/**
 * `ambit doctor`: the checks `status` and `validate` deliberately leave out.
 *
 * Every case pins the *exit code and the finding*, because the two can fail apart: a doctor that
 * always exited 6 would satisfy half of the task, and one that reported a finding under the wrong
 * check would satisfy the other half while sending someone to the wrong fix. The healthy case is the
 * load-bearing one — an installed project whose environment is complete must come back with every
 * check `ok`, or nobody will run the command twice.
 *
 * Environment variables are stubbed per test rather than in `beforeEach`, since which of them are set
 * is the subject of the first check. The fixture's `function.engineering.frontend` skill declares
 * `ACME_FIGMA_TOKEN` and its `tagged` server declares `LINTER_API_KEY`, which it also interpolates
 * into a header — so the default profile needs exactly those two.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { restoreEnv, stubEnv } from "../support/env.js";
import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { diagnoseProject, doctorFailures, isHealthy } from "../../src/project/doctor.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = ".agents/skills";
const CLAUDE_LINK = ".claude/skills";
const MCP_FILE = ".mcp.json";
const LOCK_FILE = "ambit.lock";
const STATE_FILE = ".ambit/state.json";
const GITIGNORE_FILE = ".gitignore";

const CORE_SKILL = "company-context";
const ENGINEERING_SKILL = "code-review";
const FRONTEND_SKILL = "design-tokens";

const CORE_TARGET = `${SKILLS_DIR}/${CORE_SKILL}`;
const FRONTEND_TARGET = `${SKILLS_DIR}/${FRONTEND_SKILL}`;
const ENGINEERING_TARGET = `${SKILLS_DIR}/${ENGINEERING_SKILL}`;

/**
 * The fixture's script-shipping hook and the file its config entry lands in.
 *
 * `function.engineering` selects it, so the default profile installs a directory of bytes and a config
 * file besides the skills — which is what makes the ownership and mode checks answer for both
 * directory kinds rather than only for skills.
 */
const HOOK_TARGET = ".agents/hooks/guard-secrets";
const CLAUDE_SETTINGS = ".claude/settings.json";

/** The two variables the default profile's bundle declares. */
const FIGMA_VAR = "ACME_FIGMA_TOKEN";
const TAGGED_VAR = "LINTER_API_KEY";

/** The hook the harness cases put in the catalog, and the variable one of them has it want. */
const HOOK = "notify";
const HOOK_VAR = "NOTIFY_WEBHOOK";

/** A tag nothing in the fixture carries, so holding it selects that hook and nothing else. */
const HOOK_PACK = "harness.cases";

const HOOK_LINES: readonly string[] = ["event: Stop", "type: command", "command: ./bin/notify"];

/** What a healthy project reports: every check named, and both finding lists explicitly empty. */
const HEALTHY_REPORT = [
  "checks (6)",
  "  expects    ok",
  "  lock       ok",
  "  ownership  ok",
  "  drift      ok",
  "  mode       ok",
  "  harness    ok",
  "",
  "failures (0)",
  "  (none)",
  "",
  "warnings (0)",
  "  (none)",
].join("\n");

let root: string;
let catalogDir: string;
let projectDir: string;

/** One `requires` entry, taking a whole pack from `catalog`. */
function requiresEntry(pack: string, catalog = CATALOG_NAME): string {
  return `  - { pack: "${catalog}/${pack}" }`;
}

/** Points the project at the fixture catalog and gives it a `requires` list. */
async function writeProfile(packs: readonly string[]): Promise<void> {
  const list =
    packs.length === 0 ? "[]" : `\n${packs.map((pack) => requiresEntry(pack)).join("\n")}`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
requires: ${list}
`,
    "utf8",
  );
}

/**
 * A profile configuring `harnesses` whose bundle holds exactly one hook — or none, for `hooks: []`,
 * the case about a project that configures a harness and selects no hook at all.
 *
 * The hook is written into the catalog copy this test owns, carrying a tag the fixture uses nowhere
 * else, and the project holds that tag alone. That is the only way to declare a hook, so what these
 * cases are about stays the harness the project configures rather than where the hook came from.
 *
 * @param hooks the hook's `hook.yml` lines beyond its `name` and its tag; empty writes no hook.
 */
async function writeHookProfile(
  harnesses: readonly string[],
  hooks: readonly string[] = HOOK_LINES,
): Promise<void> {
  if (hooks.length > 0) {
    const dir = path.join(catalogDir, "hooks", HOOK);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "hook.yml"), [`name: ${HOOK}`, ...hooks, ""].join("\n"), "utf8");
    // The pack the profile below takes: nothing labels itself, so the grouping is a document.
    await mkdir(path.join(catalogDir, "packs"), { recursive: true });
    await writeFile(
      path.join(catalogDir, "packs", `${HOOK_PACK}.yml`),
      [
        `name: ${HOOK_PACK}`,
        "description: The hook these cases install.",
        "requires:",
        `  - hook: ${HOOK}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
harnesses: [${harnesses.join(", ")}]
requires: ${hooks.length === 0 ? "[]" : `\n${requiresEntry(HOOK_PACK)}`}
`,
    "utf8",
  );
}

/** Runs the CLI against the project, collecting stdout and stderr. */
async function cli(
  ...argv: readonly string[]
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv, "--project", projectDir], {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/**
 * Every file in the project, keyed by relative path and carrying its contents. Symlinks are
 * followed, because the default install of a `path:` catalog is a link.
 */
async function snapshot(): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const within = relative === "" ? entry : `${relative}/${entry}`;
      const absolute = path.join(current, entry);
      if ((await stat(absolute)).isDirectory()) await walk(absolute, within);
      else found[within] = await readFile(absolute, "utf8");
    }
  };

  await walk(projectDir, "");
  return found;
}

/** Every finding, as `check/severity: message`, so a whole report fits one assertion. */
async function findings(): Promise<readonly string[]> {
  const report = await diagnoseProject(projectDir);
  return report.findings.map(
    (finding) => `${finding.check}/${finding.severity}: ${finding.message}`,
  );
}

/** The detail lines of the one finding whose message contains `needle`. */
async function detailOf(needle: string): Promise<readonly string[]> {
  const report = await diagnoseProject(projectDir);
  const found = report.findings.filter((finding) => finding.message.includes(needle));
  expect(found).toHaveLength(1);
  return found[0]?.detail ?? [];
}

/** Every check's verdict, as `check=status`. */
async function checks(): Promise<readonly string[]> {
  const report = await diagnoseProject(projectDir);
  return report.checks.map((result) => `${result.check}=${result.status}`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-doctor-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  // Three skills — `function.engineering` also selects its nested frontend child — plus the `tagged`
  // http server, which declares that same tag.
  await writeProfile(["core", "function.engineering", "function.engineering.*"]);
});

afterEach(async () => {
  restoreEnv();
  await rm(root, { recursive: true, force: true });
});

describe("ambit doctor on a healthy project", () => {
  beforeEach(async () => {
    stubEnv(FIGMA_VAR, "figma-token");
    stubEnv(TAGGED_VAR, "tagged-key");
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("passes every check, and names them rather than printing nothing", async () => {
    const result = await cli("doctor");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(HEALTHY_REPORT);
  });

  it("touches nothing, so it can be run on a project it would report failures on", async () => {
    const before = await snapshot();

    expect((await cli("doctor")).code).toBe(ExitCode.Success);
    stubEnv(TAGGED_VAR, undefined);
    await rm(path.join(projectDir, LOCK_FILE));
    expect((await cli("doctor")).code).toBe(ExitCode.Doctor);

    // The lock is the one file the second run was told about; nothing else moved.
    const after = await snapshot();
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .filter((file) => file !== LOCK_FILE)
        .sort(),
    );
  });

  it("emits machine-readable output carrying no absolute paths", async () => {
    const result = await cli("doctor", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      checks: [
        { check: "expects", status: "ok" },
        { check: "lock", status: "ok" },
        { check: "ownership", status: "ok" },
        { check: "drift", status: "ok" },
        { check: "mode", status: "ok" },
        { check: "harness", status: "ok" },
      ],
      findings: [],
      healthy: true,
    });
    expect(result.stdout).not.toContain(root);
  });
});

/** Spec §5: install cannot fail on a missing variable, which is why this command has to. */
describe("ambit doctor on an incomplete environment", () => {
  beforeEach(async () => {
    // Installed with neither variable set, so `.mcp.json` holds the placeholder and matches the plan:
    // the only thing wrong with this project is its environment.
    stubEnv(FIGMA_VAR, undefined);
    stubEnv(TAGGED_VAR, undefined);
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("exits 6 reporting one failure per unset variable, in variable order", async () => {
    const result = await cli("doctor");

    expect(result.code).toBe(ExitCode.Doctor);
    // A finding is a report, not an error: nothing reaches stderr.
    expect(result.stderr).toBe("");
    expect(await findings()).toEqual([
      `expects/fail: unset environment variable "${FIGMA_VAR}"`,
      `expects/fail: unset environment variable "${TAGGED_VAR}"`,
    ]);
    expect(await checks()).toEqual([
      "expects=fail",
      "lock=ok",
      "ownership=ok",
      "drift=ok",
      "mode=ok",
      "harness=ok",
    ]);
  });

  it("names the skill that wants the variable, and how to satisfy it", async () => {
    expect(await detailOf(FIGMA_VAR)).toEqual([
      `skill "${FRONTEND_SKILL}" expects it`,
      `set ${FIGMA_VAR} in the environment the agent runs in`,
    ]);
  });

  it("names the server, and the reference install left in `.mcp.json` for the harness", async () => {
    expect(await detailOf(TAGGED_VAR)).toEqual([
      'MCP server "linter" expects it',
      `"mcpServers.linter" in ${MCP_FILE} references it, for the harness to expand at spawn`,
      // No reinstall in the fix: ambit wrote a reference, so setting the variable is the whole of it.
      `set ${TAGGED_VAR} in the environment the agent runs in`,
    ]);
  });

  it("says nothing about a variable set to the empty string, which is a decision someone made", async () => {
    stubEnv(FIGMA_VAR, "");

    expect(await findings()).toEqual([`expects/fail: unset environment variable "${TAGGED_VAR}"`]);
  });

  it("goes quiet once the variables are set and install has interpolated them", async () => {
    stubEnv(FIGMA_VAR, "figma-token");
    stubEnv(TAGGED_VAR, "tagged-key");
    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(isHealthy(await diagnoseProject(projectDir))).toBe(true);
  });
});

/**
 * A server whose env map renames a variable: the name the process reads is written in the catalog, and
 * the value comes from a variable of the machine's. Nothing expects that variable, so the reference
 * install left in the file is the only thing that can ask for it.
 */
describe("ambit doctor on a server that renames a variable", () => {
  const SERVER = "planner";
  const SOURCE_VAR = "ACME_PLANNER_TOKEN";

  beforeEach(async () => {
    await writeFile(
      path.join(catalogDir, "mcps", `${SERVER}.yml`),
      [
        `name: ${SERVER}`,
        "",
        "transport:",
        "  stdio:",
        "    command: planner-mcp",
        "    env:",
        `      PLANNER_TOKEN: "\${${SOURCE_VAR}}"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "ambit.yml"),
      `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
requires:
  - { mcp: "${CATALOG_NAME}/${SERVER}" }
`,
      "utf8",
    );
    stubEnv(SOURCE_VAR, undefined);
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("asks for the variable the file references, not the name the process reads", async () => {
    expect(await findings()).toEqual([`expects/fail: unset environment variable "${SOURCE_VAR}"`]);
    expect(await detailOf(SOURCE_VAR)).toEqual([
      `"mcpServers.${SERVER}" in ${MCP_FILE} references it, for the harness to expand at spawn`,
      `set ${SOURCE_VAR} in the environment the agent runs in`,
    ]);
  });

  it("goes quiet once that variable is set", async () => {
    stubEnv(SOURCE_VAR, "planner-token");

    expect(isHealthy(await diagnoseProject(projectDir))).toBe(true);
  });
});

/** The lock is a record of a resolution, and `status` never reads it. */
describe("ambit doctor against the lock", () => {
  beforeEach(async () => {
    stubEnv(FIGMA_VAR, "figma-token");
    stubEnv(TAGGED_VAR, "tagged-key");
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("reports a lock resolution would rewrite, naming the file", async () => {
    await writeFile(path.join(projectDir, LOCK_FILE), "version: 1\n", "utf8");

    expect(await findings()).toEqual([`lock/fail: ${LOCK_FILE} is out of date`]);
    expect((await cli("doctor")).code).toBe(ExitCode.Doctor);
  });

  it("distinguishes a lock that was never written from one that is stale", async () => {
    await rm(path.join(projectDir, LOCK_FILE));

    expect(await findings()).toEqual([`lock/fail: ${LOCK_FILE} is missing`]);
    expect(await detailOf(LOCK_FILE)).toContain("run `ambit install` to write it");
  });

  it("says nothing about the lock after a prune, which rewrites it along with state", async () => {
    await writeProfile(["core"]);
    expect((await cli("prune")).code).toBe(ExitCode.Success);

    // Pruning removes artifacts, rewrites state *and* rewrites the lock, so nothing is left describing
    // the wider bundle. This used to be the one way to reach a stale lock without editing it by hand.
    expect(await findings()).toEqual([]);
    expect((await cli("doctor")).code).toBe(ExitCode.Success);
  });

  it("names the two commands that write the lock when one of them has not been run", async () => {
    await writeFile(path.join(projectDir, LOCK_FILE), "version: 1\n", "utf8");

    expect(await detailOf(LOCK_FILE)).toContain(
      `${LOCK_FILE} is written by \`ambit install\` and \`ambit prune\`, so config or a catalog commit has moved since the last one`,
    );
  });
});

/**
 * Spec §5 rule 4: state is written after the filesystem changes it describes, so an install that dies
 * halfway leaves its own artifacts present and unowned. This is the command that explains that.
 */
describe("ambit doctor on an ownership anomaly", () => {
  beforeEach(async () => {
    stubEnv(FIGMA_VAR, "figma-token");
    stubEnv(TAGGED_VAR, "tagged-key");
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("reports every artifact ambit no longer owns, and never as drift", async () => {
    // What a crash between the last write and `writeState` leaves behind.
    await rm(path.join(projectDir, STATE_FILE));

    expect(await findings()).toEqual([
      `ownership/fail: ambit does not own ${HOOK_TARGET}`,
      `ownership/fail: ambit does not own ${ENGINEERING_TARGET}`,
      `ownership/fail: ambit does not own ${CORE_TARGET}`,
      `ownership/fail: ambit does not own ${FRONTEND_TARGET}`,
      `ownership/fail: ambit does not own ${CLAUDE_SETTINGS}`,
      `ownership/fail: ambit does not own ${CLAUDE_LINK}`,
      `ownership/fail: ambit does not own ${MCP_FILE}`,
    ]);
    expect(await checks()).toContain("drift=ok");
    expect((await cli("doctor")).code).toBe(ExitCode.Doctor);
  });

  it("explains the crash and names `--adopt`, so nobody starts deleting files", async () => {
    await rm(path.join(projectDir, STATE_FILE));

    expect(await detailOf(CORE_TARGET)).toEqual([
      "it exists but ambit did not create it",
      "an `ambit install` that crashed leaves this: state is written after the files it describes",
      "move it aside, or run `ambit install --adopt` to take ownership",
    ]);
  });

  it("reports a co-owned config key by key rather than by file", async () => {
    await rm(path.join(projectDir, STATE_FILE));

    expect(await detailOf(MCP_FILE)).toContain(
      '"mcpServers.linter" exists but ambit did not create it',
    );
  });
});

describe("ambit doctor against the project", () => {
  beforeEach(async () => {
    stubEnv(FIGMA_VAR, "figma-token");
    stubEnv(TAGGED_VAR, "tagged-key");
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("reports a deleted skill directory, carrying status's own detail line", async () => {
    await rm(path.join(projectDir, ENGINEERING_TARGET), { recursive: true });

    expect(await findings()).toEqual([`drift/fail: ${ENGINEERING_TARGET} is missing`]);
    expect(await detailOf(ENGINEERING_TARGET)).toEqual([
      "nothing is installed at this path",
      "run `ambit install` to write it",
    ]);
  });

  it("reports the managed `.gitignore` block, which `status` has no row for", async () => {
    await rm(path.join(projectDir, GITIGNORE_FILE));

    expect(await findings()).toEqual([
      `drift/fail: ${GITIGNORE_FILE} does not hold the block install would write`,
    ]);
    expect((await cli("doctor")).code).toBe(ExitCode.Doctor);
  });

  it("reports every failure at once rather than stopping at the first", async () => {
    stubEnv(TAGGED_VAR, undefined);
    await rm(path.join(projectDir, CORE_TARGET));
    await rm(path.join(projectDir, LOCK_FILE));

    // Four checks, three of them failing, in the order they run. `.mcp.json` is deliberately not
    // among them: ambit wrote a `${VAR}` reference rather than a value, so unsetting the variable
    // cannot make the installed file differ from what resolution now produces. An installed config is
    // a function of the bundle alone, which is what stops `doctor` inventing drift from a shell.
    expect(await findings()).toEqual([
      `expects/fail: unset environment variable "${TAGGED_VAR}"`,
      `lock/fail: ${LOCK_FILE} is missing`,
      `drift/fail: ${CORE_TARGET} is missing`,
    ]);
  });
});

/** A20 left this to `doctor`: a mode is a per-run choice, so divergence is worth saying, not failing. */
describe("ambit doctor on a project installed with `--copy`", () => {
  beforeEach(async () => {
    stubEnv(FIGMA_VAR, "figma-token");
    stubEnv(TAGGED_VAR, "tagged-key");
    expect((await cli("install", "--copy")).code).toBe(ExitCode.Success);
  });

  it("warns that a plain install would symlink each skill, and still exits 0", async () => {
    const result = await cli("doctor");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    // The hook's own directory among them: both directory kinds have a mode to diverge in.
    expect(await findings()).toEqual([
      `mode/warn: ${ENGINEERING_TARGET} is installed as a copy`,
      `mode/warn: ${CORE_TARGET} is installed as a copy`,
      `mode/warn: ${FRONTEND_TARGET} is installed as a copy`,
      `mode/warn: ${HOOK_TARGET} is installed as a copy`,
    ]);
    expect(await checks()).toEqual([
      "expects=ok",
      "lock=ok",
      "ownership=ok",
      "drift=ok",
      "mode=warn",
      "harness=ok",
    ]);
  });

  it("says why, and how to keep it — nothing persists a mode between runs", async () => {
    expect(await detailOf(CORE_TARGET)).toEqual([
      "its source is a local directory someone edits, so a plain `ambit install` would symlink it",
      "keep passing `--copy` to `ambit install` to leave it as it is",
    ]);
  });

  it("stays silent about the mode of a skill it is already reporting as modified", async () => {
    await writeFile(path.join(projectDir, CORE_TARGET, "SKILL.md"), "edited by hand\n", "utf8");

    // One finding for that skill, not two: an artifact install would rewrite anyway has nothing to
    // say about the mode it would be rewritten in.
    expect(await findings()).toEqual([
      `drift/fail: ${CORE_TARGET} is modified`,
      `mode/warn: ${ENGINEERING_TARGET} is installed as a copy`,
      `mode/warn: ${FRONTEND_TARGET} is installed as a copy`,
      `mode/warn: ${HOOK_TARGET} is installed as a copy`,
    ]);
  });
});

/**
 * A hook's `env:` expectation is the fourth route into the one check that reads the environment, and it
 * is the only one of the four with nothing in a harness config file behind it: a `${VAR}` in a hook's
 * `command` is left for the shell the harness spawns, so the declaration is all there is to report.
 */
describe("ambit doctor on a hook's `expects`", () => {
  beforeEach(async () => {
    await writeHookProfile(["claude"], [...HOOK_LINES, `expects: [{ env: ${HOOK_VAR} }]`]);
    stubEnv(HOOK_VAR, undefined);
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("fails on a variable a selected hook declares and the environment does not have", async () => {
    expect((await cli("doctor")).code).toBe(ExitCode.Doctor);
    expect(await findings()).toEqual([`expects/fail: unset environment variable "${HOOK_VAR}"`]);
    expect(await detailOf(HOOK_VAR)).toEqual([
      `hook "${HOOK}" expects it`,
      `set ${HOOK_VAR} in the environment the agent runs in`,
    ]);
  });

  it("goes quiet once it is set, without a reinstall", async () => {
    stubEnv(HOOK_VAR, "https://hooks.example/notify");

    expect(isHealthy(await diagnoseProject(projectDir))).toBe(true);
  });
});

/**
 * §7's one harness finding: Codex reads hooks only when a user's own config carries
 * `[features] codex_hooks = true`, and that file is not one ambit writes. So ambit can write
 * `.codex/hooks.json` exactly as planned — every other check `ok` — and the hooks still never run,
 * which is the one failure mode nothing else in this command can see.
 */
describe("ambit doctor on a project configuring codex", () => {
  it("warns that codex needs the feature flag, and still exits 0", async () => {
    await writeHookProfile(["codex"]);
    expect((await cli("install")).code).toBe(ExitCode.Success);

    const result = await cli("doctor");
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await findings()).toEqual([
      "harness/warn: codex runs hooks only with `[features] codex_hooks = true` set",
    ]);
    expect(await checks()).toEqual([
      "expects=ok",
      "lock=ok",
      "ownership=ok",
      "drift=ok",
      "mode=ok",
      "harness=warn",
    ]);
  });

  it("names the file ambit wrote, and says the flag is not ambit's to write", async () => {
    await writeHookProfile(["codex"]);
    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(await detailOf("codex_hooks")).toEqual([
      "this project selects a hook, and ambit writes them to .codex/hooks.json",
      "codex's hooks are experimental, and the flag enabling them is user-level config ambit must not write",
      "set `[features] codex_hooks = true` in your own codex config to have them run",
    ]);
  });

  it("says nothing when codex is configured and no hook is selected", async () => {
    // Nothing is waiting on the flag, so a project that configures codex for its MCP servers alone
    // has no reason to hear about it.
    await writeHookProfile(["codex"], []);
    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(await findings()).toEqual([]);
    expect(await checks()).toContain("harness=ok");
  });

  it("says nothing when hooks are selected and codex is not configured", async () => {
    await writeHookProfile(["claude"]);
    expect((await cli("install")).code).toBe(ExitCode.Success);

    expect(await findings()).toEqual([]);
    expect((await cli("doctor")).code).toBe(ExitCode.Success);
  });
});

describe("ambit doctor before an install", () => {
  it("reports the missing lock and every missing artifact, and exits 6", async () => {
    stubEnv(FIGMA_VAR, "figma-token");
    stubEnv(TAGGED_VAR, "tagged-key");

    const result = await cli("doctor");

    expect(result.code).toBe(ExitCode.Doctor);
    expect(await checks()).toEqual([
      "expects=ok",
      "lock=fail",
      "ownership=ok",
      "drift=fail",
      "mode=ok",
      "harness=ok",
    ]);
    // The lock, both managed blocks, three missing skills, the missing hook directory, the skills
    // link, `.claude/settings.json` and `.mcp.json`.
    expect(doctorFailures(await diagnoseProject(projectDir))).toHaveLength(10);
  });

  it("resolves the catalog, so a broken config is an error rather than a finding", async () => {
    await writeProfile(["function.enginering"]);

    const result = await cli("doctor");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `\`requires\` entry "pack:${CATALOG_NAME}/function.enginering" matches nothing`,
    );
    expect(result.stdout).toBe("");
  });
});

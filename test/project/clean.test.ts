/**
 * `ambit prune` and `ambit clean`: the two commands that only remove.
 *
 * Every case asserts both directions, because half of each claim is about restraint. A prune that
 * removed everything and a prune that removed nothing would each satisfy "the withdrawn skill is
 * gone" or "the selected ones are still there" on its own, so both are pinned every time — and the
 * same goes for what neither command owns: a hand-written skill, a hand-added server, and the files
 * ambit writes but does not own.
 *
 * The install-time prune is pinned in `test/install.test.ts`; what these add is the part only a
 * standalone command has — that it reaches the same set without materializing anything, that it
 * rewrites the records afterwards, and that a run with nothing to do writes nothing at all.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { restoreEnv, stubEnv } from "../support/env.js";
import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { cleanProject, pruneProject } from "../../src/project/clean.js";
import { diagnoseProject, isHealthy } from "../../src/project/doctor.js";
import { ExitCode } from "../../src/errors.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  GITIGNORE_FILENAME,
  SHARED_GITIGNORE_FILE,
} from "../../src/project/gitignore.js";
import { LOCK_FILENAME } from "../../src/project/lock.js";
import { arrayEntryKey, managedKey } from "../../src/model/documents/index.js";
import { run } from "../../src/cli/program.js";
import { STATE_DIRNAME, STATE_FILENAME, parseState } from "../../src/model/state.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = ".agents/skills";
const CLAUDE_LINK = ".claude/skills";
const MCP_FILE = ".mcp.json";

const CORE_SKILL = "company-context";
const ENGINEERING_SKILL = "code-review";
const FRONTEND_SKILL = "design-tokens";

/** The fixture's tag-matched http server. */
const PACKED_MCP = "linter";

/**
 * The fixture's two tag-matched hooks, and the file they share.
 *
 * `core` selects an inline-command hook and `function.engineering` a script-shipping one, so the
 * bundle these cases install carries a config file and a materialized directory neither skills nor
 * servers account for. The keys are built from the rendered entry rather than written out, because a
 * digest is not a literal anyone can check by eye — `test/project/hooks.test.ts` is where the
 * rendering itself is pinned.
 */
const CLAUDE_SETTINGS = ".claude/settings.json";
const SCRIPT_HOOK_DIR = ".agents/hooks/guard-secrets";

const CORE_HOOK_KEY = managedKey(
  "hooks",
  arrayEntryKey("SessionStart", {
    hooks: [{ type: "command", command: 'echo "acme conventions apply"' }],
  }),
);

const ENGINEERING_HOOK_KEY = managedKey(
  "hooks",
  arrayEntryKey("PreToolUse", {
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: `\${CLAUDE_PROJECT_DIR}/${SCRIPT_HOOK_DIR}/guard.sh`,
        timeout: 10,
      },
    ],
  }),
);

/** The variable the tagged server interpolates into its `Authorization` header. */
const PACKED_KEY_VAR = "LINTER_API_KEY";

const STATE_FILE = `${STATE_DIRNAME}/${STATE_FILENAME}`;
const HANDMADE_SKILL = "hand-written";

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
 * Every file in the project, keyed by relative path and carrying its contents.
 *
 * Symlinks are followed, because the default install of a `path:` catalog is a link and
 * what these tests compare is the files a harness would read.
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

/** The installed skill directory names, sorted. */
async function installedSkills(): Promise<readonly string[]> {
  try {
    return (await readdir(path.join(projectDir, SKILLS_DIR))).sort();
  } catch {
    return [];
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(path.join(projectDir, target));
    return true;
  } catch {
    return false;
  }
}

async function readMcpConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(projectDir, MCP_FILE), "utf8")) as Record<
    string,
    unknown
  >;
}

async function ownedPathsNow(): Promise<readonly string[]> {
  const text = await readFile(path.join(projectDir, STATE_FILE), "utf8");
  return parseState(text, STATE_FILENAME).artifacts.map((artifact) => artifact.path);
}

/** The lines between one file's markers, or undefined when it holds no block. */
async function managedBlock(
  file: string = GITIGNORE_FILENAME,
): Promise<readonly string[] | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(projectDir, file), "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(BLOCK_BEGIN));
  const end = lines.findIndex((line) => line.startsWith(BLOCK_END));
  if (start === -1 || end <= start) return undefined;
  return lines.slice(start + 1, end);
}

/**
 * The lock a clean install of `tags` writes, produced in a throwaway sibling project.
 *
 * The point of comparing against this rather than against a hand-written expectation is that it makes
 * the claim the fix is about: what a prune leaves behind is what install would have written for the
 * surviving set, not a document prune assembled by subtracting from the old one. The sibling sits
 * beside the project so its `path:../catalog` names the same fixture.
 */
async function lockOfFreshInstall(packs: readonly string[]): Promise<string> {
  const reference = await mkdtemp(path.join(root, "reference-"));
  const list =
    packs.length === 0 ? "[]" : `\n${packs.map((pack) => requiresEntry(pack)).join("\n")}`;
  await writeFile(
    path.join(reference, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
requires: ${list}
`,
    "utf8",
  );

  const code = await run(["install", "--project", reference], {
    cwd: root,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  expect(code).toBe(ExitCode.Success);
  return await readFile(path.join(reference, LOCK_FILENAME), "utf8");
}

/** A skill directory beside ambit's that no state claims. */
async function writeForeignSkillDir(): Promise<void> {
  const target = path.join(projectDir, SKILLS_DIR, HANDMADE_SKILL);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), `---\nname: ${HANDMADE_SKILL}\n---\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-clean-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  // Three skills — `function.engineering` also selects its nested frontend child — plus the
  // `tagged` http server, which declares that same tag.
  await writeProfile(["core", "function.engineering", "function.engineering.*"]);
  // The tagged server interpolates this into a header, so what is on disk depends on it.
  stubEnv(PACKED_KEY_VAR, undefined);
});

afterEach(async () => {
  restoreEnv();
  await rm(root, { recursive: true, force: true });
});

describe("ambit prune", () => {
  it("removes the skills the narrowed bundle dropped and keeps the ones it still selects", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["core"]);

    const result = await cli("prune");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([CORE_SKILL]);
    expect(await readFile(path.join(projectDir, SKILLS_DIR, CORE_SKILL, "SKILL.md"), "utf8")).toBe(
      await readFile(path.join(catalogDir, "skills/company-context/SKILL.md"), "utf8"),
    );
  });

  it("stops claiming what it removed, and rewrites the managed blocks to match", async () => {
    await cli("install");
    await writeProfile(["core"]);

    await cli("prune");

    // The settings file stays owned: the narrowed profile still holds `core`, whose hook it carries.
    expect(await ownedPathsNow()).toEqual([
      `${SKILLS_DIR}/${CORE_SKILL}`,
      CLAUDE_SETTINGS,
      CLAUDE_LINK,
    ]);
    expect(await managedBlock(SHARED_GITIGNORE_FILE)).toEqual([`/skills/${CORE_SKILL}`]);
    expect(await managedBlock()).toEqual([`${STATE_DIRNAME}/`, CLAUDE_LINK]);
  });

  it("removes the server keys the narrowed bundle dropped, and keeps the file", async () => {
    await cli("install");
    await writeProfile(["core"]);

    await cli("prune");

    // ambit owns keys in this file and not the document, so the section empties and the
    // file stays — and state stops claiming it at all.
    expect(await readMcpConfig()).toEqual({ mcpServers: {} });
    expect(await ownedPathsNow()).not.toContain(MCP_FILE);
  });

  it("leaves a hand-written skill and a hand-added server exactly where they are", async () => {
    await writeFile(
      path.join(projectDir, MCP_FILE),
      `${JSON.stringify({ mcpServers: { handmade: { command: "node" } }, extra: { kept: true } }, null, 2)}\n`,
      "utf8",
    );
    await cli("install");
    await writeForeignSkillDir();
    await writeProfile(["core"]);

    const result = await cli("prune");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([CORE_SKILL, HANDMADE_SKILL].sort());
    expect(await readMcpConfig()).toEqual({
      mcpServers: { handmade: { command: "node" } },
      extra: { kept: true },
    });
  });

  it("rewrites `ambit.lock` to the bundle it pruned down to, byte for byte as install would", async () => {
    await cli("install");
    await writeProfile(["core"]);

    await cli("prune");

    // The reference is a fresh install of the narrowed profile into a second project: the lock a prune
    // leaves must be the one install writes for the surviving set, not a subtraction of its own.
    const pruned = await readFile(path.join(projectDir, LOCK_FILENAME), "utf8");
    expect(pruned).toBe(await lockOfFreshInstall(["core"]));

    // And it really did change — otherwise the assertion above would pass on a prune that wrote nothing.
    expect(pruned).not.toBe(
      await lockOfFreshInstall(["core", "function.engineering", "function.engineering.*"]),
    );
    expect(pruned).not.toContain(FRONTEND_SKILL);
    expect(pruned).not.toContain(PACKED_MCP);
  });

  it("leaves the lock byte-identical when it prunes nothing, rather than rewriting it in place", async () => {
    await cli("install");
    const lock = await readFile(path.join(projectDir, LOCK_FILENAME), "utf8");

    await cli("prune");

    expect(await readFile(path.join(projectDir, LOCK_FILENAME), "utf8")).toBe(lock);
  });

  it("writes no lock under `--dry-run`, however much it says it would remove", async () => {
    await cli("install");
    const lock = await readFile(path.join(projectDir, LOCK_FILENAME), "utf8");
    await writeProfile(["core"]);

    const result = await cli("prune", "--dry-run");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await readFile(path.join(projectDir, LOCK_FILENAME), "utf8")).toBe(lock);
  });

  it("leaves a pruned project passing `ambit doctor`, lock check included", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["core"]);

    expect((await cli("prune")).code).toBe(ExitCode.Success);

    // The whole point of rewriting the lock: the project a prune leaves is one `doctor` calls healthy,
    // where it used to report `ambit.lock is out of date` for the change the prune had just made.
    const report = await diagnoseProject(projectDir);
    expect(report.findings.map((finding) => `${finding.check}/${finding.severity}`)).toEqual([]);
    expect(isHealthy(report)).toBe(true);
  });

  it("changes no bytes when the bundle is unchanged", async () => {
    await cli("install");
    const before = await snapshot();

    const result = await cli("prune");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await snapshot()).toEqual(before);
    expect(await installedSkills()).toEqual([ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL].sort());
  });

  it("writes nothing at all in a project ambit never installed into", async () => {
    const result = await cli("prune");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // Not even the state file or a `.gitignore` block: a prune with nothing to remove has nothing to
    // record either, and creating them here would be claiming an install that never happened.
    expect(Object.keys(await snapshot())).toEqual(["ambit.yml"]);
  });

  it("is a no-op the second time", async () => {
    await cli("install");
    await writeProfile(["core"]);
    await cli("prune");
    const before = await snapshot();

    const result = await cli("prune");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await snapshot()).toEqual(before);
    expect(result.stdout).toBe(["pruned (0)", "  (none)"].join("\n"));
  });

  it("lists what it removed", async () => {
    await cli("install");
    await writeProfile(["core"]);

    const result = await cli("prune");

    const width = `${SKILLS_DIR}/${FRONTEND_SKILL}`.length;
    expect(result.stdout).toBe(
      [
        "pruned (5)",
        `  ${SCRIPT_HOOK_DIR.padEnd(width)}  hook-dir        -`,
        `  ${`${SKILLS_DIR}/${ENGINEERING_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${`${SKILLS_DIR}/${FRONTEND_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${CLAUDE_SETTINGS.padEnd(width)}  harness-config  ${ENGINEERING_HOOK_KEY}`,
        `  ${MCP_FILE.padEnd(width)}  harness-config  mcpServers.${PACKED_MCP}`,
      ].join("\n"),
    );
  });

  it("emits what it removed and what it still owns, carrying no absolute paths", async () => {
    await cli("install");
    await writeProfile(["core"]);

    const result = await cli("prune", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      pruned: [
        { kind: "hook-dir", path: SCRIPT_HOOK_DIR },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        { kind: "harness-config", managedKeys: [ENGINEERING_HOOK_KEY], path: CLAUDE_SETTINGS },
        { kind: "harness-config", managedKeys: [`mcpServers.${PACKED_MCP}`], path: MCP_FILE },
      ],
      // Neither the link nor the settings file is pruned: a narrowed profile still holds skills, so
      // it still points at them, and still holds the hook the file's remaining entry is.
      remaining: [
        { kind: "skill-dir", mode: "link", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "harness-config", managedKeys: [CORE_HOOK_KEY], path: CLAUDE_SETTINGS },
        { kind: "skills-link", mode: "link", path: CLAUDE_LINK },
      ],
    });
    expect(result.stdout).not.toContain(root);
  });

  it("reports what it would remove under `--dry-run`, and removes none of it", async () => {
    await cli("install");
    await writeProfile(["core"]);
    const before = await snapshot();

    const result = await cli("prune", "--dry-run", "--json");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(JSON.parse(result.stdout).pruned).toEqual([
      { kind: "hook-dir", path: SCRIPT_HOOK_DIR },
      { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
      { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
      { kind: "harness-config", managedKeys: [ENGINEERING_HOOK_KEY], path: CLAUDE_SETTINGS },
      { kind: "harness-config", managedKeys: [`mcpServers.${PACKED_MCP}`], path: MCP_FILE },
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it("removes nothing when the project resolves to what is already installed", async () => {
    await cli("install");

    expect((await pruneProject(projectDir)).pruned).toEqual([]);
  });
});

describe("ambit clean", () => {
  beforeEach(async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("removes every skill directory and every managed server key", async () => {
    const result = await cli("clean");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([]);
    expect(await readMcpConfig()).toEqual({ mcpServers: {} });
  });

  it("removes ambit's own state directory and both managed blocks", async () => {
    await cli("clean");

    expect(await pathExists(STATE_DIRNAME)).toBe(false);
    expect(await managedBlock()).toBeUndefined();
    // Its block was the whole of the nested file, so the file goes with it.
    expect(await pathExists(SHARED_GITIGNORE_FILE)).toBe(false);
  });

  it("leaves the project holding only the files ambit does not own", async () => {
    await cli("clean");

    // `ambit.lock` is a record of a resolution rather than an artifact, and `.mcp.json` is
    // co-owned, so neither is ambit's to delete — see `src/project/clean.ts`. The `.gitignore` ambit created
    // goes, because ambit's block was the whole of it.
    expect(Object.keys(await snapshot()).sort()).toEqual(
      ["ambit.yml", "ambit.lock", MCP_FILE, CLAUDE_SETTINGS].sort(),
    );
  });

  it("gives a .gitignore the project already had back byte for byte", async () => {
    const handwritten = "node_modules/\n.env\n";
    await rm(path.join(projectDir, GITIGNORE_FILENAME));
    await writeFile(path.join(projectDir, GITIGNORE_FILENAME), handwritten, "utf8");
    await cli("install");

    await cli("clean");

    // The blank line above the block was ambit's separator, so it goes with the block.
    expect(await readFile(path.join(projectDir, GITIGNORE_FILENAME), "utf8")).toBe(handwritten);
  });

  it("leaves a hand-written skill and a hand-added server untouched", async () => {
    await writeForeignSkillDir();
    const handmade = { command: "node", args: ["./scripts/local-mcp.js"] };
    await writeFile(
      path.join(projectDir, MCP_FILE),
      `${JSON.stringify({ mcpServers: { handmade, [PACKED_MCP]: { type: "http", url: "x" } }, extra: 1 }, null, 2)}\n`,
      "utf8",
    );
    // The tagged key is ambit's, so re-installing over the hand-edited file keeps ownership of it.
    await cli("install", "--adopt");

    const result = await cli("clean");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([HANDMADE_SKILL]);
    expect(await readMcpConfig()).toEqual({ mcpServers: { handmade }, extra: 1 });
  });

  it("works on a project whose catalog can no longer be resolved", async () => {
    // The whole point of answering from state alone: this is the state a project is usually in when
    // someone reaches for `clean`.
    await rm(path.join(projectDir, "ambit.yml"));

    const result = await cli("clean");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await installedSkills()).toEqual([]);
    expect(await pathExists(STATE_DIRNAME)).toBe(false);
  });

  it("is a no-op the second time, and on a project ambit never touched", async () => {
    await cli("clean");
    const before = await snapshot();

    const second = await cli("clean");
    expect(second.code, second.stderr).toBe(ExitCode.Success);

    expect(await snapshot()).toEqual(before);
    expect(second.stdout).toBe(
      ["removed (0)", "  (none)", "", "records (0)", "  (none)"].join("\n"),
    );
  });

  it("lists what it removed, artifacts and records apart", async () => {
    const result = await cli("clean");

    const width = `${SKILLS_DIR}/${CORE_SKILL}`.length;
    expect(result.stdout).toBe(
      [
        "removed (7)",
        `  ${SCRIPT_HOOK_DIR.padEnd(width)}  hook-dir        -`,
        `  ${`${SKILLS_DIR}/${ENGINEERING_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${`${SKILLS_DIR}/${CORE_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${`${SKILLS_DIR}/${FRONTEND_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${CLAUDE_SETTINGS.padEnd(width)}  harness-config  ${ENGINEERING_HOOK_KEY}, ${CORE_HOOK_KEY}`,
        `  ${CLAUDE_LINK.padEnd(width)}  skills-link     -`,
        `  ${MCP_FILE.padEnd(width)}  harness-config  mcpServers.${PACKED_MCP}`,
        "",
        "records (3)",
        `  ${STATE_FILE}`,
        `  ${GITIGNORE_FILENAME} (managed block)`,
        `  ${SHARED_GITIGNORE_FILE} (managed block)`,
      ].join("\n"),
    );
  });

  it("emits machine-readable output carrying no absolute paths", async () => {
    const result = await cli("clean", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      gitignoreRemoved: [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE],
      removed: [
        { kind: "hook-dir", path: SCRIPT_HOOK_DIR },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        {
          kind: "harness-config",
          managedKeys: [ENGINEERING_HOOK_KEY, CORE_HOOK_KEY],
          path: CLAUDE_SETTINGS,
        },
        { kind: "skills-link", path: CLAUDE_LINK },
        { kind: "harness-config", managedKeys: [`mcpServers.${PACKED_MCP}`], path: MCP_FILE },
      ],
      stateRemoved: true,
    });
    expect(result.stdout).not.toContain(root);
  });

  it("reports what it would remove under `--dry-run`, and removes none of it", async () => {
    const before = await snapshot();

    const result = await cli("clean", "--dry-run", "--json");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(JSON.parse(result.stdout)).toEqual({
      gitignoreRemoved: [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE],
      removed: [
        { kind: "hook-dir", path: SCRIPT_HOOK_DIR },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        {
          kind: "harness-config",
          managedKeys: [ENGINEERING_HOOK_KEY, CORE_HOOK_KEY],
          path: CLAUDE_SETTINGS,
        },
        { kind: "skills-link", path: CLAUDE_LINK },
        { kind: "harness-config", managedKeys: [`mcpServers.${PACKED_MCP}`], path: MCP_FILE },
      ],
      stateRemoved: true,
    });
    expect(await snapshot()).toEqual(before);
    expect(await installedSkills()).toEqual([ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL].sort());
  });

  it("unlinks a linked skill without following it into the catalog", async () => {
    await cleanProject(projectDir);

    expect(await installedSkills()).toEqual([]);
    expect(
      await readFile(path.join(catalogDir, "skills/company-context/SKILL.md"), "utf8"),
    ).toContain(CORE_SKILL);
  });

  it("leaves a project reinstallable, with no ownership conflict to adopt past", async () => {
    await cli("clean");

    const result = await cli("install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await installedSkills()).toEqual([ENGINEERING_SKILL, CORE_SKILL, FRONTEND_SKILL].sort());
  });
});

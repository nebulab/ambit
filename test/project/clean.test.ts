/**
 * `ambit prune` and `ambit clean` (spec §6): the two commands that only remove.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { cleanProject, pruneProject } from "../../src/project/clean.js";
import { diagnoseProject, isHealthy } from "../../src/project/doctor.js";
import { ExitCode } from "../../src/errors.js";
import { BLOCK_BEGIN, BLOCK_END, GITIGNORE_FILENAME } from "../../src/project/gitignore.js";
import { LOCK_FILENAME } from "../../src/project/lock.js";
import { run } from "../../src/cli/program.js";
import { STATE_DIRNAME, STATE_FILENAME, parseState } from "../../src/model/state.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = ".claude/skills";
const MCP_FILE = ".mcp.json";

const CORE_SKILL = "acme.commons.use-company-context";
const ENGINEERING_SKILL = "acme.engineering.use-code-review";
const FRONTEND_SKILL = "acme.engineering.frontend.use-design-tokens";

/** The fixture's scope-matched http server. */
const SCOPED_MCP = "scoped";

/** The variable the scoped server interpolates into its `Authorization` header. */
const SCOPED_KEY_VAR = "SCOPED_API_KEY";

const STATE_FILE = `${STATE_DIRNAME}/${STATE_FILENAME}`;
const HANDMADE_SKILL = "hand-written";

let root: string;
let catalogDir: string;
let projectDir: string;

/** Points the project at the fixture catalog and gives it `scopes`. */
async function writeProfile(scopes: readonly string[]): Promise<void> {
  const list = scopes.length === 0 ? "[]" : `\n${scopes.map((scope) => `  - ${scope}`).join("\n")}`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
scopes: ${list}
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
 * Symlinks are followed, because the default install of a `path:` catalog is a link (spec §5) and
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
  return JSON.parse(await readFile(path.join(projectDir, MCP_FILE), "utf8")) as Record<string, unknown>;
}

async function ownedPathsNow(): Promise<readonly string[]> {
  const text = await readFile(path.join(projectDir, STATE_FILE), "utf8");
  return parseState(text, STATE_FILENAME).artifacts.map((artifact) => artifact.path);
}

/** The lines between the markers, or undefined when the file holds no block. */
async function managedBlock(): Promise<readonly string[] | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(projectDir, GITIGNORE_FILENAME), "utf8");
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
 * The lock a clean install of `scopes` writes, produced in a throwaway sibling project.
 *
 * The point of comparing against this rather than against a hand-written expectation is that it makes
 * the claim the fix is about: what a prune leaves behind is what install would have written for the
 * surviving set, not a document prune assembled by subtracting from the old one. The sibling sits
 * beside the project so its `path:../catalog` names the same fixture.
 */
async function lockOfFreshInstall(scopes: readonly string[]): Promise<string> {
  const reference = await mkdtemp(path.join(root, "reference-"));
  const list = scopes.length === 0 ? "[]" : `\n${scopes.map((scope) => `  - ${scope}`).join("\n")}`;
  await writeFile(
    path.join(reference, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
scopes: ${list}
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
  // `scoped` http server, which declares that same scope.
  await writeProfile(["core", "function.engineering"]);
  // The scoped server interpolates this into a header, so what is on disk depends on it (spec §5).
  vi.stubEnv(SCOPED_KEY_VAR, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
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
      await readFile(path.join(catalogDir, "skills/acme/commons/use-company-context/SKILL.md"), "utf8"),
    );
  });

  it("stops claiming what it removed, and rewrites the managed block to match", async () => {
    await cli("install");
    await writeProfile(["core"]);

    await cli("prune");

    expect(await ownedPathsNow()).toEqual([`${SKILLS_DIR}/${CORE_SKILL}`]);
    expect(await managedBlock()).toEqual([`${STATE_DIRNAME}/`, `${SKILLS_DIR}/${CORE_SKILL}`]);
  });

  it("removes the server keys the narrowed bundle dropped, and keeps the file", async () => {
    await cli("install");
    await writeProfile(["core"]);

    await cli("prune");

    // ambit owns keys in this file and not the document (spec §3.6), so the section empties and the
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
    expect(pruned).not.toBe(await lockOfFreshInstall(["core", "function.engineering"]));
    expect(pruned).not.toContain(FRONTEND_SKILL);
    expect(pruned).not.toContain(SCOPED_MCP);
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
    expect(await installedSkills()).toEqual(
      [CORE_SKILL, FRONTEND_SKILL, ENGINEERING_SKILL].sort(),
    );
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
        "pruned (3)",
        `  ${`${SKILLS_DIR}/${FRONTEND_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${`${SKILLS_DIR}/${ENGINEERING_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${MCP_FILE.padEnd(width)}  harness-config  mcpServers.${SCOPED_MCP}`,
      ].join("\n"),
    );
  });

  it("emits what it removed and what it still owns, carrying no absolute paths", async () => {
    await cli("install");
    await writeProfile(["core"]);

    const result = await cli("prune", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      pruned: [
        { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`], path: MCP_FILE },
      ],
      remaining: [{ kind: "skill-dir", mode: "link", path: `${SKILLS_DIR}/${CORE_SKILL}` }],
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
      { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
      { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
      { kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`], path: MCP_FILE },
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

  it("removes ambit's own state directory and its managed block", async () => {
    await cli("clean");

    expect(await pathExists(STATE_DIRNAME)).toBe(false);
    expect(await managedBlock()).toBeUndefined();
  });

  it("leaves the project holding only the files ambit does not own", async () => {
    await cli("clean");

    // `ambit.lock` is a record of a resolution rather than an artifact (spec §3.5), and `.mcp.json` is
    // co-owned, so neither is ambit's to delete — see `src/project/clean.ts`. The `.gitignore` ambit created
    // goes, because ambit's block was the whole of it.
    expect(Object.keys(await snapshot()).sort()).toEqual(["ambit.yml", "ambit.lock", MCP_FILE].sort());
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
      `${JSON.stringify({ mcpServers: { handmade, [SCOPED_MCP]: { type: "http", url: "x" } }, extra: 1 }, null, 2)}\n`,
      "utf8",
    );
    // The scoped key is ambit's, so re-installing over the hand-edited file keeps ownership of it.
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
    expect(second.stdout).toBe(["removed (0)", "  (none)", "", "records (0)", "  (none)"].join("\n"));
  });

  it("lists what it removed, artifacts and records apart", async () => {
    const result = await cli("clean");

    const width = `${SKILLS_DIR}/${FRONTEND_SKILL}`.length;
    expect(result.stdout).toBe(
      [
        "removed (4)",
        `  ${`${SKILLS_DIR}/${CORE_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${`${SKILLS_DIR}/${FRONTEND_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${`${SKILLS_DIR}/${ENGINEERING_SKILL}`.padEnd(width)}  skill-dir       -`,
        `  ${MCP_FILE.padEnd(width)}  harness-config  mcpServers.${SCOPED_MCP}`,
        "",
        "records (2)",
        `  ${STATE_FILE}`,
        `  ${GITIGNORE_FILENAME} (managed block)`,
      ].join("\n"),
    );
  });

  it("emits machine-readable output carrying no absolute paths", async () => {
    const result = await cli("clean", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      gitignoreRemoved: true,
      removed: [
        { kind: "skill-dir", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`], path: MCP_FILE },
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
      gitignoreRemoved: true,
      removed: [
        { kind: "skill-dir", path: `${SKILLS_DIR}/${CORE_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${FRONTEND_SKILL}` },
        { kind: "skill-dir", path: `${SKILLS_DIR}/${ENGINEERING_SKILL}` },
        { kind: "harness-config", managedKeys: [`mcpServers.${SCOPED_MCP}`], path: MCP_FILE },
      ],
      stateRemoved: true,
    });
    expect(await snapshot()).toEqual(before);
    expect(await installedSkills()).toEqual(
      [CORE_SKILL, FRONTEND_SKILL, ENGINEERING_SKILL].sort(),
    );
  });

  it("unlinks a linked skill without following it into the catalog", async () => {
    await cleanProject(projectDir);

    expect(await installedSkills()).toEqual([]);
    expect(
      await readFile(path.join(catalogDir, "skills/acme/commons/use-company-context/SKILL.md"), "utf8"),
    ).toContain(CORE_SKILL);
  });

  it("leaves a project reinstallable, with no ownership conflict to adopt past", async () => {
    await cli("clean");

    const result = await cli("install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await installedSkills()).toEqual(
      [CORE_SKILL, FRONTEND_SKILL, ENGINEERING_SKILL].sort(),
    );
  });
});

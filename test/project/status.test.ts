/**
 * `ambit status`: does the project match what resolution now produces?
 *
 * The interesting assertions are the negative ones. A status command is only worth running if it is
 * quiet about everything ambit does not own — a hand-added server in `.mcp.json`, a hand-written
 * skill directory beside ambit's — so every drift case here also pins what is *not* reported.
 *
 * `--check` is asserted in both directions every time: exit 5 on drift and 0 when clean. A checker
 * that always failed and a checker that never did would each satisfy half of it.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";
import { isClean, projectStatus, statusDrift } from "../../src/project/status.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = ".agents/skills";
const CLAUDE_LINK = ".claude/skills";
const MCP_FILE = ".mcp.json";

const CORE_SKILL = "company-context";
const ENGINEERING_SKILL = "code-review";
const FRONTEND_SKILL = "design-tokens";

/** The fixture's scope-matched http server, and the one only `requires` reaches. */
const SCOPED_MCP = "scoped";
const FIXTURE_MCP = "fixture";

/** The variable the scoped server interpolates into its `Authorization` header. */
const SCOPED_KEY_VAR = "SCOPED_API_KEY";

/** The default profile's four artifacts, by project-relative path and in status's order. */
const CORE_TARGET = `${SKILLS_DIR}/${CORE_SKILL}`;
const FRONTEND_TARGET = `${SKILLS_DIR}/${FRONTEND_SKILL}`;
const ENGINEERING_TARGET = `${SKILLS_DIR}/${ENGINEERING_SKILL}`;

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
 * Symlinks are followed, because the default install of a `path:` catalog is a link and the
 * claim being made is about the files a harness would read.
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

/** Every artifact status reports, as `path=state` pairs, so a whole report fits one assertion. */
async function states(): Promise<readonly string[]> {
  const status = await projectStatus(projectDir);
  return status.artifacts.map((artifact) => `${artifact.path}=${artifact.state}`);
}

/** The detail line status gives for one path. */
async function detailOf(target: string): Promise<string | undefined> {
  const status = await projectStatus(projectDir);
  return status.artifacts.find((artifact) => artifact.path === target)?.detail;
}

async function writeMcpFile(document: unknown): Promise<void> {
  await writeFile(
    path.join(projectDir, MCP_FILE),
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}

async function readMcpConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(projectDir, MCP_FILE), "utf8")) as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-status-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  // Three skills — `function.engineering` also selects its nested frontend child — plus the
  // `scoped` http server, which declares that same scope.
  await writeProfile(["core", "function.engineering"]);
  // The scoped server interpolates this into a header, so what is on disk depends on it.
  vi.stubEnv(SCOPED_KEY_VAR, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("ambit status on an installed project", () => {
  beforeEach(async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
  });

  it("reports every artifact as matching, and says so rather than printing nothing", async () => {
    const result = await cli("status");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    // The detail column is empty on every row here, so `columns` trims it away and the state ends
    // each line — but the two columns before it are still padded out to their widest cell.
    const width = CORE_TARGET.length;
    const kind = "harness-config".length;
    expect(result.stdout).toBe(
      [
        "artifacts (5)",
        `  ${ENGINEERING_TARGET.padEnd(width)}  ${"skill-dir".padEnd(kind)}  ok`,
        `  ${CORE_TARGET}  ${"skill-dir".padEnd(kind)}  ok`,
        `  ${FRONTEND_TARGET.padEnd(width)}  ${"skill-dir".padEnd(kind)}  ok`,
        `  ${CLAUDE_LINK.padEnd(width)}  ${"skills-link".padEnd(kind)}  ok`,
        `  ${MCP_FILE.padEnd(width)}  harness-config  ok`,
      ].join("\n"),
    );
  });

  it("exits 0 under `--check` when nothing has drifted", async () => {
    const result = await cli("status", "--check");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });

  it("touches nothing, so it can be run on a project it would report drift on", async () => {
    const before = await snapshot();

    expect((await cli("status")).code).toBe(ExitCode.Success);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);

    expect(await snapshot()).toEqual(before);
  });

  it("emits machine-readable output carrying no absolute paths", async () => {
    const result = await cli("status", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      artifacts: [
        { kind: "skill-dir", path: ENGINEERING_TARGET, state: "ok" },
        { kind: "skill-dir", path: CORE_TARGET, state: "ok" },
        { kind: "skill-dir", path: FRONTEND_TARGET, state: "ok" },
        { kind: "skills-link", path: CLAUDE_LINK, state: "ok" },
        { kind: "harness-config", path: MCP_FILE, state: "ok" },
      ],
      clean: true,
    });
    expect(result.stdout).not.toContain(root);
  });
});

/**
 * Content drift, which is a question about a *copy*: a symlinked skill has no bytes of its own, so
 * these cases install with `--copy`. Editing a linked skill edits the catalog, and the
 * block below pins that as the non-drift it is.
 */
describe("ambit status after a manual edit", () => {
  beforeEach(async () => {
    expect((await cli("install", "--copy")).code).toBe(ExitCode.Success);
  });

  it("reports an edited skill file as modified, naming the file", async () => {
    await writeFile(
      path.join(projectDir, CORE_TARGET, "SKILL.md"),
      "---\nname: edited by hand\n---\n",
      "utf8",
    );

    const result = await cli("status");
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(`modified  SKILL.md differs from its source`);
    expect(await states()).toEqual([
      `${ENGINEERING_TARGET}=ok`,
      `${CORE_TARGET}=modified`,
      `${FRONTEND_TARGET}=ok`,
      `${CLAUDE_LINK}=ok`,
      `${MCP_FILE}=ok`,
    ]);
  });

  it("exits 5 under `--check` once a skill has been edited", async () => {
    await writeFile(path.join(projectDir, CORE_TARGET, "SKILL.md"), "edited\n", "utf8");

    const result = await cli("status", "--check");

    expect(result.code).toBe(ExitCode.Drift);
    // The report is still the report: `--check` adds an exit code, not an error.
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("modified");
  });

  it("reports a file added into an installed skill, which install would remove", async () => {
    await writeFile(path.join(projectDir, CORE_TARGET, "notes.md"), "mine\n", "utf8");

    expect(await detailOf(CORE_TARGET)).toBe("notes.md is not in its source");
  });

  it("reports a deleted skill directory as missing", async () => {
    await rm(path.join(projectDir, ENGINEERING_TARGET), { recursive: true });

    expect(await states()).toEqual([
      `${ENGINEERING_TARGET}=missing`,
      `${CORE_TARGET}=ok`,
      `${FRONTEND_TARGET}=ok`,
      `${CLAUDE_LINK}=ok`,
      `${MCP_FILE}=ok`,
    ]);
    expect(await detailOf(ENGINEERING_TARGET)).toBe("nothing is installed at this path");
  });

  it("reports an edited server as modified, naming the key", async () => {
    await writeMcpFile({ mcpServers: { [SCOPED_MCP]: { command: "my-own-thing" } } });

    expect(await detailOf(MCP_FILE)).toBe(
      `"mcpServers.${SCOPED_MCP}" is not what install would write`,
    );
    expect(await states()).toContain(`${MCP_FILE}=modified`);
  });

  it("reports a deleted server as absent rather than as modified", async () => {
    await writeMcpFile({ mcpServers: {} });

    expect(await detailOf(MCP_FILE)).toBe(`"mcpServers.${SCOPED_MCP}" is absent`);
    expect(await states()).toContain(`${MCP_FILE}=missing`);
  });

  it("reports a `.mcp.json` deleted outright, since install would write it again", async () => {
    await rm(path.join(projectDir, MCP_FILE));

    expect(await states()).toContain(`${MCP_FILE}=missing`);
  });

  it("does not read a reordered server as drift: ambit owns the key, not the layout", async () => {
    const document = await readMcpConfig();
    const scoped =
      (document.mcpServers as Record<string, Record<string, unknown>>)[SCOPED_MCP] ?? {};
    await writeMcpFile({
      mcpServers: { [SCOPED_MCP]: { headers: scoped.headers, url: scoped.url, type: scoped.type } },
    });

    expect(isClean(await projectStatus(projectDir))).toBe(true);
  });

  it("says nothing about a hand-added server, or any other key in the file", async () => {
    const document = await readMcpConfig();
    await writeMcpFile({
      ...document,
      mcpServers: { ...(document.mcpServers as object), handmade: { command: "node" } },
      extra: { kept: true },
    });

    expect(await states()).toEqual([
      `${ENGINEERING_TARGET}=ok`,
      `${CORE_TARGET}=ok`,
      `${FRONTEND_TARGET}=ok`,
      `${CLAUDE_LINK}=ok`,
      `${MCP_FILE}=ok`,
    ]);
  });

  it("says nothing about a skill directory no state claims", async () => {
    const target = path.join(projectDir, SKILLS_DIR, "hand-written");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: hand-written\n---\n", "utf8");

    expect(isClean(await projectStatus(projectDir))).toBe(true);
  });

  it("reports a change in the catalog, not only one in the project", async () => {
    await writeFile(
      path.join(catalogDir, "skills/company-context/SKILL.md"),
      "---\nname: company-context\nambit:\n  scopes: [core]\n---\n\n# rewritten upstream\n",
      "utf8",
    );

    expect(await detailOf(CORE_TARGET)).toBe("SKILL.md differs from its source");
  });
});

/**
 * The other half of the materialization modes: what is on disk decides how a skill is compared,
 * so a link is checked for pointing at its source and a copy for holding its bytes.
 */
describe("ambit status on a symlinked install", () => {
  const CORE_SOURCE = "skills/company-context";

  it("says nothing when the source is edited through the link, which is what linking is for", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);

    await writeFile(
      path.join(projectDir, CORE_TARGET, "SKILL.md"),
      "---\nname: company-context\nambit:\n  scopes: [core]\n---\n\n# edited in place\n",
      "utf8",
    );

    // The edit landed in the catalog, so there is no second copy for the two to disagree about.
    expect(await readFile(path.join(catalogDir, CORE_SOURCE, "SKILL.md"), "utf8")).toContain(
      "edited in place",
    );
    expect(isClean(await projectStatus(projectDir))).toBe(true);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });

  it("reports a link pointing elsewhere as modified, naming where it points", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await rm(path.join(projectDir, CORE_TARGET));
    await symlink("../../../elsewhere", path.join(projectDir, CORE_TARGET), "dir");

    // A link is not followed, so one pointing at nothing is drift rather than an absent artifact.
    expect(await detailOf(CORE_TARGET)).toBe("it points at ../../../elsewhere, not at its source");
    expect(await states()).toContain(`${CORE_TARGET}=modified`);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Drift);
  });

  it("reports a file sitting where a linked skill belongs as modified", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await rm(path.join(projectDir, CORE_TARGET));
    await writeFile(path.join(projectDir, CORE_TARGET), "not a skill directory\n", "utf8");

    expect(await detailOf(CORE_TARGET)).toBe("it is not a directory");
  });

  it("reads an intact copy as clean, even though a plain install would relink it", async () => {
    expect((await cli("install", "--copy")).code).toBe(ExitCode.Success);

    // Mode is a per-run choice and both modes put the same bytes in front of the harness, so
    // `--copy` must not leave `status --check` permanently red.
    expect(await states()).toEqual([
      `${ENGINEERING_TARGET}=ok`,
      `${CORE_TARGET}=ok`,
      `${FRONTEND_TARGET}=ok`,
      `${CLAUDE_LINK}=ok`,
      `${MCP_FILE}=ok`,
    ]);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });
});

describe("ambit status before an install", () => {
  it("reports every artifact resolution wants as missing", async () => {
    const result = await cli("status");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await states()).toEqual([
      `${ENGINEERING_TARGET}=missing`,
      `${CORE_TARGET}=missing`,
      `${FRONTEND_TARGET}=missing`,
      `${CLAUDE_LINK}=missing`,
      `${MCP_FILE}=missing`,
    ]);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Drift);
  });

  it("reports a target install would refuse as unowned rather than as modified", async () => {
    const target = path.join(projectDir, CORE_TARGET);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: not ambit's\n---\n", "utf8");
    await writeMcpFile({ mcpServers: { [SCOPED_MCP]: { command: "not ambit's either" } } });

    expect(await states()).toEqual([
      `${ENGINEERING_TARGET}=missing`,
      `${CORE_TARGET}=unowned`,
      `${FRONTEND_TARGET}=missing`,
      // Nothing is installed here, so the link is absent like the skills it would point at.
      `${CLAUDE_LINK}=missing`,
      `${MCP_FILE}=unowned`,
    ]);
    expect(await detailOf(CORE_TARGET)).toBe("it exists but ambit did not create it");
    expect(await detailOf(MCP_FILE)).toBe(
      `"mcpServers.${SCOPED_MCP}" exists but ambit did not create it`,
    );
  });

  it("reports nothing at all for a project that resolves to nothing", async () => {
    await writeProfile([]);

    const result = await cli("status");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(["artifacts (0)", "  (none)"].join("\n"));
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });
});

/** Spec §5 rule 3 from the read-only side: what install would prune, before it prunes it. */
describe("ambit status after the profile narrows", () => {
  it("reports what ambit owns and nothing selects as stale", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["core"]);

    expect(await states()).toEqual([
      `${ENGINEERING_TARGET}=stale`,
      `${CORE_TARGET}=ok`,
      `${FRONTEND_TARGET}=stale`,
      `${CLAUDE_LINK}=ok`,
      `${MCP_FILE}=stale`,
    ]);
    expect(await detailOf(FRONTEND_TARGET)).toBe("ambit owns it, and nothing selects it now");
    expect((await cli("status", "--check")).code).toBe(ExitCode.Drift);
  });

  it("reports a single stale server key in a file whose other keys still match", async () => {
    // Both servers: `scoped` by scope, `fixture` through the project skill's `requires`.
    await writeProfile(["function.engineering", "project.acme"]);
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["function.engineering"]);

    expect(await detailOf(MCP_FILE)).toBe(`"mcpServers.${FIXTURE_MCP}" is no longer selected`);
    expect(await states()).toContain(`${MCP_FILE}=stale`);
  });

  it("goes quiet again once the install that prunes them has run", async () => {
    expect((await cli("install")).code).toBe(ExitCode.Success);
    await writeProfile(["core"]);
    expect((await cli("install")).code).toBe(ExitCode.Success);

    const status = await projectStatus(projectDir);
    expect(statusDrift(status)).toEqual([]);
    expect((await cli("status", "--check")).code).toBe(ExitCode.Success);
  });
});

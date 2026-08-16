/**
 * `ambit.lock`, and `install --frozen`.
 *
 * The lock's whole value is that identical inputs produce identical bytes, so the assertions here are
 * on the exact file rather than on a parsed view of it: a reordered key, a stray timestamp, or an
 * anchor would all survive a structural comparison and all break the diff the lock exists to give.
 *
 * The commit fields need a source that has a revision, so they are covered in
 * `test/git-source.test.ts` end to end, and here through {@link buildLock}, which takes the commit as
 * a value and therefore needs no git to pin the numeric-SHA case §3.0 warns about.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { Catalog } from "../../src/model/catalog.js";
import { mergeCatalogs, parseCatalogDirectory } from "../../src/model/catalog.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import { LOCK_FILENAME, buildLock, serializeLock } from "../../src/project/lock.js";
import { run } from "../../src/cli/program.js";
import type { Bundle } from "../../src/resolution/resolve.js";
import { resolveBundle } from "../../src/resolution/resolve.js";
import { parseYamlMapping } from "../../src/model/yaml.js";

const CATALOG_NAME = "company";
const CATALOG_SOURCE = "path:../catalog";
const SKILLS_DIR = ".agents/skills";

const CORE_SKILL = "company-context";
const ENGINEERING_SKILL = "code-review";
const FRONTEND_SKILL = "design-tokens";
const PROJECT_SKILL = "acme-brief";

let root: string;
let catalogDir: string;
let projectDir: string;

/**
 * Points the project at the fixture catalog and gives it a `requires` list.
 *
 * @param entries further `requires` entry lines, for the shapes {@link requiresEntry} does not build.
 */
async function writeProfile(
  packs: readonly string[],
  entries: readonly string[] = [],
): Promise<void> {
  const written = [...packs.map((pack) => requiresEntry(pack)), ...entries];
  const list = written.length === 0 ? "[]" : `\n${written.join("\n")}`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: ${CATALOG_SOURCE}
requires: ${list}
`,
    "utf8",
  );
}

/** One `requires` entry, taking a whole pack from `catalog`. */
function requiresEntry(pack: string, catalog = CATALOG_NAME): string {
  return `  - { pack: "${catalog}/${pack}" }`;
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

async function readLock(): Promise<string> {
  return readFile(path.join(projectDir, LOCK_FILENAME), "utf8");
}

async function lockExists(): Promise<boolean> {
  return (await readdir(projectDir)).includes(LOCK_FILENAME);
}

/** The installed skill directory names, sorted. */
async function installedSkills(): Promise<readonly string[]> {
  try {
    return (await readdir(path.join(projectDir, SKILLS_DIR))).sort();
  } catch {
    return [];
  }
}

/**
 * Adds a hook to the fixture catalog, held by `core`.
 *
 * @param name the hook's directory and name.
 * @param body further `hook.yml` lines — `event`, `command`, and whatever else the case needs.
 * @param script when given, written beside `hook.yml` under that filename, which makes `command:
 *   <filename>` a shipped script rather than a command line.
 */
async function writeCatalogHook(
  name: string,
  body: readonly string[],
  script?: { readonly file: string; readonly body: string },
): Promise<void> {
  const dir = path.join(catalogDir, "hooks", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "hook.yml"), [`name: ${name}`, ...body, ""].join("\n"), "utf8");
  if (script !== undefined) await writeFile(path.join(dir, script.file), script.body, "utf8");
}

/** What the project's current profile resolves to against `catalogs`. */
async function bundleFrom(catalogs: readonly Catalog[]): Promise<Bundle> {
  const config = await loadProjectConfig(projectDir);
  return resolveBundle(config, mergeCatalogs(catalogs));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-lock-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile(["core", "function.engineering", "function.engineering.*"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit.lock", () => {
  it("records every configured catalog and every selected item, keys sorted throughout", async () => {
    const result = await cli("install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await readLock()).toBe(
      [
        "catalogs:",
        `  ${CATALOG_NAME}:`,
        `    source: ${CATALOG_SOURCE}`,
        // `path` on the hook that ships a script and not on the one whose `command` is a command
        // line: a lock pins bytes, and a command line is config values — the argument the servers make.
        "hooks:",
        "  guard-secrets:",
        `    catalog: ${CATALOG_NAME}`,
        "    path: hooks/guard-secrets",
        "    reason: required-by:pack:function.engineering",
        "  session-notes:",
        `    catalog: ${CATALOG_NAME}`,
        "    reason: required-by:pack:core",
        "mcps:",
        "  linter:",
        `    catalog: ${CATALOG_NAME}`,
        "    reason: required-by:pack:function.engineering",
        // The packs the project named, which nothing materializes and every reason above points at.
        "packs:",
        "  core:",
        `    catalog: ${CATALOG_NAME}`,
        `    reason: pack:${CATALOG_NAME}/core`,
        "  function.engineering:",
        `    catalog: ${CATALOG_NAME}`,
        `    reason: pack:${CATALOG_NAME}/function.engineering`,
        "  function.engineering.frontend:",
        `    catalog: ${CATALOG_NAME}`,
        `    reason: pack:${CATALOG_NAME}/function.engineering.*`,
        "skills:",
        `  ${ENGINEERING_SKILL}:`,
        `    catalog: ${CATALOG_NAME}`,
        "    path: skills/code-review",
        "    reason: required-by:pack:function.engineering",
        `  ${CORE_SKILL}:`,
        `    catalog: ${CATALOG_NAME}`,
        "    path: skills/company-context",
        "    reason: required-by:pack:core",
        `  ${FRONTEND_SKILL}:`,
        `    catalog: ${CATALOG_NAME}`,
        "    path: skills/design-tokens",
        "    reason: required-by:pack:function.engineering.frontend",
        "version: 1",
        "",
      ].join("\n"),
    );
  });

  it("is byte-identical on a second install, so nothing in it is a timestamp", async () => {
    await cli("install");
    const first = await readLock();

    await cli("install");

    expect(await readLock()).toBe(first);
  });

  it("carries no absolute path, so a team can commit one file between them", async () => {
    await cli("install");

    expect(await readLock()).not.toContain(root);
  });

  it("keeps every section even when a project selects nothing", async () => {
    await writeProfile([]);

    await cli("install");

    // An emptied section reads as `{}` rather than vanishing: losing the last MCP server should show
    // up in the diff as a change to `mcps`, not as a key a reader has to notice the absence of.
    expect(await readLock()).toBe(
      [
        "catalogs:",
        `  ${CATALOG_NAME}:`,
        `    source: ${CATALOG_SOURCE}`,
        "hooks: {}",
        "mcps: {}",
        "packs: {}",
        "skills: {}",
        "version: 1",
        "",
      ].join("\n"),
    );
  });

  it("records the reason each item was selected, in `--explain`'s form", async () => {
    await writeProfile(["project.acme"], [`  - { skill: "${CATALOG_NAME}/${ENGINEERING_SKILL}" }`]);

    await cli("install");
    const lock = parseYamlMapping(await readLock(), LOCK_FILENAME);

    const skills = lock.requireMapping("skills");
    expect(skills.requireMapping(ENGINEERING_SKILL).requireString("reason")).toBe(
      `skill:${CATALOG_NAME}/${ENGINEERING_SKILL}`,
    );
    expect(skills.requireMapping(PROJECT_SKILL).requireString("reason")).toBe(
      "required-by:pack:project.acme",
    );
    expect(
      lock.requireMapping("packs").requireMapping("project.acme").requireString("reason"),
    ).toBe(`pack:${CATALOG_NAME}/project.acme`);
    expect(skills.requireMapping(CORE_SKILL).requireString("reason")).toBe(
      `required-by:skill:${PROJECT_SKILL}`,
    );
    expect(lock.requireMapping("mcps").requireMapping("fixture").requireString("reason")).toBe(
      `required-by:skill:${PROJECT_SKILL}`,
    );
  });

  it("records a command-line hook as config values, with no bytes to pin", async () => {
    await writeCatalogHook("notify", ["event: Stop", "type: command", "command: ./notify"]);

    await writeProfile([], [`  - { hook: "${CATALOG_NAME}/notify" }`]);
    await cli("install");
    const entry = parseYamlMapping(await readLock(), LOCK_FILENAME)
      .requireMapping("hooks")
      .requireMapping("notify");

    // A hook whose `command` is a command line ships no bytes, so there is nothing to pin: it takes
    // `LockMcp`'s shape, and `catalog` is all a reader needs to find the document.
    expect(entry.keys()).toEqual(["catalog", "reason"]);
    expect(entry.requireString("catalog")).toBe(CATALOG_NAME);
    expect(entry.requireString("reason")).toBe(`hook:${CATALOG_NAME}/notify`);
  });

  it("pins where a hook's bytes came from only when it ships a script", async () => {
    await writeCatalogHook("block-rm", ["event: PreToolUse", "type: script", "command: hook.sh"], {
      file: "hook.sh",
      body: "#!/bin/sh\nexit 0\n",
    });
    await writeCatalogHook("announce", [
      "event: Stop",
      "type: command",
      "command: npx --yes say done",
    ]);
    await writeProfile(
      [],
      [`  - { hook: "${CATALOG_NAME}/block-rm" }`, `  - { hook: "${CATALOG_NAME}/announce" }`],
    );

    // Through `buildLock` rather than the CLI, so the commit is a value rather than something a git
    // source has to supply — the same trick the numeric-SHA case below uses.
    const catalog = await parseCatalogDirectory(
      CATALOG_NAME,
      CATALOG_SOURCE,
      catalogDir,
      "abc1234",
    );
    const hooks = parseYamlMapping(
      serializeLock(buildLock([catalog], await bundleFrom([catalog]))),
      LOCK_FILENAME,
    ).requireMapping("hooks");

    // `command: hook.sh` names a file the hook's directory holds, so an install materializes those
    // bytes and the lock says which they were. `path` is the catalog-relative directory, as a skill's
    // is — never the command written into a harness file, which is rewritten per harness and so is no
    // single value a lock could hold.
    const shipping = hooks.requireMapping("block-rm");
    expect(shipping.keys()).toEqual(["catalog", "commit", "path", "reason"]);
    expect(shipping.requireString("catalog")).toBe(CATALOG_NAME);
    expect(shipping.requireString("path")).toBe("hooks/block-rm");
    expect(shipping.requireString("commit")).toBe("abc1234");
    expect(shipping.requireString("reason")).toBe(`hook:${CATALOG_NAME}/block-rm`);

    // `npx --yes say done` is a command line, so the same catalog entry ships nothing and pins
    // nothing: a directory holding only the declaration that was already read has no bytes to record.
    const inert = hooks.requireMapping("announce");
    expect(inert.keys()).toEqual(["catalog", "reason"]);
    expect(inert.requireString("catalog")).toBe(CATALOG_NAME);
  });

  it("quotes a commit and a ref a YAML parser would otherwise read as numbers", async () => {
    // The §3.0 trap, at the surface it matters on: `1234567` unquoted parses as an integer and
    // `1e5` as a float, so an unquoted lock would pin a different commit than the one installed.
    const parsed = await parseCatalogDirectory(CATALOG_NAME, CATALOG_SOURCE, catalogDir, "1234567");
    const catalog: Catalog = { ...parsed, ref: "1e5" };
    const text = serializeLock(buildLock([catalog], await bundleFrom([catalog])));

    expect(text).toContain('    commit: "1234567"\n');
    expect(text).toContain('    ref: "1e5"\n');

    const lock = parseYamlMapping(text, LOCK_FILENAME);
    const entry = lock.requireMapping("catalogs").requireMapping(CATALOG_NAME);
    expect(entry.requireString("commit")).toBe("1234567");
    expect(entry.requireString("ref")).toBe("1e5");
    // Every catalog skill inherits it, so the same quoting has to hold there too.
    expect(lock.requireMapping("skills").requireMapping(CORE_SKILL).requireString("commit")).toBe(
      "1234567",
    );
  });
});

describe("ambit install --frozen", () => {
  it("succeeds when the lock on disk is what resolution produces", async () => {
    await cli("install");
    const before = await readLock();

    const result = await cli("install", "--frozen");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await readLock()).toBe(before);
  });

  it("exits 5 when the project has no lock, and writes nothing", async () => {
    const result = await cli("install", "--frozen");

    expect(result.code).toBe(ExitCode.Drift);
    expect(result.stderr).toContain(`${LOCK_FILENAME} is out of date`);
    expect(result.stderr).toContain(`has no ${LOCK_FILENAME}`);
    expect(await lockExists()).toBe(false);
    expect(await installedSkills()).toEqual([]);
  });

  it("exits 5 when resolution would change the lock, leaving the project as it was", async () => {
    await cli("install");
    const before = await readLock();
    const installedBefore = await installedSkills();

    await writeProfile(["project.acme"]);
    const result = await cli("install", "--frozen");

    expect(result.code).toBe(ExitCode.Drift);
    expect(result.stderr).toContain("produces a different ambit.lock than the one on disk");
    expect(await readLock()).toBe(before);
    expect(await installedSkills()).toEqual(installedBefore);
  });

  it("exits 5 for a lock that says the same thing in different bytes", async () => {
    await cli("install");
    // Reformatting is drift too: `--frozen` is asked whether install would rewrite the file, and a
    // lock ambit did not emit is one ambit would rewrite.
    await writeFile(
      path.join(projectDir, LOCK_FILENAME),
      (await readLock()).replace(/\n/g, "\n\n"),
    );

    expect((await cli("install", "--frozen")).code).toBe(ExitCode.Drift);
  });
});

/**
 * `ambit.lock` (spec §3.5), and `install --frozen` (spec §6).
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { Catalog } from "../../src/model/catalog.js";
import { mergeCatalogs, mergeConfigEntities, parseCatalogDirectory } from "../../src/model/catalog.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import { LOCK_FILENAME, buildLock, serializeLock } from "../../src/project/lock.js";
import { run } from "../../src/cli/program.js";
import type { Bundle } from "../../src/resolution/resolve.js";
import { resolveBundle } from "../../src/resolution/resolve.js";
import type { SourceContext } from "../../src/model/sources.js";
import { parseYamlMapping } from "../../src/model/yaml.js";

const CATALOG_NAME = "company";
const CATALOG_SOURCE = "path:../catalog";
const SKILLS_DIR = ".claude/skills";

const CORE_SKILL = "acme.commons.use-company-context";
const ENGINEERING_SKILL = "acme.engineering.use-code-review";
const FRONTEND_SKILL = "acme.engineering.frontend.use-design-tokens";
const PROJECT_SKILL = "acme.projects.use-acme-brief";

let root: string;
let catalogDir: string;
let projectDir: string;

/**
 * Points the project at the fixture catalog and gives it `scopes`.
 *
 * @param extra further top-level config lines, appended after the scopes list.
 */
async function writeProfile(
  scopes: readonly string[],
  extra: readonly string[] = [],
): Promise<void> {
  const list = scopes.length === 0 ? "[]" : `\n${scopes.map((scope) => `  - ${scope}`).join("\n")}`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: ${CATALOG_SOURCE}
scopes: ${list}
${extra.map((line) => `${line}\n`).join("")}`,
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

/** What the project's current profile resolves to against `catalogs`. */
async function bundleFrom(catalogs: readonly Catalog[]): Promise<Bundle> {
  const context: SourceContext = { projectDir, env: process.env };
  const config = await loadProjectConfig(projectDir);
  return resolveBundle(config, await mergeConfigEntities(mergeCatalogs(catalogs), config, context));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-lock-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile(["core", "function.engineering"]);
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
        "mcps:",
        "  scoped:",
        `    catalog: ${CATALOG_NAME}`,
        "    reason: scope:function.engineering",
        "skills:",
        `  ${CORE_SKILL}:`,
        `    catalog: ${CATALOG_NAME}`,
        "    path: skills/acme/commons/use-company-context",
        "    reason: scope:core",
        `  ${FRONTEND_SKILL}:`,
        `    catalog: ${CATALOG_NAME}`,
        "    path: skills/acme/engineering/frontend/use-design-tokens",
        "    reason: scope:function.engineering.frontend",
        `  ${ENGINEERING_SKILL}:`,
        `    catalog: ${CATALOG_NAME}`,
        "    path: skills/acme/engineering/use-code-review",
        "    reason: scope:function.engineering",
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
        "mcps: {}",
        "skills: {}",
        "version: 1",
        "",
      ].join("\n"),
    );
  });

  it("records the reason each item was selected, in `--explain`'s form", async () => {
    await writeProfile(["project.acme"], [`skills:`, `  - ${ENGINEERING_SKILL}`]);

    await cli("install");
    const lock = parseYamlMapping(await readLock(), LOCK_FILENAME);

    const skills = lock.requireMapping("skills");
    expect(skills.requireMapping(ENGINEERING_SKILL).requireString("reason")).toBe("explicit");
    expect(skills.requireMapping(PROJECT_SKILL).requireString("reason")).toBe("scope:project.acme");
    expect(skills.requireMapping(CORE_SKILL).requireString("reason")).toBe(
      `required-by:${PROJECT_SKILL}`,
    );
    expect(lock.requireMapping("mcps").requireMapping("fixture").requireString("reason")).toBe(
      `required-by:${PROJECT_SKILL}`,
    );
  });

  it("names the source, not a catalog, for a skill that carries its own", async () => {
    const source = path.join(root, "extra", "skills", "readwise-cli");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: readwise-cli\n---\n\n# rw\n", "utf8");
    await writeProfile([], ["skills:", "  - name: readwise-cli", "    source: path:../extra"]);

    await cli("install");

    // The same answer `resolve --json` gives: no catalog provided it, so the column that would name
    // one names the source it was fetched from, which is what a reader edits to change it.
    const entry = parseYamlMapping(await readLock(), LOCK_FILENAME)
      .requireMapping("skills")
      .requireMapping("readwise-cli");
    expect(entry.requireString("catalog")).toBe("path:../extra");
    expect(entry.requireString("path")).toBe("skills/readwise-cli");
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
    expect(
      lock.requireMapping("skills").requireMapping(CORE_SKILL).requireString("commit"),
    ).toBe("1234567");
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
    await writeFile(path.join(projectDir, LOCK_FILENAME), (await readLock()).replace(/\n/g, "\n\n"));

    expect((await cli("install", "--frozen")).code).toBe(ExitCode.Drift);
  });
});

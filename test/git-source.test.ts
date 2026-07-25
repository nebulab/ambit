/**
 * Git sources end to end (spec §5), against a bare repository on the local filesystem: `file://` is
 * a git URL like any other, so ambit needs no test mode and no test needs a network (spec §7).
 *
 * The claim under test is that a git source is not a second kind of catalog. The same fixture,
 * installed once from a repository and once from a directory, must leave byte-identical projects
 * behind — anything else means fetching quietly changed what a project gets.
 *
 * The second claim is about the cache: a resolve that the cache can already answer must not touch
 * the remote. That is asserted the only way it can be believed — by deleting the remote between the
 * two runs.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FixtureGitCatalog } from "../scripts/fixture-catalog.js";
import { buildFixtureCatalog, buildFixtureGitCatalog } from "../scripts/fixture-catalog.js";
import { loadCatalogs } from "../src/catalog.js";
import { loadProjectConfig } from "../src/config.js";
import { ExitCode } from "../src/errors.js";
import { REPOS_DIRNAME, SOURCES_DIRNAME, cacheRoot, gitCacheKey } from "../src/git.js";
import { run } from "../src/program.js";

const CATALOG_NAME = "company";
const CORE_SKILL = "acme.commons.use-company-context";
const SKILLS_DIR = ".claude/skills";

/** Selects three skills and the `scoped` server, so the comparison covers every artifact kind. */
const SCOPES: readonly string[] = ["core", "function.engineering"];

/** The variable the scoped server interpolates into a header; pinned so the file is predictable. */
const SCOPED_KEY_VAR = "SCOPED_API_KEY";

let root: string;
let cacheDir: string;
let catalogDir: string;
let fixture: FixtureGitCatalog;
let gitProject: string;
let pathProject: string;

/**
 * Writes a project pointing one catalog at `source`.
 *
 * @param extra further top-level config lines, appended after the scopes list.
 */
async function writeProject(
  dir: string,
  source: string,
  ref?: string,
  extra: readonly string[] = [],
): Promise<void> {
  const refLine = ref === undefined ? "" : `    ref: "${ref}"\n`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: ${source}
${refLine}scopes:
${SCOPES.map((scope) => `  - ${scope}`).join("\n")}
${extra.map((line) => `${line}\n`).join("")}`,
    "utf8",
  );
}

/** Runs the CLI against one project, collecting stdout and stderr. */
async function cli(
  dir: string,
  ...argv: readonly string[]
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv, "--project", dir], {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/**
 * Every file ambit left in a project, keyed by relative path and carrying its contents.
 *
 * `ambit.yml` is excluded because it is the one file that must differ: naming a different source is
 * the whole experiment.
 */
async function installed(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const within = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (within === "ambit.yml") continue;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), within);
      else found[within] = await readFile(path.join(current, entry.name), "utf8");
    }
  };

  await walk(dir, "");
  return found;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Where the fixture repository is cached, and where its commit is checked out. */
function cachePaths(): { readonly clone: string; readonly checkouts: string } {
  const cache = cacheRoot(process.env);
  const key = gitCacheKey(fixture.url);
  return {
    clone: path.join(cache, REPOS_DIRNAME, `${key}.git`),
    checkouts: path.join(cache, SOURCES_DIRNAME, key),
  };
}

/** The catalog the git-source project resolves to, loaded in process so `commit` is visible. */
async function gitCatalog(): Promise<{ readonly root: string; readonly commit?: string }> {
  const config = await loadProjectConfig(gitProject);
  const catalogs = await loadCatalogs(config, { projectDir: gitProject, env: process.env });
  const catalog = catalogs[0];
  if (catalog === undefined) throw new Error("expected the project to declare one catalog");
  return catalog;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-git-"));
  cacheDir = path.join(root, "cache");
  // The cache is machine-wide (spec §5), so every test points it somewhere disposable rather than
  // writing into the developer's real one.
  vi.stubEnv("XDG_CACHE_HOME", cacheDir);
  vi.stubEnv(SCOPED_KEY_VAR, undefined);

  catalogDir = path.join(root, "catalog");
  await buildFixtureCatalog(catalogDir);
  fixture = await buildFixtureGitCatalog(path.join(root, "remote"));

  gitProject = path.join(root, "from-git");
  pathProject = path.join(root, "from-path");
  await writeProject(gitProject, fixture.url);
  await writeProject(pathProject, "path:../catalog");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("a catalog fetched from git", () => {
  it("installs exactly what the same catalog installs from a directory", async () => {
    const fromPath = await cli(pathProject, "install");
    expect(fromPath.code, fromPath.stderr).toBe(ExitCode.Success);
    const fromGit = await cli(gitProject, "install");
    expect(fromGit.code, fromGit.stderr).toBe(ExitCode.Success);

    expect(await installed(gitProject)).toEqual(await installed(pathProject));
    expect(Object.keys(await installed(gitProject))).toContain(
      `${SKILLS_DIR}/${CORE_SKILL}/SKILL.md`,
    );
  });

  it("clones into the cache, keyed by host and path, and checks the commit out there", async () => {
    const result = await cli(gitProject, "install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const { clone, checkouts } = cachePaths();
    expect(await pathExists(path.join(clone, "HEAD"))).toBe(true);
    expect(await pathExists(path.join(checkouts, fixture.commit, "scopes.yml"))).toBe(true);
    expect(clone.startsWith(path.join(cacheDir, "ambit"))).toBe(true);
  });

  it("reports the commit the catalog is pinned to", async () => {
    expect((await gitCatalog()).commit).toBe(fixture.commit);
    expect((await gitCatalog()).root).toBe(path.join(cachePaths().checkouts, fixture.commit));
  });

  for (const [label, ref] of [
    ["the default branch", undefined],
    ["a branch", "main"],
    ["a tag", "v1"],
    ["a full commit SHA", "commit"],
    ["an abbreviated commit SHA", "abbreviated"],
  ] as const) {
    it(`resolves ${label} to the same commit`, async () => {
      const asked =
        ref === "commit"
          ? fixture.commit
          : ref === "abbreviated"
            ? fixture.commit.slice(0, 8)
            : ref;
      await writeProject(gitProject, fixture.url, asked);

      expect((await gitCatalog()).commit).toBe(fixture.commit);
    });
  }

  it("resolves from the cache on a second run, with the remote gone", async () => {
    const first = await cli(gitProject, "install");
    expect(first.code, first.stderr).toBe(ExitCode.Success);
    const before = await installed(gitProject);

    // Nothing but the cache can answer now, so a second run that succeeds fetched nothing.
    await rm(fixture.repo, { recursive: true, force: true });

    const second = await cli(gitProject, "install");
    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(await installed(gitProject)).toEqual(before);
  });

  it("checks a commit out once and reuses the checkout", async () => {
    await cli(gitProject, "install");
    await cli(gitProject, "install");

    expect((await readdir(cachePaths().checkouts)).sort()).toEqual([
      fixture.commit,
      `${fixture.commit}.ready`,
    ]);
  });

  it("shares one clone between the URL and its `git:` spelling", async () => {
    await cli(gitProject, "install");
    await writeProject(gitProject, `git:${fixture.url}`);
    await rm(fixture.repo, { recursive: true, force: true });

    const result = await cli(gitProject, "install");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect((await readdir(path.join(cacheRoot(process.env), REPOS_DIRNAME))).sort()).toEqual([
      "local",
    ]);
  });

  it("installs a skill from a git source with no catalog behind it", async () => {
    await writeFile(
      path.join(gitProject, "ambit.yml"),
      `version: 1
scopes: []
skills:
  - name: ${CORE_SKILL}
    source: ${fixture.url}
    ref: "${fixture.tag}"
`,
      "utf8",
    );

    const result = await cli(gitProject, "install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(Object.keys(await installed(gitProject))).toContain(
      `${SKILLS_DIR}/${CORE_SKILL}/SKILL.md`,
    );
  });
});

describe("git source failures", () => {
  it("exits 2 for a ref the repository does not have", async () => {
    await writeProject(gitProject, fixture.url, "nope");

    const result = await cli(gitProject, "install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`cannot resolve ref "nope" for catalog "${CATALOG_NAME}"`);
    expect(result.stderr).toContain("omit it to take the default branch");
    expect(await pathExists(path.join(gitProject, SKILLS_DIR))).toBe(false);
  });

  it("exits 2 for a ref git would read as an option", async () => {
    await writeProject(gitProject, fixture.url, "--upload-pack=touch");

    const result = await cli(gitProject, "install");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" has an unusable ref`);
  });

  it("exits 4 for a repository that is not there", async () => {
    await writeProject(gitProject, `file://${path.join(root, "missing.git")}`);

    const result = await cli(gitProject, "install");

    expect(result.code).toBe(ExitCode.Network);
    expect(result.stderr).toContain(`cannot clone catalog "${CATALOG_NAME}"`);
    expect(result.stderr).toContain("git said:");
    // A failed clone must leave nothing a later run would mistake for a cache hit.
    expect(await pathExists(cachePaths().clone)).toBe(false);
  });
});

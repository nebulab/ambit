/**
 * Git sources end to end, against a bare repository on the local filesystem: `file://` is
 * a git URL like any other, so ambit needs no test mode and no test needs a network.
 *
 * The claim under test is that a git source is not a second kind of catalog. The same fixture,
 * installed once from a repository and once from a directory, must leave byte-identical projects
 * behind — anything else means fetching quietly changed what a project gets. The two files that
 * record *where* it came from are the deliberate exception, and are named in
 * {@link PER_SOURCE_FILES}; the materialization mode is the other one, since a commit is copied and a
 * working directory is linked, so the comparison passes `--copy` on the directory side.
 *
 * The second claim is about the cache: a resolve that the cache can already answer must not touch
 * the remote. That is asserted the only way it can be believed — by deleting the remote between the
 * two runs.
 *
 * The third is `--offline`, which is the same claim from the other side: with the remote
 * present and perfectly reachable, an offline run against a cold cache has to fail rather than
 * quietly fetch. Deleting the remote proves the cache can answer; leaving it in place proves ambit
 * did not ask it to.
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FixtureGitCatalog } from "../../scripts/fixture-catalog.js";
import { buildFixtureCatalog, buildFixtureGitCatalog } from "../../scripts/fixture-catalog.js";
import { loadCatalogs } from "../../src/model/catalog.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import { REPOS_DIRNAME, SOURCES_DIRNAME, cacheRoot, gitCacheKey } from "../../src/model/git.js";
import { LOCK_FILENAME } from "../../src/project/lock.js";
import { run } from "../../src/cli/program.js";
import { STATE_DIRNAME, STATE_FILENAME, parseState } from "../../src/model/state.js";
import type { YamlMapping } from "../../src/model/yaml.js";
import { parseYamlMapping } from "../../src/model/yaml.js";

const CATALOG_NAME = "company";
const CORE_SKILL = "acme.commons.use-company-context";
const SKILLS_DIR = ".agents/skills";

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
 * Files whose contents must differ between the two projects, and so cannot take part in the
 * comparison: `ambit.yml` names a different source, which is the whole experiment, and `ambit.lock`
 * records that source and the commit behind it — a git source has one and a directory
 * has none, so a lock that matched would mean the lock was not doing its job.
 */
const PER_SOURCE_FILES: ReadonlySet<string> = new Set(["ambit.yml", "ambit.lock"]);

/**
 * Every file ambit left in a project, keyed by relative path and carrying its contents.
 *
 * Symlinks are followed: a `path:` catalog's skills are linked by default, and what this
 * compares is the files a harness would read, not how they got there.
 */
async function installed(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const within = relative === "" ? entry : `${relative}/${entry}`;
      if (PER_SOURCE_FILES.has(within)) continue;
      const absolute = path.join(current, entry);
      if ((await stat(absolute)).isDirectory()) await walk(absolute, within);
      else found[within] = await readFile(absolute, "utf8");
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
  // The cache is machine-wide, so every test points it somewhere disposable rather than
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
    // `--copy` on the directory side, because that is the one thing the two sources legitimately
    // disagree about: a commit is immutable and gets copied, a working directory gets linked,
    // and state records which. Everything else — every skill, every server key — must
    // match byte for byte, so the flag is what keeps this comparison about fetching.
    const fromPath = await cli(pathProject, "install", "--copy");
    expect(fromPath.code, fromPath.stderr).toBe(ExitCode.Success);
    const fromGit = await cli(gitProject, "install");
    expect(fromGit.code, fromGit.stderr).toBe(ExitCode.Success);

    expect(await installed(gitProject)).toEqual(await installed(pathProject));
    expect(Object.keys(await installed(gitProject))).toContain(
      `${SKILLS_DIR}/${CORE_SKILL}/SKILL.md`,
    );
  });

  it("copies its skills, since a commit is not a working tree anyone edits", async () => {
    const result = await cli(gitProject, "install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const target = path.join(gitProject, SKILLS_DIR, CORE_SKILL);
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    const state = await readFile(path.join(gitProject, STATE_DIRNAME, STATE_FILENAME), "utf8");
    expect(parseState(state, STATE_FILENAME).artifacts).toContainEqual({
      path: `${SKILLS_DIR}/${CORE_SKILL}`,
      kind: "skill-dir",
      mode: "copy",
    });
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

/**
 * The commit half of the lock, which only a git source can exercise: a `path:` catalog has no
 * revision to pin, so this is the only place the lock's `commit` fields can be shown to be real.
 */
describe("the lock a git source writes", () => {
  /** The lock as ambit's own parser reads it, which also proves what was emitted is loadable. */
  async function lock(dir: string): Promise<YamlMapping> {
    return parseYamlMapping(await readFile(path.join(dir, LOCK_FILENAME), "utf8"), LOCK_FILENAME);
  }

  it("pins the catalog to the commit its ref resolved to, keeping the ref it was asked for", async () => {
    await writeProject(gitProject, fixture.url, fixture.tag);

    const result = await cli(gitProject, "install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const entry = (await lock(gitProject)).requireMapping("catalogs").requireMapping(CATALOG_NAME);
    expect(entry.requireString("source")).toBe(fixture.url);
    expect(entry.requireString("ref")).toBe(fixture.tag);
    expect(entry.requireString("commit")).toBe(fixture.commit);
  });

  it("pins every skill it installed to that same commit", async () => {
    await cli(gitProject, "install");

    const entry = (await lock(gitProject)).requireMapping("skills").requireMapping(CORE_SKILL);
    expect(entry.requireString("catalog")).toBe(CATALOG_NAME);
    expect(entry.requireString("commit")).toBe(fixture.commit);
  });

  it("pins a skill carrying its own source, which has no catalog entry to inherit from", async () => {
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

    const document = await lock(gitProject);
    expect(document.requireMapping("catalogs").keys()).toEqual([]);
    const entry = document.requireMapping("skills").requireMapping(CORE_SKILL);
    // No catalog provided it, so the column that would name one names the source, exactly as
    // `resolve --json` reports it.
    expect(entry.requireString("catalog")).toBe(fixture.url);
    expect(entry.requireString("commit")).toBe(fixture.commit);
  });

  it("leaves the commit out for a catalog read from a directory", async () => {
    await cli(pathProject, "install");

    const entry = (await lock(pathProject)).requireMapping("catalogs").requireMapping(CATALOG_NAME);
    expect(entry.optionalString("commit")).toBeUndefined();
    expect(entry.requireString("source")).toBe("path:../catalog");
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

describe("--offline", () => {
  /** Fills the cache the way a normal run does, so an offline run has something to work from. */
  async function warmTheCache(): Promise<void> {
    const result = await cli(gitProject, "install");
    expect(result.code, result.stderr).toBe(ExitCode.Success);
  }

  it("resolves entirely from the cache, with the remote gone", async () => {
    await warmTheCache();
    await rm(fixture.repo, { recursive: true, force: true });

    const result = await cli(gitProject, "resolve", "--offline");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(CORE_SKILL);
  });

  it("installs a project that never fetched, from the cache another project filled", async () => {
    await warmTheCache();
    const second = path.join(root, "from-cache");
    await writeProject(second, fixture.url);
    await rm(fixture.repo, { recursive: true, force: true });

    const result = await cli(second, "install", "--offline");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(Object.keys(await installed(second))).toContain(`${SKILLS_DIR}/${CORE_SKILL}/SKILL.md`);
  });

  it("checks a commit out from a clone it already has, since that needs no remote", async () => {
    await warmTheCache();
    // The clone stays; only the materialized checkout goes, which is the case the cache can still
    // answer without asking anyone.
    const { checkouts } = cachePaths();
    await rm(path.join(checkouts, fixture.commit), { recursive: true, force: true });
    await rm(`${path.join(checkouts, fixture.commit)}.ready`, { force: true });
    await rm(fixture.repo, { recursive: true, force: true });

    const result = await cli(gitProject, "install", "--offline");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await pathExists(path.join(checkouts, fixture.commit, "scopes.yml"))).toBe(true);
  });

  it("exits 4 naming the catalog it would have had to clone, and clones nothing", async () => {
    // The remote is right there and reachable, so a run that succeeds fetched something it was
    // told not to.
    const result = await cli(gitProject, "install", "--offline");

    expect(result.code).toBe(ExitCode.Network);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" is not in the cache`);
    expect(result.stderr).toContain(fixture.url);
    expect(result.stderr).toContain("without `--offline`");
    expect(await pathExists(cachePaths().clone)).toBe(false);
    expect(await pathExists(path.join(gitProject, SKILLS_DIR))).toBe(false);
  });

  it("exits 4 for a ref the cached clone was never told about, without fetching", async () => {
    await warmTheCache();
    await writeProject(gitProject, fixture.url, "v2");
    await rm(fixture.repo, { recursive: true, force: true });

    const result = await cli(gitProject, "install", "--offline");

    expect(result.code).toBe(ExitCode.Network);
    expect(result.stderr).toContain(
      `cannot resolve ref "v2" from the cache for catalog "${CATALOG_NAME}"`,
    );
    // The online path would have tried a fetch before deciding, and said so.
    expect(result.stderr).not.toContain("cannot fetch");
  });

  it("exits 4 naming a skill whose own source is not cached", async () => {
    await writeFile(
      path.join(gitProject, "ambit.yml"),
      `version: 1
scopes: []
skills:
  - name: ${CORE_SKILL}
    source: ${fixture.url}
`,
      "utf8",
    );

    const result = await cli(gitProject, "install", "--offline");

    expect(result.code).toBe(ExitCode.Network);
    expect(result.stderr).toContain(`skill "${CORE_SKILL}" is not in the cache`);
  });

  it("has nothing to say about a catalog read from a directory", async () => {
    const result = await cli(pathProject, "install", "--offline");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(Object.keys(await installed(pathProject))).toContain(
      `${SKILLS_DIR}/${CORE_SKILL}/SKILL.md`,
    );
  });
});

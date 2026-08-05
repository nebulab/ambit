/**
 * `ambit outdated` and `ambit update`, against a bare repository on the local filesystem — `file://`
 * is a git URL like any other, so nothing here needs a network.
 *
 * Three claims, and the first is the one the rest lean on.
 *
 * **`outdated` changes nothing about what a later command does.** It reaches the remote, which every
 * other read-only command is forbidden to do, so the whole design rests on the answer landing
 * somewhere ref resolution never looks (`PROBE_NAMESPACE`). The way to believe that is to run
 * `outdated`, then run `resolve` and `install` and watch them still produce the old bundle — which is
 * exactly what the first describe does. Get this wrong and a read-only command silently moves a pin.
 *
 * **The report is about capabilities, not commits.** A branch that advanced over a change this project
 * does not select produces a moved commit and an empty diff, and a `SKILL.md` whose description
 * changed reports the field rather than the file. Both are asserted directly, because a report that
 * merely restated two SHAs would pass every other test here.
 *
 * **`update` moves the pin and installs it.** The lock's commit, the skill's bytes on disk, and a
 * second `outdated` all have to agree afterwards.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FixtureGitCatalog } from "../../scripts/fixture-catalog.js";
import { buildFixtureCatalog, buildFixtureGitCatalog } from "../../scripts/fixture-catalog.js";
import { commitFixtureGitRevision } from "../../scripts/fixture-catalog.js";
import { ExitCode } from "../../src/errors.js";
import { LOCK_FILENAME } from "../../src/project/lock.js";
import { PROBE_NAMESPACE, REPOS_DIRNAME, cacheRoot, gitCacheKey } from "../../src/model/git.js";
import { run } from "../../src/cli/program.js";
import { parseYamlMapping } from "../../src/model/yaml.js";

const CATALOG_NAME = "company";
const SKILLS_DIR = ".agents/skills";

/**
 * The tags the project selects on: two skills, the `tagged` server and both tagged hooks, so every
 * namespace has something in it that a second revision can move.
 */
const TAGS: readonly string[] = ["core", "function.engineering"];

/** The fixture's two credentials, stubbed so no run depends on the developer's environment. */
const ENV_STUBS: Readonly<Record<string, string>> = {
  TAGGED_API_KEY: "update-tagged-key",
  FIXTURE_API_KEY: "update-fixture-key",
};

/** One `requires` entry, selecting everything in the catalog that carries `tag`. */
function requiresEntry(tag: string, catalog = CATALOG_NAME): string {
  return `  - { tag: "${catalog}/${tag}", capabilities: [skills, mcps, hooks] }`;
}

/** The `requires:` list every project here writes. */
const REQUIRES = TAGS.map((tag) => requiresEntry(tag)).join("\n");

/** A skill the first revision does not have, on a tag the project selects. */
const NEW_SKILL = `---
name: deploy-runbook
description: How Acme deploys.
ambit:
  tags: [function.engineering]
---

# Deploy runbook
`;

/** A skill on a tag the project does *not* select, so committing it moves a commit and no capability. */
const UNSELECTED_SKILL = `---
name: brand-voice
description: How Acme writes.
ambit:
  tags: [project.acme]
---

# Brand voice
`;

let root: string;
let fixture: FixtureGitCatalog;
let project: string;

/** Writes a project pointing its one catalog at `source`, optionally at a `ref`. */
async function writeProject(dir: string, source: string, ref?: string): Promise<void> {
  const refLine = ref === undefined ? "" : `    ref: "${ref}"\n`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: ${source}
${refLine}requires:
${REQUIRES}
`,
    "utf8",
  );
}

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

/** `--json` output, parsed. */
async function json(
  dir: string,
  ...argv: readonly string[]
): Promise<Readonly<Record<string, unknown>>> {
  const result = await cli(dir, ...argv, "--json");
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return JSON.parse(result.stdout) as Readonly<Record<string, unknown>>;
}

/** The commit the lock pins the catalog to. */
async function lockedCommit(dir: string): Promise<string | undefined> {
  const text = await readFile(path.join(dir, LOCK_FILENAME), "utf8");
  return parseYamlMapping(text, LOCK_FILENAME)
    .requireMapping("catalogs")
    .requireMapping(CATALOG_NAME)
    .optionalString("commit");
}

/** What the cache's clone says the branch points at — the value a plain resolve would take. */
async function cachedBranch(): Promise<string> {
  const repo = path.join(cacheRoot(process.env), REPOS_DIRNAME, `${gitCacheKey(fixture.url)}.git`);
  const packed = await readFile(path.join(repo, "packed-refs"), "utf8").catch(() => "");
  const loose = await readFile(path.join(repo, "refs", "heads", fixture.branch), "utf8").catch(
    () => "",
  );
  if (loose.trim() !== "") return loose.trim();

  const line = packed.split("\n").find((entry) => entry.endsWith(`refs/heads/${fixture.branch}`));
  return line?.split(" ")[0] ?? "";
}

/** Whether the cached clone holds any ref under the probe namespace. */
async function probedRefs(): Promise<readonly string[]> {
  const repo = path.join(cacheRoot(process.env), REPOS_DIRNAME, `${gitCacheKey(fixture.url)}.git`);
  const namespace = path.join(repo, ...PROBE_NAMESPACE.split("/"));
  return readdir(namespace).catch(() => []);
}

/** The skill names one bundle holds, from `resolve --json`. */
async function resolvedSkills(dir: string): Promise<readonly string[]> {
  const bundle = await json(dir, "resolve");
  return Object.keys(bundle.skills as Readonly<Record<string, unknown>>);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-update-"));
  // The cache is machine-wide, so every test points it somewhere disposable.
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  for (const [name, value] of Object.entries(ENV_STUBS)) vi.stubEnv(name, value);

  fixture = await buildFixtureGitCatalog(path.join(root, "remote"));
  project = path.join(root, "project");
  await writeProject(project, fixture.url, fixture.branch);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("ambit outdated leaves the cache exactly where it found it", () => {
  it("does not move the clone's own branch, so a later install pins the same commit", async () => {
    const first = await cli(project, "install");
    expect(first.code, first.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(fixture.commit);

    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
    });
    expect(moved).not.toBe(fixture.commit);

    const outdated = await cli(project, "outdated");
    expect(outdated.code, outdated.stderr).toBe(ExitCode.Success);
    expect(outdated.stdout).toContain("outdated");

    // The probe found the new commit and put it somewhere resolution does not read.
    expect(await probedRefs()).not.toEqual([]);
    expect(await cachedBranch()).toBe(fixture.commit);

    // Which is the claim that matters: an ordinary install after `outdated` installs what it would
    // have installed before it.
    const second = await cli(project, "install");
    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(fixture.commit);
    expect(await resolvedSkills(project)).not.toContain("deploy-runbook");
  });

  it("writes nothing into the project", async () => {
    const install = await cli(project, "install");
    expect(install.code, install.stderr).toBe(ExitCode.Success);
    await commitFixtureGitRevision(fixture, { "skills/deploy-runbook/SKILL.md": NEW_SKILL });
    const before = await readFile(path.join(project, LOCK_FILENAME), "utf8");

    await cli(project, "outdated");

    expect(await readFile(path.join(project, LOCK_FILENAME), "utf8")).toBe(before);
    expect(await readdir(path.join(project, SKILLS_DIR))).not.toContain("deploy-runbook");
  });
});

describe("what ambit outdated reports about a pin", () => {
  it("reports a branch whose commit moved, naming both ends", async () => {
    await cli(project, "install");
    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
    });

    const report = await json(project, "outdated");
    const catalogs = report.catalogs as Record<string, Record<string, unknown>>;

    expect(report.outdated).toBe(true);
    expect(catalogs[CATALOG_NAME]).toEqual({
      commit: fixture.commit,
      freshness: "outdated",
      latest: moved,
      ref: fixture.branch,
      source: fixture.url,
    });
  });

  it("reports a branch that has not moved as current", async () => {
    await cli(project, "install");

    const report = await json(project, "outdated");
    const catalogs = report.catalogs as Record<string, Record<string, unknown>>;

    expect(report.outdated).toBe(false);
    expect(report.changed).toBe(false);
    expect(catalogs[CATALOG_NAME]?.freshness).toBe("current");
    expect(catalogs[CATALOG_NAME]?.latest).toBe(fixture.commit);
  });

  it("reports a commit-pinned catalog as pinned, since there is nothing for it to be behind", async () => {
    await writeProject(project, fixture.url, fixture.commit);
    await cli(project, "install");
    await commitFixtureGitRevision(fixture, { "skills/deploy-runbook/SKILL.md": NEW_SKILL });

    const report = await json(project, "outdated");
    const catalogs = report.catalogs as Record<string, Record<string, unknown>>;

    expect(report.outdated).toBe(false);
    expect(catalogs[CATALOG_NAME]?.freshness).toBe("pinned");
  });

  it("reports a tag as a moving ref, since a tag can be force-pushed", async () => {
    await writeProject(project, fixture.url, fixture.tag);
    await cli(project, "install");

    const report = await json(project, "outdated");
    const catalogs = report.catalogs as Record<string, Record<string, unknown>>;

    // Still current — nothing moved the tag — but classified as something that *could* move, which is
    // the distinction `pinned` exists to draw.
    expect(catalogs[CATALOG_NAME]?.freshness).toBe("current");
  });

  it("reports a `path:` catalog as unversioned rather than current", async () => {
    await buildFixtureCatalog(path.join(root, "catalog"));
    await writeProject(project, "path:../catalog");
    await cli(project, "install");

    const report = await json(project, "outdated");
    const catalogs = report.catalogs as Record<string, Record<string, unknown>>;

    expect(catalogs[CATALOG_NAME]).toEqual({
      freshness: "unversioned",
      source: "path:../catalog",
    });
    expect(report.outdated).toBe(false);
  });
});

describe("the bundle diff, which is what makes the report about capabilities", () => {
  /** Installs, commits `files` on the branch, and returns what `outdated --json` says changed. */
  async function changesAfter(
    files: Readonly<Record<string, string | null>>,
  ): Promise<Readonly<Record<string, { changes: { name: string; detail: string }[] }>>> {
    const install = await cli(project, "install");
    expect(install.code, install.stderr).toBe(ExitCode.Success);
    await commitFixtureGitRevision(fixture, files);

    const report = await json(project, "outdated");
    return report as unknown as Readonly<
      Record<string, { changes: { name: string; detail: string }[] }>
    >;
  }

  it("reports a moved commit that changes nothing this project selects as no change at all", async () => {
    const report = await changesAfter({ "skills/brand-voice/SKILL.md": UNSELECTED_SKILL });

    // The pin moved…
    expect((report as unknown as Record<string, unknown>).outdated).toBe(true);
    // …and the answer to "what would I get" is: nothing new. Which is the whole argument for
    // diffing bundles rather than commits.
    expect((report as unknown as Record<string, unknown>).changed).toBe(false);
    expect(report.skills?.changes).toEqual([]);
  });

  it("names an arriving skill and why it would be selected", async () => {
    const report = await changesAfter({ "skills/deploy-runbook/SKILL.md": NEW_SKILL });

    expect(report.skills?.changes).toEqual([
      { change: "added", detail: "tag:company/function.engineering", name: "deploy-runbook" },
    ]);
  });

  it("names a departing skill and why it used to be selected", async () => {
    const report = await changesAfter({ "skills/code-review/SKILL.md": null });

    expect(report.skills?.changes).toEqual([
      { change: "removed", detail: "was tag:company/function.engineering", name: "code-review" },
    ]);
  });

  it("names the field a skill changed, in preference to naming the file", async () => {
    const changed = `---
name: code-review
description: A different description entirely.
ambit:
  tags: [function.engineering]
---

# Code review at Acme
`;
    const report = await changesAfter({ "skills/code-review/SKILL.md": changed });

    expect(report.skills?.changes).toEqual([
      { change: "changed", detail: "description changed", name: "code-review" },
    ]);
  });

  it("falls back to the bytes when a skill's declarations are untouched", async () => {
    const edited = `---
name: code-review
description: How Acme reviews code — what reviewers look for, and in what order.
ambit:
  tags: [function.engineering]
---

# Code review at Acme

An entirely rewritten body, with no frontmatter moved.
`;
    const report = await changesAfter({ "skills/code-review/SKILL.md": edited });

    expect(report.skills?.changes).toEqual([
      { change: "changed", detail: "content changed", name: "code-review" },
    ]);
  });

  it("names a server's changed field by the path its own document has", async () => {
    const moved = `name: tagged
tags: [function.engineering]

transport:
  http:
    url: https://mcp.invalid/moved
    headers:
      Authorization: "Bearer \${TAGGED_API_KEY}"

expects:
  - env: TAGGED_API_KEY
`;
    const report = await changesAfter({ "mcps/tagged.yml": moved });

    expect(report.mcps?.changes).toEqual([
      { change: "changed", detail: "transport.http.url changed", name: "tagged" },
    ]);
  });

  it("says what an arriving hook will actually run, not why it was selected", async () => {
    const hook = `name: block-force-push
tags: [function.engineering]

event: PreToolUse
matcher: Bash
type: command
command: ./bin/block-force-push
`;
    const report = await changesAfter({ "hooks/block-force-push/HOOK.yml": hook });

    expect(report.hooks?.changes).toEqual([
      {
        change: "added",
        detail: "PreToolUse Bash — runs ./bin/block-force-push",
        name: "block-force-push",
      },
    ]);
  });

  it("names the installed path a shipped script will run from", async () => {
    const hook = `name: audit-trail
tags: [function.engineering]

event: SessionEnd
type: script
command: audit.sh --strict
`;
    const report = await changesAfter({
      "hooks/audit-trail/HOOK.yml": hook,
      "hooks/audit-trail/audit.sh": "#!/bin/sh\nexit 0\n",
    });

    expect(report.hooks?.changes).toEqual([
      {
        change: "added",
        detail: "SessionEnd — runs .agents/hooks/audit-trail/audit.sh --strict",
        name: "audit-trail",
      },
    ]);
  });

  it("reports a changed hook script as a script change", async () => {
    const report = await changesAfter({
      "hooks/guard-secrets/guard.sh": "#!/bin/sh\n# rewritten\ncat >/dev/null\nexit 0\n",
    });

    expect(report.hooks?.changes).toEqual([
      { change: "changed", detail: "script changed", name: "guard-secrets" },
    ]);
  });
});

describe("ambit update", () => {
  it("moves the pin, rewrites the lock, and materializes what arrived", async () => {
    await cli(project, "install");
    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
    });

    const result = await cli(project, "update");
    expect(result.code, result.stderr).toBe(ExitCode.Success);

    expect(await lockedCommit(project)).toBe(moved);
    expect(await readdir(path.join(project, SKILLS_DIR))).toContain("deploy-runbook");
    // The report leads with the bundle change and ends with what was written.
    expect(result.stdout).toContain("+  deploy-runbook");
    expect(result.stdout).toContain(`${SKILLS_DIR}/deploy-runbook`);
  });

  it("leaves nothing outdated behind it", async () => {
    await cli(project, "install");
    await commitFixtureGitRevision(fixture, { "skills/deploy-runbook/SKILL.md": NEW_SKILL });
    await cli(project, "update");

    const report = await json(project, "outdated");

    expect(report.outdated).toBe(false);
    expect(report.changed).toBe(false);
  });

  it("installs into an uninstalled project, as `install` would", async () => {
    const result = await cli(project, "update");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(fixture.commit);
    expect(await readdir(path.join(project, SKILLS_DIR))).toContain("code-review");
  });

  it("--dry-run reports the same plan and touches neither the project nor the pin", async () => {
    await cli(project, "install");
    await commitFixtureGitRevision(fixture, { "skills/deploy-runbook/SKILL.md": NEW_SKILL });

    const preview = await cli(project, "update", "--dry-run");
    const report = await cli(project, "outdated");

    expect(preview.code, preview.stderr).toBe(ExitCode.Success);
    expect(preview.stdout).toBe(report.stdout);
    expect(await lockedCommit(project)).toBe(fixture.commit);
    expect(await readdir(path.join(project, SKILLS_DIR))).not.toContain("deploy-runbook");
  });

  it("refuses a catalog name the project does not configure, naming the ones it does", async () => {
    const result = await cli(project, "update", "compnay");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('unknown catalog "compnay"');
    expect(result.stderr).toContain(`this project configures: ${CATALOG_NAME}`);
  });

  // Two catalogs on two *different* sources, which is the case the plan can narrow. Two refs of one
  // repository share a clone and cannot be separated — `refreshPlan` says so at length.
  it("moves only the catalog it was told to", async () => {
    await buildFixtureCatalog(path.join(root, "catalog"));
    await writeFile(
      path.join(project, "ambit.yml"),
      `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: ${fixture.url}
    ref: "${fixture.branch}"
  - name: personal
    source: path:../catalog
requires:
${REQUIRES}
`,
      "utf8",
    );
    await cli(project, "install");
    await commitFixtureGitRevision(fixture, { "skills/deploy-runbook/SKILL.md": NEW_SKILL });

    const named = await cli(project, "update", "personal");
    expect(named.code, named.stderr).toBe(ExitCode.Success);

    // `personal` is a directory with no revision, so updating it moves nothing — and naming it must
    // not have moved the sibling that did have somewhere to go.
    expect(await lockedCommit(project)).toBe(fixture.commit);
    const report = await json(project, "outdated");
    expect(report.outdated).toBe(true);
  });
});

describe("--offline", () => {
  for (const command of [["outdated"], ["update"], ["update", "--dry-run"]]) {
    it(`refuses \`ambit ${command.join(" ")}\` rather than answering from the cache`, async () => {
      const install = await cli(project, "install");
      expect(install.code, install.stderr).toBe(ExitCode.Success);
      await commitFixtureGitRevision(fixture, { "skills/deploy-runbook/SKILL.md": NEW_SKILL });

      const result = await cli(project, ...command, "--offline");

      expect(result.code).toBe(ExitCode.Network);
      expect(result.stderr).toContain("`--offline` cannot answer where a ref points now");
      // The refusal is the point: reporting `current` here would be a confident wrong answer.
      expect(result.stdout).not.toContain("current");
    });
  }
});

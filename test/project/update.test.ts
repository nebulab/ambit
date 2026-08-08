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
const PACKS: readonly string[] = ["core", "function.engineering"];

/** The fixture's two credentials, stubbed so no run depends on the developer's environment. */
const ENV_STUBS: Readonly<Record<string, string>> = {
  LINTER_API_KEY: "update-tagged-key",
  FIXTURE_API_KEY: "update-fixture-key",
};

/** One `requires` entry, taking a whole pack from the catalog. */
function requiresEntry(pack: string, catalog = CATALOG_NAME): string {
  return `  - { pack: "${catalog}/${pack}" }`;
}

/** The `requires:` list every project here writes. */
const REQUIRES = PACKS.map((pack) => requiresEntry(pack)).join("\n");

/**
 * The engineering pack, rewritten to gather `extra` on top of its own members.
 *
 * A second revision that adds an item the project should see has to add it to a pack as well as to
 * the catalog: nothing labels itself any more, so arriving in `skills/` reaches nobody on its own.
 * That is the mechanism these cases are exercising as much as the diff is.
 *
 * @param extra further `requires` entry lines, without their leading `- `.
 * @param members the pack's own members, so a case about a *departing* item can drop one.
 */
function engineeringPack(
  extra: readonly string[] = [],
  members: readonly string[] = [
    "pack: core",
    "skill: code-review",
    "mcp: linter",
    "hook: guard-secrets",
  ],
): Readonly<Record<string, string>> {
  return {
    "packs/function/engineering.yml": [
      "name: function.engineering",
      "description: Everything an Acme engineer needs — reviews, tooling, and the guards around them.",
      "requires:",
      ...[...members, ...extra].map((line) => `  - ${line}`),
      "",
    ].join("\n"),
  };
}

/** A skill the first revision does not have, which the engineering pack then names. */
const NEW_SKILL = `---
name: deploy-runbook
description: How Acme deploys.
---

# Deploy runbook
`;

/** A skill no pack the project takes names, so committing it moves a commit and no capability. */
const UNSELECTED_SKILL = `---
name: brand-voice
description: How Acme writes.
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
      ...engineeringPack(["skill: deploy-runbook"]),
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
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });
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
      ...engineeringPack(["skill: deploy-runbook"]),
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
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

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
    const report = await changesAfter({
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

    expect(report.skills?.changes).toEqual([
      { change: "added", detail: "required-by:pack:function.engineering", name: "deploy-runbook" },
    ]);
    // The pack's own row says what moved about it, which is the cause the row above is the effect of.
    expect(report.packs?.changes).toEqual([
      { change: "changed", detail: "requires changed", name: "function.engineering" },
    ]);
  });

  it("names a departing skill and why it used to be selected", async () => {
    const report = await changesAfter({
      "skills/code-review/SKILL.md": null,
      ...engineeringPack([], ["pack: core", "mcp: linter", "hook: guard-secrets"]),
    });

    expect(report.skills?.changes).toEqual([
      {
        change: "removed",
        detail: "was required-by:pack:function.engineering",
        name: "code-review",
      },
    ]);
  });

  it("names the field a skill changed, in preference to naming the file", async () => {
    const changed = `---
name: code-review
description: A different description entirely.
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
    const moved = `name: linter

transport:
  http:
    url: https://mcp.invalid/moved
    headers:
      Authorization: "Bearer \${LINTER_API_KEY}"

expects:
  - env: LINTER_API_KEY
`;
    const report = await changesAfter({ "mcps/linter.yml": moved });

    expect(report.mcps?.changes).toEqual([
      { change: "changed", detail: "transport.http.url changed", name: "linter" },
    ]);
  });

  it("says what an arriving hook will actually run, not why it was selected", async () => {
    const hook = `name: block-force-push

event: PreToolUse
matcher: Bash
type: command
command: ./bin/block-force-push
`;
    const report = await changesAfter({
      "hooks/block-force-push/hook.yml": hook,
      ...engineeringPack(["hook: block-force-push"]),
    });

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

event: SessionEnd
type: script
command: audit.sh --strict
`;
    const report = await changesAfter({
      "hooks/audit-trail/hook.yml": hook,
      "hooks/audit-trail/audit.sh": "#!/bin/sh\nexit 0\n",
      ...engineeringPack(["hook: audit-trail"]),
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
      ...engineeringPack(["skill: deploy-runbook"]),
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
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });
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
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

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
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

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
      await commitFixtureGitRevision(fixture, {
        "skills/deploy-runbook/SKILL.md": NEW_SKILL,
        ...engineeringPack(["skill: deploy-runbook"]),
      });

      const result = await cli(project, ...command, "--offline");

      expect(result.code).toBe(ExitCode.Network);
      expect(result.stderr).toContain("`--offline` cannot answer where a ref points now");
      // The refusal is the point: reporting `current` here would be a confident wrong answer.
      expect(result.stdout).not.toContain("current");
    });
  }
});

/**
 * A `requires` entry naming a hook the catalog does not ship — the shape a catalog takes when a
 * commit is read by a build that has moved on past it. The one this was written for was a manifest
 * filename that changed: the skill's `requires` was right and the hook was there, and the older
 * commit spelled its manifest the way only the older build looked for it.
 */
const UNRESOLVABLE_SKILL = `---
name: deploy-runbook
description: How Acme deploys.
ambit:
  requires:
    - hook: no-such-hook
---

# Deploy runbook
`;

/**
 * The lock as an *input*, which is the only thing that makes committing one worth doing.
 *
 * Every case here is the same experiment: put the project's recorded commit and the shared clone's idea
 * of `main` into disagreement, then check which one wins. It has to be the lock, and it has to be the
 * lock even when the clone is warm and wrong, even when the clone is missing entirely, and even when
 * another project on the machine moved it on purpose. Nothing in the previous design could tell those
 * apart from the intended commit, which is why `--frozen` could not be satisfied by a project using
 * `ref: main` at all.
 */
describe("a reinstall, which has a recorded commit to reproduce", () => {
  /** Moves the shared clone's own `main` forward, the way another project running `update` does. */
  async function anotherProjectUpdates(): Promise<string> {
    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

    const mover = path.join(root, "mover");
    await writeProject(mover, fixture.url, fixture.branch);
    const update = await cli(mover, "update");
    expect(update.code, update.stderr).toBe(ExitCode.Success);
    expect(await cachedBranch()).toBe(moved);

    return moved;
  }

  /** Rewrites every commit the lock records, standing in for a lock a teammate committed. */
  async function rewriteLockedCommit(dir: string, commit: string): Promise<void> {
    const file = path.join(dir, LOCK_FILENAME);
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replaceAll(fixture.commit, commit), "utf8");
  }

  it("installs the commit the lock names, not the one the shared clone was moved to", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(fixture.commit);

    const moved = await anotherProjectUpdates();

    // The clone's `refs/heads/main` now says `moved`, so this is the case that used to drift: the
    // project's own `ref: main` would have resolved through the moved clone and installed it.
    const second = await cli(project, "install");

    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(await cachedBranch()).toBe(moved);
    expect(await lockedCommit(project)).toBe(fixture.commit);
    expect(await resolvedSkills(project)).not.toContain("deploy-runbook");

    // Every read-only command resolves the same commit as the install, or it would report on a project
    // nobody has: `resolve` above, and `status`, which plans through the adapters as install does.
    const status = await cli(project, "status");
    expect(status.code, status.stderr).toBe(ExitCode.Success);
  });

  it("satisfies `--frozen` on a cold cache, whatever the branch points at now", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    const committed = await readFile(path.join(project, LOCK_FILENAME), "utf8");
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

    // A CI runner: the committed lock, and a machine that has never fetched this repository. The clone
    // it makes has `main` at the new commit, which is precisely what `--frozen` used to fail on.
    await rm(cacheRoot(process.env), { recursive: true, force: true });

    const frozen = await cli(project, "install", "--frozen");

    expect(frozen.code, frozen.stderr).toBe(ExitCode.Success);
    expect(await readFile(path.join(project, LOCK_FILENAME), "utf8")).toBe(committed);
    expect(await resolvedSkills(project)).not.toContain("deploy-runbook");
  });

  it("reports the recorded commit as what the project resolves to, not the moved clone's", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    const moved = await anotherProjectUpdates();

    const report = await json(project, "outdated");
    const catalogs = report.catalogs as Record<string, Record<string, unknown>>;

    // `commit` is the pin and `latest` is the remote, so a report whose `commit` column showed the
    // clone's moved branch would be naming a commit this project would not install.
    expect(catalogs[CATALOG_NAME]?.commit).toBe(fixture.commit);
    expect(catalogs[CATALOG_NAME]?.latest).toBe(moved);
    expect(catalogs[CATALOG_NAME]?.freshness).toBe("outdated");
  });

  it("moves past the recorded commit for `ambit update`, which is the command that exists to", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

    const update = await cli(project, "update");

    // The install `update` ends with reads the same lock, which at that point still holds the commit
    // being replaced. Honouring it there would make the update undo itself.
    expect(update.code, update.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(moved);
    expect(await resolvedSkills(project)).toContain("deploy-runbook");
  });

  it("drops the pin when `ref:` is edited, since it answers a question that changed", async () => {
    await writeProject(project, fixture.url, fixture.tag);
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(fixture.commit);

    // The tag stays where it is and the branch moves, so the two refs now name different commits and
    // the edit is the only thing that can explain the new one.
    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });
    await writeProject(project, fixture.url, fixture.branch);

    const second = await cli(project, "install");

    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(moved);
  });

  it("resolves a catalog the lock has no entry for against its remote", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

    // Renaming the catalog is the smallest form of adding one: the lock pins `company`, the config now
    // declares `acme`, and nothing recorded says what `acme` resolves to. Taking the warm clone's
    // answer would be inheriting a commit this project never asked for.
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, "ambit.yml"),
      `version: 1
catalogs:
  - name: acme
    source: ${fixture.url}
    ref: "${fixture.branch}"
requires:
${PACKS.map((pack) => requiresEntry(pack, "acme")).join("\n")}
`,
      "utf8",
    );

    const second = await cli(project, "install");

    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(
      parseYamlMapping(await readFile(path.join(project, LOCK_FILENAME), "utf8"), LOCK_FILENAME)
        .requireMapping("catalogs")
        .requireMapping("acme")
        .optionalString("commit"),
    ).toBe(moved);
  });

  it("exits 2 for a recorded commit the repository does not have, naming the way out", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    const vanished = "d".repeat(40);
    await rewriteLockedCommit(project, vanished);

    const second = await cli(project, "install");

    // Fatal rather than a quiet fallback to `main`: installing a different commit than the lock names
    // is the one thing a lock exists to prevent, and a force-push is how this happens for real.
    expect(second.code).toBe(ExitCode.Config);
    expect(second.stderr).toContain(`cannot find the locked commit for catalog "${CATALOG_NAME}"`);
    expect(second.stderr).toContain(vanished);
    expect(second.stderr).toContain("run `ambit update`");
  });

  it("exits 4 under `--offline` for a recorded commit the cache does not hold", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    await rewriteLockedCommit(project, "d".repeat(40));

    const second = await cli(project, "install", "--offline");

    // Exit 4 rather than 2: the commit may well exist, and `--offline` is what stopped ambit finding out.
    expect(second.code).toBe(ExitCode.Network);
    expect(second.stderr).toContain("cannot resolve the locked commit from the cache");
    expect(second.stderr).toContain("without `--offline`");
  });

  it("exits 2 for a lock recording something that is not a commit", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    await rewriteLockedCommit(project, "main");

    const second = await cli(project, "install");

    expect(second.code).toBe(ExitCode.Config);
    expect(second.stderr).toContain("is pinned to something that is not a commit");
    expect(second.stderr).toContain(LOCK_FILENAME);
  });

  it("exits 2 for a lock it cannot read, rather than resolving as though there were none", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    await writeFile(path.join(project, LOCK_FILENAME), "catalogs: [\n", "utf8");

    const second = await cli(project, "install");

    // Ignoring it would resolve against the shared clone again, which is the drift the pins remove.
    expect(second.code).toBe(ExitCode.Config);
    expect(second.stderr).toContain(LOCK_FILENAME);
  });

  it("exits 2 for a lock version it does not know, since it cannot find the pins in it", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    const file = path.join(project, LOCK_FILENAME);
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("version: 1", "version: 99"), "utf8");

    const second = await cli(project, "install");

    expect(second.code).toBe(ExitCode.Config);
    expect(second.stderr).toContain("version 99");
    expect(second.stderr).toContain("upgrade ambit");
  });
});

describe("a first install, which has no earlier resolution to reproduce", () => {
  it("takes the commit the ref names now, not the one the shared cache happens to hold", async () => {
    // Some other project on this machine warmed the clone, and the branch moved afterwards.
    const warmed = path.join(root, "warmed");
    await writeProject(warmed, fixture.url, fixture.branch);
    expect((await cli(warmed, "install")).code).toBe(ExitCode.Success);
    const moved = await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

    const fresh = path.join(root, "fresh");
    await writeProject(fresh, fixture.url, fixture.branch);
    const install = await cli(fresh, "install");

    expect(install.code, install.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(fresh)).toBe(moved);
    expect(await resolvedSkills(fresh)).toContain("deploy-runbook");
  });

  it("leaves the cache alone once a lock exists, which is what makes a reinstall reproducible", async () => {
    expect((await cli(project, "install")).code).toBe(ExitCode.Success);
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });

    const second = await cli(project, "install");

    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(fixture.commit);
    expect(await resolvedSkills(project)).not.toContain("deploy-runbook");
  });

  it("does not reach the remote under `--offline`, which outranks it", async () => {
    await rm(fixture.repo, { recursive: true, force: true });

    const install = await cli(project, "install", "--offline");

    expect(install.code).toBe(ExitCode.Network);
    expect(await readdir(project)).not.toContain(LOCK_FILENAME);
  });
});

describe("ambit update, when the cached commit is one the project cannot resolve", () => {
  /** Leaves the clone's branch on a commit that does not resolve, and the remote on one that does. */
  async function breakTheCache(): Promise<string> {
    await commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": UNRESOLVABLE_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });
    const broken = await cli(project, "install");
    expect(broken.code).toBe(ExitCode.Resolution);

    return commitFixtureGitRevision(fixture, {
      "skills/deploy-runbook/SKILL.md": NEW_SKILL,
      ...engineeringPack(["skill: deploy-runbook"]),
    });
  }

  it("replaces it instead of dying on it, which is the whole reason to run update", async () => {
    const fixed = await breakTheCache();

    const update = await cli(project, "update");

    expect(update.code, update.stderr).toBe(ExitCode.Success);
    expect(await lockedCommit(project)).toBe(fixed);
    expect(await resolvedSkills(project)).toContain("deploy-runbook");
  });

  it("reports the pin as outdated, with no commit it claims to resolve to", async () => {
    const fixed = await breakTheCache();

    const report = await json(project, "outdated");
    const catalogs = report.catalogs as Record<string, Record<string, unknown>>;

    expect(report.outdated).toBe(true);
    // No `commit`: a project that resolves to nothing has no commit it resolves to, and naming the
    // one it failed at would read as a working pin.
    expect(catalogs[CATALOG_NAME]).toEqual({
      freshness: "outdated",
      latest: fixed,
      ref: fixture.branch,
      source: fixture.url,
    });
  });
});

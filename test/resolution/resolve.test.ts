/**
 * Resolution by pattern, and the `ambit resolve` output built on it.
 *
 * The rule under test is that one grammar does all the selecting: an entry is one key naming a
 * namespace and carrying the glob to match names in it, and an exact name is a glob with no
 * wildcard. So the cases here are about what an entry reaches — and, just as much, about what it
 * does not: `core.*` excluding `core`, a qualifier confining an entry to one catalog, and a
 * `skill:` entry never reaching a hook of the same name.
 *
 * Grouping is a **pack**: a catalog document whose `requires` names the items it gathers, and which
 * a project takes with one entry. The closure that expands one is the same closure a skill's own
 * `requires` goes through, so the two are tested together rather than as two mechanisms.
 *
 * The `resolve --json` shape is pinned by golden files under `test/golden/resolve/`, one per
 * profile, so a change in what a `requires` list selects shows up as a reviewable diff rather than
 * a rewritten assertion. Regenerate them with `UPDATE_GOLDEN=1 bun test` and read the diff.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { loadCatalogs, mergeCatalogs, skillNameFromPath } from "../../src/model/catalog.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";
import type { Bundle } from "../../src/resolution/resolve.js";
import { resolveBundle } from "../../src/resolution/resolve.js";
import type { SourceContext } from "../../src/model/sources.js";

const CATALOG_NAME = "company";

const CORE_SKILL = "company-context";
const ENGINEERING_SKILL = "code-review";
const FRONTEND_SKILL = "design-tokens";
const PROJECT_SKILL = "acme-brief";

/** The fixture's deepest pack name, which is what a section's first column pads out to. */
const FRONTEND_PACK = "function.engineering.frontend";

/** The fixture's two packed hooks, in the sections they appear in — both names 13 wide. */
const CORE_HOOK = "session-notes";
const ENGINEERING_HOOK = "guard-secrets";

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "golden",
  "resolve",
);

/**
 * The line {@link writeProfile} puts the first `requires` entry on, after the four-line preamble and
 * the key itself.
 *
 * Named because the exact line is what a refusal is asserted to print: the whole point of the message
 * is that it sends a reader to the offending line of their own config, so a loose assertion would
 * pass on a message that named the file alone.
 */
const FIRST_ENTRY_LINE = 6;

/**
 * One `requires` entry as a single config line.
 *
 * An entry is one key, so it occupies one line and the position a refusal names is countable from
 * the profile's four-line preamble. The address is qualified with the fixture catalog unless it
 * already carries a qualifier of its own.
 */
function entry(kind: "pack" | "skill" | "mcp" | "hook", address: string): string {
  const qualified = address.includes("/") ? address : `${CATALOG_NAME}/${address}`;
  return `  - { ${kind}: "${qualified}" }`;
}

/**
 * The profile matrix: one `requires` list each, with a golden file.
 *
 * `engineering` and `frontend` are two entries apart rather than one label and its subtree, and that
 * is the grammar being honest rather than a wart: `function.engineering` and
 * `function.engineering.*` are different patterns, and only the second reaches the nested
 * `frontend` pack. A dot is a character, not a level, so a pattern says what it takes.
 *
 * `core` is where the transitive half shows: the `function.engineering` pack requires the `core`
 * pack, so the `engineering` profile ends up holding everything `core` holds without naming it.
 */
const PROFILES: readonly { readonly name: string; readonly requires: readonly string[] }[] = [
  { name: "empty", requires: [] },
  { name: "core", requires: [entry("pack", "core")] },
  {
    name: "engineering",
    requires: [entry("pack", "function.engineering"), entry("pack", "function.engineering.*")],
  },
  {
    name: "core-and-engineering",
    requires: [
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ],
  },
  { name: "frontend", requires: [entry("pack", "function.engineering.frontend")] },
  { name: "project", requires: [entry("pack", "project.acme")] },
];

let root: string;
let catalogDir: string;
let projectDir: string;

/**
 * Points the project at the fixture catalog and gives it a `requires` list.
 *
 * @param extra further top-level config lines — a deleted key, for the cases that refuse one —
 *   appended after the list, so the line each entry sits on does not depend on them.
 */
async function writeProfile(
  requires: readonly string[],
  extra: readonly string[] = [],
): Promise<void> {
  const list = requires.length === 0 ? "[]" : `\n${requires.join("\n")}`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
requires: ${list}
${extra.map((line) => `${line}\n`).join("")}`,
    "utf8",
  );
}

/**
 * Adds an MCP entity to the fixture catalog, its name taken from its filename per §3.3.
 *
 * Only the cases the shared fixture cannot hold need this — a server whose name collides with a
 * skill's, which no sane catalog would ship.
 */
async function writeMcp(name: string, annotations: readonly string[] = []): Promise<void> {
  await writeFile(
    path.join(catalogDir, "mcps", `${name}.yml`),
    [
      `name: ${name}`,
      ...annotations,
      "transport:",
      "  stdio:",
      "    command: fixture-mcp",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * One entry of a skill's own `requires`, **unqualified** — the spelling a catalog demands, since the
 * alias in `catalogs:` belongs to the consumer and a catalog author cannot write it.
 *
 * By exact name, which is a pattern with no wildcard: most cases here are about what the closure does
 * with an edge rather than about what a glob reaches, and `pattern.test.ts` owns the matcher. The
 * cases that *are* about a pattern inside a catalog write one out.
 */
function needs(kind: string, name: string): string {
  return `{ ${kind}: "${name}" }`;
}

/**
 * Adds a pack to the fixture catalog, gathering `entries`.
 *
 * The other half of {@link inCorePack}: where that edits a pack the profile already takes, this one
 * declares a new grouping for a case that wants to select it by name.
 */
async function writePack(name: string, entries: readonly string[]): Promise<void> {
  await writeFile(
    path.join(catalogDir, "packs", `${name}.yml`),
    [
      `name: ${name}`,
      `description: The ${name} pack, written by a test.`,
      "requires:",
      ...entries.map((line) => `  - ${line}`),
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Rewrites the fixture's `core` pack so it gathers `entries` as well as its own two members.
 *
 * The stand-in for the label these cases used to hang on every item they wrote. Nothing labels itself
 * any more: a grouping is a document, so a case that needs its own skills in the bundle edits the
 * pack the profile takes — which is the edit an author would make in a real catalog, and the reason
 * a misspelling here is a resolution error rather than a new label reaching nobody.
 */
async function inCorePack(...entries: readonly string[]): Promise<void> {
  await writeFile(
    path.join(catalogDir, "packs", "core.yml"),
    [
      "name: core",
      "description: What every Acme session needs, whoever is in it.",
      "requires:",
      ...[`{ skill: "${CORE_SKILL}" }`, `{ hook: "${CORE_HOOK}" }`, ...entries].map(
        (line) => `  - ${line}`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );
}

/** A skill's whole `requires` list as one annotation line, from {@link needs} entries. */
function requires(...entries: readonly string[]): string {
  return `requires: [${entries.join(", ")}]`;
}

/**
 * The annotation lines as §3.2 nests them: under a top-level `ambit:`, indented with it.
 *
 * Callers still pass `requires:` as it is tabulated, so a fixture reads like the format's own
 * documentation and only one place knows where the block goes.
 */
function ambitBlock(annotations: readonly string[]): readonly string[] {
  return annotations.length === 0 ? [] : ["ambit:", ...annotations.map((line) => `  ${line}`)];
}

/**
 * Adds a skill to the fixture catalog, its name derived from its path per §2.
 *
 * The `requires` graphs under test — a chain, a diamond, a cycle — cannot live in the shared
 * fixture: a cycle there would fail every other profile, and `validate` (A23) is meant to reject
 * exactly that catalog. So each shape is written into the copy this test owns.
 */
async function writeSkill(relative: string, annotations: readonly string[]): Promise<void> {
  const target = path.join(catalogDir, "skills", relative, "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    [
      "---",
      `name: ${skillNameFromPath(relative)}`,
      ...ambitBlock(annotations),
      "---",
      "",
      "# fixture",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Adds a skill to a second catalog beside the fixture, for the cases about two catalogs providing one
 * name.
 *
 * @param catalog the catalog's directory, which is also the name config gives it.
 */
async function writeSkillIn(
  catalog: string,
  relative: string,
  annotations: readonly string[] = [],
): Promise<void> {
  const target = path.join(root, catalog, "skills", relative, "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    [
      "---",
      `name: ${skillNameFromPath(relative)}`,
      ...ambitBlock(annotations),
      "---",
      "",
      "# fixture",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Points the project at the fixture catalog and a second one beside it, with a `requires` list.
 *
 * The second catalog gets an alias of its own, which is what makes both copies of a name individually
 * addressable — and so what makes the collision below the project's to avoid.
 */
async function writeTwoCatalogProfile(second: string, requires: readonly string[]): Promise<void> {
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    [
      "version: 1",
      "catalogs:",
      `  - name: ${CATALOG_NAME}`,
      "    source: path:../catalog",
      `  - name: ${second}`,
      `    source: path:../${second}`,
      "requires:",
      ...requires,
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Adds a hook to the fixture catalog, its name derived from its path per §2. */
async function writeHook(name: string, lines: readonly string[]): Promise<void> {
  const target = path.join(catalogDir, "hooks", name.replaceAll(".", "/"), "hook.yml");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, [`name: ${name}`, ...lines, ""].join("\n"), "utf8");
}

/** The hooks the fixture itself ships: one tagged `core`, one `function.engineering`, one untagged. */
const FIXTURE_HOOKS = [CORE_HOOK, ENGINEERING_HOOK, "acme-standup"];

/**
 * The names of the hooks a case wrote, in bundle order, with the fixture's own left out.
 *
 * The fixture's hooks are reached by the same entries these cases hold, and every case here is about
 * the one document it wrote — the golden bundles are where the fixture's own selection is pinned.
 */
function writtenHooks(resolved: Bundle): readonly string[] {
  return resolved.hooks.map((hook) => hook.name).filter((name) => !FIXTURE_HOOKS.includes(name));
}

/** What source resolution reads from outside its arguments; every source here is a local path. */
function context(): SourceContext {
  return { projectDir, env: process.env };
}

/** Resolves the project in-process, skipping the CLI. */
async function bundle(requires: readonly string[], extra: readonly string[] = []): Promise<Bundle> {
  await writeProfile(requires, extra);
  const config = await loadProjectConfig(projectDir);
  return resolveBundle(config, mergeCatalogs(await loadCatalogs(config, context())));
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
 * Compares against the golden file, or rewrites it when `UPDATE_GOLDEN` is set.
 *
 * A missing file is a failure rather than an implicit accept: a golden file only means something
 * if a human read it once.
 */
async function expectGolden(name: string, actual: string): Promise<void> {
  const file = path.join(GOLDEN_DIR, `${name}.json`);

  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await writeFile(file, `${actual}\n`, "utf8");
    return;
  }

  let expected: string;
  try {
    expected = await readFile(file, "utf8");
  } catch {
    throw new Error(`missing golden file ${file}; regenerate with UPDATE_GOLDEN=1 bun test`);
  }
  expect(actual, `golden mismatch for ${name}; UPDATE_GOLDEN=1 bun test to accept`).toBe(
    expected.replace(/\n$/, ""),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-resolve-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile([entry("pack", "core")]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolve golden files", () => {
  for (const profile of PROFILES) {
    it(`matches the golden bundle for ${profile.name}`, async () => {
      await writeProfile(profile.requires);

      const result = await cli("resolve", "--json");
      expect(result.code).toBe(ExitCode.Success);
      await expectGolden(profile.name, result.stdout);
    });
  }
});

/**
 * The glob rules, end to end against a catalog rather than against the matcher alone.
 *
 * `pattern.test.ts` pins what a pattern matches; these pin that *selection* runs on it — the
 * exclusion in particular, since `core.*` not reaching `core` is the one rule whose cost the design
 * accepts as silent, and the only place it can be caught is a case that writes both items.
 */
describe("glob rules in selection", () => {
  beforeEach(async () => {
    await writeSkill("prefix", []);
    await writeSkill("prefix.child", []);
    await writeSkill("prefix.child.deeper", []);
    await writeSkill("prefix-sibling", []);
  });

  it("reaches every depth beneath a prefix, since `*` spans the dot", async () => {
    const selected = await bundle([entry("skill", "prefix.*")]);

    expect(selected.skills.map((skill) => skill.name)).toEqual([
      "prefix.child",
      "prefix.child.deeper",
    ]);
  });

  it("excludes the item named exactly the prefix, which takes a second entry", async () => {
    const one = await bundle([entry("skill", "prefix.*")]);
    expect(one.skills.map((skill) => skill.name)).not.toContain("prefix");

    const two = await bundle([entry("skill", "prefix"), entry("skill", "prefix.*")]);
    expect(two.skills.map((skill) => skill.name)).toContain("prefix");
  });

  it("does not reach a sibling whose name merely starts with the pattern's", async () => {
    // `prefix-sibling` reads as a hierarchy to a bare prefix check and to nobody else; the dot in
    // `prefix.*` is a literal character the sibling does not have.
    const selected = await bundle([entry("skill", "prefix.*")]);

    expect(selected.skills.map((skill) => skill.name)).not.toContain("prefix-sibling");
  });

  it("takes a whole namespace for a bare `*`, one entry per namespace", async () => {
    // A key names one namespace, so `*` is as wide as an entry gets: taking the whole catalog is
    // four entries, which is the grammar declining to guess how much of it somebody meant.
    const everything = await bundle([entry("skill", "*"), entry("mcp", "*")]);

    expect(everything.skills).toHaveLength(8);
    expect(everything.mcps.map((mcp) => mcp.name)).toEqual(["fixture", "linter"]);
    // The packs are a namespace of their own and no `skill: *` reaches them.
    expect(everything.packs).toEqual([]);
  });

  it("matches an exact name and nothing else when the pattern holds no wildcard", async () => {
    const selected = await bundle([entry("skill", "prefix.child")]);

    expect(selected.skills.map((skill) => skill.name)).toEqual(["prefix.child"]);
  });
});

/**
 * The two halves of an entry that are declared rather than guessed, and what each of them refuses to
 * reach.
 */
describe("what an entry does not reach", () => {
  it("never reaches a pack from a `skill:` entry, or the reverse", async () => {
    // The reason the key is written out at all: a catalog's namespaces are flat and independent, so
    // one name can legitimately belong to a pack and to a skill, and an entry says which it means.
    await writeSkill("core", []);

    expect((await bundle([entry("skill", "core")])).skills.map((skill) => skill.name)).toEqual([
      "core",
    ]);
    expect((await bundle([entry("skill", "core")])).packs).toEqual([]);
    expect((await bundle([entry("pack", "core")])).skills.map((skill) => skill.name)).toEqual([
      CORE_SKILL,
    ]);
  });

  it("takes a pack whole, which is the grouping a project asked for", async () => {
    // The other side of the same coin: a pack is not a filter a consumer narrows, it is a set the
    // catalog decided on, so taking `core` takes the hook in it as well as the skill.
    const core = await bundle([entry("pack", "core")]);

    expect(core.skills.map((skill) => skill.name)).toEqual([CORE_SKILL]);
    expect(core.hooks.map((hook) => hook.name)).toEqual([CORE_HOOK]);
  });

  it("confines an entry to the catalog it qualified", async () => {
    await writeSkillIn("personal", "personal-only", []);
    await writeTwoCatalogProfile("personal", [entry("pack", `${CATALOG_NAME}/core`)]);

    const config = await loadProjectConfig(projectDir);
    const resolved = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, context())));

    expect(resolved.skills.map((skill) => skill.name)).toEqual([CORE_SKILL]);
  });
});

describe("selection by pattern", () => {
  it("selects only what an entry reaches — nothing is implicit", async () => {
    const engineering = await bundle([
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    // `company-context` is here because `function.engineering` requires the `core` pack, which is
    // the composition packs exist for — and `acme-brief` is not, because nothing named it.
    expect(engineering.skills.map((skill) => skill.name)).toEqual([
      ENGINEERING_SKILL,
      CORE_SKILL,
      FRONTEND_SKILL,
    ]);
    expect(engineering.skills.map((skill) => skill.name)).not.toContain(PROJECT_SKILL);
  });

  it("selects the union of every entry in the list", async () => {
    const both = await bundle([
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    expect(both.skills.map((skill) => skill.name)).toEqual([
      ENGINEERING_SKILL,
      CORE_SKILL,
      FRONTEND_SKILL,
    ]);
  });

  it("does not reach a pack no entry names", async () => {
    for (const requires of [
      [entry("pack", "function.engineering"), entry("pack", "function.engineering.*")],
      [
        entry("pack", "core"),
        entry("pack", "function.engineering"),
        entry("pack", "function.engineering.*"),
      ],
    ]) {
      const resolved = await bundle(requires);
      expect(resolved.skills.map((skill) => skill.name)).not.toContain(PROJECT_SKILL);
    }
  });

  it("reaches exactly the pack a narrow entry names, and what that pack requires", async () => {
    const frontend = await bundle([entry("pack", "function.engineering.frontend")]);

    // Its own skill, plus everything the two packs beneath it name — and nothing from the project
    // pack, which nothing here reaches.
    expect(frontend.skills.map((skill) => skill.name)).toEqual([
      ENGINEERING_SKILL,
      CORE_SKILL,
      FRONTEND_SKILL,
    ]);
    expect(frontend.skills.map((skill) => skill.name)).not.toContain(PROJECT_SKILL);
  });

  it("yields an empty bundle for an empty `requires` list", async () => {
    const empty = await bundle([]);

    expect(empty).toEqual({
      packs: [],
      skills: [],
      mcps: [],
      hooks: [],
      expects: { env: [] },
      reasons: {
        packs: new Map(),
        skills: new Map(),
        mcps: new Map(),
        hooks: new Map(),
      },
    });
  });

  it("selects an MCP server through the pack that names it", async () => {
    expect(
      (
        await bundle([
          entry("pack", "function.engineering"),
          entry("pack", "function.engineering.*"),
        ])
      ).mcps.map((mcp) => mcp.name),
    ).toEqual(["linter"]);
    expect((await bundle([entry("pack", "core")])).mcps).toEqual([]);
  });

  it("unions `expects` across everything the list selected", async () => {
    // ACME_FIGMA_TOKEN comes from the nested frontend skill, LINTER_API_KEY from the server the
    // broader entry selects, so one list must produce both.
    const wide = await bundle([
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    expect(wide.expects.env).toEqual(["ACME_FIGMA_TOKEN", "LINTER_API_KEY"]);
  });

  it("selects an item once when two entries both reach it", async () => {
    // The pack and the exact name both reach `company-context`, and it is one item either way — a
    // bundle holds one entry per name, and which entry is reported is the reason's business.
    const twice = await bundle([entry("pack", "core"), entry("skill", CORE_SKILL)]);

    expect(twice.skills.map((skill) => skill.name)).toEqual([CORE_SKILL]);
  });
});

/**
 * Spec §4.9: the closure is what makes a skill's dependencies travel with it. The fixture's
 * project skill is the case the spec cares about — it requires a skill and a server that no entry
 * selecting the project skill itself would reach — and the graph shapes around it (chain, diamond,
 * cycle) are
 * written into the catalog per test.
 */
describe("the requires closure", () => {
  it("pulls in a required skill and MCP server that no entry in the profile matches", async () => {
    const project = await bundle([entry("pack", "project.acme")]);

    expect(project.skills.map((skill) => skill.name)).toEqual([PROJECT_SKILL, CORE_SKILL]);
    expect(project.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
  });

  it("unions `expects` over what the closure added, not only what an entry selected", async () => {
    // FIXTURE_API_KEY belongs to the server only `requires` can reach, so a bundle that lists the
    // server without its credential would send `doctor` looking at the wrong thing.
    expect((await bundle([entry("pack", "project.acme")])).expects.env).toEqual([
      "FIXTURE_API_KEY",
    ]);
  });

  it("follows a requirement of a requirement, to fixpoint", async () => {
    await writeSkill("chain-a", [requires(needs("skill", "chain-b"))]);
    await writeSkill("chain-b", [requires(needs("skill", "chain-c"))]);
    await writeSkill("chain-c", []);
    await inCorePack(needs("skill", "chain-a"));

    expect((await bundle([entry("pack", "core")])).skills.map((skill) => skill.name)).toEqual([
      "chain-a",
      "chain-b",
      "chain-c",
      CORE_SKILL,
    ]);
  });

  it("treats a requirement two skills share as a diamond, not a cycle", async () => {
    await writeSkill("diamond-left", [requires(needs("skill", "diamond-shared"))]);
    await writeSkill("diamond-right", [requires(needs("skill", "diamond-shared"))]);
    await writeSkill("diamond-shared", []);
    await inCorePack(needs("skill", "diamond-left"), needs("skill", "diamond-right"));

    const resolved = await bundle([entry("pack", "core")]);

    expect(
      resolved.skills.map((skill) => skill.name).filter((name) => name.startsWith("diamond-")),
    ).toEqual(["diamond-left", "diamond-right", "diamond-shared"]);
  });

  it("selects a required skill exactly once, however many skills require it", async () => {
    await writeSkill("twice-left", [requires(needs("mcp", "fixture"))]);
    await writeSkill("twice-right", [requires(needs("mcp", "fixture"))]);
    await inCorePack(needs("skill", "twice-left"), needs("skill", "twice-right"));

    expect((await bundle([entry("pack", "core")])).mcps.map((mcp) => mcp.name)).toEqual([
      "fixture",
    ]);
  });

  it("takes the requiring catalog's copy of a name two catalogs ship", async () => {
    // A name two catalogs ship is not ambiguous to a requirer, because the entry never leaves its own
    // catalog: `company`'s skill gets `company`'s copy and `personal`'s is not selected at all. So the
    // closure cannot pull one name in twice, and there is no collision here to refuse.
    await writeSkill("needs-shared", [requires(needs("skill", "shared-dep"))]);
    await writeSkill("shared-dep", []);
    await inCorePack(needs("skill", "needs-shared"));
    await writeSkillIn("personal", "shared-dep", []);
    await writeTwoCatalogProfile("personal", [entry("pack", `${CATALOG_NAME}/core`)]);

    const config = await loadProjectConfig(projectDir);
    const resolved = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, context())));

    expect(
      resolved.skills.filter((skill) => skill.name === "shared-dep").map((skill) => skill.catalog),
    ).toEqual([CATALOG_NAME]);
  });

  it("refuses a collision two project entries reach, the only way one arises now", async () => {
    // Collision is a project's ask, not a catalog's: both catalogs ship `house-style`, both entries
    // select a copy, and the two would materialize to one harness path.
    await writeSkill("house-style", []);
    await writeSkillIn("personal", "house-style", []);
    await writeTwoCatalogProfile("personal", [
      entry("skill", `${CATALOG_NAME}/house-style`),
      entry("skill", "personal/house-style"),
    ]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('skill "house-style" is selected from more than one catalog');
    expect(result.stderr).toContain(`provided by: ${CATALOG_NAME}, personal`);
  });

  it("leaves a broken skill nobody selected alone, so one bad entry blocks no one", async () => {
    // Spec §4's validation split: `resolve` hard-validates the selected closure only. This skill
    // declares no tags and no entry names it, so nothing reaches it and its dangling requirement is
    // `validate`'s business (A23), not this bundle's.
    await writeSkill("broken-unselected", [requires(needs("skill", "absent-skill"))]);

    const result = await cli("resolve");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });
});

/**
 * A `requires` entry inside a catalog that reaches nothing, which is the one refusal a `requires` list
 * earns at either altitude — the same finding a project's own entry earns, named the same way.
 *
 * The old *unresolvable requirement* is gone with the lookup it described: a requirement no longer
 * names a name that either is or is not there, so what these cases pin is which catalog was searched,
 * which namespaces, and the file the entry is written in.
 */
describe("`requires` entries that reach nothing", () => {
  it("exits 3 naming the entry, the catalog searched, and the file the edge is in", async () => {
    await writeSkill("broken-dangling", [requires(needs("skill", "absent-skill"))]);
    await inCorePack(needs("skill", "broken-dangling"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      '`requires` entry "skill:absent-skill" matches nothing (skills/broken-dangling/SKILL.md)',
    );
    expect(result.stderr).toContain(
      `no skill in catalog "${CATALOG_NAME}" has a name matching "absent-skill"`,
    );
  });

  it("names the MCP namespace, and only it, for a `[mcps]` entry", async () => {
    await writeSkill("broken-dangling-mcp", [requires(needs("mcp", "absent"))]);
    await inCorePack(needs("skill", "broken-dangling-mcp"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('`requires` entry "mcp:absent" matches nothing');
    expect(result.stderr).toContain(`no MCP server in catalog "${CATALOG_NAME}"`);
  });

  it("names the hook namespace, and only it, for a `[hooks]` entry", async () => {
    await writeSkill("broken-dangling-hook", [requires(needs("hook", "absent"))]);
    await inCorePack(needs("skill", "broken-dangling-hook"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      '`requires` entry "hook:absent" matches nothing (skills/broken-dangling-hook/SKILL.md)',
    );
    expect(result.stderr).toContain(`no hook in catalog "${CATALOG_NAME}"`);
  });

  it("does not accept a skill of that name for an entry that names only hooks", async () => {
    // A `hook:` entry names the hook namespace, and a skill called `absent` is not in it — or the
    // key would be decoration.
    await writeSkill("absent", []);
    await writeSkill("broken-wrong-namespace", [requires(needs("hook", "absent"))]);
    await inCorePack(needs("skill", "absent"), needs("skill", "broken-wrong-namespace"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('`requires` entry "hook:absent" matches nothing');
  });

  it("says another catalog's copy does not satisfy it, so a catalog stays self-contained", async () => {
    // The tightening: the merged view plainly holds `remote-only`, and `company`'s skill still cannot
    // require it. A catalog author cannot write a consumer's alias, so a bare pattern means this
    // catalog — and reaching across used to depend on which catalogs a project happened to list.
    await writeSkill("needs-across", [requires(needs("skill", "remote-only"))]);
    await inCorePack(needs("skill", "needs-across"));
    await writeSkillIn("personal", "remote-only");
    await writeTwoCatalogProfile("personal", [entry("pack", `${CATALOG_NAME}/core`)]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('`requires` entry "skill:remote-only" matches nothing');
    expect(result.stderr).toContain(
      "a catalog's own `requires` resolves within that catalog, which can only require what it ships",
    );
  });

  it("takes a wildcard inside a catalog, reaching every sibling under a prefix", async () => {
    // The point of one grammar at both altitudes: a skill can say *everything under `dep.`* exactly as
    // a project can, and it is one entry rather than one per sibling.
    await writeSkill("wide", [requires(needs("skill", "dep.*"))]);
    await writeSkill("dep.one", []);
    await writeSkill("dep.two", []);
    await inCorePack(needs("skill", "wide"));

    const selected = await bundle([entry("pack", "core")]);

    expect(selected.skills.map((skill) => skill.name)).toEqual([
      CORE_SKILL,
      "dep.one",
      "dep.two",
      "wide",
    ]);
  });

  it("takes a tag entry inside a catalog, and its capability list is obeyed", async () => {
    await writeHook("guard-tagged", [
      "event: PreToolUse",
      "matcher: Bash",
      "type: command",
      "command: npx guard",
    ]);
    await writeSkill("guarded", [requires(needs("hook", "*"))]);
    await inCorePack(needs("skill", "guarded"));

    const required = await bundle([entry("pack", "core")]);

    // Every hook the catalog ships, and no skill or server: `capabilities` is what bounds a wildcard.
    expect(required.hooks.map((hook) => hook.name)).toEqual([
      "acme-standup",
      "guard-secrets",
      "guard-tagged",
      CORE_HOOK,
    ]);
    expect(required.mcps).toEqual([]);
  });

  it("refuses a `requires` entry written as a bare string, naming both things it fails to say", async () => {
    // A plain list of names is the shape a reader reaches for, and it says nothing about which of
    // the four namespaces it means — the one declaration this grammar is made of.
    await writeSkill("legacy", ["requires: [mcp.absent]"]);
    await inCorePack(needs("skill", "legacy"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('`requires` entry "mcp.absent" is not a mapping');
    expect(result.stderr).toContain("does not say which namespace it selects from");
    expect(result.stderr).toContain('- skill: "mcp.absent"');
  });

  it("reads a one-key entry naming a namespace, which is the whole grammar", async () => {
    await writeSkill("modern", ["requires: [{ mcp: fixture }]"]);
    await inCorePack(needs("skill", "modern"));

    const resolved = await bundle([entry("pack", "core")]);

    expect(resolved.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
  });

  it("names the qualifier as refused for a catalog entry that writes one", async () => {
    // A catalog author cannot write the alias, so an address that carries one is exit 2 rather than a
    // pattern quietly resolved against a guess.
    await writeSkill("qualified", [`requires: [{ skill: "${CATALOG_NAME}/${CORE_SKILL}" }]`]);
    await inCorePack(needs("skill", "qualified"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(
      `\`requires\` entry "${CATALOG_NAME}/${CORE_SKILL}" names a catalog, which a catalog's own \`requires\` may not`,
    );
  });

  it("refuses an entry whose one key names no namespace", async () => {
    await writeSkill("typo", ["requires: [{ skil: a }]"]);
    await inCorePack(needs("skill", "typo"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('unknown key "ambit.requires[0].skil"');
    expect(result.stderr).toContain("accepted keys: hook, mcp, pack, skill");
  });
});

/**
 * `expects` is the last list written as one-key `<kind>: <name>` mappings — `requires` left that
 * spelling when it started selecting by pattern — so the shape errors here are what the grammar
 * `reference.ts` still serves refuses.
 *
 * The one thing deliberately *not* here is a resolution failure: an expectation names nothing a
 * catalog could provide, so there is no entry to write that could reach nothing and no cycle to close.
 * That is `doctor`'s question, and the split is exactly this: everything below fails at parse time, and
 * a variable the machine does not have fails nowhere until the machine is asked.
 */
describe("`expects` entries", () => {
  it("refuses an entry written as a bare string, naming the spelling it wanted", async () => {
    await writeSkill("legacy", ["expects: [CLOSE_API_KEY]"]);
    await inCorePack(needs("skill", "legacy"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('`expects` entry "CLOSE_API_KEY" names no precondition');
    expect(result.stderr).toContain("`- env: CLOSE_API_KEY`");
  });

  it("refuses an entry naming two preconditions at once", async () => {
    await writeSkill("greedy", ["expects: [{env: A, bin: b}]"]);
    await inCorePack(needs("skill", "greedy"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("an `expects` entry names 2 preconditions: bin, env");
  });

  it("refuses a kind that is not one this version knows", async () => {
    // `bin:` is the obvious second kind and is deliberately not one yet, so this doubles as the
    // claim that a catalog written against a later ambit fails loudly here rather than silently
    // declaring nothing.
    await writeSkill("ahead", ["expects: [{bin: docker}]"]);
    await inCorePack(needs("skill", "ahead"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('unknown precondition "bin" in an `expects` entry');
  });

  it("takes an `expects` on all three kinds, which is what `requires` cannot do", async () => {
    await writeSkill("reader", ["expects: [{env: SKILL_VAR}]"]);
    await writeMcp("server", ["expects: [{env: MCP_VAR}]"]);
    await writeHook("watcher", [
      "event: Stop",
      "type: command",
      "command: npx watch",
      "expects: [{env: HOOK_VAR}]",
    ]);
    await inCorePack(needs("skill", "reader"), needs("mcp", "server"), needs("hook", "watcher"));

    expect((await bundle([entry("pack", "core")])).expects.env).toEqual(
      expect.arrayContaining(["HOOK_VAR", "MCP_VAR", "SKILL_VAR"]),
    );
  });
});

describe("requirement cycles", () => {
  it("exits 3 printing the whole path, not just the fact of a cycle", async () => {
    await writeSkill("cycle-a", [requires(needs("skill", "cycle-b"))]);
    await writeSkill("cycle-b", [requires(needs("skill", "cycle-c"))]);
    await writeSkill("cycle-c", [requires(needs("skill", "cycle-a"))]);
    await inCorePack(needs("skill", "cycle-a"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("requirement cycle");
    expect(result.stderr).toContain(
      "skill:cycle-a → skill:cycle-b → skill:cycle-c → skill:cycle-a",
    );
    // The closing edge, which is the actionable half: the entry, and the file it is written in.
    expect(result.stderr).toContain("closed by `skill:cycle-a` in skills/cycle-c/SKILL.md");
    expect(result.stderr).toContain("break the cycle by removing one `requires` entry");
  });

  it("reports a skill that requires itself as the one-step cycle it is", async () => {
    await writeSkill("cycle-self", [requires(needs("skill", "cycle-self"))]);
    await inCorePack(needs("skill", "cycle-self"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("skill:cycle-self → skill:cycle-self");
  });

  it("reports a cycle reached only through a requirement, not just one held directly", async () => {
    await writeSkill("cycle-entry", [requires(needs("skill", "cycle-b"))]);
    await writeSkill("cycle-b", [requires(needs("skill", "cycle-c"))]);
    await writeSkill("cycle-c", [requires(needs("skill", "cycle-b"))]);
    await inCorePack(needs("skill", "cycle-entry"));

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("skill:cycle-b → skill:cycle-c → skill:cycle-b");
  });

  it("names the same cycle whatever order a `requires` list is written in", async () => {
    await writeSkill("cycle-a", [requires(needs("skill", "cycle-b"), needs("skill", "cycle-c"))]);
    await writeSkill("cycle-b", [requires(needs("skill", "cycle-a"))]);
    await writeSkill("cycle-c", [requires(needs("skill", "cycle-a"))]);
    await inCorePack(needs("skill", "cycle-a"));
    const first = await cli("resolve");

    await writeSkill("cycle-a", [requires(needs("skill", "cycle-c"), needs("skill", "cycle-b"))]);
    await inCorePack(needs("skill", "cycle-a"));
    const second = await cli("resolve");

    expect(first.stderr).toContain("skill:cycle-a → skill:cycle-b → skill:cycle-a");
    expect(second.stderr).toBe(first.stderr);
  });
});

/**
 * An exact name is a pattern with no wildcard, which is what folded the old explicit `skills:` list
 * into `requires` — one operator rather than two routes with two spellings and two error classes.
 *
 * The keys that used to do the selecting, and the two forms that let a project define an item of its
 * own, are all refused. The refusals are asserted end to end here because the exit code is what a user
 * meets; their wording is `config.test.ts`'s.
 */
describe("exact-name entries", () => {
  it("selects a name from a catalog, whatever tags it declares", async () => {
    const named = await bundle([entry("skill", ENGINEERING_SKILL)]);

    expect(named.skills.map((skill) => skill.name)).toEqual([ENGINEERING_SKILL]);
    // No tag entry was written, so the skill's own `function.engineering` tag did none of the work.
    expect(named.reasons.skills.get(ENGINEERING_SKILL)).toMatchObject({
      entry: { kind: "skill" },
    });
  });

  it("closes a named skill over its own `requires`", async () => {
    const named = await bundle([entry("skill", PROJECT_SKILL)]);

    expect(named.skills.map((skill) => skill.name)).toEqual([PROJECT_SKILL, CORE_SKILL]);
    expect(named.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
    expect(named.expects.env).toEqual(["FIXTURE_API_KEY"]);
  });

  it("reaches an MCP server and a hook by name, which no explicit list ever could", async () => {
    // The payoff of one grammar: `skills:` could only ever name a skill, so a server or a hook a
    // catalog shipped was reachable by tag or by a `requires` edge and by nothing else.
    const named = await bundle([entry("mcp", "fixture"), entry("hook", "acme-standup")]);

    expect(named.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
    expect(named.hooks.map((hook) => hook.name)).toEqual(["acme-standup"]);
    expect(named.skills).toEqual([]);
  });

  it("exits 3 for a name no catalog provides, naming the entry and its line", async () => {
    await writeProfile([entry("skill", "absent-skill")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `\`requires\` entry "skill:${CATALOG_NAME}/absent-skill" matches nothing (ambit.yml line ${FIRST_ENTRY_LINE})`,
    );
    expect(result.stderr).toContain(
      `no skill in catalog "${CATALOG_NAME}" has a name matching "absent-skill"`,
    );
    expect(result.stderr).toContain("correct the pattern, add the item to a catalog");
  });

  it("exits 2 for a top-level `scopes`, naming the entry each held scope becomes", async () => {
    await writeProfile([], ["scopes:", "  - core"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("top-level `scopes` is gone");
    expect(result.stderr).toContain(
      "declare a pack in the catalog that requires them, and select it with `pack:`",
    );
  });

  it("exits 2 for a top-level `skills`, naming the entry each name becomes", async () => {
    await writeProfile([], ["skills:", `  - ${CORE_SKILL}`]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("top-level `skills` is gone");
    expect(result.stderr).toContain(
      `\`${CORE_SKILL}\` becomes \`- skill: "${CATALOG_NAME}/${CORE_SKILL}"\``,
    );
  });

  it("exits 2 for a top-level `mcps`, naming the file the definition moves into", async () => {
    await writeProfile(
      [],
      [
        "mcps:",
        "  - name: custom",
        "    transport:",
        "      stdio:",
        "        command: custom-mcp",
      ],
    );

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("top-level `mcps` is gone");
    expect(result.stderr).toContain("move each entry to `mcps/<name>.yml`");
    expect(result.stderr).toContain("`- name: local` with `source: path:.`");
  });

  it("exits 2 for a top-level `hooks`, naming the file the definition moves into", async () => {
    await writeProfile(
      [],
      [
        "hooks:",
        "  - name: notify",
        "    event: Stop",
        "    type: command",
        "    command: ./notify",
      ],
    );

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("top-level `hooks` is gone");
    expect(result.stderr).toContain("move each entry to `hooks/<name>/hook.yml`");
  });
});

/**
 * A hook a *catalog* provides is selected exactly as a server is: by a `hook:` entry whose pattern
 * reaches it, or by a pack that names it, and belonging to no pack leaves it reachable by name or by
 * a `requires` edge alone.
 *
 * That is the whole difference distribution makes to resolution — the same two routes, now with a
 * fourth namespace coming down them — so what is asserted here is that the hook namespace goes
 * through the merged catalog rather than being read off the config, which is where it started.
 */
describe("catalog hooks", () => {
  const HOOK_NAME = "block-rm";

  beforeEach(async () => {
    await writeHook(HOOK_NAME, [
      "event: PreToolUse",
      "matcher: Bash",
      "type: command",
      "command: npx block-rm",
    ]);
  });

  it("selects a catalog hook through a pack, naming the entry that reached it", async () => {
    await writePack("guards", [needs("hook", HOOK_NAME)]);

    const guarded = await bundle([entry("pack", "guards")]);

    expect(writtenHooks(guarded)).toEqual([HOOK_NAME]);
    expect(guarded.hooks[0]).toMatchObject({ catalog: CATALOG_NAME, type: "command" });
    // The reason names the pack the project asked for, not the hook's membership in it: the entry
    // is the half a reader can go and edit.
    expect(guarded.reasons.hooks.get(HOOK_NAME)).toEqual({
      kind: "required-by",
      requirer: { kind: "pack", name: "guards" },
    });
  });

  it("names the project's own entry when one reaches the hook directly", async () => {
    const named = await bundle([entry("hook", HOOK_NAME)]);

    expect(named.reasons.hooks.get(HOOK_NAME)).toEqual({
      kind: "selected",
      entry: { kind: "hook", pattern: HOOK_NAME, catalog: CATALOG_NAME },
    });
  });

  it("reaches a hook through a wildcard entry, and not through the exact name above it", async () => {
    const wide = await bundle([entry("hook", "block-*")]);
    expect(wide.reasons.hooks.get(HOOK_NAME)).toMatchObject({
      entry: { pattern: "block-*" },
    });

    const elsewhere = await bundle([entry("pack", "core")]);
    expect(writtenHooks(elsewhere)).toEqual([]);
  });

  it("leaves a hook no pack names out of every pack-selected bundle", async () => {
    const everything = await bundle([
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
      entry("pack", "project.acme"),
    ]);

    expect(writtenHooks(everything)).toEqual([]);
  });

  it("names the catalog it came from in `resolve`", async () => {
    await writeProfile([entry("hook", HOOK_NAME), entry("pack", "function.engineering")]);

    // Beside the fixture's own hook, which is what the section's padding widens to.
    expect((await cli("resolve")).stdout).toContain(
      `hooks (3)\n  ${HOOK_NAME.padEnd(ENGINEERING_HOOK.length)}  ${CATALOG_NAME}  PreToolUse\n  ${ENGINEERING_HOOK}  ${CATALOG_NAME}  PreToolUse`,
    );
  });
});

/**
 * A `hook:<name>` requirement is the second route into a bundle, and the only one that reaches a hook
 * the project never named: a skill whose instructions are unsafe without its guard carries the guard.
 *
 * Every hook here declares no tag at all, so being required is doing all the work — a hook a project
 * entry could also have reached would prove nothing about the edge.
 */
describe("hooks reached through `requires`", () => {
  const HOOK_NAME = "guard";

  beforeEach(async () => {
    await writeHook(HOOK_NAME, [
      "event: PreToolUse",
      "matcher: Bash",
      "type: command",
      "command: npx guard",
      "expects: [{ env: GUARD_TOKEN }]",
    ]);
  });

  it("pulls a hook in behind the skill that requires it, and names the requirer", async () => {
    await writeSkill("risky", [requires(needs("hook", HOOK_NAME))]);
    await inCorePack(needs("skill", "risky"));

    const required = await bundle([entry("pack", "core")]);

    expect(writtenHooks(required)).toEqual([HOOK_NAME]);
    expect(required.reasons.hooks.get(HOOK_NAME)).toEqual({
      kind: "required-by",
      requirer: { kind: "skill", name: "risky" },
    });
  });

  it("unions a required hook's `expects`, so the closure feeds the credential list too", async () => {
    await writeSkill("risky", [requires(needs("hook", HOOK_NAME))]);
    await inCorePack(needs("skill", "risky"));

    expect((await bundle([entry("pack", "core")])).expects.env).toContain("GUARD_TOKEN");
  });

  it("reaches a hook down a chain, not only from a skill an entry selected", async () => {
    await writeSkill("chain-leaf", [requires(needs("hook", HOOK_NAME))]);
    await writeSkill("chain-root", [requires(needs("skill", "chain-leaf"))]);
    await inCorePack(needs("skill", "chain-root"));

    const required = await bundle([entry("pack", "core")]);

    expect(writtenHooks(required)).toEqual([HOOK_NAME]);
    expect(required.reasons.hooks.get(HOOK_NAME)).toEqual({
      kind: "required-by",
      requirer: { kind: "skill", name: "chain-leaf" },
    });
  });

  it("leaves the hook out when nothing selected requires it", async () => {
    // The same catalog, the same hook: what differs is that the requiring skill is not selected, so
    // the edge exists and reaches nothing.
    await writeSkill("risky", [requires(needs("hook", HOOK_NAME))]);

    expect(writtenHooks(await bundle([entry("pack", "core")]))).toEqual([]);
  });
});

/**
 * Spec §6: every selected item carries the reason it is in the bundle — one of the two routes
 * resolution offers, and only one, so a reader gets an answer rather than a list of possibilities.
 *
 * The reason is asserted on the bundle rather than only through `--explain`, because the lock
 * records it too and both surfaces have to agree by construction.
 */
describe("selection reasons", () => {
  it("names the entry that selected an item, not the value it matched", async () => {
    const wide = await bundle([
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    // The reason is the pack the *project* named, not the item's membership in it: a reader looking
    // for why goes to their own `requires` list, which is the half they can change.
    expect(wide.reasons.skills.get(ENGINEERING_SKILL)).toEqual({
      kind: "required-by",
      requirer: { kind: "pack", name: "function.engineering" },
    });
    expect(wide.reasons.packs.get("function.engineering")).toEqual({
      kind: "selected",
      entry: {
        kind: "pack",
        pattern: "function.engineering",
        catalog: CATALOG_NAME,
      },
    });
    // Reached through the wildcard entry's pack, and it is that pack the reason names.
    expect(wide.reasons.skills.get(FRONTEND_SKILL)).toMatchObject({
      kind: "required-by",
      requirer: { kind: "pack", name: "function.engineering.frontend" },
    });
    expect(wide.reasons.packs.get("function.engineering.frontend")).toMatchObject({
      kind: "selected",
      entry: { pattern: "function.engineering.*" },
    });
  });

  it("names the requirer of a skill and a server no entry selected", async () => {
    const project = await bundle([entry("pack", "project.acme")]);

    expect(project.reasons.skills.get(CORE_SKILL)).toEqual({
      kind: "required-by",
      requirer: { kind: "skill", name: PROJECT_SKILL },
    });
    expect(project.reasons.mcps.get("fixture")).toEqual({
      kind: "required-by",
      requirer: { kind: "skill", name: PROJECT_SKILL },
    });
  });

  it("names the first requirer by name, not the first the closure happened to walk", async () => {
    await writeSkill("twice-left", [requires(needs("mcp", "fixture"))]);
    await writeSkill("twice-right", [requires(needs("mcp", "fixture"))]);
    await inCorePack(needs("skill", "twice-left"), needs("skill", "twice-right"));

    expect((await bundle([entry("pack", "core")])).reasons.mcps.get("fixture")).toEqual({
      kind: "required-by",
      requirer: { kind: "skill", name: "twice-left" },
    });
  });

  it("tie-breaks two entries that both reach an item on sorted order", async () => {
    // Both routes are true, and an entry beats an edge: the entry ends the chain where the pack's
    // membership continues one.
    const both = await bundle([
      entry("pack", "function.engineering"),
      entry("skill", ENGINEERING_SKILL),
    ]);

    expect(both.reasons.skills.get(ENGINEERING_SKILL)).toMatchObject({
      entry: { kind: "skill", pattern: ENGINEERING_SKILL },
    });
  });

  it("prefers an entry over a `requires` edge, since the entry ends the chain", async () => {
    // `company-context` is both required by the project skill and named outright; the entry is the
    // shorter true answer, and the one the reader can act on.
    const both = await bundle([entry("pack", "project.acme"), entry("skill", CORE_SKILL)]);

    expect(both.reasons.skills.get(CORE_SKILL)).toMatchObject({ kind: "selected" });
  });

  it("explains every item it selected, leaving nothing unaccounted for", async () => {
    const wide = await bundle([
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
      entry("pack", "project.acme"),
    ]);

    expect([...wide.reasons.skills.keys()]).toEqual(wide.skills.map((skill) => skill.name));
    expect([...wide.reasons.mcps.keys()]).toEqual(wide.mcps.map((mcp) => mcp.name));
  });
});

describe("ambit resolve --explain", () => {
  it("adds a reason column to every section but `expects`", async () => {
    await writeProfile([
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    const result = await cli("resolve", "--explain");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    const PACK = "function.engineering.frontend";
    expect(result.stdout).toBe(
      [
        "packs (3)",
        `  ${"core".padEnd(PACK.length)}  ${CATALOG_NAME}  pack:${CATALOG_NAME}/core`,
        `  ${"function.engineering".padEnd(PACK.length)}  ${CATALOG_NAME}  pack:${CATALOG_NAME}/function.engineering`,
        `  ${PACK}  ${CATALOG_NAME}  pack:${CATALOG_NAME}/function.engineering.*`,
        "",
        "skills (3)",
        `  ${ENGINEERING_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}  required-by:pack:function.engineering`,
        `  ${CORE_SKILL}  ${CATALOG_NAME}  required-by:pack:core`,
        `  ${FRONTEND_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}  required-by:pack:function.engineering.frontend`,
        "",
        "mcps (1)",
        `  linter  ${CATALOG_NAME}  required-by:pack:function.engineering`,
        "",
        "hooks (2)",
        `  ${ENGINEERING_HOOK}  ${CATALOG_NAME}  PreToolUse    required-by:pack:function.engineering`,
        `  ${CORE_HOOK}  ${CATALOG_NAME}  SessionStart  required-by:pack:core`,
        "",
        "expects (2)",
        "  env  ACME_FIGMA_TOKEN",
        "  env  LINTER_API_KEY",
      ].join("\n"),
    );
  });

  it("adds a reason to every JSON record, which plain `--json` omits", async () => {
    await writeProfile([entry("pack", "project.acme")]);

    const explained = JSON.parse((await cli("resolve", "--explain", "--json")).stdout) as {
      skills: Record<string, { reason?: string }>;
      mcps: Record<string, { reason?: string }>;
    };

    expect(explained.skills[CORE_SKILL]?.reason).toBe(`required-by:skill:${PROJECT_SKILL}`);
    expect(explained.skills[PROJECT_SKILL]?.reason).toBe("required-by:pack:project.acme");
    expect(explained.mcps.fixture?.reason).toBe(`required-by:skill:${PROJECT_SKILL}`);

    const plain = JSON.parse((await cli("resolve", "--json")).stdout) as {
      skills: Record<string, { reason?: string }>;
    };
    expect(plain.skills[PROJECT_SKILL]).not.toHaveProperty("reason");
  });
});

/**
 * Spec §6: `ambit why <name>` prints the chain from a `requires` entry to the item. The chain matters more
 * than the reason — `required-by:x` only moves the question up a level — so the assertions are on
 * the whole path, not on the last link.
 */
describe("ambit why", () => {
  it("prints the one-link chain of something an entry selected outright", async () => {
    await writeProfile([entry("pack", "core")]);

    const result = await cli("why", `skill:${CORE_SKILL}`);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        `skill ${CORE_SKILL}`,
        "",
        "chain (2)",
        `  ${"core".padEnd(CORE_SKILL.length)}  pack   pack:${CATALOG_NAME}/core`,
        `  ${CORE_SKILL}  skill  required-by:pack:core`,
      ].join("\n"),
    );
  });

  it("walks back through `requires` to the entry that started it", async () => {
    await writeProfile([entry("pack", "project.acme")]);

    const result = await cli("why", `skill:${CORE_SKILL}`);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        `skill ${CORE_SKILL}`,
        "",
        "chain (3)",
        `  ${"project.acme".padEnd(CORE_SKILL.length)}  pack   pack:${CATALOG_NAME}/project.acme`,
        `  ${PROJECT_SKILL.padEnd(CORE_SKILL.length)}  skill  required-by:pack:project.acme`,
        `  ${CORE_SKILL}  skill  required-by:skill:${PROJECT_SKILL}`,
      ].join("\n"),
    );
  });

  it("names the entry as written, wildcard included, when that is what reached the item", async () => {
    // The whole reason a reason carries the entry rather than the matched name: the wildcard is
    // what the reader can go and change, and the chain ends on it.
    await writeProfile([
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    const result = await cli("why", `skill:${FRONTEND_SKILL}`);

    expect(result.stdout).toContain(`pack:${CATALOG_NAME}/function.engineering.*`);
  });

  it("finds a server by the `mcp:` reference `requires` uses", async () => {
    await writeProfile([entry("pack", "project.acme")]);

    const result = await cli("why", "mcp:fixture");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("mcp fixture");
    expect(result.stdout).toContain(
      `${"fixture".padEnd("project.acme".length)}  mcp    required-by:skill:${PROJECT_SKILL}`,
    );
  });

  it("refuses a bare name, in the words every list that names an item refuses one", async () => {
    await writeProfile([entry("pack", "core")]);

    const result = await cli("why", CORE_SKILL);

    // Refused rather than looked up, even though this command *could* look it up: one grammar
    // everywhere a name is taken from a person beats a rule that holds only while a name is unique.
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`\`why ${CORE_SKILL}\` does not say what to explain`);
    expect(result.stderr).toContain(`\`pack:${CORE_SKILL}\`, \`skill:${CORE_SKILL}\``);
  });

  it("names either namespace for a name both hold", async () => {
    await writeMcp(CORE_SKILL, []);
    await inCorePack(needs("mcp", CORE_SKILL));
    await writeProfile([entry("pack", "core")]);

    // Two namespaces answering to one name is a legitimate catalog, and neither reading is preferred
    // over the other — both are simply asked for.
    expect((await cli("why", `skill:${CORE_SKILL}`)).stdout).toContain(`skill ${CORE_SKILL}`);
    expect((await cli("why", `mcp:${CORE_SKILL}`)).stdout).toContain(`mcp ${CORE_SKILL}`);
  });

  it("reaches a skill whose own name reads like another namespace's prefix", async () => {
    // The bug this format was changed for: `skills/mcp/sentry/SKILL.md` is the skill `mcp.sentry`,
    // and under a prefix convention no string could name it.
    await writeSkill("mcp.sentry", []);
    await inCorePack(needs("skill", "mcp.sentry"));
    await writeProfile([entry("pack", "core")]);

    expect((await cli("why", "skill:mcp.sentry")).stdout).toContain("skill mcp.sentry");
  });

  it("lets a skill named for one namespace and an entity of that name coexist", async () => {
    await writeSkill("mcp.sentry", []);
    await writeMcp("sentry", []);
    await inCorePack(needs("skill", "mcp.sentry"), needs("mcp", "sentry"));
    await writeProfile([entry("pack", "core")]);

    // Two different things, and both reachable: the kind decides, and the name never does.
    expect((await cli("why", "skill:mcp.sentry")).stdout).toContain("skill mcp.sentry");
    expect((await cli("why", "mcp:sentry")).stdout).toContain("mcp sentry");
  });

  it("prints the chain to a hook a skill required, ending on the hook", async () => {
    await writeHook("guard", [
      "event: PreToolUse",
      "matcher: Bash",
      "type: command",
      "command: npx guard",
    ]);
    await writeSkill("risky", [requires(needs("hook", "guard"))]);
    await inCorePack(needs("skill", "risky"));
    await writeProfile([entry("pack", "core")]);

    const result = await cli("why", "hook:guard");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "hook guard",
        "",
        "chain (3)",
        `  core   pack   pack:${CATALOG_NAME}/core`,
        "  risky  skill  required-by:pack:core",
        "  guard  hook   required-by:skill:risky",
      ].join("\n"),
    );
  });

  it("insists on the hook for a `hook:` reference a skill also answers to", async () => {
    await writeHook(CORE_SKILL, ["event: Stop", "type: command", "command: npx notify"]);
    await inCorePack(needs("hook", CORE_SKILL));
    await writeProfile([entry("pack", "core")]);

    expect((await cli("why", `skill:${CORE_SKILL}`)).stdout).toContain(`skill ${CORE_SKILL}`);
    expect((await cli("why", `hook:${CORE_SKILL}`)).stdout).toContain(`hook ${CORE_SKILL}`);
  });

  it("names the entry that would select an unselected hook", async () => {
    await writeHook("guard", [
      "event: PreToolUse",
      "matcher: Bash",
      "type: command",
      "command: npx guard",
    ]);
    await writeProfile([entry("pack", "core")]);

    const result = await cli("why", "hook:guard");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('hook "guard" is not in the bundle');
    // By exact name and qualified, which is the one entry that selects this copy and nothing else.
    expect(result.stderr).toContain(`select it with \`- hook: "${CATALOG_NAME}/guard"\``);
  });

  it("reports a name entry as the whole chain, since nothing precedes it", async () => {
    await writeProfile([entry("skill", ENGINEERING_SKILL)]);

    const result = await cli("why", `skill:${ENGINEERING_SKILL}`);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(
      `${ENGINEERING_SKILL}  skill  skill:${CATALOG_NAME}/${ENGINEERING_SKILL}`,
    );
  });

  it("emits the chain, the item, and its reason as JSON", async () => {
    await writeProfile([entry("pack", "project.acme")]);

    const result = await cli("why", "mcp:fixture", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      chain: [
        {
          kind: "pack",
          name: "project.acme",
          reason: `pack:${CATALOG_NAME}/project.acme`,
        },
        { kind: "skill", name: PROJECT_SKILL, reason: "required-by:pack:project.acme" },
        { kind: "mcp", name: "fixture", reason: `required-by:skill:${PROJECT_SKILL}` },
      ],
      kind: "mcp",
      name: "fixture",
      reason: `required-by:skill:${PROJECT_SKILL}`,
    });
  });

  it("exits 3 for a skill a catalog provides but nothing selects, naming the entry that would", async () => {
    await writeProfile([entry("pack", "core")]);

    const result = await cli("why", `skill:${PROJECT_SKILL}`);

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`skill "${PROJECT_SKILL}" is not in the bundle`);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" provides it`);
    expect(result.stderr).toContain(
      `select it with \`- skill: "${CATALOG_NAME}/${PROJECT_SKILL}"\``,
    );
  });

  it("names an entry for an unselected server too, which the old `skills` list could not", async () => {
    await writeProfile([entry("pack", "core")]);

    const result = await cli("why", "mcp:fixture");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('MCP server "fixture" is not in the bundle');
    // The fixture's server carries no tag, so there is no tag line to print — and the name entry is
    // the whole of the advice.
    expect(result.stderr).not.toContain("it declares tags");
    expect(result.stderr).toContain(`select it with \`- mcp: "${CATALOG_NAME}/fixture"\``);
  });

  it("exits 3 for a name nothing provides, naming the namespace and where to look", async () => {
    const result = await cli("why", "skill:absent-skill");

    // The namespace is named rather than hedged over all three: the subject said which it meant.
    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('unknown skill "absent-skill"');
    // The next step carries the name that was typed, so a misremembered one is one paste away.
    expect(result.stderr).toContain(
      'run `ambit search --capability skill "*absent-skill*"` to see what is available',
    );
  });

  it("exits 3 for a reference nothing provides, without falling back to another namespace", async () => {
    await writeProfile([entry("pack", "core")]);

    // `company-context` is a skill this catalog does have. A reference is taken at its word, so
    // naming the wrong namespace is a miss rather than a lookup that wanders into the right one.
    const result = await cli("why", `mcp:${CORE_SKILL}`);

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`unknown MCP server "${CORE_SKILL}"`);
  });

  it("refuses a subject whose kind is not a namespace, rather than reading it as a name", async () => {
    await writeProfile([entry("pack", "core")]);

    const result = await cli("why", "server:fixture");

    // `server:` is no kind, so this is a bare name — and the refusal explains the grammar rather
    // than complaining about a namespace nobody claimed to be naming.
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("`why server:fixture` does not say what to explain");
    expect(result.stderr).toContain("`skill:server:fixture`");
  });
});

/**
 * Spec §4.6: an entry that matches nothing is exit 3, not a silent miss. The line assertions are
 * exact rather than loose, since the whole point of the message is that it sends a reader to the
 * offending line of their own config.
 *
 * This is the only direction that still fails: the same typo made on an item's `tags` is simply a
 * new tag, and nothing anywhere can tell.
 */
describe("entries that match nothing", () => {
  it("exits 3, naming the entry, its line, and what it looked in", async () => {
    await writeProfile([entry("pack", "core"), entry("pack", "function.enginering")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `\`requires\` entry "pack:${CATALOG_NAME}/function.enginering" matches nothing (ambit.yml line ${FIRST_ENTRY_LINE + 1})`,
    );
    expect(result.stderr).toContain(
      `no pack in catalog "${CATALOG_NAME}" has a name matching "function.enginering"`,
    );
    expect(result.stderr).toContain("correct the pattern, add the item to a catalog");
  });

  it("refuses a wildcard that reaches nothing, exactly as it refuses a misspelled name", async () => {
    // The point of one grammar: a stale glob and a typo'd exact name are the same mistake, and the
    // silence a glob used to buy is what this rule removes.
    await writeProfile([entry("skill", "absent.*")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`\`requires\` entry "skill:${CATALOG_NAME}/absent.*"`);
  });

  it("says the qualifier names no catalog rather than blaming the pattern", async () => {
    // A qualifier is an alias, not a pattern, so `*` in that half asks for a catalog literally
    // named `*` — and a message about what that catalog holds would answer the wrong question.
    await writeProfile([entry("skill", "*/core")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('no catalog in `catalogs:` is named "*"');
    expect(result.stderr).toContain("`*` is matched literally there");
    expect(result.stderr).toContain(`configured catalogs: ${CATALOG_NAME}`);
  });

  it("names a misspelled alias without the wildcard aside", async () => {
    await writeProfile([entry("pack", "compny/core")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('no catalog in `catalogs:` is named "compny"');
    expect(result.stderr).not.toContain("matched literally");
    expect(result.stderr).toContain("correct the qualifier, or add the catalog to `catalogs:`");
  });

  it("refuses an entry whose namespace holds no match, however live the name is elsewhere", async () => {
    // `core` is a pack, and there is no *skill* of that name; an entry naming the wrong namespace
    // is a mistake even though the name itself is live one namespace over.
    await writeProfile([entry("skill", "core")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `no skill in catalog "${CATALOG_NAME}" has a name matching "core"`,
    );
  });

  it("reports the same offender however the config orders the list", async () => {
    await writeProfile([entry("pack", "zeta.unknown"), entry("pack", "alpha.unknown")]);
    const first = await cli("resolve");

    await writeProfile([entry("pack", "alpha.unknown"), entry("pack", "zeta.unknown")]);
    const second = await cli("resolve");

    expect(first.stderr).toContain(`"pack:${CATALOG_NAME}/alpha.unknown" matches nothing`);
    expect(second.stderr).toContain(`"pack:${CATALOG_NAME}/alpha.unknown" matches nothing`);
  });

  it("selects nothing before failing, so install cannot half-run", async () => {
    await expect(bundle([entry("pack", "core"), entry("pack", "not.a.tag")])).rejects.toMatchObject(
      {
        code: ExitCode.Resolution,
      },
    );
  });
});

describe("ambit resolve", () => {
  it("lists the bundle as text", async () => {
    await writeProfile([
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        // The catalog column is padded out to the widest name, so it lines up down the section.
        "packs (3)",
        `  ${"core".padEnd(FRONTEND_PACK.length)}  ${CATALOG_NAME}`,
        `  ${"function.engineering".padEnd(FRONTEND_PACK.length)}  ${CATALOG_NAME}`,
        `  ${FRONTEND_PACK}  ${CATALOG_NAME}`,
        "",
        "skills (3)",
        `  ${ENGINEERING_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}`,
        `  ${CORE_SKILL}  ${CATALOG_NAME}`,
        `  ${FRONTEND_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}`,
        "",
        "mcps (1)",
        `  linter  ${CATALOG_NAME}`,
        "",
        "hooks (2)",
        `  ${ENGINEERING_HOOK}  ${CATALOG_NAME}  PreToolUse`,
        `  ${CORE_HOOK}  ${CATALOG_NAME}  SessionStart`,
        "",
        "expects (2)",
        "  env  ACME_FIGMA_TOKEN",
        "  env  LINTER_API_KEY",
      ].join("\n"),
    );
  });

  it("says so for an empty bundle rather than printing nothing", async () => {
    await writeProfile([]);

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "packs (0)",
        "  (none)",
        "",
        "skills (0)",
        "  (none)",
        "",
        "mcps (0)",
        "  (none)",
        "",
        "hooks (0)",
        "  (none)",
        "",
        "expects (0)",
        "  (none)",
      ].join("\n"),
    );
  });

  it("emits byte-identical JSON on a second run", async () => {
    await writeProfile([
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
    ]);

    const first = await cli("resolve", "--json");
    const second = await cli("resolve", "--json");

    expect(second.stdout).toBe(first.stdout);
  });

  it("carries no machine-specific paths into JSON output", async () => {
    const result = await cli("resolve", "--json");

    expect(result.stdout).not.toContain(root);
  });

  it("emits byte-identical JSON on a second run under `--explain` too", async () => {
    await writeProfile([
      entry("pack", "core"),
      entry("pack", "function.engineering"),
      entry("pack", "function.engineering.*"),
      entry("pack", "project.acme"),
    ]);

    const first = await cli("resolve", "--explain", "--json");
    const second = await cli("resolve", "--explain", "--json");

    expect(second.stdout).toBe(first.stdout);
  });

  it("exits 2 when the project has no config", async () => {
    await rm(path.join(projectDir, "ambit.yml"));

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("no ambit config");
  });

  it("exits 2 on a malformed catalog", async () => {
    await writeFile(path.join(catalogDir, "mcps", "broken.yml"), "name: broken\n", "utf8");

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('missing required key "transport"');
  });
});

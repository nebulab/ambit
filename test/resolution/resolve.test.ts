/**
 * Resolution by pattern, and the `ambit resolve` output built on it.
 *
 * The rule under test is that one grammar does all the selecting: an entry names the field it
 * matches, the glob it matches with, and the namespaces to match against, and an exact name is a
 * glob with no wildcard. So the cases here are about what an entry reaches — and, just as much,
 * about what it does not: `core.*` excluding `core`, a qualifier confining an entry to one catalog,
 * and a capability list keeping a `[skills]` entry away from a hook carrying the same tag.
 *
 * The `resolve --json` shape is pinned by golden files under `test/golden/resolve/`, one per
 * profile, so a change in what a `requires` list selects shows up as a reviewable diff rather than
 * a rewritten assertion. Regenerate them with `UPDATE_GOLDEN=1 npm test` and read the diff.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

/** The fixture's two scope-selected hooks, in the sections they appear in — both names 13 wide. */
const CORE_HOOK = "session-notes";
const ENGINEERING_HOOK = "guard-secrets";

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "golden",
  "resolve",
);

/** Every namespace, which is what a held scope used to reach in one stroke. */
const ALL: readonly string[] = ["skills", "mcps", "hooks"];

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
 * One `requires` entry as a single config line, in flow style.
 *
 * Flow rather than block, so an entry occupies one line and the position a refusal names is
 * countable from the profile's four-line preamble. The address is qualified with the fixture
 * catalog unless it already carries a qualifier of its own.
 */
function entry(
  field: "name" | "tag",
  address: string,
  capabilities: readonly string[] = ALL,
): string {
  const qualified = address.includes("/") ? address : `${CATALOG_NAME}/${address}`;
  return `  - { ${field}: "${qualified}", capabilities: [${capabilities.join(", ")}] }`;
}

/**
 * The profile matrix: one `requires` list each, with a golden file.
 *
 * The two `function.engineering` profiles hold two entries where a held scope held one, and that is
 * the grammar being honest rather than a wart: `function.engineering` and `function.engineering.*`
 * are different patterns, and the second is what reaches the nested `frontend` label the subtree
 * rule used to reach silently.
 */
const PROFILES: readonly { readonly name: string; readonly requires: readonly string[] }[] = [
  { name: "empty", requires: [] },
  { name: "core", requires: [entry("tag", "core")] },
  {
    name: "engineering",
    requires: [entry("tag", "function.engineering"), entry("tag", "function.engineering.*")],
  },
  {
    name: "core-and-engineering",
    requires: [
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ],
  },
  { name: "frontend", requires: [entry("tag", "function.engineering.frontend")] },
  { name: "project", requires: [entry("tag", "project.acme")] },
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
 * The annotation lines as §3.2 nests them: under a top-level `ambit:`, indented with it.
 *
 * Callers still pass `tags:` and `requires:` as they are tabulated, so a fixture reads like the
 * format's own documentation and only one place knows where the block goes.
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
  const target = path.join(catalogDir, "hooks", name.replaceAll(".", "/"), "HOOK.yml");
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
    throw new Error(`missing golden file ${file}; regenerate with UPDATE_GOLDEN=1 npm test`);
  }
  expect(actual, `golden mismatch for ${name}; UPDATE_GOLDEN=1 npm test to accept`).toBe(
    expected.replace(/\n$/, ""),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-resolve-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile([entry("tag", "core")]);
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
    await writeSkill("prefix", ["tags: [glob]"]);
    await writeSkill("prefix.child", ["tags: [glob]"]);
    await writeSkill("prefix.child.deeper", ["tags: [glob]"]);
    await writeSkill("prefix-sibling", ["tags: [glob]"]);
  });

  it("reaches every depth beneath a prefix, since `*` spans the dot", async () => {
    const selected = await bundle([entry("name", "prefix.*", ["skills"])]);

    expect(selected.skills.map((skill) => skill.name)).toEqual([
      "prefix.child",
      "prefix.child.deeper",
    ]);
  });

  it("excludes the item named exactly the prefix, which takes a second entry", async () => {
    const one = await bundle([entry("name", "prefix.*", ["skills"])]);
    expect(one.skills.map((skill) => skill.name)).not.toContain("prefix");

    const two = await bundle([
      entry("name", "prefix", ["skills"]),
      entry("name", "prefix.*", ["skills"]),
    ]);
    expect(two.skills.map((skill) => skill.name)).toContain("prefix");
  });

  it("does not reach a sibling whose name merely starts with the pattern's", async () => {
    // `prefix-sibling` reads as a hierarchy to a bare prefix check and to nobody else; the dot in
    // `prefix.*` is a literal character the sibling does not have.
    const selected = await bundle([entry("name", "prefix.*", ["skills"])]);

    expect(selected.skills.map((skill) => skill.name)).not.toContain("prefix-sibling");
  });

  it("takes the whole catalog for a bare `*`", async () => {
    const everything = await bundle([entry("name", "*")]);

    expect(everything.skills).toHaveLength(8);
    expect(everything.mcps.map((mcp) => mcp.name)).toEqual(["fixture", "scoped"]);
  });

  it("matches an exact name and nothing else when the pattern holds no wildcard", async () => {
    const selected = await bundle([entry("name", "prefix.child", ["skills"])]);

    expect(selected.skills.map((skill) => skill.name)).toEqual(["prefix.child"]);
  });
});

/**
 * The two halves of an entry that are declared rather than guessed, and what each of them refuses to
 * reach.
 */
describe("what an entry does not reach", () => {
  it("matches a tag against `tag:` alone, never against a name", async () => {
    await writeSkill("tag-only", ["tags: [distinct-label]"]);

    await expect(bundle([entry("name", "distinct-label", ["skills"])])).rejects.toMatchObject({
      code: ExitCode.Resolution,
    });
    expect(
      (await bundle([entry("tag", "distinct-label", ["skills"])])).skills.map(
        (skill) => skill.name,
      ),
    ).toEqual(["tag-only"]);
  });

  it("leaves a hook alone when the entry names only `skills`, however the tag matches", async () => {
    // The reason `capabilities` is not defaulted: the fixture's `core` tag is on a skill *and* a
    // hook, and an entry written thinking about skills must not install the hook.
    const skillsOnly = await bundle([entry("tag", "core", ["skills"])]);

    expect(skillsOnly.skills.map((skill) => skill.name)).toEqual([CORE_SKILL]);
    expect(skillsOnly.hooks).toEqual([]);
  });

  it("confines an entry to the catalog it qualified", async () => {
    await writeSkillIn("personal", "personal-only", ["tags: [core]"]);
    await writeTwoCatalogProfile("personal", [entry("tag", `${CATALOG_NAME}/core`, ["skills"])]);

    const config = await loadProjectConfig(projectDir);
    const resolved = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, context())));

    expect(resolved.skills.map((skill) => skill.name)).toEqual([CORE_SKILL]);
  });
});

describe("selection by pattern", () => {
  it("selects only what an entry reaches — nothing is implicit", async () => {
    const engineering = await bundle([
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    expect(engineering.skills.map((skill) => skill.name)).toEqual([
      ENGINEERING_SKILL,
      FRONTEND_SKILL,
    ]);
    expect(engineering.skills.map((skill) => skill.name)).not.toContain(CORE_SKILL);
  });

  it("selects the union of every entry in the list", async () => {
    const both = await bundle([
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    expect(both.skills.map((skill) => skill.name)).toEqual([
      ENGINEERING_SKILL,
      CORE_SKILL,
      FRONTEND_SKILL,
    ]);
  });

  it("does not reach a label no entry names", async () => {
    for (const requires of [
      [entry("tag", "function.engineering"), entry("tag", "function.engineering.*")],
      [
        entry("tag", "core"),
        entry("tag", "function.engineering"),
        entry("tag", "function.engineering.*"),
      ],
    ]) {
      const resolved = await bundle(requires);
      expect(resolved.skills.map((skill) => skill.name)).not.toContain(PROJECT_SKILL);
    }
  });

  it("reaches only the one label a narrow entry names", async () => {
    const frontend = await bundle([entry("tag", "function.engineering.frontend")]);

    expect(frontend.skills.map((skill) => skill.name)).toEqual([FRONTEND_SKILL]);
    expect(frontend.mcps).toEqual([]);
  });

  it("yields an empty bundle for an empty `requires` list", async () => {
    const empty = await bundle([]);

    expect(empty).toEqual({
      skills: [],
      mcps: [],
      hooks: [],
      expects: { env: [] },
      reasons: { skills: new Map(), mcps: new Map(), hooks: new Map() },
    });
  });

  it("selects an MCP server by its own tags", async () => {
    expect(
      (
        await bundle([entry("tag", "function.engineering"), entry("tag", "function.engineering.*")])
      ).mcps.map((mcp) => mcp.name),
    ).toEqual(["scoped"]);
    expect((await bundle([entry("tag", "core")])).mcps).toEqual([]);
  });

  it("unions `expects` across everything the list selected", async () => {
    // ACME_FIGMA_TOKEN comes from the nested frontend skill, SCOPED_API_KEY from the server the
    // broader entry selects, so one list must produce both.
    const wide = await bundle([
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    expect(wide.expects.env).toEqual(["ACME_FIGMA_TOKEN", "SCOPED_API_KEY"]);
  });

  it("selects an item once when two entries both reach it", async () => {
    // The exact name and the tag both reach `company-context`, and it is one item either way — a
    // bundle holds one entry per name, and which entry is reported is the reason's business.
    const twice = await bundle([
      entry("tag", "core", ["skills"]),
      entry("name", CORE_SKILL, ["skills"]),
    ]);

    expect(twice.skills.map((skill) => skill.name)).toEqual([CORE_SKILL]);
  });
});

/**
 * Spec §4.9: the closure is what makes a skill's dependencies travel with it. The fixture's
 * project skill is the case the spec cares about — it requires a skill and a server that no held
 * scope of its own would ever select — and the graph shapes around it (chain, diamond, cycle) are
 * written into the catalog per test.
 */
describe("the requires closure", () => {
  it("pulls in a required skill and MCP server that match by no held scope", async () => {
    const project = await bundle([entry("tag", "project.acme")]);

    expect(project.skills.map((skill) => skill.name)).toEqual([PROJECT_SKILL, CORE_SKILL]);
    expect(project.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
  });

  it("unions `expects` over what the closure added, not only what scope selected", async () => {
    // FIXTURE_API_KEY belongs to the server only `requires` can reach, so a bundle that lists the
    // server without its credential would send `doctor` looking at the wrong thing.
    expect((await bundle([entry("tag", "project.acme")])).expects.env).toEqual(["FIXTURE_API_KEY"]);
  });

  it("follows a requirement of a requirement, to fixpoint", async () => {
    await writeSkill("chain-a", ["tags: [core]", "requires: [{skill: chain-b}]"]);
    await writeSkill("chain-b", ["requires: [{skill: chain-c}]"]);
    await writeSkill("chain-c", []);

    expect((await bundle([entry("tag", "core")])).skills.map((skill) => skill.name)).toEqual([
      "chain-a",
      "chain-b",
      "chain-c",
      CORE_SKILL,
    ]);
  });

  it("treats a requirement two skills share as a diamond, not a cycle", async () => {
    await writeSkill("diamond-left", ["tags: [core]", "requires: [{skill: diamond-shared}]"]);
    await writeSkill("diamond-right", ["tags: [core]", "requires: [{skill: diamond-shared}]"]);
    await writeSkill("diamond-shared", []);

    const resolved = await bundle([entry("tag", "core")]);

    expect(
      resolved.skills.map((skill) => skill.name).filter((name) => name.startsWith("diamond-")),
    ).toEqual(["diamond-left", "diamond-right", "diamond-shared"]);
  });

  it("selects a required skill exactly once, however many skills require it", async () => {
    await writeSkill("twice-left", ["tags: [core]", "requires: [{mcp: fixture}]"]);
    await writeSkill("twice-right", ["tags: [core]", "requires: [{mcp: fixture}]"]);

    expect((await bundle([entry("tag", "core")])).mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
  });

  it("pulls in every catalog's copy of a required name, and refuses the collision", async () => {
    // A `requires` entry names a name and says nothing about which catalog holds it. With no
    // precedence left there is nothing to choose with, so both copies join the selection and the
    // project hears about it — taking the first is the silent drop this branch deleted.
    await writeSkill("needs-shared", ["tags: [core]", "requires: [{skill: shared-dep}]"]);
    await writeSkill("shared-dep", []);
    await writeSkillIn("personal", "shared-dep", []);
    await writeTwoCatalogProfile("personal", [entry("tag", "core")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('skill "shared-dep" is selected from more than one catalog');
    expect(result.stderr).toContain(`provided by: ${CATALOG_NAME}, personal`);
  });

  it("follows a required name into a second catalog when only one copy exists", async () => {
    // The other half of the case above: reaching across catalogs is what a `requires` edge does
    // today, and one copy of the name is one selection — no collision, no refusal.
    await writeSkill("needs-remote", ["tags: [core]", "requires: [{skill: remote-dep}]"]);
    await writeSkillIn("personal", "remote-dep", []);
    await writeTwoCatalogProfile("personal", [entry("tag", "core")]);

    const config = await loadProjectConfig(projectDir);
    const resolved = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, context())));

    expect(resolved.skills.find((skill) => skill.name === "remote-dep")?.catalog).toBe("personal");
  });

  it("leaves a broken skill nobody selected alone, so one bad entry blocks no one", async () => {
    // Spec §4's validation split: `resolve` hard-validates the selected closure only. This skill
    // declares no scope, so nothing reaches it and its dangling requirement is `validate`'s
    // business (A23), not this bundle's.
    await writeSkill("broken-unselected", ["requires: [{skill: absent-skill}]"]);

    const result = await cli("resolve");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });
});

describe("unresolvable requirements", () => {
  it("exits 3 naming the requirer, the missing skill, and the file the edge is in", async () => {
    await writeSkill("broken-dangling", ["tags: [core]", "requires: [{skill: absent-skill}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      'unresolvable requirement "skill:absent-skill" (skills/broken-dangling/SKILL.md)',
    );
    expect(result.stderr).toContain('broken-dangling requires a skill named "absent-skill"');
  });

  it("names the MCP entity, and the namespace the entry declared, for an `mcp:` target", async () => {
    await writeSkill("broken-dangling-mcp", ["tags: [core]", "requires: [{mcp: absent}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('unresolvable requirement "mcp:absent"');
    expect(result.stderr).toContain('requires an MCP entity named "absent"');
    expect(result.stderr).toContain("mcps/");
  });

  it("names the hook, and the namespace the entry declared, for a `hook:` target", async () => {
    await writeSkill("broken-dangling-hook", ["tags: [core]", "requires: [{hook: absent}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      'unresolvable requirement "hook:absent" (skills/broken-dangling-hook/SKILL.md)',
    );
    expect(result.stderr).toContain('requires a hook named "absent"');
    expect(result.stderr).toContain("add it under hooks/ in a catalog");
  });

  it("does not accept a skill of that name for a requirement in another namespace", async () => {
    // A `hook:` entry names the hook namespace, and a skill called `absent` is not in it — or the
    // key would be decoration.
    await writeSkill("absent", ["tags: [core]"]);
    await writeSkill("broken-wrong-namespace", ["tags: [core]", "requires: [{hook: absent}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('unresolvable requirement "hook:absent"');
  });

  it("refuses a `requires` entry written as a bare string, naming all three spellings", async () => {
    // The pre-namespace shape. Refused at parse time rather than read as a skill, because
    // `mcp.absent` was always two claims at once and picking one is what this format removed.
    await writeSkill("legacy", ["tags: [core]", "requires: [mcp.absent]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('`requires` entry "mcp.absent" names no namespace');
    expect(result.stderr).toContain("`- mcp: absent`");
    expect(result.stderr).toContain("`- skill: mcp.absent`");
  });

  it("refuses an entry naming two namespaces at once", async () => {
    await writeSkill("greedy", ["tags: [core]", "requires: [{mcp: a, hook: b}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("a `requires` entry names 2 namespaces: hook, mcp");
  });

  it("refuses an entry whose one key is not a namespace", async () => {
    await writeSkill("typo", ["tags: [core]", "requires: [{skil: a}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('unknown namespace "skil" in a `requires` entry');
  });
});

/**
 * `expects` borrows `requires`' spelling, so the shape errors are the same errors in the other
 * vocabulary — which is the point of sharing the grammar, and what these cases pin.
 *
 * The one thing deliberately *not* here is a resolution failure: an expectation names nothing a
 * catalog could provide, so there is no unresolvable entry to write and no cycle to close. That is
 * `doctor`'s question, and the split is exactly this: everything below fails at parse time, and a
 * variable the machine does not have fails nowhere until the machine is asked.
 */
describe("`expects` entries", () => {
  it("refuses an entry written as a bare string, naming the spelling it wanted", async () => {
    await writeSkill("legacy", ["tags: [core]", "expects: [CLOSE_API_KEY]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('`expects` entry "CLOSE_API_KEY" names no precondition');
    expect(result.stderr).toContain("`- env: CLOSE_API_KEY`");
  });

  it("refuses an entry naming two preconditions at once", async () => {
    await writeSkill("greedy", ["tags: [core]", "expects: [{env: A, bin: b}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("an `expects` entry names 2 preconditions: bin, env");
  });

  it("refuses a kind that is not one this version knows", async () => {
    // `bin:` is the obvious second kind and is deliberately not one yet, so this doubles as the
    // claim that a catalog written against a later ambit fails loudly here rather than silently
    // declaring nothing.
    await writeSkill("ahead", ["tags: [core]", "expects: [{bin: docker}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('unknown precondition "bin" in an `expects` entry');
  });

  it("takes an `expects` on all three kinds, which is what `requires` cannot do", async () => {
    await writeSkill("reader", ["tags: [core]", "expects: [{env: SKILL_VAR}]"]);
    await writeMcp("server", ["tags: [core]", "expects: [{env: MCP_VAR}]"]);
    await writeHook("watcher", [
      "tags: [core]",
      "event: Stop",
      "type: command",
      "command: npx watch",
      "expects: [{env: HOOK_VAR}]",
    ]);

    expect((await bundle([entry("tag", "core")])).expects.env).toEqual(
      expect.arrayContaining(["HOOK_VAR", "MCP_VAR", "SKILL_VAR"]),
    );
  });
});

describe("requirement cycles", () => {
  it("exits 3 printing the whole path, not just the fact of a cycle", async () => {
    await writeSkill("cycle-a", ["tags: [core]", "requires: [{skill: cycle-b}]"]);
    await writeSkill("cycle-b", ["requires: [{skill: cycle-c}]"]);
    await writeSkill("cycle-c", ["requires: [{skill: cycle-a}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("requirement cycle");
    expect(result.stderr).toContain("cycle-a → cycle-b → cycle-c → cycle-a");
    expect(result.stderr).toContain("skills/cycle-a/SKILL.md");
    expect(result.stderr).toContain("break the cycle by removing one `requires` edge");
  });

  it("reports a skill that requires itself as the one-step cycle it is", async () => {
    await writeSkill("cycle-self", ["tags: [core]", "requires: [{skill: cycle-self}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("cycle-self → cycle-self");
  });

  it("reports a cycle reached only through a requirement, not just one held directly", async () => {
    await writeSkill("cycle-entry", ["tags: [core]", "requires: [{skill: cycle-b}]"]);
    await writeSkill("cycle-b", ["requires: [{skill: cycle-c}]"]);
    await writeSkill("cycle-c", ["requires: [{skill: cycle-b}]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("cycle-b → cycle-c → cycle-b");
  });

  it("names the same cycle whatever order a `requires` list is written in", async () => {
    await writeSkill("cycle-a", ["tags: [core]", "requires: [{skill: cycle-b}, {skill: cycle-c}]"]);
    await writeSkill("cycle-b", ["requires: [{skill: cycle-a}]"]);
    await writeSkill("cycle-c", ["requires: [{skill: cycle-a}]"]);
    const first = await cli("resolve");

    await writeSkill("cycle-a", ["tags: [core]", "requires: [{skill: cycle-c}, {skill: cycle-b}]"]);
    const second = await cli("resolve");

    expect(first.stderr).toContain("cycle-a → cycle-b → cycle-a");
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
    const named = await bundle([entry("name", ENGINEERING_SKILL, ["skills"])]);

    expect(named.skills.map((skill) => skill.name)).toEqual([ENGINEERING_SKILL]);
    // No tag entry was written, so the skill's own `function.engineering` tag did none of the work.
    expect(named.reasons.skills.get(ENGINEERING_SKILL)).toMatchObject({
      entry: { field: "name" },
    });
  });

  it("closes a named skill over its own `requires`", async () => {
    const named = await bundle([entry("name", PROJECT_SKILL, ["skills"])]);

    expect(named.skills.map((skill) => skill.name)).toEqual([PROJECT_SKILL, CORE_SKILL]);
    expect(named.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
    expect(named.expects.env).toEqual(["FIXTURE_API_KEY"]);
  });

  it("reaches an MCP server and a hook by name, which no explicit list ever could", async () => {
    // The payoff of one grammar: `skills:` could only ever name a skill, so a server or a hook a
    // catalog shipped was reachable by tag or by a `requires` edge and by nothing else.
    const named = await bundle([
      entry("name", "fixture", ["mcps"]),
      entry("name", "acme-standup", ["hooks"]),
    ]);

    expect(named.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
    expect(named.hooks.map((hook) => hook.name)).toEqual(["acme-standup"]);
    expect(named.skills).toEqual([]);
  });

  it("exits 3 for a name no catalog provides, naming the entry and its line", async () => {
    await writeProfile([entry("name", "absent-skill", ["skills"])]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `\`requires\` entry "name:${CATALOG_NAME}/absent-skill" matches nothing (ambit.yml line ${FIRST_ENTRY_LINE})`,
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
      `\`core\` becomes \`- { tag: "${CATALOG_NAME}/core", capabilities: [skills, mcps, hooks] }\``,
    );
  });

  it("exits 2 for a top-level `skills`, naming the entry each name becomes", async () => {
    await writeProfile([], ["skills:", `  - ${CORE_SKILL}`]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("top-level `skills` is gone");
    expect(result.stderr).toContain(
      `\`${CORE_SKILL}\` becomes \`- { name: "${CATALOG_NAME}/${CORE_SKILL}", capabilities: [skills] }\``,
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
    expect(result.stderr).toContain("move each entry to `hooks/<name>/HOOK.yml`");
  });
});

/**
 * A hook a *catalog* provides is selected exactly as a server is: by an entry whose `capabilities`
 * name `hooks` and whose pattern reaches it, and declaring no tag leaves it reachable by name or by a
 * `requires` edge alone.
 *
 * That is the whole difference distribution makes to resolution — the same two routes, now with a
 * third namespace coming down them — so what is asserted here is that the hook namespace goes through
 * the merged catalog rather than being read off the config, which is where it started.
 */
describe("catalog hooks", () => {
  const HOOK_NAME = "block-rm";

  beforeEach(async () => {
    await writeHook(HOOK_NAME, [
      "tags: [function.engineering.frontend]",
      "event: PreToolUse",
      "matcher: Bash",
      "type: command",
      "command: npx block-rm",
    ]);
  });

  it("selects a catalog hook by a tag entry, naming the entry that reached it", async () => {
    const frontend = await bundle([entry("tag", "function.engineering.frontend")]);

    expect(frontend.hooks.map((hook) => hook.name)).toEqual([HOOK_NAME]);
    expect(frontend.hooks[0]).toMatchObject({ catalog: CATALOG_NAME, type: "command" });
    expect(frontend.reasons.hooks.get(HOOK_NAME)).toEqual({
      kind: "selected",
      entry: {
        field: "tag",
        pattern: "function.engineering.frontend",
        catalog: CATALOG_NAME,
        capabilities: ALL,
      },
    });
  });

  it("reaches a hook through a wildcard entry, and not through the exact label above it", async () => {
    const parent = await bundle([
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);
    expect(parent.reasons.hooks.get(HOOK_NAME)).toMatchObject({
      entry: { pattern: "function.engineering.*" },
    });

    const elsewhere = await bundle([entry("tag", "core")]);
    expect(writtenHooks(elsewhere)).toEqual([]);
  });

  it("leaves a hook declaring no tags out of every tag-selected bundle", async () => {
    await writeHook("unscoped", ["event: Stop", "type: command", "command: npx notify"]);

    const everything = await bundle([
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
      entry("tag", "project.acme"),
    ]);
    expect(writtenHooks(everything)).toEqual([HOOK_NAME]);
  });

  it("names the catalog it came from in `resolve`", async () => {
    await writeProfile([
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    // Beside the fixture's own hook on the same tag, which is what the section's padding widens to.
    expect((await cli("resolve")).stdout).toContain(
      `hooks (2)\n  ${HOOK_NAME.padEnd(ENGINEERING_HOOK.length)}  ${CATALOG_NAME}  PreToolUse\n  ${ENGINEERING_HOOK}  ${CATALOG_NAME}  PreToolUse`,
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
    await writeSkill("risky", ["tags: [core]", `requires: [{hook: ${HOOK_NAME}}]`]);

    const required = await bundle([entry("tag", "core")]);

    expect(writtenHooks(required)).toEqual([HOOK_NAME]);
    expect(required.reasons.hooks.get(HOOK_NAME)).toEqual({
      kind: "required-by",
      requirer: "risky",
    });
  });

  it("unions a required hook's `expects`, so the closure feeds the credential list too", async () => {
    await writeSkill("risky", ["tags: [core]", `requires: [{hook: ${HOOK_NAME}}]`]);

    expect((await bundle([entry("tag", "core")])).expects.env).toContain("GUARD_TOKEN");
  });

  it("reaches a hook down a chain, not only from a skill an entry selected", async () => {
    await writeSkill("chain-leaf", [`requires: [{hook: ${HOOK_NAME}}]`]);
    await writeSkill("chain-root", ["tags: [core]", "requires: [{skill: chain-leaf}]"]);

    const required = await bundle([entry("tag", "core")]);

    expect(writtenHooks(required)).toEqual([HOOK_NAME]);
    expect(required.reasons.hooks.get(HOOK_NAME)).toEqual({
      kind: "required-by",
      requirer: "chain-leaf",
    });
  });

  it("leaves the hook out when nothing selected requires it", async () => {
    // The same catalog, the same hook: what differs is that the requiring skill is not selected, so
    // the edge exists and reaches nothing.
    await writeSkill("risky", ["tags: [project.acme]", `requires: [{hook: ${HOOK_NAME}}]`]);

    expect(writtenHooks(await bundle([entry("tag", "core")]))).toEqual([]);
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
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    expect(wide.reasons.skills.get(ENGINEERING_SKILL)).toEqual({
      kind: "selected",
      entry: {
        field: "tag",
        pattern: "function.engineering",
        catalog: CATALOG_NAME,
        capabilities: ALL,
      },
    });
    // Reached by the wildcard entry, so the reason is that entry — the label the author happened to
    // write is not what a reader can go and change.
    expect(wide.reasons.skills.get(FRONTEND_SKILL)).toMatchObject({
      kind: "selected",
      entry: { pattern: "function.engineering.*" },
    });
    expect(wide.reasons.mcps.get("scoped")).toMatchObject({
      kind: "selected",
      entry: { field: "tag", pattern: "function.engineering" },
    });
  });

  it("names the requirer of a skill and a server no entry selected", async () => {
    const project = await bundle([entry("tag", "project.acme")]);

    expect(project.reasons.skills.get(CORE_SKILL)).toEqual({
      kind: "required-by",
      requirer: PROJECT_SKILL,
    });
    expect(project.reasons.mcps.get("fixture")).toEqual({
      kind: "required-by",
      requirer: PROJECT_SKILL,
    });
  });

  it("names the first requirer by name, not the first the closure happened to walk", async () => {
    await writeSkill("twice-left", ["tags: [core]", "requires: [{mcp: fixture}]"]);
    await writeSkill("twice-right", ["tags: [core]", "requires: [{mcp: fixture}]"]);

    expect((await bundle([entry("tag", "core")])).reasons.mcps.get("fixture")).toEqual({
      kind: "required-by",
      requirer: "twice-left",
    });
  });

  it("tie-breaks two entries that both reach an item on sorted order", async () => {
    // Both entries are true, so the tie-break only has to be a function of the entries: sorted on
    // what a reason prints, `name:` sorts before `tag:`.
    const both = await bundle([
      entry("tag", "function.engineering", ["skills"]),
      entry("name", ENGINEERING_SKILL, ["skills"]),
    ]);

    expect(both.reasons.skills.get(ENGINEERING_SKILL)).toMatchObject({
      entry: { field: "name", pattern: ENGINEERING_SKILL },
    });
  });

  it("prefers an entry over a `requires` edge, since the entry ends the chain", async () => {
    // `company-context` is both required by the project skill and named outright; the entry is the
    // shorter true answer, and the one the reader can act on.
    const both = await bundle([
      entry("tag", "project.acme", ["skills"]),
      entry("name", CORE_SKILL, ["skills"]),
    ]);

    expect(both.reasons.skills.get(CORE_SKILL)).toMatchObject({ kind: "selected" });
  });

  it("explains every item it selected, leaving nothing unaccounted for", async () => {
    const wide = await bundle([
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
      entry("tag", "project.acme"),
    ]);

    expect([...wide.reasons.skills.keys()]).toEqual(wide.skills.map((skill) => skill.name));
    expect([...wide.reasons.mcps.keys()]).toEqual(wide.mcps.map((mcp) => mcp.name));
  });
});

describe("ambit resolve --explain", () => {
  it("adds a reason column to every section but `expects`", async () => {
    await writeProfile([
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    const result = await cli("resolve", "--explain");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "skills (3)",
        `  ${ENGINEERING_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}  tag:${CATALOG_NAME}/function.engineering`,
        `  ${CORE_SKILL}  ${CATALOG_NAME}  tag:${CATALOG_NAME}/core`,
        `  ${FRONTEND_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}  tag:${CATALOG_NAME}/function.engineering.*`,
        "",
        "mcps (1)",
        `  scoped  ${CATALOG_NAME}  tag:${CATALOG_NAME}/function.engineering`,
        "",
        "hooks (2)",
        `  ${ENGINEERING_HOOK}  ${CATALOG_NAME}  PreToolUse    tag:${CATALOG_NAME}/function.engineering`,
        `  ${CORE_HOOK}  ${CATALOG_NAME}  SessionStart  tag:${CATALOG_NAME}/core`,
        "",
        "expects (2)",
        "  env  ACME_FIGMA_TOKEN",
        "  env  SCOPED_API_KEY",
      ].join("\n"),
    );
  });

  it("adds a reason to every JSON record, which plain `--json` omits", async () => {
    await writeProfile([entry("tag", "project.acme")]);

    const explained = JSON.parse((await cli("resolve", "--explain", "--json")).stdout) as {
      skills: Record<string, { reason?: string }>;
      mcps: Record<string, { reason?: string }>;
    };

    expect(explained.skills[CORE_SKILL]?.reason).toBe(`required-by:${PROJECT_SKILL}`);
    expect(explained.skills[PROJECT_SKILL]?.reason).toBe(`tag:${CATALOG_NAME}/project.acme`);
    expect(explained.mcps.fixture?.reason).toBe(`required-by:${PROJECT_SKILL}`);

    const plain = JSON.parse((await cli("resolve", "--json")).stdout) as {
      skills: Record<string, { reason?: string }>;
    };
    expect(plain.skills[PROJECT_SKILL]).not.toHaveProperty("reason");
  });
});

/**
 * Spec §6: `ambit why <name>` prints the chain from a held scope to the item. The chain matters more
 * than the reason — `required-by:x` only moves the question up a level — so the assertions are on
 * the whole path, not on the last link.
 */
describe("ambit why", () => {
  it("prints the one-link chain of something a held scope selected outright", async () => {
    await writeProfile([entry("tag", "core")]);

    const result = await cli("why", `skill:${CORE_SKILL}`);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        `skill ${CORE_SKILL}`,
        "",
        "chain (1)",
        `  ${CORE_SKILL}  skill  tag:${CATALOG_NAME}/core`,
      ].join("\n"),
    );
  });

  it("walks back through `requires` to the entry that started it", async () => {
    await writeProfile([entry("tag", "project.acme")]);

    const result = await cli("why", `skill:${CORE_SKILL}`);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        `skill ${CORE_SKILL}`,
        "",
        "chain (2)",
        `  ${PROJECT_SKILL.padEnd(CORE_SKILL.length)}  skill  tag:${CATALOG_NAME}/project.acme`,
        `  ${CORE_SKILL}  skill  required-by:${PROJECT_SKILL}`,
      ].join("\n"),
    );
  });

  it("names the entry as written, wildcard included, when that is what reached the item", async () => {
    // The whole reason a reason carries the entry rather than the matched value: `frontend` is the
    // label the author wrote, and the pattern is what the reader can go and change.
    await writeProfile([
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    const result = await cli("why", `skill:${FRONTEND_SKILL}`);

    expect(result.stdout).toContain(`tag:${CATALOG_NAME}/function.engineering.*`);
  });

  it("finds a server by the `mcp:` reference `requires` uses", async () => {
    await writeProfile([entry("tag", "project.acme")]);

    const result = await cli("why", "mcp:fixture");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("mcp fixture");
    expect(result.stdout).toContain(
      `${"fixture".padEnd(PROJECT_SKILL.length)}  mcp    required-by:${PROJECT_SKILL}`,
    );
  });

  it("refuses a bare name, in the words every list that names an item refuses one", async () => {
    await writeProfile([entry("tag", "core")]);

    const result = await cli("why", CORE_SKILL);

    // Refused rather than looked up, even though this command *could* look it up: one grammar
    // everywhere a name is taken from a person beats a rule that holds only while a name is unique.
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`\`why ${CORE_SKILL}\` does not say what to explain`);
    expect(result.stderr).toContain(`\`skill:${CORE_SKILL}\`, \`mcp:${CORE_SKILL}\``);
  });

  it("names either namespace for a name both hold", async () => {
    await writeMcp(CORE_SKILL, ["tags: [core]"]);
    await writeProfile([entry("tag", "core")]);

    // Two namespaces answering to one name is a legitimate catalog, and neither reading is preferred
    // over the other — both are simply asked for.
    expect((await cli("why", `skill:${CORE_SKILL}`)).stdout).toContain(`skill ${CORE_SKILL}`);
    expect((await cli("why", `mcp:${CORE_SKILL}`)).stdout).toContain(`mcp ${CORE_SKILL}`);
  });

  it("reaches a skill whose own name reads like another namespace's prefix", async () => {
    // The bug this format was changed for: `skills/mcp/sentry/SKILL.md` is the skill `mcp.sentry`,
    // and under a prefix convention no string could name it.
    await writeSkill("mcp.sentry", ["tags: [core]"]);
    await writeProfile([entry("tag", "core")]);

    expect((await cli("why", "skill:mcp.sentry")).stdout).toContain("skill mcp.sentry");
  });

  it("lets a skill named for one namespace and an entity of that name coexist", async () => {
    await writeSkill("mcp.sentry", ["tags: [core]"]);
    await writeMcp("sentry", ["tags: [core]"]);
    await writeProfile([entry("tag", "core")]);

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
    await writeSkill("risky", ["tags: [core]", "requires: [{hook: guard}]"]);
    await writeProfile([entry("tag", "core")]);

    const result = await cli("why", "hook:guard");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "hook guard",
        "",
        "chain (2)",
        `  risky  skill  tag:${CATALOG_NAME}/core`,
        "  guard  hook   required-by:risky",
      ].join("\n"),
    );
  });

  it("insists on the hook for a `hook:` reference a skill also answers to", async () => {
    await writeHook(CORE_SKILL, [
      "tags: [core]",
      "event: Stop",
      "type: command",
      "command: npx notify",
    ]);
    await writeProfile([entry("tag", "core")]);

    expect((await cli("why", `skill:${CORE_SKILL}`)).stdout).toContain(`skill ${CORE_SKILL}`);
    expect((await cli("why", `hook:${CORE_SKILL}`)).stdout).toContain(`hook ${CORE_SKILL}`);
  });

  it("names the entry that would select an unselected hook, tags and all", async () => {
    await writeHook("guard", [
      "tags: [project.acme]",
      "event: PreToolUse",
      "matcher: Bash",
      "type: command",
      "command: npx guard",
    ]);
    await writeProfile([entry("tag", "core")]);

    const result = await cli("why", "hook:guard");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('hook "guard" is not in the bundle');
    expect(result.stderr).toContain("it declares tags: project.acme");
    // By exact name and qualified, which is the one entry that selects this copy and nothing else.
    expect(result.stderr).toContain(
      `select it with \`- { name: "${CATALOG_NAME}/guard", capabilities: [hooks] }\``,
    );
  });

  it("reports a name entry as the whole chain, since nothing precedes it", async () => {
    await writeProfile([entry("name", ENGINEERING_SKILL, ["skills"])]);

    const result = await cli("why", `skill:${ENGINEERING_SKILL}`);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(
      `${ENGINEERING_SKILL}  skill  name:${CATALOG_NAME}/${ENGINEERING_SKILL}`,
    );
  });

  it("emits the chain, the item, and its reason as JSON", async () => {
    await writeProfile([entry("tag", "project.acme")]);

    const result = await cli("why", "mcp:fixture", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      chain: [
        {
          kind: "skill",
          name: PROJECT_SKILL,
          reason: `tag:${CATALOG_NAME}/project.acme`,
        },
        { kind: "mcp", name: "fixture", reason: `required-by:${PROJECT_SKILL}` },
      ],
      kind: "mcp",
      name: "fixture",
      reason: `required-by:${PROJECT_SKILL}`,
    });
  });

  it("exits 3 for a skill a catalog provides but nothing selects, naming the entry that would", async () => {
    await writeProfile([entry("tag", "core")]);

    const result = await cli("why", `skill:${PROJECT_SKILL}`);

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`skill "${PROJECT_SKILL}" is not in the bundle`);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" provides it`);
    expect(result.stderr).toContain("it declares tags: project.acme");
    expect(result.stderr).toContain(
      `select it with \`- { name: "${CATALOG_NAME}/${PROJECT_SKILL}", capabilities: [skills] }\``,
    );
  });

  it("names an entry for an unselected server too, which the old `skills` list could not", async () => {
    await writeProfile([entry("tag", "core")]);

    const result = await cli("why", "mcp:fixture");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('MCP server "fixture" is not in the bundle');
    // The fixture's server carries no tag, so there is no tag line to print — and the name entry is
    // the whole of the advice.
    expect(result.stderr).not.toContain("it declares tags");
    expect(result.stderr).toContain(
      `select it with \`- { name: "${CATALOG_NAME}/fixture", capabilities: [mcps] }\``,
    );
  });

  it("exits 3 for a name nothing provides, naming the namespace and where to look", async () => {
    const result = await cli("why", "skill:absent-skill");

    // The namespace is named rather than hedged over all three: the subject said which it meant.
    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('unknown skill "absent-skill"');
    expect(result.stderr).toContain("run `ambit dump-catalog` to see what is available");
  });

  it("exits 3 for a reference nothing provides, without falling back to another namespace", async () => {
    await writeProfile([entry("tag", "core")]);

    // `company-context` is a skill this catalog does have. A reference is taken at its word, so
    // naming the wrong namespace is a miss rather than a lookup that wanders into the right one.
    const result = await cli("why", `mcp:${CORE_SKILL}`);

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`unknown MCP server "${CORE_SKILL}"`);
  });

  it("refuses a subject whose kind is not a namespace, rather than reading it as a name", async () => {
    await writeProfile([entry("tag", "core")]);

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
    await writeProfile([entry("tag", "core"), entry("tag", "function.enginering")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `\`requires\` entry "tag:${CATALOG_NAME}/function.enginering" matches nothing (ambit.yml line ${FIRST_ENTRY_LINE + 1})`,
    );
    expect(result.stderr).toContain(
      `no skill, MCP server or hook in catalog "${CATALOG_NAME}" declares a tag matching "function.enginering"`,
    );
    expect(result.stderr).toContain("correct the pattern, tag an item with it (`ambit.tags`)");
  });

  it("refuses a wildcard that reaches nothing, exactly as it refuses a misspelled name", async () => {
    // The point of one grammar: a stale glob and a typo'd exact name are the same mistake, and the
    // silence a glob used to buy is what this rule removes.
    await writeProfile([entry("name", "absent.*", ["skills"])]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`\`requires\` entry "name:${CATALOG_NAME}/absent.*"`);
  });

  it("says the qualifier names no catalog rather than blaming the pattern", async () => {
    // A qualifier is an alias, not a pattern, so `*` in that half asks for a catalog literally
    // named `*` — and a message about what that catalog holds would answer the wrong question.
    await writeProfile([entry("name", "*/core", ["skills"])]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('no catalog in `catalogs:` is named "*"');
    expect(result.stderr).toContain("`*` is matched literally there");
    expect(result.stderr).toContain(`configured catalogs: ${CATALOG_NAME}`);
  });

  it("names a misspelled alias without the wildcard aside", async () => {
    await writeProfile([entry("tag", "compny/core")]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('no catalog in `catalogs:` is named "compny"');
    expect(result.stderr).not.toContain("matched literally");
    expect(result.stderr).toContain("correct the qualifier, or add the catalog to `catalogs:`");
  });

  it("refuses an entry whose capabilities exclude every match", async () => {
    // `core` is on a skill and a hook, and on no server; an entry that selects only servers by that
    // tag is a mistake even though the tag itself is live.
    await writeProfile([entry("tag", "core", ["mcps"])]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `no MCP server in catalog "${CATALOG_NAME}" declares a tag matching "core"`,
    );
  });

  it("reports the same offender however the config orders the list", async () => {
    await writeProfile([entry("tag", "zeta.unknown"), entry("tag", "alpha.unknown")]);
    const first = await cli("resolve");

    await writeProfile([entry("tag", "alpha.unknown"), entry("tag", "zeta.unknown")]);
    const second = await cli("resolve");

    expect(first.stderr).toContain(`"tag:${CATALOG_NAME}/alpha.unknown" matches nothing`);
    expect(second.stderr).toContain(`"tag:${CATALOG_NAME}/alpha.unknown" matches nothing`);
  });

  it("selects nothing before failing, so install cannot half-run", async () => {
    await expect(bundle([entry("tag", "core"), entry("tag", "not.a.tag")])).rejects.toMatchObject({
      code: ExitCode.Resolution,
    });
  });
});

describe("ambit resolve", () => {
  it("lists the bundle as text", async () => {
    await writeProfile([
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
    ]);

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        // The catalog column is padded out to the widest name, so it lines up down the section.
        "skills (3)",
        `  ${ENGINEERING_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}`,
        `  ${CORE_SKILL}  ${CATALOG_NAME}`,
        `  ${FRONTEND_SKILL.padEnd(CORE_SKILL.length)}  ${CATALOG_NAME}`,
        "",
        "mcps (1)",
        `  scoped  ${CATALOG_NAME}`,
        "",
        "hooks (2)",
        `  ${ENGINEERING_HOOK}  ${CATALOG_NAME}  PreToolUse`,
        `  ${CORE_HOOK}  ${CATALOG_NAME}  SessionStart`,
        "",
        "expects (2)",
        "  env  ACME_FIGMA_TOKEN",
        "  env  SCOPED_API_KEY",
      ].join("\n"),
    );
  });

  it("says so for an empty bundle rather than printing nothing", async () => {
    await writeProfile([]);

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
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
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
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
      entry("tag", "core"),
      entry("tag", "function.engineering"),
      entry("tag", "function.engineering.*"),
      entry("tag", "project.acme"),
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

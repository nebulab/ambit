/**
 * Full-catalog validation — `ambit validate`, one command over one subject.
 *
 * It was two: `ambit catalog validate` read one catalog directory on its own terms, because a catalog
 * was not a project and had no `ambit.yml`. A catalog repo lists **itself** now, so the case that
 * command existed for is a project like any other and is asserted here as one — see
 * "a catalog repo, which lists itself".
 *
 * Two claims carry this suite. The first is the split from resolution: validation must find what
 * `resolve` deliberately ignores, so the broken-but-unselected cases assert *both* commands — exit 0
 * from `resolve` and exit 3 from `validate`, on the same catalog.
 *
 * The second is that a CI command lists every problem. Each case that could stop at the first one
 * plants two problems and asserts both, because "exits 3" would pass either way and the whole point
 * of the command is not having to run it six times.
 *
 * Every mutation lands in the per-test copy of the fixture catalog. The shared fixture must stay
 * clean — it is what a golden profile resolves against, and this suite asserts it validates.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { skillNameFromPath } from "../../src/model/catalog.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";

const CATALOG_NAME = "company";

/** The fixture's shape, which a clean report counts back. */
const FIXTURE_PACKS = 4;
const FIXTURE_SKILLS = 4;
const FIXTURE_MCPS = 2;
const FIXTURE_HOOKS = 3;

/** `writeProfile` puts the first `requires` entry here, after the four-line preamble and the key. */
const FIRST_ENTRY_LINE = 6;

/** What a clean catalog reports: what was checked, and an explicitly empty problem list. */
const CLEAN_REPORT = [
  `checked ${FIXTURE_PACKS} packs, ${FIXTURE_SKILLS} skills, ${FIXTURE_MCPS} mcps, ${FIXTURE_HOOKS} hooks`,
  "",
  "problems (0)",
  "  (none)",
].join("\n");

let root: string;
let catalogDir: string;
let projectDir: string;

/** One `requires` entry, taking a whole pack from `catalog`. */
function requiresEntry(pack: string, catalog = CATALOG_NAME): string {
  return `  - { pack: "${catalog}/${pack}" }`;
}

/**
 * Points the project at the fixture catalog and gives it a `requires` list.
 *
 * @param packs the packs to take, each becoming one `pack:` entry.
 * @param extra further top-level config lines, appended after the list so the line each entry sits
 *   on does not depend on them.
 */
async function writeProfile(
  packs: readonly string[],
  extra: readonly string[] = [],
): Promise<void> {
  const list =
    packs.length === 0 ? "[]" : `\n${packs.map((pack) => requiresEntry(pack)).join("\n")}`;
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
 * One entry of a skill's own `requires`, **unqualified** — the spelling a catalog demands, since the
 * alias in `catalogs:` belongs to the consumer and a catalog author cannot write it.
 *
 * By exact name, a pattern with no wildcard, because what these cases are about is which edges the
 * report finds rather than what a glob reaches.
 */
function needs(kind: string, name: string): string {
  return `{ ${kind}: "${name}" }`;
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
 * Adds a skill to the catalog copy this test owns, its name derived from its path per §2.
 *
 * @param within the catalog root to write it into, so a case about two catalogs providing one name can
 *   put a copy in each.
 */
async function writeSkill(
  relative: string,
  annotations: readonly string[] = [],
  within = catalogDir,
): Promise<void> {
  const target = path.join(within, "skills", relative, "SKILL.md");
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

/** The same, with a frontmatter `name` the path does not derive — the one recoverable violation. */
async function writeMisnamedSkill(relative: string, declared: string): Promise<void> {
  const target = path.join(catalogDir, "skills", relative, "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    ["---", `name: ${declared}`, "---", "", "# fixture", ""].join("\n"),
    "utf8",
  );
}

/**
 * Adds a hook, its name derived from its directory per §2.
 *
 * @param within the catalog root to write it into, so a case about two catalogs providing one name can
 *   put a copy in each.
 */
async function writeHook(
  name: string,
  lines: readonly string[],
  within = catalogDir,
): Promise<void> {
  const target = path.join(within, "hooks", name.replaceAll(".", "/"), "hook.yml");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, [`name: ${name}`, ...lines, ""].join("\n"), "utf8");
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
 * The same, pointed at the catalog directory rather than at the project — how a catalog repo's CI
 * invokes the command, once the repo carries the three-line `ambit.yml` that lists itself.
 */
async function cliInCatalogRepo(
  ...argv: readonly string[]
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv, "--project", catalogDir], {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/**
 * Turns the fixture catalog into a catalog *repo*: the whole of what §_`ambit validate` validates the
 * catalog too_ says such a repo carries, and what `ambit init` scaffolds. No `requires:` list at all.
 */
async function writeSelfListingConfig(): Promise<void> {
  await writeFile(
    path.join(catalogDir, "ambit.yml"),
    ["version: 1", "catalogs:", "  - name: local", "    source: path:.", ""].join("\n"),
    "utf8",
  );
}

/** One problem's `kind`, `message`, and `detail`, as `--json` reports them. */
interface ProblemRecord {
  readonly kind: string;
  readonly message: string;
  readonly detail: readonly string[];
}

/** The `--json` report, parsed. */
async function report(...argv: readonly string[]): Promise<{
  valid: boolean;
  checked: Readonly<Record<string, number>>;
  problems: readonly ProblemRecord[];
}> {
  const result = await cli(...argv, "--json");
  return JSON.parse(result.stdout) as {
    valid: boolean;
    checked: Readonly<Record<string, number>>;
    problems: readonly ProblemRecord[];
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-validate-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeProfile(["core"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit validate", () => {
  it("exits 0 against the fixture catalog, saying what it checked", async () => {
    const result = await cli("validate");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(CLEAN_REPORT);
  });

  it("validates a catalog repo, which lists itself and selects nothing", async () => {
    // What `ambit catalog validate` was for, and why it is not needed: a catalog repo is a project
    // that lists its own `skills/`, `mcps/` and `hooks/` as `source: path:.`, and every item in the
    // merged catalog is checked whether anything selects it or not. Nothing here consumes anything —
    // there is no `requires:` list at all — and the whole repo is still checked.
    await writeSelfListingConfig();
    await rm(path.join(projectDir, "ambit.yml"));

    const result = await cliInCatalogRepo("validate");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(CLEAN_REPORT);
  });

  it("reports a catalog repo's own broken skill, which nothing selects", async () => {
    // The claim above, with something to find: the report is about items no `requires` entry reaches,
    // which is every item in a catalog repo.
    await writeSelfListingConfig();
    await writeSkill("broken-unselected", [requires(needs("skill", "absent-skill"))]);

    const result = await cliInCatalogRepo("validate");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stdout).toContain(
      '`requires` entry "skill:absent-skill" matches nothing (skills/broken-unselected/SKILL.md)',
    );
  });

  it("exits 2 on a catalog that does not parse, rather than reporting about it", async () => {
    // The deliberate boundary: there is no semantic report to build about a document ambit cannot
    // read, so parsing failures stay the exit-2 errors they are everywhere else.
    await writeFile(path.join(catalogDir, "mcps", "broken.yml"), "name: broken\n", "utf8");

    const result = await cli("validate");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('missing required key "transport"');
  });

  it("refuses a catalog that still holds a scopes.yml, naming the rewrite", async () => {
    // The registry is gone, and a file that still parses as one would otherwise sit there looking
    // like it labels something. Exit 2 with the migration in the message is the whole of the path.
    await writeFile(
      path.join(catalogDir, "scopes.yml"),
      "scopes:\n  core:\n    description: A\n",
      "utf8",
    );

    const result = await cli("validate");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("the scope registry is gone (scopes.yml)");
    expect(result.stderr).toContain("a group of items is a pack now");
  });
});

/**
 * Spec §4's validation split, in both directions: `resolve` hard-validates the selected closure, so
 * a skill nothing selects may carry a dangling `requires` — and `validate` is what refuses to let
 * that sit in the catalog.
 */
describe("ambit validate: requirements and cycles", () => {
  it("reports a dangling requirement `resolve` deliberately ignores", async () => {
    await writeSkill("broken-unselected", [requires(needs("skill", "absent-skill"))]);

    const resolved = await cli("resolve");
    const validated = await cli("validate");

    expect(resolved.code, resolved.stderr).toBe(ExitCode.Success);
    expect(validated.code).toBe(ExitCode.Resolution);
    expect(validated.stdout).toContain(
      '`requires` entry "skill:absent-skill" matches nothing (skills/broken-unselected/SKILL.md)',
    );
    expect(validated.stdout).toContain(
      `no skill in catalog "${CATALOG_NAME}" has a name matching "absent-skill"`,
    );
  });

  it("reports an entry that reaches no MCP entity, naming the namespace it asked for", async () => {
    await writeSkill("broken-unselected", [requires(needs("mcp", "absent"))]);

    const found = await report("validate");

    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]?.kind).toBe("unmatched-pattern");
    expect(found.problems[0]?.detail[0]).toContain('no MCP server in catalog "company"');
  });

  it("reports a missing hook by its bare name", async () => {
    await writeSkill("broken-unselected", [requires(needs("hook", "absent"))]);

    const resolved = await cli("resolve");
    const found = await report("validate");

    // The same split the describe is about: nothing selects the skill, so `resolve` never walks the
    // edge and only `validate` reports it.
    expect(resolved.code, resolved.stderr).toBe(ExitCode.Success);
    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]?.kind).toBe("unmatched-pattern");
    expect(found.problems[0]?.detail[0]).toContain('no hook in catalog "company"');
  });

  it("resolves a `[hooks]` requirement against the hooks a catalog provides", async () => {
    await writeHook("guard", ["event: Stop", "type: command", "command: npx notify"]);
    await writeSkill("well-formed", [requires(needs("hook", "guard"))]);

    expect((await report("validate")).problems).toEqual([]);
  });

  it("follows no edge out of a hook when hunting cycles, since a hook has no `requires`", async () => {
    // A hook named like a skill in the cycle would send a one-step walk round it twice; the entry
    // declares its capabilities, so the edge reaches the hook and stops there.
    await writeHook("cycle-a", ["event: Stop", "type: command", "command: npx notify"]);
    await writeSkill("cycle-a", [requires(needs("hook", "cycle-a"))]);

    expect((await report("validate")).problems).toEqual([]);
  });

  it("reports a cycle among skills nothing selects, printing the whole path", async () => {
    await writeSkill("cycle-a", [requires(needs("skill", "cycle-b"))]);
    await writeSkill("cycle-b", [requires(needs("skill", "cycle-c"))]);
    await writeSkill("cycle-c", [requires(needs("skill", "cycle-a"))]);

    const resolved = await cli("resolve");
    const validated = await cli("validate");

    expect(resolved.code, resolved.stderr).toBe(ExitCode.Success);
    expect(validated.code).toBe(ExitCode.Resolution);
    expect(validated.stdout).toContain("requirement cycle");
    expect(validated.stdout).toContain(
      "skill:cycle-a → skill:cycle-b → skill:cycle-c → skill:cycle-a",
    );
    expect(validated.stdout).toContain("closed by `skill:cycle-a` in skills/cycle-c/SKILL.md");
    expect(validated.stdout).toContain("break the cycle by removing one `requires` entry");
  });

  it("reports two independent cycles as two problems", async () => {
    await writeSkill("one-a", [requires(needs("skill", "one-b"))]);
    await writeSkill("one-b", [requires(needs("skill", "one-a"))]);
    await writeSkill("two-a", [requires(needs("skill", "two-b"))]);
    await writeSkill("two-b", [requires(needs("skill", "two-a"))]);

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.detail[0])).toEqual([
      "skill:one-a → skill:one-b → skill:one-a",
      "skill:two-a → skill:two-b → skill:two-a",
    ]);
  });

  it("reports one loop once, however many skills lead into it", async () => {
    await writeSkill("entry-left", [requires(needs("skill", "cycle-a"))]);
    await writeSkill("entry-right", [requires(needs("skill", "cycle-b"))]);
    await writeSkill("cycle-a", [requires(needs("skill", "cycle-b"))]);
    await writeSkill("cycle-b", [requires(needs("skill", "cycle-a"))]);

    const found = await report("validate");

    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]?.detail[0]).toBe("skill:cycle-a → skill:cycle-b → skill:cycle-a");
  });

  it("reports a dangling requirement and a cycle from one run", async () => {
    await writeSkill("broken-dangling", [requires(needs("skill", "absent-skill"))]);
    await writeSkill("cycle-a", [requires(needs("skill", "cycle-b"))]);
    await writeSkill("cycle-b", [requires(needs("skill", "cycle-a"))]);

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.kind)).toEqual(["unmatched-pattern", "cycle"]);
  });
});

describe("ambit validate: name↔path agreement", () => {
  it("lists a mismatch as a problem instead of stopping the run at it", async () => {
    await writeMisnamedSkill("misnamed-thing", "wrong-name");
    await writeSkill("broken-dangling", [requires(needs("skill", "absent-skill"))]);

    const validated = await cli("validate");
    const found = await report("validate");

    expect(validated.code).toBe(ExitCode.Resolution);
    // The mismatch alone would be exit 2 anywhere else; here it is one entry of a longer list.
    expect(found.problems.map((problem) => problem.kind)).toEqual([
      "name-mismatch",
      "unmatched-pattern",
    ]);
    expect(found.problems[0]?.message).toContain('skill name "wrong-name" does not match its path');
    expect(found.problems[0]?.detail).toEqual([
      `in catalog "${CATALOG_NAME}"`,
      'skills/misnamed-thing/SKILL.md derives the name "misnamed-thing"',
      "rename the directory, or correct `name` to match it",
    ]);
  });

  it("goes on to check the misnamed skill under the name its path derives", async () => {
    // Continuing past the mismatch is only worth anything if the rest of the skill is still checked,
    // and the path is the name every other tool would have installed it under.
    await writeMisnamedSkill("misnamed-thing", "wrong-name");
    await writeSkill("needs-it", [requires(needs("skill", "misnamed-thing"))]);

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.kind)).toEqual(["name-mismatch"]);
  });

  it("still exits 2 for a mismatch outside validation", async () => {
    await writeMisnamedSkill("misnamed-thing", "wrong-name");

    const result = await cli("search", "*");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("does not match its path");
  });
});

/**
 * A name two catalogs provide is not a `validate` finding any more.
 *
 * It was one while resolution silently dropped a copy: an unreachable skill somebody maintains is
 * worse than an absent one. Now nothing is dropped, both copies are addressable, and the only place
 * two copies are a conflict is a project that selects both — which is resolution's judgement, not a
 * fact about a catalog. So this suite's claim is inverted: `validate` reports nothing, and `resolve`
 * on the very same project refuses.
 */
describe("ambit validate: a name two catalogs provide", () => {
  const SECOND = "personal";

  beforeEach(async () => {
    // An exact copy of the fixture, so every name is provided twice.
    await buildFixtureCatalog(path.join(root, SECOND));
    await writeFile(
      path.join(projectDir, "ambit.yml"),
      [
        "version: 1",
        "catalogs:",
        `  - name: ${CATALOG_NAME}`,
        "    source: path:../catalog",
        `  - name: ${SECOND}`,
        `    source: path:../${SECOND}`,
        "requires:",
        requiresEntry("core"),
        requiresEntry("core", SECOND),
        "",
      ].join("\n"),
      "utf8",
    );
  });

  it("exits 0, counting every copy it checked", async () => {
    const found = await report("validate");

    expect(found.valid).toBe(true);
    expect(found.problems).toEqual([]);
    // Both copies, not both names: each is a document this run read and checked on its own terms.
    expect(found.checked).toEqual({
      packs: FIXTURE_PACKS * 2,
      skills: FIXTURE_SKILLS * 2,
      mcps: FIXTURE_MCPS * 2,
      hooks: FIXTURE_HOOKS * 2,
    });
  });

  it("leaves the collision to `resolve`, which refuses the same project", async () => {
    // The split, in the opposite direction from the rest of this file: `validate` passes a catalog
    // pair that is perfectly well-formed, and the project selecting both copies is what fails.
    expect((await cli("validate")).code).toBe(ExitCode.Success);

    const resolved = await cli("resolve");
    expect(resolved.code).toBe(ExitCode.Resolution);
    expect(resolved.stderr).toContain("is selected from more than one catalog");
  });

  it("reports a broken skill once per copy, because two copies are two documents", async () => {
    const dangling = [requires(needs("skill", "absent"))];
    await writeSkill("dangling", dangling);
    await writeSkill("dangling", dangling, path.join(root, SECOND));

    const found = await report("validate");
    const problems = found.problems.filter((problem) => problem.message.includes("skill:absent"));

    expect(problems).toHaveLength(2);
    expect(new Set(problems.map((problem) => problem.kind))).toEqual(
      new Set(["unmatched-pattern"]),
    );
  });

  it("does not let one catalog's copy satisfy the other's `requires`", async () => {
    // The tightening a bare pattern inside a catalog buys: `personal` ships `needed`, `company` does
    // not, and `company`'s skill asking for it is unsatisfied however plainly the merged view holds a
    // match. A catalog can only require what it ships.
    await writeSkill("needs-across", [requires(needs("skill", "needed"))]);
    await writeSkill("needed", [], path.join(root, SECOND));

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.message)).toEqual([
      '`requires` entry "skill:needed" matches nothing (skills/needs-across/SKILL.md)',
    ]);
    expect(found.problems[0]?.detail).toEqual([
      `no skill in catalog "${CATALOG_NAME}" has a name matching "needed"`,
      "a catalog's own `requires` resolves within that catalog, which can only require what it ships",
      "correct the pattern, add the item to a catalog, or remove the entry",
    ]);
  });
});

/**
 * The multi-problem variant of what resolution throws one at a time. Both surfaces use the same
 * error builders, so the assertion is that `validate` lists what `resolve` stops at.
 */
describe("ambit validate: the project's own config", () => {
  it("lists every entry that matches nothing in one run, in document order", async () => {
    await writeProfile(["core", "zeta.unknown", "alpha.unknown"]);

    const resolved = await cli("resolve");
    const found = await report("validate");

    // `resolve` reports the alphabetically first offender and nothing else, so which one it names
    // does not fall to the order the config happens to list them in.
    expect(resolved.code).toBe(ExitCode.Resolution);
    expect(resolved.stderr).toContain(`"pack:${CATALOG_NAME}/alpha.unknown" matches nothing`);
    expect(resolved.stderr).not.toContain("zeta.unknown");

    // `validate` lists all of them, down the file the reader has open.
    expect(found.problems.map((problem) => problem.message)).toEqual([
      `\`requires\` entry "pack:${CATALOG_NAME}/zeta.unknown" matches nothing (ambit.yml line ${FIRST_ENTRY_LINE + 1})`,
      `\`requires\` entry "pack:${CATALOG_NAME}/alpha.unknown" matches nothing (ambit.yml line ${FIRST_ENTRY_LINE + 2})`,
    ]);
    expect(found.problems.map((problem) => problem.kind)).toEqual([
      "unmatched-pattern",
      "unmatched-pattern",
    ]);
  });

  it("checks the project's own `skills/` when the project lists itself as a catalog", async () => {
    // The replacement for a `skills` entry that carried its own `source`: a project that publishes
    // something is a catalog, so `validate` reads it with no special case — and a broken skill it
    // ships is a finding like any other, whether the project selects it or not.
    await writeSkill("readwise-cli", [requires(needs("skill", "absent-skill"))], projectDir);
    await writeFile(
      path.join(projectDir, "ambit.yml"),
      [
        "version: 1",
        "catalogs:",
        `  - name: ${CATALOG_NAME}`,
        "    source: path:../catalog",
        "  - name: local",
        "    source: path:.",
        "requires:",
        requiresEntry("core"),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await cli("validate");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stdout).toContain(`checked ${FIXTURE_PACKS} packs, ${FIXTURE_SKILLS + 1} skills`);
    expect(result.stdout).toContain(
      '`requires` entry "skill:absent-skill" matches nothing (skills/readwise-cli/SKILL.md)',
    );
  });

  it("reports nothing about an entry some configured catalog's items satisfy", async () => {
    await writeProfile(["core", "function.engineering", "function.engineering.*", "project.acme"]);

    expect((await cli("validate")).code).toBe(ExitCode.Success);
  });
});

/**
 * The one finding whose subject is the config alone: a catalog it lists and never selects from.
 *
 * This is what a typo'd `source:` escapes into now that a catalog is a directory and nothing else —
 * a misspelled path is not a parse failure, and where no pattern is qualified with the alias, nothing
 * else has a reason to look at it. Both of its exemptions are here too, because each of them is what
 * keeps `validate` passing on something `ambit init` produced.
 */
describe("ambit validate: a configured catalog nothing selects from", () => {
  const SECOND = "personal";

  /** Points the project at the fixture catalog plus one more, selecting only from the fixture. */
  async function writeTwoCatalogs(name: string, source: string): Promise<void> {
    await writeFile(
      path.join(projectDir, "ambit.yml"),
      [
        "version: 1",
        "catalogs:",
        `  - name: ${CATALOG_NAME}`,
        "    source: path:../catalog",
        `  - name: ${name}`,
        `    source: ${source}`,
        "requires:",
        requiresEntry("core"),
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("reports a catalog with items that no entry is qualified with", async () => {
    await buildFixtureCatalog(path.join(root, SECOND));
    await writeTwoCatalogs(SECOND, `path:../${SECOND}`);

    const found = await report("validate");

    expect(found.problems).toEqual([
      {
        kind: "unselected-catalog",
        message: `catalog "${SECOND}" is configured but nothing selects from it (ambit.yml)`,
        detail: [
          `it provides ${FIXTURE_PACKS + FIXTURE_SKILLS + FIXTURE_MCPS + FIXTURE_HOOKS} items, and no \`requires\` entry is qualified with "${SECOND}/"`,
          "select what this project needs from it, or drop it from `catalogs:`",
        ],
      },
    ]);
  });

  it("reports the unmatched pattern instead when an entry does name the catalog", async () => {
    // Qualified with, not matched by. An entry spelled `personal/nope` mentions the catalog, so the
    // pattern is the offender and one mistake is reported once.
    await buildFixtureCatalog(path.join(root, SECOND));
    await writeFile(
      path.join(projectDir, "ambit.yml"),
      [
        "version: 1",
        "catalogs:",
        `  - name: ${CATALOG_NAME}`,
        "    source: path:../catalog",
        `  - name: ${SECOND}`,
        `    source: path:../${SECOND}`,
        "requires:",
        requiresEntry("core"),
        requiresEntry("nope", SECOND),
        "",
      ].join("\n"),
      "utf8",
    );

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.kind)).toEqual(["unmatched-pattern"]);
  });

  it("says nothing about a catalog with no items, which is just empty", async () => {
    // `ambit init` scaffolds a live `local` entry against three empty directories and comments out the
    // entry that would select it, so a finding here would fail `validate` on every fresh project.
    await mkdir(path.join(root, "empty"), { recursive: true });
    await writeTwoCatalogs("empty", "path:../empty");

    const result = await cli("validate");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });

  it("says nothing about the catalog the project itself is, however many items it holds", async () => {
    // The guard above stops holding the moment somebody puts a skill in `skills/`, which is what a
    // catalog repo is. Publishing is not consuming: a repo that ships items and selects none of them
    // is the normal state of a catalog repo, and `ambit init` scaffolded the entry that says so.
    await writeSkill("readwise-cli", [], projectDir);
    await writeTwoCatalogs("local", "path:.");

    const result = await cli("validate");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(`checked ${FIXTURE_PACKS} packs, ${FIXTURE_SKILLS + 1} skills`);
  });
});

describe("ambit validate output", () => {
  it("emits the problem list as JSON, with the verdict and what was checked", async () => {
    await writeSkill("broken-thing", [requires(needs("skill", "absent-skill"))]);

    const result = await cli("validate", "--json");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(JSON.parse(result.stdout)).toEqual({
      checked: {
        hooks: FIXTURE_HOOKS,
        mcps: FIXTURE_MCPS,
        packs: FIXTURE_PACKS,
        skills: FIXTURE_SKILLS + 1,
      },
      problems: [
        {
          detail: [
            `no skill in catalog "${CATALOG_NAME}" has a name matching "absent-skill"`,
            "a catalog's own `requires` resolves within that catalog, which can only require what it ships",
            "correct the pattern, add the item to a catalog, or remove the entry",
          ],
          kind: "unmatched-pattern",
          message:
            '`requires` entry "skill:absent-skill" matches nothing (skills/broken-thing/SKILL.md)',
        },
      ],
      valid: false,
    });
  });

  it("emits `valid: true` for a clean catalog rather than an empty document", async () => {
    expect(await report("validate")).toEqual({
      checked: {
        hooks: FIXTURE_HOOKS,
        mcps: FIXTURE_MCPS,
        packs: FIXTURE_PACKS,
        skills: FIXTURE_SKILLS,
      },
      problems: [],
      valid: true,
    });
  });

  it("counts the hooks it checked, so a clean run says the third namespace was looked at", async () => {
    await writeHook("guard", ["event: Stop", "type: command", "command: npx notify"]);

    const result = await cli("validate");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(
      `checked ${FIXTURE_PACKS} packs, ${FIXTURE_SKILLS} skills, ${FIXTURE_MCPS} mcps, ${FIXTURE_HOOKS + 1} hooks`,
    );
    expect((await report("validate")).checked).toEqual({
      hooks: FIXTURE_HOOKS + 1,
      mcps: FIXTURE_MCPS,
      packs: FIXTURE_PACKS,
      skills: FIXTURE_SKILLS,
    });
  });

  it("prints each problem's detail indented under its summary", async () => {
    await writeSkill("broken-thing", [requires(needs("skill", "absent-skill"))]);

    const result = await cli("validate");

    expect(result.stdout).toBe(
      [
        `checked ${FIXTURE_PACKS} packs, ${FIXTURE_SKILLS + 1} skills, ${FIXTURE_MCPS} mcps, ${FIXTURE_HOOKS} hooks`,
        "",
        "problems (1)",
        '  `requires` entry "skill:absent-skill" matches nothing (skills/broken-thing/SKILL.md)',
        `      no skill in catalog "${CATALOG_NAME}" has a name matching "absent-skill"`,
        "      a catalog's own `requires` resolves within that catalog, which can only require what it ships",
        "      correct the pattern, add the item to a catalog, or remove the entry",
      ].join("\n"),
    );
  });

  it("emits byte-identical JSON on a second run, and carries no machine paths", async () => {
    await writeSkill("broken-thing", [requires(needs("skill", "absent-skill"))]);

    const first = await cli("validate", "--json");
    const second = await cli("validate", "--json");

    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).not.toContain(root);
  });

  it("carries no machine paths in a catalog repo either, where the root is the project", async () => {
    await writeSelfListingConfig();
    await writeMisnamedSkill("misnamed-thing", "wrong-name");

    const result = await cliInCatalogRepo("validate");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stdout).not.toContain(root);
  });
});

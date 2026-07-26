/**
 * Full-catalog validation — `ambit validate` for a project, `ambit catalog validate` for one catalog
 * directory on its own terms. They are two commands over one report, so most cases here run the
 * project half and the catalog half is asserted where the subject is what differs: no `ambit.yml`
 * within reach, and nothing to say about shadowing when only one catalog was read.
 *
 * Two claims carry this suite. The first is the split from resolution: validation must find what
 * `resolve` deliberately ignores, so the broken-but-unselected cases assert *both* commands — exit 0
 * from one and exit 3 from the other, on the same catalog.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import { skillNameFromPath } from "../../src/model/catalog.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";

const CATALOG_NAME = "company";

/** The fixture's shape, which a clean report counts back. */
const FIXTURE_SCOPES = 4;
const FIXTURE_SKILLS = 4;
const FIXTURE_MCPS = 2;
/** None yet: the shared fixture grows hooks with the rest of the backlog. */
const FIXTURE_HOOKS = 0;

/** `writeProfile` puts the first held scope here, after the four-line preamble and `scopes:`. */
const FIRST_SCOPE_LINE = 6;

/** What a clean catalog reports: what was checked, and an explicitly empty problem list. */
const CLEAN_REPORT = [
  `checked ${FIXTURE_SCOPES} scopes, ${FIXTURE_SKILLS} skills, ${FIXTURE_MCPS} mcps, ${FIXTURE_HOOKS} hooks`,
  "",
  "problems (0)",
  "  (none)",
].join("\n");

let root: string;
let catalogDir: string;
let projectDir: string;

/**
 * Points the project at the fixture catalog and gives it `scopes`.
 *
 * @param extra further top-level config lines, appended after the scopes list so the line each held
 *   scope sits on does not depend on them.
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
    source: path:../catalog
scopes: ${list}
${extra.map((line) => `${line}\n`).join("")}`,
    "utf8",
  );
}

/**
 * The annotation lines as §3.2 nests them: under a top-level `ambit:`, indented with it.
 *
 * Callers still pass `scopes:` and `requires:` as they are tabulated, so a fixture reads like the
 * format's own documentation and only one place knows where the block goes.
 */
function ambitBlock(annotations: readonly string[]): readonly string[] {
  return annotations.length === 0 ? [] : ["ambit:", ...annotations.map((line) => `  ${line}`)];
}

/** Adds a skill to the catalog copy this test owns, its name derived from its path per §2. */
async function writeSkill(relative: string, annotations: readonly string[] = []): Promise<void> {
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
 * Adds an MCP entity, its name taken from its filename per §3.3.
 *
 * @param extension which of §3.3's two extensions to write it as, since which one is on disk is what
 *   a problem about the entity has to cite.
 */
async function writeMcp(
  name: string,
  annotations: readonly string[] = [],
  extension = ".yml",
): Promise<void> {
  await writeFile(
    path.join(catalogDir, "mcps", `${name}${extension}`),
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
 * Adds a hook, its name derived from its directory per §2.
 *
 * @param within the catalog root to write it into, so a shadowing case can put one copy in each.
 */
async function writeHook(
  name: string,
  lines: readonly string[],
  within = catalogDir,
): Promise<void> {
  const target = path.join(within, "hooks", name.replaceAll(".", "/"), "HOOK.yml");
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

/** The same, with no `--project` at all — how a catalog repo's CI invokes the command. */
async function cliWithoutProject(
  ...argv: readonly string[]
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...argv], {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
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

  it("validates a catalog directory with no project config anywhere", async () => {
    // A catalog is not a project and has no `ambit.yml`, so the CI check for one cannot
    // depend on finding a config — here there is none within reach of the cwd. That is the whole
    // reason `catalog validate` is its own command: nothing about it reads a project.
    await rm(path.join(projectDir, "ambit.yml"));

    const result = await cliWithoutProject("catalog", "validate", "--catalog", catalogDir);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(CLEAN_REPORT);
  });

  it("exits 2 on a catalog that does not parse, rather than reporting about it", async () => {
    // The deliberate boundary: there is no semantic report to build about a document ambit cannot
    // read, so parsing failures stay the exit-2 errors they are everywhere else.
    await writeFile(path.join(catalogDir, "scopes.yml"), "scopes:\n  core: {}\n", "utf8");

    const result = await cli("validate");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('missing required key "scopes.core.description"');
  });
});

describe("ambit validate: unregistered scopes", () => {
  it("reports a scope a skill declares that no registry knows, and suggests the near one", async () => {
    await writeSkill("typo-thing", ["scopes: [function.enginering]"]);

    const result = await cli("validate");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stdout).toContain(
      'unregistered scope "function.enginering" (skills/typo-thing/SKILL.md)',
    );
    expect(result.stdout).toContain(
      'skill "typo-thing" declares it, but no catalog\'s scopes.yml registers it',
    );
    expect(result.stdout).toContain('did you mean "function.engineering"?');
  });

  it("reports one for an MCP entity too, naming the server and its catalog", async () => {
    await writeMcp("loose", ["scopes: [marketing]"]);

    const found = await report("validate");

    expect(found.valid).toBe(false);
    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]).toMatchObject({
      kind: "unregistered-scope",
      message: 'unregistered scope "marketing" (mcps/loose.yml)',
    });
    expect(found.problems[0]?.detail[0]).toBe(
      'MCP server "loose" (catalog "company") declares it, but no catalog\'s scopes.yml registers it',
    );
  });

  it("reports one for a hook too, naming the hook and its catalog", async () => {
    await writeHook("guard", ["scopes: [marketing]", "event: Stop", "command: npx notify"]);

    const found = await report("validate");

    expect(found.valid).toBe(false);
    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]).toMatchObject({
      kind: "unregistered-scope",
      message: 'unregistered scope "marketing" (hooks/guard/HOOK.yml)',
    });
    expect(found.problems[0]?.detail[0]).toBe(
      'hook "guard" (catalog "company") declares it, but no catalog\'s scopes.yml registers it',
    );
  });

  it("cites the config file for a hook the project declares inline, which has no directory", async () => {
    await writeProfile(
      ["core"],
      [
        "hooks:",
        "  - name: custom",
        "    scopes: [marketing]",
        "    event: Stop",
        "    command: x",
      ],
    );

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.message)).toEqual([
      'unregistered scope "marketing" (ambit.yml)',
    ]);
    expect(found.problems[0]?.detail[0]).toBe(
      'hook "custom" (catalog "ambit.yml") declares it, but no catalog\'s scopes.yml registers it',
    );
  });

  it("cites the file an entity is written as, not the extension ambit would have chosen", async () => {
    // `mcps/<name>.yml` is what ambit writes, but §3.3 accepts `.yaml` too — and a problem reported
    // against the file that is *not* there sends the reader nowhere.
    await writeMcp("loose", ["scopes: [marketing]"], ".yaml");

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.message)).toEqual([
      'unregistered scope "marketing" (mcps/loose.yaml)',
    ]);
    expect(found.problems[0]?.message).not.toContain("mcps/loose.yml");
  });

  it("cites the config file for an entity the project declares inline, which has no file", async () => {
    // An inline `mcps` entry (§3.1) is a document ambit never wrote and never will; `ambit.yml` is
    // where a reader goes to change it, so that is what the problem names.
    await writeProfile(
      ["core"],
      [
        "mcps:",
        "  - name: custom",
        "    scopes: [marketing]",
        "    transport:",
        "      stdio:",
        "        command: fixture-mcp",
      ],
    );

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.message)).toEqual([
      'unregistered scope "marketing" (ambit.yml)',
    ]);
    expect(found.problems[0]?.detail[0]).toBe(
      'MCP server "custom" (catalog "ambit.yml") declares it, but no catalog\'s scopes.yml registers it',
    );
  });

  it("says how to register a scope nothing resembles rather than guessing", async () => {
    await writeSkill("typo-thing", ["scopes: [marmalade]"]);

    const result = await cli("validate");

    expect(result.stdout).toContain(
      "register it in a catalog's scopes.yml, or correct the spelling",
    );
    expect(result.stdout).not.toContain("did you mean");
  });

  it("lists every offending scope, not the first", async () => {
    await writeSkill("typo-one", ["scopes: [alpha.unknown, zeta.unknown]"]);
    await writeSkill("typo-two", ["scopes: [middle.unknown]"]);

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.message)).toEqual([
      'unregistered scope "alpha.unknown" (skills/typo-one/SKILL.md)',
      'unregistered scope "zeta.unknown" (skills/typo-one/SKILL.md)',
      'unregistered scope "middle.unknown" (skills/typo-two/SKILL.md)',
    ]);
  });
});

/**
 * Spec §4's validation split, in both directions: `resolve` hard-validates the selected closure, so
 * a skill nothing selects may carry a dangling `requires` — and `validate` is what refuses to let
 * that sit in the catalog.
 */
describe("ambit validate: requirements and cycles", () => {
  it("reports a dangling requirement `resolve` deliberately ignores", async () => {
    await writeSkill("broken-unselected", ["requires: [absent-skill]"]);

    const resolved = await cli("resolve");
    const validated = await cli("validate");

    expect(resolved.code, resolved.stderr).toBe(ExitCode.Success);
    expect(validated.code).toBe(ExitCode.Resolution);
    expect(validated.stdout).toContain(
      'unresolvable requirement "absent-skill" (skills/broken-unselected/SKILL.md)',
    );
    expect(validated.stdout).toContain('broken-unselected requires a skill named "absent-skill"');
  });

  it("reports a missing MCP entity by its bare name", async () => {
    await writeSkill("broken-unselected", ["requires: [mcp.absent]"]);

    const found = await report("validate");

    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]?.kind).toBe("unresolvable-requirement");
    expect(found.problems[0]?.detail[0]).toContain('an MCP entity named "absent"');
  });

  it("reports a missing hook by its bare name", async () => {
    await writeSkill("broken-unselected", ["requires: [hook.absent]"]);

    const resolved = await cli("resolve");
    const found = await report("validate");

    // The same split the describe is about: nothing selects the skill, so `resolve` never walks the
    // edge and only `validate` reports it.
    expect(resolved.code, resolved.stderr).toBe(ExitCode.Success);
    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]?.kind).toBe("unresolvable-requirement");
    expect(found.problems[0]?.detail[0]).toContain('a hook named "absent"');
    expect(found.problems[0]?.detail[1]).toContain("hooks/");
  });

  it("resolves a `hook.` requirement against the hooks a catalog provides", async () => {
    await writeHook("guard", ["event: Stop", "command: npx notify"]);
    await writeSkill("well-formed", ["requires: [hook.guard]"]);

    expect((await report("validate")).problems).toEqual([]);
  });

  it("follows no edge out of a hook when hunting cycles, since a hook has no `requires`", async () => {
    // A hook named like a skill in the cycle would send a one-step walk round it twice; the prefix
    // decides the namespace, so the edge simply ends.
    await writeHook("cycle-a", ["event: Stop", "command: npx notify"]);
    await writeSkill("cycle-a", ["requires: [hook.cycle-a]"]);

    expect((await report("validate")).problems).toEqual([]);
  });

  it("reports a cycle among skills no scope selects, printing the whole path", async () => {
    await writeSkill("cycle-a", ["requires: [cycle-b]"]);
    await writeSkill("cycle-b", ["requires: [cycle-c]"]);
    await writeSkill("cycle-c", ["requires: [cycle-a]"]);

    const resolved = await cli("resolve");
    const validated = await cli("validate");

    expect(resolved.code, resolved.stderr).toBe(ExitCode.Success);
    expect(validated.code).toBe(ExitCode.Resolution);
    expect(validated.stdout).toContain("requirement cycle");
    expect(validated.stdout).toContain("cycle-a → cycle-b → cycle-c → cycle-a");
    expect(validated.stdout).toContain("break the cycle by removing one `requires` edge");
  });

  it("reports two independent cycles as two problems", async () => {
    await writeSkill("one-a", ["requires: [one-b]"]);
    await writeSkill("one-b", ["requires: [one-a]"]);
    await writeSkill("two-a", ["requires: [two-b]"]);
    await writeSkill("two-b", ["requires: [two-a]"]);

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.detail[0])).toEqual([
      "one-a → one-b → one-a",
      "two-a → two-b → two-a",
    ]);
  });

  it("reports one loop once, however many skills lead into it", async () => {
    await writeSkill("entry-left", ["requires: [cycle-a]"]);
    await writeSkill("entry-right", ["requires: [cycle-b]"]);
    await writeSkill("cycle-a", ["requires: [cycle-b]"]);
    await writeSkill("cycle-b", ["requires: [cycle-a]"]);

    const found = await report("validate");

    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]?.detail[0]).toBe("cycle-a → cycle-b → cycle-a");
  });

  it("reports a dangling requirement and a cycle from one run", async () => {
    await writeSkill("broken-dangling", ["requires: [absent-skill]"]);
    await writeSkill("cycle-a", ["requires: [cycle-b]"]);
    await writeSkill("cycle-b", ["requires: [cycle-a]"]);

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.kind)).toEqual([
      "unresolvable-requirement",
      "cycle",
    ]);
  });
});

describe("ambit validate: name↔path agreement", () => {
  it("lists a mismatch as a problem instead of stopping the run at it", async () => {
    await writeMisnamedSkill("misnamed-thing", "wrong-name");
    await writeSkill("broken-dangling", ["requires: [absent-skill]"]);

    const validated = await cli("validate");
    const found = await report("validate");

    expect(validated.code).toBe(ExitCode.Resolution);
    // The mismatch alone would be exit 2 anywhere else; here it is one entry of a longer list.
    expect(found.problems.map((problem) => problem.kind)).toEqual([
      "name-mismatch",
      "unresolvable-requirement",
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
    await writeSkill("needs-it", ["requires: [misnamed-thing]"]);

    const found = await report("validate");

    expect(found.problems.map((problem) => problem.kind)).toEqual(["name-mismatch"]);
  });

  it("still exits 2 for a mismatch outside validation", async () => {
    await writeMisnamedSkill("misnamed-thing", "wrong-name");

    const result = await cli("dump-catalog");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("does not match its path");
  });
});

/**
 * Spec §4.5: resolution has a well-defined answer for a duplicate name — the earlier catalog wins —
 * and `validate` still calls it a problem, because in a catalog the losing copy is instructions
 * somebody maintains and nothing installs.
 */
describe("ambit validate: shadowing", () => {
  const SECOND = "personal";

  beforeEach(async () => {
    // An exact copy of the fixture, so every name collides and the scope descriptions agree — a
    // description conflict is a different error and would mask this one.
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
        "scopes: [core]",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  it("reports every shadowed name, naming the winner and the losers", async () => {
    const found = await report("validate");

    expect(found.valid).toBe(false);
    expect(found.problems).toHaveLength(FIXTURE_SKILLS + FIXTURE_MCPS);
    expect(new Set(found.problems.map((problem) => problem.kind))).toEqual(
      new Set(["shadowed-name"]),
    );
    expect(found.problems[0]).toMatchObject({
      message: `shadowed skill "acme-brief" (catalog "${CATALOG_NAME}")`,
      detail: [
        `catalog "${CATALOG_NAME}" provides the copy resolution uses`,
        `also provided by: ${SECOND}`,
        "rename one of the copies, or drop the catalog that should not provide it",
      ],
    });
  });

  it("reports a hook two catalogs provide, after the skills and the servers", async () => {
    await writeHook("guard", ["event: Stop", "command: npx notify"]);
    await writeHook("guard", ["event: Stop", "command: npx notify"], path.join(root, SECOND));

    const found = await report("validate");

    expect(found.problems.at(-1)).toMatchObject({
      kind: "shadowed-name",
      message: `shadowed hook "guard" (catalog "${CATALOG_NAME}")`,
      detail: [
        `catalog "${CATALOG_NAME}" provides the copy resolution uses`,
        `also provided by: ${SECOND}`,
        "rename one of the copies, or drop the catalog that should not provide it",
      ],
    });
  });

  it("keeps skills and servers in name order within their kinds", async () => {
    const found = await report("validate");

    expect(found.problems.map((problem) => problem.message)).toEqual([
      `shadowed skill "acme-brief" (catalog "${CATALOG_NAME}")`,
      `shadowed skill "code-review" (catalog "${CATALOG_NAME}")`,
      `shadowed skill "company-context" (catalog "${CATALOG_NAME}")`,
      `shadowed skill "design-tokens" (catalog "${CATALOG_NAME}")`,
      `shadowed MCP server "fixture" (catalog "${CATALOG_NAME}")`,
      `shadowed MCP server "scoped" (catalog "${CATALOG_NAME}")`,
    ]);
  });

  it("says nothing about shadowing when `catalog validate` reads only one catalog", async () => {
    const result = await cliWithoutProject("catalog", "validate", "--catalog", catalogDir);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });
});

/**
 * The multi-problem variant of what resolution throws one at a time. Both surfaces use the same
 * error builders, so the assertion is that `validate` lists what `resolve` stops at.
 */
describe("ambit validate: the project's own config", () => {
  it("lists every mistyped held scope and every unknown explicit skill in one run", async () => {
    await writeProfile(["core", "zeta.unknown", "alpha.unknown"], ["skills:", "  - absent-skill"]);

    const resolved = await cli("resolve");
    const found = await report("validate");

    // `resolve` reports the alphabetically first offender and nothing else.
    expect(resolved.code).toBe(ExitCode.Resolution);
    expect(resolved.stderr).toContain('unknown scope "alpha.unknown"');
    expect(resolved.stderr).not.toContain("zeta.unknown");

    expect(found.problems.map((problem) => problem.message)).toEqual([
      `unknown scope "alpha.unknown" (ambit.yml line ${FIRST_SCOPE_LINE + 2})`,
      `unknown scope "zeta.unknown" (ambit.yml line ${FIRST_SCOPE_LINE + 1})`,
      `unknown skill "absent-skill" (ambit.yml line ${FIRST_SCOPE_LINE + 4})`,
    ]);
    expect(found.problems.map((problem) => problem.kind)).toEqual([
      "unknown-scope",
      "unknown-scope",
      "unknown-skill",
    ]);
  });

  it("accepts a skill the config declares with its own source", async () => {
    const extra = path.join(root, "extra", "skills", "readwise-cli");
    await mkdir(extra, { recursive: true });
    await writeFile(
      path.join(extra, "SKILL.md"),
      ["---", "name: readwise-cli", "---", "", "# fixture", ""].join("\n"),
      "utf8",
    );
    await writeProfile(
      ["core"],
      ["skills:", "  - name: readwise-cli", "    source: path:../extra"],
    );

    const result = await cli("validate");

    // Folded into the merged catalog, so it is neither an unknown name nor an unregistered scope.
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(
      `checked ${FIXTURE_SCOPES} scopes, ${FIXTURE_SKILLS + 1} skills`,
    );
  });

  it("reports nothing about a held scope registered by any configured catalog", async () => {
    await writeProfile(["core", "function.engineering", "project.acme"]);

    expect((await cli("validate")).code).toBe(ExitCode.Success);
  });
});

describe("ambit validate output", () => {
  it("emits the problem list as JSON, with the verdict and what was checked", async () => {
    await writeSkill("typo-thing", ["scopes: [marmalade]"]);

    const result = await cli("validate", "--json");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(JSON.parse(result.stdout)).toEqual({
      checked: {
        hooks: FIXTURE_HOOKS,
        mcps: FIXTURE_MCPS,
        scopes: FIXTURE_SCOPES,
        skills: FIXTURE_SKILLS + 1,
      },
      problems: [
        {
          detail: [
            'skill "typo-thing" declares it, but no catalog\'s scopes.yml registers it',
            "register it in a catalog's scopes.yml, or correct the spelling",
          ],
          kind: "unregistered-scope",
          message: 'unregistered scope "marmalade" (skills/typo-thing/SKILL.md)',
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
        scopes: FIXTURE_SCOPES,
        skills: FIXTURE_SKILLS,
      },
      problems: [],
      valid: true,
    });
  });

  it("counts the hooks it checked, so a clean run says the third namespace was looked at", async () => {
    await writeHook("guard", ["event: Stop", "command: npx notify"]);

    const result = await cli("validate");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(
      `checked ${FIXTURE_SCOPES} scopes, ${FIXTURE_SKILLS} skills, ${FIXTURE_MCPS} mcps, 1 hook`,
    );
    expect((await report("validate")).checked).toEqual({
      hooks: 1,
      mcps: FIXTURE_MCPS,
      scopes: FIXTURE_SCOPES,
      skills: FIXTURE_SKILLS,
    });
  });

  it("prints each problem's detail indented under its summary", async () => {
    await writeSkill("typo-thing", ["scopes: [marmalade]"]);

    const result = await cli("validate");

    expect(result.stdout).toBe(
      [
        `checked ${FIXTURE_SCOPES} scopes, ${FIXTURE_SKILLS + 1} skills, ${FIXTURE_MCPS} mcps, ${FIXTURE_HOOKS} hooks`,
        "",
        "problems (1)",
        '  unregistered scope "marmalade" (skills/typo-thing/SKILL.md)',
        '      skill "typo-thing" declares it, but no catalog\'s scopes.yml registers it',
        "      register it in a catalog's scopes.yml, or correct the spelling",
      ].join("\n"),
    );
  });

  it("emits byte-identical JSON on a second run, and carries no machine paths", async () => {
    await writeSkill("typo-thing", ["scopes: [marmalade]"]);

    const first = await cli("validate", "--json");
    const second = await cli("validate", "--json");

    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).not.toContain(root);
  });

  it("carries no machine paths under `catalog validate` either, where the root is an argument", async () => {
    await writeMisnamedSkill("misnamed-thing", "wrong-name");

    const result = await cliWithoutProject("catalog", "validate", "--catalog", catalogDir);

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stdout).not.toContain(root);
  });
});

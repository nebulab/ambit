/**
 * Resolution by scope (spec §4.6–§4.7), and the `ambit resolve` output built on it.
 *
 * The rule under test is descendants-only: a held scope selects itself and everything beneath it,
 * and never anything above it. Both directions matter, so both are asserted — on the expansion
 * itself, where a synthetic registry can hold shapes the fixture does not, and end to end against
 * the fixture catalog.
 *
 * The `resolve --json` shape is pinned by golden files under `test/golden/resolve/`, one per
 * profile, so a change in what a set of scopes selects shows up as a reviewable diff rather than
 * a rewritten assertion. Regenerate them with `UPDATE_GOLDEN=1 npm test` and read the diff.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import {
  loadCatalogs,
  mergeCatalogs,
  mergeConfigEntities,
  skillNameFromPath,
} from "../src/catalog.js";
import type { ProjectConfig } from "../src/config.js";
import { loadProjectConfig } from "../src/config.js";
import { AmbitError, ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";
import type { Bundle } from "../src/resolve.js";
import { assertScopesRegistered, expandHeldScopes, resolveBundle } from "../src/resolve.js";
import type { SourceContext } from "../src/sources.js";

const CATALOG_NAME = "company";

const CORE_SKILL = "acme.commons.use-company-context";
const ENGINEERING_SKILL = "acme.engineering.use-code-review";
const FRONTEND_SKILL = "acme.engineering.frontend.use-design-tokens";
const PROJECT_SKILL = "acme.projects.use-acme-brief";

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "golden",
  "resolve",
);

/** The profile matrix spec §7 asks for: one set of held scopes each, with a golden file. */
const PROFILES: readonly { readonly name: string; readonly scopes: readonly string[] }[] = [
  { name: "empty", scopes: [] },
  { name: "core", scopes: ["core"] },
  { name: "engineering", scopes: ["function.engineering"] },
  { name: "core-and-engineering", scopes: ["core", "function.engineering"] },
  { name: "frontend", scopes: ["function.engineering.frontend"] },
  { name: "project", scopes: ["project.acme"] },
];

let root: string;
let catalogDir: string;
let projectDir: string;

/**
 * Points the project at the fixture catalog and gives it `scopes`.
 *
 * @param extra further top-level config lines — `skills` and `mcps` blocks — appended after the
 *   scopes list, so the line each held scope sits on does not depend on them.
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
    ["---", `name: ${skillNameFromPath(relative)}`, ...annotations, "---", "", "# fixture", ""].join(
      "\n",
    ),
    "utf8",
  );
}

/**
 * Writes a skill into a directory that is not a catalog — no registry, no `mcps/` — which is what a
 * `skills` entry carrying its own `source` points at (spec §3.1).
 *
 * @param within the skill's directory inside the source.
 */
async function writeSourceSkill(
  within: string,
  name: string,
  annotations: readonly string[] = [],
): Promise<void> {
  const target = path.join(root, "extra", within, "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    ["---", `name: ${name}`, ...annotations, "---", "", "# fixture", ""].join("\n"),
    "utf8",
  );
}

/** What source resolution reads from outside its arguments; every source here is a local path. */
function context(): SourceContext {
  return { projectDir, env: process.env };
}

/** Resolves the project in-process, skipping the CLI. */
async function bundle(scopes: readonly string[], extra: readonly string[] = []): Promise<Bundle> {
  await writeProfile(scopes, extra);
  const config = await loadProjectConfig(projectDir);
  const catalogs = mergeCatalogs(await loadCatalogs(config, context()));
  return resolveBundle(config, await mergeConfigEntities(catalogs, config, context()));
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
  await writeProfile(["core"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolve golden files", () => {
  for (const profile of PROFILES) {
    it(`matches the golden bundle for ${profile.name}`, async () => {
      await writeProfile(profile.scopes);

      const result = await cli("resolve", "--json");
      expect(result.code).toBe(ExitCode.Success);
      await expectGolden(profile.name, result.stdout);
    });
  }
});

/**
 * The expansion in isolation, against a registry the fixture cannot supply: two levels of
 * nesting, and a sibling whose name merely starts with another scope's.
 */
describe("scope subtree expansion", () => {
  const REGISTRY = [
    { name: "core", description: "The universal floor" },
    { name: "function.engineering", description: "Engineering" },
    { name: "function.engineering-legacy", description: "A sibling, not a child" },
    { name: "function.engineering.frontend", description: "Frontend" },
    { name: "function.engineering.frontend.a11y", description: "Accessibility" },
  ];

  it("includes the held scope and every scope beneath it, however deep", () => {
    expect([...expandHeldScopes(["function.engineering"], REGISTRY)]).toEqual([
      "function.engineering",
      "function.engineering.frontend",
      "function.engineering.frontend.a11y",
    ]);
  });

  it("does not reach up from a child to its parent", () => {
    expect([...expandHeldScopes(["function.engineering.frontend"], REGISTRY)]).toEqual([
      "function.engineering.frontend",
      "function.engineering.frontend.a11y",
    ]);
  });

  it("does not reach a sibling that merely shares a prefix", () => {
    expect(
      expandHeldScopes(["function.engineering"], REGISTRY).has("function.engineering-legacy"),
    ).toBe(false);
  });

  it("expands nothing for a scope the registry does not know", () => {
    expect([...expandHeldScopes(["function.enginering"], REGISTRY)]).toEqual([]);
  });

  it("expands identically whatever order the held scopes arrive in", () => {
    expect([...expandHeldScopes(["function.engineering.frontend", "core"], REGISTRY)]).toEqual([
      ...expandHeldScopes(["core", "function.engineering.frontend"], REGISTRY),
    ]);
  });
});

/**
 * The suggestion in isolation, against a registry holding two scopes a typo could plausibly mean.
 * The fixture catalog cannot express that, and which of several near candidates is proposed is
 * exactly the part worth pinning.
 */
describe("unknown-scope suggestions", () => {
  const REGISTRY = [
    { name: "core", description: "The universal floor" },
    { name: "function.engineering", description: "Engineering" },
    { name: "function.engineering-legacy", description: "A sibling, not a child" },
  ];

  /** A config holding `scopes` and nothing else, as resolution sees it. */
  function held(scopes: readonly string[]): ProjectConfig {
    return {
      version: 1,
      origin: {
        file: "ambit.yml",
        scopeLines: new Map(),
        skillLines: new Map(),
        mcpLines: new Map(),
      },
      harnesses: ["claude"],
      scopes,
      catalogs: [],
      skills: [],
      mcps: [],
    };
  }

  /** The error a held scope list is rejected with. */
  function rejection(scopes: readonly string[]): AmbitError {
    try {
      assertScopesRegistered(held(scopes), REGISTRY);
    } catch (error) {
      if (!(error instanceof AmbitError)) throw error;
      return error;
    }
    throw new Error("expected the held scopes to be rejected");
  }

  it("accepts every registered scope, and says nothing about them", () => {
    expect(() => assertScopesRegistered(held(["core", "function.engineering"]), REGISTRY)).not.toThrow();
  });

  it("proposes the closest of several plausible candidates", () => {
    expect(rejection(["function.engineerng"]).format()).toContain('did you mean "function.engineering"?');
  });

  it("degrades to naming the file when the config gave no line", () => {
    expect(rejection(["nope"]).format()).toContain("(ambit.yml)");
  });

  it("proposes nothing for a name no registered scope resembles", () => {
    expect(rejection(["marmalade"]).format()).not.toContain("did you mean");
  });
});

describe("selection by scope", () => {
  it("selects only what a held scope's subtree declares — nothing is implicit", async () => {
    const engineering = await bundle(["function.engineering"]);

    expect(engineering.skills.map((skill) => skill.name)).toEqual([
      FRONTEND_SKILL,
      ENGINEERING_SKILL,
    ]);
    expect(engineering.skills.map((skill) => skill.name)).not.toContain(CORE_SKILL);
  });

  it("selects the union when both scopes are held", async () => {
    const both = await bundle(["core", "function.engineering"]);

    expect(both.skills.map((skill) => skill.name)).toEqual([
      CORE_SKILL,
      FRONTEND_SKILL,
      ENGINEERING_SKILL,
    ]);
  });

  it("does not cross into another branch of the tree", async () => {
    for (const scopes of [["function.engineering"], ["core", "function.engineering"]]) {
      const resolved = await bundle(scopes);
      expect(resolved.skills.map((skill) => skill.name)).not.toContain(PROJECT_SKILL);
    }
  });

  it("does not reach up from a nested scope to its parent, nor to core", async () => {
    const frontend = await bundle(["function.engineering.frontend"]);

    expect(frontend.skills.map((skill) => skill.name)).toEqual([FRONTEND_SKILL]);
    expect(frontend.mcps).toEqual([]);
  });

  it("yields an empty bundle for an empty scope list", async () => {
    const empty = await bundle([]);

    expect(empty).toEqual({
      scopes: [],
      skills: [],
      mcps: [],
      env: [],
      reasons: { skills: new Map(), mcps: new Map() },
    });
  });

  it("selects an MCP server by its own scopes", async () => {
    expect((await bundle(["function.engineering"])).mcps.map((mcp) => mcp.name)).toEqual(["scoped"]);
    expect((await bundle(["core"])).mcps).toEqual([]);
  });

  it("unions env across the whole subtree it selected", async () => {
    // ACME_FIGMA_TOKEN comes from the nested frontend skill, SCOPED_API_KEY from the server the
    // parent scope selects, so one held scope must produce both.
    const wide = await bundle(["function.engineering"]);

    expect(wide.env).toEqual(["ACME_FIGMA_TOKEN", "SCOPED_API_KEY"]);
  });

  it("deduplicates and sorts the held scopes it reports", async () => {
    const repeated = await bundle(["function.engineering", "core", "function.engineering"]);

    expect(repeated.scopes).toEqual(["core", "function.engineering"]);
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
    const project = await bundle(["project.acme"]);

    expect(project.skills.map((skill) => skill.name)).toEqual([CORE_SKILL, PROJECT_SKILL]);
    expect(project.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
  });

  it("unions env over what the closure added, not only what scope selected", async () => {
    // FIXTURE_API_KEY belongs to the server only `requires` can reach, so a bundle that lists the
    // server without its credential would send `doctor` looking at the wrong thing.
    expect((await bundle(["project.acme"])).env).toEqual(["FIXTURE_API_KEY"]);
  });

  it("follows a requirement of a requirement, to fixpoint", async () => {
    await writeSkill("acme/chain/use-a", ["scopes: [core]", "requires: [acme.chain.use-b]"]);
    await writeSkill("acme/chain/use-b", ["requires: [acme.chain.use-c]"]);
    await writeSkill("acme/chain/use-c", []);

    expect((await bundle(["core"])).skills.map((skill) => skill.name)).toEqual([
      "acme.chain.use-a",
      "acme.chain.use-b",
      "acme.chain.use-c",
      CORE_SKILL,
    ]);
  });

  it("treats a requirement two skills share as a diamond, not a cycle", async () => {
    await writeSkill("acme/diamond/use-left", [
      "scopes: [core]",
      "requires: [acme.diamond.use-shared]",
    ]);
    await writeSkill("acme/diamond/use-right", [
      "scopes: [core]",
      "requires: [acme.diamond.use-shared]",
    ]);
    await writeSkill("acme/diamond/use-shared", []);

    const resolved = await bundle(["core"]);

    expect(
      resolved.skills.map((skill) => skill.name).filter((name) => name.startsWith("acme.diamond.")),
    ).toEqual(["acme.diamond.use-left", "acme.diamond.use-right", "acme.diamond.use-shared"]);
  });

  it("selects a required skill exactly once, however many skills require it", async () => {
    await writeSkill("acme/twice/use-left", ["scopes: [core]", "requires: [mcp.fixture]"]);
    await writeSkill("acme/twice/use-right", ["scopes: [core]", "requires: [mcp.fixture]"]);

    expect((await bundle(["core"])).mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
  });

  it("leaves a broken skill nobody selected alone, so one bad entry blocks no one", async () => {
    // Spec §4's validation split: `resolve` hard-validates the selected closure only. This skill
    // declares no scope, so nothing reaches it and its dangling requirement is `validate`'s
    // business (A23), not this bundle's.
    await writeSkill("acme/broken/use-unselected", ["requires: [acme.absent.use-nothing]"]);

    const result = await cli("resolve");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
  });
});

describe("unresolvable requirements", () => {
  it("exits 3 naming the requirer, the missing skill, and the file the edge is in", async () => {
    await writeSkill("acme/broken/use-dangling", [
      "scopes: [core]",
      "requires: [acme.absent.use-nothing]",
    ]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      'unresolvable requirement "acme.absent.use-nothing" (skills/acme/broken/use-dangling/SKILL.md)',
    );
    expect(result.stderr).toContain(
      'acme.broken.use-dangling requires a skill named "acme.absent.use-nothing"',
    );
  });

  it("names the MCP entity, not the prefixed requirement, for an `mcp.` target", async () => {
    await writeSkill("acme/broken/use-dangling-mcp", ["scopes: [core]", "requires: [mcp.absent]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('unresolvable requirement "mcp.absent"');
    expect(result.stderr).toContain('requires an MCP entity named "absent"');
    expect(result.stderr).toContain("mcps/");
  });
});

describe("requirement cycles", () => {
  it("exits 3 printing the whole path, not just the fact of a cycle", async () => {
    await writeSkill("acme/cycle/use-a", ["scopes: [core]", "requires: [acme.cycle.use-b]"]);
    await writeSkill("acme/cycle/use-b", ["requires: [acme.cycle.use-c]"]);
    await writeSkill("acme/cycle/use-c", ["requires: [acme.cycle.use-a]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("requirement cycle");
    expect(result.stderr).toContain(
      "acme.cycle.use-a → acme.cycle.use-b → acme.cycle.use-c → acme.cycle.use-a",
    );
    expect(result.stderr).toContain("skills/acme/cycle/use-a/SKILL.md");
    expect(result.stderr).toContain("break the cycle by removing one `requires` edge");
  });

  it("reports a skill that requires itself as the one-step cycle it is", async () => {
    await writeSkill("acme/cycle/use-self", ["scopes: [core]", "requires: [acme.cycle.use-self]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("acme.cycle.use-self → acme.cycle.use-self");
  });

  it("reports a cycle reached only through a requirement, not just one held directly", async () => {
    await writeSkill("acme/cycle/use-entry", ["scopes: [core]", "requires: [acme.cycle.use-b]"]);
    await writeSkill("acme/cycle/use-b", ["requires: [acme.cycle.use-c]"]);
    await writeSkill("acme/cycle/use-c", ["requires: [acme.cycle.use-b]"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain("acme.cycle.use-b → acme.cycle.use-c → acme.cycle.use-b");
  });

  it("names the same cycle whatever order a `requires` list is written in", async () => {
    await writeSkill("acme/cycle/use-a", [
      "scopes: [core]",
      "requires: [acme.cycle.use-b, acme.cycle.use-c]",
    ]);
    await writeSkill("acme/cycle/use-b", ["requires: [acme.cycle.use-a]"]);
    await writeSkill("acme/cycle/use-c", ["requires: [acme.cycle.use-a]"]);
    const first = await cli("resolve");

    await writeSkill("acme/cycle/use-a", [
      "scopes: [core]",
      "requires: [acme.cycle.use-c, acme.cycle.use-b]",
    ]);
    const second = await cli("resolve");

    expect(first.stderr).toContain("acme.cycle.use-a → acme.cycle.use-b → acme.cycle.use-a");
    expect(second.stderr).toBe(first.stderr);
  });
});

/**
 * Spec §4.8: a project can name a skill or a server outright, and it is selected whatever its
 * scopes — asking for something by name is already the decision scope selection exists to make.
 *
 * The `source` form points at a directory that is deliberately *not* a catalog, since that is the
 * case the form exists for: a plain skills repo nobody annotated.
 */
describe("explicit skills and inline servers", () => {
  /** `writeProfile` puts the first `extra` line here, after the four-line preamble and `scopes`. */
  const FIRST_EXTRA_LINE = 6;

  const SOURCE = "path:../extra";
  const READWISE = "readwise-cli";

  it("selects a bare name from a catalog, whatever scopes it declares", async () => {
    const explicit = await bundle([], ["skills:", `  - ${ENGINEERING_SKILL}`]);

    expect(explicit.skills.map((skill) => skill.name)).toEqual([ENGINEERING_SKILL]);
    // Nothing was held, so the skill's own `function.engineering` scope did none of the work.
    expect(explicit.scopes).toEqual([]);
  });

  it("closes an explicitly named skill over its own `requires`", async () => {
    const explicit = await bundle([], ["skills:", `  - ${PROJECT_SKILL}`]);

    expect(explicit.skills.map((skill) => skill.name)).toEqual([CORE_SKILL, PROJECT_SKILL]);
    expect(explicit.mcps.map((mcp) => mcp.name)).toEqual(["fixture"]);
    expect(explicit.env).toEqual(["FIXTURE_API_KEY"]);
  });

  it("selects a skill once when a held scope also reaches it", async () => {
    const both = await bundle(["function.engineering"], ["skills:", `  - ${ENGINEERING_SKILL}`]);

    expect(both.skills.map((skill) => skill.name)).toEqual([FRONTEND_SKILL, ENGINEERING_SKILL]);
  });

  it("loads a skill from its own source, by the name→path convention", async () => {
    await writeSourceSkill(`skills/${READWISE}`, READWISE, ["env: [READWISE_TOKEN]"]);

    const explicit = await bundle([], ["skills:", `  - name: ${READWISE}`, `    source: ${SOURCE}`]);

    expect(explicit.skills).toHaveLength(1);
    expect(explicit.skills[0]).toMatchObject({
      name: READWISE,
      path: `skills/${READWISE}`,
      // No catalog provided it, so the origin column names the source it came from instead.
      catalog: SOURCE,
    });
    expect(explicit.env).toEqual(["READWISE_TOKEN"]);
  });

  it("takes a `path` that overrides the convention, even outside `skills/`", async () => {
    await writeSourceSkill("bundled/tool", "custom-tool");

    const explicit = await bundle(
      [],
      ["skills:", "  - name: custom-tool", `    source: ${SOURCE}`, "    path: bundled/tool"],
    );

    expect(explicit.skills.map((skill) => skill.path)).toEqual(["bundled/tool"]);
  });

  it("closes a source skill over `requires` against the catalogs too", async () => {
    await writeSourceSkill(`skills/${READWISE}`, READWISE, [`requires: [${CORE_SKILL}]`]);

    const explicit = await bundle([], ["skills:", `  - name: ${READWISE}`, `    source: ${SOURCE}`]);

    expect(explicit.skills.map((skill) => skill.name)).toEqual([CORE_SKILL, READWISE]);
  });

  it("selects an inline server whatever scopes it declares", async () => {
    const explicit = await bundle(
      [],
      [
        "mcps:",
        "  - name: custom",
        "    transport:",
        "      stdio:",
        "        command: custom-mcp",
        "    env: [CUSTOM_TOKEN]",
      ],
    );

    expect(explicit.mcps).toHaveLength(1);
    expect(explicit.mcps[0]).toMatchObject({ name: "custom", catalog: "ambit.yml" });
    expect(explicit.env).toEqual(["CUSTOM_TOKEN"]);
  });

  it("lets a catalog skill's `requires` reach an inline server", async () => {
    // The point of folding config's declarations into the merged catalog: one namespace, so a
    // requirement does not care which surface defined its target.
    await writeSkill("acme/inline/use-inline", ["scopes: [core]", "requires: [mcp.custom]"]);

    const explicit = await bundle(
      ["core"],
      ["mcps:", "  - name: custom", "    transport:", "      stdio:", "        command: custom-mcp"],
    );

    expect(explicit.mcps.map((mcp) => mcp.name)).toEqual(["custom"]);
  });

  it("exits 3 for a bare name no catalog provides, naming it and its line", async () => {
    await writeProfile([], ["skills:", "  - acme.absent.use-nothing"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `unknown skill "acme.absent.use-nothing" (ambit.yml line ${FIRST_EXTRA_LINE + 1})`,
    );
    expect(result.stderr).toContain("no catalog provides a skill with that name");
    expect(result.stderr).toContain("give the entry its own `source`");
  });

  it("reports the same unknown name however the config orders the list", async () => {
    await writeProfile([], ["skills:", "  - zeta.absent", "  - alpha.absent"]);
    const first = await cli("resolve");

    await writeProfile([], ["skills:", "  - alpha.absent", "  - zeta.absent"]);
    const second = await cli("resolve");

    expect(first.stderr).toContain('unknown skill "alpha.absent"');
    expect(second.stderr).toContain('unknown skill "alpha.absent"');
  });

  it("exits 3 rather than letting a source shadow a catalog skill of the same name", async () => {
    await writeSourceSkill("skills/acme/commons/use-company-context", CORE_SKILL);
    await writeProfile([], ["skills:", `  - name: ${CORE_SKILL}`, `    source: ${SOURCE}`]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `skill "${CORE_SKILL}" is also provided by catalog "${CATALOG_NAME}"`,
    );
    expect(result.stderr).toContain("drop `source` to take the catalog's copy");
  });

  it("exits 3 rather than letting an inline server shadow a catalog one", async () => {
    await writeProfile(
      [],
      ["mcps:", "  - name: fixture", "    transport:", "      stdio:", "        command: mine"],
    );

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `MCP server "fixture" is also provided by catalog "${CATALOG_NAME}"`,
    );
  });

  it("exits 2 when the source holds no such skill directory", async () => {
    await writeSourceSkill("skills/something-else", "something-else");
    await writeProfile([], ["skills:", `  - name: ${READWISE}`, `    source: ${SOURCE}`]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`skill "${READWISE}" is not in its source (ambit.yml line 7)`);
    expect(result.stderr).toContain(`has no skills/${READWISE}/SKILL.md`);
    expect(result.stderr).toContain("add `path:` naming the skill's directory");
  });

  it("exits 2 for a source in no recognized format", async () => {
    await writeProfile([], ["skills:", `  - name: ${READWISE}`, "    source: ../extra"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(
      `skill "${READWISE}" has an unrecognized source (ambit.yml line 7)`,
    );
  });

  it("exits 2 when the frontmatter name disagrees with the name it is declared under", async () => {
    await writeSourceSkill(`skills/${READWISE}`, "something-else");
    await writeProfile([], ["skills:", `  - name: ${READWISE}`, `    source: ${SOURCE}`]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(
      'skill name "something-else" does not match the name it is declared under',
    );
    expect(result.stderr).toContain(`ambit.yml lists it as "${READWISE}"`);
    // Which source the offending SKILL.md is in, since its path is relative to one.
    expect(result.stderr).toContain(`in skill source "${SOURCE}"`);
  });

  it("exits 2 for two `skills` entries naming the same skill", async () => {
    await writeProfile([], ["skills:", `  - ${CORE_SKILL}`, `  - ${CORE_SKILL}`]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`duplicate skills entry "${CORE_SKILL}" (ambit.yml line 8)`);
    expect(result.stderr).toContain("first declared on line 7");
  });
});

/**
 * Spec §6: every selected item carries the reason it is in the bundle — one of the three routes
 * resolution offers, and only one, so a reader gets an answer rather than a list of possibilities.
 *
 * The reason is asserted on the bundle rather than only through `--explain`, because the lock
 * records it too (spec §3.5) and both surfaces have to agree by construction.
 */
describe("selection reasons", () => {
  it("names the scope a skill declares, and the held scope that reached it", async () => {
    const wide = await bundle(["function.engineering"]);

    expect(wide.reasons.skills.get(ENGINEERING_SKILL)).toEqual({
      kind: "scope",
      scope: "function.engineering",
      held: "function.engineering",
    });
    // Selected through the subtree rule, so the scope it declares is not one the config lists.
    expect(wide.reasons.skills.get(FRONTEND_SKILL)).toEqual({
      kind: "scope",
      scope: "function.engineering.frontend",
      held: "function.engineering",
    });
    expect(wide.reasons.mcps.get("scoped")).toEqual({
      kind: "scope",
      scope: "function.engineering",
      held: "function.engineering",
    });
  });

  it("names the requirer of a skill and a server no held scope selected", async () => {
    const project = await bundle(["project.acme"]);

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
    await writeSkill("acme/twice/use-left", ["scopes: [core]", "requires: [mcp.fixture]"]);
    await writeSkill("acme/twice/use-right", ["scopes: [core]", "requires: [mcp.fixture]"]);

    expect((await bundle(["core"])).reasons.mcps.get("fixture")).toEqual({
      kind: "required-by",
      requirer: "acme.twice.use-left",
    });
  });

  it("reports an explicit entry as explicit even when a held scope also reaches it", async () => {
    const both = await bundle(["function.engineering"], ["skills:", `  - ${ENGINEERING_SKILL}`]);

    expect(both.reasons.skills.get(ENGINEERING_SKILL)).toEqual({ kind: "explicit" });
    // The scope route is still the only thing that reached the nested skill.
    expect(both.reasons.skills.get(FRONTEND_SKILL)).toMatchObject({ kind: "scope" });
  });

  it("reports an inline server as explicit", async () => {
    const inline = await bundle(
      [],
      ["mcps:", "  - name: custom", "    transport:", "      stdio:", "        command: custom-mcp"],
    );

    expect(inline.reasons.mcps.get("custom")).toEqual({ kind: "explicit" });
  });

  it("explains every item it selected, leaving nothing unaccounted for", async () => {
    const wide = await bundle(["core", "function.engineering", "project.acme"]);

    expect([...wide.reasons.skills.keys()]).toEqual(wide.skills.map((skill) => skill.name));
    expect([...wide.reasons.mcps.keys()]).toEqual(wide.mcps.map((mcp) => mcp.name));
  });
});

describe("ambit resolve --explain", () => {
  it("adds a reason column to skills and mcps, and leaves scopes and env alone", async () => {
    await writeProfile(["core", "function.engineering"]);

    const result = await cli("resolve", "--explain");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "scopes (2)",
        "  core",
        "  function.engineering",
        "",
        "skills (3)",
        `  ${CORE_SKILL.padEnd(FRONTEND_SKILL.length)}  ${CATALOG_NAME}  scope:core`,
        `  ${FRONTEND_SKILL}  ${CATALOG_NAME}  scope:function.engineering.frontend`,
        `  ${ENGINEERING_SKILL.padEnd(FRONTEND_SKILL.length)}  ${CATALOG_NAME}  scope:function.engineering`,
        "",
        "mcps (1)",
        `  scoped  ${CATALOG_NAME}  scope:function.engineering`,
        "",
        "env (2)",
        "  ACME_FIGMA_TOKEN",
        "  SCOPED_API_KEY",
      ].join("\n"),
    );
  });

  it("adds a reason to every JSON record, which plain `--json` omits", async () => {
    await writeProfile(["project.acme"]);

    const explained = JSON.parse((await cli("resolve", "--explain", "--json")).stdout) as {
      skills: Record<string, { reason?: string }>;
      mcps: Record<string, { reason?: string }>;
    };

    expect(explained.skills[CORE_SKILL]?.reason).toBe(`required-by:${PROJECT_SKILL}`);
    expect(explained.skills[PROJECT_SKILL]?.reason).toBe("scope:project.acme");
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
    await writeProfile(["core"]);

    const result = await cli("why", CORE_SKILL);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [`skill ${CORE_SKILL}`, "", "chain (1)", `  ${CORE_SKILL}  skill  scope:core`].join("\n"),
    );
  });

  it("walks back through `requires` to the held scope that started it", async () => {
    await writeProfile(["project.acme"]);

    const result = await cli("why", CORE_SKILL);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        `skill ${CORE_SKILL}`,
        "",
        "chain (2)",
        `  ${PROJECT_SKILL.padEnd(CORE_SKILL.length)}  skill  scope:project.acme`,
        `  ${CORE_SKILL}  skill  required-by:${PROJECT_SKILL}`,
      ].join("\n"),
    );
  });

  it("names the held scope as well when the subtree rule did the reaching", async () => {
    await writeProfile(["function.engineering"]);

    const result = await cli("why", FRONTEND_SKILL);

    expect(result.stdout).toContain(
      "scope:function.engineering.frontend (held function.engineering)",
    );
  });

  it("finds a server by its bare name and by the `mcp.` prefix `requires` uses", async () => {
    await writeProfile(["project.acme"]);

    const bare = await cli("why", "fixture");
    const prefixed = await cli("why", "mcp.fixture");

    expect(bare.code, bare.stderr).toBe(ExitCode.Success);
    expect(bare.stdout).toContain("mcp fixture");
    expect(bare.stdout).toContain(
      `${"fixture".padEnd(PROJECT_SKILL.length)}  mcp    required-by:${PROJECT_SKILL}`,
    );
    expect(prefixed.stdout).toBe(bare.stdout);
  });

  it("prefers the skill for a bare name both namespaces hold, and the prefix names the server", async () => {
    await writeMcp(CORE_SKILL, ["scopes: [core]"]);
    await writeProfile(["core"]);

    expect((await cli("why", CORE_SKILL)).stdout).toContain(`skill ${CORE_SKILL}`);
    expect((await cli("why", `mcp.${CORE_SKILL}`)).stdout).toContain(`mcp ${CORE_SKILL}`);
  });

  it("reports an explicit entry as the whole chain, since nothing precedes it", async () => {
    await writeProfile([], ["skills:", `  - ${ENGINEERING_SKILL}`]);

    const result = await cli("why", ENGINEERING_SKILL);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(`${ENGINEERING_SKILL}  skill  explicit`);
  });

  it("emits the chain, the item, and its reason as JSON", async () => {
    await writeProfile(["project.acme"]);

    const result = await cli("why", "mcp.fixture", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      chain: [
        {
          held: "project.acme",
          kind: "skill",
          name: PROJECT_SKILL,
          reason: "scope:project.acme",
        },
        { kind: "mcp", name: "fixture", reason: `required-by:${PROJECT_SKILL}` },
      ],
      kind: "mcp",
      name: "fixture",
      reason: `required-by:${PROJECT_SKILL}`,
    });
  });

  it("exits 3 for a skill a catalog provides but nothing selects, naming the scope that would", async () => {
    await writeProfile(["core"]);

    const result = await cli("why", PROJECT_SKILL);

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`skill "${PROJECT_SKILL}" is not in the bundle`);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" provides it`);
    expect(result.stderr).toContain("hold one of its scopes (project.acme)");
  });

  it("points at `requires` for an unselected server, which no `skills` entry can reach", async () => {
    await writeProfile(["core"]);

    const result = await cli("why", "mcp.fixture");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('MCP server "fixture" is not in the bundle');
    expect(result.stderr).toContain("have a selected skill `require` mcp.fixture");
  });

  it("exits 3 for a name nothing provides, and says where to look", async () => {
    const result = await cli("why", "acme.absent.use-nothing");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('unknown skill or MCP server "acme.absent.use-nothing"');
    expect(result.stderr).toContain("run `ambit catalog` to see what is available");
  });
});

/**
 * Spec §4.6: a held scope the merged registry does not know is exit 3, not a silent miss. The
 * line assertions are exact rather than loose, since the whole point of the message is that it
 * sends a reader to the offending line of their own config.
 */
describe("unknown held scopes", () => {
  /** `writeProfile` puts the sequence items on lines 6 and up, after the four-line preamble. */
  const FIRST_SCOPE_LINE = 6;

  it("exits 3, names the scope and its line, and suggests the nearest registered one", async () => {
    await writeProfile(["core", "function.enginering"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(
      `unknown scope "function.enginering" (ambit.yml line ${FIRST_SCOPE_LINE + 1})`,
    );
    expect(result.stderr).toContain("not found in the merged registry");
    expect(result.stderr).toContain('did you mean "function.engineering"?');
  });

  it("says how to register a scope nothing is close to, rather than guessing", async () => {
    await writeProfile(["marmalade"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`unknown scope "marmalade" (ambit.yml line ${FIRST_SCOPE_LINE})`);
    expect(result.stderr).toContain("scopes.yml");
    expect(result.stderr).not.toContain("did you mean");
  });

  it("rejects a parent nobody registered, whatever its children are called", async () => {
    // `function.engineering` is registered; bare `function` is not, so holding it is a typo —
    // the registry decides what may be held, not the shape of the dotted names.
    await writeProfile(["function"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('unknown scope "function"');
  });

  it("reports the same offender however the config orders the list", async () => {
    await writeProfile(["zeta.unknown", "alpha.unknown"]);
    const first = await cli("resolve");

    await writeProfile(["alpha.unknown", "zeta.unknown"]);
    const second = await cli("resolve");

    expect(first.stderr).toContain('unknown scope "alpha.unknown"');
    expect(second.stderr).toContain('unknown scope "alpha.unknown"');
  });

  it("selects nothing before failing, so install cannot half-run", async () => {
    await expect(bundle(["core", "not.a.scope"])).rejects.toMatchObject({
      code: ExitCode.Resolution,
    });
  });
});

describe("ambit resolve", () => {
  it("lists the bundle as text", async () => {
    await writeProfile(["core", "function.engineering"]);

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "scopes (2)",
        "  core",
        "  function.engineering",
        "",
        // The catalog column is padded out to the widest name, so it lines up down the section.
        "skills (3)",
        `  ${CORE_SKILL.padEnd(FRONTEND_SKILL.length)}  ${CATALOG_NAME}`,
        `  ${FRONTEND_SKILL}  ${CATALOG_NAME}`,
        `  ${ENGINEERING_SKILL.padEnd(FRONTEND_SKILL.length)}  ${CATALOG_NAME}`,
        "",
        "mcps (1)",
        `  scoped  ${CATALOG_NAME}`,
        "",
        "env (2)",
        "  ACME_FIGMA_TOKEN",
        "  SCOPED_API_KEY",
      ].join("\n"),
    );
  });

  it("says so for an empty bundle rather than printing nothing", async () => {
    await writeProfile([]);

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      ["scopes (0)", "  (none)", "", "skills (0)", "  (none)", "", "mcps (0)", "  (none)", "", "env (0)", "  (none)"].join(
        "\n",
      ),
    );
  });

  it("emits byte-identical JSON on a second run", async () => {
    await writeProfile(["core", "function.engineering"]);

    const first = await cli("resolve", "--json");
    const second = await cli("resolve", "--json");

    expect(second.stdout).toBe(first.stdout);
  });

  it("carries no machine-specific paths into JSON output", async () => {
    const result = await cli("resolve", "--json");

    expect(result.stdout).not.toContain(root);
  });

  it("emits byte-identical JSON on a second run under `--explain` too", async () => {
    await writeProfile(["core", "function.engineering", "project.acme"]);

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
    await writeFile(path.join(catalogDir, "scopes.yml"), "scopes:\n  core: {}\n", "utf8");

    const result = await cli("resolve");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("missing required key");
  });
});

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
import { loadCatalogs, mergeCatalogs } from "../src/catalog.js";
import type { ProjectConfig } from "../src/config.js";
import { loadProjectConfig } from "../src/config.js";
import { AmbitError, ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";
import type { Bundle } from "../src/resolve.js";
import { assertScopesRegistered, expandHeldScopes, resolveBundle } from "../src/resolve.js";

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

/** Points the project at the fixture catalog and gives it `scopes`. */
async function writeProfile(scopes: readonly string[]): Promise<void> {
  const list = scopes.length === 0 ? "[]" : `\n${scopes.map((scope) => `  - ${scope}`).join("\n")}`;
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    `version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
scopes: ${list}
`,
    "utf8",
  );
}

/** Resolves the project in-process, skipping the CLI. */
async function bundle(scopes: readonly string[]): Promise<Bundle> {
  await writeProfile(scopes);
  const config = await loadProjectConfig(projectDir);
  return resolveBundle(config, mergeCatalogs(await loadCatalogs(config, projectDir)));
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
      origin: { file: "ambit.yml", scopeLines: new Map() },
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

    expect(empty).toEqual({ scopes: [], skills: [], mcps: [], env: [] });
  });

  it("closes over nothing: a required skill and MCP stay out", async () => {
    // acme.projects.use-acme-brief requires the core skill and mcp.fixture; the closure is A09.
    const project = await bundle(["project.acme"]);

    expect(project.skills.map((skill) => skill.name)).toEqual([PROJECT_SKILL]);
    expect(project.mcps).toEqual([]);
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

  it("reports `--explain` as unimplemented instead of printing an unannotated bundle", async () => {
    const result = await cli("resolve", "--explain");

    expect(result.code).toBe(ExitCode.Internal);
    expect(result.stderr).toContain("`--explain` is not implemented yet");
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

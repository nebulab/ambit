/**
 * Resolution by exact scope match (spec §4.6–§4.7), and the `ambit resolve` output built on it.
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
import { loadProjectConfig } from "../src/config.js";
import { ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";
import type { Bundle } from "../src/resolve.js";
import { resolveBundle } from "../src/resolve.js";

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

describe("selection by exact scope", () => {
  it("selects only what declares a held scope — nothing is implicit", async () => {
    const engineering = await bundle(["function.engineering"]);

    expect(engineering.skills.map((skill) => skill.name)).toEqual([ENGINEERING_SKILL]);
    expect(engineering.skills.map((skill) => skill.name)).not.toContain(CORE_SKILL);
  });

  it("selects the union when both scopes are held", async () => {
    const both = await bundle(["core", "function.engineering"]);

    expect(both.skills.map((skill) => skill.name)).toEqual([CORE_SKILL, ENGINEERING_SKILL]);
  });

  it("does not descend into a nested scope", async () => {
    for (const scopes of [["function.engineering"], ["core", "function.engineering"]]) {
      const resolved = await bundle(scopes);
      expect(resolved.skills.map((skill) => skill.name)).not.toContain(FRONTEND_SKILL);
      expect(resolved.skills.map((skill) => skill.name)).not.toContain(PROJECT_SKILL);
    }
  });

  it("does not reach up from a nested scope to its parent", async () => {
    const frontend = await bundle(["function.engineering.frontend"]);

    expect(frontend.skills.map((skill) => skill.name)).toEqual([FRONTEND_SKILL]);
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

  it("unions env across the selected skills and servers", async () => {
    const wide = await bundle(["function.engineering", "function.engineering.frontend"]);

    expect(wide.env).toEqual(["ACME_FIGMA_TOKEN", "SCOPED_API_KEY"]);
  });

  it("deduplicates and sorts the held scopes it reports", async () => {
    const repeated = await bundle(["function.engineering", "core", "function.engineering"]);

    expect(repeated.scopes).toEqual(["core", "function.engineering"]);
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
        "skills (2)",
        `  ${CORE_SKILL}  ${CATALOG_NAME}`,
        `  ${ENGINEERING_SKILL}  ${CATALOG_NAME}`,
        "",
        "mcps (1)",
        `  scoped  ${CATALOG_NAME}`,
        "",
        "env (1)",
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

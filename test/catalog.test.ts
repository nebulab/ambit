/**
 * Catalog parsing from a `path:` source (spec §3.2–§3.4), and the `ambit catalog` dump built on
 * it.
 *
 * Every case runs against the fixture catalog, mutated in place for the malformed ones, so the
 * subject is the same tree the rest of the suite resolves against.
 */
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import { loadCatalogs, mergeCatalogs, parseCatalogDirectory } from "../src/catalog.js";
import { loadProjectConfig } from "../src/config.js";
import { AmbitError, ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";
import type { SourceContext } from "../src/sources.js";

const CATALOG_NAME = "company";
const CODE_REVIEW = "skills/acme/engineering/use-code-review/SKILL.md";

let root: string;
let catalogDir: string;
let projectDir: string;

/** What source resolution reads from outside its arguments; every source here is a local path. */
function context(): SourceContext {
  return { projectDir, env: process.env };
}

/** Rewrites `ambit.yml` for the project under test. */
async function writeConfig(body: string): Promise<void> {
  await writeFile(path.join(projectDir, "ambit.yml"), body, "utf8");
}

/** Replaces one file inside the fixture catalog. */
async function writeCatalogFile(relative: string, body: string): Promise<void> {
  const target = path.join(catalogDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, "utf8");
}

/** Parses the fixture catalog, asserting it was rejected as a config error (exit 2). */
async function rejection(): Promise<AmbitError> {
  try {
    await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);
  } catch (error) {
    if (!(error instanceof AmbitError)) throw error;
    expect(error.code, `expected exit ${ExitCode.Config}: ${error.format()}`).toBe(ExitCode.Config);
    return error;
  }
  throw new Error("expected the catalog to be rejected");
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeConfig(`version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../catalog
`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("catalog parsing", () => {
  it("reads the registry, every skill, and every MCP entity", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    expect(catalog.name).toBe(CATALOG_NAME);
    expect(catalog.root).toBe(catalogDir);
    expect(catalog.scopes).toEqual([
      { name: "core", description: "The universal floor — context everyone needs" },
      { name: "function.engineering", description: "Building and shipping software" },
      {
        name: "function.engineering.frontend",
        description: "Browser-side work: components, styling, accessibility",
      },
      { name: "project.acme", description: "The Acme engagement" },
    ]);
    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      "acme.commons.use-company-context",
      "acme.engineering.frontend.use-design-tokens",
      "acme.engineering.use-code-review",
      "acme.projects.use-acme-brief",
    ]);
    expect(catalog.mcps.map((mcp) => mcp.name)).toEqual(["fixture", "scoped"]);
  });

  it("derives each skill's name and path from its directory", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);
    const nested = catalog.skills.find(
      (skill) => skill.name === "acme.engineering.frontend.use-design-tokens",
    );

    expect(nested).toMatchObject({
      path: "skills/acme/engineering/frontend/use-design-tokens",
      scopes: ["function.engineering.frontend"],
      requires: [],
      env: ["ACME_FIGMA_TOKEN"],
    });
    expect(nested?.description).toBeTruthy();
  });

  it("carries `requires` through, MCP prefixes included", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    expect(
      catalog.skills.find((skill) => skill.name === "acme.projects.use-acme-brief")?.requires,
    ).toEqual(["acme.commons.use-company-context", "mcp.fixture"]);
  });

  it("parses both transport kinds", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    expect(catalog.mcps.find((mcp) => mcp.name === "fixture")?.transport).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@acme/fixture-mcp"],
    });
    expect(catalog.mcps.find((mcp) => mcp.name === "scoped")?.transport).toEqual({
      kind: "http",
      url: "https://mcp.invalid/fixture",
      headers: { Authorization: "Bearer ${SCOPED_API_KEY}" },
    });
  });

  it("keeps frontmatter keys it does not know", async () => {
    // The frontmatter is the harness's; ambit only adds keys to it (spec §3.2).
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: acme.engineering.use-code-review
description: x
scopes: [function.engineering]
allowed-tools: [Read, Grep]
---
`,
    );

    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);
    expect(catalog.skills.map((skill) => skill.name)).toContain(
      "acme.engineering.use-code-review",
    );
  });

  it("parses identically whatever order the filesystem reports", async () => {
    const first = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    // Rebuilding into a fresh directory in a different write order is the closest a test can get
    // to a differently-ordered readdir.
    const other = path.join(root, "reordered");
    await cp(catalogDir, other, { recursive: true });
    const second = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", other);

    expect({ ...second, root: catalogDir }).toEqual(first);
  });
});

describe("catalog parsing failures", () => {
  it("rejects a skill whose frontmatter name disagrees with its path", async () => {
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: acme.engineering.wrong
description: x
---
`,
    );

    const error = await rejection();
    expect(error.message).toContain('skill name "acme.engineering.wrong" does not match its path');
    // The line is the one the reader will find `name` on in the whole document, not in the block.
    expect(error.message).toContain(`${CODE_REVIEW} line 2`);
    expect(error.detail.join("\n")).toContain('derives the name "acme.engineering.use-code-review"');
  });

  it("positions a frontmatter error at its line in the document", async () => {
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: acme.engineering.use-code-review
description: x
description: y
---
`,
    );

    expect((await rejection()).message).toBe(`duplicate key "description" (${CODE_REVIEW} line 4)`);
  });

  it("rejects a skill with no frontmatter", async () => {
    await writeCatalogFile(CODE_REVIEW, "# just a document\n");

    expect((await rejection()).message).toContain(`${CODE_REVIEW} has no frontmatter block`);
  });

  it("rejects an empty frontmatter block", async () => {
    await writeCatalogFile(CODE_REVIEW, "---\n---\nbody\n");

    expect((await rejection()).message).toContain(`${CODE_REVIEW} has an empty frontmatter block`);
  });

  it("rejects frontmatter that is not YAML", async () => {
    await writeCatalogFile(CODE_REVIEW, '---json\n{"name": "x"}\n---\n');

    expect((await rejection()).message).toContain("declares its frontmatter as \"json\"");
  });

  it("rejects an MCP entity whose name disagrees with its filename", async () => {
    await writeCatalogFile(
      "mcps/other.yml",
      `name: notother
transport:
  stdio:
    command: npx
`,
    );

    const error = await rejection();
    expect(error.message).toContain('MCP name "notother" does not match its filename');
    expect(error.detail.join("\n")).toContain('declares the name "other"');
  });

  it("rejects one MCP name defined by two files", async () => {
    await cp(path.join(catalogDir, "mcps/fixture.yml"), path.join(catalogDir, "mcps/fixture.yaml"));

    expect((await rejection()).message).toBe(
      'mcps/fixture.yaml and mcps/fixture.yml both define "fixture"',
    );
  });

  it("rejects a catalog with no scope registry", async () => {
    await rename(path.join(catalogDir, "scopes.yml"), path.join(catalogDir, "scopes.hidden"));

    expect((await rejection()).message).toBe("scopes.yml is missing");
  });

  it("requires a description for every registered scope", async () => {
    await writeCatalogFile("scopes.yml", "scopes:\n  core: {}\n");

    expect((await rejection()).message).toContain('missing required key "scopes.core.description"');
  });

  it("names the catalog an error came from", async () => {
    await writeCatalogFile(CODE_REVIEW, "# no frontmatter\n");

    expect((await rejection()).detail[0]).toBe(`in catalog "${CATALOG_NAME}" (${catalogDir})`);
  });
});

describe("catalog sources", () => {
  it("resolves a `path:` source relative to the project", async () => {
    const config = await loadProjectConfig(projectDir);
    const catalogs = await loadCatalogs(config, context());

    expect(catalogs.map((catalog) => catalog.root)).toEqual([catalogDir]);
    // A directory has no revision, so nothing pretends to pin one.
    expect(catalogs[0]?.commit).toBeUndefined();
  });

  it("rejects a source in no recognized format", async () => {
    await writeConfig(`version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: ../catalog
`);

    const result = await cli("catalog");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" has an unrecognized source`);
    expect(result.stderr).toContain("use owner/repo, a git URL, `git:<url>`, or `path:./dir`");
  });

  it("rejects a `path:` source that is not a directory", async () => {
    await writeConfig(`version: 1
catalogs:
  - name: ${CATALOG_NAME}
    source: path:../missing
`);

    const result = await cli("catalog");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" is not a directory`);
  });
});

describe("ambit catalog", () => {
  it("emits the full fixture catalog as JSON", async () => {
    const result = await cli("catalog", "--json");

    expect(result.code).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout)).toEqual({
      catalogs: [CATALOG_NAME],
      scopes: {
        core: { description: "The universal floor — context everyone needs" },
        "function.engineering": { description: "Building and shipping software" },
        "function.engineering.frontend": {
          description: "Browser-side work: components, styling, accessibility",
        },
        "project.acme": { description: "The Acme engagement" },
      },
      skills: {
        "acme.commons.use-company-context": {
          catalog: CATALOG_NAME,
          description:
            "Canonical context about Acme — what it sells, to whom, and how it works.",
          env: [],
          path: "skills/acme/commons/use-company-context",
          requires: [],
          scopes: ["core"],
        },
        "acme.engineering.frontend.use-design-tokens": {
          catalog: CATALOG_NAME,
          description: "Acme's design tokens — color, spacing, and the type scale.",
          env: ["ACME_FIGMA_TOKEN"],
          path: "skills/acme/engineering/frontend/use-design-tokens",
          requires: [],
          scopes: ["function.engineering.frontend"],
        },
        "acme.engineering.use-code-review": {
          catalog: CATALOG_NAME,
          description: "How Acme reviews code — what reviewers look for, and in what order.",
          env: [],
          path: "skills/acme/engineering/use-code-review",
          requires: [],
          scopes: ["function.engineering"],
        },
        "acme.projects.use-acme-brief": {
          catalog: CATALOG_NAME,
          description: "The Acme engagement brief — scope, contacts, and conventions.",
          env: [],
          path: "skills/acme/projects/use-acme-brief",
          requires: ["acme.commons.use-company-context", "mcp.fixture"],
          scopes: ["project.acme"],
        },
      },
      mcps: {
        fixture: {
          catalog: CATALOG_NAME,
          env: ["FIXTURE_API_KEY"],
          scopes: [],
          transport: { kind: "stdio", command: "npx", args: ["-y", "@acme/fixture-mcp"] },
        },
        scoped: {
          catalog: CATALOG_NAME,
          env: ["SCOPED_API_KEY"],
          scopes: ["function.engineering"],
          transport: {
            kind: "http",
            url: "https://mcp.invalid/fixture",
            headers: { Authorization: "Bearer ${SCOPED_API_KEY}" },
          },
        },
      },
    });
  });

  it("emits byte-identical JSON on a second run, with keys sorted", async () => {
    const first = await cli("catalog", "--json");
    const second = await cli("catalog", "--json");

    expect(second.stdout).toBe(first.stdout);
    const emitted = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(Object.keys(emitted)).toEqual([...Object.keys(emitted)].sort());
  });

  it("carries no machine-specific paths into JSON output", async () => {
    const result = await cli("catalog", "--json");

    expect(result.stdout).not.toContain(root);
  });

  it("lists scopes, skills, and MCPs as text", async () => {
    const result = await cli("catalog");

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain(`${CATALOG_NAME}  path:../catalog`);
    expect(result.stdout).toContain("core                           The universal floor");
    expect(result.stdout).toContain("acme.projects.use-acme-brief");
    expect(result.stdout).toContain("stdio: npx -y @acme/fixture-mcp");
    expect(result.stdout).toContain("http: https://mcp.invalid/fixture");
  });

  it("succeeds with nothing to dump when no catalogs are configured", async () => {
    await writeConfig("version: 1\nscopes: [core]\n");

    const result = await cli("catalog");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain("no catalogs configured");
  });

  it("exits 2 on a skill name that disagrees with its path", async () => {
    await writeCatalogFile(CODE_REVIEW, "---\nname: acme.engineering.wrong\n---\n");

    const result = await cli("catalog", "--json");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not match its path");
  });

  it("exits 2 when the project has no config", async () => {
    await rm(path.join(projectDir, "ambit.yml"));

    const result = await cli("catalog");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("no ambit config");
  });
});

describe("merging", () => {
  it("tags every item with the catalog it came from", async () => {
    const merged = mergeCatalogs(
      await loadCatalogs(await loadProjectConfig(projectDir), context()),
    );

    expect(merged.catalogs).toEqual([CATALOG_NAME]);
    for (const item of [...merged.skills, ...merged.mcps]) {
      expect(item.catalog).toBe(CATALOG_NAME);
    }
  });

  it("lets the earlier catalog win a duplicate name", async () => {
    const other = path.join(root, "other");
    await buildFixtureCatalog(other);
    const config = await loadProjectConfig(projectDir);
    const first = await loadCatalogs(config, context());
    const second = await loadCatalogs(
      { ...config, catalogs: [{ name: "personal", source: "path:../other" }] },
      context(),
    );

    const merged = mergeCatalogs([...first, ...second]);
    expect(merged.catalogs).toEqual([CATALOG_NAME, "personal"]);
    expect(new Set(merged.skills.map((skill) => skill.catalog))).toEqual(new Set([CATALOG_NAME]));
    expect(merged.skills).toHaveLength(4);
  });
});

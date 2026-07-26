/**
 * Catalog parsing from a `path:` source (spec §3.2–§3.4), and the `ambit catalog` dump built on
 * it.
 *
 * Every case runs against the fixture catalog, mutated in place for the malformed ones, so the
 * subject is the same tree the rest of the suite resolves against.
 */
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { MergedCatalog } from "../../src/model/catalog.js";
import { loadCatalogs, mergeCatalogs, parseCatalogDirectory } from "../../src/model/catalog.js";
import type { CommandHandlers, CommandRules } from "../../src/cli/commands.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { AmbitError, ExitCode } from "../../src/errors.js";
import { HANDLERS, RULES, run } from "../../src/cli/program.js";
import type { SourceContext } from "../../src/model/sources.js";

const CATALOG_NAME = "company";
const CODE_REVIEW = "skills/acme/engineering/use-code-review/SKILL.md";

/** The fixture's core skill, and the scope it declares — the pair a second catalog collides with. */
const CORE_SKILL = "acme.commons.use-company-context";
const CORE_DESCRIPTION = "The universal floor — context everyone needs";
const ENGINEERING_DESCRIPTION = "Building and shipping software";

/** A skill only the second catalog provides, so a merge has something to keep from both. */
const OWN_SKILL = "jane.use-notes";

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

/**
 * Builds a catalog beside the fixture that deliberately collides with it: the same `core` scope,
 * the same core skill, and the same `scoped` server, plus a scope and a skill of its own so the
 * merge has something to keep from both.
 *
 * @param name the catalog's directory, which is also the name config gives it.
 * @param coreDescription how it describes the shared `core` scope — identical to the fixture's
 *   unless the test is about two catalogs disagreeing.
 */
async function writeShadowingCatalog(
  name: string,
  coreDescription: string = CORE_DESCRIPTION,
): Promise<void> {
  const files: Readonly<Record<string, string>> = {
    "scopes.yml": [
      "scopes:",
      "  core:",
      `    description: ${JSON.stringify(coreDescription)}`,
      "  function.engineering:",
      `    description: ${JSON.stringify(ENGINEERING_DESCRIPTION)}`,
      "  person.jane:",
      "    description: Jane's own things",
      "",
    ].join("\n"),
    [`skills/${CORE_SKILL.replaceAll(".", "/")}/SKILL.md`]: [
      "---",
      `name: ${CORE_SKILL}`,
      `description: ${name}'s copy of the core skill.`,
      "ambit:",
      "  scopes: [core]",
      "---",
      "",
      `# ${name}'s copy`,
      "",
    ].join("\n"),
    [`skills/${OWN_SKILL.replaceAll(".", "/")}/SKILL.md`]: [
      "---",
      `name: ${OWN_SKILL}`,
      "description: Jane's notes, which no other catalog provides.",
      "ambit:",
      "  scopes: [core, person.jane]",
      "---",
      "",
      "# notes",
      "",
    ].join("\n"),
    "mcps/scoped.yml": [
      "name: scoped",
      "scopes: [function.engineering]",
      "transport:",
      "  stdio:",
      `    command: ${name}-mcp`,
      "",
    ].join("\n"),
  };

  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, name, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
}

/**
 * Points the project at the fixture catalog first and the extra catalogs after it, so config order
 * — which is priority order (spec §3.1) — is the fixture's.
 */
async function writeCatalogOrder(
  extra: readonly string[],
  scopes: readonly string[] = [],
): Promise<void> {
  await writeConfig(
    [
      "version: 1",
      "catalogs:",
      `  - name: ${CATALOG_NAME}`,
      "    source: path:../catalog",
      ...extra.flatMap((name) => [`  - name: ${name}`, `    source: path:../${name}`]),
      `scopes: [${scopes.join(", ")}]`,
      "",
    ].join("\n"),
  );
}

/** The merged view of whatever the project's config currently lists. */
async function merged(): Promise<MergedCatalog> {
  return mergeCatalogs(await loadCatalogs(await loadProjectConfig(projectDir), context()));
}

interface CliResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI exactly as given, collecting stdout and stderr.
 *
 * @param handlers the wiring to run against, defaulting to the real one. Given explicitly by the one
 *   case that needs a command with no handler, now that every declared command has one.
 * @param rules the flag rules to run against, defaulting to the real ones. Given explicitly by the
 *   cases that assert *where* a rule runs rather than what any particular one says.
 */
async function invoke(
  argv: readonly string[],
  handlers: CommandHandlers = HANDLERS,
  rules: CommandRules = RULES,
): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    argv,
    {
      cwd: root,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
    handlers,
    rules,
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/**
 * Runs the CLI against the project under test. Authoring commands take `--catalog` instead and so
 * cannot go through here — use `invoke` for those (spec §6).
 */
async function cli(...argv: readonly string[]): Promise<CliResult> {
  return invoke([...argv, "--project", projectDir]);
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

  it("keeps top-level frontmatter keys it does not know", async () => {
    // The top level is the harness's; ambit adds exactly one key to it (spec §3.2).
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: acme.engineering.use-code-review
description: x
allowed-tools: [Read, Grep]
ambit:
  scopes: [function.engineering]
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

  it("rejects a key under `ambit:` that §3.2 does not define, since that block is ambit's", async () => {
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: acme.engineering.use-code-review
description: x
ambit:
  scope: [function.engineering]
---
`,
    );

    const error = await rejection();
    expect(error.message).toBe(`unknown key "ambit.scope" (${CODE_REVIEW} line 5)`);
    expect(error.detail).toContain("accepted keys: env, requires, scopes");
  });

  it("rejects an `ambit:` that is not a mapping", async () => {
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: acme.engineering.use-code-review
description: x
ambit: [function.engineering]
---
`,
    );

    expect((await rejection()).message).toBe(
      `"ambit" must be a mapping (${CODE_REVIEW} line 4)`,
    );
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

/**
 * Spec §6, "Catalog authoring": `catalog` becomes a command group whose default action is `dump`, so
 * the consumer command keeps behaving exactly as it did while the maintainer commands hang off the
 * same word. What is asserted here is the surface itself — which commands exist, what each is called,
 * which directory flag it takes, and what one whose behaviour is not wired up does. Each command's
 * own behaviour is its own suite's.
 */
describe("ambit catalog as a command group", () => {
  /** Every subcommand of `catalog`, as spec §6 lists them. */
  const SUBCOMMANDS = ["dump", "init", "tree", "audit", "scope", "skill", "mcp", "annotate"];

  /**
   * A command's usage, read by running `--help` through the CLI. That is only testable in-process
   * because a subcommand now inherits `exitOverride` and `configureOutput` (A30); before that it took
   * the worker with it, and the help text had to be read off the built `Command` instead.
   */
  async function usage(...words: readonly string[]): Promise<string> {
    const result = await invoke([...words, "--help"]);
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    return result.stdout;
  }

  it("dumps the merged catalog under both `catalog` and `catalog dump`", async () => {
    const group = await cli("catalog");
    const dump = await cli("catalog", "dump");

    expect(group.code, group.stderr).toBe(ExitCode.Success);
    expect(dump.code, dump.stderr).toBe(ExitCode.Success);
    expect(dump.stdout).toBe(group.stdout);
  });

  it("emits byte-identical JSON under both", async () => {
    const group = await cli("catalog", "--json");
    const dump = await cli("catalog", "dump", "--json");

    expect(dump.stdout).toBe(group.stdout);
    expect(JSON.parse(dump.stdout)).toMatchObject({ catalogs: [CATALOG_NAME] });
  });

  it("lists every authoring subcommand in `ambit catalog --help`", async () => {
    const help = await usage("catalog");

    for (const name of SUBCOMMANDS) expect(help).toContain(`\n  ${name} `);
  });

  it("gives an authoring command `--catalog <dir>`, and `dump` `--project <dir>`", async () => {
    // The two directories are different subjects, not the same one under two names: a catalog has no
    // `ambit.yml` to read (spec §6).
    const init = await usage("catalog", "init");
    expect(init).toContain("--catalog <dir>");
    expect(init).not.toContain("--project");

    expect(await usage("catalog", "dump")).toContain("--project <dir>");
  });

  it("prints its usage for a group that has no default action", async () => {
    const result = await invoke(["catalog", "scope"]);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("Usage: ambit catalog scope");
    for (const verb of ["add", "rm", "mv"]) expect(result.stdout).toContain(`\n  ${verb} `);
  });

  it("reports a subcommand with no handler as unimplemented, naming the whole invocation", async () => {
    // Every command spec §6 declares is now built, so the guard is asserted against a program built
    // with one handler removed rather than against a gap in the surface: this is what a later task
    // adding a spec before its behaviour must see, instead of a command that silently succeeds.
    const withoutTree = Object.fromEntries(
      Object.entries(HANDLERS).filter(([key]) => key !== "catalog tree"),
    );
    const result = await invoke(["catalog", "tree", "--catalog", catalogDir], withoutTree);

    expect(result.code, result.stderr).toBe(ExitCode.Internal);
    expect(result.stderr).toContain(`command "catalog tree" is not implemented yet`);
    expect(result.stdout).toBe("");
  });
});

/**
 * Spec §6's exit-code contract, asserted on the commands furthest from the program: a *Commander*-level
 * usage error — an unknown flag, a missing argument — has to leave through `run()` as a code and print
 * through ambit's own output, exactly as one of ambit's own errors does.
 *
 * A subcommand added with `addCommand` inherits neither of the two settings that make that true, so
 * before A30 every case here wrote to the real stderr and called `process.exit`, taking the test worker
 * with it. That is why they are asserted two levels down rather than only for a top-level command:
 * `catalog scope add` is the depth nothing can reach by inheriting from the program alone.
 */
describe("usage errors below the top level", () => {
  const NESTED = ["catalog", "scope", "add"];

  it("returns an exit code for an unknown flag on a nested subcommand", async () => {
    const before = await readFile(path.join(catalogDir, "scopes.yml"), "utf8");
    const result = await invoke([
      ...NESTED,
      "person.jane",
      "--descriptoin",
      "Jane's own things",
      "--catalog",
      catalogDir,
    ]);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("error: unknown option '--descriptoin'");
    // Commander's suggestion is half of what makes the message useful, and it reaches the reader only
    // through ambit's own writer.
    expect(result.stderr).toContain("--description");
    expect(result.stdout).toBe("");
    // Refused before the handler ran, so the mutation it named did not happen.
    expect(await readFile(path.join(catalogDir, "scopes.yml"), "utf8")).toBe(before);
  });

  it("returns an exit code for a missing argument on a nested subcommand", async () => {
    const result = await invoke([...NESTED, "--description", "Jane's own things"]);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("error: missing required argument 'name'");
    expect(result.stdout).toBe("");
  });

  it("returns an exit code for an unknown flag on a top-level command", async () => {
    const result = await invoke(["scopes", "--nope"]);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("error: unknown option '--nope'");
    expect(result.stdout).toBe("");
  });

  it("refuses `--quiet` and `--no-color`, which no command accepts", async () => {
    // Both were once accepted everywhere and read nowhere: ambit prints no progress chatter to
    // suppress and no color to disable. Rejecting them is the intended behaviour — a script passing
    // `--quiet` should hear that ambit cannot honour it, not be silently ignored.
    for (const flag of ["--quiet", "--no-color"]) {
      const result = await invoke(["scopes", flag]);

      expect(result.code).toBe(ExitCode.Config);
      expect(result.stderr).toContain(`error: unknown option '${flag}'`);
      expect(result.stdout).toBe("");
    }
  });

  it("prints a nested subcommand's usage on `--help`, at exit 0", async () => {
    const result = await invoke([...NESTED, "--help"]);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("Usage: ambit catalog scope add");
    expect(result.stderr).toBe("");
  });
});

/**
 * The flag rules Commander runs before it dispatches (`RULES` in `src/program.ts`): the three rules
 * `.makeOptionMandatory()` and `.conflicts()` cannot state without giving up the message spec §6 asks
 * for, declared with the command as a `preAction` hook instead of enforced by the handler that follows.
 *
 * Each case runs against a wiring whose handler would succeed and only record that it was reached, so
 * what is asserted is that the refusal arrived *before* the handler — the whole of what moving the rule
 * onto Commander changed — while the wording each rule produces stays pinned where it always was, in
 * `test/catalog-scope.test.ts`, `test/catalog-mcp.test.ts` and `test/catalog-annotate.test.ts`.
 */
describe("the flag rules Commander enforces before a handler runs", () => {
  /** A wiring in which one command's handler succeeds, doing nothing but recording the visit. */
  function stub(name: string): { handlers: CommandHandlers; reached: () => boolean } {
    let visited = false;
    return {
      handlers: {
        ...HANDLERS,
        [name]: () => {
          visited = true;
          return ExitCode.Success;
        },
      },
      reached: () => visited,
    };
  }

  it("refuses `scope add` with no description before the handler, naming the registry", async () => {
    const stubbed = stub("catalog scope add");

    const result = await invoke(
      ["catalog", "scope", "add", "person.jane", "--catalog", catalogDir],
      stubbed.handlers,
    );

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('scope "person.jane" needs a description (scopes.yml)');
    expect(result.stderr).toContain("--description");
    expect(stubbed.reached()).toBe(false);
  });

  it("refuses `mcp new` naming no transport before the handler, naming its file", async () => {
    const stubbed = stub("catalog mcp new");

    const result = await invoke(
      ["catalog", "mcp", "new", "notes", "--catalog", catalogDir],
      stubbed.handlers,
    );

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain('MCP server "notes" names no transport (mcps/notes.yml)');
    expect(result.stderr).toContain("supported kinds: http, stdio");
    expect(stubbed.reached()).toBe(false);
  });

  it("refuses an `annotate` contradiction before the handler, naming both flags", async () => {
    const stubbed = stub("catalog annotate");

    const result = await invoke(
      [
        "catalog",
        "annotate",
        CORE_SKILL,
        "--add-scope",
        "core",
        "--remove-scope",
        "core",
        "--catalog",
        catalogDir,
      ],
      stubbed.handlers,
    );

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(
      "`--add-scope core` and `--remove-scope core` contradict each other (skills)",
    );
    expect(stubbed.reached()).toBe(false);
  });

  it("dispatches to the handler once a rule accepts the flags it was given", async () => {
    // The control on the three above: a hook that refused everything, or one wired to the wrong key,
    // would pass them all and fail here.
    const stubbed = stub("catalog scope add");

    const result = await invoke(
      ["catalog", "scope", "add", "person.jane", "--description", "Jane's own things", "--catalog", catalogDir],
      stubbed.handlers,
    );

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(stubbed.reached()).toBe(true);
  });

  it("runs a group's default rule exactly once, whether or not the default is typed", async () => {
    // A hook fires for every action below the command it hangs off as well as for that command's own,
    // so `catalog`'s copy of the `catalog dump` rule has to stand down when `dump` is what ran — or the
    // rule sees the group's flags, and sees them twice.
    const seen: (string | undefined)[] = [];
    const rules: CommandRules = {
      "catalog dump": (ctx) => {
        seen.push(typeof ctx.options.project === "string" ? ctx.options.project : undefined);
      },
    };

    for (const argv of [["catalog"], ["catalog", "dump"]]) {
      const result = await invoke([...argv, "--project", projectDir], HANDLERS, rules);
      expect(result.code, result.stderr).toBe(ExitCode.Success);
    }

    expect(seen).toEqual([projectDir, projectDir]);
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

/**
 * Spec §4.4–§4.5: several catalogs merge into one namespace per kind, the earlier one in config
 * order wins a duplicate name, and the loss is recorded rather than discarded — a shadowed copy that
 * vanishes silently is the failure someone adding a personal catalog cannot debug.
 *
 * The second catalog is written per test rather than added to the shared fixture: a catalog whose
 * whole purpose is to collide with another one has no business in the tree every other profile
 * resolves against.
 */
describe("multi-catalog merge and shadowing", () => {
  const SECOND = "personal";
  const THIRD = "backup";

  it("keeps the earlier catalog's copy of a duplicate name, and records the shadowing", async () => {
    await writeShadowingCatalog(SECOND);
    await writeCatalogOrder([SECOND]);

    const view = await merged();

    expect(view.catalogs).toEqual([CATALOG_NAME, SECOND]);
    expect(view.skills.find((skill) => skill.name === CORE_SKILL)?.catalog).toBe(CATALOG_NAME);
    expect(view.shadowing.skills.get(CORE_SKILL)).toEqual({
      name: CORE_SKILL,
      catalog: CATALOG_NAME,
      shadows: [SECOND],
    });
    expect(view.shadowing.mcps.get("scoped")).toEqual({
      name: "scoped",
      catalog: CATALOG_NAME,
      shadows: [SECOND],
    });
  });

  it("keeps what the later catalog alone provides, and records nothing about it", async () => {
    await writeShadowingCatalog(SECOND);
    await writeCatalogOrder([SECOND]);

    const view = await merged();

    expect(view.skills.find((skill) => skill.name === OWN_SKILL)?.catalog).toBe(SECOND);
    expect(view.shadowing.skills.has(OWN_SKILL)).toBe(false);
    expect([...view.shadowing.skills.keys()]).toEqual([CORE_SKILL]);
    expect([...view.shadowing.mcps.keys()]).toEqual(["scoped"]);
  });

  it("keeps the winner's definition, not merely its label", async () => {
    // The transports differ, so this is the assertion that the merge dropped the shadowed entry
    // rather than keeping its body under the winning catalog's name.
    await writeShadowingCatalog(SECOND);
    await writeCatalogOrder([SECOND]);

    const dumped = JSON.parse((await cli("catalog", "--json")).stdout) as {
      mcps: Record<string, { catalog: string; transport: { kind: string } }>;
    };

    expect(dumped.mcps.scoped).toMatchObject({
      catalog: CATALOG_NAME,
      transport: { kind: "http" },
    });
  });

  it("names every catalog a duplicate was shadowed in, in config order", async () => {
    await writeShadowingCatalog(SECOND);
    await writeShadowingCatalog(THIRD);
    await writeCatalogOrder([SECOND, THIRD]);

    expect((await merged()).shadowing.skills.get(CORE_SKILL)?.shadows).toEqual([SECOND, THIRD]);
  });

  it("merges a scope two catalogs describe identically, keeping one registration", async () => {
    await writeShadowingCatalog(SECOND);
    await writeCatalogOrder([SECOND]);

    const view = await merged();

    expect(view.scopes.map((scope) => scope.name)).toEqual([
      "core",
      "function.engineering",
      "function.engineering.frontend",
      "person.jane",
      "project.acme",
    ]);
    expect(view.scopes.find((scope) => scope.name === "core")?.description).toBe(CORE_DESCRIPTION);
  });

  it("exits 3 for a scope two catalogs describe differently, naming both", async () => {
    await writeShadowingCatalog(SECOND, "Everything, all of it");
    await writeCatalogOrder([SECOND], ["core"]);

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('conflicting descriptions for scope "core" (scopes.yml)');
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" describes it as "${CORE_DESCRIPTION}"`);
    expect(result.stderr).toContain(`catalog "${SECOND}" describes it as "Everything, all of it"`);
    expect(result.stderr).toContain("make the two descriptions identical");
  });

  it("reports the shadowing beside the reason under `resolve --explain`", async () => {
    await writeShadowingCatalog(SECOND);
    await writeCatalogOrder([SECOND], ["core"]);

    const result = await cli("resolve", "--explain");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "scopes (1)",
        "  core",
        "",
        "skills (2)",
        `  ${CORE_SKILL}  ${CATALOG_NAME.padEnd(SECOND.length)}  scope:core  catalog:${CATALOG_NAME} (shadows ${SECOND})`,
        `  ${OWN_SKILL.padEnd(CORE_SKILL.length)}  ${SECOND}  scope:core`,
        "",
        "mcps (0)",
        "  (none)",
        "",
        "env (0)",
        "  (none)",
      ].join("\n"),
    );
  });

  it("adds the shadowed catalogs to `--explain --json`, and only there", async () => {
    await writeShadowingCatalog(SECOND);
    await writeCatalogOrder([SECOND], ["core", "function.engineering"]);

    const explained = JSON.parse((await cli("resolve", "--explain", "--json")).stdout) as {
      skills: Record<string, { catalog: string; shadows?: readonly string[] }>;
      mcps: Record<string, { catalog: string; reason?: string; shadows?: readonly string[] }>;
    };

    expect(explained.skills[CORE_SKILL]?.shadows).toEqual([SECOND]);
    expect(explained.skills[OWN_SKILL]).not.toHaveProperty("shadows");
    // A server the fixture and the second catalog both provide, selected by its own scope.
    expect(explained.mcps.scoped).toEqual({
      catalog: CATALOG_NAME,
      reason: "scope:function.engineering",
      shadows: [SECOND],
    });

    const plain = JSON.parse((await cli("resolve", "--json")).stdout) as {
      skills: Record<string, unknown>;
      mcps: Record<string, unknown>;
    };
    expect(plain.skills[CORE_SKILL]).not.toHaveProperty("shadows");
    expect(plain.mcps.scoped).not.toHaveProperty("shadows");
  });
});

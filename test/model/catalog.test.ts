/**
 * Catalog parsing from a `path:` source, and the `ambit search` view built on it.
 *
 * Every case runs against the fixture catalog, mutated in place for the malformed ones, so the
 * subject is the same tree the rest of the suite resolves against.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { MergedCatalog } from "../../src/model/catalog.js";
import { loadCatalogs, mergeCatalogs, parseCatalogDirectory } from "../../src/model/catalog.js";
import type { CommandHandlers, CommandRules } from "../../src/cli/commands.js";
import { COMMAND_SPECS, buildCommand } from "../../src/cli/commands.js";
import { loadProjectConfig } from "../../src/model/config.js";
import { AmbitError, ExitCode } from "../../src/errors.js";
import { HANDLERS, RULES, run } from "../../src/cli/program.js";
import type { SourceContext } from "../../src/model/sources.js";

const CATALOG_NAME = "company";
const CODE_REVIEW = "skills/code-review/SKILL.md";

/** The fixture's core skill, and the tag it declares — the pair a second catalog collides with. */
const CORE_SKILL = "company-context";
const CORE_TAG = "core";

/** A skill only the second catalog provides, so a merge has something to keep from both. */
const OWN_SKILL = "jane-notes";

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
 * Builds a catalog beside the fixture that deliberately collides with it: the same core skill and the
 * same `tagged` server, plus a skill of its own so the merge has something only one catalog provides.
 *
 * @param name the catalog's directory, which is also the name config gives it.
 */
async function writeCollidingCatalog(name: string): Promise<void> {
  const files: Readonly<Record<string, string>> = {
    [`skills/${CORE_SKILL.replaceAll(".", "/")}/SKILL.md`]: [
      "---",
      `name: ${CORE_SKILL}`,
      `description: ${name}'s copy of the core skill.`,
      "---",
      "",
      `# ${name}'s copy`,
      "",
    ].join("\n"),
    [`skills/${OWN_SKILL.replaceAll(".", "/")}/SKILL.md`]: [
      "---",
      `name: ${OWN_SKILL}`,
      "description: Jane's notes, which no other catalog provides.",
      "---",
      "",
      "# notes",
      "",
    ].join("\n"),
    "mcps/linter.yml": [
      "name: linter",
      "transport:",
      "  stdio:",
      `    command: ${name}-mcp`,
      "",
    ].join("\n"),
    // Every catalog offers the same two groupings by name, which is what makes a project selecting
    // from both a collision rather than two different asks.
    [`packs/${CORE_TAG}.yml`]: [
      `name: ${CORE_TAG}`,
      `description: ${name}'s core pack.`,
      "requires:",
      `  - skill: ${CORE_SKILL}`,
      `  - skill: ${OWN_SKILL}`,
      "",
    ].join("\n"),
    "packs/person.jane.yml": [
      "name: person.jane",
      `description: ${name}'s pack for Jane.`,
      "requires:",
      `  - skill: ${OWN_SKILL}`,
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
 * Points the project at the fixture catalog first and the extra catalogs after it.
 *
 * The order is only how the file reads: nothing resolves by it, since every catalog's copy of a name
 * survives the merge.
 *
 * @param requires entry lines, built with {@link requiresEntry}. Each carries its own qualifier,
 *   because that is the whole of what makes two copies of one name individually addressable — and so
 *   what makes reaching both of them a thing a config has to ask for on purpose.
 */
async function writeCatalogOrder(
  extra: readonly string[],
  requires: readonly string[] = [],
): Promise<void> {
  await writeConfig(
    [
      "version: 1",
      "catalogs:",
      `  - name: ${CATALOG_NAME}`,
      "    source: path:../catalog",
      ...extra.flatMap((name) => [`  - name: ${name}`, `    source: path:../${name}`]),
      ...(requires.length === 0 ? ["requires: []"] : ["requires:", ...requires]),
      "",
    ].join("\n"),
  );
}

/** One `requires` entry, taking a whole pack from `catalog`. */
function requiresEntry(pack: string, catalog = CATALOG_NAME): string {
  return `  - { pack: "${catalog}/${pack}" }`;
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

/** Runs the CLI against the project under test. */
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
  it("reads every skill and every MCP entity, and nothing at the root", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    expect(catalog.name).toBe(CATALOG_NAME);
    expect(catalog.root).toBe(catalogDir);
    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      "acme-brief",
      "code-review",
      "company-context",
      "design-tokens",
    ]);
    expect(catalog.mcps.map((mcp) => mcp.name)).toEqual(["fixture", "linter"]);
  });

  it("derives each skill's name and path from its directory", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);
    const frontend = catalog.skills.find((skill) => skill.name === "design-tokens");

    expect(frontend).toMatchObject({
      path: "skills/design-tokens",
      requires: [],
      expects: [{ kind: "env", name: "ACME_FIGMA_TOKEN" }],
    });
    expect(frontend?.description).toBeTruthy();
  });

  it("joins a nested skill's path segments with `.`, which is the only way a name carries one", async () => {
    await writeCatalogFile(
      "skills/personal/notes/SKILL.md",
      "---\nname: personal.notes\ndescription: x\n---\n",
    );

    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    expect(catalog.skills.find((skill) => skill.name === "personal.notes")).toMatchObject({
      path: "skills/personal/notes",
    });
  });

  it("carries `requires` through as pattern entries, unqualified", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    // In the order the fixture wrote them: a `requires` list is the author's, not a sorted one. No
    // `catalog` on any entry — a catalog author cannot write a consumer's alias, and the entry
    // resolves within this catalog.
    expect(catalog.skills.find((skill) => skill.name === "acme-brief")?.requires).toEqual([
      { kind: "skill", pattern: "company-context" },
      { kind: "mcp", pattern: "fixture" },
      { kind: "hook", pattern: "acme-standup" },
    ]);
  });

  it("parses both transport kinds", async () => {
    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    expect(catalog.mcps.find((mcp) => mcp.name === "fixture")?.transport).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@acme/fixture-mcp"],
    });
    expect(catalog.mcps.find((mcp) => mcp.name === "linter")?.transport).toEqual({
      kind: "http",
      url: "https://mcp.invalid/fixture",
      headers: { Authorization: "Bearer ${LINTER_API_KEY}" },
    });
  });

  it("keeps top-level frontmatter keys it does not know", async () => {
    // The top level is the harness's; ambit adds exactly one key to it.
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: code-review
description: x
allowed-tools: [Read, Grep]
ambit:
  requires: [{ skill: company-context }]
---
`,
    );

    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);
    expect(catalog.skills.map((skill) => skill.name)).toContain("code-review");
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
name: wrong-name
description: x
---
`,
    );

    const error = await rejection();
    expect(error.message).toContain('skill name "wrong-name" does not match its path');
    // The line is the one the reader will find `name` on in the whole document, not in the block.
    expect(error.message).toContain(`${CODE_REVIEW} line 2`);
    expect(error.detail.join("\n")).toContain('derives the name "code-review"');
  });

  it("rejects a key under `ambit:` that §3.2 does not define, since that block is ambit's", async () => {
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: code-review
description: x
ambit:
  tag: [function.engineering]
---
`,
    );

    const error = await rejection();
    expect(error.message).toBe(`unknown key "ambit.tag" (${CODE_REVIEW} line 5)`);
    expect(error.detail).toContain("accepted keys: expects, requires");
  });

  it("rejects an `ambit:` that is not a mapping", async () => {
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: code-review
description: x
ambit: [function.engineering]
---
`,
    );

    expect((await rejection()).message).toBe(`"ambit" must be a mapping (${CODE_REVIEW} line 4)`);
  });

  it("positions a frontmatter error at its line in the document", async () => {
    await writeCatalogFile(
      CODE_REVIEW,
      `---
name: code-review
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

    expect((await rejection()).message).toContain('declares its frontmatter as "json"');
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

  /**
   * The transport rules, read through the file that is now the only place a server can be written.
   *
   * They were asserted through `ambit.yml`'s inline `mcps` while that existed, which was the shorter
   * document to write; `mcps/<name>.yml` is the same parser and the same messages, minus the key path
   * a config entry prefixed them with.
   */
  const TRANSPORTS: readonly [label: string, body: string, expected: string][] = [
    ["names no kind", "transport: {}\n", "`transport` names no transport kind"],
    [
      "names two kinds",
      "transport:\n  stdio:\n    command: npx\n  http:\n    url: https://x.invalid\n",
      "`transport` names 2 transport kinds: http, stdio",
    ],
    [
      "names a kind ambit does not have",
      "transport:\n  sse:\n    url: https://x.invalid\n",
      'unknown transport kind "sse"',
    ],
    [
      "gives a stdio transport no command",
      "transport:\n  stdio: {}\n",
      'missing required key "transport.stdio.command"',
    ],
  ];

  for (const [label, body, expected] of TRANSPORTS) {
    it(`rejects an MCP entity whose transport ${label}`, async () => {
      await writeCatalogFile("mcps/broken.yml", `name: broken\n${body}`);

      expect((await rejection()).format()).toContain(expected);
    });
  }

  it("lists the transport kinds it does have when one is missing", async () => {
    await writeCatalogFile("mcps/broken.yml", "name: broken\ntransport: {}\n");

    expect((await rejection()).format()).toContain("supported kinds: http, stdio");
  });

  it("rejects one MCP name defined by two files", async () => {
    await cp(path.join(catalogDir, "mcps/fixture.yml"), path.join(catalogDir, "mcps/fixture.yaml"));

    expect((await rejection()).message).toBe(
      'mcps/fixture.yaml and mcps/fixture.yml both define "fixture"',
    );
  });

  it("refuses a catalog that still holds a scopes.yml, naming the rewrite", async () => {
    // The registry is the one thing at a catalog root ambit still has an opinion about, and the
    // opinion is that it must not be there.
    await writeCatalogFile("scopes.yml", "scopes:\n  core:\n    description: A\n");

    const error = await rejection();
    expect(error.message).toBe("the scope registry is gone (scopes.yml)");
    expect(error.detail.join("\n")).toContain("a group of items is a pack now");
    expect(error.detail.join("\n")).toContain("selected with `pack:`");
  });

  it("ignores an `ambit.yml` at the catalog root, since a project may publish itself", async () => {
    await writeCatalogFile("ambit.yml", "version: 1\nrequires: []\n");

    const catalog = await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir);

    expect(catalog.skills.map((skill) => skill.name)).toContain("company-context");
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

    const result = await cli("search", "*");
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

    const result = await cli("search", "*");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`catalog "${CATALOG_NAME}" is not a directory`);
  });
});

describe("ambit search", () => {
  it("emits the full fixture catalog as JSON", async () => {
    const result = await cli("search", "*", "--json");

    expect(result.code).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout)).toEqual({
      catalogs: [CATALOG_NAME],
      // The fixture's three: one the `core` pack names, one shipping a script, and one in no pack.
      hooks: {
        [`${CATALOG_NAME}/acme-standup`]: {
          catalog: CATALOG_NAME,
          type: "command",
          command: 'echo "acme session ended"',
          description: "Records what the session touched, for the Acme standup.",
          expects: [],
          event: "SessionEnd",
          path: "hooks/acme-standup",
        },
        [`${CATALOG_NAME}/guard-secrets`]: {
          catalog: CATALOG_NAME,
          type: "script",
          command: "guard.sh",
          description: "Inspects a Bash command before Acme's tooling runs it.",
          expects: [],
          event: "PreToolUse",
          matcher: "Bash",
          path: "hooks/guard-secrets",
          timeout: 10,
        },
        [`${CATALOG_NAME}/session-notes`]: {
          catalog: CATALOG_NAME,
          type: "command",
          command: 'echo "acme conventions apply"',
          description: "Reminds a session that Acme's conventions apply.",
          expects: [],
          event: "SessionStart",
          path: "hooks/session-notes",
        },
      },
      skills: {
        [`${CATALOG_NAME}/company-context`]: {
          catalog: CATALOG_NAME,
          description: "Canonical context about Acme — what it sells, to whom, and how it works.",
          expects: [],
          path: "skills/company-context",
          requires: [],
        },
        [`${CATALOG_NAME}/design-tokens`]: {
          catalog: CATALOG_NAME,
          description: "Acme's design tokens — color, spacing, and the type scale.",
          expects: [{ kind: "env", name: "ACME_FIGMA_TOKEN" }],
          path: "skills/design-tokens",
          requires: [],
        },
        [`${CATALOG_NAME}/code-review`]: {
          catalog: CATALOG_NAME,
          description: "How Acme reviews code — what reviewers look for, and in what order.",
          expects: [],
          path: "skills/code-review",
          requires: [],
        },
        [`${CATALOG_NAME}/acme-brief`]: {
          catalog: CATALOG_NAME,
          description: "The Acme engagement brief — remit, contacts, and conventions.",
          expects: [],
          path: "skills/acme-brief",
          requires: [
            { kind: "skill", pattern: "company-context" },
            { kind: "mcp", pattern: "fixture" },
            { kind: "hook", pattern: "acme-standup" },
          ],
        },
      },
      // What a pack is for, and what it gathers — the half the labels it replaced never had.
      packs: {
        [`${CATALOG_NAME}/core`]: {
          catalog: CATALOG_NAME,
          description: "What every Acme session needs, whoever is in it.",
          requires: [
            { kind: "skill", pattern: "company-context" },
            { kind: "hook", pattern: "session-notes" },
          ],
        },
        [`${CATALOG_NAME}/function.engineering`]: {
          catalog: CATALOG_NAME,
          description:
            "Everything an Acme engineer needs — reviews, tooling, and the guards around them.",
          requires: [
            { kind: "pack", pattern: "core" },
            { kind: "skill", pattern: "code-review" },
            { kind: "mcp", pattern: "linter" },
            { kind: "hook", pattern: "guard-secrets" },
          ],
        },
        [`${CATALOG_NAME}/function.engineering.frontend`]: {
          catalog: CATALOG_NAME,
          description:
            "What an Acme engineer working on interfaces needs on top of the engineering pack.",
          requires: [
            { kind: "pack", pattern: "function.engineering" },
            { kind: "skill", pattern: "design-tokens" },
          ],
        },
        [`${CATALOG_NAME}/project.acme`]: {
          catalog: CATALOG_NAME,
          description: "The Acme engagement — its brief, and whatever the brief drags in.",
          requires: [{ kind: "skill", pattern: "acme-brief" }],
        },
      },
      mcps: {
        [`${CATALOG_NAME}/fixture`]: {
          catalog: CATALOG_NAME,
          expects: [{ kind: "env", name: "FIXTURE_API_KEY" }],
          transport: { kind: "stdio", command: "npx", args: ["-y", "@acme/fixture-mcp"] },
        },
        [`${CATALOG_NAME}/linter`]: {
          catalog: CATALOG_NAME,
          expects: [{ kind: "env", name: "LINTER_API_KEY" }],
          transport: {
            kind: "http",
            url: "https://mcp.invalid/fixture",
            headers: { Authorization: "Bearer ${LINTER_API_KEY}" },
          },
        },
      },
    });
  });

  it("emits byte-identical JSON on a second run, with keys sorted", async () => {
    const first = await cli("search", "*", "--json");
    const second = await cli("search", "*", "--json");

    expect(second.stdout).toBe(first.stdout);
    const emitted = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(Object.keys(emitted)).toEqual([...Object.keys(emitted)].sort());
  });

  it("carries no machine-specific paths into JSON output", async () => {
    const result = await cli("search", "*", "--json");

    expect(result.stdout).not.toContain(root);
  });

  it("lists packs with their descriptions, and skills and MCPs, as text", async () => {
    const result = await cli("search", "*");

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain(`${CATALOG_NAME}  path:../catalog`);
    // The packs lead, and each carries what it is for — which is the section a person browsing a
    // catalog is actually reading.
    expect(result.stdout).toContain(
      `core                           ${CATALOG_NAME}  What every Acme session needs`,
    );
    expect(result.stdout).toContain(`company-context  ${CATALOG_NAME}`);
    expect(result.stdout).toContain("acme-brief");
    expect(result.stdout).toContain("stdio: npx -y @acme/fixture-mcp");
    expect(result.stdout).toContain("http: https://mcp.invalid/fixture");
  });

  it("succeeds with nothing to dump when no catalogs are configured", async () => {
    await writeConfig("version: 1\nrequires: []\n");

    const result = await cli("search", "*");
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain("no catalogs configured");
  });

  it("exits 2 on a skill name that disagrees with its path", async () => {
    await writeCatalogFile(CODE_REVIEW, "---\nname: wrong-name\n---\n");

    const result = await cli("search", "*", "--json");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not match its path");
  });

  it("exits 2 when the project has no config", async () => {
    await rm(path.join(projectDir, "ambit.yml"));

    const result = await cli("search", "*");
    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("no ambit config");
  });
});

/**
 * The three filters `ambit search` narrows with, and how they combine.
 *
 * Repeating one flag widens and different flags narrow, which is the only reading that makes both
 * halves of `--catalog a --catalog b --capability skill "foo*"` mean something — and the half worth
 * asserting is that a result has to satisfy every flag that was given, not merely one of them.
 *
 * The pattern is the same glob a `requires` entry is written with, deliberately: a person who has
 * found an item with this command can paste what they typed into `requires:` and reach the same
 * items. What differs is what an empty result means, and that is asserted here too — matching nothing
 * is exit 0 and a report, where the same pattern in a `requires` entry is exit 3.
 */
describe("ambit search, narrowed", () => {
  /** The section body `ambit search` prints under `title`, without its heading or its indent. */
  function rowsUnder(stdout: string, title: string): readonly string[] {
    const lines = stdout.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${title} (`));
    if (start === -1) return [];
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => !line.startsWith("  "));
    return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim());
  }

  /** Whether a section was printed at all, which is what `--capability` decides. */
  function hasSection(stdout: string, title: string): boolean {
    return stdout.split("\n").some((line) => line.startsWith(`${title} (`));
  }

  it("matches names with the glob a `requires` entry uses, prefix included", async () => {
    const result = await cli("search", "function.*", "--capability", "pack");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(rowsUnder(result.stdout, "packs").map((row) => row.split("  ")[0])).toEqual([
      "function.engineering",
      "function.engineering.frontend",
    ]);
  });

  it("excludes the prefix itself, exactly as the same pattern does in `requires`", async () => {
    // `function.engineering.*` says *`function.engineering`, a dot, then anything*, and the pack
    // named exactly that has no dot left. A search that was generous here would find items a
    // `requires` entry copied out of it would then miss.
    const result = await cli("search", "function.engineering.*", "--capability", "pack");

    expect(rowsUnder(result.stdout, "packs").map((row) => row.split("  ")[0])).toEqual([
      "function.engineering.frontend",
    ]);
  });

  it("treats a pattern with no wildcard as an exact name", async () => {
    const result = await cli("search", "code-review", "--capability", "skill");

    expect(rowsUnder(result.stdout, "skills").map((row) => row.split("  ")[0])).toEqual([
      "code-review",
    ]);
  });

  it("prints only the sections `--capability` asked for", async () => {
    const result = await cli("search", "*", "--capability", "skill");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(hasSection(result.stdout, "skills")).toBe(true);
    // Omitted rather than printed empty: a section shown as `(none)` reads as *this catalog has no
    // packs*, which is a different answer from *you did not ask about packs*.
    for (const title of ["packs", "mcps", "hooks"]) {
      expect(hasSection(result.stdout, title), title).toBe(false);
    }
  });

  it("widens when `--capability` is repeated", async () => {
    const result = await cli("search", "*", "--capability", "skill", "--capability", "mcp");

    expect(hasSection(result.stdout, "skills")).toBe(true);
    expect(hasSection(result.stdout, "mcps")).toBe(true);
    expect(hasSection(result.stdout, "packs")).toBe(false);
    expect(hasSection(result.stdout, "hooks")).toBe(false);
  });

  it("emits every namespace as a JSON key whatever was asked for, so a reader need not branch", async () => {
    const result = await cli("search", "*", "--capability", "skill", "--json");

    const emitted = JSON.parse(result.stdout) as Record<string, Record<string, unknown>>;
    expect(Object.keys(emitted)).toEqual(["catalogs", "hooks", "mcps", "packs", "skills"]);
    expect(Object.keys(emitted.skills!).length).toBeGreaterThan(0);
    expect(emitted.packs).toEqual({});
    expect(emitted.mcps).toEqual({});
    expect(emitted.hooks).toEqual({});
  });

  it("limits to one catalog, and widens when `--catalog` is repeated", async () => {
    const second = "acme";
    await writeCollidingCatalog(second);
    await writeCatalogOrder([second]);

    // `company-context` is the name both catalogs provide, so it is the one that can tell a filter
    // that narrowed from a filter that did nothing.
    const one = await cli("search", CORE_SKILL, "--capability", "skill", "--catalog", second);
    expect(rowsUnder(one.stdout, "skills")).toEqual([`${CORE_SKILL}  ${second}`]);
    // The header answers *where did I just look*, so it narrows with the filter.
    expect(one.stdout).not.toContain(`${CATALOG_NAME}  path:../catalog`);

    const both = await cli(
      "search",
      CORE_SKILL,
      "--capability",
      "skill",
      "--catalog",
      second,
      "--catalog",
      CATALOG_NAME,
    );
    expect(rowsUnder(both.stdout, "skills")).toEqual([
      `${CORE_SKILL}  ${second}`,
      `${CORE_SKILL}  ${CATALOG_NAME}`,
    ]);
  });

  it("narrows across flags: a result satisfies the pattern, the capability and the catalog", async () => {
    const second = "acme";
    await writeCollidingCatalog(second);
    await writeCatalogOrder([second]);

    // `jane-notes` exists only in the second catalog, so restricting to the first is a filter the
    // pattern alone would not have applied.
    const result = await cli(
      "search",
      OWN_SKILL,
      "--capability",
      "skill",
      "--catalog",
      CATALOG_NAME,
    );

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(rowsUnder(result.stdout, "skills")).toEqual(["(none)"]);
  });

  it("succeeds with an empty report when the pattern matches nothing", async () => {
    // The opposite of what the same pattern means in a `requires` entry, and deliberately so: a
    // requirement reaching nothing is a config that will not do what it says, while a search finding
    // nothing is the answer to the search.
    const result = await cli("search", "no-such-*");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stderr).toBe("");
    for (const title of ["packs", "skills", "mcps", "hooks"]) {
      expect(rowsUnder(result.stdout, title), title).toEqual(["(none)"]);
    }
  });

  it("exits 2 on a `--catalog` this project does not list, naming what it does", async () => {
    const result = await cli("search", "*", "--catalog", "nope");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('no catalog named "nope"');
    expect(result.stderr).toContain(`this project lists: ${CATALOG_NAME}`);
  });

  it("exits 2 on a `--capability` that is not a namespace", async () => {
    const result = await cli("search", "*", "--capability", "tag");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("pack, skill, mcp, hook");
  });

  it("requires the pattern, so `*` is asked for rather than defaulted to", async () => {
    const result = await cli("search");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("missing required argument");
  });
});

/**
 * `hooks/<name>/hook.yml`: the third namespace a catalog distributes, and the one whose declaration is
 * not the whole truth about it.
 *
 * A hook is a directory for the same reason a skill is — it may ship bytes — so it is found and named
 * exactly as a skill is, and those cases are the cheap half. The half worth the file is what
 * happens once a document says `type: script`: the catalog is asked whether the file is really there,
 * so a misspelled script name is a refusal naming what the directory actually holds, rather than a
 * command line quietly written into a harness config and discovered when the hook silently fails to
 * run.
 *
 * Every case writes the hook it is about into the fixture, beside the three the fixture ships, and reads
 * back only what it wrote: a case about one document should not restate the fixture's own.
 */
describe("catalog hooks", () => {
  const HOOK_NAME = "block-rm";
  const HOOK_DIR = `hooks/${HOOK_NAME}`;
  const HOOK_FILE = `${HOOK_DIR}/hook.yml`;

  /** The second catalog, for the one case about two of them providing one hook. */
  const SECOND_CATALOG = "personal";

  /** A hook document, its `name` given separately so a caller writes only what the case is about. */
  function document(name: string, lines: readonly string[]): string {
    return [`name: ${name}`, ...lines, ""].join("\n");
  }

  /** Writes a hook into a catalog beside the fixture, so two catalogs can provide one name. */
  async function writeHookIn(
    catalog: string,
    name: string,
    lines: readonly string[],
  ): Promise<void> {
    const target = path.join(root, catalog, "hooks", name.replaceAll(".", "/"), "hook.yml");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, document(name, lines), "utf8");
  }

  /** The hooks the fixture itself ships, which every case here writes beside. */
  const FIXTURE_HOOKS = ["acme-standup", "guard-secrets", "session-notes"];

  /** The hooks a case wrote, parsed — the fixture's own filtered out. */
  async function hooks() {
    const parsed = (await parseCatalogDirectory(CATALOG_NAME, "path:../catalog", catalogDir)).hooks;
    return parsed.filter((hook) => !FIXTURE_HOOKS.includes(hook.name));
  }

  it("reads every hook directory, deriving the name and the path from it", async () => {
    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, [
        "description: Refuses a destructive rm before it runs",
        "event: PreToolUse",
        "matcher: Bash",
        "type: command",
        "command: npx block-rm",
        "timeout: 30",
        "expects:",
        "  - env: BLOCK_RM_TOKEN",
      ]),
    );

    expect(await hooks()).toEqual([
      {
        name: HOOK_NAME,
        path: HOOK_DIR,
        description: "Refuses a destructive rm before it runs",
        event: "PreToolUse",
        matcher: "Bash",
        type: "command",
        command: "npx block-rm",
        timeout: 30,
        expects: [{ kind: "env", name: "BLOCK_RM_TOKEN" }],
      },
    ]);
  });

  it("joins a nested hook's path segments with `.`, exactly as a skill's are", async () => {
    await writeCatalogFile(
      "hooks/team/notify/hook.yml",
      document("team.notify", ["event: Stop", "type: command", "command: npx notify"]),
    );

    expect(await hooks()).toMatchObject([{ name: "team.notify", path: "hooks/team/notify" }]);
  });

  it("accepts a declared script the directory holds, whether bare or nested", async () => {
    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, ["event: Stop", "type: script", "command: hook.sh"]),
    );
    await writeCatalogFile(`${HOOK_DIR}/hook.sh`, "#!/bin/sh\nexit 0\n");
    expect(await hooks()).toMatchObject([{ command: "hook.sh", type: "script" }]);

    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, ["event: Stop", "type: script", "command: ./bin/hook --verbose"]),
    );
    await writeCatalogFile(`${HOOK_DIR}/bin/hook`, "#!/bin/sh\nexit 0\n");
    // The program is the only token that can name a shipped file; its arguments are the harness's.
    expect(await hooks()).toMatchObject([{ command: "./bin/hook --verbose", type: "script" }]);
  });

  it("takes a command line as written, whatever its first word looks like", async () => {
    // The three the old derivation had to be taught: two bare programs, and one absolute path it
    // had to carve out by hand. `type` answers all three without a rule about dots or slashes.
    for (const command of ["npx prettier --write", "python3.11 check.py", "/usr/bin/say done"]) {
      await writeCatalogFile(
        HOOK_FILE,
        document(HOOK_NAME, ["event: Stop", "type: command", `command: ${command}`]),
      );

      expect(await hooks(), command).toMatchObject([{ command, type: "command" }]);
    }
  });

  it("leaves a command line alone even when the directory happens to hold that name", async () => {
    // `type` is the whole answer, so a file sitting there is a coincidence rather than a signal —
    // this hook runs `hook.sh` off the PATH, and nothing is materialized for it.
    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, ["event: Stop", "type: command", "command: hook.sh"]),
    );
    await writeCatalogFile(`${HOOK_DIR}/hook.sh`, "#!/bin/sh\nexit 0\n");

    expect(await hooks()).toMatchObject([{ command: "hook.sh", type: "command" }]);
  });

  it("refuses a script the hook's directory does not hold, listing what it does", async () => {
    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, ["event: Stop", "type: script", "command: hook.sh"]),
    );
    await writeCatalogFile(`${HOOK_DIR}/hoook.sh`, "#!/bin/sh\nexit 0\n");
    await writeCatalogFile(`${HOOK_DIR}/lib/helper.sh`, "#!/bin/sh\nexit 0\n");

    const error = await rejection();
    expect(error.message).toBe(`hook "${HOOK_NAME}" ships no hook.sh (${HOOK_FILE} line 4)`);
    expect(error.detail).toContain(`${HOOK_DIR} holds: hoook.sh, lib/helper.sh`);
    expect(error.detail.join("\n")).toContain("say `type: command` instead");
  });

  it("says the directory holds nothing else when a hook ships no files at all", async () => {
    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, ["event: Stop", "type: script", "command: hook.sh"]),
    );

    expect((await rejection()).detail).toContain(`${HOOK_DIR} holds nothing but hook.yml`);
  });

  it("refuses a hook whose `name` disagrees with its path", async () => {
    await writeCatalogFile(
      HOOK_FILE,
      document("wrong-name", ["event: Stop", "type: command", "command: npx x"]),
    );

    const error = await rejection();
    expect(error.message).toBe(
      `hook name "wrong-name" does not match its path (${HOOK_FILE} line 1)`,
    );
    expect(error.detail.join("\n")).toContain(`derives the name "${HOOK_NAME}"`);
  });

  it("refuses a `hook.yml` that is in no hook directory at all", async () => {
    await writeCatalogFile(
      "hooks/hook.yml",
      document("x", ["event: Stop", "type: command", "command: npx x"]),
    );

    expect((await rejection()).message).toBe("hooks/hook.yml is not inside a hook directory");
  });

  it("carries every hook entity rejection through, since one parser serves both surfaces", async () => {
    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, ["event: OnTuesday", "type: command", "command: npx x"]),
    );

    expect((await rejection()).message).toContain('unknown hook event "OnTuesday"');
  });

  it("shows hooks in `ambit search`, JSON and text, with the derivation JSON cannot see otherwise", async () => {
    await writeCatalogFile(
      HOOK_FILE,
      document(HOOK_NAME, [
        "event: PreToolUse",
        "matcher: Bash",
        "type: script",
        "command: hook.sh",
      ]),
    );
    await writeCatalogFile(`${HOOK_DIR}/hook.sh`, "#!/bin/sh\nexit 0\n");

    const emitted = JSON.parse((await cli("search", "*", "--json")).stdout) as {
      hooks: Record<string, unknown>;
    };
    expect(emitted.hooks[`${CATALOG_NAME}/${HOOK_NAME}`]).toEqual({
      catalog: CATALOG_NAME,
      type: "script",
      command: "hook.sh",
      event: "PreToolUse",
      expects: [],
      matcher: "Bash",
      path: HOOK_DIR,
    });
    // The fixture's own three come along, which the whole-catalog case above pins. Each record is
    // keyed by its address, since a name is not unique across catalogs.
    expect(Object.keys(emitted.hooks)).toEqual(
      [HOOK_NAME, ...FIXTURE_HOOKS].sort().map((name) => `${CATALOG_NAME}/${name}`),
    );

    // The row's fields rather than its padding, which widens with whatever else the catalog holds.
    const row = (await cli("search", "*")).stdout
      .split("\n")
      .find((line) => line.trimStart().startsWith(`${HOOK_NAME} `));
    expect(row?.replace(/\s+/g, " ").trim()).toBe(
      `${HOOK_NAME} ${CATALOG_NAME} PreToolUse hook.sh (shipped)`,
    );
  });

  it("keeps both catalogs' copies of a duplicate hook name, each with its own definition", async () => {
    await writeCollidingCatalog(SECOND_CATALOG);
    await writeHookIn("catalog", HOOK_NAME, [
      "event: Stop",
      "type: command",
      "command: npx company-notify",
    ]);
    await writeHookIn(SECOND_CATALOG, HOOK_NAME, [
      "event: Stop",
      "type: command",
      "command: npx jane-notify",
    ]);
    await writeCatalogOrder([SECOND_CATALOG]);

    const view = await merged();

    // Two entries for the contested name, in catalog order, each carrying its own `command` — which
    // is what says the merge kept both definitions rather than one label twice.
    expect(view.hooks.filter((hook) => hook.name === HOOK_NAME)).toEqual([
      expect.objectContaining({
        name: HOOK_NAME,
        catalog: CATALOG_NAME,
        command: "npx company-notify",
      }),
      expect.objectContaining({
        name: HOOK_NAME,
        catalog: SECOND_CATALOG,
        command: "npx jane-notify",
      }),
    ]);
  });
});

/**
 * The command surface itself — which commands exist, what flags each takes, and what one whose
 * behaviour is not wired up does. Each command's own behaviour is its own suite's.
 *
 * It is **flat**, and that is what these cases pin. `catalog` was a command group, holding every
 * command whose subject was one catalog directory: it answered to `--catalog <dir>` where a consumer
 * command answered to `--project <dir>`, and it withheld `--offline` because a directory read off disk
 * resolves no source. Every project is a catalog now — it lists itself as `source: path:.` — so there
 * is one subject, `ambit validate` covers what `ambit catalog validate` covered, and the word is gone
 * from the surface rather than left standing over nothing.
 */
describe("the command surface", () => {
  /** Every command the surface declares, which is every command a user can type. */
  const COMMANDS = COMMAND_SPECS.map((spec) => spec.name);

  /**
   * A command's usage, read by running `--help` through the CLI. That is only testable in-process
   * because a subcommand inherits `exitOverride` and `configureOutput` (A30); before that it took the
   * worker with it, and the help text had to be read off the built `Command` instead.
   */
  async function usage(...words: readonly string[]): Promise<string> {
    const result = await invoke([...words, "--help"]);
    expect(result.code, result.stderr).toBe(ExitCode.Success);
    return result.stdout;
  }

  it("dumps the merged catalog under `ambit search`", async () => {
    const dump = await cli("search", "*");

    expect(dump.code, dump.stderr).toBe(ExitCode.Success);
    expect(dump.stdout).toContain(CATALOG_NAME);
  });

  it("emits the merged catalog as JSON", async () => {
    const dump = await cli("search", "*", "--json");

    expect(dump.code, dump.stderr).toBe(ExitCode.Success);
    expect(JSON.parse(dump.stdout)).toMatchObject({ catalogs: [CATALOG_NAME] });
  });

  it("declares no command group, so no invocation is two words", () => {
    // The flatness itself, asserted on the specs rather than on any one command: a group reintroduced
    // by accident — or a `catalog` spec surviving a rebase — fails here rather than in whichever case
    // happens to type its name.
    for (const spec of COMMAND_SPECS) expect(spec.subcommands, spec.name).toBeUndefined();
  });

  it("does not answer to `ambit catalog`, which is not a command any more", async () => {
    for (const argv of [["catalog"], ["catalog", "validate"], ["catalog", "dump"]]) {
      const result = await invoke(argv);

      expect(result.code, argv.join(" ")).toBe(ExitCode.Config);
      expect(result.stderr).toContain("unknown command 'catalog'");
      expect(result.stdout).toBe("");
    }
  });

  it("gives every command the same three global flags, and none of them a `--catalog` directory", async () => {
    // One subject, one directory flag. `--offline` is uniform for the same reason: the rule that
    // withheld it existed for the catalog commands, and there are none. `ambit search --catalog
    // <name>` is not that flag returning — it names a catalog to search rather than a directory to
    // read a catalog out of — so what is asserted is the spelling that would mean the old thing.
    for (const name of COMMANDS) {
      const help = await usage(name);

      expect(help, name).toContain("--project <dir>");
      expect(help, name).toContain("--json");
      expect(help, name).toContain("--offline");
      expect(help, name).not.toContain("--catalog <dir>");
      if (name !== "search") expect(help, name).not.toContain("--catalog");
    }
  });

  it("reports a command with no handler as unimplemented, naming the invocation", async () => {
    // Every command the surface declares is now built, so the guard is asserted against a program built
    // with one handler removed rather than against a gap in the surface: this is what a later task
    // adding a spec before its behaviour must see, instead of a command that silently succeeds.
    const withoutValidate = Object.fromEntries(
      Object.entries(HANDLERS).filter(([key]) => key !== "validate"),
    );
    const result = await invoke(["validate", "--project", projectDir], withoutValidate);

    expect(result.code, result.stderr).toBe(ExitCode.Internal);
    expect(result.stderr).toContain(`command "validate" is not implemented yet`);
    expect(result.stdout).toBe("");
  });
});

/**
 * The group seam `CommandSpec.subcommands` is, which no command in the surface declares.
 *
 * `catalog` was the only group, and `ambit validate` absorbed its last subcommand. The machinery
 * stayed — a group prints usage instead of acting, its children are keyed by the whole invocation, and
 * it takes none of the flags they take — so what is pinned here is the mechanism rather than any
 * command's behaviour, exactly as the flag-rule cases below pin `RULES` with nothing in it. Each case
 * therefore builds its own group with {@link buildCommand}, which is also how a second group would
 * arrive.
 *
 * One thing this cannot reach: a Commander-level usage error *below* the top level, which travels out
 * as an exit code only because `buildProgram` copies `exitOverride` and `configureOutput` down the
 * whole tree. That needs a nested command inside the real program, and there is none — the flat
 * surface pins the one-level case instead, under "usage errors and the exit-code contract".
 */
describe("the nested-command seam no command uses", () => {
  /** A group of one, wired to a handler that records the flags it was dispatched with. */
  function group(handlers: CommandHandlers): Command {
    return buildCommand(
      { name: "grp", summary: "a group", subcommands: [{ name: "sub", summary: "a command" }] },
      handlers,
      RULES,
      { cwd: root, stdout: () => {}, stderr: () => {} },
      () => {},
    );
  }

  it("dispatches a nested command through the handler keyed by the whole invocation", async () => {
    let seen: string | undefined;
    const command = group({
      "grp sub": (ctx) => {
        seen = typeof ctx.options.project === "string" ? ctx.options.project : undefined;
        return ExitCode.Success;
      },
    });

    await command.parseAsync(["sub", "--project", projectDir], { from: "user" });

    // Keyed by `grp sub` and not by `sub`, which is what makes two groups able to hold one leaf name.
    expect(seen).toBe(projectDir);
  });

  it("prints usage for the group itself, which has no action of its own", async () => {
    const printed: string[] = [];
    const command = buildCommand(
      { name: "grp", summary: "a group", subcommands: [{ name: "sub", summary: "a command" }] },
      HANDLERS,
      RULES,
      { cwd: root, stdout: (line) => printed.push(line), stderr: () => {} },
      () => {},
    );

    await command.parseAsync([], { from: "user" });

    expect(printed.join("\n")).toContain("Usage: grp");
    // And the group carries none of the flags its children do, rather than silently eating them.
    for (const flag of ["--project", "--json", "--offline"]) {
      expect(command.options.some((option) => option.long === flag)).toBe(false);
    }
  });
});

/**
 * Spec §6's exit-code contract for a *Commander*-level usage error — an unknown flag, a missing
 * argument. It has to leave through `run()` as a code and print through ambit's own output, exactly as
 * one of ambit's own errors does.
 *
 * A subcommand added with `addCommand` inherits neither of the two settings that make that true, so
 * before A30 every case here wrote to the real stderr and called `process.exit`, taking the test worker
 * with it. `inheritSettings` in `src/cli/program.ts` is what fixes it, and every command in a flat
 * surface is one level down from the program — so one level down is the depth these cases assert. The
 * two that asserted it two levels down went with `catalog validate`, the last nested command there was.
 */
describe("usage errors and the exit-code contract", () => {
  it("returns an exit code for an unknown flag, with Commander's suggestion", async () => {
    const result = await invoke(["validate", "--jsonn", "--project", projectDir]);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("error: unknown option '--jsonn'");
    // Commander's suggestion is half of what makes the message useful, and it reaches the reader only
    // through ambit's own writer.
    expect(result.stderr).toContain("--json");
    // Refused before the handler ran, so nothing it would have printed reached stdout.
    expect(result.stdout).toBe("");
  });

  it("prints a command's usage on `--help`, at exit 0", async () => {
    const result = await invoke(["validate", "--help"]);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("Usage: ambit validate");
    expect(result.stderr).toBe("");
  });

  it("returns an exit code for a missing argument", async () => {
    const result = await invoke(["why", "--project", projectDir]);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("error: missing required argument 'kind:name'");
    expect(result.stdout).toBe("");
  });

  it("refuses `--quiet` and `--no-color`, which no command accepts", async () => {
    // Both were once accepted everywhere and read nowhere: ambit prints no progress chatter to
    // suppress and no color to disable. Rejecting them is the intended behaviour — a script passing
    // `--quiet` should hear that ambit cannot honour it, not be silently ignored.
    for (const flag of ["--quiet", "--no-color"]) {
      const result = await invoke(["status", flag]);

      expect(result.code).toBe(ExitCode.Config);
      expect(result.stderr).toContain(`error: unknown option '${flag}'`);
      expect(result.stdout).toBe("");
    }
  });
});

/**
 * The flag-rule seam Commander runs before it dispatches (`RULES` in `src/cli/program.ts`): a rule
 * declared with its command as a `preAction` hook, for the refusals `.makeOptionMandatory()` and
 * `.conflicts()` cannot word without giving up the message shape required.
 *
 * `RULES` holds two entries, and they are one rule twice — `outdated` and `update` both refusing
 * `--offline`, whose wording `test/project/update.test.ts` pins. So what is pinned here is the
 * mechanism rather than any command's wording: a rule refuses *before* the handler, and it runs once,
 * for the command it belongs to. Each case therefore injects its own rule, which is also how the seam
 * is exercised by a command that has none.
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

  it("declares a rule only for the two commands that refuse `--offline`", () => {
    expect(Object.keys(RULES).sort()).toEqual(["outdated", "update"]);
    // One rule twice, not two rules that agree today: `outdated` and `update` ask a remote the same
    // question, so their refusal cannot drift apart.
    expect(RULES.outdated).toBe(RULES.update);
  });

  it("refuses before the handler, in ambit's own message shape", async () => {
    const stubbed = stub("validate");
    const rules: CommandRules = {
      validate: () => {
        throw new AmbitError(ExitCode.Config, "refused by a rule (mcps/x.yml)", [
          "do something else",
        ]);
      },
    };

    const result = await invoke(["validate", "--project", projectDir], stubbed.handlers, rules);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refused by a rule (mcps/x.yml)");
    expect(result.stderr).toContain("do something else");
    expect(stubbed.reached()).toBe(false);
  });

  it("dispatches to the handler once a rule accepts the flags it was given", async () => {
    // The control on the case above: a hook wired to the wrong key, or one that refused everything,
    // would pass that one and fail here.
    const stubbed = stub("validate");
    const rules: CommandRules = { validate: () => {} };

    const result = await invoke(["validate", "--project", projectDir], stubbed.handlers, rules);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(stubbed.reached()).toBe(true);
  });

  it("runs a rule exactly once, for the command it belongs to", async () => {
    // Commander fires a `preAction` hook for the command that acted and for each of its ancestors, so
    // a rule that hung off a *group* would also see its children's invocations. Only a leaf carries
    // one, and a leaf has nothing below it — this is the case that fails if a rule is ever attached
    // further up.
    const seen: (string | undefined)[] = [];
    const rules: CommandRules = {
      validate: (ctx) => {
        seen.push(typeof ctx.options.project === "string" ? ctx.options.project : undefined);
      },
    };
    // Stubbed, so what is asserted is how often the hook fired rather than what the real command
    // makes of the project it was pointed at.
    const stubbed = stub("validate");

    const result = await invoke(["validate", "--project", projectDir], stubbed.handlers, rules);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(seen).toEqual([projectDir]);
    expect(stubbed.reached()).toBe(true);
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

  it("keeps every catalog's copy of a duplicate name, grouped by name then catalog", async () => {
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
    // Two identical catalogs, so every name is provided twice and nothing is dropped.
    expect(merged.skills).toHaveLength(8);
    expect(merged.skills.map((skill) => `${skill.name} ${skill.catalog}`)).toEqual([
      `acme-brief ${CATALOG_NAME}`,
      "acme-brief personal",
      `code-review ${CATALOG_NAME}`,
      "code-review personal",
      `company-context ${CATALOG_NAME}`,
      "company-context personal",
      `design-tokens ${CATALOG_NAME}`,
      "design-tokens personal",
    ]);
  });
});

/**
 * Spec §4.4–§4.5: several catalogs merge into one namespace per kind, and **every** copy of a name
 * survives — `catalogs:` order settles nothing, because there is no precedence left to establish.
 *
 * A name two catalogs provide is a non-event here. It becomes a refusal only where a project selects
 * both copies, and then at resolve rather than at the merge: harness layout is flat, so the two would
 * be installed at one path, and choosing one would be ambit deciding which half of the request the
 * project meant.
 *
 * The second catalog is written per test rather than added to the shared fixture: a catalog whose
 * whole purpose is to collide with another one has no business in the tree every other profile
 * resolves against.
 */
describe("multi-catalog merge", () => {
  const SECOND = "personal";
  const THIRD = "backup";

  it("keeps both catalogs' copies of a duplicate name", async () => {
    await writeCollidingCatalog(SECOND);
    await writeCatalogOrder([SECOND]);

    const view = await merged();

    expect(view.catalogs).toEqual([CATALOG_NAME, SECOND]);
    expect(
      view.skills.filter((skill) => skill.name === CORE_SKILL).map((skill) => skill.catalog),
    ).toEqual([CATALOG_NAME, SECOND]);
    expect(view.mcps.filter((mcp) => mcp.name === "linter").map((mcp) => mcp.catalog)).toEqual([
      CATALOG_NAME,
      SECOND,
    ]);
  });

  it("keeps what one catalog alone provides, exactly once", async () => {
    await writeCollidingCatalog(SECOND);
    await writeCatalogOrder([SECOND]);

    const view = await merged();

    expect(view.skills.filter((skill) => skill.name === OWN_SKILL)).toEqual([
      expect.objectContaining({ name: OWN_SKILL, catalog: SECOND }),
    ]);
  });

  it("keeps each copy's own definition, not one body under two catalog names", async () => {
    // The transports differ, so this is the assertion that both bodies are in the merged view rather
    // than one of them twice — and that a name-keyed JSON record did not quietly drop one.
    await writeCollidingCatalog(SECOND);
    await writeCatalogOrder([SECOND]);

    const dumped = JSON.parse((await cli("search", "*", "--json")).stdout) as {
      mcps: Record<string, { catalog: string; transport: Record<string, unknown> }>;
    };

    expect(dumped.mcps[`${CATALOG_NAME}/linter`]).toMatchObject({
      catalog: CATALOG_NAME,
      transport: { kind: "http" },
    });
    expect(dumped.mcps[`${SECOND}/linter`]).toMatchObject({
      catalog: SECOND,
      transport: { kind: "stdio", command: `${SECOND}-mcp` },
    });
  });

  it("keeps all three copies when three catalogs provide one name", async () => {
    await writeCollidingCatalog(SECOND);
    await writeCollidingCatalog(THIRD);
    await writeCatalogOrder([SECOND, THIRD]);

    // In catalog order rather than config order: the merged view is sorted by name and then catalog,
    // so which copy is listed first depends on the names alone.
    expect(
      (await merged()).skills
        .filter((skill) => skill.name === CORE_SKILL)
        .map((skill) => skill.catalog),
    ).toEqual([THIRD, CATALOG_NAME, SECOND]);
  });

  it("refuses a selection that reaches both copies of a skill, naming both catalogs", async () => {
    // Two entries, one per catalog: reaching both copies is something a qualified address makes a
    // project ask for deliberately, which is exactly why refusing it is not second-guessing anyone.
    await writeCollidingCatalog(SECOND);
    await writeCatalogOrder(
      [SECOND],
      [
        `  - { skill: "${CATALOG_NAME}/${CORE_SKILL}" }`,
        `  - { skill: "${SECOND}/${CORE_SKILL}" }`,
      ],
    );

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain(`skill "${CORE_SKILL}" is selected from more than one catalog`);
    expect(result.stderr).toContain(`provided by: ${CATALOG_NAME}, ${SECOND}`);
    expect(result.stderr).toContain(
      "a harness reads one entry per name, so both copies would be installed at the same path",
    );
    expect(result.stderr).toContain(
      "select only one copy: narrow a `requires` pattern, or drop the entry that reaches the other catalog",
    );
  });

  it("refuses a selected MCP server two catalogs provide, as it does a skill", async () => {
    // Both catalogs ship a `linter`, and no skill is named twice — so this is the namespace the
    // refusal is reported for.
    await writeCollidingCatalog(SECOND);
    await writeCatalogOrder(
      [SECOND],
      [`  - { mcp: "${CATALOG_NAME}/linter" }`, `  - { mcp: "${SECOND}/linter" }`],
    );

    const result = await cli("resolve");

    expect(result.code).toBe(ExitCode.Resolution);
    expect(result.stderr).toContain('MCP server "linter" is selected from more than one catalog');
  });

  it("resolves normally, with no whose-copy column, when one copy is selected", async () => {
    // A pack only the second catalog holds a member for, so two catalogs are configured and nothing
    // collides. `--explain` ends at the reason: there is nothing left to say about which copy this is.
    await writeCollidingCatalog(SECOND);
    await writeCatalogOrder([SECOND], [`  - { skill: "${SECOND}/${OWN_SKILL}" }`]);

    const result = await cli("resolve", "--explain");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        "packs (0)",
        "  (none)",
        "",
        "skills (1)",
        `  ${OWN_SKILL}  ${SECOND}  skill:${SECOND}/${OWN_SKILL}`,
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

  it("carries nothing about other copies into `--explain --json`", async () => {
    await writeCollidingCatalog(SECOND);
    await writeCatalogOrder([SECOND], [requiresEntry("person.jane", SECOND)]);

    const explained = JSON.parse((await cli("resolve", "--explain", "--json")).stdout) as {
      skills: Record<string, Record<string, unknown>>;
    };

    // Keyed by name, because a bundle holds one item per name — the collision refusal is what makes
    // that true — and carrying only what the bundle knows: where it came from, and why.
    expect(Object.keys(explained.skills)).toEqual([OWN_SKILL]);
    expect(explained.skills[OWN_SKILL]).toEqual({
      catalog: SECOND,
      path: `skills/${OWN_SKILL}`,
      reason: "required-by:pack:person.jane",
    });
  });
});

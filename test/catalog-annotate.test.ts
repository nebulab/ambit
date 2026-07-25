/**
 * `ambit catalog annotate` (spec §6, "Catalog authoring") — changing what an item declares.
 *
 * This is the one authoring command that edits the *inside* of a hand-written document, so the suite is
 * built around authoring rule 2: several cases assert the whole file against the fixture's own bytes with
 * exactly one substitution, which is the only way to catch an edit that also reflowed a list, moved a key,
 * or dropped the comment above one. The annotated-skill fixture carries an unknown harness key, a comment,
 * a flow list, a block list, and a body for that reason — the five things rule 2 protects.
 *
 * The other two claims: a list ambit rewrites comes out sorted and deduplicated, while a list whose
 * membership the request would not change is left byte-for-byte alone (which is what makes annotating
 * twice a genuine no-op); and every refusal costs nothing, so each one asserts the whole tree is untouched.
 *
 * Everything runs against a per-test copy of the fixture catalog. The shared fixture must stay clean: it
 * is what the golden profiles resolve against.
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIXTURE_CATALOG_FILES, buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import type { Catalog, CatalogSkill } from "../src/catalog.js";
import { parseCatalogDirectory } from "../src/catalog.js";
import { ExitCode } from "../src/errors.js";
import type { McpEntity } from "../src/mcp.js";
import { run } from "../src/program.js";

/** The fixture's `core` skill: one flow-listed scope, nothing else annotated. */
const CORE_SKILL = "acme.commons.use-company-context";
const CORE_SKILL_FILE = "skills/acme/commons/use-company-context/SKILL.md";

/** A fixture skill nothing requires and which requires nothing, so pointing at it cannot cycle. */
const REVIEW_SKILL = "acme.engineering.use-code-review";

/** The fixture's project skill, the one that already declares every annotation. */
const PROJECT_SKILL = "acme.projects.use-acme-brief";
const PROJECT_SKILL_FILE = "skills/acme/projects/use-acme-brief/SKILL.md";

/** The fixture's two servers: one scoped, one carrying no `scopes` key at all. */
const SCOPED_MCP = "scoped";
const SCOPED_MCP_FILE = "mcps/scoped.yml";
const UNSCOPED_MCP = "fixture";
const UNSCOPED_MCP_FILE = "mcps/fixture.yml";

/** Registered scopes the cases move around. */
const CORE_SCOPE = "core";
const ENGINEERING = "function.engineering";
const PROJECT_SCOPE = "project.acme";

/** A skill carrying a harness key ambit knows nothing about, a comment, and a body. */
const CLOSE_SKILL = "acme.sales.use-close";
const CLOSE_SKILL_FILE = "skills/acme/sales/use-close/SKILL.md";

const CLOSE_SKILL_TEXT = `---
name: acme.sales.use-close
description: Calls the Close CRM REST API.
# Bash stays out of this one: the skill only ever reads.
allowed-tools: [Read, Grep]
scopes: [core]
requires:
  - acme.commons.use-company-context
env: [CLOSE_API_KEY]
---

# Close CRM

The body, which no edit may touch.
`;

let root: string;
let catalogDir: string;

interface CliResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/** Runs the CLI exactly as given. An authoring command takes `--catalog`, never `--project`. */
async function invoke(...argv: readonly string[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Runs an annotate command against the catalog under test. */
async function annotate(...argv: readonly string[]): Promise<CliResult> {
  return invoke("catalog", "annotate", ...argv, "--catalog", catalogDir);
}

/** Runs one, asserting it succeeded. */
async function succeeds(...argv: readonly string[]): Promise<CliResult> {
  const result = await annotate(...argv);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** Runs one, asserting it was refused with `code` and that nothing on disk moved. */
async function refused(code: ExitCode, ...argv: readonly string[]): Promise<CliResult> {
  const before = await snapshot();
  const result = await annotate(...argv);

  expect(result.code, result.stdout).toBe(code);
  expect(result.stdout).toBe("");
  expect(await snapshot()).toEqual(before);
  return result;
}

async function read(file: string): Promise<string> {
  return readFile(path.join(catalogDir, file), "utf8");
}

async function write(file: string, text: string): Promise<void> {
  const target = path.join(catalogDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

/** Every file in the catalog with its bytes, so "nothing was written" can be asserted as a whole. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const inner = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), inner);
      else files[inner] = await readFile(path.join(dir, entry.name), "utf8");
    }
  };
  await walk(catalogDir, "");
  return files;
}

/** The fixture's own bytes for a file, as written before any command ran. */
function fixture(file: string): string {
  return FIXTURE_CATALOG_FILES[file] ?? "";
}

/** The catalog as the parser reads it back. */
async function parsed(): Promise<Catalog> {
  return parseCatalogDirectory("subject", `path:${catalogDir}`, catalogDir);
}

async function skill(name: string): Promise<CatalogSkill | undefined> {
  return (await parsed()).skills.find((candidate) => candidate.name === name);
}

async function server(name: string): Promise<McpEntity | undefined> {
  return (await parsed()).mcps.find((candidate) => candidate.name === name);
}

/** `ambit validate` against the catalog: what every mutation has to leave passing. */
async function validates(): Promise<CliResult> {
  const result = await invoke("validate", "--catalog", catalogDir);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-annotate-"));
  catalogDir = path.join(root, "catalog");
  await buildFixtureCatalog(catalogDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit catalog annotate, on a skill", () => {
  it("adds a scope, leaving every other byte of the document alone", async () => {
    await succeeds(CORE_SKILL, "--add-scope", ENGINEERING);

    expect(await read(CORE_SKILL_FILE)).toBe(
      fixture(CORE_SKILL_FILE).replace(
        `scopes: [${CORE_SCOPE}]`,
        `scopes: [${CORE_SCOPE}, ${ENGINEERING}]`,
      ),
    );
    await validates();
  });

  it("sorts and deduplicates the list it rewrites, so argv order is not information", async () => {
    await succeeds(
      CORE_SKILL,
      "--add-scope",
      PROJECT_SCOPE,
      "--add-scope",
      ENGINEERING,
      "--add-scope",
      PROJECT_SCOPE,
    );

    expect((await skill(CORE_SKILL))?.scopes).toEqual([CORE_SCOPE, ENGINEERING, PROJECT_SCOPE]);
    await validates();
  });

  it("removes an entry, and leaves an empty list rather than a removed key", async () => {
    await succeeds(CORE_SKILL, "--remove-scope", CORE_SCOPE);

    // "Declares none" and "says nothing" read the same to the parser, but only one of them is a
    // statement the author made — a command that deleted the key would undo the annotation.
    expect(await read(CORE_SKILL_FILE)).toBe(
      fixture(CORE_SKILL_FILE).replace(`scopes: [${CORE_SCOPE}]`, "scopes: []"),
    );
    expect((await skill(CORE_SKILL))?.scopes).toEqual([]);
    await validates();
  });

  it("adds and removes across every annotation in one run", async () => {
    await succeeds(
      PROJECT_SKILL,
      "--add-scope",
      CORE_SCOPE,
      "--remove-requires",
      CORE_SKILL,
      "--add-env",
      "ACME_BRIEF_TOKEN",
    );

    expect(await skill(PROJECT_SKILL)).toMatchObject({
      scopes: [CORE_SCOPE, PROJECT_SCOPE],
      requires: ["mcp.fixture"],
      env: ["ACME_BRIEF_TOKEN"],
    });
    await validates();
  });

  it("keeps an unknown harness key, the comment above it, the layouts, and the body", async () => {
    await write(CLOSE_SKILL_FILE, CLOSE_SKILL_TEXT);

    await succeeds(CLOSE_SKILL, "--add-env", "CLOSE_BASE_URL");

    // One substitution, in a file carrying `allowed-tools`, a comment, a flow list, a block list, and
    // prose: everything rule 2 protects is asserted by the equality rather than by five assertions.
    expect(await read(CLOSE_SKILL_FILE)).toBe(
      CLOSE_SKILL_TEXT.replace(
        "env: [CLOSE_API_KEY]",
        "env: [CLOSE_API_KEY, CLOSE_BASE_URL]",
      ),
    );
    await validates();
  });

  it("writes a key the document never had at the end, as a block sequence", async () => {
    await succeeds(CORE_SKILL, "--add-requires", REVIEW_SKILL);

    // A key ambit adds has no layout to preserve, so it takes ambit's own (spec §3.0) and lands after
    // the keys that were already there rather than being sorted into them.
    expect(await read(CORE_SKILL_FILE)).toBe(
      fixture(CORE_SKILL_FILE).replace(
        `scopes: [${CORE_SCOPE}]\n---`,
        `scopes: [${CORE_SCOPE}]\nrequires:\n  - ${REVIEW_SKILL}\n---`,
      ),
    );
    await validates();
  });

  it("removes a scope the registry does not hold, which is how a broken catalog is fixed", async () => {
    // `catalog scope rm` refuses while anything declares the scope, so this is the only way out — and a
    // pre-check on removals would make the one command that can fix such a catalog refuse to run.
    await write(
      CORE_SKILL_FILE,
      fixture(CORE_SKILL_FILE).replace(
        `scopes: [${CORE_SCOPE}]`,
        `scopes: [${CORE_SCOPE}, ghost.scope]`,
      ),
    );

    await succeeds(CORE_SKILL, "--remove-scope", "ghost.scope");

    expect(await read(CORE_SKILL_FILE)).toBe(fixture(CORE_SKILL_FILE));
    await validates();
  });
});

describe("ambit catalog annotate, on an MCP entity", () => {
  it("adds and removes a server's scopes", async () => {
    await succeeds("mcp.scoped", "--add-scope", CORE_SCOPE, "--remove-scope", ENGINEERING);

    expect(await read(SCOPED_MCP_FILE)).toBe(
      fixture(SCOPED_MCP_FILE).replace(`scopes: [${ENGINEERING}]`, `scopes: [${CORE_SCOPE}]`),
    );
    expect((await server(SCOPED_MCP))?.scopes).toEqual([CORE_SCOPE]);
    await validates();
  });

  it("edits the file the author wrote, not the extension ambit would have chosen", async () => {
    // §3.3 accepts `.yaml` too, and writing the `.yml` a name *would* take would leave two files
    // defining one server — which parsing rejects.
    await rename(path.join(catalogDir, SCOPED_MCP_FILE), path.join(catalogDir, "mcps/scoped.yaml"));
    const before = await snapshot();

    const result = await succeeds("mcp.scoped", "--add-scope", CORE_SCOPE);

    expect(result.stdout).toContain("  mcps/scoped.yaml  updated");
    expect(Object.keys(await snapshot())).toEqual(Object.keys(before));
    expect((await server(SCOPED_MCP))?.scopes).toEqual([CORE_SCOPE, ENGINEERING]);
    await validates();
  });

  it("adds a `scopes` key to an entity that had none, leaving its comment in place", async () => {
    await succeeds(`mcp.${UNSCOPED_MCP}`, "--add-scope", CORE_SCOPE);

    expect(await read(UNSCOPED_MCP_FILE)).toBe(
      `${fixture(UNSCOPED_MCP_FILE)}scopes:\n  - ${CORE_SCOPE}\n`,
    );
    expect((await server(UNSCOPED_MCP))?.scopes).toEqual([CORE_SCOPE]);
    await validates();
  });

  it("refuses a `requires` edit, naming the flag that does what was meant", async () => {
    const result = await refused(ExitCode.Config, "mcp.scoped", "--add-requires", CORE_SKILL);

    expect(result.stderr).toContain(
      `MCP server "${SCOPED_MCP}" declares no requirements (${SCOPED_MCP_FILE})`,
    );
    expect(result.stderr).toContain(
      `ambit catalog annotate <skill> --add-requires mcp.${SCOPED_MCP}`,
    );
  });
});

describe("ambit catalog annotate, refusals", () => {
  it("refuses an added scope the registry does not hold, suggesting the nearest one", async () => {
    const result = await refused(ExitCode.Resolution, CORE_SKILL, "--add-scope", "function.enginering");

    expect(result.stderr).toContain('unknown scope "function.enginering" (scopes.yml)');
    expect(result.stderr).toContain(`did you mean "${ENGINEERING}"?`);
  });

  it("refuses a requirement nothing in the catalog provides, and writes nothing", async () => {
    const result = await refused(ExitCode.Resolution, CORE_SKILL, "--add-requires", "acme.absent");

    // No pre-check here: validation's own message already names the unresolvable requirement, and
    // there is no better advice to add.
    expect(result.stderr).toContain("refusing to write: the result would not validate");
    expect(result.stderr).toContain('"acme.absent"');
  });

  it("refuses a skill the catalog does not provide", async () => {
    const result = await refused(ExitCode.Resolution, "acme.absent", "--add-scope", CORE_SCOPE);

    expect(result.stderr).toContain('unknown skill "acme.absent" (skills/acme/absent/SKILL.md)');
  });

  it("refuses a server the catalog does not provide", async () => {
    const result = await refused(ExitCode.Resolution, "mcp.absent", "--add-scope", CORE_SCOPE);

    expect(result.stderr).toContain('unknown MCP server "absent" (mcps/absent.yml)');
  });

  it("refuses an invocation that names no change at all", async () => {
    const result = await refused(ExitCode.Config, CORE_SKILL);

    expect(result.stderr).toContain(`\`annotate ${CORE_SKILL}\` names no change (skills)`);
    expect(result.stderr).toContain("--add-scope, --remove-scope");
  });

  it("refuses adding and removing the same entry in one run", async () => {
    const result = await refused(
      ExitCode.Config,
      CORE_SKILL,
      "--add-scope",
      CORE_SCOPE,
      "--remove-scope",
      CORE_SCOPE,
    );

    expect(result.stderr).toContain(
      `\`--add-scope ${CORE_SCOPE}\` and \`--remove-scope ${CORE_SCOPE}\` contradict each other (skills)`,
    );
  });
});

describe("ambit catalog annotate, idempotence", () => {
  it("writes nothing the second time, down to the modification time", async () => {
    await succeeds(CORE_SKILL, "--add-scope", ENGINEERING);
    const before = await snapshot();

    const again = await succeeds(CORE_SKILL, "--add-scope", ENGINEERING);

    expect(again.stdout).toContain("files (0)");
    expect(await snapshot()).toEqual(before);
  });

  it("leaves a list whose membership it would not change exactly as the author wrote it", async () => {
    // Unsorted on purpose: a command that rewrote the list anyway would reorder entries nobody asked it
    // to touch, which is the reformatting authoring rule 2 forbids.
    const unsorted = CLOSE_SKILL_TEXT.replace(
      "env: [CLOSE_API_KEY]",
      "env: [CLOSE_TOKEN, CLOSE_API_KEY]",
    );
    await write(CLOSE_SKILL_FILE, unsorted);

    const result = await succeeds(CLOSE_SKILL, "--add-env", "CLOSE_TOKEN");

    expect(result.stdout).toContain("files (0)");
    expect(await read(CLOSE_SKILL_FILE)).toBe(unsorted);
  });

  it("reports success and no files when what it was asked to remove is not there", async () => {
    const before = await snapshot();

    const result = await succeeds(CORE_SKILL, "--remove-env", "ABSENT_VAR");

    expect(result.stdout).toContain("files (0)");
    expect(await snapshot()).toEqual(before);
  });
});

describe("ambit catalog annotate, output", () => {
  it("names the subject, then what it declares, then the file that took", async () => {
    const result = await succeeds(CORE_SKILL, "--add-scope", ENGINEERING);

    expect(result.stdout).toBe(
      [
        `skill ${CORE_SKILL}`,
        "",
        "declares (3)",
        `  scopes    ${CORE_SCOPE}, ${ENGINEERING}`,
        "  requires  -",
        "  env       -",
        "",
        "files (1)",
        `  ${CORE_SKILL_FILE}  updated`,
      ].join("\n"),
    );
  });

  it("leaves `requires` out for a server, which cannot declare one", async () => {
    const result = await succeeds(`mcp.${SCOPED_MCP}`, "--add-scope", CORE_SCOPE);

    expect(result.stdout).toBe(
      [
        `mcp ${SCOPED_MCP}`,
        "",
        "declares (2)",
        `  scopes  ${CORE_SCOPE}, ${ENGINEERING}`,
        "  env     SCOPED_API_KEY",
        "",
        "files (1)",
        `  ${SCOPED_MCP_FILE}  updated`,
      ].join("\n"),
    );
  });

  it("carries the resulting annotations and the file's bytes in --json", async () => {
    const result = await succeeds(PROJECT_SKILL, "--add-env", "ACME_BRIEF_TOKEN", "--json");
    const report = JSON.parse(result.stdout) as {
      annotated: {
        declares: Record<string, readonly string[]>;
        file: string;
        kind: string;
        name: string;
      };
      files: readonly { file: string; text: string }[];
      written: boolean;
    };

    expect(report.annotated).toEqual({
      declares: {
        scopes: [PROJECT_SCOPE],
        requires: [CORE_SKILL, "mcp.fixture"],
        env: ["ACME_BRIEF_TOKEN"],
      },
      file: PROJECT_SKILL_FILE,
      kind: "skill",
      name: PROJECT_SKILL,
    });
    expect(report.files).toEqual([
      { file: PROJECT_SKILL_FILE, text: await read(PROJECT_SKILL_FILE) },
    ]);
    expect(report.written).toBe(true);
  });

  it("under --dry-run, prints the diff and writes nothing", async () => {
    const before = await snapshot();

    const result = await succeeds(CORE_SKILL, "--add-scope", ENGINEERING, "--dry-run");

    expect(result.stdout).toContain("would declare (3)");
    expect(result.stdout).toContain(`  ${CORE_SKILL_FILE} (updated)`);
    expect(result.stdout).toContain(`+ scopes: [${CORE_SCOPE}, ${ENGINEERING}]`);
    expect(await snapshot()).toEqual(before);
  });
});

/**
 * `ambit catalog scope add|rm|mv` (spec §6, "Catalog authoring") — maintaining `scopes.yml`.
 *
 * Three claims carry this suite, and all three are about bytes. The first is fidelity: the registry is
 * hand-maintained, so a comment, a quoting style, or an entry's position that moves is a bug even when the
 * result parses the same — which is why the cases assert whole files against the fixture's own text rather
 * than reading fields back. The second is that the subtree is the unit: renaming a scope renames what
 * holding it selects (spec §2), and rewrites every skill and server declaring any of it, in one edit.
 * The third is that a refusal costs nothing — every rejection asserts the tree is untouched, since an
 * exit code says nothing about what was already half-written.
 *
 * Everything runs against a per-test copy of the fixture catalog. The shared fixture must stay clean: it
 * is what the golden profiles resolve against.
 */
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIXTURE_CATALOG_FILES, buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import { parseCatalogDirectory } from "../src/catalog.js";
import { ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";

/** The scope the fixture nests one level, and the two files that declare either end of it. */
const PARENT = "function.engineering";
const CHILD = "function.engineering.frontend";
const RENAMED_PARENT = "team.engineering";

const REGISTRY = "scopes.yml";
const CODE_REVIEW = "skills/acme/engineering/use-code-review/SKILL.md";
const DESIGN_TOKENS = "skills/acme/engineering/frontend/use-design-tokens/SKILL.md";
const SCOPED_MCP = "mcps/scoped.yml";

/** Every file `mv function.engineering` touches, in the path order the command reports them. */
const RENAMED_FILES = [SCOPED_MCP, REGISTRY, DESIGN_TOKENS, CODE_REVIEW];

const JANE = "person.jane";
const JANE_DESCRIPTION = "Jane's own things";

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

/** Runs a scope command against the catalog under test. */
async function scope(...argv: readonly string[]): Promise<CliResult> {
  return invoke("catalog", "scope", ...argv, "--catalog", catalogDir);
}

/** Runs one, asserting it succeeded. */
async function succeeds(...argv: readonly string[]): Promise<CliResult> {
  const result = await scope(...argv);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** Runs one, asserting it was refused with `code` and that nothing on disk moved. */
async function refused(code: ExitCode, ...argv: readonly string[]): Promise<CliResult> {
  const before = await snapshot();
  const result = await scope(...argv);

  expect(result.code, result.stdout).toBe(code);
  expect(result.stdout).toBe("");
  expect(await snapshot()).toEqual(before);
  return result;
}

async function read(file: string): Promise<string> {
  return readFile(path.join(catalogDir, file), "utf8");
}

async function write(file: string, text: string): Promise<void> {
  await writeFile(path.join(catalogDir, file), text, "utf8");
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

/** The registry as the parser reads it back. */
async function registeredScopes(): Promise<Readonly<Record<string, string>>> {
  const catalog = await parseCatalogDirectory("subject", `path:${catalogDir}`, catalogDir);
  return Object.fromEntries(catalog.scopes.map((definition) => [definition.name, definition.description]));
}

/** `ambit validate` against the catalog: what every mutation has to leave passing. */
async function validates(): Promise<CliResult> {
  const result = await invoke("validate", "--catalog", catalogDir);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-scope-"));
  catalogDir = path.join(root, "catalog");
  await buildFixtureCatalog(catalogDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit catalog scope add", () => {
  it("appends an entry, leaving every byte above it alone", async () => {
    await succeeds("add", JANE, "--description", JANE_DESCRIPTION);

    expect(await read(REGISTRY)).toBe(
      `${fixture(REGISTRY)}  ${JANE}:\n    description: ${JANE_DESCRIPTION}\n`,
    );
    await validates();
  });

  it("registers a scope the parser then reads back, and nothing else", async () => {
    await succeeds("add", JANE, "--description", JANE_DESCRIPTION);

    expect(await registeredScopes()).toEqual({
      core: "The universal floor — context everyone needs",
      [PARENT]: "Building and shipping software",
      [CHILD]: "Browser-side work: components, styling, accessibility",
      "project.acme": "The Acme engagement",
      [JANE]: JANE_DESCRIPTION,
    });
  });

  it("writes nothing at all the second time, and says so", async () => {
    const first = await succeeds("add", JANE, "--description", JANE_DESCRIPTION);
    const after = await read(REGISTRY);

    const second = await succeeds("add", JANE, "--description", JANE_DESCRIPTION);

    expect(first.stdout).toContain("files (1)");
    expect(second.stdout).toContain("files (0)");
    // Still "registered", not "would register": a no-op run is not a preview.
    expect(second.stdout).toContain("registered (1)");
    expect(await read(REGISTRY)).toBe(after);
  });

  it("gives an existing scope the description it is asked for, since nothing else edits one", async () => {
    await succeeds("add", PARENT, "--description", "Shipping client software");

    expect((await registeredScopes())[PARENT]).toBe("Shipping client software");
    expect(await read(REGISTRY)).toBe(
      fixture(REGISTRY).replace(
        "description: Building and shipping software",
        "description: Shipping client software",
      ),
    );
  });

  it("quotes a description that would otherwise come back as something else", async () => {
    await succeeds("add", "release.v1", "--description", "1.5");

    // §3.0's central rule, on ambit's own writes: a value that identifies something arrives as a string.
    expect(await read(REGISTRY)).toContain('description: "1.5"');
    expect((await registeredScopes())["release.v1"]).toBe("1.5");
  });

  it("prints what it registered and which file that took", async () => {
    const result = await succeeds("add", JANE, "--description", JANE_DESCRIPTION);

    expect(result.stdout).toBe(
      [
        "registered (1)",
        `  ${JANE}  ${JANE_DESCRIPTION}`,
        "",
        "files (1)",
        `  ${REGISTRY}`,
      ].join("\n"),
    );
  });

  it("carries the registry's new bytes in --json", async () => {
    const result = await succeeds("add", JANE, "--description", JANE_DESCRIPTION, "--json");
    const report = JSON.parse(result.stdout) as {
      files: readonly { file: string; text: string }[];
      registered: { name: string; description: string };
      written: boolean;
    };

    expect(report.written).toBe(true);
    expect(report.registered).toEqual({ description: JANE_DESCRIPTION, name: JANE });
    expect(report.files).toEqual([{ file: REGISTRY, text: await read(REGISTRY) }]);
  });

  it("refuses a scope with no description, writing nothing", async () => {
    const result = await refused(ExitCode.Config, "add", JANE);

    expect(result.stderr).toContain(`scope "${JANE}" needs a description (${REGISTRY})`);
    expect(result.stderr).toContain("--description");
  });

  it("refuses a blank description, which would not parse back", async () => {
    const result = await refused(ExitCode.Config, "add", JANE, "--description", "   ");

    expect(result.stderr).toContain("needs a description");
  });

  it("refuses a name with an empty segment", async () => {
    const result = await refused(ExitCode.Config, "add", "person..jane", "--description", "x");

    expect(result.stderr).toContain('invalid scope name "person..jane"');
  });

  it("under --dry-run, prints the diff and writes nothing", async () => {
    const before = await snapshot();

    const result = await succeeds("add", JANE, "--description", JANE_DESCRIPTION, "--dry-run");

    expect(result.stdout).toContain("would register (1)");
    expect(result.stdout).toContain(`diff (1)`);
    expect(result.stdout).toContain(`  ${REGISTRY} (updated)`);
    // The entry's own indentation survives the diff's `+ ` prefix, so the addition reads as YAML.
    expect(result.stdout).toContain(`+   ${JANE}:`);
    expect(await snapshot()).toEqual(before);
  });
});

describe("ambit catalog scope rm", () => {
  it("unregisters a scope nothing declares, restoring the registry it was added to", async () => {
    await succeeds("add", JANE, "--description", JANE_DESCRIPTION);

    const result = await succeeds("rm", JANE);

    expect(result.stdout).toBe(
      ["unregistered (1)", `  ${JANE}`, "", "files (1)", `  ${REGISTRY}`].join("\n"),
    );
    expect(await read(REGISTRY)).toBe(fixture(REGISTRY));
    await validates();
  });

  it("refuses while a skill or a server still declares it, naming every declarer", async () => {
    const result = await refused(ExitCode.Resolution, "rm", PARENT);

    expect(result.stderr).toContain(`scope "${PARENT}" is still declared (${REGISTRY})`);
    expect(result.stderr).toContain(`skill "acme.engineering.use-code-review" declares it (${CODE_REVIEW})`);
    expect(result.stderr).toContain(`MCP server "scoped" declares it (${SCOPED_MCP})`);
    expect(result.stderr).toContain("remove the scope from each of them first");
  });

  it("refuses a scope the registry does not hold, naming the nearest one it does", async () => {
    const result = await refused(ExitCode.Resolution, "rm", "function.enginering");

    expect(result.stderr).toContain('unknown scope "function.enginering" (scopes.yml)');
    expect(result.stderr).toContain(`did you mean "${PARENT}"?`);
  });

  it("leaves a registered descendant registered, since a scope needs no parent", async () => {
    await succeeds("add", JANE, "--description", JANE_DESCRIPTION);
    await succeeds("add", `${JANE}.notes`, "--description", "Jane's notes");

    await succeeds("rm", JANE);

    expect(Object.keys(await registeredScopes())).toContain(`${JANE}.notes`);
    expect(Object.keys(await registeredScopes())).not.toContain(JANE);
    await validates();
  });

  it("under --dry-run, previews the removal and writes nothing", async () => {
    await succeeds("add", JANE, "--description", JANE_DESCRIPTION);
    const before = await snapshot();

    const result = await succeeds("rm", JANE, "--dry-run");

    expect(result.stdout).toContain("would unregister (1)");
    expect(result.stdout).toContain(`-   ${JANE}:`);
    expect(await snapshot()).toEqual(before);
  });
});

describe("ambit catalog scope mv", () => {
  it("renames the scope, every descendant, and every declarer of either", async () => {
    const result = await succeeds("mv", PARENT, RENAMED_PARENT);

    expect(result.stdout).toBe(
      [
        "renamed (2)",
        `  ${PARENT.padEnd(CHILD.length)}  →  ${RENAMED_PARENT}`,
        `  ${CHILD}  →  ${RENAMED_PARENT}.frontend`,
        "",
        `files (${RENAMED_FILES.length})`,
        ...RENAMED_FILES.map((file) => `  ${file}`),
        "",
        "next: update `ambit.yml` in every project that holds a renamed scope — a catalog cannot do it for them",
      ].join("\n"),
    );

    // Every touched file, byte for byte. Only the registry's keys and the declared lists changed, so the
    // comments above the registry, the flow layout of each list, and the unrelated keys are all as the
    // fixture wrote them — and so are the two skill bodies, which mention `function.engineering` in prose
    // that a textual find-and-replace would have rewritten.
    expect(await read(REGISTRY)).toBe(fixture(REGISTRY).replaceAll(PARENT, RENAMED_PARENT));
    expect(await read(SCOPED_MCP)).toBe(
      fixture(SCOPED_MCP).replace(`scopes: [${PARENT}]`, `scopes: [${RENAMED_PARENT}]`),
    );
    expect(await read(CODE_REVIEW)).toBe(
      fixture(CODE_REVIEW).replace(`scopes: [${PARENT}]`, `scopes: [${RENAMED_PARENT}]`),
    );
    expect(await read(DESIGN_TOKENS)).toBe(
      fixture(DESIGN_TOKENS).replace(`scopes: [${CHILD}]`, `scopes: [${RENAMED_PARENT}.frontend]`),
    );
    expect(await read(CODE_REVIEW)).toContain(`Selected by \`${PARENT}\``);
    await validates();
  });

  it("leaves every other file in the catalog untouched", async () => {
    const before = await snapshot();

    await succeeds("mv", PARENT, RENAMED_PARENT);

    const after = await snapshot();
    for (const file of Object.keys(before)) {
      if (RENAMED_FILES.includes(file)) continue;
      expect(after[file], file).toBe(before[file]);
    }
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });

  it("keeps a comment written above the entry it renames, and the entry's position", async () => {
    // `remove` plus `setString` would move the entry to the end of the mapping and take this comment
    // with it, which is the reformatting authoring rule 2 forbids.
    const annotated = fixture(REGISTRY).replace(
      `  ${PARENT}:\n`,
      `  # Everyone who ships software holds this one.\n  ${PARENT}:\n`,
    );
    await write(REGISTRY, annotated);

    await succeeds("mv", PARENT, RENAMED_PARENT);

    expect(await read(REGISTRY)).toBe(annotated.replaceAll(PARENT, RENAMED_PARENT));
  });

  it("rewrites a declaring entity written as `.yaml`, not the `.yml` ambit would have written", async () => {
    // §3.3 accepts either extension, and rewriting the other one would leave two files defining one
    // server — which parsing rejects, so the whole rename would fail with nothing written.
    await rename(path.join(catalogDir, SCOPED_MCP), path.join(catalogDir, "mcps/scoped.yaml"));
    const before = await snapshot();

    const result = await succeeds("mv", PARENT, RENAMED_PARENT);

    expect(result.stdout).toContain("  mcps/scoped.yaml");
    expect(Object.keys(await snapshot())).toEqual(Object.keys(before));
    expect(await read("mcps/scoped.yaml")).toBe(
      fixture(SCOPED_MCP).replace(`scopes: [${PARENT}]`, `scopes: [${RENAMED_PARENT}]`),
    );
    await validates();
  });

  it("refuses a rename onto a name the registry already holds", async () => {
    const result = await refused(ExitCode.Resolution, "mv", PARENT, "project.acme");

    expect(result.stderr).toContain(`scope "project.acme" is already registered (${REGISTRY})`);
    expect(result.stderr).toContain(`renaming "${PARENT}" to it would merge two scopes into one`);
  });

  it("refuses a scope the registry does not hold", async () => {
    const result = await refused(ExitCode.Resolution, "mv", "person.jane", "person.joan");

    expect(result.stderr).toContain('unknown scope "person.jane" (scopes.yml)');
  });

  it("refuses a new name with an empty segment", async () => {
    const result = await refused(ExitCode.Config, "mv", PARENT, "team.");

    expect(result.stderr).toContain('invalid scope name "team."');
  });

  it("writes nothing when the new name is the old one", async () => {
    const result = await succeeds("mv", PARENT, PARENT);

    expect(result.stdout).toContain("files (0)");
    expect(await read(REGISTRY)).toBe(fixture(REGISTRY));
  });

  it("under --dry-run, prints one diff per file and writes none of them", async () => {
    const before = await snapshot();

    const result = await succeeds("mv", PARENT, RENAMED_PARENT, "--dry-run");

    expect(result.stdout).toContain("would rename (2)");
    expect(result.stdout).toContain(`diff (${RENAMED_FILES.length})`);
    for (const file of RENAMED_FILES) expect(result.stdout).toContain(`  ${file} (updated)`);
    // The closing next-step line belongs to a run that changed something.
    expect(result.stdout).not.toContain("next:");
    expect(await snapshot()).toEqual(before);
  });

  it("carries every rewritten file's bytes in --json", async () => {
    const result = await succeeds("mv", PARENT, RENAMED_PARENT, "--json");
    const report = JSON.parse(result.stdout) as {
      files: readonly { file: string; text: string }[];
      renamed: readonly { from: string; to: string }[];
      written: boolean;
    };

    expect(report.renamed).toEqual([
      { from: PARENT, to: RENAMED_PARENT },
      { from: CHILD, to: `${RENAMED_PARENT}.frontend` },
    ]);
    expect(report.files.map((change) => change.file)).toEqual(RENAMED_FILES);
    for (const change of report.files) expect(change.text).toBe(await read(change.file));
  });
});

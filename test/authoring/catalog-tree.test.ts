/**
 * `ambit catalog tree` (spec §6, "Catalog authoring") — the registry drawn as a tree.
 *
 * The command exists to make the spec §2 decision legible: a held scope selects itself and every scope
 * beneath it, descendants only, so nesting is a promise about what one choice brings in. Three claims
 * carry this suite.
 *
 * The first is that the drawn nesting is the *registry's*, not the dotted names': a scope hangs off its
 * longest registered ancestor, so a registry holding `function.engineering` without `function` has two
 * roots, and registering `function` re-parents the subtree without anything else changing.
 *
 * The second is that the two counts partition what a scope selects — direct plus inherited is what
 * holding it brings in, with an item declaring both a scope and its child counted once. The last case
 * states that as an invariant against `expandHeldScopes` itself, so the view and the resolver cannot
 * drift apart; the rest of the suite pins the rendering.
 *
 * The third is that this command reads and refuses nothing beyond parsing, exactly as `ambit scopes`
 * does: a catalog whose skill declares an unregistered scope still renders, because that is the catalog
 * someone runs this command *against*.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureCatalog } from "../scripts/fixture-catalog.js";
import { parseCatalogDirectory, skillNameFromPath } from "../src/catalog.js";
import { buildScopeTree, flattenScopeTree } from "../src/catalog-tree.js";
import { ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";
import { expandHeldScopes } from "../src/resolve.js";

const GOLDEN_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "golden",
  "catalog-tree.json",
);

const CODE_REVIEW = "acme/engineering/use-code-review";
const DESIGN_TOKENS = "acme/engineering/frontend/use-design-tokens";

/** The fixture's four registered scopes, as `scopes.yml` names them. */
const ENGINEERING = "function.engineering";
const FRONTEND = "function.engineering.frontend";

let root: string;
let catalogDir: string;

interface CliResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/** Runs the CLI exactly as given. Authoring commands take `--catalog`, never `--project`. */
async function invoke(argv: readonly string[], cwd: string = root): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** The tree of the fixture catalog, asserting the command succeeded. */
async function tree(...flags: readonly string[]): Promise<CliResult> {
  const result = await invoke(["catalog", "tree", "--catalog", catalogDir, ...flags]);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** One node of the `--json` tree: what it selects, and the scopes registered beneath it. */
interface JsonNode {
  children: Record<string, JsonNode>;
  description: string;
  direct: { mcps: readonly string[]; skills: readonly string[] };
  inherited: { mcps: readonly string[]; skills: readonly string[] };
}

async function treeJson(): Promise<Record<string, JsonNode>> {
  const result = await tree("--json");
  return (JSON.parse(result.stdout) as { scopes: Record<string, JsonNode> }).scopes;
}

/** Appends an entry to the fixture's registry, which is sorted by the parser rather than by the file. */
async function registerScope(name: string, description: string): Promise<void> {
  const file = path.join(catalogDir, "scopes.yml");
  const current = await readFile(file, "utf8");
  await writeFile(file, `${current}  ${name}:\n    description: ${description}\n`, "utf8");
}

/**
 * Rewrites one of the fixture's skills with the scopes given, its name derived from its path per §2.
 *
 * Written into the per-test copy rather than into `scripts/fixture-catalog.ts`: a skill declaring two
 * scopes in one subtree is a shape this command is tested against, not one every other profile should
 * resolve.
 */
async function writeSkill(relative: string, scopes: readonly string[]): Promise<void> {
  const target = path.join(catalogDir, "skills", relative, "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    [
      "---",
      `name: ${skillNameFromPath(relative)}`,
      "description: A fixture skill.",
      "ambit:",
      `  scopes: [${scopes.join(", ")}]`,
      "---",
      "",
      "# fixture",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** The row for one scope, with its indentation and its columns, from the text report. */
function row(stdout: string, name: string): string {
  const found = stdout.split("\n").find((line) => line.trimStart().startsWith(`${name} `));
  expect(found, `no row for "${name}" in:\n${stdout}`).toBeDefined();
  return found ?? "";
}

/**
 * Compares against the golden file, or rewrites it when `UPDATE_GOLDEN` is set.
 *
 * A missing file is a failure rather than an implicit accept: a golden file only means something if a
 * human read it once.
 */
async function expectGolden(actual: string): Promise<void> {
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(path.dirname(GOLDEN_FILE), { recursive: true });
    await writeFile(GOLDEN_FILE, `${actual}\n`, "utf8");
    return;
  }

  let expected: string;
  try {
    expected = await readFile(GOLDEN_FILE, "utf8");
  } catch {
    throw new Error(`missing golden file ${GOLDEN_FILE}; regenerate with UPDATE_GOLDEN=1 npm test`);
  }
  expect(actual, "golden mismatch; UPDATE_GOLDEN=1 npm test to accept").toBe(
    expected.replace(/\n$/, ""),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-tree-"));
  catalogDir = path.join(root, "catalog");
  await buildFixtureCatalog(catalogDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit catalog tree", () => {
  it("draws the registry as a tree, one indented row per scope", async () => {
    const result = await tree();

    expect(result.stdout).toBe(
      [
        "scopes (4)",
        "  core                             1 direct  0 inherited  The universal floor — context everyone needs",
        "  function.engineering             2 direct  1 inherited  Building and shipping software",
        "    function.engineering.frontend  1 direct  0 inherited  Browser-side work: components, styling, accessibility",
        "  project.acme                     1 direct  0 inherited  The Acme engagement",
      ].join("\n"),
    );
  });

  it("names what each scope selects directly and by descent under `--json`", async () => {
    const scopes = await treeJson();

    expect(scopes[ENGINEERING]?.direct).toEqual({
      mcps: ["scoped"],
      skills: ["acme.engineering.use-code-review"],
    });
    // The nested skill: selected by holding the parent, and declared by neither.
    expect(scopes[ENGINEERING]?.inherited).toEqual({
      mcps: [],
      skills: ["acme.engineering.frontend.use-design-tokens"],
    });
    expect(scopes[ENGINEERING]?.children[FRONTEND]?.direct).toEqual({
      mcps: [],
      skills: ["acme.engineering.frontend.use-design-tokens"],
    });
    expect(scopes[ENGINEERING]?.children[FRONTEND]?.inherited).toEqual({ mcps: [], skills: [] });
  });

  it("nests a scope under its longest registered ancestor, not under its dotted prefix", async () => {
    // The fixture registers `function.engineering` and not `function`, so it is a root of the tree: a
    // parent nobody registered is not a scope anyone can hold (spec §2).
    expect(Object.keys(await treeJson())).toEqual(["core", ENGINEERING, "project.acme"]);

    await registerScope("function", "Every function");
    const scopes = await treeJson();

    expect(Object.keys(scopes)).toEqual(["core", "function", "project.acme"]);
    expect(Object.keys(scopes.function?.children ?? {})).toEqual([ENGINEERING]);
    // Nothing declares `function`, and holding it now reaches the whole subtree.
    expect(scopes.function?.direct).toEqual({ mcps: [], skills: [] });
    expect(scopes.function?.inherited).toEqual({
      mcps: ["scoped"],
      skills: [
        "acme.engineering.frontend.use-design-tokens",
        "acme.engineering.use-code-review",
      ],
    });
  });

  it("shows a registered scope nothing declares as empty", async () => {
    await registerScope("person.jane", "Jane's own things");

    expect(row((await tree()).stdout, "person.jane")).toContain("0 direct  0 inherited");
    expect((await treeJson())["person.jane"]).toMatchObject({
      children: {},
      direct: { mcps: [], skills: [] },
      inherited: { mcps: [], skills: [] },
    });
  });

  it("counts an item declaring both a scope and its child as direct, and once", async () => {
    // Declaring both is redundant rather than wrong, and the counts have to keep summing to what
    // holding the scope brings in.
    await writeSkill(DESIGN_TOKENS, [ENGINEERING, FRONTEND]);

    const scopes = await treeJson();
    expect(scopes[ENGINEERING]?.direct.skills).toEqual([
      "acme.engineering.frontend.use-design-tokens",
      "acme.engineering.use-code-review",
    ]);
    expect(scopes[ENGINEERING]?.inherited).toEqual({ mcps: [], skills: [] });
    expect(row((await tree()).stdout, ENGINEERING)).toContain("3 direct  0 inherited");
  });

  it("reads the catalog `--catalog` names, defaulting to the cwd", async () => {
    const given = await tree();
    const implied = await invoke(["catalog", "tree"], catalogDir);

    expect(implied.code, implied.stderr).toBe(ExitCode.Success);
    expect(implied.stdout).toBe(given.stdout);
  });

  it("renders a catalog whose skill declares an unregistered scope, listing it nowhere", async () => {
    // The registry is the subject, so an unregistered scope has no row — and this is the command
    // someone runs to see that the skill has fallen out of every subtree.
    await writeSkill(CODE_REVIEW, ["function.marketing"]);

    const result = await tree();
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).not.toContain("function.marketing");

    const scopes = await treeJson();
    expect(scopes[ENGINEERING]?.direct).toEqual({ mcps: ["scoped"], skills: [] });
    expect(JSON.stringify(scopes)).not.toContain("acme.engineering.use-code-review");
  });

  it("exits 2 when the directory is not a catalog", async () => {
    const result = await invoke(["catalog", "tree", "--catalog", root]);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("scopes.yml is missing");
  });
});

describe("ambit catalog tree --json", () => {
  it("matches the golden tree for the fixture catalog", async () => {
    await expectGolden((await tree("--json")).stdout);
  });

  it("emits byte-identical JSON on a second run", async () => {
    expect((await tree("--json")).stdout).toBe((await tree("--json")).stdout);
  });

  it("carries no machine-specific paths", async () => {
    expect((await tree("--json")).stdout).not.toContain(root);
    expect((await tree()).stdout).not.toContain(root);
  });
});

/**
 * The invariant the whole view rests on: what a node reports is exactly what holding that scope would
 * select by scope. Asserted against `expandHeldScopes` — the resolver's own expansion — so the tree
 * cannot drift into drawing a hierarchy that selection does not follow.
 */
describe("the tree against the resolver's own expansion", () => {
  it("reports, per scope, exactly what holding it selects", async () => {
    await registerScope("function", "Every function");
    await writeSkill(DESIGN_TOKENS, [ENGINEERING, FRONTEND]);

    const catalog = await parseCatalogDirectory("fixture", `path:${catalogDir}`, catalogDir);
    const nodes = flattenScopeTree(buildScopeTree(catalog));

    expect(nodes).toHaveLength(catalog.scopes.length);
    for (const { node } of nodes) {
      const expanded = expandHeldScopes([node.name], catalog.scopes);
      const selected = <T extends { readonly name: string; readonly scopes: readonly string[] }>(
        items: readonly T[],
      ): readonly string[] =>
        items.filter((item) => item.scopes.some((scope) => expanded.has(scope))).map((i) => i.name);

      expect([...node.direct.skills, ...node.inherited.skills].sort()).toEqual(
        selected(catalog.skills),
      );
      expect([...node.direct.mcps, ...node.inherited.mcps].sort()).toEqual(selected(catalog.mcps));
    }
  });
});

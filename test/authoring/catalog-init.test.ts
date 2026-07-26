/**
 * `ambit catalog init` (spec §6, "Catalog authoring"): the scaffolded catalog.
 *
 * Three claims carry this suite. The first is that the scaffold is a *catalog* — it parses, and
 * `ambit validate` passes against it, which is what makes `catalog scope add` and `catalog skill new`
 * able to start from it. The second is that it is a function of nothing: two runs into two differently
 * named directories produce byte-identical trees, so the scaffold cannot pick up a machine path or a
 * timestamp. The third is about what it refuses: an existing `scopes.yml` means the directory already
 * holds a catalog and nothing is written, while a directory that merely has a README is the ordinary
 * case, and that README must come out the other side untouched.
 *
 * The prose is deliberately not pinned, exactly as in `test/init.test.ts`. What is pinned is that the
 * README still teaches spec §2 — the descendants-only rule and the nest-versus-sibling choice — since
 * that is the part a catalog cannot be fixed without.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCatalogDirectory } from "../src/catalog.js";
import {
  CATALOG_INIT_SCOPE,
  CATALOG_README_FILENAME,
  CATALOG_WORKFLOW_FILENAME,
} from "../src/catalog-init.js";
import { ExitCode } from "../src/errors.js";
import { run } from "../src/program.js";
import { isValid, validateCatalogDirectory } from "../src/validate.js";
import { emitYaml } from "../src/yaml.js";

/** Every file the scaffold writes, in the order the command reports them. */
const SCAFFOLD_FILES = [
  CATALOG_WORKFLOW_FILENAME,
  CATALOG_README_FILENAME,
  "mcps/.gitkeep",
  "scopes.yml",
  "skills/.gitkeep",
];

/**
 * What the registry sets, stated here rather than imported so the test is an independent claim about
 * the emitted shape (spec §3.0) rather than a restatement of the source.
 */
const REGISTRY_VALUES = {
  scopes: { core: { description: "The universal floor — what everyone here needs" } },
};

let root: string;
let catalogDir: string;

interface CliResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/** Runs the CLI exactly as given. Authoring commands take `--catalog`, never `--project`. */
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

/** Scaffolds into `dir`, asserting it succeeded. */
async function init(dir: string, ...flags: readonly string[]): Promise<CliResult> {
  const result = await invoke("catalog", "init", "--catalog", dir, ...flags);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

async function read(file: string, dir = catalogDir): Promise<string> {
  return readFile(path.join(dir, file), "utf8");
}

/** Every file under `dir` with its bytes, so a whole tree can be compared or asserted unchanged. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (inner: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(inner, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(inner, entry.name), next);
      else files[next] = await readFile(path.join(inner, entry.name), "utf8");
    }
  };
  await walk(dir, "");
  return files;
}

/** The document with every comment and separator dropped: the values, as YAML. */
function values(text: string): string {
  const lines = text.split("\n").filter((line) => !line.startsWith("#") && line !== "");
  return `${lines.join("\n")}\n`;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-init-"));
  catalogDir = path.join(root, "catalog");
  await mkdir(catalogDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit catalog init", () => {
  it("writes a catalog the parser accepts", async () => {
    await init(catalogDir);

    const catalog = await parseCatalogDirectory("scaffold", `path:${catalogDir}`, catalogDir);

    expect(catalog.scopes).toEqual([
      { name: CATALOG_INIT_SCOPE, description: REGISTRY_VALUES.scopes.core.description },
    ]);
    expect(catalog.skills).toEqual([]);
    expect(catalog.mcps).toEqual([]);
  });

  it("scaffolds a catalog `ambit validate` passes against", async () => {
    await init(catalogDir);

    const result = await invoke("validate", "--catalog", catalogDir);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("checked 1 scope, 0 skills, 0 mcps");
    expect(result.stdout).toContain("problems (0)");
  });

  it("writes the registry, both directories, a README, and a CI workflow", async () => {
    await init(catalogDir);

    expect(Object.keys(await snapshot(catalogDir)).sort()).toEqual([...SCAFFOLD_FILES].sort());
  });

  it("holds exactly what ambit would emit from the registry's values, plus comments", async () => {
    await init(catalogDir);

    expect(values(await read("scopes.yml"))).toBe(emitYaml(REGISTRY_VALUES));
  });

  it("emits the CI workflow the same way, so it cannot drift into malformed YAML", async () => {
    await init(catalogDir);
    const workflow = await read(CATALOG_WORKFLOW_FILENAME);

    // Its keys are sorted like every other document ambit emits, which is why `name` and `on` sit
    // after `jobs`; GitHub reads a workflow's keys in any order.
    expect(values(workflow)).toBe(
      emitYaml({
        jobs: {
          validate: {
            "runs-on": "ubuntu-latest",
            steps: [
              { name: "Check out the catalog", uses: "actions/checkout@v4" },
              {
                name: "Set up Node",
                uses: "actions/setup-node@v4",
                with: { "node-version": "22" },
              },
              {
                name: "Validate the catalog",
                run: "npx --yes @nebulab/ambit validate --catalog .",
              },
            ],
          },
        },
        name: "validate",
        on: ["push", "pull_request"],
      }),
    );
    expect(workflow).toContain("validate --catalog .");
  });

  it("scaffolds byte-identical trees into two differently named directories", async () => {
    // The scaffold must be a function of nothing: a directory name, an absolute path, or a timestamp
    // reaching the bytes would make two catalogs of the same command differ.
    const other = path.join(root, "a-longer-catalog-name");
    await init(catalogDir);
    await init(other);

    expect(await snapshot(other)).toEqual(await snapshot(catalogDir));
  });

  it("creates the catalog directory when it is not there yet", async () => {
    // Unlike `ambit init`, which refuses a missing project directory: this command creates `skills/`,
    // `mcps/` and `.github/workflows/` regardless, so refusing to create the root would be arbitrary.
    const fresh = path.join(root, "new-catalog");

    await init(fresh);

    expect(Object.keys(await snapshot(fresh)).sort()).toEqual([...SCAFFOLD_FILES].sort());
  });

  it("prints what it created, what it kept, and the one thing left to do", async () => {
    const result = await init(catalogDir);

    expect(result.stdout).toBe(
      [
        `created (${SCAFFOLD_FILES.length})`,
        ...SCAFFOLD_FILES.map((file) => `  ${file}`),
        "",
        "kept (0)",
        "  (none)",
        "",
        "next: register your scopes with `ambit catalog scope add`, then add a skill with `ambit catalog skill new`",
      ].join("\n"),
    );
  });

  it("carries every file's bytes in --json, so a consuming tool can write them itself", async () => {
    const result = await init(catalogDir, "--json");
    const report = JSON.parse(result.stdout) as {
      created: readonly { file: string; text: string }[];
      kept: readonly string[];
      written: boolean;
    };

    expect(report.written).toBe(true);
    expect(report.kept).toEqual([]);
    expect(report.created.map((change) => change.file)).toEqual(SCAFFOLD_FILES);
    for (const change of report.created) expect(change.text).toBe(await read(change.file));
  });

  it("teaches the descendants-only rule and the nest-versus-sibling choice in the README", async () => {
    await init(catalogDir);
    const readme = await read(CATALOG_README_FILENAME);

    expect(readme).toMatch(/descendants only/i);
    expect(readme).toMatch(/nothing is implicit/i);
    // The guidance spec §2 asks a catalog's README to carry: nest only when the parent implies every
    // child, sibling anything picked independently.
    expect(readme).toMatch(/nest/i);
    expect(readme).toMatch(/sibling/i);
    expect(readme).toMatch(/function\.engineering\.frontend/);
  });
});

describe("ambit catalog init on a directory that already holds a catalog", () => {
  it("refuses an existing scopes.yml, writing nothing", async () => {
    const registry = "scopes:\n  mine:\n    description: Mine\n";
    await writeFile(path.join(catalogDir, "scopes.yml"), registry, "utf8");
    const before = await snapshot(catalogDir);

    const result = await invoke("catalog", "init", "--catalog", catalogDir);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite scopes.yml");
    expect(result.stderr).toContain(catalogDir);
    expect(await snapshot(catalogDir)).toEqual(before);
  });

  it("refuses under --dry-run as well, since the preview of a refusal is a refusal", async () => {
    await writeFile(path.join(catalogDir, "scopes.yml"), "scopes: {}\n", "utf8");

    const result = await invoke("catalog", "init", "--catalog", catalogDir, "--dry-run");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite scopes.yml");
  });

  it("refuses a second run, which is what makes the first one the only one", async () => {
    await init(catalogDir);

    const second = await invoke("catalog", "init", "--catalog", catalogDir);

    expect(second.code).toBe(ExitCode.Config);
  });
});

describe("ambit catalog init on an occupied directory", () => {
  it("keeps a README it did not write, byte-identical, and scaffolds the rest", async () => {
    // A catalog is normally initialized inside a repo that already exists, so an occupant that is not
    // a catalog is not a mistake — and overwriting someone's README would be the reformatting
    // authoring rule 2 forbids, one file up.
    const readme = "# my repo\n\nNothing to do with ambit.\n";
    await writeFile(path.join(catalogDir, CATALOG_README_FILENAME), readme, "utf8");

    const result = await init(catalogDir);

    expect(result.stdout).toContain("kept (1)");
    expect(result.stdout).toContain(`  ${CATALOG_README_FILENAME}`);
    expect(await read(CATALOG_README_FILENAME)).toBe(readme);
    expect(isValid(await validateCatalogDirectory(catalogDir))).toBe(true);
  });

  it("keeps an existing workflow of the same name rather than replacing the CI it finds", async () => {
    const workflow = "name: mine\non: [push]\njobs: {}\n";
    await mkdir(path.dirname(path.join(catalogDir, CATALOG_WORKFLOW_FILENAME)), {
      recursive: true,
    });
    await writeFile(path.join(catalogDir, CATALOG_WORKFLOW_FILENAME), workflow, "utf8");

    await init(catalogDir);

    expect(await read(CATALOG_WORKFLOW_FILENAME)).toBe(workflow);
  });
});

describe("ambit catalog init --dry-run", () => {
  it("prints the diff of every file it would write, and writes none of them", async () => {
    const result = await init(catalogDir, "--dry-run");

    expect(result.stdout).toContain(`would create (${SCAFFOLD_FILES.length})`);
    expect(result.stdout).toContain(`diff (${SCAFFOLD_FILES.length})`);
    for (const file of SCAFFOLD_FILES) expect(result.stdout).toContain(`  ${file} (created)`);
    // The diff is the scaffold: every line of the registry appears as an addition.
    expect(result.stdout).toContain("    + scopes:");
    expect(await snapshot(catalogDir)).toEqual({});
  });

  it("reports written: false in --json, with the bytes a real run would write", async () => {
    const preview = await init(catalogDir, "--dry-run", "--json");
    const previewed = JSON.parse(preview.stdout) as {
      created: readonly { file: string; text: string }[];
      written: boolean;
    };

    await init(catalogDir);

    expect(previewed.written).toBe(false);
    for (const change of previewed.created) expect(change.text).toBe(await read(change.file));
  });
});

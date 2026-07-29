/**
 * `ambit catalog init`: the scaffolded catalog.
 *
 * Three claims carry this suite. The first is that the scaffold is a *catalog* — it parses, and
 * `ambit catalog validate` passes against it, so the first thing an author writes into it by hand is
 * written into something that already checks out. The second is that it is a function of nothing: two runs into two differently
 * named directories produce byte-identical trees, so the scaffold cannot pick up a machine path or a
 * timestamp. The third is about what it leaves alone: no file makes a directory a catalog any more, so
 * every occupant of the same name is kept byte-identical and reported — which makes a second run a
 * no-op rather than a refusal, and a directory that merely has a README the ordinary case.
 *
 * The prose is deliberately not pinned, exactly as in `test/init.test.ts`. What is pinned is that the
 * README says where each kind of thing goes and that tags are free-form — a scaffolded README still
 * describing a registry would be worse than none.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCatalogDirectory } from "../../src/model/catalog.js";
import { CATALOG_README_FILENAME, CATALOG_WORKFLOW_FILENAME } from "../../src/authoring/init.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";
import { isValid, validateCatalogDirectory } from "../../src/resolution/validate.js";
import { emitYaml } from "../../src/model/yaml.js";

/** Every file the scaffold writes, in the order the command reports them. */
const SCAFFOLD_FILES = [
  CATALOG_WORKFLOW_FILENAME,
  CATALOG_README_FILENAME,
  "hooks/.gitkeep",
  "mcps/.gitkeep",
  "skills/.gitkeep",
];

let root: string;
let catalogDir: string;

interface CliResult {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/** Runs the CLI exactly as given. A `catalog` subcommand takes `--catalog`, never `--project`. */
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

    expect(catalog.skills).toEqual([]);
    expect(catalog.mcps).toEqual([]);
    // A `.gitkeep` is invisible to parsing, so the scaffolded `hooks/` holds no hook — which is what
    // makes the directory additive rather than a catalog declaring something nobody wrote.
    expect(catalog.hooks).toEqual([]);
  });

  it("scaffolds a catalog `ambit catalog validate` passes against", async () => {
    await init(catalogDir);

    const result = await invoke("catalog", "validate", "--catalog", catalogDir);

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("checked 0 skills, 0 mcps");
    expect(result.stdout).toContain("problems (0)");
  });

  it("writes all three item directories, a README and a CI workflow — and no config of its own", async () => {
    await init(catalogDir);

    const written = Object.keys(await snapshot(catalogDir)).sort();
    expect(written).toEqual([...SCAFFOLD_FILES].sort());
    // A catalog is a directory and nothing else, so there is no file left to write at its root.
    expect(written).not.toContain("scopes.yml");
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
                run: "npx --yes @nebulab/ambit catalog validate",
              },
            ],
          },
        },
        name: "validate",
        on: ["push", "pull_request"],
      }),
    );
    expect(workflow).toContain("catalog validate");
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
        "next: add a skill in `skills/<name>/SKILL.md`, tagged with who needs it — see `README.md`",
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

  it("says where each kind of thing goes, and that tags are free-form, in the README", async () => {
    await init(catalogDir);
    const readme = await read(CATALOG_README_FILENAME);

    expect(readme).toContain("skills/<name>/SKILL.md");
    expect(readme).toContain("mcps/<name>.yml");
    expect(readme).toContain("hooks/<name>/HOOK.yml");
    expect(readme).toMatch(/free-form/i);
    // The rule a tag still obeys, and the one mistake nothing here can catch.
    expect(readme).toMatch(/function\.engineering\.frontend/);
    expect(readme).toMatch(/misspelled tag/i);
    // Nothing registers anything any more, so the README must not say a word about a registry.
    expect(readme).not.toMatch(/scopes\.yml/);
    expect(readme).not.toMatch(/registr/i);
  });
});

describe("ambit catalog init on a directory that already holds a catalog", () => {
  it("keeps every scaffold file it finds, writing nothing on a second run", async () => {
    // No file makes a directory a catalog, so there is nothing left to refuse: the second run finds
    // all five files already there, reports them as kept, and touches none of them.
    await init(catalogDir);
    const before = await snapshot(catalogDir);

    const second = await invoke("catalog", "init", "--catalog", catalogDir);

    expect(second.code, second.stderr).toBe(ExitCode.Success);
    expect(second.stdout).toContain("created (0)");
    expect(second.stdout).toContain(`kept (${SCAFFOLD_FILES.length})`);
    expect(await snapshot(catalogDir)).toEqual(before);
  });

  it("refuses a directory still holding a scopes.yml, naming the rewrite", async () => {
    // The scaffold's result would not parse as a catalog, and the editor validates the result before
    // writing — so the migration refusal arrives here without this command knowing anything about it.
    await writeFile(
      path.join(catalogDir, "scopes.yml"),
      "scopes:\n  mine:\n    description: Mine\n",
      "utf8",
    );
    const before = await snapshot(catalogDir);

    const result = await invoke("catalog", "init", "--catalog", catalogDir);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("the scope registry is gone (scopes.yml)");
    expect(result.stderr).toContain(
      "scopes are gone; tag items with `ambit.tags` and select them with `tag:`",
    );
    expect(await snapshot(catalogDir)).toEqual(before);
  });

  it("refuses it under --dry-run as well, since the preview of a refusal is a refusal", async () => {
    await writeFile(path.join(catalogDir, "scopes.yml"), "scopes: {}\n", "utf8");

    const result = await invoke("catalog", "init", "--catalog", catalogDir, "--dry-run");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("the scope registry is gone (scopes.yml)");
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
    // The diff is the scaffold: every line of the workflow appears as an addition.
    expect(result.stdout).toContain("    + jobs:");
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

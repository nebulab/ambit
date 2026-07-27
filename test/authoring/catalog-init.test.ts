/**
 * `ambit catalog init`: the scaffolded catalog.
 *
 * Four claims carry this suite. The first is that the scaffold is a *catalog* — it parses, and
 * `ambit catalog validate` passes against it, which is what makes `catalog scope add` and
 * `catalog skill new` able to start from it. The second is that it is a function of nothing: two runs into two differently
 * named directories produce byte-identical trees, so the scaffold cannot pick up a machine path or a
 * timestamp. The third is about what it refuses: an existing `catalog:` block means the directory
 * already publishes a catalog and nothing is written, while a directory that merely has a README is the
 * ordinary case, and that README must come out the other side untouched. The fourth is the case one
 * file makes possible: a config `ambit init` wrote gets the `catalog:` block *added* to it, with its
 * consumer keys and their comments byte-identical.
 *
 * The prose is deliberately not pinned, exactly as in `test/init.test.ts`. What is pinned is that the
 * README still teaches the descendants-only rule and the nest-versus-sibling choice — since
 * that is the part a catalog cannot be fixed without.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCatalogDirectory } from "../../src/model/catalog.js";
import {
  CATALOG_INIT_SCOPE,
  CATALOG_README_FILENAME,
  CATALOG_WORKFLOW_FILENAME,
} from "../../src/authoring/init.js";
import { CONFIG_FILENAMES } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";
import { scaffoldConfig } from "../../src/project/init.js";
import { isValid, validateCatalogDirectory } from "../../src/resolution/validate.js";
import { emitYaml } from "../../src/model/yaml.js";

/** The config the scaffold writes its `catalog:` block into. */
const CONFIG = CONFIG_FILENAMES[0];

/** Every file the scaffold writes, in the order the command reports them. */
const SCAFFOLD_FILES = [
  CATALOG_WORKFLOW_FILENAME,
  CATALOG_README_FILENAME,
  CONFIG,
  "hooks/.gitkeep",
  "mcps/.gitkeep",
  "skills/.gitkeep",
];

/**
 * What the config sets, stated here rather than imported so the test is an independent claim about
 * the emitted shape rather than a restatement of the source.
 */
const CONFIG_VALUES = {
  catalog: {
    scopes: { core: { description: "The universal floor — what everyone here needs" } },
  },
  version: 1,
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
      { name: CATALOG_INIT_SCOPE, description: CONFIG_VALUES.catalog.scopes.core.description },
    ]);
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
    expect(result.stdout).toContain("checked 1 scope, 0 skills, 0 mcps");
    expect(result.stdout).toContain("problems (0)");
  });

  it("writes the registry, all three item directories, a README, and a CI workflow", async () => {
    await init(catalogDir);

    expect(Object.keys(await snapshot(catalogDir)).sort()).toEqual([...SCAFFOLD_FILES].sort());
  });

  it("holds exactly what ambit would emit from the config's values, plus comments", async () => {
    await init(catalogDir);

    expect(values(await read(CONFIG))).toBe(emitYaml(CONFIG_VALUES));
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

  it("prints what it created, what it updated, what it kept, and the one thing left to do", async () => {
    const result = await init(catalogDir);

    expect(result.stdout).toBe(
      [
        `created (${SCAFFOLD_FILES.length})`,
        ...SCAFFOLD_FILES.map((file) => `  ${file}`),
        "",
        "updated (0)",
        "  (none)",
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
      updated: readonly { file: string; text: string }[];
      kept: readonly string[];
      written: boolean;
    };

    expect(report.written).toBe(true);
    expect(report.kept).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.created.map((change) => change.file)).toEqual(SCAFFOLD_FILES);
    for (const change of report.created) expect(change.text).toBe(await read(change.file));
  });

  it("teaches the descendants-only rule and the nest-versus-sibling choice in the README", async () => {
    await init(catalogDir);
    const readme = await read(CATALOG_README_FILENAME);

    expect(readme).toMatch(/descendants only/i);
    expect(readme).toMatch(/nothing is implicit/i);
    // The guidance a catalog's README has to carry: nest only when the parent implies every
    // child, sibling anything picked independently.
    expect(readme).toMatch(/nest/i);
    expect(readme).toMatch(/sibling/i);
    expect(readme).toMatch(/function\.engineering\.frontend/);
  });
});

describe("ambit catalog init on a directory that already publishes a catalog", () => {
  it("refuses a config that already has a `catalog:` block, writing nothing", async () => {
    const config = "version: 1\ncatalog:\n  scopes:\n    mine:\n      description: Mine\n";
    await writeFile(path.join(catalogDir, CONFIG), config, "utf8");
    const before = await snapshot(catalogDir);

    const result = await invoke("catalog", "init", "--catalog", catalogDir);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite the `catalog:` block in ambit.yml");
    expect(result.stderr).toContain(catalogDir);
    expect(await snapshot(catalogDir)).toEqual(before);
  });

  it("refuses under --dry-run as well, since the preview of a refusal is a refusal", async () => {
    await writeFile(path.join(catalogDir, CONFIG), "version: 1\ncatalog:\n  scopes: {}\n", "utf8");

    const result = await invoke("catalog", "init", "--catalog", catalogDir, "--dry-run");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("refusing to overwrite the `catalog:` block");
  });

  it("refuses a second run, which is what makes the first one the only one", async () => {
    await init(catalogDir);

    const second = await invoke("catalog", "init", "--catalog", catalogDir);

    expect(second.code).toBe(ExitCode.Config);
  });

  it("sends a directory still holding scopes.yml to where the registry went", async () => {
    // A hard break with a message that teaches: scaffolding a second registry beside the old one would
    // leave two, and the one ambit reads would be the empty one.
    await writeFile(
      path.join(catalogDir, "scopes.yml"),
      "scopes:\n  mine:\n    description: Mine\n",
      "utf8",
    );
    const before = await snapshot(catalogDir);

    const result = await invoke("catalog", "init", "--catalog", catalogDir);

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("still holds scopes.yml");
    expect(result.stderr).toContain("`catalog.scopes`");
    expect(await snapshot(catalogDir)).toEqual(before);
  });
});

describe("ambit catalog init on a config `ambit init` already wrote", () => {
  it("adds the `catalog:` block, keeping every consumer key and comment byte-identical", async () => {
    const project = scaffoldConfig();
    await writeFile(path.join(catalogDir, CONFIG), project, "utf8");

    const result = await init(catalogDir);
    const config = await read(CONFIG);

    // Reported as updated rather than created: the file was already there, and most of its bytes are
    // still the other command's.
    expect(result.stdout).toContain("updated (1)");
    expect(result.stdout).toContain(`  ${CONFIG}`);
    expect(config.startsWith(project)).toBe(true);
    expect(config).toContain("catalog:");
    // One `version:`, not two — the block the document already answers is dropped.
    expect(config.split("version: 1").length - 1).toBe(1);
    expect(isValid(await validateCatalogDirectory(catalogDir))).toBe(true);
  });

  it("leaves a catalog the parser reads the scopes of, beside what the project holds", async () => {
    await writeFile(path.join(catalogDir, CONFIG), scaffoldConfig(), "utf8");

    await init(catalogDir);
    const catalog = await parseCatalogDirectory("both", `path:${catalogDir}`, catalogDir);

    expect(catalog.scopes.map((definition) => definition.name)).toEqual([CATALOG_INIT_SCOPE]);
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
    // The diff is the scaffold: every line of the config appears as an addition.
    expect(result.stdout).toContain("    + catalog:");
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

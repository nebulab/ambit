/**
 * `ambit init`: the scaffolded project, which is also a catalog.
 *
 * Four claims carry this suite, and none of them is about the prose.
 *
 * The first is that the scaffold is *emitted*: strip its comments and what is left must be
 * byte-identical to what {@link emitYaml} produces from the same values, so the file cannot drift into
 * an unsorted key or an unquoted value and cannot stop being byte-stable between runs — and that holds
 * for the commented-out block too, which must be valid config the moment the `# ` comes off.
 *
 * The second is that the two halves agree. The scaffolded `catalogs:` entry is live and names the
 * project itself, so the three item directories have to be there for it to be true; the `requires`
 * entry selecting that catalog is commented, because an entry matching nothing is exit 3 and a fresh
 * project's own catalog is empty. Both are checked by running `ambit validate` against the result.
 *
 * The third is that it still teaches the entry grammar, which is the part that costs a bundle when it
 * goes missing.
 *
 * The fourth is about what it leaves alone: an existing config is refused, an existing `.gitkeep` is
 * kept byte-identical and reported, and a missing project root is refused rather than created.
 *
 * The prose itself is deliberately not pinned. It is documentation, free to be reworded; what is
 * pinned is that a comment adjacent to `requires` says nothing is implicit and explains the glob
 * rule.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCatalogDirectory } from "../../src/model/catalog.js";
import { parseProjectConfig } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import { INIT_FILENAME, scaffoldConfig, scaffoldProject } from "../../src/project/init.js";
import { run } from "../../src/cli/program.js";
import { emitYaml } from "../../src/model/yaml.js";

/** Every file the scaffold writes, in the order the command reports them. */
const SCAFFOLD_FILES = [
  INIT_FILENAME,
  "hooks/.gitkeep",
  "mcps/.gitkeep",
  "packs/.gitkeep",
  "skills/.gitkeep",
];

/**
 * What the scaffold sets, stated here rather than imported so the test is an independent claim.
 *
 * `catalogs` is live: every project is a catalog, and the entry is what makes its own `packs/`,
 * `skills/`, `mcps/` and `hooks/` reachable.
 */
const SCAFFOLD_VALUES = {
  catalogs: [{ name: "local", source: "path:." }],
  harnesses: ["claude"],
  version: 1,
};

/** The commented-out `requires` example, which selects nothing until a reader uncomments it. */
const EXAMPLE_REQUIRES = [{ pack: "local/*" }, { skill: "local/*" }];

/** The scaffold with its commented-out example uncommented, which is what a reader does. */
const WITH_EXAMPLE = { ...SCAFFOLD_VALUES, requires: EXAMPLE_REQUIRES };

const OTHER_CONFIG = "ambit.yaml";

let root: string;
let projectDir: string;

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

/** One project-relative file's bytes. */
async function read(file: string): Promise<string> {
  return readFile(path.join(projectDir, file), "utf8");
}

async function readConfig(): Promise<string> {
  return read(INIT_FILENAME);
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

/**
 * The scaffold with its commented-out example turned back into config.
 *
 * A comment line belongs to the example rather than to the prose when what follows `# ` is either the
 * key itself or further indentation — prose never begins with a space. `requires` is the only key
 * shown that way: `catalogs` is scaffolded live.
 */
function uncommented(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^# (?:requires:| )/.test(line) ? line.slice(2) : line))
    .join("\n");
}

/** The contiguous comment lines immediately above a key. */
function commentAbove(text: string, key: string): readonly string[] {
  const lines = text.split("\n");
  const index = lines.indexOf(`${key}:`);
  expect(index, `${key} is not a top-level key`).toBeGreaterThan(-1);

  const comment: string[] = [];
  for (let above = index - 1; above >= 0 && lines[above]?.startsWith("#") === true; above -= 1) {
    comment.unshift(lines[above] ?? "");
  }
  return comment;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-init-"));
  projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit init", () => {
  it("writes an ambit.yml the config loader accepts", async () => {
    const result = await cli("init");

    expect(result.code, result.stderr).toBe(ExitCode.Success);

    const config = parseProjectConfig(await readConfig(), INIT_FILENAME);
    expect(config.version).toBe(1);
    expect(config.harnesses).toEqual(["claude"]);
    // The project lists itself, which is the only way a project ships a skill of its own.
    expect(config.catalogs).toEqual([{ name: "local", source: "path:." }]);
    // Nothing selected, which is what keeps `ambit validate` clean on a fresh project: an entry
    // matching nothing is exit 3, and `local` is three empty directories.
    expect(config.requires).toEqual([]);
  });

  it("writes the config and every item directory, and nothing else", async () => {
    await cli("init");

    expect(Object.keys(await snapshot(projectDir)).sort()).toEqual([...SCAFFOLD_FILES].sort());
  });

  it("scaffolds a catalog the parser accepts, holding nothing", async () => {
    await cli("init");

    const catalog = await parseCatalogDirectory("local", "path:.", projectDir);

    // A `.gitkeep` is invisible to parsing, so the three directories are additive rather than a
    // catalog declaring something nobody wrote.
    expect(catalog.skills).toEqual([]);
    expect(catalog.mcps).toEqual([]);
    expect(catalog.hooks).toEqual([]);
  });

  it("scaffolds a project `ambit validate` passes against, with no edits", async () => {
    await cli("init");

    const result = await cli("validate");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("problems (0)");
  });

  it("is read by the commands that load a project, not merely by the parser", async () => {
    await cli("init");

    // `ambit search` loads the config the way every command does, so a scaffold it accepts is one the
    // whole tool accepts — and what it dumps is the project's own empty catalog.
    const result = await cli("search", "*");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("local");
  });

  it("holds exactly what ambit would emit from those values, plus comments", async () => {
    await cli("init");

    expect(values(await readConfig())).toBe(emitYaml(SCAFFOLD_VALUES));
  });

  it("stays sorted, and parses, when the commented-out example is uncommented", async () => {
    await cli("init");
    const text = uncommented(await readConfig());

    expect(values(text)).toBe(emitYaml(WITH_EXAMPLE));

    const config = parseProjectConfig(text, INIT_FILENAME);
    // The `requires` example quotes the alias the live `catalogs` block declares, so uncommenting it
    // leaves a config that agrees with itself.
    expect(config.requires).toEqual([
      { kind: "pack", pattern: "*", catalog: "local" },
      { kind: "skill", pattern: "*", catalog: "local" },
    ]);
  });

  it("scaffolds byte-identical trees into two fresh directories", async () => {
    await cli("init");
    const first = await snapshot(projectDir);

    const second = path.join(root, "second");
    await mkdir(second, { recursive: true });
    await run(["init", "--project", second], {
      cwd: root,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(await snapshot(second)).toEqual(first);
    expect(first[INIT_FILENAME]).toBe(scaffoldConfig());
  });

  it("explains the entry grammar above the commented-out `requires` block", async () => {
    await cli("init");
    const text = await readConfig();
    const comment = commentAbove(text, "# requires").join("\n");

    // Commented, so the scaffold selects nothing; and the prose is where the two declarations and the
    // glob rule are stated, since nothing warns about either at install time.
    expect(text).toContain("# requires:");
    expect(text).not.toMatch(/^requires:/m);
    expect(comment).toMatch(/nothing is implicit/i);
    expect(comment).toMatch(/pack/);
    expect(comment).toMatch(/not `core` itself/);
  });

  it("prints what it created, what it kept, and the two things left to do", async () => {
    const result = await cli("init");

    expect(result.stdout).toBe(
      [
        `created (${SCAFFOLD_FILES.length})`,
        ...SCAFFOLD_FILES.map((file) => `  ${file}`),
        "",
        "kept (0)",
        "  (none)",
        "",
        "next: put a skill in `skills/<name>/SKILL.md`, or add a catalog under `catalogs`",
        "      then uncomment a `requires` entry that selects it, and run `ambit install`",
      ].join("\n"),
    );
  });

  it("carries every file's bytes in --json, so a consuming tool can write them itself", async () => {
    const result = await cli("init", "--json");
    const report = JSON.parse(result.stdout) as {
      created: readonly { file: string; text: string }[];
      kept: readonly string[];
      written: boolean;
    };

    expect(report.written).toBe(true);
    expect(report.kept).toEqual([]);
    expect(report.created.map((file) => file.file)).toEqual(SCAFFOLD_FILES);
    for (const file of report.created) expect(file.text).toBe(await read(file.file));
  });
});

describe("ambit init on a directory that already holds a config", () => {
  it("refuses ambit.yml, leaving it byte-identical and writing no directories", async () => {
    await writeFile(path.join(projectDir, INIT_FILENAME), "version: 1\n", "utf8");

    const result = await cli("init");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`refusing to overwrite ${INIT_FILENAME}`);
    expect(result.stderr).toContain("ambit init");
    // The config is the file that makes a directory a project, so a refusal is total: not the config,
    // and not a `.gitkeep` beside it.
    expect(await readdir(projectDir)).toEqual([INIT_FILENAME]);
    expect(await readConfig()).toBe("version: 1\n");
  });

  it("refuses ambit.yaml too, and writes no ambit.yml beside it", async () => {
    // Both names are accepted config, so scaffolding the other one would leave a project
    // whose two configs are an error in every other command.
    await writeFile(path.join(projectDir, OTHER_CONFIG), "version: 1\n", "utf8");

    const result = await cli("init");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`refusing to overwrite ${OTHER_CONFIG}`);
    expect(await readdir(projectDir)).toEqual([OTHER_CONFIG]);
  });

  it("refuses under --dry-run as well, since the preview of a refusal is a refusal", async () => {
    await writeFile(path.join(projectDir, INIT_FILENAME), "version: 1\n", "utf8");

    const result = await cli("init", "--dry-run");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`refusing to overwrite ${INIT_FILENAME}`);
  });

  it("refuses a second run, which is what makes the config the refused half", async () => {
    await cli("init");
    const before = await snapshot(projectDir);

    const second = await cli("init");

    expect(second.code).toBe(ExitCode.Config);
    expect(await snapshot(projectDir)).toEqual(before);
  });
});

describe("ambit init on a directory that already holds a .gitkeep", () => {
  it("keeps it byte-identical and reports it, rather than refusing", async () => {
    // A `.gitkeep` carries no bytes to lose and is exactly what a project with its own `skills/`
    // already has, so it is kept where a config would be refused.
    await mkdir(path.join(projectDir, "skills"), { recursive: true });
    await writeFile(path.join(projectDir, "skills/.gitkeep"), "# mine\n", "utf8");

    const result = await cli("init");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("created (4)");
    expect(result.stdout).toContain("kept (1)");
    expect(result.stdout).toContain("  skills/.gitkeep");
    expect(await readFile(path.join(projectDir, "skills/.gitkeep"), "utf8")).toBe("# mine\n");
  });

  it("leaves an occupied item directory's other contents alone", async () => {
    await mkdir(path.join(projectDir, "skills/mine"), { recursive: true });
    await writeFile(path.join(projectDir, "skills/mine/notes.md"), "# notes\n", "utf8");

    await cli("init");

    expect(await readFile(path.join(projectDir, "skills/mine/notes.md"), "utf8")).toBe("# notes\n");
    // The directory was there, but the `.gitkeep` inside it was not, so it is created.
    expect(await readFile(path.join(projectDir, "skills/.gitkeep"), "utf8")).toBe("");
  });
});

describe("ambit init --dry-run", () => {
  it("prints the bytes it would write and writes none of them", async () => {
    const result = await cli("init", "--dry-run");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [
        `would create (${SCAFFOLD_FILES.length})`,
        ...SCAFFOLD_FILES.map((file) => `  ${file}`),
        "",
        "kept (0)",
        "  (none)",
        "",
        scaffoldConfig().trimEnd(),
      ].join("\n"),
    );
    // Not the config, and not one of the three directories the `.gitkeep` files would create.
    expect(await readdir(projectDir)).toEqual([]);
  });

  it("reports written: false in --json, with the same bytes a real run would write", async () => {
    const preview = await cli("init", "--dry-run", "--json");
    const previewed = JSON.parse(preview.stdout) as {
      created: readonly { file: string; text: string }[];
      written: boolean;
    };

    await cli("init");

    expect(previewed.written).toBe(false);
    for (const file of previewed.created) expect(file.text).toBe(await read(file.file));
  });
});

describe("ambit init on a missing directory", () => {
  it("refuses it rather than creating one, and names it", async () => {
    // `ambit init`'s stance, kept through the merge with the catalog scaffold: `--project` naming the
    // wrong path should not leave a project — now three directories and a config — where nobody meant.
    const missing = path.join(root, "absent");
    const err: string[] = [];

    const code = await run(["init", "--project", missing], {
      cwd: root,
      stdout: () => undefined,
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(ExitCode.Config);
    expect(err.join("\n")).toContain(`cannot initialize ${missing}`);
    expect(err.join("\n")).toContain("`--project` at a directory that exists");
    await expect(readdir(missing)).rejects.toThrow();
  });
});

describe("the scaffold as a value", () => {
  it("is a function of nothing, in path order", () => {
    // Two runs into two differently named directories must produce identical trees, so nothing about
    // the target — a directory name, an absolute path, a timestamp — may reach the bytes.
    expect(scaffoldProject().map((file) => file.file)).toEqual(SCAFFOLD_FILES);
    expect(scaffoldProject()).toEqual(scaffoldProject());
  });
});

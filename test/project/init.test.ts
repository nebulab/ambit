/**
 * `ambit init`: the scaffolded `ambit.yml`.
 *
 * Two claims carry this suite, and neither is about the prose. The first is that the scaffold is
 * *emitted*: strip its comments and what is left must be byte-identical to what {@link emitYaml}
 * produces from the same values, so the file cannot drift into an unsorted key or an unquoted value
 * and cannot stop being byte-stable between runs — and that holds for the commented-out blocks too,
 * which must be valid config the moment the `# ` comes off. The second is that it still teaches the
 * entry grammar, which is the part that costs a bundle when it goes missing.
 *
 * The prose itself is deliberately not pinned. It is documentation, free to be reworded; what is
 * pinned is that a comment adjacent to `requires` says nothing is implicit and explains the glob
 * rule, and that the scaffold selects nothing — an entry matching nothing is exit 3, so a fresh
 * project must hold none.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseProjectConfig } from "../../src/model/config.js";
import { ExitCode } from "../../src/errors.js";
import { INIT_FILENAME, scaffoldConfig } from "../../src/project/init.js";
import { run } from "../../src/cli/program.js";
import { emitYaml } from "../../src/model/yaml.js";

/** What the scaffold sets, stated here rather than imported so the test is an independent claim. */
const SCAFFOLD_VALUES = { harnesses: ["claude"], version: 1 };

/** The commented-out `requires` example, which selects nothing until a reader uncomments it. */
const EXAMPLE_REQUIRES = [
  { capabilities: ["skills", "mcps", "hooks"], tag: "company/function.engineering" },
  { capabilities: ["skills"], name: "company/core.*" },
];

/** The scaffold with both commented-out examples uncommented, which is what a reader does. */
const WITH_EXAMPLES = {
  catalogs: [{ name: "company", ref: "main", source: "acme/skills" }],
  harnesses: ["claude"],
  requires: EXAMPLE_REQUIRES,
  version: 1,
};

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

async function readConfig(name = INIT_FILENAME): Promise<string> {
  return readFile(path.join(projectDir, name), "utf8");
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
 * key itself or further indentation — prose never begins with a space.
 */
function uncommented(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^# (?:catalogs:|requires:| )/.test(line) ? line.slice(2) : line))
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
    expect(config.catalogs).toEqual([]);
    // Nothing selected, which is what keeps `ambit validate` clean on a project nobody has pointed at
    // a catalog yet: an entry matching nothing is exit 3.
    expect(config.requires).toEqual([]);
  });

  it("is read by the commands that load a project, not merely by the parser", async () => {
    await cli("init");

    // `catalog` loads the config the way every command does, so a scaffold it accepts is one the
    // whole tool accepts — the scaffolded file declares no catalog, which is what it says.
    const result = await cli("dump-catalog");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain("no catalogs configured");
  });

  it("holds exactly what ambit would emit from those values, plus comments", async () => {
    await cli("init");

    expect(values(await readConfig())).toBe(emitYaml(SCAFFOLD_VALUES));
  });

  it("stays sorted, and parses, when both commented-out examples are uncommented", async () => {
    await cli("init");
    const text = uncommented(await readConfig());

    expect(values(text)).toBe(emitYaml(WITH_EXAMPLES));

    const config = parseProjectConfig(text, INIT_FILENAME);
    expect(config.catalogs).toEqual([{ name: "company", ref: "main", source: "acme/skills" }]);
    // The `requires` example quotes the alias the `catalogs` example declares, so uncommenting both
    // leaves a config that agrees with itself.
    expect(config.requires).toEqual([
      {
        field: "tag",
        pattern: "function.engineering",
        catalog: "company",
        capabilities: ["skills", "mcps", "hooks"],
      },
      { field: "name", pattern: "core.*", catalog: "company", capabilities: ["skills"] },
    ]);
  });

  it("scaffolds byte-identical files into two fresh directories", async () => {
    await cli("init");
    const first = await readConfig();

    const second = path.join(root, "second");
    await mkdir(second, { recursive: true });
    await run(["init", "--project", second], {
      cwd: root,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(await readFile(path.join(second, INIT_FILENAME), "utf8")).toBe(first);
    expect(first).toBe(scaffoldConfig());
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
    expect(comment).toMatch(/capabilities/);
    expect(comment).toMatch(/not `core` itself/);
  });

  it("prints what it created and the one thing left to do", async () => {
    const result = await cli("init");

    expect(result.stdout).toBe(
      [
        `created ${INIT_FILENAME}`,
        "next: add a catalog under `catalogs`, then `requires` entries, then `ambit install`",
      ].join("\n"),
    );
  });

  it("carries the bytes in --json, so a consuming tool can write them itself", async () => {
    const result = await cli("init", "--json");
    const report = JSON.parse(result.stdout) as { created: boolean; file: string; text: string };

    expect(report).toEqual({ created: true, file: INIT_FILENAME, text: await readConfig() });
  });
});

describe("ambit init on a directory that already holds a config", () => {
  it("refuses ambit.yml, leaving it byte-identical", async () => {
    await writeFile(path.join(projectDir, INIT_FILENAME), "version: 1\n", "utf8");

    const result = await cli("init");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain(`refusing to overwrite ${INIT_FILENAME}`);
    expect(result.stderr).toContain("ambit init");
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
});

describe("ambit init --dry-run", () => {
  it("prints the bytes it would write and writes none of them", async () => {
    const result = await cli("init", "--dry-run");

    expect(result.code, result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toBe(
      [`would create ${INIT_FILENAME}`, "", scaffoldConfig().trimEnd()].join("\n"),
    );
    expect(await readdir(projectDir)).toEqual([]);
  });

  it("reports created: false in --json, with the same bytes a real run would write", async () => {
    const preview = await cli("init", "--dry-run", "--json");
    const previewed = JSON.parse(preview.stdout) as { created: boolean; text: string };

    await cli("init");

    expect(previewed.created).toBe(false);
    expect(previewed.text).toBe(await readConfig());
  });
});

describe("ambit init on an unusable directory", () => {
  it("names the directory rather than failing with a bare filesystem error", async () => {
    const missing = path.join(root, "absent");
    const err: string[] = [];

    const code = await run(["init", "--project", missing], {
      cwd: root,
      stdout: () => undefined,
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(ExitCode.Config);
    expect(err.join("\n")).toContain(`cannot write ${INIT_FILENAME}`);
    expect(err.join("\n")).toContain(missing);
  });
});

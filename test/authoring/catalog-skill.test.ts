/**
 * `ambit catalog skill new|rm|mv` — maintaining a skill directory.
 *
 * A skill's identity is its path, so the claims here are about paths as much as bytes. `new`
 * writes one document and nothing beside it, and the document is emitted YAML plus a body. `rm` and `mv`
 * act on a *directory*: the cases therefore assert what happened to files ambit never reads — a
 * `references/` note, and a file that is not even text — because a command that moved only the `SKILL.md`
 * would pass every assertion about frontmatter and still lose someone's work.
 *
 * The third claim is the one every authoring suite makes: a refusal costs nothing. Every rejection
 * asserts the tree is untouched, since an exit code says nothing about what was already half-written.
 *
 * Everything runs against a per-test copy of the fixture catalog. The shared fixture must stay clean: it
 * is what the golden profiles resolve against.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIXTURE_CATALOG_FILES, buildFixtureCatalog } from "../../scripts/fixture-catalog.js";
import type { Catalog } from "../../src/model/catalog.js";
import { parseCatalogDirectory } from "../../src/model/catalog.js";
import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";
import { emitYaml } from "../../src/model/yaml.js";

/** The fixture's required skill, its requirer, and the name the rename gives the first. */
const CORE = "company-context";
const CORE_DIR = "skills/company-context";
const CORE_FILE = `${CORE_DIR}/SKILL.md`;
const RENAMED_CORE = "context";
const RENAMED_CORE_DIR = "skills/context";
const RENAMED_CORE_FILE = `${RENAMED_CORE_DIR}/SKILL.md`;

const BRIEF = "acme-brief";
const BRIEF_DIR = "skills/acme-brief";
const BRIEF_FILE = `${BRIEF_DIR}/SKILL.md`;

const REVIEW = "code-review";
const REVIEW_DIR = "skills/code-review";

/** Every file `mv company-context` reports, in the path order it reports them. */
const RENAMED_FILES = [BRIEF_FILE, RENAMED_CORE_FILE];

const JANE = "jane-notes";
const JANE_DIR = "skills/jane-notes";
const JANE_FILE = `${JANE_DIR}/SKILL.md`;
const JANE_DESCRIPTION = "Jane's notes";

/** Bytes no parser of ambit's will read, so a move must carry them rather than re-encode them. */
const OPAQUE = Buffer.from([0x00, 0xff, 0xfe, 0x0a]);

/**
 * A nested skill, which is the one shape where a name carries a `.`: it is the path under `skills/`
 * with the separators swapped, so this one lives at `skills/personal/notes/SKILL.md`. The two tests
 * about namespace directories create it themselves, since a flat catalog has none to prune.
 */
const NESTED = "personal.notes";
const NESTED_NAMESPACE_DIR = "skills/personal";

let root: string;
let catalogDir: string;
let projectDir: string;

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

/** Runs a skill command against the catalog under test. */
async function skill(...argv: readonly string[]): Promise<CliResult> {
  return invoke("catalog", "skill", ...argv, "--catalog", catalogDir);
}

/** Runs one, asserting it succeeded. */
async function succeeds(...argv: readonly string[]): Promise<CliResult> {
  const result = await skill(...argv);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** Runs one, asserting it was refused with `code` and that nothing on disk moved. */
async function refused(code: ExitCode, ...argv: readonly string[]): Promise<CliResult> {
  const before = await snapshot();
  const result = await skill(...argv);

  expect(result.code, result.stdout).toBe(code);
  expect(result.stdout).toBe("");
  expect(await snapshot()).toEqual(before);
  return result;
}

async function read(file: string): Promise<string> {
  return readFile(path.join(catalogDir, file), "utf8");
}

async function write(file: string, text: string | Buffer): Promise<void> {
  const target = path.join(catalogDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
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

/** Every directory in the catalog, so a command that leaves an empty husk behind is visible. */
async function directories(): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const inner = relative === "" ? entry.name : `${relative}/${entry.name}`;
      found.push(inner);
      await walk(path.join(dir, entry.name), inner);
    }
  };
  await walk(catalogDir, "");
  return [...found].sort((a, b) => (a < b ? -1 : 1));
}

/** The fixture's own bytes for a file, as written before any command ran. */
function fixture(file: string): string {
  return FIXTURE_CATALOG_FILES[file] ?? "";
}

/** The catalog as the parser reads it back. */
async function parsed(): Promise<Catalog> {
  return parseCatalogDirectory("subject", `path:${catalogDir}`, catalogDir);
}

/** `ambit catalog validate` against the catalog: what every mutation has to leave passing. */
async function validates(): Promise<CliResult> {
  const result = await invoke("catalog", "validate", "--catalog", catalogDir);
  expect(result.code, result.stderr).toBe(ExitCode.Success);
  return result;
}

/** The frontmatter block of a `SKILL.md`, and the body below it. */
function halves(text: string): { frontmatter: string; body: string } {
  const closing = text.indexOf("\n---\n", "---\n".length);
  expect(closing, text).toBeGreaterThan(0);
  return {
    frontmatter: text.slice("---\n".length, closing + 1),
    body: text.slice(closing + "\n---\n".length),
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ambit-catalog-skill-"));
  catalogDir = path.join(root, "catalog");
  projectDir = path.join(root, "project");
  await buildFixtureCatalog(catalogDir);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, "ambit.yml"),
    "version: 1\ncatalogs:\n  - name: company\n    source: path:../catalog\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ambit catalog skill new", () => {
  it("writes one SKILL.md, in the directory its name derives, and nothing else", async () => {
    const before = await snapshot();

    await succeeds("new", JANE, "--description", JANE_DESCRIPTION, "--scope", "core");

    const after = await snapshot();
    expect(Object.keys(after)).toEqual([...Object.keys(before), JANE_FILE].sort());
    for (const file of Object.keys(before)) expect(after[file], file).toBe(before[file]);
    await validates();
  });

  it("emits the frontmatter ambit owns the shape of, then a body of its own", async () => {
    await succeeds(
      "new",
      JANE,
      "--description",
      JANE_DESCRIPTION,
      "--scope",
      "core",
      "--requires",
      `skill:${CORE}`,
      "--expects",
      "env:NOTES_TOKEN",
    );

    // The claim is the same one every scaffold makes: the bytes above the body are exactly `emitYaml`
    // of the values, so the keys are sorted and a value that would coerce is quoted. The
    // body's prose is deliberately not pinned — only that it opens on the skill's name.
    const { frontmatter, body } = halves(await read(JANE_FILE));
    expect(frontmatter).toBe(
      emitYaml({
        ambit: {
          expects: [{ env: "NOTES_TOKEN" }],
          requires: [{ skill: CORE }],
          scopes: ["core"],
        },
        description: JANE_DESCRIPTION,
        name: JANE,
      }),
    );
    expect(body.startsWith(`\n# ${JANE}\n`)).toBe(true);
  });

  it("agrees with its path, which is the only thing that names a skill", async () => {
    await succeeds("new", JANE, "--scope", "core");

    const skills = (await parsed()).skills;
    expect(skills.find((candidate) => candidate.name === JANE)).toMatchObject({
      name: JANE,
      path: JANE_DIR,
      scopes: ["core"],
    });
  });

  it("appears in `catalog dump`, which is the view resolution works from", async () => {
    await succeeds("new", JANE, "--description", JANE_DESCRIPTION, "--scope", "core");

    const dump = await invoke("dump-catalog", "--json", "--project", projectDir);
    const report = JSON.parse(dump.stdout) as {
      skills: Record<string, { description?: string; scopes: readonly string[] }>;
    };

    expect(dump.code, dump.stderr).toBe(ExitCode.Success);
    expect(report.skills[JANE]).toMatchObject({ description: JANE_DESCRIPTION, scopes: ["core"] });
  });

  it("sorts and deduplicates the lists it is given, so argv order is not information", async () => {
    await succeeds(
      "new",
      JANE,
      "--scope",
      "project.acme",
      "--scope",
      "core",
      "--scope",
      "core",
      "--expects",
      "env:SECOND",
      "--expects",
      "env:FIRST",
    );

    expect((await parsed()).skills.find((candidate) => candidate.name === JANE)).toMatchObject({
      scopes: ["core", "project.acme"],
      expects: [
        { kind: "env", name: "FIRST" },
        { kind: "env", name: "SECOND" },
      ],
    });
  });

  it("leaves out every key it was given nothing for, since absent and empty mean the same", async () => {
    await succeeds("new", JANE);

    expect(halves(await read(JANE_FILE)).frontmatter).toBe(emitYaml({ name: JANE }));
    expect((await parsed()).skills.find((candidate) => candidate.name === JANE)).toMatchObject({
      scopes: [],
      requires: [],
      expects: [],
    });
    await validates();
  });

  it("quotes a description that would otherwise come back as something else", async () => {
    await succeeds("new", JANE, "--description", "1.5");

    expect(await read(JANE_FILE)).toContain('description: "1.5"');
    expect((await parsed()).skills.find((candidate) => candidate.name === JANE)?.description).toBe(
      "1.5",
    );
  });

  it("refuses a scope the registry does not hold, naming the nearest one it does", async () => {
    const result = await refused(
      ExitCode.Resolution,
      "new",
      JANE,
      "--scope",
      "function.enginering",
    );

    expect(result.stderr).toContain('unknown scope "function.enginering" (scopes.yml)');
    expect(result.stderr).toContain('did you mean "function.engineering"?');
  });

  it("refuses a name the catalog already provides", async () => {
    const result = await refused(ExitCode.Resolution, "new", CORE, "--scope", "core");

    expect(result.stderr).toContain(`skill "${CORE}" already exists (${CORE_FILE})`);
    expect(result.stderr).toContain("pick another name, or edit the skill that is there");
  });

  it("refuses a name that could not be a path under skills/", async () => {
    const result = await refused(ExitCode.Config, "new", "jane..notes");

    expect(result.stderr).toContain('invalid skill name "jane..notes" (skills)');
  });

  it("prints what it created, which path that took, and what is left to do", async () => {
    const result = await succeeds(
      "new",
      JANE,
      "--description",
      JANE_DESCRIPTION,
      "--scope",
      "core",
    );

    expect(result.stdout).toBe(
      [
        "created (1)",
        `  ${JANE}  ${JANE_DESCRIPTION}`,
        "",
        "files (1)",
        `  ${JANE_FILE}  created`,
        "",
        `next: write the skill's instructions in ${JANE_FILE}`,
      ].join("\n"),
    );
  });

  it("carries the new file's bytes in --json", async () => {
    const result = await succeeds("new", JANE, "--description", JANE_DESCRIPTION, "--json");
    const report = JSON.parse(result.stdout) as {
      created: { name: string; description: string };
      files: readonly { file: string; text: string }[];
      trees: readonly unknown[];
      written: boolean;
    };

    expect(report.created).toEqual({ description: JANE_DESCRIPTION, name: JANE });
    expect(report.files).toEqual([{ file: JANE_FILE, text: await read(JANE_FILE) }]);
    expect(report.trees).toEqual([]);
    expect(report.written).toBe(true);
  });

  it("under --dry-run, prints the diff and writes nothing", async () => {
    const before = await snapshot();

    const result = await succeeds("new", JANE, "--scope", "core", "--dry-run");

    expect(result.stdout).toContain("would create (1)");
    expect(result.stdout).toContain(`  ${JANE_FILE} (created)`);
    expect(result.stdout).toContain(`+ name: ${JANE}`);
    expect(result.stdout).not.toContain("next:");
    expect(await snapshot()).toEqual(before);
  });
});

describe("ambit catalog skill rm", () => {
  it("deletes the whole directory, including the files ambit never reads", async () => {
    await write(`${BRIEF_DIR}/references/notes.md`, "# notes\n");
    await write(`${BRIEF_DIR}/logo.bin`, OPAQUE);

    await succeeds("rm", BRIEF);

    expect(
      Object.keys(await snapshot()).filter((file) => file.startsWith(`${BRIEF_DIR}/`)),
    ).toEqual([]);
    await validates();
  });

  it("prunes the namespace directory it emptied, and stops at the catalog's own layout", async () => {
    await succeeds("new", NESTED, "--scope", "core");

    await succeeds("rm", NESTED);

    const remaining = await directories();
    expect(remaining).not.toContain(NESTED_NAMESPACE_DIR);
    expect(remaining).toContain("skills");
  });

  it("refuses while another skill requires it, naming the requirer", async () => {
    const result = await refused(ExitCode.Resolution, "rm", CORE);

    expect(result.stderr).toContain(`skill "${CORE}" is still required (${CORE_FILE})`);
    expect(result.stderr).toContain(`skill "${BRIEF}" requires it (${BRIEF_FILE})`);
    // The next step names the command that clears a `requires` entry, not the hand-edit that
    // predated it.
    expect(result.stderr).toContain(
      `clear it from each with \`ambit catalog annotate skill:<skill> --remove-requires skill:${CORE}\``,
    );
  });

  it("refuses a skill the catalog does not provide, without guessing at a near miss", async () => {
    const result = await refused(ExitCode.Resolution, "rm", "jane-nothing");

    expect(result.stderr).toContain('unknown skill "jane-nothing" (skills/jane-nothing/SKILL.md)');
    expect(result.stderr).not.toContain("did you mean");
  });

  it("refuses a directory that holds another skill, naming the one in the way", async () => {
    await write(`${REVIEW_DIR}/nested/SKILL.md`, `---\nname: ${REVIEW}.nested\n---\n\n# nested\n`);

    const result = await refused(ExitCode.Resolution, "rm", REVIEW);

    expect(result.stderr).toContain(`cannot remove skill "${REVIEW}": it holds another skill`);
    expect(result.stderr).toContain(`skill "${REVIEW}.nested" is written inside it`);
  });

  it("prints the directory it removed, with the trailing slash that says it was one", async () => {
    const result = await succeeds("rm", BRIEF);

    expect(result.stdout).toBe(
      [
        "removed (1)",
        `  ${BRIEF}`,
        "",
        "files (1)",
        `  ${BRIEF_DIR}/  removed`,
        "",
        "next: drop the skill from `ambit.yml` in every project that lists it explicitly — a catalog cannot do it for them",
      ].join("\n"),
    );
  });

  it("reports the removal in --json as a tree, not as a file", async () => {
    const result = await succeeds("rm", BRIEF, "--json");
    const report = JSON.parse(result.stdout) as {
      files: readonly unknown[];
      removed: string;
      trees: readonly { directory: string; to: string | null }[];
      written: boolean;
    };

    expect(report.removed).toBe(BRIEF);
    expect(report.files).toEqual([]);
    expect(report.trees).toEqual([{ directory: BRIEF_DIR, to: null }]);
    expect(report.written).toBe(true);
  });

  it("under --dry-run, previews the removal and writes nothing", async () => {
    const before = await snapshot();

    const result = await succeeds("rm", BRIEF, "--dry-run");

    expect(result.stdout).toContain("would remove (1)");
    expect(result.stdout).toContain(`  ${BRIEF_DIR}/ (removed)`);
    expect(result.stdout).not.toContain("next:");
    expect(await snapshot()).toEqual(before);
  });
});

describe("ambit catalog skill mv", () => {
  it("moves the directory, corrects the name, and rewrites every requires that named it", async () => {
    const result = await succeeds("mv", CORE, RENAMED_CORE);

    expect(result.stdout).toBe(
      [
        "renamed (1)",
        `  ${CORE}  →  ${RENAMED_CORE}`,
        "",
        "files (3)",
        `  ${`${CORE_DIR}/`.padEnd(BRIEF_FILE.length)}  moved to ${RENAMED_CORE_DIR}/`,
        `  ${BRIEF_FILE}  updated`,
        `  ${RENAMED_CORE_FILE.padEnd(BRIEF_FILE.length)}  updated`,
        "",
        "next: update `ambit.yml` in every project that lists the old name — a catalog cannot do it for them",
      ].join("\n"),
    );

    // Both documents byte for byte. Only `name` and the one `requires` entry moved, so each skill's
    // description, its unrelated keys, the flow layout of `scopes`, the block layout of `requires`, and
    // both Markdown bodies are exactly as the fixture wrote them.
    expect(await read(RENAMED_CORE_FILE)).toBe(fixture(CORE_FILE).replace(CORE, RENAMED_CORE));
    expect(await read(BRIEF_FILE)).toBe(fixture(BRIEF_FILE).replace(CORE, RENAMED_CORE));
    expect(Object.keys(await snapshot())).not.toContain(CORE_FILE);
    await validates();
  });

  it("carries bytes it never reads through the move untouched", async () => {
    // The reason a tree moves rather than being rewritten file by file: a skill may carry an asset that
    // is not text at all, and reading one as UTF-8 to write it back would corrupt it.
    await write(`${CORE_DIR}/references/logo.bin`, OPAQUE);

    await succeeds("mv", CORE, RENAMED_CORE);

    const moved = await readFile(path.join(catalogDir, RENAMED_CORE_DIR, "references/logo.bin"));
    expect(moved.equals(OPAQUE)).toBe(true);
  });

  it("leaves no requires pointing at the name it moved away from", async () => {
    await succeeds("mv", CORE, RENAMED_CORE);

    const skills = (await parsed()).skills;
    const provided = new Set(skills.map((candidate) => candidate.name));
    for (const candidate of skills) {
      for (const requirement of candidate.requires) {
        // An entry in another namespace is untouched by a skill rename, and says so itself.
        if (requirement.kind !== "skill") continue;
        expect(
          provided.has(requirement.name),
          `${candidate.name} requires ${requirement.name}`,
        ).toBe(true);
      }
    }
    expect(await read(BRIEF_FILE)).toContain(`  - skill: ${RENAMED_CORE}\n`);
  });

  it("prunes the namespace it emptied, and creates the one it needs", async () => {
    await succeeds("new", NESTED, "--scope", "core");

    await succeeds("mv", NESTED, "team.notes");

    const remaining = await directories();
    expect(remaining).toContain("skills/team/notes");
    expect(remaining).not.toContain(NESTED_NAMESPACE_DIR);
    expect(remaining).toContain("skills");
  });

  it("refuses a name the catalog already provides", async () => {
    const result = await refused(ExitCode.Resolution, "mv", CORE, REVIEW);

    expect(result.stderr).toContain(`skill "${REVIEW}" already exists`);
  });

  it("refuses a new name that could not be a path under skills/", async () => {
    const result = await refused(ExitCode.Config, "mv", CORE, "jane-notes.");

    expect(result.stderr).toContain('invalid skill name "jane-notes."');
  });

  it("refuses a directory that holds another skill", async () => {
    await write(`${REVIEW_DIR}/nested/SKILL.md`, `---\nname: ${REVIEW}.nested\n---\n\n# nested\n`);

    const result = await refused(ExitCode.Resolution, "mv", REVIEW, "review");

    expect(result.stderr).toContain(`cannot move skill "${REVIEW}": it holds another skill`);
  });

  it("writes nothing when the new name is the old one", async () => {
    const before = await snapshot();

    const result = await succeeds("mv", CORE, CORE);

    expect(result.stdout).toContain("files (0)");
    expect(await snapshot()).toEqual(before);
  });

  it("under --dry-run, previews one moved directory and a one-line edit inside it", async () => {
    const before = await snapshot();

    const result = await succeeds("mv", CORE, RENAMED_CORE, "--dry-run");

    expect(result.stdout).toContain("would rename (1)");
    expect(result.stdout).toContain(`diff (${RENAMED_FILES.length + 1})`);
    expect(result.stdout).toContain(`  ${CORE_DIR}/ (moved to ${RENAMED_CORE_DIR}/)`);
    // The moved document reads as an edit rather than as a creation, because that is what happened to
    // it: everything but its `name` arrives unchanged.
    expect(result.stdout).toContain(`  ${RENAMED_CORE_FILE} (updated)`);
    expect(result.stdout).toContain(`- name: ${CORE}`);
    expect(result.stdout).toContain(`+ name: ${RENAMED_CORE}`);
    expect(await snapshot()).toEqual(before);
  });

  it("carries every rewritten file's bytes, and the move itself, in --json", async () => {
    const result = await succeeds("mv", CORE, RENAMED_CORE, "--json");
    const report = JSON.parse(result.stdout) as {
      files: readonly { file: string; text: string }[];
      renamed: { from: string; to: string };
      trees: readonly { directory: string; to: string | null }[];
      written: boolean;
    };

    expect(report.renamed).toEqual({ from: CORE, to: RENAMED_CORE });
    expect(report.files.map((change) => change.file)).toEqual(RENAMED_FILES);
    for (const change of report.files) expect(change.text).toBe(await read(change.file));
    expect(report.trees).toEqual([{ directory: CORE_DIR, to: RENAMED_CORE_DIR }]);
  });
});

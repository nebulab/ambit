/**
 * `ambit init` — scaffold a project, which is also a catalog.
 *
 * Every ambit project is technically a catalog: a project that ships a skill, a server or a hook of
 * its own puts it in `skills/`, `mcps/` or `hooks/` and lists itself under `catalogs:`, because that
 * is the only way to declare one. So this command scaffolds both halves — `ambit.yml`, the three item
 * directories, and a live `catalogs:` entry naming the project itself — and there is no second
 * command to run afterwards. What used to be `ambit catalog init` is these three `.gitkeep` files.
 *
 * Four decisions a reader would otherwise have to reverse-engineer:
 *
 * - **The three directories are always created**, in every project, not behind a flag. It is three
 *   empty files, and it is what makes the scaffolded `local` entry true rather than aspirational —
 *   a `catalogs:` entry whose directories a person has to create first is a config that does not yet
 *   describe the project it sits in. They are created *by* writing `.gitkeep` files inside them,
 *   which is also what makes them survive the first commit: git tracks no empty directory, and a
 *   project that loses all three on the way into a repo is not a scaffolded project.
 * - **`local` is scaffolded live; the `requires` entry selecting it is commented.** These collide
 *   otherwise. An entry matching nothing is exit 3, and a fresh project's `local` catalog is three
 *   empty directories — so a scaffolded `local/*` requirement would fail `ambit validate` on the
 *   project it was just written into. The catalog entry costs nothing while it is empty; the
 *   requirement does, so it waits, commented, until there is something to select.
 * - **No CI workflow is scaffolded**, unlike the catalog scaffold this absorbed. That command could
 *   assume a fresh repo; a project is routinely an existing application, and writing into its
 *   `.github/workflows/` is presumptuous in a way writing `ambit.yml` is not. The workflow is a
 *   paste-able block in the README instead, running `ambit validate`.
 * - **An existing `ambit.yml` is refused; an existing `.gitkeep` is reported as `kept`.** Each half's
 *   own stance, and they do not conflict once stated that way: the config is the file that makes the
 *   directory a project, so overwriting one would discard a config someone wrote, whereas a
 *   `.gitkeep` carries no bytes to lose and is exactly what a second run should find.
 *
 * The scaffold is documentation as much as configuration. It is the one place a person meets the
 * entry grammar at the moment it matters — while writing the `requires` list — so the comments say
 * outright that both keys of an entry are declared and that a pattern is matched literally. Getting
 * that wrong yields a bundle quietly missing what the config asked for, or a refusal whose cause is
 * a character.
 *
 * The bytes are *emitted*, not templated: the file is a list of {@link ScaffoldBlock}s rendered by
 * {@link renderScaffold}, so stripping the comments from the scaffold leaves exactly what ambit would
 * emit from the same values. `test/project/init.test.ts` pins that equivalence rather than a
 * golden copy of the prose, which is free to be reworded.
 *
 * The commented-out `requires` example is emitted the same way and then prefixed, so the one part of
 * the file a person is expected to uncomment cannot be malformed YAML — and it quotes the alias the
 * live `catalogs:` block declares, so uncommenting it leaves a config that agrees with itself.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { HOOKS_DIRNAME, MCPS_DIRNAME, SKILLS_DIRNAME } from "../model/catalog.js";
import {
  CONFIG_FILENAMES,
  CONFIG_VERSION,
  DEFAULT_HARNESSES,
  existingConfigFiles,
} from "../model/config.js";
import { configError } from "../errors.js";
import type { ScaffoldBlock } from "../model/scaffold.js";
import { renderScaffold } from "../model/scaffold.js";

/** The name `init` writes: the first of the two accepted config filenames. */
export const INIT_FILENAME = CONFIG_FILENAMES[0];

/**
 * What is written inside `skills/`, `mcps/` and `hooks/` so the directories exist and survive a
 * commit. Invisible to catalog parsing, which reads only `skills/**`, `mcps/*.yml` and `hooks/**`.
 */
export const KEEP_FILENAME = ".gitkeep";

/** The alias the scaffolded `catalogs` entry gives the project's own directory. */
export const LOCAL_CATALOG = "local";

/** The `source` that names the project itself: its own `skills/`, `mcps/` and `hooks/`. */
const LOCAL_SOURCE = "path:.";

/** The item directories the scaffold creates, in the order they are written. */
const ITEM_DIRNAMES: readonly string[] = [HOOKS_DIRNAME, MCPS_DIRNAME, SKILLS_DIRNAME];

/**
 * The scaffold, block by block.
 *
 * Every block that carries a key sits in sorted-key order, and the commented `requires` example sits
 * where its key would go — so uncommenting it leaves the file sorted, and the whole scaffold matches
 * what `emitYaml` produces from its values.
 */
const BLOCKS: readonly ScaffoldBlock[] = [
  {
    comment: [
      "ambit project config. `ambit install` reads this file, resolves a bundle of skills and",
      "MCP servers from it, and writes that bundle into each harness listed below.",
      "",
      "`version` is the only required key. Every definition lives in a file a catalog holds, so this",
      "project lists itself below: a skill of its own goes in `skills/<name>/SKILL.md`, a server in",
      "`mcps/<name>.yml`, a hook in `hooks/<name>/HOOK.yml`.",
    ],
  },
  {
    comment: [
      "The catalogs to draw skills, MCP servers and hooks from.",
      "",
      "`local` is this project's own three directories, which `ambit init` created — a project that",
      "ships nothing simply leaves them empty, and an empty catalog costs nothing. Add another with a",
      "`source` of `owner/repo`, `owner/repo@ref`, a git URL, or `path:./relative/dir`, and a `ref`",
      'to pin it to: quote one that looks like a number — `ref: "1234567"` — or YAML will read it as',
      "one.",
      "",
      "The order carries no meaning: none takes precedence over another, and selecting one name from",
      "two of them is refused rather than settled here.",
    ],
    values: { catalogs: [{ name: LOCAL_CATALOG, source: LOCAL_SOURCE }] },
  },
  {
    comment: [
      "The agent harnesses to install into: `claude`, `codex`, `cursor`, `opencode`, `vscode`.",
      "",
      "Skills go to `.agents/skills/` whichever are listed — one copy, however many tools read it.",
      "`claude` and `cursor` also get `.claude/skills` as a link to it, since neither reads the",
      "shared directory natively. Each harness's MCP servers go in that harness's own config file:",
      "`.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.opencode/opencode.jsonc`,",
      "`.vscode/mcp.json`.",
    ],
    values: { harnesses: [...DEFAULT_HARNESSES] },
  },
  {
    comment: [
      "What this project selects — who this project is, in its catalogs' terms.",
      "",
      "Nothing is implicit: ambit adds nothing on its own, so an item no entry below reaches is not",
      "installed, however universal it looks. An entry declares both of its keys and neither is",
      "guessed — the field to match (`name` or `tag`), because `function.engineering` is a plausible",
      "name prefix and a plausible tag, and `capabilities`, because hooks execute and an entry",
      "written thinking about skills must not silently install one.",
      "",
      "An address is `<catalog>/<pattern>`, where the catalog is an alias from `catalogs:` above.",
      "In a pattern, `*` matches any run of characters, including `.`, and a pattern without one is",
      "an exact name. `core.*` matches `core.a` and `core.a.b` but not `core` itself, so selecting a",
      "prefix and the item named exactly that takes two entries. `local/*` is the whole catalog.",
      "",
      "An entry that matches nothing is an error, not a silent miss — which is why this block is",
      "commented out: `local` is empty until this project ships something, and the entry below would",
      "fail on the project it was just scaffolded into. Uncomment it once there is something to take.",
    ],
    example: {
      requires: [{ name: `${LOCAL_CATALOG}/*`, capabilities: ["skills", "mcps", "hooks"] }],
    },
  },
  {
    comment: ["The config format version. `1` is the only one this build understands."],
    values: { version: CONFIG_VERSION },
  },
];

/**
 * The scaffolded `ambit.yml`, as bytes.
 *
 * Pure and byte-stable: the output is a function of {@link BLOCKS} alone, so two runs on two
 * machines scaffold the same file.
 */
export function scaffoldConfig(): string {
  return renderScaffold(BLOCKS);
}

/** One file the scaffold writes. */
export interface ScaffoldedFile {
  /** Project-relative and `/`-separated — how output and messages name it. */
  readonly file: string;
  /** The bytes it holds. Empty for a `.gitkeep`, whose whole content is its path. */
  readonly text: string;
}

/**
 * The scaffold: every file it writes, with its bytes, in path order.
 *
 * Pure and byte-stable — nothing about the target directory reaches the contents, so two runs into
 * two differently named directories produce identical trees.
 */
export function scaffoldProject(): readonly ScaffoldedFile[] {
  const files: readonly ScaffoldedFile[] = [
    { file: INIT_FILENAME, text: scaffoldConfig() },
    ...ITEM_DIRNAMES.map((dirname) => ({ file: `${dirname}/${KEEP_FILENAME}`, text: "" })),
  ];

  return [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** How an init was asked to behave. */
export interface InitOptions {
  /** `--dry-run`: report the files that would be written and touch nothing. */
  readonly dryRun?: boolean;
}

/** What an init produced. */
export interface InitResult {
  /**
   * The files written, or under `--dry-run` the ones that would be, in path order. Each carries its
   * bytes, so a preview and a consuming tool both have what they need.
   */
  readonly created: readonly ScaffoldedFile[];
  /** Scaffold files that were already there, left byte-identical, in path order. */
  readonly kept: readonly string[];
  /**
   * False under `--dry-run`, and true otherwise.
   *
   * There is no third case: an existing `ambit.yml` is refused rather than kept, so a run that gets
   * this far always has at least the config to write. It is carried anyway because it is what
   * distinguishes the preview from the real thing in `--json`, where there is no heading to say so.
   */
  readonly written: boolean;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Writes one scaffolded file, creating the directory that holds it.
 *
 * `mkdir` is what creates `skills/`, `mcps/` and `hooks/` — there is no separate step that makes a
 * directory, so a `.gitkeep` and the directory it keeps arrive together or not at all. It is not
 * what creates the project root: {@link initProject} refuses a missing one before reaching here.
 *
 * @throws {AmbitError} exit 2 if the write fails, naming the file.
 */
async function write(projectDir: string, scaffolded: ScaffoldedFile): Promise<void> {
  const target = path.join(projectDir, scaffolded.file);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, scaffolded.text, "utf8");
  } catch (error) {
    throw configError(`cannot write ${scaffolded.file}`, [
      error instanceof Error ? error.message : String(error),
      `check that ${projectDir} is writable`,
    ]);
  }
}

/**
 * Scaffolds a project in `projectDir`: `ambit.yml`, and the three item directories that make it a
 * catalog of its own.
 *
 * A directory that already holds either accepted config name is refused, under `--dry-run` too: a
 * preview of a command that would be refused is refused, the same stance `install --dry-run` takes
 * about ownership. Nothing is written on that path — not the config, and not a `.gitkeep`.
 *
 * @param projectDir the project root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 if the directory already holds an ambit config, if it does not exist,
 *   or if a file cannot be written.
 */
export async function initProject(
  projectDir: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const present = await existingConfigFiles(projectDir);
  if (present.length > 0) {
    throw configError(`refusing to overwrite ${present.join(" and ")}`, [
      `${projectDir} already holds an ambit config`,
      `edit it, or delete it and run \`ambit init\` again`,
    ]);
  }

  // A missing root is refused rather than created, even though the scaffold creates directories
  // inside it: `--project` naming the wrong path should not leave a project in a directory nobody
  // meant, and three item directories under it make that mistake more expensive rather than less.
  if (!(await isDirectory(projectDir))) {
    throw configError(`cannot initialize ${projectDir}`, [
      "it is not a directory, and `init` creates no project root",
      "create it, or point `--project` at a directory that exists",
    ]);
  }

  const created: ScaffoldedFile[] = [];
  const kept: string[] = [];
  for (const scaffolded of scaffoldProject()) {
    if (await exists(path.join(projectDir, scaffolded.file))) kept.push(scaffolded.file);
    else created.push(scaffolded);
  }

  if (options.dryRun === true) return { created, kept, written: false };

  for (const scaffolded of created) await write(projectDir, scaffolded);

  return { created, kept, written: true };
}

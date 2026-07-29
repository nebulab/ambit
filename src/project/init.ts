/**
 * `ambit init` — scaffold a project's `ambit.yml`.
 *
 * The scaffold is documentation as much as configuration. It is the one place a person meets the
 * entry grammar at the moment it matters — while writing the `requires` list — so the comments say
 * outright that both keys of an entry are declared and that a pattern is matched literally. Getting
 * that wrong yields a bundle quietly missing what the config asked for, or a refusal whose cause is
 * a character.
 *
 * `requires` is scaffolded **commented out**, unlike the `scopes` list it replaces, and the reason is
 * the rule that replaced it: an entry matching nothing is exit 3, so any live entry here would fail
 * on a project that has not been pointed at a catalog yet. An absent `requires` selects nothing and
 * says so, which is the honest state of a fresh project.
 *
 * The bytes are *emitted*, not templated: the file is a list of {@link ScaffoldBlock}s rendered by
 * {@link renderScaffold}, so stripping the comments from the scaffold leaves exactly what ambit would
 * emit from the same values. `test/project/init.test.ts` pins that equivalence rather than a
 * golden copy of the prose, which is free to be reworded.
 *
 * The commented-out `catalogs` and `requires` examples are emitted the same way and then prefixed, so
 * the parts of the file a person is expected to uncomment cannot be malformed YAML — and the second
 * quotes the alias the first declares, so uncommenting both leaves a config that agrees with itself.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

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

/** The alias the commented `catalogs` example declares, which the `requires` example qualifies with. */
const EXAMPLE_CATALOG = "company";

/**
 * The scaffold, block by block.
 *
 * Every block that carries a key sits in sorted-key order, and the commented `catalogs` example sits
 * where its key would go — so uncommenting it leaves the file sorted, and the whole scaffold matches
 * what `emitYaml` produces from its values.
 */
const BLOCKS: readonly ScaffoldBlock[] = [
  {
    comment: [
      "ambit project config. `ambit install` reads this file, resolves a bundle of skills and",
      "MCP servers from it, and writes that bundle into each harness listed below.",
      "",
      "`version` is the only required key. Every definition lives in a file a catalog holds, so a",
      "project that ships a skill, a server or a hook of its own lists itself as one.",
    ],
  },
  {
    comment: [
      "The catalogs to draw skills and MCP servers from. The order carries no meaning: none takes",
      "precedence over another, and selecting one name from two of them is refused rather than",
      "settled here. A source is `owner/repo`, `owner/repo@ref`, a git URL, or",
      '`path:./relative/dir`. Quote a ref that looks like a number — `ref: "1234567"` — or YAML',
      "will read it as one.",
    ],
    example: { catalogs: [{ name: EXAMPLE_CATALOG, ref: "main", source: "acme/skills" }] },
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
      "prefix and the item named exactly that takes two entries. `company/*` is the whole catalog.",
      "",
      "An entry that matches nothing is an error, not a silent miss — which is why this block is",
      "commented out rather than scaffolded with an example entry that no catalog could satisfy.",
    ],
    example: {
      requires: [
        {
          tag: `${EXAMPLE_CATALOG}/function.engineering`,
          capabilities: ["skills", "mcps", "hooks"],
        },
        { name: `${EXAMPLE_CATALOG}/core.*`, capabilities: ["skills"] },
      ],
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

/** How an init was asked to behave. */
export interface InitOptions {
  /** `--dry-run`: report the file that would be written and touch nothing. */
  readonly dryRun?: boolean;
}

/** What an init produced. */
export interface InitResult {
  /** The config's name, project-relative — how output and messages name it. */
  readonly file: string;
  /** The scaffolded bytes, whether or not they were written. */
  readonly text: string;
  /** False under `--dry-run`, which produces the same bytes and writes none of them. */
  readonly created: boolean;
}

/**
 * Scaffolds `ambit.yml` in a project directory.
 *
 * A directory that already holds either accepted config name is refused, under `--dry-run` too: a
 * preview of a command that would be refused is refused, the same stance `install --dry-run` takes
 * about ownership. Nothing is written on that path.
 *
 * @param projectDir the project root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 if the directory already holds an ambit config, or if the file cannot
 *   be written — a directory that does not exist yet is the common case, and `init` reports it
 *   rather than creating one, since `--project` naming the wrong path should not leave a config
 *   behind in a directory nobody meant.
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

  const text = scaffoldConfig();
  if (options.dryRun === true) return { file: INIT_FILENAME, text, created: false };

  try {
    await writeFile(path.join(projectDir, INIT_FILENAME), text, "utf8");
  } catch (error) {
    throw configError(`cannot write ${INIT_FILENAME}`, [
      error instanceof Error ? error.message : String(error),
      `create ${projectDir}, or point \`--project\` at a directory that exists`,
    ]);
  }

  return { file: INIT_FILENAME, text, created: true };
}

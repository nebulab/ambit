/**
 * `ambit init` — scaffold a project's `ambit.yml`.
 *
 * The scaffold is documentation as much as configuration. It is the one place a person meets the
 * selection rule at the moment it matters — while writing the `scopes` list — so the comments say
 * outright that nothing is implicit and that a held scope reaches downward only. Getting
 * that wrong yields a bundle quietly missing the company floor, and by design nothing warns about
 * it; the warning therefore has to live in the file itself.
 *
 * The bytes are *emitted*, not templated: the file is a list of {@link ScaffoldBlock}s rendered by
 * {@link renderScaffold}, so stripping the comments from the scaffold leaves exactly what ambit would
 * emit from the same values. `test/init.test.ts` pins that equivalence rather than a
 * golden copy of the prose, which is free to be reworded.
 *
 * The commented-out `catalogs` example is emitted the same way and then prefixed, so the one part of
 * the file a person is expected to uncomment cannot be malformed YAML.
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

/**
 * The scope the scaffold holds.
 *
 * A convention, not a rule ambit knows: the resolver reserves no names, and a catalog that
 * calls its universal floor something else will reject this one as unregistered. Scaffolding it
 * anyway is deliberate — the alternative is an empty `scopes` list, which selects nothing and
 * teaches nothing about why.
 */
export const INIT_SCOPE = "core";

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
      "`version` is the only required key. Two more exist for what a catalog cannot cover:",
      "`skills`, for a skill from outside any catalog, and `mcps`, for a server defined inline.",
    ],
  },
  {
    comment: [
      "The catalogs to draw skills and MCP servers from, in priority order: on a name collision,",
      "the first one wins. A source is `owner/repo`, `owner/repo@ref`, a git URL, or",
      '`path:./relative/dir`. Quote a ref that looks like a number — `ref: "1234567"` — or YAML',
      "will read it as one.",
    ],
    example: { catalogs: [{ name: "company", ref: "main", source: "acme/skills" }] },
  },
  {
    comment: [
      "The agent harnesses to install into. `claude` writes `.claude/skills/` and `.mcp.json`.",
    ],
    values: { harnesses: [...DEFAULT_HARNESSES] },
  },
  {
    comment: [
      "The scopes this project holds — who this project is, in the catalog's terms.",
      "",
      "Nothing is implicit. ambit reserves no scope names and adds nothing on its own, so a scope",
      "that is not listed here selects nothing, however universal it looks. `core` is the",
      "conventional name for a catalog's universal floor, and it is scaffolded here because",
      "forgetting it is the mistake that costs the most and warns the least.",
      "",
      "A held scope selects itself and every scope beneath it — descendants only. Holding",
      "`function.engineering` also selects `function.engineering.frontend`; holding the child does",
      "not reach back up to the parent.",
    ],
    values: { scopes: [INIT_SCOPE] },
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

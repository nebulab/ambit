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
 *
 * The file it writes is also the file `ambit catalog init` writes, since one format covers both roles.
 * So this command refuses a config that already answers *its* keys and adds them to one that does not —
 * a catalog repo that decides to install its own skills gets the consumer half appended to the document
 * it already has, with the `catalog:` block and every comment around it untouched.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG_FILENAMES, DEFAULT_HARNESSES, existingConfigFiles } from "../model/config.js";
import type { AmbitError } from "../errors.js";
import { configError } from "../errors.js";
import type { ScaffoldBlock } from "../model/scaffold.js";
import { VERSION_BLOCK, appendScaffold, renderScaffold } from "../model/scaffold.js";
import { parseYamlMapping } from "../model/yaml.js";

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
      "The scopes this project holds — who this project is, in the catalog's terms. This is a list",
      "of scopes *held*, not a registry of scopes defined: a catalog defines them under",
      "`catalog.scopes`, in its own copy of this file.",
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
  VERSION_BLOCK,
];

/**
 * The keys that make a config a *project's*, whichever of them it wrote.
 *
 * A config holding any of them has already been initialized as a project, and this command has nothing
 * to add. `version` is not among them: it belongs to the format rather than to either role, and a
 * catalog's config carries it too.
 */
const PROJECT_KEYS: readonly string[] = [
  "catalogs",
  "harnesses",
  "hooks",
  "mcps",
  "scopes",
  "skills",
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
  /** The bytes the config would hold afterwards, whether or not they were written. */
  readonly text: string;
  /**
   * The bytes it held before, absent when this command created it.
   *
   * Present when a catalog's config was there already and the consumer keys were added to it — which
   * is what lets the caller print a diff rather than a whole file, and say "updated" rather than
   * "created".
   */
  readonly before?: string;
  /** False under `--dry-run`, which produces the same bytes and writes none of them. */
  readonly written: boolean;
}

/** The error for a config that has already been initialized as a project. */
function alreadyAProject(projectDir: string, file: string): AmbitError {
  return configError(`refusing to overwrite ${file}`, [
    `${projectDir} already holds an ambit project config`,
    `edit it, or delete it and run \`ambit init\` again`,
  ]);
}

/**
 * The config to write, and the bytes it is replacing.
 *
 * A directory holding no config gets the whole scaffold. One whose config already answers a project key
 * is refused — this command has nothing to add to it. One that answers none, which is a catalog repo
 * that has not installed anything for itself yet, gets the consumer blocks appended: its `catalog:`
 * block, its comments and its key order survive byte-for-byte.
 *
 * @throws {AmbitError} exit 2 if both accepted names are there, if the config has already been
 *   initialized as a project, or if it cannot be read or parsed.
 */
async function plan(projectDir: string): Promise<InitResult> {
  const present = await existingConfigFiles(projectDir);
  if (present.length > 1) {
    throw configError(`${present.join(" and ")} both exist in ${projectDir}`, [
      "ambit cannot tell which one is authoritative",
      `delete one, keeping ${CONFIG_FILENAMES[0]}`,
    ]);
  }

  const file = present[0];
  if (file === undefined) {
    return { file: INIT_FILENAME, text: scaffoldConfig(), written: false };
  }

  const target = path.join(projectDir, file);
  let existing: string;
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    throw configError(`cannot read ${file}`, [
      error instanceof Error ? error.message : String(error),
      `check that ${target} is readable`,
    ]);
  }

  // Parsed for one question — which keys are already answered — so a document ambit cannot read is
  // refused here rather than silently appended to.
  const document = parseYamlMapping(existing, file);
  if (PROJECT_KEYS.some((key) => document.has(key))) throw alreadyAProject(projectDir, file);

  return {
    file,
    text: appendScaffold(existing, BLOCKS, (key) => document.has(key)),
    before: existing,
    written: false,
  };
}

/**
 * Scaffolds `ambit.yml` in a project directory, or adds the project half to the config already there.
 *
 * A config that has already been initialized as a project is refused, under `--dry-run` too: a
 * preview of a command that would be refused is refused, the same stance `install --dry-run` takes
 * about ownership. Nothing is written on that path.
 *
 * @param projectDir the project root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 if the directory's config is already a project's, or if the file cannot
 *   be written — a directory that does not exist yet is the common case, and `init` reports it
 *   rather than creating one, since `--project` naming the wrong path should not leave a config
 *   behind in a directory nobody meant.
 */
export async function initProject(
  projectDir: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const planned = await plan(projectDir);
  if (options.dryRun === true) return planned;

  try {
    await writeFile(path.join(projectDir, planned.file), planned.text, "utf8");
  } catch (error) {
    throw configError(`cannot write ${planned.file}`, [
      error instanceof Error ? error.message : String(error),
      `create ${projectDir}, or point \`--project\` at a directory that exists`,
    ]);
  }

  return { ...planned, written: true };
}

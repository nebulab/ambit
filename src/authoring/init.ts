/**
 * `ambit catalog init` — scaffold a catalog, the mirror of what
 * `ambit init` does for a project.
 *
 * A catalog's shape is not the interesting part; the selection rule is. Nesting the registry wrongly is
 * the one mistake here that cannot be fixed without editing every project that holds the scope, so the
 * scaffolded `README.md` carries the descendants-only rule and its nest-versus-sibling guidance
 * in full. That is why the README is part of the scaffold at all rather than a nicety: a catalog whose
 * author never met the rule is a catalog whose tree has to be restructured later.
 *
 * Four decisions a reader would otherwise have to reverse-engineer:
 *
 * - **Every write goes through the editor** ({@link applyCatalogEdit}), like every other authoring
 *   mutation, so the scaffold gets atomic writes, the root check, `--dry-run`, and — the one that
 *   matters — validation of the *result*: a scaffold that would not pass `ambit catalog validate` is
 *   not written. The directories are therefore created by writing the `.gitkeep` files inside them,
 *   which is also what makes them survive the first commit; git tracks no empty directory, and a
 *   catalog that loses three of its four directories on the way into a repo is not a scaffolded repo.
 * - **An existing `catalog:` block is refused; an existing config without one is added to.** The two
 *   halves of `ambit.yml` belong to two commands, so "refuse if the file is there" is not a stance this
 *   one can hold: a repo that ran `ambit init` first has a config already, and its catalog half has to
 *   arrive in that document rather than beside it. So the block this command owns is what it refuses to
 *   overwrite (exit 2, nothing written), and everything else in the file survives byte-for-byte
 *   ({@link appendScaffold}).
 * - **Any other occupant is left alone.** A catalog is normally initialized *inside* a repo that
 *   already has a README and a workflows directory, so a scaffold file that is already there is kept as
 *   it is and reported — overwriting someone's README would be exactly the reformatting authoring rule
 *   2 exists to forbid, one file up.
 * - **A missing root is created**, unlike `ambit init`, which refuses one. The scaffold necessarily
 *   creates directories (`skills/`, `mcps/`, `hooks/`, `.github/workflows/`), so "this command does not create
 *   directories" is not a stance it could hold, and starting a new catalog with
 *   `ambit catalog init --catalog acme-skills` is the ordinary first use.
 */
import { readFile, stat } from "node:fs/promises";

import {
  HOOKS_DIRNAME,
  HOOK_FILENAME,
  LEGACY_REGISTRY_FILENAME,
  MCPS_DIRNAME,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
} from "../model/catalog.js";
import {
  CATALOG_KEY,
  CONFIG_FILENAMES,
  REGISTRY_KEY_PATH,
  REGISTRY_PATH,
  existingConfigFiles,
} from "../model/config.js";
import type { CatalogFileChange, EditOptions, EditedFile } from "./editor.js";
import { applyCatalogEdit, catalogFilePath } from "./editor.js";
import type { AmbitError } from "../errors.js";
import { configError } from "../errors.js";
import type { ScaffoldBlock } from "../model/scaffold.js";
import { VERSION_BLOCK, appendScaffold, renderScaffold } from "../model/scaffold.js";
import { parseYamlMapping } from "../model/yaml.js";

/**
 * The scope the scaffolded registry holds.
 *
 * A convention, not a rule ambit knows, and the same one `ambit init` scaffolds into a
 * project — so a freshly initialized project and a freshly initialized catalog agree out of the box,
 * which is the pair someone tries first.
 */
export const CATALOG_INIT_SCOPE = "core";

/** The scaffolded README, where the selection rule is documented. */
export const CATALOG_README_FILENAME = "README.md";

/** The scaffolded CI workflow, which runs `ambit catalog validate`. */
export const CATALOG_WORKFLOW_FILENAME = ".github/workflows/validate.yml";

/**
 * What is written inside `skills/`, `mcps/` and `hooks/` so the directories exist and survive a commit.
 * Invisible to catalog parsing, which reads only `ambit.yml`, `skills/**`, `mcps/*.yml`, and
 * `hooks/**`.
 */
export const CATALOG_KEEP_FILENAME = ".gitkeep";

/**
 * The command the scaffolded workflow runs, and the one the README tells a maintainer to run.
 *
 * `ambit catalog validate` rather than `ambit validate`: the subject is this catalog on its own terms,
 * and the project-wide check would read the consumer half of the same file — which a catalog repo may
 * not have written at all. It needs no `--catalog` either: the flag defaults to the cwd, which in CI is
 * the checkout root.
 */
const VALIDATE_COMMAND = "npx --yes @nebulab/ambit catalog validate";

/**
 * What this repo publishes as a catalog.
 *
 * The comment has to carry the `scopes:`-versus-`catalog.scopes:` distinction, because the scaffold is
 * where a person meets both keys and one document can hold them four lines apart: the nesting makes
 * them unambiguous to the parser and not to the reader.
 */
const CATALOG_BLOCK: ScaffoldBlock = {
  comment: [
    "What this repo publishes as a catalog. Everything under `catalog:` describes what other",
    "projects get from it; the top-level keys — if this repo installs skills for itself too —",
    "describe what *this* repo holds. `catalog.scopes` defines scopes; a top-level `scopes:`",
    "would be the list of scopes held, which is a different claim under the same word.",
    "",
    "The scope registry: every scope any skill, MCP server or hook in this catalog declares must",
    "be listed here, with a description. A scope that is not registered selects nothing and warns",
    "nobody, so registering them is what turns a typo into an error — and the descriptions are",
    "what a tool asking someone which scopes they hold renders as its list.",
    "",
    "A held scope selects itself and every scope beneath it — descendants only. Nest a scope",
    "only when holding the parent genuinely implies wanting every child; make siblings of",
    "anything people pick independently. README.md explains the choice; it is much cheaper to",
    "make now than to change once projects name these scopes.",
  ],
  values: {
    [CATALOG_KEY]: {
      scopes: {
        [CATALOG_INIT_SCOPE]: { description: "The universal floor — what everyone here needs" },
      },
    },
  },
};

/**
 * The config this command writes, in sorted-key order: `catalog`, then `version`.
 *
 * Both, because either may be the one that creates the file. When `ambit init` got there first the
 * version key is already written, and {@link appendScaffold} drops that block rather than writing a
 * second one — which YAML would reject as a duplicate key.
 */
const CONFIG_BLOCKS: readonly ScaffoldBlock[] = [CATALOG_BLOCK, VERSION_BLOCK];

const WORKFLOW_BLOCKS: readonly ScaffoldBlock[] = [
  {
    comment: [
      "Validates this catalog on every push and pull request: that every scope a skill or server",
      "declares is registered, that every `requires` resolves to something this catalog provides,",
      "that no `requires` edge forms a cycle, and that every skill's name matches its path.",
      "",
      "Catching those here is the point. A broken catalog otherwise fails for whoever installs it",
      "next, which is never the person who broke it.",
    ],
    values: {
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
            { name: "Validate the catalog", run: VALIDATE_COMMAND },
          ],
        },
      },
    },
  },
  { comment: ["The name this check reports under."], values: { name: "validate" } },
  { comment: ["Every push, and every pull request."], values: { on: ["push", "pull_request"] } },
];

/**
 * The scaffolded README.
 *
 * Prose, so it is written as prose — the §3.0 emit rules are about documents ambit parses, and this is
 * the one scaffolded file nothing reads back. Its middle two sections are the selection rule and
 * the nest-versus-sibling guidance the spec asks a catalog's README to carry prominently.
 */
const README = `# An ambit catalog

This directory is a catalog: the skills, MCP server definitions and hooks \`ambit\` installs into
projects, each labelled with the *scopes* that should get it.

## Layout

    ${CONFIG_FILENAMES[0]}                 the \`${CATALOG_KEY}:\` block — every scope, with a description
    ${SKILLS_DIRNAME}/<name>/${SKILL_FILENAME}    one directory per skill
    ${MCPS_DIRNAME}/<name>.yml           one file per MCP server
    ${HOOKS_DIRNAME}/<name>/${HOOK_FILENAME}     one directory per hook

A catalog and a project share one config format, and \`${CATALOG_KEY}:\` is the half that makes this
directory a catalog. If this repo also installs skills *for itself*, its own \`scopes\`, \`catalogs\`
and \`harnesses\` go at the top level of the same file — run \`ambit init\` and it adds them.

A skill's name is its path under \`${SKILLS_DIRNAME}/\`, so \`${SKILLS_DIRNAME}/close-crm/\` holds the skill \`close-crm\`.
Nothing else names it — which is what keeps this directory a plain skills repo that other tools
can read. Nesting a skill is allowed and joins the segments with \`.\`, so
\`${SKILLS_DIRNAME}/sales/close-crm/\` is \`sales.close-crm\`.

## A held scope selects its descendants

A project holds a list of scopes. **A held scope selects itself and every scope beneath it —
descendants only.**

Holding \`function.engineering\` selects things scoped \`function.engineering\` *and*
\`function.engineering.frontend\`. Holding \`function.engineering.frontend\` selects that subtree
alone: it does **not** reach back up to \`function.engineering\`.

Nothing is implicit. ambit reserves no scope names and adds none on its own, so a project gets
exactly the scopes it lists. \`${CATALOG_INIT_SCOPE}\` is registered as this catalog's universal floor by
convention, and a project that wants it has to say so.

### Nest, or make siblings?

The rule above makes the shape of \`${REGISTRY_PATH}\` load-bearing, and it is the one decision here
that gets expensive to change — every project's \`${CONFIG_FILENAMES[0]}\` names these scopes by hand.

- **Nest** only when holding the parent genuinely implies wanting every child.
  \`function.engineering.frontend\` belongs under \`function.engineering\` because everyone doing
  engineering wants the frontend material too.
- **Make siblings** of anything people pick independently. Two engagements are
  \`project.apollo\` and \`project.borealis\`, never one beneath the other, because nobody working on
  the first wants the second's brief.

Getting this wrong is only fixable by restructuring the tree, so decide it before the catalog has
users.

## Maintaining the catalog

    ambit catalog scope add <name> --description <text>   register a scope
    ambit catalog skill new <name> --scope <scope>        create a skill
    ambit catalog mcp new <name> --stdio <command>        define an MCP server
    ambit catalog hook new <name> --event <event>         define a hook
    ambit catalog tree                                    see what each scope selects
    ambit catalog audit                                   find dead scopes and unreachable items
    ambit catalog validate                                check the whole catalog

Every command up there that changes a file takes \`--dry-run\`, which prints the diff it would write
and touches nothing. Each acts on the current directory unless given \`--catalog <dir>\`.

\`ambit catalog validate\` is what \`${CATALOG_WORKFLOW_FILENAME}\` runs in CI.
`;

/**
 * The config a fresh catalog is scaffolded with, as bytes.
 *
 * Exported so a test can strip the comments and compare what remains against what `emitYaml` produces
 * from the same values, which is the property {@link renderScaffold} exists to hold.
 */
export function scaffoldCatalogConfig(): string {
  return renderScaffold(CONFIG_BLOCKS);
}

/**
 * The scaffold's other files: every one it writes whole, with its bytes, in path order.
 *
 * Pure and byte-stable — nothing about the target directory reaches the contents, so two runs into two
 * differently named directories produce identical trees. The config is not here because it is the one
 * file the command may have to *add to* rather than write; see {@link initCatalog}.
 */
export function scaffoldCatalog(): readonly CatalogFileChange[] {
  const files: Readonly<Record<string, string>> = {
    [CATALOG_WORKFLOW_FILENAME]: renderScaffold(WORKFLOW_BLOCKS),
    [CATALOG_README_FILENAME]: README,
    [`${HOOKS_DIRNAME}/${CATALOG_KEEP_FILENAME}`]: "",
    [`${MCPS_DIRNAME}/${CATALOG_KEEP_FILENAME}`]: "",
    [`${SKILLS_DIRNAME}/${CATALOG_KEEP_FILENAME}`]: "",
  };

  return Object.keys(files)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => ({ file, text: files[file] ?? "" }));
}

export type CatalogInitOptions = EditOptions;

/** What a catalog init produced. */
export interface CatalogInitResult {
  /**
   * The files written, or under `--dry-run` the ones that would be, in path order. Each carries its
   * bytes and, when it already existed, the bytes it held — so a diff and a consuming tool both have
   * what they need, and a config that was added to is distinguishable from one that was created.
   */
  readonly changes: readonly EditedFile[];
  /** Scaffold files that were already there, left byte-identical, in path order. */
  readonly kept: readonly string[];
  /** False under `--dry-run`. */
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

/**
 * The error for a directory whose config already publishes a catalog.
 *
 * The `catalog:` block, and not the file: this command owns that block and nothing else in the
 * document, so a config `ambit init` wrote is something to add to rather than a reason to stop.
 */
function alreadyACatalog(root: string, file: string): AmbitError {
  return configError(`refusing to overwrite the \`${CATALOG_KEY}:\` block in ${file}`, [
    `${root} already publishes a catalog`,
    `edit it, or point \`--catalog\` at a directory whose ${file} has no \`${CATALOG_KEY}:\` block`,
  ]);
}

/** The error for a directory still keeping its registry in `scopes.yml` — see {@link movedRegistry}. */
function legacyRegistry(root: string): AmbitError {
  return configError(`${root} still holds ${LEGACY_REGISTRY_FILENAME}`, [
    `a catalog's scopes are registered under \`${REGISTRY_PATH}\` in ${CONFIG_FILENAMES[0]}, and ${LEGACY_REGISTRY_FILENAME} is no longer read`,
    `move its \`scopes:\` mapping there and delete it — scaffolding a second registry beside it would leave two, one of them ignored`,
  ]);
}

/**
 * The config the scaffold would write, and the bytes it is replacing.
 *
 * Three cases, and the third is why this is not a plain file write: no config at all, a config that
 * already publishes a catalog, and a config written for the other role. The last gets the `catalog:`
 * block appended to it — comments, key order and every consumer key kept byte-for-byte — because both
 * halves live in one document now and each command owns one of them.
 *
 * @throws {AmbitError} exit 2 if the root holds both accepted config names, if its config already has a
 *   `catalog:` block, if it still holds a `scopes.yml`, or if the existing config cannot be parsed.
 */
async function configChange(root: string): Promise<CatalogFileChange> {
  if (await exists(catalogFilePath(root, LEGACY_REGISTRY_FILENAME))) throw legacyRegistry(root);

  const present = await existingConfigFiles(root);
  if (present.length > 1) {
    throw configError(`${present.join(" and ")} both exist in ${root}`, [
      "ambit cannot tell which one the catalog would be published from",
      `delete one, keeping ${CONFIG_FILENAMES[0]}`,
    ]);
  }

  const file = present[0];
  if (file === undefined) return { file: CONFIG_FILENAMES[0], text: scaffoldCatalogConfig() };

  const existing = await readFile(catalogFilePath(root, file), "utf8");
  // Parsed for one question — which keys are already answered — so a document ambit cannot read is
  // refused here rather than silently appended to.
  const document = parseYamlMapping(existing, file);
  if (document.has(REGISTRY_KEY_PATH[0]!)) throw alreadyACatalog(root, file);

  return { file, text: appendScaffold(existing, CONFIG_BLOCKS, (key) => document.has(key)) };
}

/**
 * Scaffolds a catalog in `root`.
 *
 * @param root the catalog root, absolute. Created if it is not there yet.
 * @param options `--dry-run`, which validates the scaffold and writes none of it.
 * @throws {AmbitError} exit 2 if the directory's config already publishes a catalog — under
 *   `--dry-run` too, since a preview of a refusal is a refusal — or if a write fails; exit 3 in the
 *   case the editor guards against, a result that would not validate.
 */
export async function initCatalog(
  root: string,
  options: CatalogInitOptions = {},
): Promise<CatalogInitResult> {
  const changes: CatalogFileChange[] = [await configChange(root)];

  const kept: string[] = [];
  for (const change of scaffoldCatalog()) {
    if (await exists(catalogFilePath(root, change.file))) kept.push(change.file);
    else changes.push(change);
  }

  const result = await applyCatalogEdit(root, changes, options);
  return { changes: result.changes, kept, written: result.written };
}

/**
 * `ambit catalog init` — scaffold a catalog (spec §6, "Catalog authoring"), the mirror of what
 * `ambit init` does for a project.
 *
 * A catalog's shape is not the interesting part; the selection rule is. Nesting `scopes.yml` wrongly is
 * the one mistake here that cannot be fixed without editing every project that holds the scope, so the
 * scaffolded `README.md` carries spec §2's descendants-only rule and its nest-versus-sibling guidance
 * in full. That is why the README is part of the scaffold at all rather than a nicety: a catalog whose
 * author never met the rule is a catalog whose tree has to be restructured later.
 *
 * Three decisions a reader would otherwise have to reverse-engineer:
 *
 * - **Every write goes through the editor** ({@link applyCatalogEdit}), like every other authoring
 *   mutation, so the scaffold gets atomic writes, the root check, `--dry-run`, and — the one that
 *   matters — validation of the *result*: a scaffold that would not pass `ambit validate` is not
 *   written. The directories are therefore created by writing the `.gitkeep` files inside them, which
 *   is also what makes them survive the first commit; git tracks no empty directory, and a catalog that
 *   loses two of its three directories on the way into a repo is not a scaffolded repo.
 * - **An existing `scopes.yml` is refused; any other occupant is left alone.** The registry is what
 *   makes a directory a catalog, so its presence means the command was pointed at one that already
 *   exists (exit 2, nothing written). A catalog is normally initialized *inside* a repo that already
 *   has a README and a workflows directory, though, so a scaffold file that is already there is kept as
 *   it is and reported — overwriting someone's README would be exactly the reformatting authoring rule
 *   2 exists to forbid, one file up.
 * - **A missing root is created**, unlike `ambit init`, which refuses one. The scaffold necessarily
 *   creates directories (`skills/`, `mcps/`, `.github/workflows/`), so "this command does not create
 *   directories" is not a stance it could hold, and starting a new catalog with
 *   `ambit catalog init --catalog acme-skills` is the ordinary first use.
 */
import { stat } from "node:fs/promises";

import { MCPS_DIRNAME, SCOPES_FILENAME, SKILLS_DIRNAME, SKILL_FILENAME } from "./catalog.js";
import type { CatalogFileChange, EditOptions, EditedFile } from "./editor.js";
import { applyCatalogEdit, catalogFilePath } from "./editor.js";
import { configError } from "./errors.js";
import type { ScaffoldBlock } from "./scaffold.js";
import { renderScaffold } from "./scaffold.js";

/**
 * The scope the scaffolded registry holds.
 *
 * A convention, not a rule ambit knows (spec §2), and the same one `ambit init` scaffolds into a
 * project — so a freshly initialized project and a freshly initialized catalog agree out of the box,
 * which is the pair someone tries first.
 */
export const CATALOG_INIT_SCOPE = "core";

/** The scaffolded README, where the selection rule is documented (spec §2). */
export const CATALOG_README_FILENAME = "README.md";

/** The scaffolded CI workflow, which runs `ambit validate --catalog .`. */
export const CATALOG_WORKFLOW_FILENAME = ".github/workflows/validate.yml";

/**
 * What is written inside `skills/` and `mcps/` so the directories exist and survive a commit. Invisible
 * to catalog parsing, which reads only `scopes.yml`, `skills/**`, and `mcps/*.yml`.
 */
export const CATALOG_KEEP_FILENAME = ".gitkeep";

/** The command the scaffolded workflow runs, and the one the README tells a maintainer to run. */
const VALIDATE_COMMAND = "npx --yes @nebulab/ambit validate --catalog .";

const REGISTRY_BLOCKS: readonly ScaffoldBlock[] = [
  {
    comment: [
      "The scope registry: every scope any skill or MCP server in this catalog declares must be",
      "listed here, with a description. A scope that is not registered selects nothing and warns",
      "nobody, so registering them is what turns a typo into an error — and the descriptions are",
      "what a tool asking someone which scopes they hold renders as its list.",
      "",
      "A held scope selects itself and every scope beneath it — descendants only. Nest a scope",
      "only when holding the parent genuinely implies wanting every child; make siblings of",
      "anything people pick independently. README.md explains the choice; it is much cheaper to",
      "make now than to change once projects name these scopes.",
    ],
    values: {
      scopes: {
        [CATALOG_INIT_SCOPE]: { description: "The universal floor — what everyone here needs" },
      },
    },
  },
];

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
 * the one scaffolded file nothing reads back. Its middle two sections are spec §2's selection rule and
 * the nest-versus-sibling guidance the spec asks a catalog's README to carry prominently.
 */
const README = `# An ambit catalog

This directory is a catalog: the skills and MCP server definitions \`ambit\` installs into projects,
each labelled with the *scopes* that should get it.

## Layout

    ${SCOPES_FILENAME}                            every scope, with a description
    ${SKILLS_DIRNAME}/<namespace>/<name>/${SKILL_FILENAME}    one directory per skill
    ${MCPS_DIRNAME}/<name>.yml                       one file per MCP server

A skill's name is its path under \`${SKILLS_DIRNAME}/\` with \`/\` replaced by \`.\`, so
\`${SKILLS_DIRNAME}/acme/sales/use-close/\` holds the skill \`acme.sales.use-close\`. Nothing else names
it — which is what keeps this directory a plain skills repo that other tools can read.

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

The rule above makes the shape of \`scopes.yml\` load-bearing, and it is the one decision here that
gets expensive to change — every project's \`ambit.yml\` names these scopes by hand.

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
    ambit catalog tree                                    see what each scope selects
    ambit catalog audit                                   find dead scopes and unreachable items
    ambit validate --catalog .                            check the whole catalog

Every command up there that changes a file takes \`--dry-run\`, which prints the diff it would write
and touches nothing.

\`ambit validate --catalog .\` is what \`${CATALOG_WORKFLOW_FILENAME}\` runs in CI.
`;

/**
 * The scaffold: every file it writes, with its bytes, in path order.
 *
 * Pure and byte-stable — nothing about the target directory reaches the contents, so two runs into two
 * differently named directories produce identical trees.
 */
export function scaffoldCatalog(): readonly CatalogFileChange[] {
  const files: Readonly<Record<string, string>> = {
    [CATALOG_WORKFLOW_FILENAME]: renderScaffold(WORKFLOW_BLOCKS),
    [CATALOG_README_FILENAME]: README,
    [`${MCPS_DIRNAME}/${CATALOG_KEEP_FILENAME}`]: "",
    [SCOPES_FILENAME]: renderScaffold(REGISTRY_BLOCKS),
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
   * bytes, so a diff and a consuming tool both have what they need.
   */
  readonly created: readonly EditedFile[];
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
 * Scaffolds a catalog in `root`.
 *
 * @param root the catalog root, absolute. Created if it is not there yet.
 * @param options `--dry-run`, which validates the scaffold and writes none of it.
 * @throws {AmbitError} exit 2 if the directory already holds a `scopes.yml` — under `--dry-run` too,
 *   since a preview of a refusal is a refusal — or if a write fails; exit 3 in the case the editor
 *   guards against, a result that would not validate.
 */
export async function initCatalog(
  root: string,
  options: CatalogInitOptions = {},
): Promise<CatalogInitResult> {
  if (await exists(catalogFilePath(root, SCOPES_FILENAME))) {
    throw configError(`refusing to overwrite ${SCOPES_FILENAME}`, [
      `${root} already holds a catalog`,
      `edit it, or point \`--catalog\` at a directory that has no ${SCOPES_FILENAME}`,
    ]);
  }

  const kept: string[] = [];
  const changes: CatalogFileChange[] = [];
  for (const change of scaffoldCatalog()) {
    if (await exists(catalogFilePath(root, change.file))) kept.push(change.file);
    else changes.push(change);
  }

  const result = await applyCatalogEdit(root, changes, options);
  return { created: result.changes, kept, written: result.written };
}

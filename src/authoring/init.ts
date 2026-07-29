/**
 * `ambit catalog init` — scaffold a catalog, the mirror of what
 * `ambit init` does for a project.
 *
 * What the scaffold amounts to is three empty directories, a README and a CI workflow. It used to
 * write a fourth thing — the scope registry — and most of the prose here and in the README existed to
 * teach the one rule that made the registry's shape expensive to get wrong. There is no registry and
 * no shape: a tag is a free-form label on an item, so nothing has to be decided before the catalog
 * has users, and the README is left saying where each kind of thing goes.
 *
 * Three decisions a reader would otherwise have to reverse-engineer:
 *
 * - **Every write goes through the editor** ({@link applyCatalogEdit}), which is what gives the
 *   scaffold atomic writes, the root check, `--dry-run`, and — the one that
 *   matters — validation of the *result*: a scaffold that would not pass `ambit catalog validate` is
 *   not written. The directories are therefore created by writing the `.gitkeep` files inside them,
 *   which is also what makes them survive the first commit; git tracks no empty directory, and a
 *   catalog that loses three of its four directories on the way into a repo is not a scaffolded repo.
 * - **Nothing is refused, and every occupant is left alone.** No file makes a directory a catalog any
 *   more — the three item directories do, and a catalog is normally initialized *inside* a repo that
 *   already has a README and a workflows directory. So a scaffold file that is already there is kept
 *   as it is and reported, which also makes a second run a no-op: overwriting someone's README would
 *   be exactly the reformatting authoring rule 2 exists to forbid, one file up. A directory still
 *   holding a `scopes.yml` fails anyway, through the validation the editor runs on the result.
 * - **A missing root is created**, unlike `ambit init`, which refuses one. The scaffold necessarily
 *   creates directories (`skills/`, `mcps/`, `hooks/`, `.github/workflows/`), so "this command does not create
 *   directories" is not a stance it could hold, and starting a new catalog with
 *   `ambit catalog init --catalog acme-skills` is the ordinary first use.
 */
import { stat } from "node:fs/promises";

import {
  HOOKS_DIRNAME,
  HOOK_FILENAME,
  MCPS_DIRNAME,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
} from "../model/catalog.js";
import type { CatalogFileChange, EditOptions, EditedFile } from "./editor.js";
import { applyCatalogEdit, catalogFilePath } from "./editor.js";
import type { ScaffoldBlock } from "../model/scaffold.js";
import { renderScaffold } from "../model/scaffold.js";

/** The scaffolded README, which says what goes where. */
export const CATALOG_README_FILENAME = "README.md";

/** The scaffolded CI workflow, which runs `ambit catalog validate`. */
export const CATALOG_WORKFLOW_FILENAME = ".github/workflows/validate.yml";

/**
 * What is written inside `skills/`, `mcps/` and `hooks/` so the directories exist and survive a commit.
 * Invisible to catalog parsing, which reads only `skills/**`, `mcps/*.yml`, and `hooks/**`.
 */
export const CATALOG_KEEP_FILENAME = ".gitkeep";

/**
 * The command the scaffolded workflow runs, and the one the README tells a maintainer to run.
 *
 * `ambit catalog validate` rather than `ambit validate`: the subject is this catalog on its own terms,
 * and a catalog repo has no `ambit.yml` for the project-wide check to read. It needs no `--catalog`
 * either — the flag defaults to the cwd, which in CI is the checkout root.
 */
const VALIDATE_COMMAND = "npx --yes @nebulab/ambit catalog validate";

const WORKFLOW_BLOCKS: readonly ScaffoldBlock[] = [
  {
    comment: [
      "Validates this catalog on every push and pull request: that every `requires` resolves to",
      "something this catalog provides, that no `requires` edge forms a cycle, and that every",
      "skill's name matches its path.",
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
 * the one scaffolded file nothing reads back. It is orientation and nothing more: where each kind of
 * thing goes, what a tag is, and the one command that checks the result.
 */
const README = `# An ambit catalog

This directory is a catalog: the skills, MCP server definitions and hooks \`ambit\` installs into
projects, each tagged with whatever labels say *who needs it*.

## Layout

    ${SKILLS_DIRNAME}/<name>/${SKILL_FILENAME}    one directory per skill
    ${MCPS_DIRNAME}/<name>.yml           one file per MCP server
    ${HOOKS_DIRNAME}/<name>/${HOOK_FILENAME}     one directory per hook

That is the whole of it. A catalog is a directory holding some of those three, with no config file of
its own — nothing here has to be declared before it can be written.

A skill's name is its path under \`${SKILLS_DIRNAME}/\`, so \`${SKILLS_DIRNAME}/close-crm/\` holds the skill \`close-crm\`.
Nothing else names it — which is what keeps this directory a plain skills repo that other tools
can read. Nesting a skill is allowed and joins the segments with \`.\`, so
\`${SKILLS_DIRNAME}/sales/close-crm/\` is \`sales.close-crm\`.

## Tags

An item carries a list of tags: dotted labels a consuming project selects on.

    ambit:
      tags: [function.engineering]

They are free-form. Nothing registers a tag, nothing describes one, and no file in this catalog has
to agree about which tags exist — tag an item and every project selecting that label reaches it,
with no edit on their side. Dots nest: a project selecting \`function.engineering\` also reaches
something tagged \`function.engineering.frontend\`, never the reverse.

The cost of that freedom is that a misspelled tag is silently a new tag, reaching nobody. Nothing
here can catch it, so keep the list of labels this catalog uses somewhere a person will look.

## Maintaining the catalog

A catalog is Markdown and YAML, so it is maintained with an editor. Add a skill by writing
\`${SKILLS_DIRNAME}/<name>/${SKILL_FILENAME}\`, a server by writing \`${MCPS_DIRNAME}/<name>.yml\`, a hook by writing
\`${HOOKS_DIRNAME}/<name>/${HOOK_FILENAME}\`.

    ambit catalog validate                                check the whole catalog

That is what catches the mistakes hand-editing makes: a \`requires\` that resolves to nothing, a
cycle, a skill whose name disagrees with its path. It acts on the current directory unless given
\`--catalog <dir>\`, and it is what \`${CATALOG_WORKFLOW_FILENAME}\` runs in CI.
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
   * bytes, so a diff and a consuming tool both have what they need.
   */
  readonly created: readonly EditedFile[];
  /** Scaffold files that were already there, left byte-identical, in path order. */
  readonly kept: readonly string[];
  /** False under `--dry-run`, and false when every scaffold file was already there. */
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
 * @throws {AmbitError} exit 2 if a write fails, or if the directory does not parse as a catalog —
 *   which is what refuses one still holding a `scopes.yml`; exit 3 in the case the editor guards
 *   against, a result that would not validate.
 */
export async function initCatalog(
  root: string,
  options: CatalogInitOptions = {},
): Promise<CatalogInitResult> {
  const kept: string[] = [];
  const changes: CatalogFileChange[] = [];
  for (const change of scaffoldCatalog()) {
    if (await exists(catalogFilePath(root, change.file))) kept.push(change.file);
    else changes.push(change);
  }

  const result = await applyCatalogEdit(root, changes, options);
  return { created: result.changes, kept, written: result.written };
}

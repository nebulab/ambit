/**
 * `ambit catalog tree` (spec §6, "Catalog authoring") — the registry drawn as the tree it is.
 *
 * The text form is one row per registered scope, indented under its parent, carrying two counts and the
 * description. Counts rather than item lists on purpose: this report is read to answer "is this nesting
 * right?" (spec §2), and a scope whose subtree holds forty skills would bury the shape it exists to show.
 * `--json` carries the names, so anything that wants the itemization has it without the text form
 * becoming unscannable.
 *
 * `--json` nests, where every other command's JSON is flat: the nesting *is* the answer here, and a
 * consumer that had to rebuild it from dotted names would have to re-derive the longest-registered-ancestor
 * rule to get the same tree. Keys are full dotted names at every depth even though the nesting makes the
 * last segment sufficient, so a key can be pasted straight into an `ambit.yml` `scopes` list.
 *
 * Read-only, so there is no `--dry-run` and no diff — but the determinism rules apply unchanged (spec §4):
 * every list is sorted, and no absolute path reaches either output form, which is what lets the JSON be a
 * golden file.
 */
import type { ScopeNode, ScopeSelection } from "../catalog-tree.js";
import { flattenScopeTree, scopeTree, selectionSize } from "../catalog-tree.js";
import type { CommandHandler } from "../commands.js";
import { catalogDirOf, jsonRequested } from "../commands.js";
import { ExitCode } from "../errors.js";
import { keyed, printSections, section } from "../output.js";

/** The section title: the registry is what is being drawn, as `ambit scopes` and `catalog dump` name it. */
const TITLE = "scopes";

/** How far one level of nesting shifts a row. */
const INDENT = "  ";

/** How each count reads, so neither column can be mistaken for the other at a glance. */
function counted(selection: ScopeSelection, word: string): string {
  return `${selectionSize(selection)} ${word}`;
}

function selectionJson(selection: ScopeSelection): Readonly<Record<string, unknown>> {
  return { mcps: selection.mcps, skills: selection.skills };
}

/** Keys in one order, sorted, so the emitted JSON is byte-stable (`keyed` in `src/output.ts`). */
function scopesJson(nodes: readonly ScopeNode[]): Readonly<Record<string, unknown>> {
  return keyed(
    nodes,
    (node) => node.name,
    (node) => ({
      children: scopesJson(node.children),
      description: node.description,
      direct: selectionJson(node.direct),
      inherited: selectionJson(node.inherited),
    }),
  );
}

/** One row per scope, parents before children, the name cell indented by depth. */
function rows(nodes: readonly ScopeNode[]): readonly (readonly string[])[] {
  return flattenScopeTree(nodes).map(({ node, depth }) => [
    `${INDENT.repeat(depth)}${node.name}`,
    counted(node.direct, "direct"),
    counted(node.inherited, "inherited"),
    node.description,
  ]);
}

export const catalogTreeHandler: CommandHandler = async (ctx) => {
  const tree = await scopeTree(catalogDirOf(ctx));

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify({ scopes: scopesJson(tree) }, null, 2));
    return ExitCode.Success;
  }

  printSections(section(TITLE, rows(tree)), ctx.stdout);
  return ExitCode.Success;
};

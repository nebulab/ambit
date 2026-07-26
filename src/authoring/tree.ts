/**
 * The scope tree: `ambit catalog tree`.
 *
 * Spec §2 makes tree shape load-bearing — a held scope selects itself and every scope beneath it,
 * descendants only — and says that getting it wrong is "only fixable by restructuring the tree". This is
 * the view that makes the decision visible while it is still cheap: nest only when selecting the parent
 * genuinely implies wanting every child, and make things people pick independently siblings.
 *
 * Three decisions shape what it shows.
 *
 * - **The registry is the tree.** A scope's parent here is its longest *registered* ancestor, not its
 *   dotted prefix, because that is exactly what {@link expandHeldScopes} walks: a registry holding
 *   `function.engineering` without `function` has two roots, since a parent nobody registered is not a
 *   scope (see `assertScopesRegistered`). So the drawn nesting and the selection it predicts cannot
 *   disagree, which is the only reason this view is worth reading.
 * - **`direct` and `inherited` partition what a scope selects.** `direct` is what declares the scope
 *   itself; `inherited` is what a registered descendant declares and this scope therefore also selects.
 *   An item declaring both a scope and one of its children counts as `direct` and is left out of
 *   `inherited`, so the two counts sum to what holding the scope actually brings in — a number that did
 *   not add up would be worse than no number.
 * - **Nothing here follows `requires`.** The closure is orthogonal to nesting, and folding it in would
 *   attribute a skill's dependencies to a scope that never mentioned them. So an item no scope declares
 *   appears nowhere in this report even when a selected skill pulls it in — reporting *that* is
 *   `catalog audit`'s job.
 *
 * Like `ambit scopes`, this reads and validates nothing beyond parsing: a skill declaring an unregistered
 * scope simply appears in no row, because the registry is the subject. Someone whose catalog has that
 * problem needs a view of it, not a refusal.
 */
import path from "node:path";

import type { Catalog, ScopeDefinition } from "../model/catalog.js";
import { parseCatalogDirectory } from "../model/catalog.js";
import { SCOPE_SEPARATOR } from "../resolution/resolve.js";

/**
 * What a scope selects, by name and by kind — the two namespaces `catalog dump` keys separately, in the
 * same order, since a report about one scope reads like a slice of that one.
 */
export interface ScopeSelection {
  readonly mcps: readonly string[];
  readonly skills: readonly string[];
}

/** One registered scope, what it selects, and the scopes registered beneath it. */
export interface ScopeNode {
  readonly name: string;
  readonly description: string;
  /** What declares this scope itself. */
  readonly direct: ScopeSelection;
  /** What a registered descendant declares and this scope therefore also selects, `direct` excluded. */
  readonly inherited: ScopeSelection;
  /** Children in name order, each nested under its longest registered ancestor. */
  readonly children: readonly ScopeNode[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

/** How many items a selection holds, which is what the report counts. */
export function selectionSize(selection: ScopeSelection): number {
  return selection.mcps.length + selection.skills.length;
}

function selectionOf(mcps: readonly string[], skills: readonly string[]): ScopeSelection {
  return { mcps: sortedUnique(mcps), skills: sortedUnique(skills) };
}

/** Everything in `selections`, merged. */
function union(selections: readonly ScopeSelection[]): ScopeSelection {
  return selectionOf(
    selections.flatMap((selection) => [...selection.mcps]),
    selections.flatMap((selection) => [...selection.skills]),
  );
}

/** `selection` without anything `taken` already holds, so the two never count one item twice. */
function without(selection: ScopeSelection, taken: ScopeSelection): ScopeSelection {
  const mcps = new Set(taken.mcps);
  const skills = new Set(taken.skills);
  return {
    mcps: selection.mcps.filter((name) => !mcps.has(name)),
    skills: selection.skills.filter((name) => !skills.has(name)),
  };
}

/** What declares `scope` by name, as the catalog parsed it. */
function declaredBy(catalog: Catalog, scope: string): ScopeSelection {
  const declaring = <T extends { readonly name: string; readonly scopes: readonly string[] }>(
    items: readonly T[],
  ): readonly string[] =>
    items.filter((item) => item.scopes.includes(scope)).map((item) => item.name);

  return selectionOf(declaring(catalog.mcps), declaring(catalog.skills));
}

/**
 * The scope a node hangs off: the longest registered proper ancestor of `name`, or none when the
 * registry holds no ancestor at all and the scope is a root of the tree.
 *
 * Longest rather than the dotted prefix, because the registry decides what is a scope: with
 * `function.engineering` registered and `function` not, `function.engineering.frontend` is the child of
 * the former and the latter is not a node anybody may hold.
 */
function parentOf(name: string, registered: ReadonlySet<string>): string | undefined {
  const segments = name.split(SCOPE_SEPARATOR);
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const candidate = segments.slice(0, depth).join(SCOPE_SEPARATOR);
    if (registered.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The registry as a tree, with what each scope selects.
 *
 * Pure, and a function of the catalog's contents alone: `parseCatalogDirectory` hands back scopes,
 * skills, and entities already in name order, and every list built here is sorted, so two runs against
 * one catalog produce identical trees whatever the filesystem said.
 *
 * @returns the roots, in name order.
 */
export function buildScopeTree(catalog: Catalog): readonly ScopeNode[] {
  const registered = new Set(catalog.scopes.map((definition) => definition.name));
  const children = new Map<string | undefined, ScopeDefinition[]>();

  // `catalog.scopes` arrives sorted, so each bucket is too, and so is the tree at every depth.
  for (const definition of catalog.scopes) {
    const parent = parentOf(definition.name, registered);
    children.set(parent, [...(children.get(parent) ?? []), definition]);
  }

  const nodeOf = (definition: ScopeDefinition): ScopeNode => {
    const below = (children.get(definition.name) ?? []).map(nodeOf);
    const direct = declaredBy(catalog, definition.name);
    const beneath = union(below.map((child) => union([child.direct, child.inherited])));

    return {
      name: definition.name,
      description: definition.description,
      direct,
      inherited: without(beneath, direct),
      children: below,
    };
  };

  return (children.get(undefined) ?? []).map(nodeOf);
}

/** Every node of `nodes`, parents before children, each with how deep it sits. */
export function flattenScopeTree(
  nodes: readonly ScopeNode[],
): readonly { readonly node: ScopeNode; readonly depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth: 0 },
    ...flattenScopeTree(node.children).map((entry) => ({ ...entry, depth: entry.depth + 1 })),
  ]);
}

/**
 * Reads the catalog in `root` and builds its scope tree.
 *
 * @param root the catalog root, absolute.
 * @throws {AmbitError} exit 2 when the directory is not a catalog, or does not parse.
 */
export async function scopeTree(root: string): Promise<readonly ScopeNode[]> {
  const catalog = await parseCatalogDirectory(path.basename(root), `path:${root}`, root);
  return buildScopeTree(catalog);
}

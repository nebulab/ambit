/**
 * Resolution (spec §4) — the held scopes and the merged catalog in, the bundle out.
 *
 * Pure and synchronous: everything that touches disk or the network has already happened by the
 * time this runs. That is what makes determinism testable — the same inputs produce a
 * byte-identical bundle, so `resolve --json` can be committed as a golden file.
 *
 * A held scope selects itself and every scope beneath it — **descendants only** (spec §2).
 * Holding `function.engineering` reaches `function.engineering.frontend`; holding the child never
 * reaches back up to the parent. That asymmetry is what makes the catalog's tree shape
 * load-bearing, so it lives here rather than in any adapter.
 *
 * Nothing else is implicit: no scope is reserved, and a project selects exactly the scopes it
 * lists, expanded downward. Rejecting a held scope the registry does not know, the `requires`
 * closure, and explicit `skills`/`mcps` entries are later slices.
 */
import type { MergedCatalog, MergedMcp, MergedSkill, ScopeDefinition } from "./catalog.js";
import type { ProjectConfig } from "./config.js";

/** What separates a scope from its children (spec §2). */
const SCOPE_SEPARATOR = ".";

/** The resolved set of skills and MCP servers for a project. */
export interface Bundle {
  /**
   * The held scopes exactly as the project declared them, deduplicated and sorted. The subtree
   * they expand to is derived from these and the registry, and is deliberately not reported: a
   * reader wants their own list back, not the registry restated.
   */
  readonly scopes: readonly string[];
  /** Selected skills, sorted by name. */
  readonly skills: readonly MergedSkill[];
  /** Selected MCP servers, sorted by name. */
  readonly mcps: readonly MergedMcp[];
  /** Every env var the selection declares, unioned and sorted (spec §4.10). */
  readonly env: readonly string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

/**
 * Whether `candidate` lies in `held`'s subtree: equal to it, or beneath it.
 *
 * The separator is part of the test on purpose. A bare prefix check would let
 * `function.engineering` swallow the unrelated sibling `function.engineering-legacy`, which reads
 * as a hierarchy to string comparison and to nobody else.
 */
function inSubtree(held: string, candidate: string): boolean {
  return candidate === held || candidate.startsWith(`${held}${SCOPE_SEPARATOR}`);
}

/**
 * Expands held scopes into the set that does the selecting (spec §4.6): every **registered** scope
 * equal to a held scope or beneath it.
 *
 * Expansion runs against the registry rather than over the scopes skills happen to declare, so
 * `scopes.yml` stays the single authority on the tree's shape — an unregistered scope cannot
 * smuggle itself into a subtree by naming itself a child of one. A held scope the registry does
 * not know contributes nothing here; failing loudly on it is the next slice, and until then it
 * simply selects no more than it did before.
 */
export function expandHeldScopes(
  held: readonly string[],
  registered: readonly ScopeDefinition[],
): ReadonlySet<string> {
  const expanded = new Set<string>();
  // Both loops run in sorted order — `registered` arrives sorted by name — so the set's insertion
  // order is a function of the values alone, not of config or filesystem order.
  for (const scope of [...held].sort(compare)) {
    for (const definition of registered) {
      if (inSubtree(scope, definition.name)) expanded.add(definition.name);
    }
  }
  return expanded;
}

/**
 * Whether a declared scope list is selected by the expanded held scopes.
 *
 * An empty list is never selected — such a thing is reachable only through `requires` or an
 * explicit listing (spec §3.2).
 */
function selectedByScope(selecting: ReadonlySet<string>, declared: readonly string[]): boolean {
  return declared.some((scope) => selecting.has(scope));
}

/**
 * Computes the bundle for a project.
 *
 * Selection order comes from the merged catalog, which is already sorted by name, so filtering
 * preserves it and no collection is iterated in filesystem order.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  const selecting = expandHeldScopes(config.scopes, merged.scopes);

  const skills = merged.skills.filter((skill) => selectedByScope(selecting, skill.scopes));
  const mcps = merged.mcps.filter((mcp) => selectedByScope(selecting, mcp.scopes));

  return {
    scopes: sortedUnique(config.scopes),
    skills,
    mcps,
    env: sortedUnique([...skills.flatMap((skill) => skill.env), ...mcps.flatMap((mcp) => mcp.env)]),
  };
}

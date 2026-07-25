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
 * lists, expanded downward. The `requires` closure and explicit `skills`/`mcps` entries are
 * later slices.
 */
import type { MergedCatalog, MergedMcp, MergedSkill, ScopeDefinition } from "./catalog.js";
import { SCOPES_FILENAME } from "./catalog.js";
import type { ProjectConfig } from "./config.js";
import { at, resolutionError } from "./errors.js";

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
 * smuggle itself into a subtree by naming itself a child of one.
 *
 * Deliberately total: a held scope the registry does not know simply contributes nothing here,
 * so the expansion can be reasoned about as a set operation. Rejecting such a scope is
 * {@link assertScopesRegistered}'s job, and {@link resolveBundle} runs it first.
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
 * How far a registered scope may be from a held one and still be worth proposing as the
 * correction.
 *
 * Scaled by length rather than fixed: a typo in a long dotted scope is still one or two edits
 * from its target, while at a threshold generous enough to catch those, a short unrelated word
 * would confidently propose something it has nothing to do with.
 */
function suggestionThreshold(scope: string): number {
  return Math.max(2, Math.floor(scope.length / 3));
}

/** Levenshtein distance. A registry holds tens of scopes, so the exact distance is cheap. */
function editDistance(a: string, b: string): number {
  // One row of the matrix, rewritten per character of `a`: previous[j] is the distance between
  // the prefix of `a` handled so far and the first j characters of `b`.
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }

  return previous[b.length]!;
}

/**
 * The registered scope nearest `scope`, or undefined when nothing is close enough that proposing
 * it would help.
 *
 * Ties go to the first candidate in `registered`, which arrives sorted by name, so the
 * suggestion is a function of the names alone.
 */
function nearestScope(scope: string, registered: readonly ScopeDefinition[]): string | undefined {
  const threshold = suggestionThreshold(scope);
  let best: { readonly name: string; readonly distance: number } | undefined;

  for (const definition of registered) {
    const distance = editDistance(scope, definition.name);
    if (distance > threshold) continue;
    if (best === undefined || distance < best.distance) best = { name: definition.name, distance };
  }

  return best?.name;
}

/**
 * Rejects a held scope the merged registry does not know (spec §4.6).
 *
 * A typo has to fail loudly, because the alternative is worse than an error: expanding to
 * nothing yields a bundle quietly missing everything that scope was meant to bring, and nobody
 * notices until the agent behaves oddly weeks later.
 *
 * The registry decides what may be held, not the shape of the tree — holding `function` when
 * only `function.engineering` is registered is a typo like any other, since a parent nobody
 * declared is not a scope.
 *
 * @throws {AmbitError} exit 3, naming the scope, the config line it was written on, and the
 *   nearest registered scope when one is a plausible correction.
 */
export function assertScopesRegistered(
  config: ProjectConfig,
  registered: readonly ScopeDefinition[],
): void {
  const known = new Set(registered.map((definition) => definition.name));

  // Sorted, so which of several unknown scopes is reported first depends on the names alone
  // rather than on the order the config happens to list them in.
  for (const scope of sortedUnique(config.scopes)) {
    if (known.has(scope)) continue;

    const suggestion = nearestScope(scope, registered);
    throw resolutionError(
      `unknown scope "${scope}" ${at(config.origin.file, config.origin.scopeLines.get(scope))}`,
      [
        "not found in the merged registry",
        suggestion === undefined
          ? `register it in a catalog's ${SCOPES_FILENAME}, or correct the spelling`
          : `did you mean "${suggestion}"?`,
      ],
    );
  }
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
 *
 * @throws {AmbitError} exit 3 for a held scope the merged registry does not know.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  assertScopesRegistered(config, merged.scopes);

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

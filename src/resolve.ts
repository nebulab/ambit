/**
 * Resolution (spec §4) — the held scopes and the merged catalog in, the bundle out.
 *
 * Pure and synchronous: everything that touches disk or the network has already happened by the
 * time this runs. That is what makes determinism testable — the same inputs produce a
 * byte-identical bundle, so `resolve --json` can be committed as a golden file.
 *
 * This build matches scopes **exactly**. Nothing is implicit: holding `core` selects only what
 * declares `core`, and holding `function.engineering` does not yet reach
 * `function.engineering.frontend` — subtree expansion is a later slice, as are the `requires`
 * closure and explicit `skills`/`mcps` entries.
 */
import type { MergedCatalog, MergedMcp, MergedSkill } from "./catalog.js";
import type { ProjectConfig } from "./config.js";

/** The resolved set of skills and MCP servers for a project. */
export interface Bundle {
  /** The scopes that did the selecting, deduplicated and sorted. */
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
 * Whether a declared scope list is selected by the held scopes.
 *
 * An empty list is never selected — such a thing is reachable only through `requires` or an
 * explicit listing (spec §3.2).
 */
function selectedByScope(held: ReadonlySet<string>, declared: readonly string[]): boolean {
  return declared.some((scope) => held.has(scope));
}

/**
 * Computes the bundle for a project.
 *
 * Selection order comes from the merged catalog, which is already sorted by name, so filtering
 * preserves it and no collection is iterated in filesystem order.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  const held = new Set(config.scopes);

  const skills = merged.skills.filter((skill) => selectedByScope(held, skill.scopes));
  const mcps = merged.mcps.filter((mcp) => selectedByScope(held, mcp.scopes));

  return {
    scopes: sortedUnique(config.scopes),
    skills,
    mcps,
    env: sortedUnique([...skills.flatMap((skill) => skill.env), ...mcps.flatMap((mcp) => mcp.env)]),
  };
}

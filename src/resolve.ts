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
 * lists, expanded downward. What scope selection finds is then closed over `requires`, so a
 * skill can carry its dependencies into a bundle that would never have selected them. Explicit
 * `skills`/`mcps` entries from config are a later slice.
 */
import type { MergedCatalog, MergedMcp, MergedSkill, ScopeDefinition } from "./catalog.js";
import { MCPS_DIRNAME, SCOPES_FILENAME, SKILL_FILENAME } from "./catalog.js";
import type { ProjectConfig } from "./config.js";
import type { AmbitError } from "./errors.js";
import { at, resolutionError } from "./errors.js";

/** What separates a scope from its children (spec §2). */
const SCOPE_SEPARATOR = ".";

/** What marks a `requires` entry as naming an MCP entity rather than a skill (spec §3.2). */
const MCP_REQUIREMENT_PREFIX = "mcp.";

/** A set of catalog items under consideration, each list sorted by name. */
export interface Selection {
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
}

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

/** Where a skill's `requires` list is written, so an error about one can name a file (spec §6). */
function skillFile(skill: MergedSkill): string {
  return `${skill.path}/${SKILL_FILENAME}`;
}

/**
 * The error for a `requires` entry no catalog can satisfy (spec §4.9).
 *
 * Both halves of the edge are named — the requirer and the target — because either could be the
 * mistake: a skill may have been renamed, or the requirement misspelled.
 */
function missingRequirement(requirer: MergedSkill, requirement: string): AmbitError {
  const isMcp = requirement.startsWith(MCP_REQUIREMENT_PREFIX);
  const target = isMcp ? requirement.slice(MCP_REQUIREMENT_PREFIX.length) : requirement;

  return resolutionError(`unresolvable requirement "${requirement}" (${skillFile(requirer)})`, [
    isMcp
      ? `${requirer.name} requires an MCP entity named "${target}", which no catalog provides`
      : `${requirer.name} requires a skill named "${target}", which no catalog provides`,
    isMcp
      ? `add it under ${MCPS_DIRNAME}/ in a catalog, or remove the \`requires\` entry`
      : "add it to a catalog, or remove the `requires` entry",
  ]);
}

/**
 * The error for a `requires` cycle (spec §4.9), printing the whole path rather than the mere fact
 * of one — the offending edge is only obvious once a reader can see the loop closing.
 *
 * @param cycle the skill names around the loop, opening and closing on the same name.
 */
function cycleError(cycle: readonly string[], head: MergedSkill): AmbitError {
  return resolutionError("requirement cycle", [
    cycle.join(" → "),
    `each step is a \`requires\` entry, the first in ${skillFile(head)}`,
    "break the cycle by removing one `requires` edge",
  ]);
}

/**
 * Closes a selection over `requires` until fixpoint (spec §4.9): every skill a selected skill
 * requires, and every MCP entity one names with an `mcp.` prefix, joins the selection — whether or
 * not its own scopes would ever have selected it.
 *
 * That is the point of the mechanism. A skill that is useless without a company-context skill and
 * a server declares so once, and every profile that reaches it gets a working bundle instead of a
 * plausible-looking broken one.
 *
 * Only skills carry `requires` (spec §3.3 gives MCP entities no such key), so the graph walked
 * here is skill → skill, with MCP entities as leaves.
 *
 * @param skills the roots — what scope selection found, sorted by name.
 * @param mcps MCP entities already selected by their own scopes.
 * @param merged what requirements resolve against.
 * @throws {AmbitError} exit 3 for a requirement no catalog provides, or a cycle.
 */
export function closeOverRequires(
  skills: readonly MergedSkill[],
  mcps: readonly MergedMcp[],
  merged: MergedCatalog,
): Selection {
  const skillsByName = new Map(merged.skills.map((skill) => [skill.name, skill]));
  const mcpsByName = new Map(merged.mcps.map((mcp) => [mcp.name, mcp]));

  const chosenSkills = new Set<string>();
  const chosenMcps = new Set(mcps.map((mcp) => mcp.name));

  // The two colours a depth-first walk needs to tell a cycle from a diamond: `path` is the chain
  // currently being followed, in order, so meeting something already on it yields the cycle
  // itself; `closed` is what has been followed to completion, and revisiting that is just a
  // requirement two skills share.
  const path: string[] = [];
  const closed = new Set<string>();

  const follow = (skill: MergedSkill): void => {
    if (closed.has(skill.name)) return;

    const opened = path.indexOf(skill.name);
    if (opened !== -1) throw cycleError([...path.slice(opened), skill.name], skill);

    path.push(skill.name);
    chosenSkills.add(skill.name);

    // Sorted and deduplicated, so which of several problems in one `requires` list is reported
    // does not depend on the order its author happened to write them in.
    for (const requirement of sortedUnique(skill.requires)) {
      if (requirement.startsWith(MCP_REQUIREMENT_PREFIX)) {
        const required = mcpsByName.get(requirement.slice(MCP_REQUIREMENT_PREFIX.length));
        if (required === undefined) throw missingRequirement(skill, requirement);
        chosenMcps.add(required.name);
        continue;
      }

      const required = skillsByName.get(requirement);
      if (required === undefined) throw missingRequirement(skill, requirement);
      follow(required);
    }

    path.pop();
    closed.add(skill.name);
  };

  for (const skill of skills) follow(skill);

  // Filtering the merged lists rather than collecting during the walk keeps the result in name
  // order, whatever order the closure happened to discover things in.
  return {
    skills: merged.skills.filter((skill) => chosenSkills.has(skill.name)),
    mcps: merged.mcps.filter((mcp) => chosenMcps.has(mcp.name)),
  };
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
 * `env` is unioned over the closed selection, not the scope-selected one (spec §4.10): a server
 * pulled in by `requires` needs its credentials as much as one selected by scope.
 *
 * @throws {AmbitError} exit 3 for a held scope the merged registry does not know, a requirement no
 *   catalog provides, or a `requires` cycle.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  assertScopesRegistered(config, merged.scopes);

  const selecting = expandHeldScopes(config.scopes, merged.scopes);

  const { skills, mcps } = closeOverRequires(
    merged.skills.filter((skill) => selectedByScope(selecting, skill.scopes)),
    merged.mcps.filter((mcp) => selectedByScope(selecting, mcp.scopes)),
    merged,
  );

  return {
    scopes: sortedUnique(config.scopes),
    skills,
    mcps,
    env: sortedUnique([...skills.flatMap((skill) => skill.env), ...mcps.flatMap((mcp) => mcp.env)]),
  };
}

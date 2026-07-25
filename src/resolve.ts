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
 * lists, expanded downward. Alongside that, a project may name skills and servers outright
 * (spec §4.8) — those are selected whatever their scopes, since asking for something by name is
 * already the decision that scopes exist to make. Everything selected either way is then closed
 * over `requires`, so a skill can carry its dependencies into a bundle that would never have
 * selected them.
 *
 * Every selected item also carries the reason it was selected (spec §6), because with three routes
 * into a bundle a list of names is not an answer to "why is this here?" — and the lock records the
 * reason too (spec §3.5), so it has to be part of resolution rather than a reporting afterthought.
 */
import type { MergedCatalog, MergedMcp, MergedSkill, ScopeDefinition } from "./catalog.js";
import { MCPS_DIRNAME, SCOPES_FILENAME, SKILL_FILENAME } from "./catalog.js";
import type { ProjectConfig } from "./config.js";
import { AmbitError, ExitCode, at, resolutionError } from "./errors.js";

/** What separates a scope from its children (spec §2). */
const SCOPE_SEPARATOR = ".";

/**
 * What marks a `requires` entry as naming an MCP entity rather than a skill (spec §3.2).
 *
 * Exported because it is the only disambiguator the two namespaces have, so anything that takes a
 * name from a human — `ambit why` — has to read it the same way `requires` does.
 */
export const MCP_REQUIREMENT_PREFIX = "mcp.";

/** A set of catalog items under consideration, each list sorted by name. */
export interface Selection {
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
}

/** Which of the bundle's two namespaces a name belongs to (spec §3.2). */
export type ItemKind = "skill" | "mcp";

/** One item of a bundle, named the way its namespace requires. */
export interface BundleItem {
  readonly kind: ItemKind;
  readonly name: string;
}

/**
 * Why one item is in the bundle (spec §6) — one of the three routes resolution offers, and never
 * more than one, so a reader gets an answer rather than a list of possibilities.
 *
 * A `scope` reason carries both ends of the expansion: the scope the item declares, and the held
 * scope that reached it. They differ whenever selection went through the subtree rule, which is
 * exactly when naming only one of the two would leave a reader looking for a scope their config
 * does not contain.
 */
export type SelectionReason =
  | { readonly kind: "explicit" }
  | { readonly kind: "scope"; readonly scope: string; readonly held: string }
  | { readonly kind: "required-by"; readonly requirer: string };

/** A bundle item with the reason it was selected. */
export interface ReasonedItem extends BundleItem {
  readonly reason: SelectionReason;
}

/** Every selected item's reason, keyed by name within each namespace. */
export interface SelectionReasons {
  readonly skills: ReadonlyMap<string, SelectionReason>;
  readonly mcps: ReadonlyMap<string, SelectionReason>;
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
  /** Why each of the above is here (spec §6), one entry per selected item. */
  readonly reasons: SelectionReasons;
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
 * The concrete next step for a scope nothing recognizes (spec §6): the nearest registered scope
 * when one is a plausible correction, and how to register it otherwise.
 *
 * Exported because two surfaces reject a scope — resolution, on the first offender, and
 * `ambit validate`, on every one of them — and the advice must read identically from both.
 */
export function scopeSuggestion(
  scope: string,
  registered: readonly ScopeDefinition[],
): string {
  const suggestion = nearestScope(scope, registered);
  return suggestion === undefined
    ? `register it in a catalog's ${SCOPES_FILENAME}, or correct the spelling`
    : `did you mean "${suggestion}"?`;
}

/**
 * The error for a held scope the merged registry does not know (spec §4.6).
 *
 * @param where the `(file line N)` suffix, as {@link at} renders it.
 */
export function unknownScopeError(
  scope: string,
  where: string,
  registered: readonly ScopeDefinition[],
): AmbitError {
  return resolutionError(`unknown scope "${scope}" ${where}`, [
    "not found in the merged registry",
    scopeSuggestion(scope, registered),
  ]);
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
 * Stops at the first offender, in name order. Listing every problem at once is `ambit validate`'s
 * job (spec §4 validation split), which reuses the same error builder so the two agree.
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
    throw unknownScopeError(
      scope,
      at(config.origin.file, config.origin.scopeLines.get(scope)),
      registered,
    );
  }
}

/**
 * Where a skill's annotations are written, so an error about one can name a file (spec §6).
 *
 * Exported for `ambit validate`, which reports problems about skills nothing selected and needs to
 * locate them the same way resolution does.
 */
export function skillFile(skill: MergedSkill): string {
  return `${skill.path}/${SKILL_FILENAME}`;
}

/**
 * The error for a `requires` entry no catalog can satisfy (spec §4.9).
 *
 * Both halves of the edge are named — the requirer and the target — because either could be the
 * mistake: a skill may have been renamed, or the requirement misspelled.
 */
export function missingRequirement(requirer: MergedSkill, requirement: string): AmbitError {
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
 * @param head the skill the printed path opens on, whose file holds the loop's first edge.
 */
export function cycleError(cycle: readonly string[], head: MergedSkill): AmbitError {
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

/** The names a config selects outright, by kind. */
interface ExplicitNames {
  readonly skills: ReadonlySet<string>;
  readonly mcps: ReadonlySet<string>;
}

/**
 * The error for a `skills` entry naming a skill nothing provides (spec §4.8).
 *
 * Checked rather than trusted, because the failure mode is silent in the worst way: a misspelled
 * name that selects nothing leaves a bundle missing the one thing the config went out of its way
 * to ask for.
 */
export function unknownExplicitSkill(name: string, config: ProjectConfig): AmbitError {
  return resolutionError(
    `unknown skill "${name}" ${at(config.origin.file, config.origin.skillLines.get(name))}`,
    [
      "`skills` lists it, but no catalog provides a skill with that name",
      "correct the name, configure the catalog that has it, or give the entry its own `source`",
    ],
  );
}

/**
 * The skills and servers config names outright (spec §4.8), whatever scopes they declare.
 *
 * A `skills` entry carrying its own `source`, and every inline `mcps` entry, were folded into
 * `merged` before resolution (see `mergeConfigEntities`), so both `skills` forms resolve by name
 * here and neither needs a case of its own.
 *
 * @throws {AmbitError} exit 3 for a name nothing provides.
 */
function explicitNames(config: ProjectConfig, merged: MergedCatalog): ExplicitNames {
  const provided = new Set(merged.skills.map((skill) => skill.name));

  // Sorted, so which of several unknown names is reported first depends on the names alone rather
  // than on the order the config happens to list them in.
  for (const name of sortedUnique(config.skills.map((request) => request.name))) {
    if (!provided.has(name)) throw unknownExplicitSkill(name, config);
  }

  return {
    skills: new Set(config.skills.map((request) => request.name)),
    mcps: new Set(config.mcps.map((entity) => entity.name)),
  };
}

/** Constant, since an explicit reason has nothing to say beyond its own kind. */
const EXPLICIT: SelectionReason = { kind: "explicit" };

/** How a reason reads in `--explain`, in the lock (spec §3.5), and in `ambit why`. */
export function formatReason(reason: SelectionReason): string {
  switch (reason.kind) {
    case "explicit":
      return "explicit";
    case "scope":
      return `scope:${reason.scope}`;
    case "required-by":
      return `required-by:${reason.requirer}`;
  }
}

/**
 * The error for a bundle that cannot account for one of its own items.
 *
 * Exit 1 rather than 3: no catalog and no config can produce this, since every item in a bundle
 * arrived through one of the three routes by construction. Reaching it means the selection and the
 * explanation of it disagree, which is a bug and worth saying so.
 */
function unexplainable(item: BundleItem, problem: string): AmbitError {
  return new AmbitError(ExitCode.Internal, `cannot explain ${item.kind} "${item.name}"`, [
    problem,
    "this is a bug in ambit; please report it",
  ]);
}

/**
 * The held scope that reached `scope`: itself, or the ancestor whose subtree it lies in.
 *
 * Ties go to the first in `held`, which arrives sorted — and since a scope's ancestors form a
 * prefix chain, that is the broadest held scope. Any of them is equally true, so the tie-break only
 * has to be a function of the names.
 */
function heldAncestor(scope: string, held: readonly string[]): string | undefined {
  return held.find((candidate) => inSubtree(candidate, scope));
}

/**
 * The scope reason for an item, or undefined when no held scope reached it.
 *
 * The declared scopes are searched in sorted order, so an item declaring two selected scopes
 * reports the same one whatever order its frontmatter lists them in.
 */
function scopeReason(
  declared: readonly string[],
  selecting: ReadonlySet<string>,
  held: readonly string[],
): SelectionReason | undefined {
  for (const scope of sortedUnique(declared)) {
    if (!selecting.has(scope)) continue;
    const ancestor = heldAncestor(scope, held);
    if (ancestor !== undefined) return { kind: "scope", scope, held: ancestor };
  }
  return undefined;
}

/**
 * The `required-by` reason for an item: the first selected skill that requires it.
 *
 * Recovered from the closure's result rather than recorded during its walk, so which requirer is
 * named depends only on the names — `selected` is in name order — and not on the order the
 * depth-first walk happened to reach the item. Several skills requiring one thing is normal, and
 * any of them is a true answer.
 */
function requiredByReason(
  item: BundleItem,
  selected: readonly MergedSkill[],
): SelectionReason | undefined {
  const target = item.kind === "mcp" ? `${MCP_REQUIREMENT_PREFIX}${item.name}` : item.name;
  const requirer = selected.find((skill) => skill.requires.includes(target));
  return requirer === undefined ? undefined : { kind: "required-by", requirer: requirer.name };
}

/**
 * The reason each selected item of one namespace carries.
 *
 * Precedence is explicit, then scope, then `required-by`. The first two end a chain where
 * `required-by` continues one, so preferring them keeps an explanation as short as it can be while
 * staying true — and a project that named something outright wants to hear that, not to be told
 * about a scope it could delete without losing the item.
 *
 * @param selected the selected skills, which is what a `requires` edge can come from.
 * @throws {AmbitError} exit 1 for an item none of the three routes accounts for.
 */
function selectionReasons(
  items: readonly { readonly name: string; readonly scopes: readonly string[] }[],
  kind: ItemKind,
  explicit: ReadonlySet<string>,
  selecting: ReadonlySet<string>,
  held: readonly string[],
  selected: readonly MergedSkill[],
): ReadonlyMap<string, SelectionReason> {
  const reasons = new Map<string, SelectionReason>();

  for (const item of items) {
    const target: BundleItem = { kind, name: item.name };
    const reason = explicit.has(item.name)
      ? EXPLICIT
      : (scopeReason(item.scopes, selecting, held) ?? requiredByReason(target, selected));

    if (reason === undefined) {
      throw unexplainable(
        target,
        "it is in the bundle, but no held scope, `requires` edge, or explicit entry selected it",
      );
    }
    reasons.set(item.name, reason);
  }

  return reasons;
}

/** Whether an item is in the bundle. */
export function isSelected(bundle: Bundle, item: BundleItem): boolean {
  const reasons = item.kind === "skill" ? bundle.reasons.skills : bundle.reasons.mcps;
  return reasons.has(item.name);
}

/**
 * Why one item of a bundle is in it.
 *
 * @throws {AmbitError} exit 1 if the item is not in the bundle; check with {@link isSelected}
 *   first, so a name a user typed is rejected as the resolution error it is.
 */
export function reasonOf(bundle: Bundle, item: BundleItem): SelectionReason {
  const reasons = item.kind === "skill" ? bundle.reasons.skills : bundle.reasons.mcps;
  const reason = reasons.get(item.name);
  if (reason === undefined) throw unexplainable(item, "it is not in the bundle");
  return reason;
}

/**
 * The whole chain behind one selected item, root cause first and the item itself last.
 *
 * A reason alone is only half an answer: `required-by:acme.projects.use-acme-brief` prompts the
 * same question one level up, and it is the held scope at the end of the walk that a reader can act
 * on. So the walk follows `required-by` edges backwards until it reaches a root — an explicit entry
 * or a held scope — which terminates because `requires` cycles were rejected during closure.
 *
 * @throws {AmbitError} exit 1 if the item is not in the bundle, or the chain fails to terminate.
 */
export function explainSelection(bundle: Bundle, item: BundleItem): readonly ReasonedItem[] {
  const chain: ReasonedItem[] = [];
  const walked = new Set<string>();
  let current = item;

  for (;;) {
    const reason = reasonOf(bundle, current);
    chain.unshift({ ...current, reason });
    if (reason.kind !== "required-by") return chain;

    // Insurance against a broken invariant rather than against a catalog: a repeat here would mean
    // a `requires` cycle survived closure, and looping forever is a worse way to report that.
    if (walked.has(reason.requirer)) {
      throw unexplainable(
        current,
        `the \`requires\` chain through ${reason.requirer} does not terminate`,
      );
    }
    walked.add(reason.requirer);
    current = { kind: "skill", name: reason.requirer };
  }
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
 * Reasons are computed here rather than on request, so `--explain`, `ambit why`, and the lock all
 * report the same answer, and so a bundle that cannot account for an item fails at resolution
 * instead of at whichever surface happens to ask first.
 *
 * @param merged the catalogs, with the project's own declarations already folded in — a `skills`
 *   entry carrying a `source`, and inline `mcps` — as `mergeConfigEntities` does.
 * @throws {AmbitError} exit 3 for a held scope the merged registry does not know, an explicit skill
 *   nothing provides, a requirement no catalog provides, or a `requires` cycle.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  assertScopesRegistered(config, merged.scopes);

  const held = sortedUnique(config.scopes);
  const selecting = expandHeldScopes(config.scopes, merged.scopes);
  const explicit = explicitNames(config, merged);

  // Both seed lists stay in name order, being filters of the merged catalog, so how something was
  // selected cannot change where it lands in the bundle.
  const { skills, mcps } = closeOverRequires(
    merged.skills.filter(
      (skill) => explicit.skills.has(skill.name) || selectedByScope(selecting, skill.scopes),
    ),
    merged.mcps.filter(
      (mcp) => explicit.mcps.has(mcp.name) || selectedByScope(selecting, mcp.scopes),
    ),
    merged,
  );

  return {
    scopes: held,
    skills,
    mcps,
    env: sortedUnique([...skills.flatMap((skill) => skill.env), ...mcps.flatMap((mcp) => mcp.env)]),
    reasons: {
      skills: selectionReasons(skills, "skill", explicit.skills, selecting, held, skills),
      mcps: selectionReasons(mcps, "mcp", explicit.mcps, selecting, held, skills),
    },
  };
}

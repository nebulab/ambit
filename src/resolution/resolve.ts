/**
 * Resolution — the held scopes and the merged catalog in, the bundle out.
 *
 * Pure and synchronous: everything that touches disk or the network has already happened by the
 * time this runs. That is what makes determinism testable — the same inputs produce a
 * byte-identical bundle, so `resolve --json` can be committed as a golden file.
 *
 * A held scope selects itself and every scope beneath it — **descendants only**.
 * Holding `function.engineering` reaches `function.engineering.frontend`; holding the child never
 * reaches back up to the parent. That asymmetry is what makes the catalog's tree shape
 * load-bearing, so it lives here rather than in any adapter.
 *
 * Nothing else is implicit: no scope is reserved, and a project selects exactly the scopes it
 * lists, expanded downward — a catalog's skills, servers and hooks all come down that route.
 * Alongside it, a project may name skills and servers outright, and declare servers and hooks of its
 * own: those are selected whatever their scopes, since asking for something by
 * name is already the decision that scopes exist to make. Everything selected either way is
 * then closed over `requires`, so a skill can carry its dependencies into a bundle that would never
 * have selected them.
 *
 * Every selected item also carries the reason it was selected, because with three routes
 * into a bundle a list of names is not an answer to "why is this here?" — and the lock records the
 * reason too, so it has to be part of resolution rather than a reporting afterthought.
 */
import type { MergedCatalog, MergedHook, MergedMcp, MergedSkill } from "../model/catalog.js";
import { HOOKS_DIRNAME, MCPS_DIRNAME, SKILL_FILENAME } from "../model/catalog.js";
import type { ProjectConfig, ScopeDefinition } from "../model/config.js";
import { CONFIG_FILENAMES, REGISTRY_PATH } from "../model/config.js";
import type { ItemKind, Requirement } from "../model/requirement.js";
import {
  KIND_NOUNS,
  formatRequirement,
  requirementYaml,
  sameRequirement,
  sortedUniqueRequirements,
} from "../model/requirement.js";
import { AmbitError, ExitCode, at, resolutionError } from "../errors.js";

/**
 * What separates a scope from its children.
 *
 * Exported because authoring reads it too: renaming a scope renames its subtree, so `catalog scope mv`
 * has to cut a name apart exactly where expansion joins one.
 */
export const SCOPE_SEPARATOR = ".";

/** A set of catalog items under consideration, each list sorted by name. */
export interface Selection {
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
  readonly hooks: readonly MergedHook[];
}

export type { ItemKind };

/**
 * One item of a bundle: which namespace, and the name inside it.
 *
 * The same type a `requires` entry parses to, and deliberately so — a requirement names exactly what a
 * bundle item is, and the whole point of {@link Requirement} is that the pair travels together instead
 * of being packed into a string somebody has to unpack again.
 */
export type BundleItem = Requirement;

/**
 * Why one item is in the bundle — one of the three routes resolution offers, and never
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
  readonly hooks: ReadonlyMap<string, SelectionReason>;
}

/** The resolved set of skills, MCP servers and hooks for a project. */
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
  /** Selected hooks, sorted by name. */
  readonly hooks: readonly MergedHook[];
  /** Every env var the selection declares, unioned and sorted. */
  readonly env: readonly string[];
  /** Why each of the above is here, one entry per selected item. */
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
 *
 * Exported for `catalog scope mv`, which renames exactly the scopes a held one would reach: the two
 * answers have to be the same answer, or a rename would change what holding the scope selects.
 */
export function inSubtree(held: string, candidate: string): boolean {
  return candidate === held || candidate.startsWith(`${held}${SCOPE_SEPARATOR}`);
}

/**
 * Expands held scopes into the set that does the selecting: every **registered** scope
 * equal to a held scope or beneath it.
 *
 * Expansion runs against the registry rather than over the scopes skills happen to declare, so
 * `catalog.scopes` stays the single authority on the tree's shape — an unregistered scope cannot
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
 * The concrete next step for a scope nothing recognizes: the nearest registered scope
 * when one is a plausible correction, and how to register it otherwise.
 *
 * Exported because two surfaces reject a scope — resolution, on the first offender, and
 * validation, on every one of them — and the advice must read identically from both.
 */
export function scopeSuggestion(scope: string, registered: readonly ScopeDefinition[]): string {
  const suggestion = nearestScope(scope, registered);
  return suggestion === undefined
    ? `register it under \`${REGISTRY_PATH}\` in a catalog's ${CONFIG_FILENAMES[0]}, or correct the spelling`
    : `did you mean "${suggestion}"?`;
}

/**
 * The error for a held scope the merged registry does not know.
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
 * Rejects a held scope the merged registry does not know.
 *
 * A typo has to fail loudly, because the alternative is worse than an error: expanding to
 * nothing yields a bundle quietly missing everything that scope was meant to bring, and nobody
 * notices until the agent behaves oddly weeks later.
 *
 * The registry decides what may be held, not the shape of the tree — holding `function` when
 * only `function.engineering` is registered is a typo like any other, since a parent nobody
 * declared is not a scope.
 *
 * Stops at the first offender, in name order. Listing every problem at once is validation's
 * job, which reuses the same error builder so the two agree.
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
 * Where a skill's annotations are written, so an error about one can name a file.
 *
 * Exported for validation, which reports problems about skills nothing selected and needs to
 * locate them the same way resolution does.
 */
export function skillFile(skill: MergedSkill): string {
  return `${skill.path}/${SKILL_FILENAME}`;
}

/** Where a missing member of each namespace is added, as the last line of an error says. */
const WHERE_TO_ADD: Readonly<Record<ItemKind, string>> = {
  skill: "add it to a catalog",
  mcp: `add it under ${MCPS_DIRNAME}/ in a catalog`,
  hook: `add it under ${HOOKS_DIRNAME}/ in a catalog`,
};

/**
 * The error for a `requires` entry no catalog can satisfy.
 *
 * Both halves of the edge are named — the requirer and the target — because either could be the
 * mistake: a skill may have been renamed, or the requirement misspelled. The namespace is named
 * outright rather than left to be read off a prefix, since that is what the entry itself now says.
 */
export function missingRequirement(requirer: MergedSkill, target: Requirement): AmbitError {
  return resolutionError(
    `unresolvable requirement "${formatRequirement(target)}" (${skillFile(requirer)})`,
    [
      `${requirer.name} requires ${KIND_NOUNS[target.kind]} named "${target.name}", which no catalog provides`,
      `${WHERE_TO_ADD[target.kind]}, or remove the \`${requirementYaml(target)}\` entry`,
    ],
  );
}

/**
 * The error for a `requires` cycle, printing the whole path rather than the mere fact
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
 * Closes a selection over `requires` until fixpoint: every skill, MCP entity and hook a selected
 * skill requires joins the selection — whether or not its own scopes would ever have selected it.
 *
 * That is the point of the mechanism. A skill that is useless without a company-context skill and
 * a server declares so once, and every profile that reaches it gets a working bundle instead of a
 * plausible-looking broken one. A hook comes down the same route for the same reason: a skill whose
 * instructions are unsafe without its guard carries the guard.
 *
 * Only skills carry `requires` (neither MCP entities nor hooks have such a key), so the graph walked
 * here is skill → skill, with both other namespaces as leaves.
 *
 * @param skills the roots — what scope selection found, sorted by name.
 * @param mcps MCP entities already selected by their own scopes.
 * @param hooks hooks already selected by their own scopes.
 * @param merged what requirements resolve against.
 * @throws {AmbitError} exit 3 for a requirement no catalog provides, or a cycle.
 */
export function closeOverRequires(
  skills: readonly MergedSkill[],
  mcps: readonly MergedMcp[],
  hooks: readonly MergedHook[],
  merged: MergedCatalog,
): Selection {
  const skillsByName = new Map(merged.skills.map((skill) => [skill.name, skill]));
  const mcpsByName = new Map(merged.mcps.map((mcp) => [mcp.name, mcp]));
  const hooksByName = new Map(merged.hooks.map((hook) => [hook.name, hook]));

  const chosenSkills = new Set<string>();
  const chosenMcps = new Set(mcps.map((mcp) => mcp.name));
  const chosenHooks = new Set(hooks.map((hook) => hook.name));

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
    for (const target of sortedUniqueRequirements(skill.requires)) {
      // Both leaf namespaces end the walk: nothing an entity or a hook declares reaches anything
      // else, so joining the selection is all there is to do.
      if (target.kind === "mcp") {
        const required = mcpsByName.get(target.name);
        if (required === undefined) throw missingRequirement(skill, target);
        chosenMcps.add(required.name);
        continue;
      }

      if (target.kind === "hook") {
        const required = hooksByName.get(target.name);
        if (required === undefined) throw missingRequirement(skill, target);
        chosenHooks.add(required.name);
        continue;
      }

      const required = skillsByName.get(target.name);
      if (required === undefined) throw missingRequirement(skill, target);
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
    hooks: merged.hooks.filter((hook) => chosenHooks.has(hook.name)),
  };
}

/**
 * Whether a declared scope list is selected by the expanded held scopes.
 *
 * An empty list is never selected — such a thing is reachable only through `requires` or an
 * explicit listing.
 */
function selectedByScope(selecting: ReadonlySet<string>, declared: readonly string[]): boolean {
  return declared.some((scope) => selecting.has(scope));
}

/** The names a config selects outright, by kind. */
interface ExplicitNames {
  readonly skills: ReadonlySet<string>;
  readonly mcps: ReadonlySet<string>;
  readonly hooks: ReadonlySet<string>;
}

/**
 * The error for a `skills` entry naming a skill nothing provides.
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
 * The skills, servers and hooks config names outright, whatever scopes they declare.
 *
 * A `skills` entry carrying its own `source`, and every inline `mcps` and `hooks` entry, were folded
 * into `merged` before resolution (see `mergeConfigEntities`), so both `skills` forms resolve by name
 * here and neither needs a case of its own. What is collected here is only which *names* the config
 * asked for by writing them down, which is what makes their reason `explicit`.
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
    hooks: new Set(config.hooks.map((entity) => entity.name)),
  };
}

/** Constant, since an explicit reason has nothing to say beyond its own kind. */
const EXPLICIT: SelectionReason = { kind: "explicit" };

/** How a reason reads in `--explain`, in the lock, and in `ambit why`. */
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
  const requirer = selected.find((skill) =>
    skill.requires.some((requirement) => sameRequirement(requirement, item)),
  );
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

/** The reasons of the namespace `kind` names, so a lookup never has to know which map that is. */
function reasonsOf(bundle: Bundle, kind: ItemKind): ReadonlyMap<string, SelectionReason> {
  switch (kind) {
    case "skill":
      return bundle.reasons.skills;
    case "mcp":
      return bundle.reasons.mcps;
    case "hook":
      return bundle.reasons.hooks;
  }
}

/** Whether an item is in the bundle. */
export function isSelected(bundle: Bundle, item: BundleItem): boolean {
  return reasonsOf(bundle, item.kind).has(item.name);
}

/**
 * Why one item of a bundle is in it.
 *
 * @throws {AmbitError} exit 1 if the item is not in the bundle; check with {@link isSelected}
 *   first, so a name a user typed is rejected as the resolution error it is.
 */
export function reasonOf(bundle: Bundle, item: BundleItem): SelectionReason {
  const reason = reasonsOf(bundle, item.kind).get(item.name);
  if (reason === undefined) throw unexplainable(item, "it is not in the bundle");
  return reason;
}

/**
 * The whole chain behind one selected item, root cause first and the item itself last.
 *
 * A reason alone is only half an answer: `required-by:acme-brief` prompts the same question one
 * level up, and it is the held scope at the end of the walk that a reader can act on. So the walk
 * follows `required-by` edges backwards until it reaches a root — an explicit entry or a held
 * scope — which terminates because `requires` cycles were rejected during closure.
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
 * `env` is unioned over the closed selection, not the scope-selected one: a server
 * pulled in by `requires` needs its credentials as much as one selected by scope. A hook's `env`
 * joins it too — a hook that cannot see its credential is as broken as a server that cannot.
 *
 * Reasons are computed here rather than on request, so `--explain`, `ambit why`, and the lock all
 * report the same answer, and so a bundle that cannot account for an item fails at resolution
 * instead of at whichever surface happens to ask first.
 *
 * @param merged the catalogs, with the project's own declarations already folded in — a `skills`
 *   entry carrying a `source`, inline `mcps`, and inline `hooks` — as `mergeConfigEntities` does, so
 *   every namespace resolves by name here and no surface needs a case of its own.
 * @throws {AmbitError} exit 3 for a held scope the merged registry does not know, an explicit skill
 *   nothing provides, a requirement no catalog provides, or a `requires` cycle.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  assertScopesRegistered(config, merged.scopes);

  const held = sortedUnique(config.scopes);
  const selecting = expandHeldScopes(config.scopes, merged.scopes);
  const explicit = explicitNames(config, merged);

  // All three seed lists stay in name order, being filters of the merged catalog, so how something
  // was selected cannot change where it lands in the bundle. The third one means a catalog hook is
  // reached by scope exactly as a server is, and an inline one — folded in as explicit — is selected
  // whatever scopes it names.
  const { skills, mcps, hooks } = closeOverRequires(
    merged.skills.filter(
      (skill) => explicit.skills.has(skill.name) || selectedByScope(selecting, skill.scopes),
    ),
    merged.mcps.filter(
      (mcp) => explicit.mcps.has(mcp.name) || selectedByScope(selecting, mcp.scopes),
    ),
    merged.hooks.filter(
      (hook) => explicit.hooks.has(hook.name) || selectedByScope(selecting, hook.scopes),
    ),
    merged,
  );

  return {
    scopes: held,
    skills,
    mcps,
    hooks,
    env: sortedUnique([
      ...skills.flatMap((skill) => skill.env),
      ...mcps.flatMap((mcp) => mcp.env),
      ...hooks.flatMap((hook) => hook.env),
    ]),
    reasons: {
      skills: selectionReasons(skills, "skill", explicit.skills, selecting, held, skills),
      mcps: selectionReasons(mcps, "mcp", explicit.mcps, selecting, held, skills),
      hooks: selectionReasons(hooks, "hook", explicit.hooks, selecting, held, skills),
    },
  };
}

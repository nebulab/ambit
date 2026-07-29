/**
 * Resolution — the held scopes and the merged catalog in, the bundle out.
 *
 * Pure and synchronous: everything that touches disk or the network has already happened by the
 * time this runs. That is what makes determinism testable — the same inputs produce a
 * byte-identical bundle, so `resolve --json` can be committed as a golden file.
 *
 * A held scope matches a **tag** an item declares, and every tag beneath it — **descendants only**.
 * Holding `function.engineering` reaches an item tagged `function.engineering.frontend`; holding the
 * child never reaches back up to the parent. Nothing registers a tag and nothing describes one, so
 * the set a held scope expands over is whatever the catalog's items happen to declare — an author
 * who tags a new skill `function.engineering` reaches every project already holding that scope, with
 * no consumer edit and nothing to keep in step.
 *
 * Nothing else is implicit: no scope is reserved, and a project selects exactly the scopes it
 * lists, expanded downward — a catalog's skills, servers and hooks all come down that route.
 * Alongside it, a project may name skills outright, and those are selected whatever their tags, since
 * asking for something by name is already the decision that scopes exist to make. Everything selected
 * either way is then closed over `requires`, so a skill can carry its dependencies into a bundle that
 * would never have selected them.
 *
 * Two catalogs may provide one name, and the merged catalog holds both copies — a bundle holds at
 * most one. A selection that reached both is refused, because harness layout is flat and externally
 * imposed and the two copies would materialize to one path; see {@link assertNoCollisions}. That
 * refusal is what makes a bare name an identity within a bundle, so every map here keys on one, while
 * everything reading the merged catalog keys on `<catalog>/<name>`.
 *
 * Every selected item also carries the reason it was selected, because with three routes
 * into a bundle a list of names is not an answer to "why is this here?" — and the lock records the
 * reason too, so it has to be part of resolution rather than a reporting afterthought.
 */
import type { MergedCatalog, MergedHook, MergedMcp, MergedSkill } from "../model/catalog.js";
import {
  HOOKS_DIRNAME,
  MCPS_DIRNAME,
  SKILL_FILENAME,
  copiesByName,
  qualifiedName,
} from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import type { ExpectationSet } from "../model/expectation.js";
import { unionExpectations } from "../model/expectation.js";
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
 * Named rather than inlined because {@link inSubtree} is the only thing that reads it, and a bare `.`
 * at that call site would read as punctuation rather than as the one place the subtree rule is
 * spelled.
 */
export const SCOPE_SEPARATOR = ".";

/**
 * A set of catalog items under consideration, each list in the merged catalog's own order — name,
 * then catalog.
 *
 * Two copies of one name can be in here: this is what {@link closeOverRequires} produces, and
 * {@link assertNoCollisions} is what judges it. A {@link Bundle} is a selection that has passed that
 * check.
 */
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
 * A `scope` reason carries both ends of the expansion: the tag the item declares, and the held
 * scope that reached it. They differ whenever selection went through the subtree rule, which is
 * exactly when naming only one of the two would leave a reader looking for a label their config
 * does not contain.
 */
export type SelectionReason =
  | { readonly kind: "explicit" }
  | { readonly kind: "scope"; readonly tag: string; readonly held: string }
  | { readonly kind: "required-by"; readonly requirer: string };

/** A bundle item with the reason it was selected. */
export interface ReasonedItem extends BundleItem {
  readonly reason: SelectionReason;
}

/**
 * Every selected item's reason, keyed by name within each namespace.
 *
 * By name and not by address, because a bundle holds one item per name per namespace —
 * {@link assertNoCollisions} refuses anything else — and a reader asking why `house-style` is
 * installed has one thing installed under that name to ask about.
 */
export interface SelectionReasons {
  readonly skills: ReadonlyMap<string, SelectionReason>;
  readonly mcps: ReadonlyMap<string, SelectionReason>;
  readonly hooks: ReadonlyMap<string, SelectionReason>;
}

/**
 * The resolved set of skills, MCP servers and hooks for a project.
 *
 * One item per name within each namespace, which is what everything downstream — `install`, the
 * lock, `status`, `doctor`, `why` — relies on when it keys on a bare name. The guarantee comes from
 * {@link assertNoCollisions} rather than from the merged catalog, which holds every catalog's copy.
 */
export interface Bundle {
  /**
   * The held scopes exactly as the project declared them, deduplicated and sorted. The set of tags
   * they expand over is derived from these and the catalog, and is deliberately not reported: a
   * reader wants their own list back, not every label the catalog happens to carry.
   */
  readonly scopes: readonly string[];
  /** Selected skills, sorted by name. */
  readonly skills: readonly MergedSkill[];
  /** Selected MCP servers, sorted by name. */
  readonly mcps: readonly MergedMcp[];
  /** Selected hooks, sorted by name. */
  readonly hooks: readonly MergedHook[];
  /**
   * Every precondition the selection declares, unioned and grouped by kind.
   *
   * Grouped rather than flat because an expectation's kind decides what checking it *means* — a
   * variable is looked up in the environment, and the `bin:` that follows it would be looked up on the
   * `PATH`. A flat list would make `doctor` re-derive from a name what the entry already said.
   */
  readonly expects: ExpectationSet;
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
 * One test rather than a prefix check at each call site, so expansion and the reason a held scope
 * reached an item cannot disagree about what a subtree is.
 */
export function inSubtree(held: string, candidate: string): boolean {
  return candidate === held || candidate.startsWith(`${held}${SCOPE_SEPARATOR}`);
}

/**
 * Every tag the merged catalog's items declare, deduplicated and sorted.
 *
 * This is what selection and every message about a scope work from, now that nothing registers a
 * label anywhere: the catalog's vocabulary is the union of what its skills, servers and hooks
 * happen to say. Sorted, so a suggestion and an expansion are functions of the values alone.
 */
export function declaredTags(merged: MergedCatalog): readonly string[] {
  return sortedUnique([
    ...merged.skills.flatMap((skill) => skill.tags),
    ...merged.mcps.flatMap((mcp) => mcp.tags),
    ...merged.hooks.flatMap((hook) => hook.tags),
  ]);
}

/**
 * Expands held scopes into the set that does the selecting: every declared tag equal to a held
 * scope or beneath it.
 *
 * The subtree rule is unchanged; what it runs over is not. Expansion used to be filtered through a
 * registry, which is what made a catalog's tree shape load-bearing — a consumer could only select at
 * a depth the author had registered. Over declared tags there is no shape to agree with: a tag one
 * level deeper than anything anyone foresaw is reached by whichever held scope is above it.
 *
 * Deliberately total: a held scope nothing declares simply contributes nothing here, so the
 * expansion can be reasoned about as a set operation. Rejecting such a scope is
 * {@link assertScopesDeclared}'s job, and {@link resolveBundle} runs it first.
 */
export function expandHeldScopes(
  held: readonly string[],
  declared: readonly string[],
): ReadonlySet<string> {
  const expanded = new Set<string>();
  // Both loops run in sorted order — `declared` arrives sorted — so the set's insertion order is a
  // function of the values alone, not of config or filesystem order.
  for (const scope of [...held].sort(compare)) {
    for (const tag of declared) {
      if (inSubtree(scope, tag)) expanded.add(tag);
    }
  }
  return expanded;
}

/**
 * How far a declared tag may be from a held scope and still be worth proposing as the
 * correction.
 *
 * Scaled by length rather than fixed: a typo in a long dotted label is still one or two edits
 * from its target, while at a threshold generous enough to catch those, a short unrelated word
 * would confidently propose something it has nothing to do with.
 */
function suggestionThreshold(scope: string): number {
  return Math.max(2, Math.floor(scope.length / 3));
}

/** Levenshtein distance. A catalog declares tens of tags, so the exact distance is cheap. */
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
 * The declared tag nearest `scope`, or undefined when nothing is close enough that proposing
 * it would help.
 *
 * Ties go to the first candidate in `declared`, which arrives sorted, so the suggestion is a
 * function of the names alone.
 */
function nearestScope(scope: string, declared: readonly string[]): string | undefined {
  const threshold = suggestionThreshold(scope);
  let best: { readonly name: string; readonly distance: number } | undefined;

  for (const tag of declared) {
    const distance = editDistance(scope, tag);
    if (distance > threshold) continue;
    if (best === undefined || distance < best.distance) best = { name: tag, distance };
  }

  return best?.name;
}

/**
 * The concrete next step for a scope nothing recognizes: the nearest declared tag when one is a
 * plausible correction, and how to make the scope mean something otherwise.
 *
 * Exported because two surfaces reject a scope — resolution, on the first offender, and
 * validation, on every one of them — and the advice must read identically from both.
 */
export function scopeSuggestion(scope: string, declared: readonly string[]): string {
  const suggestion = nearestScope(scope, declared);
  return suggestion === undefined
    ? "tag an item with it (`ambit.tags`), or correct the spelling"
    : `did you mean "${suggestion}"?`;
}

/**
 * The error for a held scope no item in any catalog declares.
 *
 * @param where the `(file line N)` suffix, as {@link at} renders it.
 */
export function unknownScopeError(
  scope: string,
  where: string,
  declared: readonly string[],
): AmbitError {
  return resolutionError(`unknown scope "${scope}" ${where}`, [
    "no item in any configured catalog declares it, or anything beneath it",
    scopeSuggestion(scope, declared),
  ]);
}

/**
 * Rejects a held scope no item declares.
 *
 * A typo has to fail loudly, because the alternative is worse than an error: expanding to
 * nothing yields a bundle quietly missing everything that scope was meant to bring, and nobody
 * notices until the agent behaves oddly weeks later. This is the only surface left that can catch
 * one at all — with nothing registering a tag, the same typo made *inside* a catalog is simply a
 * new tag, and no check anywhere says a word about it.
 *
 * The subtree rule counts here: holding `function` is fine as long as something is tagged
 * `function.engineering`, because that scope does select. What is refused is a scope whose whole
 * subtree is empty, which is exactly the set that selects nothing.
 *
 * Stops at the first offender, in name order. Listing every problem at once is validation's
 * job, which reuses the same error builder so the two agree.
 *
 * @throws {AmbitError} exit 3, naming the scope, the config line it was written on, and the
 *   nearest declared tag when one is a plausible correction.
 */
export function assertScopesDeclared(config: ProjectConfig, declared: readonly string[]): void {
  // Sorted, so which of several unknown scopes is reported first depends on the names alone
  // rather than on the order the config happens to list them in.
  for (const scope of sortedUnique(config.scopes)) {
    if (declared.some((tag) => inSubtree(scope, tag))) continue;
    throw unknownScopeError(
      scope,
      at(config.origin.file, config.origin.scopeLines.get(scope)),
      declared,
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
 * skill requires joins the selection — whether or not its own tags would ever have selected it.
 *
 * That is the point of the mechanism. A skill that is useless without a company-context skill and
 * a server declares so once, and every profile that reaches it gets a working bundle instead of a
 * plausible-looking broken one. A hook comes down the same route for the same reason: a skill whose
 * instructions are unsafe without its guard carries the guard.
 *
 * Only skills carry `requires` (neither MCP entities nor hooks have such a key), so the graph walked
 * here is skill → skill, with both other namespaces as leaves.
 *
 * A requirement names a name, and several catalogs may provide it — so **every copy joins the
 * selection**, not one of them. There is nothing left to choose with: config order settles nothing,
 * and taking the first copy would be the precedence this design deleted, reintroduced where nobody
 * could see it. Two copies both selected is then {@link assertNoCollisions}'s refusal, which is loud
 * and names both catalogs.
 *
 * @param skills the roots — what scope selection found, in the merged catalog's order.
 * @param mcps MCP entities already selected by their own tags.
 * @param hooks hooks already selected by their own tags.
 * @param merged what requirements resolve against.
 * @throws {AmbitError} exit 3 for a requirement no catalog provides, or a cycle.
 */
export function closeOverRequires(
  skills: readonly MergedSkill[],
  mcps: readonly MergedMcp[],
  hooks: readonly MergedHook[],
  merged: MergedCatalog,
): Selection {
  const skillCopies = copiesByName(merged.skills);
  const mcpCopies = copiesByName(merged.mcps);
  const hookCopies = copiesByName(merged.hooks);

  // Addresses rather than names throughout: one catalog's copy of a name being selected says nothing
  // about another's, so a set of names would silently treat the two as one item.
  const chosenSkills = new Set<string>();
  const chosenMcps = new Set(mcps.map(qualifiedName));
  const chosenHooks = new Set(hooks.map(qualifiedName));

  // The two colours a depth-first walk needs to tell a cycle from a diamond: `path` is the chain
  // currently being followed, in order, so meeting something already on it yields the cycle
  // itself; `closed` is what has been followed to completion, and revisiting that is just a
  // requirement two skills share.
  const path: MergedSkill[] = [];
  const closed = new Set<string>();

  const follow = (skill: MergedSkill): void => {
    const address = qualifiedName(skill);
    if (closed.has(address)) return;

    const opened = path.findIndex((entry) => qualifiedName(entry) === address);
    // The printed path is names, which is what an author reads in a `requires` list; the walk's own
    // bookkeeping is addresses, so two catalogs' copies of one name are two nodes rather than a
    // cycle between them.
    if (opened !== -1) {
      throw cycleError(
        [...path.slice(opened), skill].map((entry) => entry.name),
        skill,
      );
    }

    path.push(skill);
    chosenSkills.add(address);

    // Sorted and deduplicated, so which of several problems in one `requires` list is reported
    // does not depend on the order its author happened to write them in.
    for (const target of sortedUniqueRequirements(skill.requires)) {
      // Both leaf namespaces end the walk: nothing an entity or a hook declares reaches anything
      // else, so joining the selection is all there is to do.
      if (target.kind === "mcp") {
        const required = mcpCopies.get(target.name);
        if (required === undefined) throw missingRequirement(skill, target);
        for (const copy of required) chosenMcps.add(qualifiedName(copy));
        continue;
      }

      if (target.kind === "hook") {
        const required = hookCopies.get(target.name);
        if (required === undefined) throw missingRequirement(skill, target);
        for (const copy of required) chosenHooks.add(qualifiedName(copy));
        continue;
      }

      const required = skillCopies.get(target.name);
      if (required === undefined) throw missingRequirement(skill, target);
      for (const copy of required) follow(copy);
    }

    path.pop();
    closed.add(address);
  };

  for (const skill of skills) follow(skill);

  // Filtering the merged lists rather than collecting during the walk keeps the result in the merged
  // catalog's order, whatever order the closure happened to discover things in.
  return {
    skills: merged.skills.filter((skill) => chosenSkills.has(qualifiedName(skill))),
    mcps: merged.mcps.filter((mcp) => chosenMcps.has(qualifiedName(mcp))),
    hooks: merged.hooks.filter((hook) => chosenHooks.has(qualifiedName(hook))),
  };
}

/**
 * What a namespace is called in a message about two catalogs providing one of its members.
 *
 * {@link KIND_NOUNS} carries an article, which reads wrong where the name follows immediately —
 * *a skill "house-style"* — so this is the bare noun for exactly that sentence shape.
 */
const KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
};

/**
 * The error for one name two selected catalogs both provide.
 *
 * A harness's layout is flat and not ambit's to change — Claude reads `.claude/skills/<name>` — so
 * both copies want one path and there is no way to install both. Dropping one is refused rather than
 * chosen: nothing is left to prefer either with, since no catalog outranks another, and a bundle
 * quietly missing a copy the selection asked for is the failure nobody can debug.
 *
 * The advice is *narrow what selects them*, which is what it is however selection is spelled: a held
 * scope reaching two copies is narrowed by holding one only one of them declares, and a pattern
 * reaching two is narrowed by qualifying it with a single catalog.
 *
 * @param catalogs every catalog providing the name, in catalog order.
 */
function collisionError(kind: ItemKind, name: string, catalogs: readonly string[]): AmbitError {
  return resolutionError(`${KIND_LABELS[kind]} "${name}" is selected from more than one catalog`, [
    `provided by: ${catalogs.join(", ")}`,
    "a harness reads one entry per name, so both copies would be installed at the same path",
    "select only one copy: narrow what selects them, or drop the catalog that should not provide it",
  ]);
}

/** Rejects two selected copies of one name within one namespace. */
function assertOnePerName(
  kind: ItemKind,
  items: readonly { readonly name: string; readonly catalog: string }[],
): void {
  const providers = new Map<string, string[]>();
  for (const item of items) {
    providers.set(item.name, [...(providers.get(item.name) ?? []), item.catalog]);
  }

  for (const [name, catalogs] of providers) {
    if (catalogs.length > 1) throw collisionError(kind, name, catalogs);
  }
}

/**
 * Rejects a selection holding two catalogs' copies of one name.
 *
 * This is where the collision the merge stopped arbitrating is settled, and the conflict it is about
 * is materialization rather than selection: a name two catalogs ship costs nothing until a project
 * selects both copies and a harness is asked to hold them at one path.
 *
 * Stops at the first offender, in namespace order and then name order — the selection arrives sorted
 * by name and then catalog, so which collision is reported, and the order the catalogs are named in,
 * depend on the names alone.
 *
 * @throws {AmbitError} exit 3, naming the item and every catalog that provides it.
 */
export function assertNoCollisions(selection: Selection): void {
  assertOnePerName("skill", selection.skills);
  assertOnePerName("mcp", selection.mcps);
  assertOnePerName("hook", selection.hooks);
}

/**
 * Whether an item's declared tags are reached by the expanded held scopes.
 *
 * An empty list is never selected — such a thing is reachable only through `requires` or an
 * explicit listing.
 */
function selectedByScope(selecting: ReadonlySet<string>, tags: readonly string[]): boolean {
  return tags.some((tag) => selecting.has(tag));
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
      "correct the name, or configure the catalog that has it",
    ],
  );
}

/**
 * The skills a config names outright, whatever tags they carry.
 *
 * Skills only: `skills` is the one list of names a project config holds, so a server or a hook is
 * reached by a held scope or by `requires` and never by being written down.
 *
 * @throws {AmbitError} exit 3 for a name nothing provides.
 */
function explicitNames(config: ProjectConfig, merged: MergedCatalog): ReadonlySet<string> {
  const provided = new Set(merged.skills.map((skill) => skill.name));

  // Sorted, so which of several unknown names is reported first depends on the names alone rather
  // than on the order the config happens to list them in.
  for (const name of sortedUnique(config.skills)) {
    if (!provided.has(name)) throw unknownExplicitSkill(name, config);
  }

  return new Set(config.skills);
}

/**
 * No name was written down: what the two namespaces a config cannot name outright pass for
 * `explicit`.
 *
 * A constant rather than a fresh set per call, and named rather than inlined, so the call sites read
 * as the claim {@link explicitNames} makes rather than as an empty collection somebody forgot to
 * fill.
 */
const NOTHING_EXPLICIT: ReadonlySet<string> = new Set();

/** Constant, since an explicit reason has nothing to say beyond its own kind. */
const EXPLICIT: SelectionReason = { kind: "explicit" };

/** How a reason reads in `--explain`, in the lock, and in `ambit why`. */
export function formatReason(reason: SelectionReason): string {
  switch (reason.kind) {
    case "explicit":
      return "explicit";
    case "scope":
      return `scope:${reason.tag}`;
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
 * The held scope that reached `tag`: the tag itself, or the ancestor whose subtree it lies in.
 *
 * Ties go to the first in `held`, which arrives sorted — and since a label's ancestors form a
 * prefix chain, that is the broadest held scope. Any of them is equally true, so the tie-break only
 * has to be a function of the names.
 */
function heldAncestor(tag: string, held: readonly string[]): string | undefined {
  return held.find((candidate) => inSubtree(candidate, tag));
}

/**
 * The scope reason for an item, or undefined when no held scope reached it.
 *
 * The declared tags are searched in sorted order, so an item whose tags are reached twice over
 * reports the same one whatever order its frontmatter lists them in.
 */
function scopeReason(
  tags: readonly string[],
  selecting: ReadonlySet<string>,
  held: readonly string[],
): SelectionReason | undefined {
  for (const tag of sortedUnique(tags)) {
    if (!selecting.has(tag)) continue;
    const ancestor = heldAncestor(tag, held);
    if (ancestor !== undefined) return { kind: "scope", tag, held: ancestor };
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
 * @param explicit the names the config wrote down, which is {@link NOTHING_EXPLICIT} for every
 *   namespace but skills.
 * @param selected the selected skills, which is what a `requires` edge can come from.
 * @throws {AmbitError} exit 1 for an item none of the three routes accounts for.
 */
function selectionReasons(
  items: readonly { readonly name: string; readonly tags: readonly string[] }[],
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
      : (scopeReason(item.tags, selecting, held) ?? requiredByReason(target, selected));

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
 * `expects` is unioned over the closed selection, not the scope-selected one: a server
 * pulled in by `requires` needs its credentials as much as one selected by scope. A hook's `expects`
 * joins it too — a hook that cannot see its credential is as broken as a server that cannot.
 *
 * Reasons are computed here rather than on request, so `--explain`, `ambit why`, and the lock all
 * report the same answer, and so a bundle that cannot account for an item fails at resolution
 * instead of at whichever surface happens to ask first.
 *
 * @param merged every configured catalog, which is where every definition is: a project that ships
 *   items of its own lists itself as a catalog, so all three namespaces arrive here the same way.
 * @throws {AmbitError} exit 3 for a held scope nothing declares, an explicit skill nothing provides,
 *   a requirement no catalog provides, a `requires` cycle, or one name selected from two catalogs.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  const declared = declaredTags(merged);
  assertScopesDeclared(config, declared);

  const held = sortedUnique(config.scopes);
  const selecting = expandHeldScopes(config.scopes, declared);
  const explicit = explicitNames(config, merged);

  // All three seed lists stay in the merged catalog's order, being filters of it, so how something
  // was selected cannot change where it lands in the bundle. Only the first consults `explicit`:
  // `skills` is the one list of names a config holds, so a server and a hook are reached by a held
  // scope alone — or, below, by something that requires them.
  //
  // Selection is per copy, not per name: a held scope reaching two catalogs' copies of one name
  // selects both, which is what makes the collision the project's to resolve rather than ambit's.
  const selection = closeOverRequires(
    merged.skills.filter(
      (skill) => explicit.has(skill.name) || selectedByScope(selecting, skill.tags),
    ),
    merged.mcps.filter((mcp) => selectedByScope(selecting, mcp.tags)),
    merged.hooks.filter((hook) => selectedByScope(selecting, hook.tags)),
    merged,
  );

  // Before the bundle exists, and before any map below keys on a bare name: this is the check that
  // makes a name an identity from here on, so nothing downstream can quietly drop a copy instead.
  assertNoCollisions(selection);
  const { skills, mcps, hooks } = selection;

  return {
    scopes: held,
    skills,
    mcps,
    hooks,
    expects: unionExpectations([
      ...skills.map((skill) => skill.expects),
      ...mcps.map((mcp) => mcp.expects),
      ...hooks.map((hook) => hook.expects),
    ]),
    reasons: {
      skills: selectionReasons(skills, "skill", explicit, selecting, held, skills),
      mcps: selectionReasons(mcps, "mcp", NOTHING_EXPLICIT, selecting, held, skills),
      hooks: selectionReasons(hooks, "hook", NOTHING_EXPLICIT, selecting, held, skills),
    },
  };
}

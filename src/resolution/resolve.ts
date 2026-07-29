/**
 * Resolution — the project's `requires` list and the merged catalog in, the bundle out.
 *
 * Pure and synchronous: everything that touches disk or the network has already happened by the
 * time this runs. That is what makes determinism testable — the same inputs produce a
 * byte-identical bundle, so `resolve --json` can be committed as a golden file.
 *
 * **One addressing scheme.** A project writes `requires` entries, each naming a field to match
 * (`name` or `tag`), a glob to match it with, and the namespaces to match it against. An exact name
 * is a pattern with no wildcard, so naming one skill and selecting a whole tag are the same
 * operator rather than two routes with two spellings and two error classes. The grammar and the
 * matcher live in `model/pattern.ts`; what lives here is what a match *means*.
 *
 * Three things follow, and all three are the point:
 *
 * - **A pattern matching nothing is exit 3** ({@link assertEntriesMatch}). A typo'd or stale entry
 *   that quietly selected nothing would leave a bundle missing exactly what the config went out of
 *   its way to ask for, and nobody would notice until the agent behaved oddly weeks later.
 * - **An address is qualified.** Every project entry names the catalog it selects from, so which
 *   copy of a name is being asked for never depends on the order `catalogs:` happens to list them
 *   in. A tag entry still reaches whatever the author labelled, so a new skill tagged for engineers
 *   arrives with no consumer edit — the author's push survives, without a registry.
 * - **A reason is the entry.** Every selected item carries either the entry that selected it or the
 *   skill that required it, and nothing else: two cases, so a reader gets an answer rather than a
 *   list of possibilities. The lock records the reason too, so it has to be part of resolution
 *   rather than a reporting afterthought.
 *
 * Everything selected is then closed over `requires` — a skill's own, which is still a list of
 * `<kind>:<name>` references — so a skill can carry its dependencies into a bundle that would never
 * have selected them.
 *
 * Two catalogs may provide one name, and the merged catalog holds both copies — a bundle holds at
 * most one. A selection that reached both is refused, because harness layout is flat and externally
 * imposed and the two copies would materialize to one path; see {@link assertNoCollisions}. That
 * refusal is what makes a bare name an identity within a bundle, so every map here keys on one, while
 * everything reading the merged catalog keys on `<catalog>/<name>`.
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
import type { PatternEntry, PatternItem } from "../model/pattern.js";
import {
  CAPABILITY_OF_KIND,
  REQUIRES_KEY,
  entryYaml,
  formatEntry,
  matches,
} from "../model/pattern.js";
import type { Reference } from "../model/reference.js";
import type { ItemKind, Requirement } from "../model/requirement.js";
import {
  ITEM_KINDS,
  KIND_NOUNS,
  formatRequirement,
  requirementYaml,
  sameRequirement,
  sortedUniqueRequirements,
} from "../model/requirement.js";
import { AmbitError, ExitCode, at, resolutionError } from "../errors.js";

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
 * A {@link Reference} over the item kinds, and no longer the same type a `requires` entry parses to.
 * The two used to be one because a requirement *was* a kind and a name; a pattern entry is a
 * question about a catalog, answered by zero or more items of possibly several namespaces, and a
 * bundle item is one item of one namespace. Sharing a type would let a selection name something no
 * bundle item could be.
 */
export type BundleItem = Reference<ItemKind>;

/**
 * Why one item is in the bundle — one of the two routes resolution offers, and never both, so a
 * reader gets an answer rather than a list of possibilities.
 *
 * A `selected` reason carries the entry itself rather than a rendering of it, so a caller can print
 * the field and the pattern together ({@link formatEntry}) and nothing has to re-derive either from a
 * string. It is deliberately the whole entry and not the matched value: a reader looking for *why*
 * needs the line of their own config, and the tag an author happened to write is not that.
 */
export type SelectionReason =
  | { readonly kind: "selected"; readonly entry: PatternEntry }
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
 *
 * The config's own `requires` list is deliberately not echoed back. A bundle is what was selected,
 * and the entries that did the selecting are already in the file the reader has open — one per
 * selected item, in {@link Bundle.reasons}, which is the half they cannot look up.
 */
export interface Bundle {
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

/**
 * One item of one namespace, in the shape the matcher takes.
 *
 * The one place the bundle's singular vocabulary (`skill`, `mcp`, `hook`) meets the entry grammar's
 * plural one, via {@link CAPABILITY_OF_KIND}, so no caller iterating a merged list has to pair them
 * up again.
 */
function patternItem(
  kind: ItemKind,
  item: { readonly catalog: string; readonly name: string; readonly tags: readonly string[] },
): PatternItem {
  return {
    capability: CAPABILITY_OF_KIND[kind],
    catalog: item.catalog,
    name: item.name,
    tags: item.tags,
  };
}

/**
 * The entry that selected an item, or undefined when none did.
 *
 * Several entries may reach one item — a tag entry and a name entry, or a wildcard and the exact
 * name under it — and any of them is a true answer, so the tie-break only has to be a function of
 * the entries themselves. It sorts on {@link formatEntry}, which is what the reason prints: two
 * entries that tie there say the same words, so which one is chosen cannot be observed.
 */
export function selectingEntry(
  entries: readonly PatternEntry[],
  kind: ItemKind,
  item: { readonly catalog: string; readonly name: string; readonly tags: readonly string[] },
): PatternEntry | undefined {
  const subject = patternItem(kind, item);
  return entries
    .filter((entry) => matches(entry, subject))
    .sort((a, b) => compare(formatEntry(a), formatEntry(b)))[0];
}

/** Whether any item in any configured catalog is selected by `entry`. */
export function matchesAnything(entry: PatternEntry, merged: MergedCatalog): boolean {
  return (
    merged.skills.some((skill) => matches(entry, patternItem("skill", skill))) ||
    merged.mcps.some((mcp) => matches(entry, patternItem("mcp", mcp))) ||
    merged.hooks.some((hook) => matches(entry, patternItem("hook", hook)))
  );
}

/**
 * What a namespace is called in a message about one of its members, without an article.
 *
 * {@link KIND_NOUNS} carries one, which reads wrong where a name follows immediately — *a skill
 * "house-style"* — so this is the bare noun for exactly that sentence shape.
 */
const KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
};

/** `a, b or c`, for a list a sentence has to read as one. */
function orList(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]!}`;
}

/** The namespaces an entry selects, as a message names them: `skill, MCP server or hook`. */
function capabilityNouns(entry: PatternEntry): string {
  return orList(
    ITEM_KINDS.filter((kind) => entry.capabilities.includes(CAPABILITY_OF_KIND[kind])).map(
      (kind) => KIND_LABELS[kind],
    ),
  );
}

/** How a message names the catalog an entry is confined to, qualified or not. */
function withinCatalog(entry: PatternEntry): string {
  return entry.catalog === undefined ? "any configured catalog" : `catalog "${entry.catalog}"`;
}

/** The concrete next step for an entry that matched nothing, in the terms of the field it matches. */
function unmatchedAdvice(entry: PatternEntry): string {
  return entry.field === "tag"
    ? "correct the pattern, tag an item with it (`ambit.tags`), or remove the entry"
    : "correct the pattern, add the item to a catalog, or remove the entry";
}

/**
 * The error for a `requires` entry no item satisfies — the successor to the unknown-scope refusals,
 * and now literal: an entry that selects nothing is a mistake, whether it names one item or globs a
 * whole prefix.
 *
 * A qualifier no catalog answers to is called out separately, because it is a different mistake with
 * a different fix, and because it is the one a reader is most likely to have made on purpose: the
 * qualifier is an **alias**, not a pattern, so a wildcard written in that half asks for a catalog
 * literally named `*`, and a message claiming that catalog holds nothing matching the rest of the
 * address would be answering the wrong question.
 *
 * Exported because two surfaces reject an entry — resolution, on the first offender, and validation,
 * on every one of them — and the message must read identically from both.
 *
 * @param where the `(file line N)` suffix, as {@link at} renders it.
 * @param catalogs every catalog the config listed, in config order.
 */
export function unmatchedEntryError(
  entry: PatternEntry,
  where: string,
  catalogs: readonly string[],
): AmbitError {
  const summary = `\`${REQUIRES_KEY}\` entry "${formatEntry(entry)}" matches nothing ${where}`;
  const { catalog } = entry;

  if (catalog !== undefined && !catalogs.includes(catalog)) {
    return resolutionError(summary, [
      `no catalog in \`catalogs:\` is named "${catalog}"`,
      ...(catalog.includes("*")
        ? ["a qualifier is an alias, not a pattern: `*` is matched literally there"]
        : []),
      catalogs.length === 0
        ? "this project configures no catalogs at all"
        : `configured catalogs: ${catalogs.join(", ")}`,
      "correct the qualifier, or add the catalog to `catalogs:`",
    ]);
  }

  const field = entry.field === "tag" ? "declares a tag matching" : "has a name matching";
  return resolutionError(summary, [
    `no ${capabilityNouns(entry)} in ${withinCatalog(entry)} ${field} "${entry.pattern}"`,
    unmatchedAdvice(entry),
  ]);
}

/**
 * Rejects a `requires` entry that selects nothing.
 *
 * A typo has to fail loudly, because the alternative is worse than an error: an entry that matches
 * nothing yields a bundle quietly missing everything it was meant to bring. This is the only
 * surface left that can catch one at all — with nothing registering a tag, the same typo made
 * *inside* a catalog is simply a new tag, and no check anywhere says a word about it.
 *
 * Stops at the first offender, in entry order — sorted on {@link formatEntry}, so which of several
 * bad entries is reported depends on what they say rather than on the order the config happens to
 * list them in. Listing every problem at once is validation's job, which reuses the same error
 * builder so the two agree.
 *
 * @throws {AmbitError} exit 3, naming the entry and the config line it was written on.
 */
export function assertEntriesMatch(config: ProjectConfig, merged: MergedCatalog): void {
  const entries = [...config.requires].sort((a, b) => compare(formatEntry(a), formatEntry(b)));

  for (const entry of entries) {
    if (matchesAnything(entry, merged)) continue;
    throw unmatchedEntryError(entry, entryPosition(config, entry), merged.catalogs);
  }
}

/**
 * Where an entry was written, as {@link at} renders it — the file alone if the parse gave no line.
 *
 * `ConfigOrigin.entryLines` is keyed by {@link entryYaml}, the entry rendered whole: two entries can
 * share a field and an address, differ only in what they select, and sit on two separate lines.
 * Exported so validation positions an entry exactly as resolution does.
 */
export function entryPosition(config: ProjectConfig, entry: PatternEntry): string {
  return at(config.origin.file, config.origin.entryLines.get(entryYaml(entry)));
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
 * skill requires joins the selection — whether or not the project's own entries would ever have
 * selected it.
 *
 * That is the point of the mechanism. A skill that is useless without a company-context skill and
 * a server declares so once, and every project that reaches it gets a working bundle instead of a
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
 * @param skills the roots — what the project's entries selected, in the merged catalog's order.
 * @param mcps MCP entities the project's entries already selected.
 * @param hooks hooks the project's entries already selected.
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
 * The error for one name two selected catalogs both provide.
 *
 * A harness's layout is flat and not ambit's to change — Claude reads `.claude/skills/<name>` — so
 * both copies want one path and there is no way to install both. Dropping one is refused rather than
 * chosen: nothing is left to prefer either with, since no catalog outranks another, and a bundle
 * quietly missing a copy the selection asked for is the failure nobody can debug.
 *
 * The remedy is to narrow a pattern or drop an entry, which is exactly what the addressing scheme
 * makes possible: an entry qualified with one catalog cannot reach the other's copy at all.
 *
 * @param catalogs every catalog providing the name, in catalog order.
 */
function collisionError(kind: ItemKind, name: string, catalogs: readonly string[]): AmbitError {
  return resolutionError(`${KIND_LABELS[kind]} "${name}" is selected from more than one catalog`, [
    `provided by: ${catalogs.join(", ")}`,
    "a harness reads one entry per name, so both copies would be installed at the same path",
    `select only one copy: narrow a \`${REQUIRES_KEY}\` pattern, or drop the entry that reaches the other catalog`,
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

/** How a reason reads in `--explain`, in the lock, and in `ambit why`. */
export function formatReason(reason: SelectionReason): string {
  switch (reason.kind) {
    case "selected":
      // The entry as written, minus the capability list: the item's own namespace is already known
      // from the section this is printed in, and the field cannot be dropped for the reason the
      // grammar declares it at all.
      return formatEntry(reason.entry);
    case "required-by":
      return `required-by:${reason.requirer}`;
  }
}

/**
 * The error for a bundle that cannot account for one of its own items.
 *
 * Exit 1 rather than 3: no catalog and no config can produce this, since every item in a bundle
 * arrived through one of the two routes by construction. Reaching it means the selection and the
 * explanation of it disagree, which is a bug and worth saying so.
 */
function unexplainable(item: BundleItem, problem: string): AmbitError {
  return new AmbitError(ExitCode.Internal, `cannot explain ${item.kind} "${item.name}"`, [
    problem,
    "this is a bug in ambit; please report it",
  ]);
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
 * An entry beats a `requires` edge, because the entry ends a chain where the edge continues one:
 * preferring it keeps an explanation as short as it can be while staying true, and a project that
 * asked for something itself wants to hear which of its own entries did it.
 *
 * @param entries the project's `requires` list.
 * @param selected the selected skills, which is what a `requires` edge can come from.
 * @throws {AmbitError} exit 1 for an item neither route accounts for.
 */
function selectionReasons(
  items: readonly {
    readonly catalog: string;
    readonly name: string;
    readonly tags: readonly string[];
  }[],
  kind: ItemKind,
  entries: readonly PatternEntry[],
  selected: readonly MergedSkill[],
): ReadonlyMap<string, SelectionReason> {
  const reasons = new Map<string, SelectionReason>();

  for (const item of items) {
    const target: BundleItem = { kind, name: item.name };
    const entry = selectingEntry(entries, kind, item);
    const reason: SelectionReason | undefined =
      entry === undefined ? requiredByReason(target, selected) : { kind: "selected", entry };

    if (reason === undefined) {
      throw unexplainable(
        target,
        `it is in the bundle, but no \`${REQUIRES_KEY}\` entry and no \`${REQUIRES_KEY}\` edge selected it`,
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
 * level up, and it is the `requires` entry at the end of the walk that a reader can act on. So the
 * walk follows `required-by` edges backwards until it reaches a root — an entry of the project's own
 * — which terminates because `requires` cycles were rejected during closure.
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
 * `expects` is unioned over the closed selection, not the entry-selected one: a server pulled in by
 * `requires` needs its credentials as much as one an entry named. A hook's `expects` joins it too —
 * a hook that cannot see its credential is as broken as a server that cannot.
 *
 * Reasons are computed here rather than on request, so `--explain`, `ambit why`, and the lock all
 * report the same answer, and so a bundle that cannot account for an item fails at resolution
 * instead of at whichever surface happens to ask first.
 *
 * @param merged every configured catalog, which is where every definition is: a project that ships
 *   items of its own lists itself as a catalog, so all three namespaces arrive here the same way.
 * @throws {AmbitError} exit 3 for a `requires` entry that matches nothing, a requirement no catalog
 *   provides, a `requires` cycle, or one name selected from two catalogs.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  // First, and before anything is selected, so an install cannot half-run on a config that asked for
  // something no catalog has.
  assertEntriesMatch(config, merged);
  const entries = config.requires;

  // All three seed lists stay in the merged catalog's order, being filters of it, so how something
  // was selected cannot change where it lands in the bundle. All three consult the same list, because
  // one entry can name several namespaces at once — which is what makes selection by tag inherently
  // multi-namespace rather than three entries saying one thing.
  //
  // Selection is per copy, not per name: an entry reaching two catalogs' copies of one name selects
  // both, which is what makes the collision the project's to resolve rather than ambit's.
  const selection = closeOverRequires(
    merged.skills.filter((skill) => selectingEntry(entries, "skill", skill) !== undefined),
    merged.mcps.filter((mcp) => selectingEntry(entries, "mcp", mcp) !== undefined),
    merged.hooks.filter((hook) => selectingEntry(entries, "hook", hook) !== undefined),
    merged,
  );

  // Before the bundle exists, and before any map below keys on a bare name: this is the check that
  // makes a name an identity from here on, so nothing downstream can quietly drop a copy instead.
  assertNoCollisions(selection);
  const { skills, mcps, hooks } = selection;

  return {
    skills,
    mcps,
    hooks,
    expects: unionExpectations([
      ...skills.map((skill) => skill.expects),
      ...mcps.map((mcp) => mcp.expects),
      ...hooks.map((hook) => hook.expects),
    ]),
    reasons: {
      skills: selectionReasons(skills, "skill", entries, skills),
      mcps: selectionReasons(mcps, "mcp", entries, skills),
      hooks: selectionReasons(hooks, "hook", entries, skills),
    },
  };
}

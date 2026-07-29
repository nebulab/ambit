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
 * - **A pattern matching nothing is exit 3** ({@link assertEntriesMatch} for a project's entries,
 *   {@link closeOverRequires} for a skill's own). A typo'd or stale entry that quietly selected
 *   nothing would leave a bundle missing exactly what the config went out of its way to ask for, and
 *   nobody would notice until the agent behaved oddly weeks later. One finding at both altitudes:
 *   {@link unmatchedEntryError}.
 * - **An address is qualified in a project, and bare in a catalog.** Every project entry names the
 *   catalog it selects from, so which copy of a name is being asked for never depends on the order
 *   `catalogs:` happens to list them in; a catalog's own entry cannot name one, so it resolves within
 *   that catalog and a catalog can only require what it ships. A tag entry still reaches whatever the
 *   author labelled, so a new skill tagged for engineers arrives with no consumer edit — the author's
 *   push survives, without a registry.
 * - **A reason is the entry.** Every selected item carries either the entry that selected it or the
 *   skill that required it, and nothing else: two cases, so a reader gets an answer rather than a
 *   list of possibilities. The lock records the reason too, so it has to be part of resolution
 *   rather than a reporting afterthought.
 *
 * Everything selected is then closed over `requires` — a skill's own, written in the same entry
 * grammar minus the qualifier — so a skill can carry its dependencies into a bundle that would never
 * have selected them. One grammar at both altitudes, so a skill can say *everything tagged `guards`,
 * as hooks* as readily as a project can, and a catalog's entry resolves within its own catalog.
 *
 * Two catalogs may provide one name, and the merged catalog holds both copies — a bundle holds at
 * most one. A selection that reached both is refused, because harness layout is flat and externally
 * imposed and the two copies would materialize to one path; see {@link assertNoCollisions}. That
 * refusal is what makes a bare name an identity within a bundle, so every map here keys on one, while
 * everything reading the merged catalog keys on `<catalog>/<name>`.
 */
import type { MergedCatalog, MergedHook, MergedMcp, MergedSkill } from "../model/catalog.js";
import { SKILL_FILENAME, qualifiedName } from "../model/catalog.js";
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
  uniqueEntries,
} from "../model/pattern.js";
import type { Reference } from "../model/reference.js";
import type { ItemKind } from "../model/requirement.js";
import { ITEM_KINDS } from "../model/requirement.js";
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
 * Bare rather than carrying one, because an article reads wrong where a name follows immediately —
 * *a skill "house-style"* — and this is the sentence shape every message here has.
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

/** The concrete next step for an entry that matched nothing, in the terms of the field it matches. */
function unmatchedAdvice(entry: PatternEntry): string {
  return entry.field === "tag"
    ? "correct the pattern, tag an item with it (`ambit.tags`), or remove the entry"
    : "correct the pattern, add the item to a catalog, or remove the entry";
}

/**
 * The error for a `requires` entry no item satisfies — **one finding at both altitudes** a `requires`
 * list is written at.
 *
 * A project's entry and a skill's own are the same grammar asking the same question, so an entry that
 * selects nothing is one mistake with one message, whether it names one item or globs a whole prefix,
 * and whether it was written in `ambit.yml` or in a `SKILL.md`. There is nothing left of the old
 * *unresolvable requirement* to keep separate: a requirement no longer names a name that either is or
 * is not there, it is a pattern, and a pattern that matched nothing is this.
 *
 * A qualifier no catalog answers to is called out separately, because it is a different mistake with
 * a different fix, and because it is the one a reader is most likely to have made on purpose: the
 * qualifier is an **alias**, not a pattern, so a wildcard written in that half asks for a catalog
 * literally named `*`, and a message claiming that catalog holds nothing matching the rest of the
 * address would be answering the wrong question.
 *
 * Exported because three surfaces reject an entry — the project check and the closure, each on the
 * first offender, and validation on every one of them — and the message must read identically from
 * all of them.
 *
 * @param within the catalog the entry resolves in. A project's entry names it, qualification being
 *   mandatory there ({@link entryCatalog}); a skill's own cannot, so it is the catalog that holds the
 *   requiring skill and only the caller knows which that is. Either way it is exactly *one* catalog:
 *   "whichever one happens to hold a match" is the config-order dependence this addressing removed.
 * @param where the `(file line N)` suffix, as {@link at} renders it.
 * @param catalogs every catalog the config listed, in config order.
 */
export function unmatchedEntryError(
  entry: PatternEntry,
  within: string,
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
    `no ${capabilityNouns(entry)} in catalog "${within}" ${field} "${entry.pattern}"`,
    // An entry carrying no qualifier is a catalog's own, by construction of the two spellings — so
    // this is the one line the project altitude never prints, and the one the catalog altitude needs:
    // another catalog holding a match is not an answer, however plainly it holds one.
    ...(catalog === undefined
      ? [
          `a catalog's own \`${REQUIRES_KEY}\` resolves within that catalog, which can only require what it ships`,
        ]
      : []),
    unmatchedAdvice(entry),
  ]);
}

/**
 * The catalog a project's `requires` entry selects from.
 *
 * Non-optional, unlike {@link PatternEntry.catalog}: a project config is parsed as `"qualified"`, so
 * an entry that named no alias was refused at parse and cannot reach here. The assertion records that
 * rather than inventing a fallback whose message could never be true — an unqualified project entry
 * does not mean *any catalog*, it means a config that did not load.
 *
 * Exported so validation and resolution name the same catalog in the same words.
 */
export function entryCatalog(entry: PatternEntry): string {
  return entry.catalog!;
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
    throw unmatchedEntryError(
      entry,
      entryCatalog(entry),
      entryPosition(config, entry),
      merged.catalogs,
    );
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

/**
 * Where a skill's `requires` entry was written, as {@link at} renders it.
 *
 * The file, and no line. A catalog's annotations are parsed long before an entry is judged and nothing
 * keeps the line one sat on — unlike a project's, which `ConfigOrigin` records because a config is the
 * document a reader has open. The file is enough to act on: a `requires` list is a handful of lines
 * under one key, and the entry is quoted in the message.
 *
 * Exported so validation positions a catalog's entry exactly as the closure does.
 */
export function requirerPosition(skill: MergedSkill): string {
  return at(skillFile(skill), undefined);
}

/**
 * A skill's `requires` list, deduplicated and in an order of its own.
 *
 * Deduplication is literal ({@link uniqueEntries}) and exact only: `tag: x` over `[skills, mcps]`
 * does not absorb `tag: x` over `[skills]`, even though everything the second selects the first
 * selects too. Selection is a union either way, so a redundant entry costs nothing; what the dedupe
 * buys is that a list saying one thing twice raises one problem rather than two.
 *
 * Ordered by {@link entryYaml} rather than kept as the author wrote it, so which of several problems
 * in one list is reported does not depend on the order they happened to write them in. `entryYaml`
 * and not {@link formatEntry}, because the latter drops the capability list and two entries that
 * differ only there would tie.
 *
 * Exported so validation walks a skill's list exactly as the closure does.
 */
export function requiredEntries(skill: MergedSkill): readonly PatternEntry[] {
  return [...uniqueEntries(skill.requires)].sort((a, b) => compare(entryYaml(a), entryYaml(b)));
}

/**
 * Every item one of a skill's `requires` entries selects: matched against the catalog that skill came
 * from, and against nothing else.
 *
 * **A catalog is self-contained.** An entry written inside one resolves within it, so `core.*` in
 * `company`'s `skills/x/SKILL.md` reaches `company`'s items and no other catalog's. That is a
 * deliberate tightening: this walk used to look a required *name* up in the merged catalog, so a
 * catalog's `requires` could reach a sibling catalog's skill — which worked by accident, depended on
 * which catalogs a given project happened to list and in what order, and let a catalog claim a
 * dependency it does not ship. A catalog author cannot write a consumer's alias, so the only honest
 * reading of a bare pattern inside a catalog is *my own catalog*.
 *
 * The locality is enforced here and not by {@link matches}, which skips its catalog test for an entry
 * carrying no qualifier: an unqualified entry does not know which catalog it was written in, so the
 * rule can only live with whoever offers it items.
 *
 * In the merged catalog's order, being a filter of it, so nothing downstream depends on the order a
 * walk discovered things in.
 *
 * Exported so validation follows a skill's edges exactly as the closure does — its cycle hunt walks
 * every skill in the catalog rather than only the selected ones, and must not disagree about where an
 * edge goes.
 */
export function requiredItems(
  entry: PatternEntry,
  requirer: MergedSkill,
  merged: MergedCatalog,
): Selection {
  const own = (catalog: string): boolean => catalog === requirer.catalog;

  return {
    skills: merged.skills.filter(
      (skill) => own(skill.catalog) && matches(entry, patternItem("skill", skill)),
    ),
    mcps: merged.mcps.filter((mcp) => own(mcp.catalog) && matches(entry, patternItem("mcp", mcp))),
    hooks: merged.hooks.filter(
      (hook) => own(hook.catalog) && matches(entry, patternItem("hook", hook)),
    ),
  };
}

/** Whether a selection holds nothing at all, in any namespace. */
function isEmpty(selection: Selection): boolean {
  return (
    selection.skills.length === 0 && selection.mcps.length === 0 && selection.hooks.length === 0
  );
}

/**
 * Whether a skill's `requires` entry selects anything the skill's own catalog ships.
 *
 * The catalog-side counterpart of {@link matchesAnything}, and the same judgement: an entry that
 * selects nothing is a mistake. Exported because validation asks it of every entry in a catalog while
 * the closure asks it of the ones a selected skill declares.
 */
export function matchesOwnCatalog(
  entry: PatternEntry,
  requirer: MergedSkill,
  merged: MergedCatalog,
): boolean {
  return !isEmpty(requiredItems(entry, requirer, merged));
}

/**
 * The error for a `requires` cycle: the whole path, and the edge that closed it.
 *
 * The path is what makes a loop visible at all — which member of it is *the* problem is a choice, and
 * printing one name would make that choice ambit's rather than the reader's. What a path of names
 * cannot say is where to go and edit, so one line names the entry that closed the loop and the file it
 * is written in.
 *
 * Only that edge. An entry is a field, a pattern and a capability list, and a path annotated with one
 * per step is unreadable; the closing edge is the actionable half, because removing it removes the
 * loop. It matters more now than it did when a requirement named a name: a pattern can close a loop
 * without naming anything in it — a skill matching its own `core.*` is a one-step cycle — and the only
 * way to see that is to be shown the entry.
 *
 * @param cycle the skill names around the loop, opening and closing on the same name.
 * @param requirer the skill whose `requires` closed the loop, and whose file holds the entry.
 * @param entry that entry.
 */
export function cycleError(
  cycle: readonly string[],
  requirer: MergedSkill,
  entry: PatternEntry,
): AmbitError {
  return resolutionError("requirement cycle", [
    cycle.join(" → "),
    `closed by \`${formatEntry(entry)}\` in ${skillFile(requirer)}`,
    `break the cycle by removing one \`${REQUIRES_KEY}\` entry`,
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
 * **The closure is set-valued.** A skill's `requires` entry is the project's entry minus the
 * qualifier — it may glob, and it may match on `tag` — so one entry answers with a *set* of items
 * rather than with the single name a `<kind>:<name>` reference used to look up. There is no map to
 * `get` from, and so no *missing* to report: there is an entry that matched nothing, which is exactly
 * the finding the project altitude raises about its own entries ({@link unmatchedEntryError}). What
 * that buys is that everything a project can say about a catalog, a skill inside one can say too, in
 * the same words — *everything tagged `guards`, as hooks* is one entry at either altitude.
 *
 * Only skills carry `requires` (neither MCP entities nor hooks have such a key), so the graph walked
 * here is skill → skill, with both other namespaces as leaves.
 *
 * Each entry resolves within the requiring skill's own catalog — see {@link requiredItems} for why,
 * and for what that tightens.
 *
 * **Accepted cost, deliberately.** A wildcard `requires` means a catalog author adding a skill
 * changes what an unrelated skill pulls in: add `skills/core/internal-notes`, and every skill
 * requiring `name: core.*` grows a dependency, at install, with no message anywhere. It is the same
 * class of hazard as the collision {@link assertNoCollisions} refuses, and it is silent where that one
 * is loud. It is recorded rather than fixed, because the only fixes are worse — forbidding wildcards
 * inside a catalog would leave a catalog less expressive than the project consuming it, and a
 * per-item acknowledgement is a registry by another name.
 *
 * One consequence of that expressiveness is worth stating outright: a pattern matches the requiring
 * skill itself if it can, and a skill that requires itself is a one-step cycle. So `core.a` cannot
 * require `name: core.*`. That is not special-cased — the cycle refusal survives this change, and
 * exempting the requirer would be inventing a rule the addressing scheme does not have — and it is why
 * {@link cycleError} names the entry that closed the loop.
 *
 * @param skills the roots — what the project's entries selected, in the merged catalog's order.
 * @param mcps MCP entities the project's entries already selected.
 * @param hooks hooks the project's entries already selected.
 * @param merged what requirements resolve against, one catalog of it at a time.
 * @throws {AmbitError} exit 3 for a `requires` entry that matches nothing in its own catalog, or a
 *   cycle.
 */
export function closeOverRequires(
  skills: readonly MergedSkill[],
  mcps: readonly MergedMcp[],
  hooks: readonly MergedHook[],
  merged: MergedCatalog,
): Selection {
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

    path.push(skill);
    chosenSkills.add(address);

    for (const entry of requiredEntries(skill)) {
      const required = requiredItems(entry, skill, merged);
      if (isEmpty(required)) {
        throw unmatchedEntryError(entry, skill.catalog, requirerPosition(skill), merged.catalogs);
      }

      // Both leaf namespaces end the walk: nothing an entity or a hook declares reaches anything
      // else, so joining the selection is all there is to do.
      for (const mcp of required.mcps) chosenMcps.add(qualifiedName(mcp));
      for (const hook of required.hooks) chosenHooks.add(qualifiedName(hook));

      for (const next of required.skills) {
        // Checked at the call site rather than on entry to `follow`, because this is the only place
        // that knows which entry the edge came from — and the cycle error names it.
        //
        // The printed path is names, which is what an author reads in a `requires` list; the walk's
        // own bookkeeping is addresses, so two catalogs' copies of one name are two nodes rather than
        // a cycle between them.
        const opened = path.findIndex((seen) => qualifiedName(seen) === qualifiedName(next));
        if (opened !== -1) {
          throw cycleError(
            [...path.slice(opened), next].map((seen) => seen.name),
            skill,
            entry,
          );
        }
        follow(next);
      }
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
 * The `required-by` reason for an item: the first selected skill whose `requires` matches it.
 *
 * The test is {@link matches} rather than an equality — a `requires` entry is a pattern, and the
 * question *did this skill ask for that item?* is the same question selection asks, one altitude down.
 * Only a skill from the item's own catalog can be the answer, because that is as far as a catalog's
 * `requires` reaches.
 *
 * Recovered from the closure's result rather than recorded during its walk, so which requirer is
 * named depends only on the names — `selected` arrives in name order, then catalog — and not on the
 * order the depth-first walk happened to reach the item. Several skills requiring one thing is normal,
 * and any of them is a true answer, so a tie-break only has to be a function of the inputs.
 */
function requiredByReason(
  item: PatternItem,
  selected: readonly MergedSkill[],
): SelectionReason | undefined {
  const requirer = selected.find(
    (skill) =>
      skill.catalog === item.catalog && skill.requires.some((entry) => matches(entry, item)),
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
      entry === undefined
        ? requiredByReason(patternItem(kind, item), selected)
        : { kind: "selected", entry };

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

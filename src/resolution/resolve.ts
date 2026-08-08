/**
 * Resolution — the project's `requires` list and the merged catalog in, the bundle out.
 *
 * Pure and synchronous: everything that touches disk or the network has already happened by the
 * time this runs. That is what makes determinism testable — the same inputs produce a
 * byte-identical bundle, so `resolve --json` can be committed as a golden file.
 *
 * **One addressing scheme.** A project writes `requires` entries, each one key naming a namespace
 * and carrying a glob to match names in it. An exact name is a pattern with no wildcard, so naming
 * one skill and taking a whole prefix are the same operator rather than two routes with two
 * spellings and two error classes. The grammar and the matcher live in `model/pattern.ts`; what
 * lives here is what a match *means*.
 *
 * Three things follow, and all three are the point:
 *
 * - **A pattern matching nothing is exit 3** ({@link assertEntriesMatch} for a project's entries,
 *   {@link closeOverRequires} for a catalog's own). A typo'd or stale entry that quietly selected
 *   nothing would leave a bundle missing exactly what the config went out of its way to ask for, and
 *   nobody would notice until the agent behaved oddly weeks later. One finding at both altitudes:
 *   {@link unmatchedEntryError}.
 * - **An address is qualified in a project, and bare in a catalog.** Every project entry names the
 *   catalog it selects from, so which copy of a name is being asked for never depends on the order
 *   `catalogs:` happens to list them in; a catalog's own entry cannot name one, so it resolves within
 *   that catalog and a catalog can only require what it ships.
 * - **A reason is the entry.** Every selected item carries either the entry that selected it or the
 *   requirer that pulled it in, and nothing else: two cases, so a reader gets an answer rather than a
 *   list of possibilities. The lock records the reason too, so it has to be part of resolution
 *   rather than a reporting afterthought.
 *
 * **Two kinds of item carry `requires`, and the closure follows both.** A **pack** exists for nothing
 * else: it is a document whose whole content is what asking for it gets you, which is how a catalog
 * offers *everything an engineer needs* as one browsable, describable name. A **skill** carries one
 * for a narrower reason — it declares what it cannot work without, so a project that reaches it gets
 * a working bundle rather than a plausible-looking broken one. Servers and hooks are leaves. See
 * {@link Requirer}, which is what the walk is actually over.
 *
 * Two catalogs may provide one name, and the merged catalog holds both copies — a bundle holds at
 * most one. A selection that reached both is refused, because harness layout is flat and externally
 * imposed and the two copies would materialize to one path; see {@link assertNoCollisions}. That
 * refusal is what makes a bare name an identity within a bundle, so every map here keys on one, while
 * everything reading the merged catalog keys on `<catalog>/<name>`.
 */
import type {
  MergedCatalog,
  MergedHook,
  MergedMcp,
  MergedPack,
  MergedSkill,
} from "../model/catalog.js";
import { SKILL_FILENAME, qualifiedName } from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import type { ExpectationSet } from "../model/expectation.js";
import { unionExpectations } from "../model/expectation.js";
import type { PatternEntry, PatternItem } from "../model/pattern.js";
import { REQUIRES_KEY, entryYaml, formatEntry, matches, uniqueEntries } from "../model/pattern.js";
import type { Reference } from "../model/reference.js";
import type { ItemKind } from "../model/requirement.js";
import { KIND_SEPARATOR } from "../model/requirement.js";
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
  readonly packs: readonly MergedPack[];
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
  readonly hooks: readonly MergedHook[];
}

export type { ItemKind };

/**
 * One item of a bundle: which namespace, and the name inside it.
 *
 * A {@link Reference} over the item kinds, and not the same type a `requires` entry parses to. A
 * pattern entry is a question about a catalog, answered by zero or more items; a bundle item is one
 * item of one namespace. Sharing a type would let a selection name something no bundle item could be.
 */
export type BundleItem = Reference<ItemKind>;

/** How a bundle item is written where only a string will do — `pack:engineering`. */
export function formatItem(item: BundleItem): string {
  return `${item.kind}${KIND_SEPARATOR}${item.name}`;
}

/**
 * An item that carries a `requires` list, as the closure and the cycle hunt see one.
 *
 * A structural shape over the two kinds that have one, rather than a union of the two merged types,
 * because everything below asks the same four questions of both: which namespace, whose catalog,
 * what name, and what does it require. The fifth — which document to send a reader to — is the only
 * place the two genuinely differ, and it is settled once, in {@link requirersOf}.
 *
 * A pack and a skill can share a name, so {@link kind} is part of a requirer's identity and not
 * decoration: `pack:core` and `skill:core` are two nodes of the graph, and a cycle through one is
 * not a cycle through the other.
 */
export interface Requirer {
  /** Which namespace it is in: the two that can require anything. */
  readonly kind: "pack" | "skill";
  readonly catalog: string;
  readonly name: string;
  readonly requires: readonly PatternEntry[];
  /**
   * The document its `requires` is written in, catalog-relative, so a refusal can name a file.
   *
   * A pack is its own document; a skill's annotations live in its `SKILL.md`. That difference is the
   * whole of why this field exists rather than being derived at each call site.
   */
  readonly file: string;
}

/**
 * Every item in the merged catalog that carries a `requires` list, packs first.
 *
 * Packs first because a pack is the more useful answer to *what pulled this in*: it is a name a
 * project wrote on purpose, where a skill's own requirement is an implementation detail of that
 * skill. The order is otherwise the merged catalog's — name, then catalog — so everything downstream
 * that picks "the first requirer that matches" picks a function of the names alone.
 */
export function requirersOf(merged: MergedCatalog): readonly Requirer[] {
  return [
    ...merged.packs.map((pack): Requirer => ({
      kind: "pack",
      catalog: pack.catalog,
      name: pack.name,
      requires: pack.requires,
      file: pack.file,
    })),
    ...merged.skills.map((skill): Requirer => ({
      kind: "skill",
      catalog: skill.catalog,
      name: skill.name,
      requires: skill.requires,
      file: `${skill.path}/${SKILL_FILENAME}`,
    })),
  ];
}

/**
 * Why one item is in the bundle — one of the two routes resolution offers, and never both, so a
 * reader gets an answer rather than a list of possibilities.
 *
 * A `selected` reason carries the entry itself rather than a rendering of it, so a caller can print
 * it whole ({@link formatEntry}) and nothing has to re-derive anything from a string.
 *
 * A `required-by` reason names the requirer's **namespace** as well as its name, because both kinds
 * that can require anything are addressable and a pack may share a name with a skill: `required-by:
 * pack:engineering` is an answer, `required-by:engineering` is a second question.
 */
export type SelectionReason =
  | { readonly kind: "selected"; readonly entry: PatternEntry }
  | { readonly kind: "required-by"; readonly requirer: BundleItem };

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
  readonly packs: ReadonlyMap<string, SelectionReason>;
  readonly skills: ReadonlyMap<string, SelectionReason>;
  readonly mcps: ReadonlyMap<string, SelectionReason>;
  readonly hooks: ReadonlyMap<string, SelectionReason>;
}

/**
 * The resolved set of packs, skills, MCP servers and hooks for a project.
 *
 * One item per name within each namespace, which is what everything downstream — `install`, the
 * lock, `status`, `doctor`, `why` — relies on when it keys on a bare name. The guarantee comes from
 * {@link assertNoCollisions} rather than from the merged catalog, which holds every catalog's copy.
 *
 * The packs are here even though **a pack materializes nothing**. Everything else in a bundle lands
 * somewhere a harness reads; a pack lands nowhere, because what it contributes is the other three
 * lists. It is carried anyway, because a bundle that dropped it could not answer *why is this skill
 * installed* with the name the project actually wrote — and a group you cannot see the effect of is
 * the thing packs replaced.
 *
 * The config's own `requires` list is deliberately not echoed back. A bundle is what was selected,
 * and the entries that did the selecting are already in the file the reader has open — one per
 * selected item, in {@link Bundle.reasons}, which is the half they cannot look up.
 */
export interface Bundle {
  /** Selected packs, sorted by name. Materialized nowhere — see above. */
  readonly packs: readonly MergedPack[];
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
   *
   * Packs contribute nothing: a pack reads nothing from the world, and the items it names carry
   * their own.
   */
  readonly expects: ExpectationSet;
  /** Why each of the above is here, one entry per selected item. */
  readonly reasons: SelectionReasons;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One item of one namespace, in the shape the matcher takes. */
function patternItem(
  kind: ItemKind,
  item: { readonly catalog: string; readonly name: string },
): PatternItem {
  return { kind, catalog: item.catalog, name: item.name };
}

/**
 * The entry that selected an item, or undefined when none did.
 *
 * Several entries may reach one item — a wildcard and the exact name under it — and any of them is a
 * true answer, so the tie-break only has to be a function of the entries themselves. It sorts on
 * {@link formatEntry}, which is what the reason prints: two entries that tie there say the same
 * words, so which one is chosen cannot be observed.
 */
export function selectingEntry(
  entries: readonly PatternEntry[],
  kind: ItemKind,
  item: { readonly catalog: string; readonly name: string },
): PatternEntry | undefined {
  const subject = patternItem(kind, item);
  return entries
    .filter((entry) => matches(entry, subject))
    .sort((a, b) => compare(formatEntry(a), formatEntry(b)))[0];
}

/** Whether any item in any configured catalog is selected by `entry`. */
export function matchesAnything(entry: PatternEntry, merged: MergedCatalog): boolean {
  return (
    merged.packs.some((pack) => matches(entry, patternItem("pack", pack))) ||
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
  pack: "pack",
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
};

/**
 * The error for a `requires` entry no item satisfies — **one finding at both altitudes** a `requires`
 * list is written at.
 *
 * A project's entry and a catalog's own are the same grammar asking the same question, so an entry
 * that selects nothing is one mistake with one message, whether it names one item or globs a whole
 * prefix, and whether it was written in `ambit.yml`, in a pack, or in a `SKILL.md`.
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
 *   mandatory there ({@link entryCatalog}); a catalog's own cannot, so it is the catalog that holds
 *   the requirer and only the caller knows which that is. Either way it is exactly *one* catalog:
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

  return resolutionError(summary, [
    `no ${KIND_LABELS[entry.kind]} in catalog "${within}" has a name matching "${entry.pattern}"`,
    // An entry carrying no qualifier is a catalog's own, by construction of the two spellings — so
    // this is the one line the project altitude never prints, and the one the catalog altitude needs:
    // another catalog holding a match is not an answer, however plainly it holds one.
    ...(catalog === undefined
      ? [
          `a catalog's own \`${REQUIRES_KEY}\` resolves within that catalog, which can only require what it ships`,
        ]
      : []),
    "correct the pattern, add the item to a catalog, or remove the entry",
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
 * nothing yields a bundle quietly missing everything it was meant to bring.
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
 * `ConfigOrigin.entryLines` is keyed by {@link entryYaml}, the entry rendered whole. Exported so
 * validation positions an entry exactly as resolution does.
 */
export function entryPosition(config: ProjectConfig, entry: PatternEntry): string {
  return at(config.origin.file, config.origin.entryLines.get(entryYaml(entry)));
}

/**
 * Where a requirer's `requires` entry was written, as {@link at} renders it.
 *
 * The file, and no line. A catalog's documents are parsed long before an entry is judged and nothing
 * keeps the line one sat on — unlike a project's, which `ConfigOrigin` records because a config is the
 * document a reader has open. The file is enough to act on: a `requires` list is a handful of lines
 * under one key, and the entry is quoted in the message.
 *
 * Exported so validation positions a catalog's entry exactly as the closure does.
 */
export function requirerPosition(requirer: Requirer): string {
  return at(requirer.file, undefined);
}

/**
 * A requirer's `requires` list, deduplicated and in an order of its own.
 *
 * Ordered by {@link entryYaml} rather than kept as the author wrote it, so which of several problems
 * in one list is reported does not depend on the order they happened to write them in.
 *
 * Exported so validation walks a list exactly as the closure does.
 */
export function requiredEntries(requirer: Requirer): readonly PatternEntry[] {
  return [...uniqueEntries(requirer.requires)].sort((a, b) => compare(entryYaml(a), entryYaml(b)));
}

/**
 * Every item one of a requirer's `requires` entries selects: matched against the catalog that
 * requirer came from, and against nothing else.
 *
 * **A catalog is self-contained.** An entry written inside one resolves within it, so `core.*` in
 * `company`'s `packs/engineering.yml` reaches `company`'s items and no other catalog's. A catalog
 * author cannot write a consumer's alias, so the only honest reading of a bare pattern inside a
 * catalog is *my own catalog*.
 *
 * The locality is enforced here and not by {@link matches}, which skips its catalog test for an entry
 * carrying no qualifier: an unqualified entry does not know which catalog it was written in, so the
 * rule can only live with whoever offers it items.
 *
 * In the merged catalog's order, being a filter of it, so nothing downstream depends on the order a
 * walk discovered things in.
 *
 * Exported so validation follows an edge exactly as the closure does — its cycle hunt walks every
 * requirer in the catalog rather than only the selected ones, and must not disagree about where an
 * edge goes.
 */
export function requiredItems(
  entry: PatternEntry,
  requirer: Requirer,
  merged: MergedCatalog,
): Selection {
  const own = (catalog: string): boolean => catalog === requirer.catalog;

  return {
    packs: merged.packs.filter(
      (pack) => own(pack.catalog) && matches(entry, patternItem("pack", pack)),
    ),
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
    selection.packs.length === 0 &&
    selection.skills.length === 0 &&
    selection.mcps.length === 0 &&
    selection.hooks.length === 0
  );
}

/**
 * Whether a requirer's `requires` entry selects anything its own catalog ships.
 *
 * The catalog-side counterpart of {@link matchesAnything}, and the same judgement: an entry that
 * selects nothing is a mistake. Exported because validation asks it of every entry in a catalog while
 * the closure asks it of the ones a selected requirer declares.
 */
export function matchesOwnCatalog(
  entry: PatternEntry,
  requirer: Requirer,
  merged: MergedCatalog,
): boolean {
  return !isEmpty(requiredItems(entry, requirer, merged));
}

/**
 * The error for a `requires` cycle: the whole path, and the edge that closed it.
 *
 * The path is what makes a loop visible at all — which member of it is *the* problem is a choice, and
 * printing one name would make that choice ambit's rather than the reader's. What a path cannot say
 * is where to go and edit, so one line names the entry that closed the loop and the file it is
 * written in.
 *
 * Members are printed as `<kind>:<name>`, not as bare names: a pack and a skill may share a name, and
 * a loop between the two of them printed as `core → core` would read as a single self-requiring item.
 *
 * Only the closing edge is annotated. An entry is a namespace and a pattern, and a path annotated
 * with one per step is unreadable; the closing edge is the actionable half, because removing it
 * removes the loop. It matters more than it did when a requirement named a name: a pattern can close
 * a loop without naming anything in it — a skill matching its own `core.*` is a one-step cycle — and
 * the only way to see that is to be shown the entry.
 *
 * @param cycle the items around the loop, opening and closing on the same one.
 * @param requirer whose `requires` closed the loop, and whose file holds the entry.
 * @param entry that entry.
 */
export function cycleError(
  cycle: readonly BundleItem[],
  requirer: Requirer,
  entry: PatternEntry,
): AmbitError {
  return resolutionError("requirement cycle", [
    cycle.map(formatItem).join(" → "),
    `closed by \`${formatEntry(entry)}\` in ${requirer.file}`,
    `break the cycle by removing one \`${REQUIRES_KEY}\` entry`,
  ]);
}

/** The identity of a requirer within the walk: its namespace, its catalog and its name. */
function requirerKey(requirer: Requirer): string {
  return `${requirer.kind}${KIND_SEPARATOR}${qualifiedName(requirer)}`;
}

/**
 * Closes a selection over `requires` until fixpoint: every pack, skill, MCP entity and hook a
 * selected pack or skill requires joins the selection — whether or not the project's own entries
 * would ever have selected it.
 *
 * That is the point of the mechanism, and packs are the case it exists for. A catalog says once what
 * *engineering* means — these skills, that server, those hooks, and the `core` pack besides — and a
 * project takes the whole of it by writing one entry. A skill's own `requires` is the narrower case:
 * a skill that is useless without a company-context skill and a server declares so, and every project
 * that reaches it gets a working bundle instead of a plausible-looking broken one. A hook comes down
 * the same route for the same reason.
 *
 * **The closure is set-valued.** A requirer's entry is the project's entry minus the qualifier — it
 * may glob — so one entry answers with a *set* of items rather than with a single name. There is no
 * map to `get` from, and so no *missing* to report: there is an entry that matched nothing, which is
 * exactly the finding the project altitude raises about its own entries
 * ({@link unmatchedEntryError}).
 *
 * Packs and skills are the interior of the graph; servers and hooks are leaves, neither carrying
 * `requires`. Each entry resolves within the requirer's own catalog — see {@link requiredItems}.
 *
 * **Accepted cost, deliberately.** A wildcard `requires` means a catalog author adding an item
 * changes what an unrelated pack pulls in: add `skills/core/internal-notes`, and every requirer
 * naming `skill: core.*` grows a dependency, at install, with no message anywhere. It is the same
 * class of hazard as the collision {@link assertNoCollisions} refuses, and it is silent where that one
 * is loud. It is recorded rather than fixed, because the only fixes are worse — forbidding wildcards
 * inside a catalog would leave a catalog less expressive than the project consuming it.
 *
 * One consequence of that expressiveness is worth stating outright: a pattern matches the requirer
 * itself if it can, and something that requires itself is a one-step cycle. So the skill `core.a`
 * cannot require `skill: core.*`. That is not special-cased — exempting the requirer would be
 * inventing a rule the addressing scheme does not have — and it is why {@link cycleError} names the
 * entry that closed the loop.
 *
 * @param roots what the project's entries selected among the two requiring kinds, in the merged
 *   catalog's order.
 * @param mcps MCP entities the project's entries already selected.
 * @param hooks hooks the project's entries already selected.
 * @param merged what requirements resolve against, one catalog of it at a time.
 * @throws {AmbitError} exit 3 for a `requires` entry that matches nothing in its own catalog, or a
 *   cycle.
 */
export function closeOverRequires(
  roots: readonly Requirer[],
  mcps: readonly MergedMcp[],
  hooks: readonly MergedHook[],
  merged: MergedCatalog,
): Selection {
  // Addresses rather than names throughout: one catalog's copy of a name being selected says nothing
  // about another's, so a set of names would silently treat the two as one item.
  const chosenPacks = new Set<string>();
  const chosenSkills = new Set<string>();
  const chosenMcps = new Set(mcps.map(qualifiedName));
  const chosenHooks = new Set(hooks.map(qualifiedName));

  // The requirers, keyed the way the walk addresses them, so an edge selecting a pack or a skill can
  // find the node to descend into without rebuilding the projection per step.
  const requirers = new Map(
    requirersOf(merged).map((requirer) => [requirerKey(requirer), requirer]),
  );

  // The two colours a depth-first walk needs to tell a cycle from a diamond: `path` is the chain
  // currently being followed, in order, so meeting something already on it yields the cycle
  // itself; `closed` is what has been followed to completion, and revisiting that is just a
  // requirement two requirers share.
  const path: Requirer[] = [];
  const closed = new Set<string>();

  const follow = (requirer: Requirer): void => {
    const key = requirerKey(requirer);
    if (closed.has(key)) return;

    path.push(requirer);
    (requirer.kind === "pack" ? chosenPacks : chosenSkills).add(qualifiedName(requirer));

    for (const entry of requiredEntries(requirer)) {
      const required = requiredItems(entry, requirer, merged);
      if (isEmpty(required)) {
        throw unmatchedEntryError(
          entry,
          requirer.catalog,
          requirerPosition(requirer),
          merged.catalogs,
        );
      }

      // Both leaf namespaces end the walk: nothing an entity or a hook declares reaches anything
      // else, so joining the selection is all there is to do.
      for (const mcp of required.mcps) chosenMcps.add(qualifiedName(mcp));
      for (const hook of required.hooks) chosenHooks.add(qualifiedName(hook));

      const next = [
        ...required.packs.map((pack) =>
          requirers.get(`pack${KIND_SEPARATOR}${qualifiedName(pack)}`),
        ),
        ...required.skills.map((skill) =>
          requirers.get(`skill${KIND_SEPARATOR}${qualifiedName(skill)}`),
        ),
      ].filter((candidate): candidate is Requirer => candidate !== undefined);

      for (const child of next) {
        // Checked at the call site rather than on entry to `follow`, because this is the only place
        // that knows which entry the edge came from — and the cycle error names it.
        const opened = path.findIndex((seen) => requirerKey(seen) === requirerKey(child));
        if (opened !== -1) {
          throw cycleError(
            [...path.slice(opened), child].map((seen) => ({ kind: seen.kind, name: seen.name })),
            requirer,
            entry,
          );
        }
        follow(child);
      }
    }

    path.pop();
    closed.add(key);
  };

  for (const root of roots) follow(root);

  // Filtering the merged lists rather than collecting during the walk keeps the result in the merged
  // catalog's order, whatever order the closure happened to discover things in.
  return {
    packs: merged.packs.filter((pack) => chosenPacks.has(qualifiedName(pack))),
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
 * A pack materializes nowhere and so has no path to collide over, and it is refused all the same: a
 * pack is addressable — `ambit why pack:core` — and two selected packs called `core` would leave that
 * question with two answers. Consistency here is cheaper than one namespace with its own rule.
 *
 * @param catalogs every catalog providing the name, in catalog order.
 */
function collisionError(kind: ItemKind, name: string, catalogs: readonly string[]): AmbitError {
  return resolutionError(`${KIND_LABELS[kind]} "${name}" is selected from more than one catalog`, [
    `provided by: ${catalogs.join(", ")}`,
    kind === "pack"
      ? "a bundle holds one item per name, so there would be two answers to which one is installed"
      : "a harness reads one entry per name, so both copies would be installed at the same path",
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
  assertOnePerName("pack", selection.packs);
  assertOnePerName("skill", selection.skills);
  assertOnePerName("mcp", selection.mcps);
  assertOnePerName("hook", selection.hooks);
}

/** How a reason reads in `--explain`, in the lock, and in `ambit why`. */
export function formatReason(reason: SelectionReason): string {
  switch (reason.kind) {
    case "selected":
      return formatEntry(reason.entry);
    case "required-by":
      return `required-by:${formatItem(reason.requirer)}`;
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
 * The `required-by` reason for an item: the first selected requirer whose `requires` matches it.
 *
 * The test is {@link matches} rather than an equality — a `requires` entry is a pattern, and the
 * question *did this pack ask for that item?* is the same question selection asks, one altitude down.
 * Only a requirer from the item's own catalog can be the answer, because that is as far as a
 * catalog's `requires` reaches.
 *
 * Recovered from the closure's result rather than recorded during its walk, so which requirer is
 * named depends only on the names — packs first, then skills, each in name order — and not on the
 * order the depth-first walk happened to reach the item. Several requirers naming one thing is
 * normal, and any of them is a true answer, so a tie-break only has to be a function of the inputs.
 */
function requiredByReason(
  item: PatternItem,
  selected: readonly Requirer[],
): SelectionReason | undefined {
  const requirer = selected.find(
    (candidate) =>
      candidate.catalog === item.catalog &&
      candidate.requires.some((entry) => matches(entry, item)),
  );
  return requirer === undefined
    ? undefined
    : { kind: "required-by", requirer: { kind: requirer.kind, name: requirer.name } };
}

/**
 * The reason each selected item of one namespace carries.
 *
 * An entry beats a `requires` edge, because the entry ends a chain where the edge continues one:
 * preferring it keeps an explanation as short as it can be while staying true, and a project that
 * asked for something itself wants to hear which of its own entries did it.
 *
 * @param entries the project's `requires` list.
 * @param selected the selected requirers, which is what a `requires` edge can come from.
 * @throws {AmbitError} exit 1 for an item neither route accounts for.
 */
function selectionReasons(
  items: readonly { readonly catalog: string; readonly name: string }[],
  kind: ItemKind,
  entries: readonly PatternEntry[],
  selected: readonly Requirer[],
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
    case "pack":
      return bundle.reasons.packs;
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
 * A reason alone is only half an answer: `required-by:pack:engineering` prompts the same question one
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
    const next = formatItem(reason.requirer);
    if (walked.has(next)) {
      throw unexplainable(current, `the \`requires\` chain through ${next} does not terminate`);
    }
    walked.add(next);
    current = reason.requirer;
  }
}

/**
 * Computes the bundle for a project.
 *
 * Selection order comes from the merged catalog, which is already sorted by name, so filtering
 * preserves it and no collection is iterated in filesystem order.
 *
 * `expects` is unioned over the closed selection, not the entry-selected one: a server pulled in by
 * a pack needs its credentials as much as one an entry named. A hook's `expects` joins it too — a
 * hook that cannot see its credential is as broken as a server that cannot. Packs contribute none:
 * a pack reads nothing from the world.
 *
 * Reasons are computed here rather than on request, so `--explain`, `ambit why`, and the lock all
 * report the same answer, and so a bundle that cannot account for an item fails at resolution
 * instead of at whichever surface happens to ask first.
 *
 * @param merged every configured catalog, which is where every definition is: a project that ships
 *   items of its own lists itself as a catalog, so all four namespaces arrive here the same way.
 * @throws {AmbitError} exit 3 for a `requires` entry that matches nothing, a `requires` cycle, or one
 *   name selected from two catalogs.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  // First, and before anything is selected, so an install cannot half-run on a config that asked for
  // something no catalog has.
  assertEntriesMatch(config, merged);
  const entries = config.requires;

  // Every seed list stays in the merged catalog's order, being a filter of it, so how something was
  // selected cannot change where it lands in the bundle.
  //
  // Selection is per copy, not per name: an entry reaching two catalogs' copies of one name selects
  // both, which is what makes the collision the project's to resolve rather than ambit's.
  const selection = closeOverRequires(
    requirersOf(merged).filter(
      (requirer) => selectingEntry(entries, requirer.kind, requirer) !== undefined,
    ),
    merged.mcps.filter((mcp) => selectingEntry(entries, "mcp", mcp) !== undefined),
    merged.hooks.filter((hook) => selectingEntry(entries, "hook", hook) !== undefined),
    merged,
  );

  // Before the bundle exists, and before any map below keys on a bare name: this is the check that
  // makes a name an identity from here on, so nothing downstream can quietly drop a copy instead.
  assertNoCollisions(selection);
  const { packs, skills, mcps, hooks } = selection;

  // The requirers that survived the closure, which is what a `required-by` reason may name.
  const selectedRequirers = requirersOf({ ...merged, packs, skills });

  return {
    packs,
    skills,
    mcps,
    hooks,
    expects: unionExpectations([
      ...skills.map((skill) => skill.expects),
      ...mcps.map((mcp) => mcp.expects),
      ...hooks.map((hook) => hook.expects),
    ]),
    reasons: {
      packs: selectionReasons(packs, "pack", entries, selectedRequirers),
      skills: selectionReasons(skills, "skill", entries, selectedRequirers),
      mcps: selectionReasons(mcps, "mcp", entries, selectedRequirers),
      hooks: selectionReasons(hooks, "hook", entries, selectedRequirers),
    },
  };
}

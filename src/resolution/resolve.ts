/**
 * Resolution: the project's `requires` list and the merged catalog in, the bundle out.
 *
 * Pure and synchronous. All disk and network access happens before this runs, so the same inputs
 * always produce a byte-identical bundle and `resolve --json` can be committed as a golden file.
 *
 * A `requires` entry names a namespace and a glob matching names in it. An exact name is just a
 * pattern with no wildcard. The grammar and matcher live in `model/pattern.ts`; this file defines
 * what a match means.
 *
 * A pattern matching nothing is exit 3 ({@link assertEntriesMatch} for a project's entries,
 * {@link closeOverRequires} for a catalog's own), via {@link unmatchedEntryError} in both cases. A
 * project's entry is qualified with the catalog it selects from; a catalog's own entry is bare and
 * resolves within that catalog only. Every selected item's reason is either the entry that selected
 * it or the requirer that pulled it in ({@link SelectionReason}) — never both, and the lock records
 * it too.
 *
 * A **pack** and a **skill** both carry `requires`, and the closure follows both. A pack is a
 * document whose whole content is what asking for it gets you — a catalog's way of offering a named,
 * browsable group of items. A skill's `requires` declares what it cannot work without, so a project
 * that reaches it gets a working bundle rather than a broken one. Servers, hooks and plugins are
 * leaves; a plugin is self-contained by construction, shipping its own components rather than naming
 * a catalog's.
 *
 * Two catalogs may provide one name; the merged catalog holds both copies, but a bundle holds at
 * most one — a selection reaching both is refused ({@link assertNoCollisions}), because harness
 * layout is flat and both copies would materialize to the same path. That refusal is what lets a
 * bare name serve as an identity within a bundle, while the merged catalog itself keys on
 * `<catalog>/<name>`.
 */
import type {
  MergedCatalog,
  MergedHook,
  MergedMcp,
  MergedPack,
  MergedPlugin,
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
 * A set of catalog items under consideration, each list in the merged catalog's own order (name,
 * then catalog).
 *
 * Two copies of one name can be in here. {@link closeOverRequires} produces a `Selection`;
 * {@link assertNoCollisions} judges it. A {@link Bundle} is a selection that has passed that check.
 */
export interface Selection {
  readonly packs: readonly MergedPack[];
  readonly plugins: readonly MergedPlugin[];
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
  readonly hooks: readonly MergedHook[];
}

export type { ItemKind };

/**
 * One item of a bundle: which namespace, and the name inside it.
 *
 * A {@link Reference} over the item kinds. Not the same type a `requires` entry parses to: a pattern
 * entry is a question about a catalog answered by zero or more items, while a bundle item is exactly
 * one item of one namespace.
 */
export type BundleItem = Reference<ItemKind>;

/** How a bundle item is written where only a string will do — `pack:engineering`. */
export function formatItem(item: BundleItem): string {
  return `${item.kind}${KIND_SEPARATOR}${item.name}`;
}

/**
 * An item that carries a `requires` list, as the closure and the cycle hunt see one.
 *
 * A structural shape over the two kinds that have one (pack and skill), rather than a union of the
 * two merged types, because everything below asks the same four questions of both: which namespace,
 * whose catalog, what name, and what does it require. Which document to send a reader to is settled
 * once, in {@link requirersOf}.
 *
 * A pack and a skill can share a name, so {@link kind} is part of a requirer's identity: `pack:core`
 * and `skill:core` are two nodes of the graph, and a cycle through one is not a cycle through the
 * other.
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
   * A pack is its own document; a skill's annotations live in its `SKILL.md`.
   */
  readonly file: string;
}

/**
 * Every item in the merged catalog that carries a `requires` list, packs first.
 *
 * Packs first because a pack is the more useful answer to *what pulled this in*: it is a name a
 * project wrote on purpose, where a skill's own requirement is an implementation detail of that
 * skill. The order is otherwise the merged catalog's (name, then catalog), so "the first requirer
 * that matches" depends only on names.
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
 * Why one item is in the bundle: one of the two routes resolution offers, never both.
 *
 * A `selected` reason carries the entry itself rather than a rendering of it, so a caller can print
 * it whole ({@link formatEntry}).
 *
 * A `required-by` reason names the requirer's namespace as well as its name, because a pack may
 * share a name with a skill: `required-by:pack:engineering` is unambiguous, `required-by:engineering`
 * is not.
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
 * Keyed by name, not address, because a bundle holds one item per name per namespace —
 * {@link assertNoCollisions} refuses anything else.
 */
export interface SelectionReasons {
  readonly packs: ReadonlyMap<string, SelectionReason>;
  readonly plugins: ReadonlyMap<string, SelectionReason>;
  readonly skills: ReadonlyMap<string, SelectionReason>;
  readonly mcps: ReadonlyMap<string, SelectionReason>;
  readonly hooks: ReadonlyMap<string, SelectionReason>;
}

/**
 * The resolved set of packs, plugins, skills, MCP servers and hooks for a project.
 *
 * One item per name within each namespace, guaranteed by {@link assertNoCollisions}. Everything
 * downstream (`install`, the lock, `status`, `doctor`, `why`) relies on that when it keys on a bare
 * name; the merged catalog itself does not, since it holds every catalog's copy.
 *
 * Packs are included even though a pack materializes nothing — everything else in a bundle lands
 * where a harness reads it, while a pack only contributes to the lists below it. It is kept so a
 * bundle can answer *why is this skill installed* with the pack name the project actually wrote.
 *
 * The config's own `requires` list is not echoed back: it is already in the file the reader has
 * open. What they cannot look up is {@link Bundle.reasons}, one per selected item.
 */
export interface Bundle {
  /** Selected packs, sorted by name. Materialized nowhere — see above. */
  readonly packs: readonly MergedPack[];
  /**
   * Selected Claude Code plugins, sorted by name.
   *
   * Materialized only for a harness that reads them, unlike everything else here: a plugin is
   * Claude's unit, not a shared one, so a project on codex alone resolves the plugin, records it in
   * the lock, and installs nothing. `doctor` reports that rather than resolution refusing it, since
   * the same `ambit.yml` is often installed by people on different tools.
   */
  readonly plugins: readonly MergedPlugin[];
  /** Selected skills, sorted by name. */
  readonly skills: readonly MergedSkill[];
  /** Selected MCP servers, sorted by name. */
  readonly mcps: readonly MergedMcp[];
  /** Selected hooks, sorted by name. */
  readonly hooks: readonly MergedHook[];
  /**
   * Every precondition the selection declares, unioned and grouped by kind.
   *
   * Grouped rather than flat because an expectation's kind decides what checking it means: a
   * variable is looked up in the environment, a `bin:` on the `PATH`. Packs contribute nothing; a
   * pack reads nothing from the world, and the items it names carry their own expectations.
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
 * Several entries may reach one item (a wildcard and the exact name under it); any of them is a true
 * answer, so ties break on {@link formatEntry} — the same string the reason prints, so a tie between
 * two entries that print identically is unobservable.
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
    merged.plugins.some((plugin) => matches(entry, patternItem("plugin", plugin))) ||
    merged.skills.some((skill) => matches(entry, patternItem("skill", skill))) ||
    merged.mcps.some((mcp) => matches(entry, patternItem("mcp", mcp))) ||
    merged.hooks.some((hook) => matches(entry, patternItem("hook", hook)))
  );
}

/** What a namespace is called in a message about one of its members, without an article. */
const KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  pack: "pack",
  plugin: "plugin",
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
};

/**
 * The error for a `requires` entry no item satisfies. Used at every place a `requires` list is
 * written and checked.
 *
 * A project's entry and a catalog's own are the same grammar asking the same question, so an entry
 * that selects nothing is one mistake with one message, whether it names one item or globs a whole
 * prefix, and whether it was written in `ambit.yml`, in a pack, or in a `SKILL.md`.
 *
 * A qualifier no catalog answers to is called out separately: the qualifier is an alias, not a
 * pattern, so a wildcard written there asks for a catalog literally named `*`, and a message about
 * "nothing matching the rest of the address" would be answering the wrong question.
 *
 * Exported because three surfaces reject an entry — the project check and the closure, each on the
 * first offender, and validation on every one of them — and the message must read identically from
 * all of them.
 *
 * @param within the catalog the entry resolves in: named by a project entry ({@link entryCatalog}),
 *   or the catalog holding the requirer when the entry is a catalog's own. Always exactly one
 *   catalog, never "whichever one happens to hold a match".
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
    // An entry with no qualifier is a catalog's own, so this line only applies there: another
    // catalog holding a match does not count, since a catalog's own requires resolves within it.
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
 * an entry naming no alias is refused at parse and cannot reach here. The assertion records that
 * invariant rather than inventing a fallback.
 *
 * Exported so validation and resolution name the same catalog in the same words.
 */
export function entryCatalog(entry: PatternEntry): string {
  return entry.catalog!;
}

/**
 * Rejects a `requires` entry that selects nothing.
 *
 * An entry that matches nothing would yield a bundle quietly missing everything it was meant to
 * bring, so it fails loudly instead.
 *
 * Stops at the first offender, sorted by {@link formatEntry}, so which of several bad entries is
 * reported depends on what they say and not on config order. Listing every problem at once is
 * validation's job, which reuses the same error builder.
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
 * `ConfigOrigin.entryLines` is keyed by {@link entryYaml}, the entry rendered whole.
 *
 * Exported so validation positions an entry exactly as resolution does.
 */
export function entryPosition(config: ProjectConfig, entry: PatternEntry): string {
  return at(config.origin.file, config.origin.entryLines.get(entryYaml(entry)));
}

/**
 * Where a requirer's `requires` entry was written, as {@link at} renders it.
 *
 * The file, and no line: a catalog's documents are parsed long before an entry is judged, so nothing
 * keeps the line it sat on (unlike a project's, which `ConfigOrigin` records). The file is enough to
 * act on, since the entry itself is quoted in the message.
 *
 * Exported so validation positions a catalog's entry exactly as the closure does.
 */
export function requirerPosition(requirer: Requirer): string {
  return at(requirer.file, undefined);
}

/**
 * A requirer's `requires` list, deduplicated and sorted by {@link entryYaml} rather than kept in
 * authoring order, so which of several problems in a list gets reported does not depend on write
 * order.
 *
 * Exported so validation walks a list exactly as the closure does.
 */
export function requiredEntries(requirer: Requirer): readonly PatternEntry[] {
  return [...uniqueEntries(requirer.requires)].sort((a, b) => compare(entryYaml(a), entryYaml(b)));
}

/**
 * Every item one of a requirer's `requires` entries selects, matched against the catalog that
 * requirer came from and against nothing else.
 *
 * A catalog is self-contained: an entry written inside one resolves within it, so `core.*` in
 * `company`'s `packs/engineering.yml` reaches only `company`'s items. A catalog author cannot write a
 * consumer's alias, so a bare pattern inside a catalog can only mean "my own catalog".
 *
 * The locality is enforced here rather than in {@link matches}, which skips its catalog test for an
 * unqualified entry: an unqualified entry does not know which catalog it was written in, so the rule
 * has to live with whoever offers it items.
 *
 * Results stay in the merged catalog's order, being a filter of it.
 *
 * Exported so validation follows an edge exactly as the closure does — its cycle hunt walks every
 * requirer in the catalog, not only the selected ones, and must not disagree about where an edge
 * goes.
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
    plugins: merged.plugins.filter(
      (plugin) => own(plugin.catalog) && matches(entry, patternItem("plugin", plugin)),
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
    selection.plugins.length === 0 &&
    selection.skills.length === 0 &&
    selection.mcps.length === 0 &&
    selection.hooks.length === 0
  );
}

/**
 * Whether a requirer's `requires` entry selects anything its own catalog ships.
 *
 * The catalog-side counterpart of {@link matchesAnything}: an entry that selects nothing is a
 * mistake. Exported because validation asks it of every entry in a catalog, while the closure asks it
 * only of the ones a selected requirer declares.
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
 * The path shows the loop without deciding which member is "the" problem — printing only one name
 * would make that choice for the reader. The closing edge is named separately, with its file, because
 * that is the actionable part: removing it breaks the cycle.
 *
 * Members print as `<kind>:<name>`, not bare names, because a pack and a skill may share a name, and
 * `core → core` would misread as one item requiring itself.
 *
 * Only the closing edge is annotated with its entry. A pattern can close a loop without naming
 * anything explicitly in it — a skill matching its own `core.*` is a one-step cycle — so showing the
 * entry is the only way to make that visible.
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
 * Closes a selection over `requires` until fixpoint: every pack, skill, MCP entity and hook that a
 * selected pack or skill requires joins the selection, whether or not the project's own entries would
 * have selected it.
 *
 * Packs are the main case this exists for. A catalog says once what "engineering" means (these
 * skills, that server, those hooks, plus the `core` pack) and a project takes the whole of it with
 * one entry. A skill's own `requires` is the narrower case: a skill that is useless without a
 * company-context skill and a server declares so, so a project reaching it gets a working bundle
 * instead of a broken one. Hooks follow the same route for the same reason.
 *
 * The closure is set-valued: a requirer's entry is the project's entry minus the qualifier, so it may
 * glob and answers with a set of items, not a single name. There is nothing to look up by key, so
 * there is no "missing" case — only an entry that matched nothing, reported the same way
 * {@link unmatchedEntryError} reports it for a project's own entries.
 *
 * Packs and skills are the interior of the graph; servers, hooks and plugins are leaves and carry
 * no `requires`. Each entry resolves within the requirer's own catalog (see {@link requiredItems}).
 *
 * Accepted cost: a wildcard `requires` means a catalog author adding an item changes what an
 * unrelated pack pulls in silently. Add `skills/core/internal-notes`, and every requirer naming
 * `skill: core.*` grows a dependency at install with no message anywhere. This is the same class of
 * hazard as the collision {@link assertNoCollisions} refuses, but silent rather than loud. It is
 * recorded, not fixed, because forbidding wildcards inside a catalog would make catalogs less
 * expressive than the projects consuming them.
 *
 * One consequence: a pattern matches the requirer itself if it can, so something that requires itself
 * is a one-step cycle — the skill `core.a` cannot require `skill: core.*`. This is not special-cased,
 * so {@link cycleError} names the entry that closed the loop.
 *
 * @param roots what the project's entries selected among the two requiring kinds, in the merged
 *   catalog's order.
 * @param mcps MCP entities the project's entries already selected.
 * @param hooks hooks the project's entries already selected.
 * @param plugins plugins the project's entries already selected.
 * @param merged what requirements resolve against, one catalog of it at a time.
 * @throws {AmbitError} exit 3 for a `requires` entry that matches nothing in its own catalog, or a
 *   cycle.
 */
export function closeOverRequires(
  roots: readonly Requirer[],
  mcps: readonly MergedMcp[],
  hooks: readonly MergedHook[],
  plugins: readonly MergedPlugin[],
  merged: MergedCatalog,
): Selection {
  // Keyed by address, not bare name: a set of names would treat two catalogs' copies as one item.
  const chosenPacks = new Set<string>();
  const chosenSkills = new Set<string>();
  const chosenMcps = new Set(mcps.map(qualifiedName));
  const chosenHooks = new Set(hooks.map(qualifiedName));
  const chosenPlugins = new Set(plugins.map(qualifiedName));

  // Keyed the way the walk addresses requirers, so an edge can find its target node directly.
  const requirers = new Map(
    requirersOf(merged).map((requirer) => [requirerKey(requirer), requirer]),
  );

  // `path` is the chain currently being followed (meeting something already on it is a cycle);
  // `closed` is what has been followed to completion (revisiting that is just a shared requirement).
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

      // Leaf namespaces: an MCP, a hook or a plugin carries no requires, so joining the selection
      // is all there is to do.
      for (const mcp of required.mcps) chosenMcps.add(qualifiedName(mcp));
      for (const hook of required.hooks) chosenHooks.add(qualifiedName(hook));
      for (const plugin of required.plugins) chosenPlugins.add(qualifiedName(plugin));

      const next = [
        ...required.packs.map((pack) =>
          requirers.get(`pack${KIND_SEPARATOR}${qualifiedName(pack)}`),
        ),
        ...required.skills.map((skill) =>
          requirers.get(`skill${KIND_SEPARATOR}${qualifiedName(skill)}`),
        ),
      ].filter((candidate): candidate is Requirer => candidate !== undefined);

      for (const child of next) {
        // Checked here rather than on entry to `follow`, because only here do we know which entry
        // the edge came from, and the cycle error needs to name it.
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

  // Filtering the merged lists, rather than collecting during the walk, keeps the result in the
  // merged catalog's order regardless of discovery order.
  return {
    packs: merged.packs.filter((pack) => chosenPacks.has(qualifiedName(pack))),
    plugins: merged.plugins.filter((plugin) => chosenPlugins.has(qualifiedName(plugin))),
    skills: merged.skills.filter((skill) => chosenSkills.has(qualifiedName(skill))),
    mcps: merged.mcps.filter((mcp) => chosenMcps.has(qualifiedName(mcp))),
    hooks: merged.hooks.filter((hook) => chosenHooks.has(qualifiedName(hook))),
  };
}

/**
 * The error for one name two selected catalogs both provide.
 *
 * A harness's layout is flat and not ambit's to change — Claude reads `.claude/skills/<name>` — so
 * both copies want one path. Dropping one silently is refused instead: no catalog outranks another,
 * so there is nothing to prefer either copy with, and a bundle quietly missing a requested copy would
 * be undebuggable.
 *
 * A pack materializes nowhere and so has no path to collide over, but it is refused all the same: a
 * pack is addressable (`ambit why pack:core`), and two selected packs named `core` would leave that
 * question with two answers.
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
 * Rejects a selected skill and a selected plugin sharing one name.
 *
 * The one collision that crosses namespaces, and it exists because the two share a directory: a
 * skills-directory plugin is loaded by Claude Code from the same `.agents/skills` a skill is
 * installed into, so `skills/house-style` and `plugins/house-style` both want
 * `.agents/skills/house-style`.
 *
 * Refused rather than arbitrated, for the same reason {@link collisionError} refuses two catalogs'
 * copies of one name: neither namespace outranks the other, and whichever lost would be silently
 * missing from the install.
 *
 * @throws {AmbitError} exit 3, naming the two catalogs so a reader knows which documents to edit.
 */
function assertSkillsAndPluginsApart(selection: Selection): void {
  const skills = new Map(selection.skills.map((skill) => [skill.name, skill.catalog]));

  for (const plugin of selection.plugins) {
    const catalog = skills.get(plugin.name);
    if (catalog === undefined) continue;

    throw resolutionError(`"${plugin.name}" is selected as both a skill and a plugin`, [
      `skill from catalog "${catalog}", plugin from catalog "${plugin.catalog}"`,
      "a plugin is installed into the shared skills directory, where a skill of that name already goes, so both would want one path",
      `rename one of them, or drop the \`${REQUIRES_KEY}\` entry that reaches the other`,
    ]);
  }
}

/**
 * Rejects a selection holding two catalogs' copies of one name.
 *
 * This is where the collision the merge left unarbitrated gets settled. The conflict is about
 * materialization, not selection: a name two catalogs ship costs nothing until a project selects
 * both copies and a harness is asked to hold them at one path.
 *
 * Stops at the first offender, in namespace order then name order. The selection arrives sorted by
 * name and then catalog, so which collision gets reported depends only on the names.
 *
 * @throws {AmbitError} exit 3, naming the item and every catalog that provides it.
 */
export function assertNoCollisions(selection: Selection): void {
  assertOnePerName("pack", selection.packs);
  assertOnePerName("plugin", selection.plugins);
  assertOnePerName("skill", selection.skills);
  assertOnePerName("mcp", selection.mcps);
  assertOnePerName("hook", selection.hooks);
  assertSkillsAndPluginsApart(selection);
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
 * Exit 1, not 3: no catalog or config input can produce this, since every item in a bundle arrives
 * through one of the two routes by construction. Reaching it means the selection and its explanation
 * disagree, which is a bug.
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
 * Tested with {@link matches}, not equality, since a `requires` entry is a pattern. Only a requirer
 * from the item's own catalog can be the answer, because that is as far as a catalog's `requires`
 * reaches.
 *
 * Recovered from the closure's result rather than recorded during its walk, so which requirer is
 * named depends only on the names (packs first, then skills, each in name order) and not on
 * discovery order. Several requirers may name one thing; any of them is a true answer.
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
 * A `selected` entry beats a `required-by` edge: the entry ends a chain, while the edge continues
 * one, so preferring it keeps the explanation as short as possible while staying true.
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
    case "plugin":
      return bundle.reasons.plugins;
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
 * A reason alone is only half an answer: `required-by:pack:engineering` just raises the same question
 * one level up. The walk follows `required-by` edges backwards until it reaches a root (an entry of
 * the project's own), which terminates because `requires` cycles were rejected during closure.
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

    // Guards against a broken invariant, not a bad catalog: a repeat here would mean a `requires`
    // cycle survived closure. Looping forever would be a worse way to report that.
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
 * preserves it.
 *
 * `expects` is unioned over the closed selection, not just the entry-selected one: a server or hook
 * pulled in by a pack needs its credentials checked as much as one an entry named directly. Packs
 * contribute none, since a pack reads nothing from the world.
 *
 * Reasons are computed here rather than on request, so `--explain`, `ambit why`, and the lock all
 * report the same answer, and a bundle that cannot account for an item fails at resolution instead
 * of at whichever surface asks first.
 *
 * @param merged every configured catalog. A project that ships items of its own lists itself as a
 *   catalog, so every namespace arrives here the same way.
 * @throws {AmbitError} exit 3 for a `requires` entry that matches nothing, a `requires` cycle, or one
 *   name selected from two catalogs.
 */
export function resolveBundle(config: ProjectConfig, merged: MergedCatalog): Bundle {
  // Checked first, before anything is selected, so an install cannot half-run on a config that asked
  // for something no catalog has.
  assertEntriesMatch(config, merged);
  const entries = config.requires;

  // Seed lists stay in the merged catalog's order, being a filter of it, so how something was
  // selected does not affect where it lands in the bundle.
  //
  // Selection is per copy, not per name: an entry reaching two catalogs' copies of one name selects
  // both, leaving the collision for the project to resolve.
  const selection = closeOverRequires(
    requirersOf(merged).filter(
      (requirer) => selectingEntry(entries, requirer.kind, requirer) !== undefined,
    ),
    merged.mcps.filter((mcp) => selectingEntry(entries, "mcp", mcp) !== undefined),
    merged.hooks.filter((hook) => selectingEntry(entries, "hook", hook) !== undefined),
    merged.plugins.filter((plugin) => selectingEntry(entries, "plugin", plugin) !== undefined),
    merged,
  );

  // Checked before the bundle exists and before any map below keys on a bare name: this is what
  // makes a name an identity from here on.
  assertNoCollisions(selection);
  const { packs, plugins, skills, mcps, hooks } = selection;

  // The requirers that survived the closure, which is what a `required-by` reason may name.
  const selectedRequirers = requirersOf({ ...merged, packs, skills });

  return {
    packs,
    plugins,
    skills,
    mcps,
    hooks,
    // Plugins contribute none: the manifest is Claude's document and has no key ambit could read a
    // precondition from, so what a plugin's own servers need is Claude's to prompt for.
    expects: unionExpectations([
      ...skills.map((skill) => skill.expects),
      ...mcps.map((mcp) => mcp.expects),
      ...hooks.map((hook) => hook.expects),
    ]),
    reasons: {
      packs: selectionReasons(packs, "pack", entries, selectedRequirers),
      plugins: selectionReasons(plugins, "plugin", entries, selectedRequirers),
      skills: selectionReasons(skills, "skill", entries, selectedRequirers),
      mcps: selectionReasons(mcps, "mcp", entries, selectedRequirers),
      hooks: selectionReasons(hooks, "hook", entries, selectedRequirers),
    },
  };
}

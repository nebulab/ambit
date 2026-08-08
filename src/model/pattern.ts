/**
 * How a selection is written down, and what it selects: the `requires` entry and its glob.
 *
 * One addressing scheme, shared by the three places a selection is written. A project's `requires`
 * says which of the catalogs it listed to take items from; a pack's says what that pack pulls in; a
 * skill's says which of its siblings it cannot work without. All three are the same entry, and the
 * only difference is whether the address carries a catalog — see {@link Addressing}.
 *
 * ```yaml
 * requires:
 *   - pack: "company/engineering" # everything that pack pulls in, transitively
 *   - skill: "company/core.*" # everything beneath the `core` name prefix
 *   - hook: "company/guards.*"
 * ```
 *
 * **One key, naming a namespace, carrying a pattern.** An entry is a mapping of exactly one key: the
 * key is the {@link ItemKind} being selected, and the value is the glob to match names in that
 * namespace against. There is nothing else to declare, because there is nothing else to match on — a
 * catalog item has a name and no other selectable field.
 *
 * That is the whole of what replaced the two-key entry this grammar had. The old one named a *field*
 * (`name` or `tag`) and a *capability list*, because an item could also carry free-form tags and one
 * tag entry was expected to reach a skill, a server and a hook at once. Tags are gone, and
 * {@link ItemKind}'s `pack` is what took their job: an author who wants one name to reach a skill, a
 * server and a hook declares a **pack** in the catalog that requires all three, and a consumer writes
 * `- pack: company/engineering`. The grouping is a document with a name and a description, browsable
 * with `ambit dump-catalog`, instead of a label that nothing registered and nothing described.
 *
 * The declaration that survives is the namespace, and it survives for the reason it always had: a
 * catalog's namespaces are flat and independent, so a skill at `skills/mcp/sentry/SKILL.md` is
 * legitimately named `mcp.sentry` while an MCP entity called `sentry` sits one namespace over. A bare
 * `- mcp.sentry` cannot say which of the two it means, so the key does.
 *
 * **No bare shorthand.** No spelling omits the key. `- "company/core.*"` is refused rather than
 * resolved against whichever namespace happens to hold a match today.
 *
 * **No negation.** `!company/core.internal.*` is not part of this grammar, so `!` is an ordinary
 * character: a leading one is matched literally, and the entry names nothing any catalog holds. That
 * fails loudly rather than quietly, because a pattern matching nothing is an error at resolve — and
 * reserving the character here would settle a question that belongs to whoever adds exclusion.
 *
 * Pure, and deliberately so: nothing here reads a catalog, and matching is a function of the entry
 * and the one item handed to it. What a pattern matching nothing means, which items a catalog's own
 * `requires` is allowed to see, and how a reason is rendered all live with the resolution that asks
 * those questions.
 */
import { at, configError } from "../errors.js";
import type { AmbitError } from "../errors.js";
import { CATALOG_SEPARATOR } from "./catalog.js";
import type { ItemKind } from "./requirement.js";
import { ITEM_KINDS } from "./requirement.js";
import { YamlMapping } from "./yaml.js";
import type { PositionedString } from "./yaml.js";

/**
 * The key a selection list is written under, in a project config, in a pack, and in a skill's
 * `ambit:` block alike.
 *
 * One word for all three, because it is one operator: everything an entry names joins the bundle. The
 * documents differ in what an address may say, not in what the list means.
 */
export const REQUIRES_KEY = "requires";

/**
 * Which spelling of an address a `requires` list is written in.
 *
 * - `"qualified"` — `<catalog>/<pattern>`, **mandatory in a project config**. A project is where
 *   the aliases in `catalogs:` are declared, so it is the only document that can name one, and
 *   without the qualifier `core.*` would mean *whichever catalog happens to hold a match*, which is
 *   the config-order dependence this addressing scheme removes.
 * - `"unqualified"` — the bare pattern, **mandatory inside a catalog**. A catalog author cannot
 *   write a qualifier correctly: the alias belongs to the consumer's config, and the same catalog is
 *   `company` in one project and `acme` in the next. So a pack's or a skill's `requires` names its
 *   siblings unqualified and resolves within its own catalog, which is what makes a catalog
 *   self-contained — it can only require what it ships. That is a deliberate tightening on what a
 *   requirement used to reach; the argument is with the closure that enforces it, in
 *   `resolution/resolve.ts`.
 *
 * A qualifier where it is refused, and a missing one where it is required, are both exit 2 naming
 * the key and the line, rather than a value quietly resolved against a guess.
 */
export type Addressing = "qualified" | "unqualified";

/**
 * One entry of a `requires` list: which namespace to select from, and the glob to select with.
 *
 * Not an {@link ItemKind}-and-name pair, however much it looks like one: an entry is a *question*
 * about a catalog, answered by zero or more items, where a bundle item is one item. `- skill: core.*`
 * names a namespace and a pattern; `skill:core.a` names a thing.
 */
export interface PatternEntry {
  /** The namespace this entry selects from — the entry's one key. */
  readonly kind: ItemKind;
  /**
   * The glob, with the qualifier stripped off — see {@link matchesPattern}.
   *
   * Never holds a {@link CATALOG_SEPARATOR}: the address is split at parse time, so everything
   * downstream matches a pattern against a name and never has to re-split anything.
   */
  readonly pattern: string;
  /**
   * The catalog alias the pattern is qualified with, present exactly when the entry was parsed as
   * `"qualified"`.
   *
   * Absent is not *any catalog*. An unqualified entry is catalog-blind by construction, and it is
   * the caller resolving one — a catalog's own `requires` — that must offer it only that catalog's
   * items. {@link matches} cannot enforce that rule, because an unqualified entry does not carry the
   * catalog it would be enforced against.
   */
  readonly catalog?: string;
}

/**
 * One item, of one namespace, as a pattern is matched against it.
 *
 * A structural shape rather than a merged-catalog type, so this module needs to know nothing about
 * how an item is loaded: a `MergedPack`, a `MergedSkill`, a `MergedMcp` and a `MergedHook` all
 * satisfy it once the caller says which namespace the array it is walking holds.
 */
export interface PatternItem {
  /** Which namespace this item is in. */
  readonly kind: ItemKind;
  /** The catalog the item came from, which a qualified entry is matched against. */
  readonly catalog: string;
  /** The item's name inside its namespace, dotted — `core.house-style`. */
  readonly name: string;
}

/** The one metacharacter this grammar has. */
const WILDCARD = "*";

/**
 * Every regular-expression metacharacter, escaped.
 *
 * The whole reason the matcher is built by splitting on {@link WILDCARD} rather than by rewriting it
 * in place: a pattern's characters are otherwise *literal*, and a dotted name space is full of dots.
 * A naive `replace("*", ".*")` leaves every other metacharacter live, so `coreXa` would match
 * `core.a` — silently selecting an item nobody asked for, which is the worst direction for this
 * mistake to fail in.
 */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `pattern` matches `text`.
 *
 * `*` matches any run of characters — **including `.`** — may appear anywhere, and may appear any
 * number of times. A pattern holding no `*` is an exact name, which is why explicit names and
 * wildcards are one grammar rather than two selection routes.
 *
 * ```
 * core.*  ->  core.a, core.a.b     (NOT core)
 * core    ->  core
 * *       ->  everything
 * ```
 *
 * **`core.*` excludes `core` itself.** The pattern says *`core`, a dot, then anything*, and `core`
 * has no dot; reading it as *also `core`* would be the matcher being generous with a syntax that
 * says something else. Selecting a prefix and the item named exactly that therefore takes two
 * entries, and the accepted cost is that the omission is silent — a reader notices the missing item
 * later, not at install.
 *
 * `*` spans `.` because the dot in a name is not a level separator to this grammar, it is a
 * character: a catalog's namespaces are flat, and the tree a dotted name suggests is a naming
 * convention rather than a structure anything here knows about. So `core.*` reaches `core.a.b` in
 * one entry, and there is no depth to pre-register or agree with.
 */
export function matchesPattern(pattern: string, text: string): boolean {
  const literals = pattern.split(WILDCARD);
  // No wildcard: the pattern is a name, and comparing strings says so more plainly than a regular
  // expression that could only ever be an equality test.
  if (literals.length === 1) return pattern === text;

  // `[\s\S]*` rather than `.*`, which stops at a newline — a name holding one is pathological, but a
  // matcher that quietly disagrees with "any run of characters" on one character is worse.
  const source = `^${literals.map(escapeLiteral).join("[\\s\\S]*")}$`;
  return new RegExp(source).test(text);
}

/** What separates a kind from the address it applies to, where only a string will do. */
const KIND_SEPARATOR = ":";

/**
 * The address as it was written: `company/core.*` when qualified, `core.*` when not.
 *
 * Recomposed from the parsed halves rather than kept as a third field, so there is one
 * representation of the entry and no way for the two to disagree.
 */
export function entryAddress(entry: PatternEntry): string {
  const { catalog, pattern } = entry;
  return catalog === undefined ? pattern : `${catalog}${CATALOG_SEPARATOR}${pattern}`;
}

/**
 * How an entry is written where only a string will do — `pack:company/engineering`,
 * `skill:company/core.*`.
 *
 * The same `<kind>:<name>` shape `ambit why` takes as its subject, and deliberately so: an entry and
 * an item are named by the same grammar, one carrying a pattern where the other carries a name.
 */
export function formatEntry(entry: PatternEntry): string {
  return `${entry.kind}${KIND_SEPARATOR}${entryAddress(entry)}`;
}

/**
 * How an entry is written in a document, for a message telling someone to write one.
 *
 * A one-key mapping fits block style on one line, so this is the entry exactly as it belongs in a
 * `requires` list. The pattern is quoted unconditionally: a pattern is exactly the kind of string
 * YAML would otherwise read as something else.
 */
export function entryYaml(entry: PatternEntry): string {
  return `- ${entry.kind}: "${entryAddress(entry)}"`;
}

/**
 * Whether two entries say literally the same thing: the same namespace and the same address.
 *
 * Exact only. `skill: core.*` does **not** absorb `skill: core.a`, even though everything the second
 * selects the first selects too. Subsumption normalizing is a rabbit hole — the honest version has to
 * reason about one pattern's matches being a subset of another's — and nobody has asked for it, so
 * two entries one of which is redundant simply stay two entries.
 */
export function sameEntry(a: PatternEntry, b: PatternEntry): boolean {
  return a.kind === b.kind && a.pattern === b.pattern && a.catalog === b.catalog;
}

/**
 * A `requires` list with literal duplicates dropped, keeping the first of each and the order the
 * list was written in.
 *
 * Order-preserving rather than sorted, because this reads a list rather than rewriting one: sorting
 * a document's own entries is the reformatting an author did not ask for. The result is a function
 * of the list alone — the same input always yields the same output — so anything downstream that
 * needs a total order can take one over {@link formatEntry}.
 */
export function uniqueEntries(entries: readonly PatternEntry[]): readonly PatternEntry[] {
  const kept: PatternEntry[] = [];
  for (const entry of entries) {
    if (!kept.some((seen) => sameEntry(seen, entry))) kept.push(entry);
  }
  return kept;
}

/**
 * Whether `entry` selects `item`.
 *
 * Three tests, all of which have to hold: the item's namespace is the one the entry named, the
 * item's catalog is the one the entry qualified (when it qualified one — see
 * {@link PatternEntry.catalog}), and the pattern matches the item's name.
 */
export function matches(entry: PatternEntry, item: PatternItem): boolean {
  if (entry.kind !== item.kind) return false;
  if (entry.catalog !== undefined && entry.catalog !== item.catalog) return false;
  return matchesPattern(entry.pattern, item.name);
}

/** The namespaces as a message lists them: `` `pack`, `skill`, `mcp`, `hook` ``. */
const KIND_LIST = ITEM_KINDS.map((kind) => `\`${kind}\``).join(", ");

/**
 * Stands in for a catalog alias a refusal has no way to know.
 *
 * Literal rather than guessed: the alias is the reader's to pick, it appears in their own
 * `catalogs:`, and proposing a particular one would be a guess dressed as advice.
 */
const ALIAS_PLACEHOLDER = "<catalog>";

/**
 * The example every refusal that has an address to work with ends on.
 *
 * Written in the spelling the document being read demands, so a catalog author is never shown a
 * qualifier they cannot write, and a project is never shown a bare pattern it would refuse in turn.
 * {@link ALIAS_PLACEHOLDER} stands in where the reader has written no alias.
 */
function example(kind: ItemKind, address: string, addressing: Addressing): string {
  const bare = address.split(CATALOG_SEPARATOR).pop()!;
  const shown =
    addressing === "unqualified"
      ? bare
      : address.includes(CATALOG_SEPARATOR)
        ? address
        : `${ALIAS_PLACEHOLDER}${CATALOG_SEPARATOR}${address}`;
  return `write it as \`${entryYaml({ kind, pattern: shown })}\``;
}

/**
 * The error for an entry written as a bare string — the shape a plain list of patterns has.
 *
 * Names what a bare pattern fails to say rather than guessing it, because the namespace is the whole
 * of what this grammar declares and a shorthand that filled it in is the spelling it deliberately
 * does not have.
 */
function bareEntry(
  mapping: YamlMapping,
  item: PositionedString,
  addressing: Addressing,
): AmbitError {
  const line = item.line ?? mapping.lineOf(REQUIRES_KEY);
  return configError(
    `\`${REQUIRES_KEY}\` entry "${item.value}" is not a mapping ${at(mapping.file, line)}`,
    [
      `a bare pattern does not say which namespace it selects from (${KIND_LIST})`,
      example("skill", item.value, addressing),
    ],
  );
}

/** The error for an entry naming no namespace, or more than one. */
function badKind(entry: YamlMapping, declared: readonly ItemKind[]): AmbitError {
  const advice = [
    `an entry is one key naming a namespace, carrying the pattern to match names in it: ${KIND_LIST}`,
    declared.length === 0
      ? `write it as \`${entryYaml({ kind: "skill", pattern: "<pattern>" })}\``
      : "split it into one entry per namespace",
  ];

  const first = declared[0];
  return first === undefined
    ? configError(
        `\`${REQUIRES_KEY}\` entry selects from no namespace ${at(entry.file, entry.line)}`,
        advice,
      )
    : entry.keyError(
        first,
        `\`${REQUIRES_KEY}\` entry selects from ${declared.length} namespaces: ${declared.join(", ")}`,
        advice,
      );
}

/** The error for an address the demanded {@link Addressing} refuses. */
function badAddress(
  entry: YamlMapping,
  kind: ItemKind,
  address: string,
  addressing: Addressing,
  problem: string,
  fix: string,
): AmbitError {
  return entry.keyError(kind, `\`${REQUIRES_KEY}\` entry "${address}" ${problem}`, [
    ...(addressing === "qualified"
      ? [
          `a project selects from a catalog it listed in \`catalogs:\`, so an address is \`<catalog>${CATALOG_SEPARATOR}<pattern>\``,
        ]
      : [
          "a catalog author cannot write the alias: it belongs to the consumer's config, and the same catalog is `company` in one project and `acme` in the next",
          "a catalog's own `requires` resolves within that catalog, so the pattern stands alone",
        ]),
    fix,
  ]);
}

/**
 * The catalog and the pattern an address holds, under the spelling the document demands.
 *
 * Split here, once, so {@link PatternEntry.pattern} never carries a {@link CATALOG_SEPARATOR} and
 * nothing downstream re-derives the halves. A `/` is refused inside the pattern half in both
 * spellings: an item's name is a dotted path and holds none, so a second separator is a stray
 * qualifier however it got there.
 */
function splitAddress(
  entry: YamlMapping,
  kind: ItemKind,
  address: string,
  addressing: Addressing,
): { readonly catalog?: string; readonly pattern: string } {
  const parts = address.split(CATALOG_SEPARATOR);

  if (addressing === "unqualified") {
    if (parts.length === 1) return { pattern: address };
    throw badAddress(
      entry,
      kind,
      address,
      addressing,
      "names a catalog, which a catalog's own `requires` may not",
      example(kind, address, addressing),
    );
  }

  if (parts.length === 1) {
    throw badAddress(
      entry,
      kind,
      address,
      addressing,
      "names no catalog",
      `qualify it: \`<catalog>${CATALOG_SEPARATOR}${address}\`, using an alias from \`catalogs:\``,
    );
  }
  if (parts.length > 2) {
    throw badAddress(
      entry,
      kind,
      address,
      addressing,
      `holds ${parts.length - 1} \`${CATALOG_SEPARATOR}\` separators`,
      `an item's name holds none, so remove all but the first`,
    );
  }

  const catalog = parts[0]!;
  const pattern = parts[1]!;
  if (catalog === "") {
    throw badAddress(
      entry,
      kind,
      address,
      addressing,
      "names an empty catalog",
      `write the alias before the \`${CATALOG_SEPARATOR}\``,
    );
  }
  if (pattern === "") {
    throw badAddress(
      entry,
      kind,
      address,
      addressing,
      "names an empty pattern",
      `write \`${catalog}${CATALOG_SEPARATOR}${WILDCARD}\` for the whole catalog`,
    );
  }

  return { catalog, pattern };
}

/**
 * Parses one `requires` entry: a one-key mapping naming a namespace and carrying a pattern.
 *
 * Unknown keys are refused first, so a leftover `tag:` or `capabilities:` reads as the key it is —
 * one this grammar does not have — rather than as an entry that names no namespace.
 */
function parseEntry(entry: YamlMapping, addressing: Addressing): PatternEntry {
  entry.rejectUnknownKeys(ITEM_KINDS);

  const declared = ITEM_KINDS.filter((candidate) => entry.has(candidate));
  const kind = declared.length === 1 ? declared[0]! : undefined;
  if (kind === undefined) throw badKind(entry, declared);

  const address = entry.requireString(kind);
  const { catalog, pattern } = splitAddress(entry, kind, address, addressing);

  return { kind, pattern, ...(catalog !== undefined && { catalog }) };
}

/**
 * Parses a `requires` list: a sequence of one-key mappings, each naming a namespace and the pattern
 * to match names in it.
 *
 * The list is returned in the order it was written, duplicates included — deduplication is
 * {@link uniqueEntries}, and it is a separate step because a caller merging several lists wants to
 * dedupe the union rather than each part.
 *
 * @param mapping the block the key sits in — a project's config root, a pack's document, a skill's
 *   `ambit:`.
 * @param addressing which spelling this document demands; see {@link Addressing}.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one naming no namespace or more
 *   than one, one carrying a key this grammar does not have, or an address the spelling refuses.
 */
export function parseEntries(
  mapping: YamlMapping,
  addressing: Addressing,
): readonly PatternEntry[] {
  const items = mapping.optionalEntryList(REQUIRES_KEY);
  if (items === undefined) return [];

  return items.map((item) => {
    // A `PositionedString` is a bare pattern, the one shape with a spelling worth describing;
    // everything else the sequence could hold was already refused by `optionalEntryList`.
    if (!(item instanceof YamlMapping)) throw bareEntry(mapping, item, addressing);
    return parseEntry(item, addressing);
  });
}

/**
 * How a selection is written: the `requires` entry and its glob.
 *
 * Used the same way in a project's `requires`, a pack's `requires`, and a skill's `requires` — only
 * whether the address carries a catalog differs (see {@link Addressing}).
 *
 * ```yaml
 * requires:
 *   - pack: "company/engineering" # everything that pack pulls in, transitively
 *   - skill: "company/core.*" # everything beneath the `core` name prefix
 *   - hook: "company/guards.*"
 * ```
 *
 * An entry is a one-key mapping: the key is the {@link ItemKind} being selected, and the value is
 * the glob to match names in that namespace. There is nothing else to match on, since a catalog item
 * has only a name.
 *
 * This replaced an older two-key entry (`name` plus a tag list), used because one tag was expected
 * to reach a skill, a server, and a hook at once. Tags are gone; {@link ItemKind}'s `pack` does that
 * job instead — an author declares a **pack** requiring all three, and a consumer writes
 * `- pack: company/engineering`.
 *
 * The namespace key is mandatory because a catalog's namespaces are flat and independent: a skill at
 * `skills/mcp/sentry/SKILL.md` can be named `mcp.sentry` while an unrelated MCP entity is also called
 * `sentry`. `- mcp.sentry` alone cannot say which is meant.
 *
 * No bare shorthand: `- "company/core.*"` is refused rather than resolved against a guessed
 * namespace.
 *
 * No negation: `!company/core.internal.*` is not part of this grammar, so a leading `!` is matched
 * literally. A pattern matching nothing is an error at resolve time.
 *
 * This module is pure: nothing here reads a catalog. Matching is a function of the entry and one
 * item. What a pattern matching nothing means, which items a catalog's own `requires` may see, and
 * how a reason is rendered live in the resolution code that asks those questions.
 */
import { at, configError } from "../errors.js";
import type { AmbitError } from "../errors.js";
import type { ItemKind } from "./requirement.js";
import { CATALOG_SEPARATOR, ITEM_KINDS } from "./requirement.js";
import { YamlMapping } from "./yaml.js";
import type { PositionedString } from "./yaml.js";

/**
 * The key a selection list is written under, in a project config, a pack, or a skill's `ambit:`
 * block. The documents differ in what an address may say, not in what the list means.
 */
export const REQUIRES_KEY = "requires";

/**
 * Which spelling of an address a `requires` list is written in.
 *
 * - `"qualified"` — `<catalog>/<pattern>`, mandatory in a project config. Only a project declares
 *   catalog aliases in `catalogs:`, so only a project can name one; without the qualifier, `core.*`
 *   would depend on catalog order.
 * - `"unqualified"` — the bare pattern, mandatory inside a catalog. A catalog author cannot write the
 *   alias correctly, since it belongs to the consumer's config and the same catalog is `company` in
 *   one project and `acme` in the next. A pack's or a skill's `requires` therefore names its siblings
 *   unqualified and resolves within its own catalog, which keeps a catalog self-contained: it can
 *   only require what it ships (enforced in `resolution/resolve.ts`).
 *
 * A qualifier where it is refused, or a missing one where it is required, is exit 2 naming the key
 * and line, rather than a value resolved against a guess.
 */
export type Addressing = "qualified" | "unqualified";

/**
 * One entry of a `requires` list: which namespace to select from, and the glob to select with.
 *
 * An entry is a question about a catalog, answered by zero or more items — a bundle item is one
 * item. `- skill: core.*` names a namespace and a pattern; `skill:core.a` names a single item.
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
   * The catalog alias the pattern is qualified with, present only when the entry was parsed as
   * `"qualified"`.
   *
   * Absent does not mean "any catalog": an unqualified entry is catalog-blind, and it is the caller
   * resolving one — a catalog's own `requires` — that must restrict it to that catalog's items.
   * {@link matches} cannot enforce this, since an unqualified entry carries no catalog to check.
   */
  readonly catalog?: string;
}

/**
 * One item, of one namespace, as a pattern is matched against it.
 *
 * A structural shape rather than a merged-catalog type, so this module does not need to know how an
 * item is loaded: `MergedPack`, `MergedSkill`, `MergedMcp`, and `MergedHook` all satisfy it once the
 * caller says which namespace the array holds.
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
 * The matcher is built by splitting on {@link WILDCARD} rather than rewriting it in place, because a
 * pattern's other characters are literal and a dotted name is full of dots. A naive
 * `replace("*", ".*")` leaves every other metacharacter live, so `coreXa` would match `core.a` and
 * silently select an item nobody asked for.
 */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `pattern` matches `text`.
 *
 * `*` matches any run of characters — **including `.`** — anywhere, any number of times. A pattern
 * holding no `*` is an exact name.
 *
 * ```
 * core.*  ->  core.a, core.a.b     (NOT core)
 * core    ->  core
 * *       ->  everything
 * ```
 *
 * **`core.*` excludes `core` itself.** The pattern says *`core`, a dot, then anything*, and `core`
 * has no dot. Selecting a prefix and the item named exactly that therefore takes two entries; the
 * omission of the bare name is silent.
 *
 * `*` spans `.` because a catalog's namespaces are flat: the dot in a name is a naming convention,
 * not a structural separator this grammar understands. So `core.*` reaches `core.a.b` in one entry.
 */
export function matchesPattern(pattern: string, text: string): boolean {
  const literals = pattern.split(WILDCARD);
  // No wildcard: compare strings directly, since a regular expression could only ever test equality
  // here.
  if (literals.length === 1) return pattern === text;

  // `[\s\S]*` rather than `.*`, which stops at a newline. A name holding one is pathological, but
  // the matcher should still honor "any run of characters" consistently.
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
 * The same `<kind>:<name>` shape `ambit why` takes as its subject: an entry and an item are named by
 * the same grammar, one carrying a pattern where the other carries a name.
 */
export function formatEntry(entry: PatternEntry): string {
  return `${entry.kind}${KIND_SEPARATOR}${entryAddress(entry)}`;
}

/**
 * How an entry is written in a document, for a message telling someone to write one.
 *
 * A one-key mapping fits block style on one line, so this is the entry exactly as it belongs in a
 * `requires` list. The pattern is quoted unconditionally, since it is exactly the kind of string
 * YAML would otherwise read as something else.
 */
export function entryYaml(entry: PatternEntry): string {
  return `- ${entry.kind}: "${entryAddress(entry)}"`;
}

/**
 * Whether two entries say literally the same thing: the same namespace and the same address.
 *
 * Exact only. `skill: core.*` does **not** absorb `skill: core.a`, even though everything the second
 * selects the first selects too. Subsumption is not implemented, so two entries where one is
 * redundant simply stay two entries.
 */
export function sameEntry(a: PatternEntry, b: PatternEntry): boolean {
  return a.kind === b.kind && a.pattern === b.pattern && a.catalog === b.catalog;
}

/**
 * A `requires` list with literal duplicates dropped, keeping the first of each and the order the
 * list was written in.
 *
 * Order-preserving rather than sorted, because this reads a list rather than rewriting one: sorting
 * a document's own entries would be reformatting the author did not ask for. Anything downstream
 * needing a total order can sort over {@link formatEntry}.
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
 * Literal rather than guessed: the alias is the reader's to pick, from their own `catalogs:`.
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
 * Names what a bare pattern fails to say rather than guessing it, since the namespace is the whole
 * of what this grammar declares and there is no shorthand for it.
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
 * Unknown keys are rejected first, so a leftover `tag:` or `capabilities:` reads as an unknown key
 * rather than as an entry naming no namespace.
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
 * Returned in the order it was written, duplicates included. Deduplication is
 * {@link uniqueEntries}, kept as a separate step because a caller merging several lists wants to
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
    // A `PositionedString` is a bare pattern; everything else the sequence could hold was already
    // refused by `optionalEntryList`.
    if (!(item instanceof YamlMapping)) throw bareEntry(mapping, item, addressing);
    return parseEntry(item, addressing);
  });
}

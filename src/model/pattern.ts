/**
 * How a selection is written down, and what it selects: the `requires` entry and its glob.
 *
 * One addressing scheme, shared by the two places a selection is written. A project's `requires`
 * says which of the catalogs it listed to take items from; a skill's own `requires` says which of
 * its siblings it cannot work without. Both are the same entry, and the only difference is whether
 * the address carries a catalog — see {@link Addressing}.
 *
 * ```yaml
 * requires:
 *   - tag: "company/function.engineering" # everything the author tagged for engineers
 *     capabilities: [skills, mcps, hooks]
 *   - name: "company/core.*" # everything beneath the `core` name prefix
 *     capabilities: [skills]
 *   - name: "company/guards.*"
 *     capabilities: [hooks]
 * ```
 *
 * **Both keys are declared, neither is guessed.** This is the rule c9494df established for
 * namespaces — a bare name cannot say which namespace it is in, because a skill at
 * `skills/mcp/sentry/SKILL.md` is legitimately named `mcp.sentry` — applied one level further: a
 * bare *pattern* cannot say which **field** it matches either, since `function.engineering` is a
 * plausible name prefix and a plausible tag. So an entry names the field, and the reason a report
 * gives for an item's presence names it too, because a reason that cannot say which of the two
 * matched is not an answer.
 *
 * **`capabilities` is required, not defaulted.** Defaulting it to all three is tempting — it is
 * what a held scope did, and it is what would make a one-line entry possible — and it is refused
 * because **hooks execute**. An entry someone wrote thinking about skills would silently install
 * every hook carrying that tag, which is exactly the class of surprise a hook's opt-in exists to
 * prevent. The cost is real and accepted: the common single-namespace entry is two lines rather
 * than one.
 *
 * **A capability *list*, rather than a `<kind>.<field>` key per entry.** Selection by tag is
 * inherently multi-namespace: an author tags a skill, a server and a hook for the same audience,
 * and one entry has to be able to take all three, or this is a regression against the held scope it
 * replaces — three entries saying what one scope said. The list is also the extension point: a
 * fourth capability is a member of {@link CAPABILITIES}, not a new key prefix on every entry.
 *
 * **No bare shorthand.** No spelling omits `capabilities`, and none omits the field. Adding a
 * shorthand later is backward-compatible; removing one is not.
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
import { YamlMapping } from "./yaml.js";
import type { PositionedString } from "./yaml.js";

/**
 * The key a selection list is written under, in a project config and in a skill's `ambit:` block
 * alike.
 *
 * One word for both, because it is one operator: everything an entry names joins the bundle. The
 * two differ in what an address may say, not in what the list means.
 */
export const REQUIRES_KEY = "requires";

/** The key inside one entry that says which namespaces the pattern is matched against. */
export const CAPABILITIES_KEY = "capabilities";

/**
 * The namespaces an entry may select, in the order every report lists them.
 *
 * Plural, unlike `ITEM_KINDS`' singular `skill`/`mcp`/`hook`, because an entry selects a *set* from
 * each namespace it names rather than one member of one — `capabilities: [skills]` reads as the
 * question it is asking. {@link CAPABILITY_OF_KIND} is the bridge between the two vocabularies, so
 * no caller has to invent one.
 *
 * This order is also the canonical one a parsed entry's list is normalized into, which is what makes
 * literal equality between two entries independent of the order an author wrote a set in.
 */
export const CAPABILITIES = ["skills", "mcps", "hooks"] as const;

/** One namespace an entry may select from. */
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Which capability a bundle item's kind belongs to.
 *
 * The one place the singular and plural vocabularies are related, so a caller iterating a merged
 * catalog's `skills` can ask whether an entry selects them without hard-coding the pairing a second
 * time.
 */
export const CAPABILITY_OF_KIND: Readonly<Record<ItemKind, Capability>> = {
  skill: "skills",
  mcp: "mcps",
  hook: "hooks",
};

/**
 * The fields a pattern may be matched against, in the order every message lists them.
 *
 * Two, and they answer different needs. A **name** gives the consumer a selector that does not
 * depend on the author having labelled anything, at the cost of making a catalog's layout public
 * API. A **tag** gives the author one that does not depend on layout, and is the only one of the two
 * that can express *this skill serves both sales and engineering*. Neither is a registry.
 */
export const PATTERN_FIELDS = ["name", "tag"] as const;

/** Which field of an item an entry's pattern is matched against. */
export type PatternField = (typeof PATTERN_FIELDS)[number];

/**
 * Which spelling of an address a `requires` list is written in.
 *
 * - `"qualified"` — `<catalog>/<pattern>`, **mandatory in a project config**. A project is where
 *   the aliases in `catalogs:` are declared, so it is the only document that can name one, and
 *   without the qualifier `core.*` would mean *whichever catalog happens to hold a match*, which is
 *   the config-order dependence this addressing scheme removes.
 * - `"unqualified"` — the bare pattern, **mandatory inside a catalog**. A catalog author cannot
 *   write a qualifier correctly: the alias belongs to the consumer's config, and the same catalog is
 *   `company` in one project and `acme` in the next. So a skill's `requires` names its siblings
 *   unqualified and resolves within its own catalog, which is what makes a catalog self-contained —
 *   it can only require what it ships.
 *
 * A qualifier where it is refused, and a missing one where it is required, are both exit 2 naming
 * the key and the line, rather than a value quietly resolved against a guess.
 */
export type Addressing = "qualified" | "unqualified";

/**
 * One entry of a `requires` list: which field to match, the pattern to match it with, and which
 * namespaces to match it against.
 *
 * This is the shape the design means by *`Requirement` becomes `{field, pattern, capabilities}`*.
 * It is not a {@link ItemKind}-and-name pair and cannot be one: an entry is a *question* about a
 * catalog, answered by zero or more items, where a bundle item is one item of one kind.
 */
export interface PatternEntry {
  /** Which field of an item {@link PatternEntry.pattern} is matched against. */
  readonly field: PatternField;
  /**
   * The glob, with the qualifier stripped off — see {@link matchesPattern}.
   *
   * Never holds a {@link CATALOG_SEPARATOR}: the address is split at parse time, so everything
   * downstream matches a pattern against a name or a tag and never has to re-split anything.
   */
  readonly pattern: string;
  /**
   * The catalog alias the pattern is scoped to, present exactly when the entry was parsed as
   * `"qualified"`.
   *
   * Absent is not *any catalog*. An unqualified entry is catalog-blind by construction, and it is
   * the caller resolving one — a catalog's own `requires` — that must offer it only that catalog's
   * items. {@link matches} cannot enforce that rule, because an unqualified entry does not carry the
   * catalog it would be enforced against.
   */
  readonly catalog?: string;
  /**
   * Which namespaces to match against: non-empty, deduplicated, and in {@link CAPABILITIES}' order.
   *
   * Normalized rather than kept as written because nothing prints it — a selection reason names the
   * field and the pattern and stops there — and because two entries that name the same set in a
   * different order are the same entry, which deduplication has to be able to see.
   */
  readonly capabilities: readonly Capability[];
}

/**
 * One item, of one namespace, as a pattern is matched against it.
 *
 * A structural shape rather than a merged-catalog type, so this module needs to know nothing about
 * how an item is loaded: a `MergedSkill`, a `MergedMcp` and a `MergedHook` all satisfy it once the
 * caller says which capability the array it is walking holds.
 */
export interface PatternItem {
  /** Which namespace this item is in — `CAPABILITY_OF_KIND[kind]` where a kind is what is at hand. */
  readonly capability: Capability;
  /** The catalog the item came from, which a qualified entry is matched against. */
  readonly catalog: string;
  /** The item's name inside its namespace, dotted — `core.house-style`. */
  readonly name: string;
  /** The item's declared tags, free-form and registered nowhere. */
  readonly tags: readonly string[];
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

/** What separates a field from the address it applies to, where only a string will do. */
const FIELD_SEPARATOR = ":";

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
 * How an entry is written where only a string will do — `tag:company/core`, `name:company/core.*`.
 *
 * The entry as written, minus the capability list: an item's own namespace is already known from the
 * section of a report it appears in, so repeating it would be noise, while the field cannot be
 * dropped for the reason the grammar declares it at all.
 */
export function formatEntry(entry: PatternEntry): string {
  return `${entry.field}${FIELD_SEPARATOR}${entryAddress(entry)}`;
}

/**
 * How an entry is written in a document, for a message telling someone to write one.
 *
 * A flow mapping, because a two-key entry does not fit block style on one line and advice that
 * spans lines is advice a reader has to reassemble. The pattern is quoted unconditionally: a
 * pattern is exactly the kind of string YAML would otherwise read as something else.
 */
export function entryYaml(entry: PatternEntry): string {
  const capabilities = entry.capabilities.join(", ");
  return `- { ${entry.field}: "${entryAddress(entry)}", ${CAPABILITIES_KEY}: [${capabilities}] }`;
}

/**
 * Whether two entries say literally the same thing: the same field, the same address, and the same
 * set of capabilities.
 *
 * Exact only. `tag: x` over `[skills, mcps]` does **not** absorb `tag: x` over `[skills]`, even
 * though everything the second selects the first selects too. Subsumption normalizing is a rabbit
 * hole — the honest version has to reason about one pattern's matches being a subset of another's —
 * and nobody has asked for it, so two entries one of which is redundant simply stay two entries.
 *
 * Capabilities are compared as a set rather than positionally, so an entry built in code is judged
 * on what it says and not on the order it happened to say it in. That is still exact equality: what
 * is refused above is comparing sets by *containment*.
 */
export function sameEntry(a: PatternEntry, b: PatternEntry): boolean {
  return (
    a.field === b.field &&
    a.pattern === b.pattern &&
    a.catalog === b.catalog &&
    a.capabilities.length === b.capabilities.length &&
    a.capabilities.every((capability) => b.capabilities.includes(capability))
  );
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
 * Three tests, all of which have to hold: the item's namespace is one the entry named, the item's
 * catalog is the one the entry qualified (when it qualified one — see
 * {@link PatternEntry.catalog}), and the pattern matches the field the entry declared.
 *
 * A tag match is *any* tag, because tags are a set an author attaches and an entry asks about one
 * label: a skill tagged for both sales and engineering is selected by either.
 */
export function matches(entry: PatternEntry, item: PatternItem): boolean {
  if (!entry.capabilities.includes(item.capability)) return false;
  if (entry.catalog !== undefined && entry.catalog !== item.catalog) return false;

  return entry.field === "name"
    ? matchesPattern(entry.pattern, item.name)
    : item.tags.some((tag) => matchesPattern(entry.pattern, tag));
}

/** The capabilities as a message lists them: `skills, mcps, hooks`. */
const CAPABILITY_LIST = CAPABILITIES.join(", ");

/** The fields as a message lists them: `` `name`, `tag` ``. */
const FIELD_LIST = PATTERN_FIELDS.map((field) => `\`${field}\``).join(", ");

/** Whether `value` is one of {@link CAPABILITIES}. */
function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The example every refusal that has an address to work with ends on.
 *
 * Written in the spelling the document being read demands, so a catalog author is never shown a
 * qualifier they cannot write, and a project is never shown a bare pattern it would refuse in turn.
 * `<catalog>` stands in literally when the reader has not written one: the alias is theirs to pick
 * and proposing a particular one would be a guess.
 */
function example(field: PatternField, address: string, addressing: Addressing): string {
  const bare = address.split(CATALOG_SEPARATOR).pop()!;
  const shown =
    addressing === "unqualified"
      ? bare
      : address.includes(CATALOG_SEPARATOR)
        ? address
        : `<catalog>${CATALOG_SEPARATOR}${address}`;
  return `write it as \`${entryYaml({ field, pattern: shown, capabilities: ["skills"] })}\``;
}

/**
 * The error for an entry written as a bare string — the shape a plain list of patterns has.
 *
 * Names both things a bare pattern fails to say rather than guessing either, because the two
 * declarations are the whole of what this grammar adds and a shorthand that filled them in is the
 * spelling it deliberately does not have.
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
      `a bare pattern says neither which field it matches (${FIELD_LIST}) nor which capabilities it selects`,
      example("name", item.value, addressing),
    ],
  );
}

/** The error for an entry declaring neither field, or both of them. */
function badField(entry: YamlMapping, declared: readonly PatternField[]): AmbitError {
  const advice = [
    `an entry declares exactly one field: ${FIELD_LIST} — "function.engineering" is a plausible name prefix and a plausible tag`,
    declared.length === 0
      ? `add \`name:\` or \`tag:\` with the pattern to match`
      : `split it into one entry per field`,
  ];

  const first = declared[0];
  return first === undefined
    ? configError(
        `\`${REQUIRES_KEY}\` entry matches on no field ${at(entry.file, entry.line)}`,
        advice,
      )
    : entry.keyError(first, `\`${REQUIRES_KEY}\` entry matches on both ${FIELD_LIST}`, advice);
}

/** The error for an address the demanded {@link Addressing} refuses. */
function badAddress(
  entry: YamlMapping,
  field: PatternField,
  address: string,
  addressing: Addressing,
  problem: string,
  fix: string,
): AmbitError {
  return entry.keyError(field, `\`${REQUIRES_KEY}\` entry "${address}" ${problem}`, [
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
  field: PatternField,
  address: string,
  addressing: Addressing,
): { readonly catalog?: string; readonly pattern: string } {
  const parts = address.split(CATALOG_SEPARATOR);

  if (addressing === "unqualified") {
    if (parts.length === 1) return { pattern: address };
    throw badAddress(
      entry,
      field,
      address,
      addressing,
      "names a catalog, which a catalog's own `requires` may not",
      example(field, address, addressing),
    );
  }

  if (parts.length === 1) {
    throw badAddress(
      entry,
      field,
      address,
      addressing,
      "names no catalog",
      `qualify it: \`<catalog>${CATALOG_SEPARATOR}${address}\`, using an alias from \`catalogs:\``,
    );
  }
  if (parts.length > 2) {
    throw badAddress(
      entry,
      field,
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
      field,
      address,
      addressing,
      "names an empty catalog",
      `write the alias before the \`${CATALOG_SEPARATOR}\``,
    );
  }
  if (pattern === "") {
    throw badAddress(
      entry,
      field,
      address,
      addressing,
      "names an empty pattern",
      `write \`${catalog}${CATALOG_SEPARATOR}${WILDCARD}\` for the whole catalog`,
    );
  }

  return { catalog, pattern };
}

/**
 * The capabilities an entry names, normalized into {@link CAPABILITIES}' order.
 *
 * Absent and empty are separate refusals with separate messages, because they are separate
 * mistakes: one is an entry written in a grammar that has a default, and this one does not; the
 * other is an entry that says outright it selects nothing.
 */
function parseCapabilities(
  entry: YamlMapping,
  field: PatternField,
  address: string,
): readonly Capability[] {
  const written = entry.optionalStringList(CAPABILITIES_KEY);

  if (written === undefined) {
    throw entry.keyError(field, `\`${REQUIRES_KEY}\` entry "${address}" declares no capabilities`, [
      "`capabilities` is not defaulted, because hooks execute: an entry written thinking about skills must not silently install every hook the pattern matches",
      `add \`${CAPABILITIES_KEY}:\` with one or more of: ${CAPABILITY_LIST}`,
    ]);
  }
  if (written.length === 0) {
    throw entry.keyError(
      CAPABILITIES_KEY,
      `\`${REQUIRES_KEY}\` entry "${address}" selects no capabilities`,
      [
        "an empty list matches nothing, so the entry does nothing",
        `give it one or more of: ${CAPABILITY_LIST}, or remove the entry`,
      ],
    );
  }

  for (const value of written) {
    if (isCapability(value)) continue;
    throw entry.keyError(
      CAPABILITIES_KEY,
      `unknown capability "${value}" in \`${REQUIRES_KEY}\` entry "${address}"`,
      [`capabilities are: ${CAPABILITY_LIST}`, `replace \`${value}\` with one of them`],
    );
  }

  // Filtered out of the canonical order rather than sorted, so the result is deduplicated and
  // ordered in one step and does not depend on how an author spelled the set.
  return CAPABILITIES.filter((capability) => written.includes(capability));
}

/**
 * Parses one `requires` entry: a two-key mapping naming a field and its capabilities.
 *
 * Unknown keys are refused first, so a typo'd `tags:` reads as the typo it is rather than as an
 * entry that declares no field.
 */
function parseEntry(entry: YamlMapping, addressing: Addressing): PatternEntry {
  entry.rejectUnknownKeys([...PATTERN_FIELDS, CAPABILITIES_KEY]);

  const declared = PATTERN_FIELDS.filter((candidate) => entry.has(candidate));
  const field = declared.length === 1 ? declared[0]! : undefined;
  if (field === undefined) throw badField(entry, declared);

  const address = entry.requireString(field);
  const { catalog, pattern } = splitAddress(entry, field, address, addressing);
  const capabilities = parseCapabilities(entry, field, address);

  return { field, pattern, ...(catalog !== undefined && { catalog }), capabilities };
}

/**
 * Parses a `requires` list: a sequence of two-key mappings, each a field-and-pattern and the
 * capabilities to match it against.
 *
 * The list is returned in the order it was written, duplicates included — deduplication is
 * {@link uniqueEntries}, and it is a separate step because a caller merging several lists wants to
 * dedupe the union rather than each part.
 *
 * @param mapping the block the key sits in — a project's config root, a skill's `ambit:`.
 * @param addressing which spelling this document demands; see {@link Addressing}.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one declaring no field or both,
 *   one whose capabilities are missing, empty or unknown, or an address the spelling refuses.
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

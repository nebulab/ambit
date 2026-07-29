/**
 * The `<kind>:<name>` grammar, and the machinery both lists written in it share.
 *
 * A skill declares two lists, and they are different operators wearing one spelling. `requires` is
 * **resolved** — every entry is a catalog item that joins the bundle, and one nothing provides fails the
 * install. `expects` is **checked** — every entry is a fact about the world `doctor` asks about, and one
 * the world does not satisfy leaves the install alone and fails `doctor`. Two algebras, two exit codes,
 * two stories; see `requirement.ts` and `expectation.ts` for each.
 *
 * What they share is how an entry is *written*, and that is this module. An entry declares which kind it
 * is rather than encoding it in a prefix of the name, because a name cannot say: a catalog's three
 * namespaces are flat and independent, so a skill at `skills/mcp/sentry/SKILL.md` is legitimately named
 * `mcp.sentry` and so is an MCP entity called `sentry` reached one namespace over. In a document that is
 * a one-key mapping, the same discriminator an MCP entity's `transport` uses:
 *
 * ```yaml
 * ambit:
 *   requires:
 *     - skill: company-context
 *     - mcp: sentry
 *   expects:
 *     - env: SENTRY_TOKEN
 * ```
 *
 * On a command line, where a mapping cannot be written, it is {@link formatReference}'s
 * `<kind>:<name>` — `mcp:sentry`, `env:SENTRY_TOKEN`. The separator is what makes it a declaration
 * rather than a guess: a kind is mandatory and is matched against a closed set, so `skill:mcp.sentry`
 * names the skill above and `mcp:sentry` names the server, with no string a reader could write that
 * means both.
 *
 * One grammar, everywhere a name is taken from a person: an entry of either list, and the subject of
 * `ambit why`, all say which kind they mean, and none of them will guess. A bare name is refused with
 * the spellings of what was typed ({@link parseSubject}) rather than resolved against the catalog,
 * because a rule that holds only while a name happens to be unique is a rule nobody can rely on — and
 * because a dangling entry has nothing to resolve against: `ambit why` and a `requires` naming
 * something that has gone both have to be able to say the name back.
 *
 * Everything here is parameterized by a {@link ReferenceGrammar}, which is the list's closed set of
 * kinds and the handful of words a message about one of them needs. That is what keeps the two lists
 * from drifting into two grammars: adding `bin:` to `expects` is a line in one array, and every error,
 * every flag and every writer follows it.
 */
import { at, configError } from "../errors.js";
import type { AmbitError } from "../errors.js";
import { YamlMapping } from "./yaml.js";

/** What separates a kind from a name on a command line. */
export const KIND_SEPARATOR = ":";

/**
 * One member of one kind: which kind, and the name inside it.
 *
 * The shape an entry parses to, and — for a `requires` entry — the shape resolution identifies a bundle
 * item by. One type rather than two, because it is one question, and two would let a requirement name
 * something no bundle item could be.
 */
export interface Reference<Kind extends string = string> {
  readonly kind: Kind;
  readonly name: string;
}

/**
 * What one list's kinds are, and the words a message about one of them is written in.
 *
 * Wording is data here rather than a string in each error, because the two lists say the same things
 * about different vocabularies — an entry that names no kind, one that names two, one whose kind is not
 * in the set — and writing those messages twice is how the two grammars would come to disagree about
 * what they accept.
 */
export interface ReferenceGrammar {
  /** The key the list is written under: `requires`, `expects`. */
  readonly key: string;
  /** How one entry is named in a sentence, article included: `` a `requires` entry ``. */
  readonly entry: string;
  /** What one kind is, singular then plural: `namespace`/`namespaces`, `precondition`/`preconditions`. */
  readonly noun: string;
  readonly plural: string;
  /** How a bare name falls short: `which namespace it is in`, `what kind of precondition it is`. */
  readonly missing: string;
  /** What a name in this grammar picks out, generically: `item`, `value`. */
  readonly named: string;
  /** The kinds, in the order every report lists them. The first is the one an example is written in. */
  readonly kinds: readonly string[];
  /** What a member of each kind is called, with an article: `a skill`, `an environment variable`. */
  readonly members: Readonly<Record<string, string>>;
  /**
   * The entry a bare string was most likely meant to be, for the one message that can propose one.
   *
   * Optional, and used only to add a line: a grammar that cannot read anything out of a bare name
   * simply offers the example every refusal offers.
   */
  readonly guess?: (value: string) => Reference | undefined;
}

/** A grammar whose kinds are known to be `Kind`, so what it parses is typed as narrowly as it is. */
export type ReferenceGrammarOf<Kind extends string> = Omit<ReferenceGrammar, "kinds"> & {
  readonly kinds: readonly Kind[];
};

/**
 * How a reference is written where only a string will do: a flag's value, an error's next step,
 * a report's cell.
 *
 * The inverse of {@link parseReference}, and the one function that spells the pair — so the advice an
 * error gives cannot disagree with what the flag it names accepts.
 */
export function formatReference(item: Reference): string {
  return `${item.kind}${KIND_SEPARATOR}${item.name}`;
}

/** How a reference is written in a document, for a message telling someone to write one. */
export function referenceYaml(item: Reference): string {
  return `- ${item.kind}: ${item.name}`;
}

/** Whether two references name the same thing. */
export function sameReference(a: Reference, b: Reference): boolean {
  return a.kind === b.kind && a.name === b.name;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A reference list sorted and deduplicated, ordered by {@link formatReference} — so a list groups by
 * kind and is a function of its members alone, whatever order an author wrote them in.
 */
export function sortedUniqueReferences<Kind extends string>(
  items: readonly Reference<Kind>[],
): readonly Reference<Kind>[] {
  const byRef = new Map(items.map((item) => [formatReference(item), item]));
  return [...byRef.keys()].sort(compare).map((ref) => byRef.get(ref)!);
}

/** The kinds as an error lists them: `skill, mcp, hook`. */
function kindList(grammar: ReferenceGrammar): string {
  return grammar.kinds.join(", ");
}

/** Whether `value` is one of the grammar's kinds. */
function isKind<Kind extends string>(
  grammar: ReferenceGrammarOf<Kind>,
  value: string,
): value is Kind {
  return (grammar.kinds as readonly string[]).includes(value);
}

/**
 * The example every refusal ends on: the grammar's first kind, applied to what was typed.
 *
 * The first rather than a chosen one, because {@link ReferenceGrammar.kinds} is already in the order
 * every report lists them, and the leading kind is the one a reader most often meant — `skill` for a
 * requirement, `env` for an expectation.
 */
function example(grammar: ReferenceGrammar, text: string): string {
  const kind = grammar.kinds[0]!;
  return `for ${grammar.members[kind]} called "${text}", that is \`${kind}${KIND_SEPARATOR}${text}\``;
}

/**
 * The error for a command-line reference whose kind is missing or is not one of the grammar's.
 *
 * @param where the `(file line N)` suffix, as {@link at} renders it, or an empty string.
 */
function badReference(
  grammar: ReferenceGrammar,
  text: string,
  problem: string,
  where: string,
): AmbitError {
  const suffix = where === "" ? "" : ` ${where}`;
  return configError(`\`${text}\` does not name a ${grammar.noun}${suffix}`, [
    problem,
    `write it as \`<kind>${KIND_SEPARATOR}<name>\`, one of: ${kindList(grammar)}`,
    example(grammar, text),
  ]);
}

/**
 * The reference a `<kind>:<name>` string names.
 *
 * Split on the *first* separator, so a name carrying one of its own survives the round trip:
 * `skill:odd:name` is the skill `odd:name`, and nothing else can be read out of it.
 *
 * @param where the `(file line N)` suffix for a refusal, or `""` when the caller has no file to cite.
 * @throws {AmbitError} exit 2 when no kind is given, or the kind is not one of the grammar's.
 */
export function parseReference<Kind extends string>(
  grammar: ReferenceGrammarOf<Kind>,
  text: string,
  where = "",
): Reference<Kind> {
  const separator = text.indexOf(KIND_SEPARATOR);
  if (separator === -1) {
    throw badReference(grammar, text, `a bare name does not say ${grammar.missing}`, where);
  }

  const kind = text.slice(0, separator);
  const name = text.slice(separator + KIND_SEPARATOR.length);

  if (!isKind(grammar, kind)) {
    throw badReference(grammar, text, `"${kind}" is not a ${grammar.noun}`, where);
  }
  if (name === "") {
    throw badReference(
      grammar,
      text,
      `\`${kind}${KIND_SEPARATOR}\` names no ${grammar.named}`,
      where,
    );
  }

  return { kind, name };
}

/**
 * Whether a string is written as a reference of this grammar at all — a known kind, then the separator.
 *
 * Recognized by its kind rather than by the mere presence of a `:`, so a name that happens to carry one
 * of its own is a bare name and gets {@link parseSubject}'s refusal, which explains the grammar, rather
 * than a confusing complaint about a namespace called `odd`.
 */
export function isReference(grammar: ReferenceGrammar, text: string): boolean {
  return grammar.kinds.some((kind) => text.startsWith(`${kind}${KIND_SEPARATOR}`));
}

/**
 * The thing a command's subject argument names.
 *
 * A subject is taken the same way wherever one is taken — `ambit why` is the command that takes one —
 * so the grammar is explained in the same words as the lists it shares, and there is one rule to learn
 * rather than one per surface.
 *
 * Every spelling of what was typed is offered rather than one of them assumed: a bare name names none
 * of the kinds in particular, and guessing is what this format exists to stop.
 *
 * @param summary how the command names what it is missing — `` `why acme` does not say what to
 *   explain `` — since only that half differs between them.
 * @throws {AmbitError} exit 2 for a bare name, or a kind the grammar does not hold.
 */
export function parseSubject<Kind extends string>(
  grammar: ReferenceGrammarOf<Kind>,
  text: string,
  summary: string,
): Reference<Kind> {
  if (isReference(grammar, text)) return parseReference(grammar, text);

  throw configError(summary, [
    "a bare name does not say what kind of thing it names",
    `write the subject as one of: ${grammar.kinds.map((kind) => `\`${kind}${KIND_SEPARATOR}${text}\``).join(", ")}`,
  ]);
}

/**
 * The error for an entry written as a bare string — the shape a list of plain names has.
 *
 * Names every spelling rather than guessing the intended one: a bare `mcp.sentry` could mean either the
 * server `sentry` or a skill of that exact name, which is the ambiguity the mapping form exists to
 * remove, so resolving it here would reintroduce it. A grammar that *can* read something out of the
 * string ({@link ReferenceGrammar.guess}) contributes one extra line, never a decision.
 */
function bareEntry(grammar: ReferenceGrammar, mapping: YamlMapping, value: string): AmbitError {
  const suggestion = grammar.guess?.(value);
  const kind = grammar.kinds[0]!;

  return mapping.keyError(
    grammar.key,
    `\`${grammar.key}\` entry "${value}" names no ${grammar.noun}`,
    [
      `an entry says ${grammar.missing}: ${grammar.kinds.map((one) => `\`${one}:\``).join(", ")}`,
      ...(suggestion === undefined
        ? []
        : [
            `for ${grammar.members[suggestion.kind]} named "${suggestion.name}", that is \`${referenceYaml(suggestion)}\``,
          ]),
      `for ${grammar.members[kind]} named "${value}", that is \`${referenceYaml({ kind, name: value })}\``,
    ],
  );
}

/** The error for an entry mapping that names none of the grammar's kinds, or more than one. */
function ambiguousEntry(
  grammar: ReferenceGrammar,
  entry: YamlMapping,
  keys: readonly string[],
): AmbitError {
  const [first] = keys;
  const advice = [`an entry is one key: ${kindList(grammar)}`, "give it exactly one of them"];

  return first === undefined
    ? configError(`${grammar.entry} names no ${grammar.noun} ${at(entry.file, entry.line)}`, advice)
    : entry.keyError(
        first,
        `${grammar.entry} names ${keys.length} ${grammar.plural}: ${[...keys].sort(compare).join(", ")}`,
        advice,
      );
}

/**
 * Parses a reference list: a sequence of one-key mappings, each naming a kind and a name in it.
 *
 * The list is returned in the order it was written. Sorting is the business of whichever command
 * *rewrites* one ({@link sortedUniqueReferences}); a list ambit merely read keeps the author's order,
 * because reordering it is the reformatting authoring rule 2 forbids.
 *
 * @param mapping the block the key sits in — a skill's `ambit:`, an entity's whole document.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one that names no kind or several, or
 *   one whose value is not a string.
 */
export function parseReferenceList<Kind extends string>(
  grammar: ReferenceGrammarOf<Kind>,
  mapping: YamlMapping,
): readonly Reference<Kind>[] {
  const entries = mapping.optionalEntryList(grammar.key);
  if (entries === undefined) return [];

  return entries.map((entry) => {
    // A `PositionedString` is a list of plain names, the one shape with a spelling to describe;
    // everything else the sequence could hold was already refused by `optionalEntryList`.
    if (!(entry instanceof YamlMapping)) throw bareEntry(grammar, mapping, entry.value);

    const keys = entry.keys();
    if (keys.length !== 1) throw ambiguousEntry(grammar, entry, keys);

    const kind = keys[0]!;
    if (!isKind(grammar, kind)) {
      throw entry.keyError(kind, `unknown ${grammar.noun} "${kind}" in ${grammar.entry}`, [
        `an entry is one key: ${kindList(grammar)}`,
        `replace \`${kind}\` with one of them`,
      ]);
    }

    return { kind, name: entry.requireString(kind) };
  });
}

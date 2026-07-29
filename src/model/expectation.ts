/**
 * What an `expects` entry names: a fact about the world that has to be true for the thing to work.
 *
 * `expects` is not `requires` with a different vocabulary. A requirement is **resolved** — it selects
 * catalog items by pattern, they join the bundle, and an entry that selects nothing fails the install at
 * exit 3. An expectation is **checked** — nothing provides it, no two catalogs can offer competing
 * copies of it, it cannot expect anything back and it cannot cycle. `doctor` asks the world about it, and a world that says no leaves
 * the install alone and fails at exit 6.
 *
 * ```yaml
 * ambit:
 *   requires: # resolved into the bundle; exit 3 if it matches nothing
 *     - name: close
 *       capabilities: [mcps]
 *   expects: # checked by `doctor`; exit 6 if unsatisfied
 *     - env: CLOSE_API_KEY
 * ```
 *
 * `env:` is its only kind today, and the list exists rather than a bare `env:` key because it is the
 * shape the *next* precondition arrives in. A skill whose instructions shell out to `docker` or `gh` has
 * a precondition it cannot write down, and `doctor` is already the right surface to check `PATH` — so
 * `bin:` is one entry in {@link EXPECTATION_KINDS} and one case in `doctor`, rather than another
 * top-level list beside `env:` that means *check this* all over again.
 *
 * Unlike `requires`, this is the one annotation every kind of catalog entity carries: a skill reads
 * variables at runtime, a server reads its own credentials, and a hook's command reads whatever the
 * shell the harness spawns hands it.
 *
 * It is also the last list written as one-key `<kind>: <name>` mappings, and the reader for that shape
 * is here rather than in `reference.ts`: the parameterized grammar the two lists shared collapsed when
 * `requires` left for `pattern.ts`, because a document list and `ambit why`'s command-line subject turn
 * out to share no reader at all — see `reference.ts`' header. So the words a refusal here is written in
 * sit next to the thing they describe.
 *
 * An entry declares its kind rather than encoding it in the value, using the same one-key discriminator
 * an MCP entity's `transport` does. Nothing guesses: a bare `expects: [CLOSE_API_KEY]` is refused with
 * the spelling it was missing rather than read as an environment variable, because `env` being the only
 * kind today is a fact about today and a shorthand is not removable once written.
 */
import { at, configError } from "../errors.js";
import type { AmbitError } from "../errors.js";
import type { Reference } from "./reference.js";
import { YamlMapping } from "./yaml.js";

/**
 * The kinds of precondition an `expects` entry can name, in the order every report lists them.
 *
 * One today. The list is the extension point: `bin:` for a program that must be on the `PATH`, a
 * minimum harness version, a file that must exist — each of them lands here, in `doctor`, and nowhere
 * else, because every surface that reads an entry reads this array to know what one may say.
 */
export const EXPECTATION_KINDS = ["env"] as const;

/** Which kind of precondition an entry states. */
export type ExpectationKind = (typeof EXPECTATION_KINDS)[number];

/** One precondition: which kind, and what it names inside that kind. */
export type Expectation = Reference<ExpectationKind>;

/** What a precondition of each kind is called in a message about one. */
export const EXPECTATION_NOUNS: Readonly<Record<ExpectationKind, string>> = {
  env: "an environment variable",
};

/** The key the list is written under, wherever one is written. */
const EXPECTS_KEY = "expects";

/** The kinds as a refusal lists them. Singular today, and a list because it will not be. */
function kindList(): string {
  return EXPECTATION_KINDS.join(", ");
}

/** How an expectation is written in a document, for a message telling someone to write one. */
function expectationYaml(item: Expectation): string {
  return `- ${item.kind}: ${item.name}`;
}

/** Whether `value` is one of the kinds of precondition. */
function isExpectationKind(value: string): value is ExpectationKind {
  return (EXPECTATION_KINDS as readonly string[]).includes(value);
}

/**
 * The error for an entry written as a bare string — the shape a list of plain names has.
 *
 * Names the spelling rather than assuming it: `expects: [CLOSE_API_KEY]` is *probably* an environment
 * variable, because that is the only kind there is, but reading it as one is the shorthand this format
 * refuses — and a `bin:` arriving later would make yesterday's guess wrong in a file nobody edited.
 */
function bareEntry(mapping: YamlMapping, value: string): AmbitError {
  const kind = EXPECTATION_KINDS[0];

  return mapping.keyError(
    EXPECTS_KEY,
    `\`${EXPECTS_KEY}\` entry "${value}" names no precondition`,
    [
      `an entry says what kind of precondition it is: ${EXPECTATION_KINDS.map((one) => `\`${one}:\``).join(", ")}`,
      `for ${EXPECTATION_NOUNS[kind]} named "${value}", that is \`${expectationYaml({ kind, name: value })}\``,
    ],
  );
}

/** The error for an entry mapping that names no kind of precondition, or more than one. */
function ambiguousEntry(entry: YamlMapping, keys: readonly string[]): AmbitError {
  const [first] = keys;
  const advice = [`an entry is one key: ${kindList()}`, "give it exactly one of them"];

  return first === undefined
    ? configError(
        `an \`${EXPECTS_KEY}\` entry names no precondition ${at(entry.file, entry.line)}`,
        advice,
      )
    : entry.keyError(
        first,
        `an \`${EXPECTS_KEY}\` entry names ${keys.length} preconditions: ${[...keys].sort(compare).join(", ")}`,
        advice,
      );
}

/**
 * Parses an `expects` list: a sequence of one-key mappings, each naming a kind and a value in it.
 *
 * The list is returned in the order it was written. Nothing here sorts it — ambit only ever reads one,
 * and reordering a list it merely read is the reformatting authoring rule 2 forbids.
 *
 * @param mapping the block the key sits in — a skill's `ambit:`, or an entity's whole document.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one that names no kind or several, or
 *   one whose value is not a string.
 */
export function parseExpectations(mapping: YamlMapping): readonly Expectation[] {
  const entries = mapping.optionalEntryList(EXPECTS_KEY);
  if (entries === undefined) return [];

  return entries.map((entry) => {
    // A `PositionedString` is a list of plain names, the one shape with a spelling to describe;
    // everything else the sequence could hold was already refused by `optionalEntryList`.
    if (!(entry instanceof YamlMapping)) throw bareEntry(mapping, entry.value);

    const keys = entry.keys();
    if (keys.length !== 1) throw ambiguousEntry(entry, keys);

    const kind = keys[0]!;
    if (!isExpectationKind(kind)) {
      throw entry.keyError(kind, `unknown precondition "${kind}" in an \`${EXPECTS_KEY}\` entry`, [
        `an entry is one key: ${kindList()}`,
        `replace \`${kind}\` with one of them`,
      ]);
    }

    return { kind, name: entry.requireString(kind) };
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The environment variables an `expects` list names, sorted and deduplicated.
 *
 * The one projection with callers outside `doctor`: a harness config passes a server's variables
 * through to the process it spawns, and the value it needs is a list of names rather than of entries.
 * Here rather than at each call site so a second kind arriving cannot leak into a `env` map.
 */
export function expectedEnv(expects: readonly Expectation[]): readonly string[] {
  return [...new Set(expects.filter((item) => item.kind === "env").map((item) => item.name))].sort(
    compare,
  );
}

/**
 * Every expectation a set of declarers states, grouped by kind — the shape a bundle reports.
 *
 * Grouped rather than flat, and with every kind present even when empty, so the key a consumer reads is
 * a function of {@link EXPECTATION_KINDS} rather than of what this particular project happens to
 * declare. A `bin` key that appears only in projects that use one is a shape nobody can write against.
 */
export type ExpectationSet = Readonly<Record<ExpectationKind, readonly string[]>>;

/** The union of several `expects` lists, grouped by kind and sorted within each. */
export function unionExpectations(lists: readonly (readonly Expectation[])[]): ExpectationSet {
  const all = lists.flat();
  const grouped = {} as { -readonly [K in ExpectationKind]: readonly string[] };

  for (const kind of EXPECTATION_KINDS) {
    grouped[kind] = [
      ...new Set(all.filter((item) => item.kind === kind).map((item) => item.name)),
    ].sort(compare);
  }

  return grouped;
}

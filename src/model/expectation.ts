/**
 * What an `expects` entry names: a fact about the world that has to be true for the thing to work.
 *
 * `expects` differs from `requires`: a requirement is **resolved** — it selects catalog items by
 * pattern, and an entry matching nothing fails install at exit 3. An expectation is **checked** —
 * nothing provides it, no two catalogs can offer competing copies of it, it cannot expect anything
 * back, and it cannot cycle. `doctor` asks the world about it; if the world says no, the install is
 * left alone and `doctor` fails at exit 6.
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
 * `env:` is the only kind today. It is a list rather than a bare `env:` key because a skill that
 * shells out to `docker` or `gh` has a precondition — the binary being on `PATH` — that does not fit
 * `env:`. Adding it later means one more entry in {@link EXPECTATION_KINDS} and one more case in
 * `doctor`, not a second top-level list.
 *
 * `expects` is the one annotation every kind of catalog entity carries: a skill reads variables at
 * runtime, a server reads its own credentials, and a hook's command reads whatever the shell the
 * harness spawns hands it.
 *
 * This is also the last list still written as one-key `<kind>: <name>` mappings. Its reader lives
 * here, not in `reference.ts`, because the shared parameterized grammar collapsed once `requires`
 * moved to `pattern.ts` (see `reference.ts`'s header): a document list and `ambit why`'s
 * command-line subject turned out to share no reader at all.
 *
 * An entry declares its kind rather than encoding it in the value, the same one-key discriminator an
 * MCP entity's `transport` uses. Nothing guesses: a bare `expects: [CLOSE_API_KEY]` is refused
 * rather than read as an environment variable, since "`env` is the only kind today" is a fact about
 * today, not a shorthand that stays correct once a second kind is added.
 */
import { at, configError } from "../errors.js";
import type { AmbitError } from "../errors.js";
import type { Reference } from "./reference.js";
import { YamlMapping } from "./yaml.js";

/**
 * The kinds of precondition an `expects` entry can name, in the order every report lists them.
 *
 * One today. This is the extension point: `bin:` for a program that must be on the `PATH`, a
 * minimum harness version, a required file — each lands here, in `doctor`, and nowhere else, since
 * every surface that reads an entry reads this array to know what one may say.
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

/** The kinds as a refusal lists them. One today, but the join stays correct once more are added. */
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
 * Names the spelling rather than assuming it: `expects: [CLOSE_API_KEY]` is probably an environment
 * variable today, since that is the only kind, but treating it as one is the shorthand this format
 * refuses. A `bin:` kind arriving later would otherwise silently reinterpret a file nobody edited.
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
 * Returned in the order it was written; nothing here sorts it.
 *
 * @param mapping the block the key sits in — a skill's `ambit:`, or an entity's whole document.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one that names no kind or several,
 *   or one whose value is not a string.
 */
export function parseExpectations(mapping: YamlMapping): readonly Expectation[] {
  const entries = mapping.optionalEntryList(EXPECTS_KEY);
  if (entries === undefined) return [];

  return entries.map((entry) => {
    // A `PositionedString` is a plain name; everything else the sequence could hold was already
    // refused by `optionalEntryList`.
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
 * through to the process it spawns, and needs a list of names rather than of entries. Kept here,
 * rather than at each call site, so a second kind arriving cannot leak into an `env` map.
 */
export function expectedEnv(expects: readonly Expectation[]): readonly string[] {
  return [...new Set(expects.filter((item) => item.kind === "env").map((item) => item.name))].sort(
    compare,
  );
}

/**
 * Every expectation a set of declarers states, grouped by kind — the shape a bundle reports.
 *
 * Every kind is present even when empty, so the keys a consumer reads are fixed by
 * {@link EXPECTATION_KINDS} rather than by what a particular project happens to declare.
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

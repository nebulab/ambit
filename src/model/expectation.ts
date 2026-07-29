/**
 * What an `expects` entry names: a fact about the world that has to be true for the thing to work.
 *
 * `expects` is not `requires` with a different vocabulary. A requirement is **resolved** — it names a
 * catalog item, it is looked up, it joins the bundle, and one nothing provides fails the install at exit
 * 3. An expectation is **checked** — nothing provides it, no two catalogs can offer competing
 * copies of it, it cannot expect anything back and it cannot cycle. `doctor` asks the world about it, and a world that says no leaves
 * the install alone and fails at exit 6.
 *
 * ```yaml
 * ambit:
 *   requires: # resolved into the bundle; exit 3 if unsatisfiable
 *     - mcp: close
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
 * shell the harness spawns hands it. The spelling is `reference.ts`'s, shared with `requires`.
 */
import type { Reference, ReferenceGrammarOf } from "./reference.js";
import {
  formatReference,
  parseReference,
  parseReferenceList,
  referenceYaml,
  sameReference,
  sortedUniqueReferences,
} from "./reference.js";
import type { YamlMapping } from "./yaml.js";

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

/** How an `expects` entry is written, and the words a refusal about one uses. */
export const EXPECTS: ReferenceGrammarOf<ExpectationKind> = {
  key: "expects",
  entry: "an `expects` entry",
  noun: "precondition",
  plural: "preconditions",
  missing: "what kind of precondition it is",
  named: "value",
  kinds: EXPECTATION_KINDS,
  members: EXPECTATION_NOUNS,
};

/** How an expectation is written where only a string will do — `env:CLOSE_API_KEY`. */
export function formatExpectation(item: Expectation): string {
  return formatReference(item);
}

/** How an expectation is written in a document, for a message telling someone to write one. */
export function expectationYaml(item: Expectation): string {
  return referenceYaml(item);
}

/** Whether two expectations state the same thing. */
export function sameExpectation(a: Expectation, b: Expectation): boolean {
  return sameReference(a, b);
}

/** An expectation list sorted and deduplicated, so it groups by kind and then by name. */
export function sortedUniqueExpectations(items: readonly Expectation[]): readonly Expectation[] {
  return sortedUniqueReferences(items);
}

/**
 * The expectation a `<kind>:<name>` string names.
 *
 * @param where the `(file line N)` suffix for a refusal, or `""` when the caller has no file to cite.
 * @throws {AmbitError} exit 2 when no kind is given, or the kind is not one of
 *   {@link EXPECTATION_KINDS}.
 */
export function parseExpectation(text: string, where = ""): Expectation {
  return parseReference(EXPECTS, text, where);
}

/**
 * Parses an `expects` list: a sequence of one-key mappings, each naming a kind and a value in it.
 *
 * @param mapping the block the key sits in — a skill's `ambit:`, or an entity's whole document.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one that names no kind or several, or
 *   one whose value is not a string.
 */
export function parseExpectations(mapping: YamlMapping): readonly Expectation[] {
  return parseReferenceList(EXPECTS, mapping);
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

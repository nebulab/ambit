/**
 * The one shape two vocabularies share: which kind a thing is, and the name inside that kind.
 *
 * This used to be a parameterized grammar shared by `requires` and `expects`: a closed set of kinds
 * plus the words a refusal about one is written in, with a single parser, formatter, deduplicator,
 * and list reader built against it.
 *
 * The parameterization is gone because the sharing is gone:
 *
 * - `requires` now selects by pattern (a namespace, a glob, and an optional catalog qualifier), not
 *   by kind and name, and lives in `pattern.ts`.
 * - Its projections (`formatEntry`, `entryYaml`, `sameEntry`, `uniqueEntries`) moved with it, and the
 *   authoring commands that used the `expects` equivalents were deleted, since authoring a catalog
 *   is hand-editing now.
 *
 * What is left is one parser per surface, each with exactly one caller: `expects`'s document list of
 * one-key mappings, in `expectation.ts`; and `ambit why`'s `<kind>:<name>` command-line subject, in
 * `requirement.ts`. Those are two grammars, not one shared vocabulary — a list never writes a
 * separator and a subject is never a mapping — so each reader now lives in the module that owns its
 * words.
 *
 * This shape survives because both of them parse *to* it: a bundle item is one item of one
 * namespace, spelled the same way either place. It is deliberately only the shape — a kind's legal
 * values, and every word said about one, belong to the vocabulary that has them.
 */

/**
 * One member of one kind: which kind, and the name inside it.
 *
 * The shape an entry parses to, and — over the item kinds — the shape resolution identifies a bundle
 * item by, since a bundle item is exactly one item of one namespace.
 */
export interface Reference<Kind extends string = string> {
  readonly kind: Kind;
  readonly name: string;
}

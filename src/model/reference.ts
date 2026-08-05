/**
 * The one shape two vocabularies share: which kind a thing is, and the name inside that kind.
 *
 * This module used to be 337 lines of parameterized grammar. A `ReferenceGrammar` carried a closed set
 * of kinds plus the handful of words a refusal about one is written in, and a single parser, formatter,
 * deduplicator and list reader were written against it — so `requires` and `expects` could be two
 * vocabularies over one implementation, and no message about one could drift from the message about the
 * other.
 *
 * The parameterization is gone, and what took it away was not the loss of a caller but the loss of the
 * *sharing*:
 *
 * - `requires` left outright. An entry selects by pattern now — a field, a glob and a set of
 *   capabilities — so it is neither a kind nor a name, and it lives in `pattern.ts`.
 * - The projections went with it, from both ends. `formatReference`, `referenceYaml`, `sameReference`
 *   and `sortedUniqueReferences` were reached through two wrappers apiece: the `requires` ones, which
 *   `pattern.ts` now answers for itself (`formatEntry`, `entryYaml`, `sameEntry`, `uniqueEntries`), and
 *   the `expects` ones, whose callers were the authoring commands that rewrote an annotation list —
 *   deleted, because authoring a catalog is hand-editing now.
 * - `ReferenceGrammar.guess` was already set by no grammar: it existed for the bare-entry refusal a
 *   `requires` list needed.
 *
 * What was left was one parser per surviving surface, each with exactly one caller — a *document* list
 * of one-key mappings for `expects`, and a `<kind>:<name>` *string* for the subject of `ambit why`.
 * Those are two grammars, not one in two vocabularies: the list never writes a separator and the
 * subject is never a mapping, so the wording table was a seam between two things that no longer meet.
 * Collapsing it therefore duplicated nothing, which is the whole of the argument — each reader now sits
 * in the module that owns its words:
 *
 * - `expects`, in `expectation.ts`, which also holds why a kind is declared in a document.
 * - `ambit why`'s subject, in `requirement.ts`, which also holds why a bare name is refused.
 *
 * This shape survives because both of them parse *to* it, and because a bundle item is one item of one
 * namespace and so is spelled the same way. It is deliberately only the shape: a kind's set of legal
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

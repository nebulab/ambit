/**
 * The three namespaces a bundle item can be in, and the `<kind>:<name>` grammar that names one.
 *
 * This module used to be the whole of what a `requires` entry was: a namespace and a name, looked up
 * in a map, one item per entry. It is not that any more. A `requires` entry selects **by pattern** —
 * a field to match, a glob to match it with, and the capabilities to match it against — so it answers
 * with a set rather than with a name, and it lives in `pattern.ts` together with the matcher and the
 * addressing rules. Nothing here parses a `requires` list.
 *
 * What survives is the vocabulary, and it survives because a *bundle item* is still one item of one
 * namespace, which is a different thing from the question an entry asks. {@link ITEM_KINDS} is that
 * vocabulary — the order every report lists the three in — and {@link ITEM_REFERENCE} is the grammar
 * for the one surface left that takes an item's identity from a person as a string: `ambit why`'s
 * subject, `ambit why mcp:sentry`.
 *
 * The declaration is mandatory there for the reason it was mandatory in a document. A catalog's
 * namespaces are flat and independent, so a skill at `skills/mcp/sentry/SKILL.md` is legitimately
 * named `mcp.sentry` and so is an MCP entity called `sentry` one namespace over. `skill:mcp.sentry`
 * and `mcp:sentry` are different questions, both askable, and a bare name is refused rather than
 * resolved against whatever the catalog happens to hold today.
 *
 * That leaves `reference.ts` with two callers rather than three — this one and `expects` — and only
 * `expects` still reads a *list* through it. Whether the generic `ReferenceGrammar` parameterization
 * still pays for itself at that size is an open question, and a real one: `ReferenceGrammar.guess`
 * already has no grammar setting it, having existed for the bare-entry refusal a `requires` list
 * needed.
 */
import type { ReferenceGrammarOf } from "./reference.js";

/**
 * The namespaces a bundle item can be in, in the order every report lists them.
 *
 * Exported as a list because several surfaces enumerate it: the refusal for a `why` subject naming no
 * namespace, the one for a subject naming something else, and every report that groups by namespace.
 */
export const ITEM_KINDS = ["skill", "mcp", "hook"] as const;

/** Which of the bundle's namespaces a name belongs to. */
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What a namespace is called in a message about one of its members. */
export const KIND_NOUNS: Readonly<Record<ItemKind, string>> = {
  skill: "a skill",
  mcp: "an MCP entity",
  hook: "a hook",
};

/**
 * How one bundle item is named where only a string will do, and the words a refusal about one uses.
 *
 * `namespace` rather than `capability` because this names one member of one namespace — `mcp:sentry`
 * is the server, singular — where a `requires` entry's `capabilities: [mcps]` names a whole
 * namespace to search. The two vocabularies are bridged by `CAPABILITY_OF_KIND` in `pattern.ts`.
 */
export const ITEM_REFERENCE: ReferenceGrammarOf<ItemKind> = {
  // `key`, `entry` and `plural` describe a *list* written in this grammar under a document key, and
  // this vocabulary no longer has one: `parseSubject` reads `kinds`, `noun`, `missing`, `named` and
  // `members`, and nothing else. Left as the words a `requires` list used rather than invented, so
  // the table still reads against `EXPECTS`' — and see the module header for what that says about
  // `ReferenceGrammar`.
  key: "requires",
  entry: "an item reference",
  noun: "namespace",
  plural: "namespaces",
  missing: "which namespace it is in",
  named: "item",
  kinds: ITEM_KINDS,
  members: KIND_NOUNS,
};

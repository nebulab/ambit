/**
 * What a `requires` entry names: a catalog item that joins the bundle behind whatever required it.
 *
 * `requires` is a **closure** operator. `closeOverRequires` walks skill → skill to a fixpoint, pulling
 * every named item into the selection whether or not the project's own entries would have selected it. Its three
 * kinds are exactly the three catalog namespaces, and an entry nothing can satisfy is exit 3 naming the
 * catalog that should have provided it — the install refuses rather than producing a bundle that is
 * missing the half a skill said it could not work without.
 *
 * That is the whole of what separates it from `expects`, its sibling in `expectation.ts`: an expectation
 * is looked up nowhere, is provided by no catalog, cannot require anything back and cannot cycle. It is
 * checked, not resolved. The two lists share a spelling and nothing else, and the spelling lives in
 * `reference.ts`.
 *
 * ```yaml
 * ambit:
 *   requires:
 *     - skill: company-context
 *     - mcp: sentry
 *     - hook: block-rm
 * ```
 */
import type { Reference, ReferenceGrammarOf } from "./reference.js";
import {
  KIND_SEPARATOR,
  formatReference,
  isReference,
  parseReference,
  parseReferenceList,
  referenceYaml,
  sameReference,
  sortedUniqueReferences,
} from "./reference.js";
import type { YamlMapping } from "./yaml.js";

export { KIND_SEPARATOR };

/**
 * The namespaces a requirement can name, in the order every report lists them.
 *
 * Exported as a list because three surfaces enumerate it: the error for an entry that names no
 * namespace, the error for one that names something else, and the lookup a bare name takes.
 */
export const ITEM_KINDS = ["skill", "mcp", "hook"] as const;

/** Which of the bundle's namespaces a name belongs to. */
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * One item of one namespace: which namespace, and the name inside it.
 *
 * The shape a `requires` entry parses to, and the shape resolution identifies a bundle item by — one
 * type rather than two, because it is one question, and two would let a requirement name something no
 * bundle item could be.
 */
export type Requirement = Reference<ItemKind>;

/** What a namespace is called in a message about one of its members. */
export const KIND_NOUNS: Readonly<Record<ItemKind, string>> = {
  skill: "a skill",
  mcp: "an MCP entity",
  hook: "a hook",
};

/**
 * The prefix spelling a bare entry was most likely reaching for.
 *
 * Only a proposal, and only ever an extra line in a refusal: `mcp.sentry` written as a plain string
 * could always have meant either the server `sentry` or a skill of that exact name, which is the
 * ambiguity the mapping form exists to remove.
 */
function guessNamespace(value: string): Requirement | undefined {
  if (value.startsWith("mcp.")) return { kind: "mcp", name: value.slice("mcp.".length) };
  if (value.startsWith("hook.")) return { kind: "hook", name: value.slice("hook.".length) };
  return undefined;
}

/** How a `requires` entry is written, and the words a refusal about one uses. */
export const REQUIRES: ReferenceGrammarOf<ItemKind> = {
  key: "requires",
  entry: "a `requires` entry",
  noun: "namespace",
  plural: "namespaces",
  missing: "which namespace it is in",
  named: "item",
  kinds: ITEM_KINDS,
  members: KIND_NOUNS,
  guess: guessNamespace,
};

/** How a requirement is written where only a string will do — `mcp:sentry`. */
export function formatRequirement(item: Requirement): string {
  return formatReference(item);
}

/** How a requirement is written in a document, for a message telling someone to write one. */
export function requirementYaml(item: Requirement): string {
  return referenceYaml(item);
}

/** Whether two requirements name the same thing. */
export function sameRequirement(a: Requirement, b: Requirement): boolean {
  return sameReference(a, b);
}

/** A requirement list sorted and deduplicated, so it groups by namespace and then by name. */
export function sortedUniqueRequirements(items: readonly Requirement[]): readonly Requirement[] {
  return sortedUniqueReferences(items);
}

/**
 * The requirement a `<kind>:<name>` string names.
 *
 * @param where the `(file line N)` suffix for a refusal, or `""` when the caller has no file to cite.
 * @throws {AmbitError} exit 2 when no kind is given, or the kind is not one of {@link ITEM_KINDS}.
 */
export function parseRequirement(text: string, where = ""): Requirement {
  return parseReference(REQUIRES, text, where);
}

/** Whether a string is written as a namespaced reference at all — a known kind, then the separator. */
export function isRequirementReference(text: string): boolean {
  return isReference(REQUIRES, text);
}

/**
 * Parses a skill's `requires`: a sequence of one-key mappings, each naming a namespace and a name.
 *
 * @param mapping the block the key sits in — a skill's `ambit:`.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one that names no namespace or
 *   several, or one whose value is not a string.
 */
export function parseRequirements(mapping: YamlMapping): readonly Requirement[] {
  return parseReferenceList(REQUIRES, mapping);
}

/**
 * The namespaces a bundle item can be in, and how a person names one of them on a command line.
 *
 * The vocabulary lives here and the grammar lives in `pattern.ts`, because the two ask different
 * questions of the same words. A *bundle item* is one item of one namespace. A `requires` entry names
 * a namespace as its key and a **pattern** as its value, so it answers with a set rather than with a
 * name — `- skill: core.*` is a question, and the matcher and the addressing rules that answer it are
 * `pattern.ts`'s. {@link ITEM_KINDS} is the shared vocabulary, in the order every report lists it, and
 * {@link parseItemSubject} is the one surface that takes an item's identity from a person as a string:
 * `ambit why`'s subject, `ambit why mcp:sentry`.
 *
 * The reader is here rather than in a shared module because it has one caller and one vocabulary.
 * `reference.ts` used to parameterize it over both this vocabulary and `expects`; the two turned out
 * to share no reader at all once `requires` left — a document list of one-key mappings and a
 * command-line string are two grammars — so its header records the collapse and keeps only the shape
 * both parse to.
 *
 * The declaration is mandatory here for the reason it is mandatory in a document. A catalog's
 * namespaces are flat and independent, so a skill at `skills/mcp/sentry/SKILL.md` is legitimately
 * named `mcp.sentry` and so is an MCP entity called `sentry` one namespace over. `skill:mcp.sentry`
 * and `mcp:sentry` are different questions, both askable, and the separator is what makes the answer a
 * declaration rather than a guess.
 *
 * Nothing here guesses. A bare name is refused with the spellings of what was typed rather than
 * resolved against the catalog — even though `ambit why` *could* look one up — because a rule that
 * holds only while a name happens to be unique is a rule nobody can rely on, and because the subject
 * of a question may name something that has gone, which still has to be said back.
 */
import { configError } from "../errors.js";
import type { Reference } from "./reference.js";

/** What separates a kind from a name on a command line. */
export const KIND_SEPARATOR = ":";

/**
 * The namespaces a bundle item can be in, in the order every report lists them.
 *
 * Exported as a list because several surfaces enumerate it: the refusal for a `why` subject naming no
 * namespace, the one for a subject naming something else, every report that groups by namespace, and
 * the `requires` grammar — where a kind is the *key* of an entry, so this list is also the set of
 * keys an entry may be written with.
 *
 * `pack` leads because a pack is what a project usually names: it is a capability whose whole job is
 * to pull in the other three, so a report that leads with the packs and then shows what they expanded
 * to reads in the order the reader asked for things.
 */
export const ITEM_KINDS = ["pack", "skill", "mcp", "hook"] as const;

/** Which of the bundle's namespaces a name belongs to. */
export type ItemKind = (typeof ITEM_KINDS)[number];

// There is no noun table here any more. `KIND_NOUNS` fed the example line a parameterized refusal ended
// on, and neither refusal below can use one: a bare name is answered with every spelling of itself, and
// a kind with no name after it has nothing to make an example out of. The two surfaces that do put a
// namespace in a sentence carry their own words and deliberately disagree — `resolve.ts` needs the bare
// noun where a name follows immediately, and `why` says "MCP server" to a person.

/** Whether `value` is one of the namespaces. */
function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

/** Every spelling of what was typed, as the refusal for a bare name offers them. */
function spellings(text: string): string {
  return ITEM_KINDS.map((kind) => `\`${kind}${KIND_SEPARATOR}${text}\``).join(", ");
}

/**
 * The item one `<kind>:<name>` subject names.
 *
 * Recognized by its kind rather than by the mere presence of a `:`, and split on the *first* separator
 * after that — so a name carrying one of its own survives the round trip (`skill:odd:name` is the skill
 * `odd:name`) while `server:fixture` is a bare name and gets the refusal that explains the grammar,
 * rather than a confusing complaint about a namespace nobody claimed to be naming.
 *
 * @param summary how the command names what it is missing — `` `why acme` does not say what to
 *   explain `` — since that is the only half that could differ between two commands taking a subject.
 * @throws {AmbitError} exit 2 for a bare name — which includes a `<prefix>:<name>` whose prefix is no
 *   namespace, since that is what one is — or for a namespace with no name after it.
 */
export function parseItemSubject(text: string, summary: string): Reference<ItemKind> {
  const separator = text.indexOf(KIND_SEPARATOR);
  const kind = separator === -1 ? "" : text.slice(0, separator);

  if (!isItemKind(kind)) {
    throw configError(summary, [
      "a bare name does not say what kind of thing it names",
      `write the subject as one of: ${spellings(text)}`,
    ]);
  }

  const name = text.slice(separator + KIND_SEPARATOR.length);
  if (name === "") {
    throw configError(summary, [
      `\`${kind}${KIND_SEPARATOR}\` names no item`,
      `write the subject as \`<kind>${KIND_SEPARATOR}<name>\`, one of: ${ITEM_KINDS.join(", ")}`,
    ]);
  }

  return { kind, name };
}

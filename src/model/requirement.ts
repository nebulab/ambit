/**
 * What a `requires` entry names, and how the three namespaces are spelled.
 *
 * A catalog holds three namespaces — skills, MCP entities, hooks — and they are flat and independent:
 * a skill at `skills/mcp/sentry/SKILL.md` is legitimately named `mcp.sentry`, and so is an MCP entity
 * called `sentry` reached one namespace over. Something therefore has to say **which** namespace a name
 * is in, and the one thing that cannot do it is the name itself.
 *
 * So a requirement **declares** its namespace rather than encoding it in a prefix of the name. In a
 * document that is a one-key mapping, the same discriminator an MCP entity's `transport` uses:
 *
 * ```yaml
 * ambit:
 *   requires:
 *     - skill: company-context
 *     - mcp: sentry
 *     - hook: block-rm
 * ```
 *
 * On a command line, where a mapping cannot be written, it is {@link formatRequirement}'s
 * `<kind>:<name>` — `mcp:sentry`. The separator is what makes it a declaration rather than a guess: a
 * kind is mandatory and is matched against a closed set, so `skill:mcp.sentry` names the skill above
 * and `mcp:sentry` names the server, with no string a reader could write that means both.
 *
 * The one place a bare name is still accepted is a command naming something that already exists —
 * `ambit why`, `ambit catalog annotate` — where it is resolved by *looking it up* and refused when more
 * than one namespace holds it. That is a search, not a reading of the string, which is why it can never
 * silently pick the wrong one. Declaring a requirement never takes that route: `--add-requires` has to
 * be able to name a target no catalog provides, which is precisely what removing a dangling requirement
 * means.
 */
import { at, configError } from "../errors.js";
import type { AmbitError } from "../errors.js";
import { YamlMapping } from "./yaml.js";

/**
 * The namespaces a name can be in, in the order every report lists them.
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
export interface Requirement {
  readonly kind: ItemKind;
  readonly name: string;
}

/** What separates a kind from a name on a command line. */
export const KIND_SEPARATOR = ":";

/** What a namespace is called in a message about one of its members. */
export const KIND_NOUNS: Readonly<Record<ItemKind, string>> = {
  skill: "a skill",
  mcp: "an MCP entity",
  hook: "a hook",
};

function isKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * How a requirement is written where only a string will do: a flag's value, an error's next step,
 * a report's cell.
 *
 * The inverse of {@link parseRequirement}, and the one function that spells the pair — so the advice an
 * error gives cannot disagree with what the flag it names accepts.
 */
export function formatRequirement(item: Requirement): string {
  return `${item.kind}${KIND_SEPARATOR}${item.name}`;
}

/** How a requirement is written in a document, for a message telling someone to write one. */
export function requirementYaml(item: Requirement): string {
  return `- ${item.kind}: ${item.name}`;
}

/** Whether two requirements name the same thing. */
export function sameRequirement(a: Requirement, b: Requirement): boolean {
  return a.kind === b.kind && a.name === b.name;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A requirement list sorted and deduplicated, ordered by {@link formatRequirement} — so a list groups
 * by namespace and is a function of its members alone, whatever order an author wrote them in.
 */
export function sortedUniqueRequirements(items: readonly Requirement[]): readonly Requirement[] {
  const byRef = new Map(items.map((item) => [formatRequirement(item), item]));
  return [...byRef.keys()].sort(compare).map((ref) => byRef.get(ref)!);
}

/** The kinds as an error lists them: `skill`, `mcp`, `hook`. */
function kindList(): string {
  return ITEM_KINDS.join(", ");
}

/**
 * The error for a command-line reference whose kind is missing or is not one of the three.
 *
 * @param where the `(file line N)` suffix, as {@link at} renders it, or an empty string.
 */
function badReference(text: string, problem: string, where: string): AmbitError {
  const suffix = where === "" ? "" : ` ${where}`;
  return configError(`\`${text}\` does not name a namespace${suffix}`, [
    problem,
    `write it as \`<kind>${KIND_SEPARATOR}<name>\`, one of: ${kindList()}`,
    `for a skill called "${text}", that is \`skill${KIND_SEPARATOR}${text}\``,
  ]);
}

/**
 * The requirement a `<kind>:<name>` string names.
 *
 * Split on the *first* separator, so a name carrying one of its own survives the round trip:
 * `skill:odd:name` is the skill `odd:name`, and nothing else can be read out of it.
 *
 * @param where the `(file line N)` suffix for a refusal, or `""` when the caller has no file to cite.
 * @throws {AmbitError} exit 2 when no kind is given, or the kind is not one of {@link ITEM_KINDS}.
 */
export function parseRequirement(text: string, where = ""): Requirement {
  const separator = text.indexOf(KIND_SEPARATOR);
  if (separator === -1) {
    throw badReference(text, `a bare name does not say which namespace it is in`, where);
  }

  const kind = text.slice(0, separator);
  const name = text.slice(separator + KIND_SEPARATOR.length);

  if (!isKind(kind)) throw badReference(text, `"${kind}" is not a namespace`, where);
  if (name === "") {
    throw badReference(text, `\`${kind}${KIND_SEPARATOR}\` names no item`, where);
  }

  return { kind, name };
}

/**
 * Whether a string is written as a namespaced reference at all — a known kind, then the separator.
 *
 * What lets a command accept both `mcp:sentry` and a bare `code-review`: the prefixed form is
 * recognized by its kind rather than by the mere presence of a `:`, so a name that happens to carry one
 * is a bare name and gets the lookup, not a refusal about an unknown namespace.
 */
export function isRequirementReference(text: string): boolean {
  return ITEM_KINDS.some((kind) => text.startsWith(`${kind}${KIND_SEPARATOR}`));
}

/**
 * The error for a `requires` entry written as a bare string — the shape every catalog used before a
 * requirement declared its namespace.
 *
 * Names all three spellings rather than guessing the intended one: a bare `mcp.sentry` could always
 * have meant either the server `sentry` or a skill of that exact name, which is the ambiguity the
 * mapping form exists to remove, so resolving it here would reintroduce it.
 */
function bareEntry(mapping: YamlMapping, key: string, value: string): AmbitError {
  const suggestion = value.startsWith("mcp.")
    ? { kind: "mcp" as const, name: value.slice("mcp.".length) }
    : value.startsWith("hook.")
      ? { kind: "hook" as const, name: value.slice("hook.".length) }
      : undefined;

  return mapping.keyError(key, `\`requires\` entry "${value}" names no namespace`, [
    `an entry says which namespace it is in: ${ITEM_KINDS.map((kind) => `\`${kind}:\``).join(", ")}`,
    ...(suggestion === undefined
      ? []
      : [
          `for ${KIND_NOUNS[suggestion.kind]} named "${suggestion.name}", that is \`${requirementYaml(suggestion)}\``,
        ]),
    `for ${KIND_NOUNS.skill} named "${value}", that is \`${requirementYaml({ kind: "skill", name: value })}\``,
  ]);
}

/** The error for an entry mapping that names none of the three kinds, or more than one. */
function ambiguousEntry(entry: YamlMapping, keys: readonly string[]): AmbitError {
  const [first] = keys;

  return first === undefined
    ? configError(`a \`requires\` entry names no namespace ${at(entry.file, entry.line)}`, [
        `an entry is one key: ${kindList()}`,
        "give it exactly one of them",
      ])
    : entry.keyError(
        first,
        `a \`requires\` entry names ${keys.length} namespaces: ${[...keys].sort(compare).join(", ")}`,
        [`an entry is one key: ${kindList()}`, "give it exactly one of them"],
      );
}

/**
 * Parses a `requires` list: a sequence of one-key mappings, each naming a namespace and a name in it.
 *
 * The list is returned in the order it was written. Sorting is the business of whichever command
 * *rewrites* one ({@link sortedUniqueRequirements}); a list ambit merely read keeps the author's order,
 * because reordering it is the reformatting authoring rule 2 forbids.
 *
 * @param mapping the block the key sits in — a skill's `ambit:`.
 * @param key the key to read, absent meaning an empty list.
 * @throws {AmbitError} exit 2 for an entry that is not a mapping, one that names no namespace or
 *   several, or one whose value is not a string.
 */
export function parseRequirements(mapping: YamlMapping, key: string): readonly Requirement[] {
  const entries = mapping.optionalEntryList(key);
  if (entries === undefined) return [];

  return entries.map((entry) => {
    // A `PositionedString` is the pre-namespace spelling, and the one shape with a migration to
    // describe; everything else the sequence could hold was already refused by `optionalEntryList`.
    if (!(entry instanceof YamlMapping)) throw bareEntry(mapping, key, entry.value);

    const keys = entry.keys();
    if (keys.length !== 1) throw ambiguousEntry(entry, keys);

    const kind = keys[0]!;
    if (!isKind(kind)) {
      throw entry.keyError(kind, `unknown namespace "${kind}" in a \`requires\` entry`, [
        `an entry is one key: ${kindList()}`,
        `replace \`${kind}\` with one of them`,
      ]);
    }

    return { kind, name: entry.requireString(kind) };
  });
}

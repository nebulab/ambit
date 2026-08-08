/**
 * The JSONC driver — `.opencode/opencode.jsonc`.
 *
 * JSONC is JSON with comments and trailing commas, which makes a parse round-trip lossy: a person's
 * comments would not survive it. So this driver never re-serializes the document. It computes the
 * minimal text edit for each key it owns and applies that to the original bytes, leaving comments,
 * blank lines, indentation and key order everywhere else untouched, using `jsonc-parser` for exactly
 * that purpose.
 */
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

import type { ConfigEntry, DocumentDriver, JsonObject } from "./format.js";
import { isRecord, structurallyEqual } from "./format.js";
import { configError } from "../../errors.js";

/**
 * The document a file that does not exist yet stands in as.
 *
 * An empty object rather than an empty string: `modify` needs somewhere to put a key, and starting
 * from `{}` makes a first install produce an ordinary document instead of a fragment.
 */
const EMPTY_TEXT = "{}\n";

/** Comments are always tolerated; trailing commas are legal JSONC and appear in real configs. */
const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false } as const;

const FORMATTING = { tabSize: 2, insertSpaces: true } as const;

/**
 * @throws {AmbitError} exit 2 for a document that cannot be parsed even tolerantly, or one whose root
 *   is not an object.
 */
function parse(text: string, file: string): JsonObject {
  const errors: ParseError[] = [];
  const document: unknown = parseJsonc(text, errors, PARSE_OPTIONS);

  if (errors.length > 0) {
    throw configError(`${file} is not valid JSONC`, [
      `parse error at offset ${String(errors[0]?.offset ?? 0)}`,
      "correct the syntax, so ambit can add its own keys without discarding the rest",
    ]);
  }

  if (!isRecord(document)) {
    throw configError(`${file} is not a JSONC object`, [
      "ambit merges its keys into this document, which requires an object at the root",
      "make the document an object, or move the file aside",
    ]);
  }

  return document;
}

function sectionOf(document: JsonObject, section: string): JsonObject | undefined {
  const existing = document[section];
  return isRecord(existing) ? existing : undefined;
}

/** Applies one key's edit, returning the new text. */
function edit(text: string, path: readonly (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, [...path], value, { formattingOptions: FORMATTING }));
}

export const jsoncDriver: DocumentDriver = {
  format: "jsonc",

  sectionKeys: (text, section, file) => {
    if (text === undefined) return new Set();
    return new Set(Object.keys(sectionOf(parse(text, file), section) ?? {}));
  },

  entryMatches: (text, section, entry, file) => {
    if (text === undefined) return false;
    return structurallyEqual(entry.value, sectionOf(parse(text, file), section)?.[entry.key]);
  },

  mergeSection: (
    text: string | undefined,
    section: string,
    entries: readonly ConfigEntry[],
    file: string,
  ): string => {
    let current = text ?? EMPTY_TEXT;
    const document = parse(current, file);

    const existing = document[section];
    if (existing !== undefined && !isRecord(existing)) {
      throw configError(`"${section}" in ${file} is not a JSONC object`, [
        `ambit writes one key per managed entry inside \`${section}\``,
        `make \`${section}\` an object, or move its current value aside`,
      ]);
    }

    // One edit per key, applied to the text the previous edit produced, so offsets stay valid.
    for (const entry of entries) current = edit(current, [section, entry.key], entry.value);
    return current;
  },

  removeKeys: (
    text: string | undefined,
    section: string,
    keys: readonly string[],
    file: string,
  ): string | undefined => {
    if (text === undefined) return undefined;
    const existing = sectionOf(parse(text, file), section);
    if (existing === undefined) return undefined;

    const present = keys.filter((key) => Object.hasOwn(existing, key));
    if (present.length === 0) return undefined;

    let current = text;
    // `undefined` is how `modify` expresses removal. The section itself is left in place even when
    // it empties out, same as the JSON driver leaving `{}` behind.
    for (const key of present) current = edit(current, [section, key], undefined);
    return current;
  },
};

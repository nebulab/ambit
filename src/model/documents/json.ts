/**
 * The JSON driver — `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`.
 *
 * JSON has no comments, so a parse round-trip loses nothing a person wrote and the driver can work
 * on parsed objects internally. Key *order* it does have, and that is preserved: spreading the
 * document keeps every foreign key in place and keeps the managed section where it already was,
 * rather than moving it to the end on the first install.
 */
import type { ConfigEntry, DocumentDriver, JsonObject } from "./format.js";
import { isRecord, structurallyEqual } from "./format.js";
import { configError } from "../../errors.js";

/** The empty document a file that does not exist yet stands in as. */
const EMPTY: JsonObject = {};

/**
 * @throws {AmbitError} exit 2 for malformed JSON or a non-object root. Overwriting either would
 *   destroy content ambit does not own, which is exactly what the ownership rules forbid.
 */
function parse(text: string | undefined, file: string): JsonObject {
  if (text === undefined) return EMPTY;

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw configError(`${file} is not valid JSON`, [
      error instanceof Error ? error.message : String(error),
      "correct the syntax, so ambit can add its own keys without discarding the rest",
    ]);
  }

  if (!isRecord(document)) {
    throw configError(`${file} is not a JSON object`, [
      "ambit merges its keys into this document, which requires an object at the root",
      "make the document an object, or move the file aside",
    ]);
  }

  return document;
}

/** The managed section as an object; anything unusable reads as empty. */
function sectionOf(document: JsonObject, section: string): JsonObject {
  const existing = document[section];
  return isRecord(existing) ? existing : EMPTY;
}

/** Renders a document as the bytes written to disk: two-space indent, trailing newline. */
function serialize(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export const jsonDriver: DocumentDriver = {
  format: "json",

  sectionKeys: (text, section, file) => new Set(Object.keys(sectionOf(parse(text, file), section))),

  entryMatches: (text, section, entry, file) =>
    structurallyEqual(entry.value, sectionOf(parse(text, file), section)[entry.key]),

  mergeSection: (
    text: string | undefined,
    section: string,
    entries: readonly ConfigEntry[],
    file: string,
  ): string => {
    const document = parse(text, file);
    const existing = document[section];
    if (existing !== undefined && !isRecord(existing)) {
      throw configError(`"${section}" in ${file} is not a JSON object`, [
        `ambit writes one key per managed entry inside \`${section}\``,
        `make \`${section}\` an object, or move its current value aside`,
      ]);
    }

    const merged: Record<string, unknown> = { ...existing };
    for (const entry of entries) merged[entry.key] = entry.value;

    return serialize({ ...document, [section]: merged });
  },

  /**
   * The section survives emptying out: ambit owns keys inside this file and not the file itself, so
   * removing the last managed server leaves `{}` behind rather than deleting a document a person may
   * also be writing into.
   */
  removeKeys: (
    text: string | undefined,
    section: string,
    keys: readonly string[],
    file: string,
  ): string | undefined => {
    const document = parse(text, file);
    const existing = document[section];
    if (!isRecord(existing)) return undefined;

    const present = keys.filter((key) => Object.hasOwn(existing, key));
    if (present.length === 0) return undefined;

    const kept: Record<string, unknown> = { ...existing };
    for (const key of present) delete kept[key];

    return serialize({ ...document, [section]: kept });
  },
};

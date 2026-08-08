/** The document drivers, keyed by the format a harness profile names and the shape of its section. */
import type { DocumentDriver, DocumentFormat, DocumentShape, JsonObject } from "./format.js";
import { jsonDriver } from "./json.js";
import { arraySectionDriver } from "./json-array.js";
import { jsoncDriver } from "./jsonc.js";
import { tomlDriver } from "./toml.js";
import { AmbitError, ExitCode } from "../../errors.js";

export type {
  ConfigEntry,
  DocumentDriver,
  DocumentFormat,
  DocumentShape,
  JsonObject,
} from "./format.js";
export {
  DOCUMENT_FORMATS,
  DOCUMENT_SHAPES,
  isRecord,
  managedKey,
  readDocumentText,
} from "./format.js";
export { jsonDriver, parseJsonDocument, serializeJsonDocument } from "./json.js";
export { DIGEST_LENGTH, arrayEntryKey, arraySectionDriver, entryDigest } from "./json-array.js";
export { jsoncDriver } from "./jsonc.js";
export { tomlDriver } from "./toml.js";

const MAP_DRIVERS: Readonly<Record<DocumentFormat, DocumentDriver>> = {
  json: jsonDriver,
  jsonc: jsoncDriver,
  toml: tomlDriver,
};

/**
 * Only JSON, because every file with an array-shaped section is JSON: Claude's `settings.json`,
 * Cursor's `hooks.json`, Codex's `hooks.json`. Partial rather than padded with drivers that would
 * write JSON into a `.toml`, so a pairing nothing supports is a refusal, not silent corruption.
 *
 * Factories rather than instances, because an array-section driver carries the root defaults of the
 * harness whose file it edits (Cursor's `version: 1`), and those are the caller's to name.
 */
const ARRAY_DRIVERS: Readonly<
  Partial<Record<DocumentFormat, (rootDefaults?: JsonObject) => DocumentDriver>>
> = {
  json: arraySectionDriver,
};

/**
 * The driver for one format and section shape.
 *
 * The map row is total over `DocumentFormat`, so adding a format to that union is a type error here
 * until a driver exists for it. An absent `shape` reads as `"map"`, exactly as an absent `format`
 * reads as `json`: both fields were added after artifacts were already being recorded, and every one
 * of those was a name-keyed JSON map.
 *
 * @param rootDefaults root keys to seed where the document lacks them, for an array-shaped section.
 *   Absent for every caller that only reads or removes: defaults belong to writing a document.
 * @throws {AmbitError} exit 1 for a format with no array-section driver. Nothing in ambit plans one,
 *   so reaching it is a bug, not something a person did. Falling back to the map driver would mean
 *   editing a hooks file as if its arrays were tables.
 */
export function driverFor(
  format: DocumentFormat,
  shape: DocumentShape = "map",
  rootDefaults?: JsonObject,
): DocumentDriver {
  if (shape === "map") return MAP_DRIVERS[format];

  const driver = ARRAY_DRIVERS[format];
  if (driver === undefined) {
    throw new AmbitError(ExitCode.Internal, `no ${format} driver for an array-shaped section`, [
      "every harness file ambit writes an array-shaped section into is JSON",
      "this is a bug in ambit; nothing a project can hold selects this pairing",
    ]);
  }
  return driver(rootDefaults);
}

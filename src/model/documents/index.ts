/** The document drivers, keyed by the format a harness profile names and the shape of its section. */
import type { DocumentDriver, DocumentFormat, DocumentShape } from "./format.js";
import { jsonDriver } from "./json.js";
import { jsonArrayDriver } from "./json-array.js";
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
export {
  DIGEST_LENGTH,
  arrayEntryKey,
  arraySectionDriver,
  entryDigest,
  jsonArrayDriver,
} from "./json-array.js";
export { jsoncDriver } from "./jsonc.js";
export { tomlDriver } from "./toml.js";

const MAP_DRIVERS: Readonly<Record<DocumentFormat, DocumentDriver>> = {
  json: jsonDriver,
  jsonc: jsoncDriver,
  toml: tomlDriver,
};

/**
 * Only JSON, because every file with an array-shaped section is JSON: Claude's `settings.json`,
 * Cursor's `hooks.json`, Codex's `hooks.json`. Partial rather than padded out with drivers that would
 * write JSON into a `.toml`, so a pairing nothing supports is a refusal and not silent corruption.
 */
const ARRAY_DRIVERS: Readonly<Partial<Record<DocumentFormat, DocumentDriver>>> = {
  json: jsonArrayDriver,
};

/**
 * The driver for one format and section shape.
 *
 * The map row is total over `DocumentFormat`, so adding a format to that union is a type error here
 * until a driver exists for it — which is the point of keeping it exhaustive rather than looking one
 * up. An absent `shape` reads as `"map"`, exactly as an absent `format` reads as `json`: both fields
 * were added after artifacts were being recorded, and every one of those was a name-keyed JSON map.
 *
 * @throws {AmbitError} exit 1 for a format with no array-section driver. Nothing in ambit plans one,
 *   so reaching it is a bug rather than something a person did — and answering with the map driver
 *   would mean editing a hooks file as if its arrays were tables.
 */
export function driverFor(format: DocumentFormat, shape: DocumentShape = "map"): DocumentDriver {
  if (shape === "map") return MAP_DRIVERS[format];

  const driver = ARRAY_DRIVERS[format];
  if (driver === undefined) {
    throw new AmbitError(ExitCode.Internal, `no ${format} driver for an array-shaped section`, [
      "every harness file ambit writes an array-shaped section into is JSON",
      "this is a bug in ambit; nothing a project can hold selects this pairing",
    ]);
  }
  return driver;
}

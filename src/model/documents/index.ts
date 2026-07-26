/** The document drivers, keyed by the format a harness profile names. */
import type { DocumentDriver, DocumentFormat } from "./format.js";
import { jsonDriver } from "./json.js";
import { jsoncDriver } from "./jsonc.js";
import { tomlDriver } from "./toml.js";

export type { ConfigEntry, DocumentDriver, DocumentFormat, JsonObject } from "./format.js";
export { DOCUMENT_FORMATS, isRecord, managedKey, readDocumentText } from "./format.js";
export { jsonDriver } from "./json.js";
export { jsoncDriver } from "./jsonc.js";
export { tomlDriver } from "./toml.js";

const DRIVERS: Readonly<Record<DocumentFormat, DocumentDriver>> = {
  json: jsonDriver,
  jsonc: jsoncDriver,
  toml: tomlDriver,
};

/**
 * The driver for one format.
 *
 * Total over `DocumentFormat`, so adding a format to that union is a type error here until a driver
 * exists for it — which is the point of keeping the map exhaustive rather than looking one up.
 */
export function driverFor(format: DocumentFormat): DocumentDriver {
  return DRIVERS[format];
}

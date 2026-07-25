/**
 * JSON config files ambit shares with a harness (spec §5).
 *
 * `.mcp.json` is not ambit's file. Someone may have added servers to it by hand long before ambit
 * ever ran, and those have to survive every install — so ambit reads the document, replaces only
 * the keys it owns, and writes everything else back exactly as it found it. That is why ownership
 * for this kind of artifact is recorded as `managedKeys` rather than as a whole path (spec §3.6):
 * the file is co-owned, and only the keys inside it are ambit's.
 *
 * Keys already present keep their position, and only new ones are appended, for the same reason:
 * reordering lines ambit does not own turns every install into a diff nobody asked for. That still
 * leaves output a function of its inputs — one document plus one entry list always produce the
 * same bytes — which is what §4's determinism requirement asks for.
 */
import { readFile } from "node:fs/promises";

import { configError } from "./errors.js";

/** One key ambit owns inside a section, and the value it writes there. */
export interface ConfigEntry {
  readonly key: string;
  /** Serialized as JSON verbatim, so it must already be built in the order it should emit in. */
  readonly value: unknown;
}

/** A JSON object, which is what both the document root and a managed section must be. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** The empty document a file that does not exist yet stands in as. */
export const EMPTY_DOCUMENT: JsonObject = {};

/** Anything with keys — what a document root and a managed section must be, and what an errno is. */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a JSON config file, treating an absent one as an empty document.
 *
 * @param target the absolute path to read.
 * @param file how the file is named in errors, conventionally project-relative.
 * @throws {AmbitError} exit 2 for a file that exists but cannot be merged into — malformed JSON or
 *   a non-object root. Overwriting it would destroy content ambit does not own, which is exactly
 *   what the ownership rules forbid (spec §5).
 */
export async function readJsonDocument(target: string, file: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return EMPTY_DOCUMENT;
    throw configError(`cannot read ${file}`, [
      error instanceof Error ? error.message : String(error),
      `make ${target} readable, or move it aside so ambit can write a fresh one`,
    ]);
  }

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

/**
 * Merges `entries` into `document[section]`, leaving every other key — and every other entry in
 * that section — exactly as it was.
 *
 * @param file how the document is named in errors, conventionally project-relative.
 * @throws {AmbitError} exit 2 when `section` holds something other than an object: ambit cannot
 *   put keys inside a string or a list, and replacing the value would discard it.
 */
export function mergeConfigSection(
  document: JsonObject,
  section: string,
  entries: readonly ConfigEntry[],
  file: string,
): JsonObject {
  const existing = document[section];
  if (existing !== undefined && !isRecord(existing)) {
    throw configError(`"${section}" in ${file} is not a JSON object`, [
      `ambit writes one key per managed entry inside \`${section}\``,
      `make \`${section}\` an object, or move its current value aside`,
    ]);
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const entry of entries) merged[entry.key] = entry.value;

  // Spreading the document keeps every foreign key in place, and keeps `section` where it already
  // was rather than moving it to the end on the first install.
  return { ...document, [section]: merged };
}

/**
 * Removes `keys` from `document[section]`, leaving every other key — and everything else in that
 * section — exactly where it was.
 *
 * @returns the new document, or `undefined` when it already held none of them, so a caller can skip
 *   the write rather than rewriting a file it has nothing to change. That is what keeps an install
 *   with nothing to prune byte-identical (spec §7), and what stops pruning from recreating a file
 *   someone deleted by hand.
 *
 * The section survives emptying out: ambit owns keys inside this file and not the file itself
 * (spec §3.6), so removing the last managed server leaves `{}` behind rather than deleting a
 * document a person may also be writing into. A section holding something other than an object
 * holds no keys to remove, which is the same reading `sectionKeys` takes.
 */
export function removeConfigKeys(
  document: JsonObject,
  section: string,
  keys: readonly string[],
): JsonObject | undefined {
  const existing = document[section];
  if (!isRecord(existing)) return undefined;

  const present = keys.filter((key) => Object.hasOwn(existing, key));
  if (present.length === 0) return undefined;

  const kept: Record<string, unknown> = { ...existing };
  for (const key of present) delete kept[key];

  // Spreading the document keeps `section` in the position it already had, so pruning one server
  // does not reorder a file someone else also maintains.
  return { ...document, [section]: kept };
}

/**
 * The managed section of a document, as an object.
 *
 * A section that is absent, or is present but holds something other than an object, reads as an
 * empty one: neither case is a *collision* with anything ambit would write, and an unusable section
 * is `mergeConfigSection`'s error to raise, since that is the code which cannot proceed with it.
 */
export function sectionOf(document: JsonObject, section: string): JsonObject {
  const existing = document[section];
  return isRecord(existing) ? existing : EMPTY_DOCUMENT;
}

/**
 * The keys currently in `document[section]` — what ownership enforcement compares a plan against
 * (spec §5).
 */
export function sectionKeys(document: JsonObject, section: string): ReadonlySet<string> {
  return new Set(Object.keys(sectionOf(document, section)));
}

/** The dotted key state records for one managed entry (spec §3.6). */
export function managedKey(section: string, key: string): string {
  return `${section}.${key}`;
}

/** Renders a document as the bytes written to disk: two-space indent, trailing newline. */
export function serializeJsonDocument(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

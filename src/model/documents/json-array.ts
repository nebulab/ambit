/**
 * The array-section driver — `.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json`.
 *
 * Every harness writes hooks as `<Event>: [entries]`. An array has no identity key: nothing in
 * `[{"matcher": "Bash", "hooks": [...]}, ...]` says which entry a tool wrote and which a person did.
 * So hooks cannot be merged by key the way MCP servers are.
 *
 * This driver makes the content the identity: a managed key is `<Event>@<digest>`, where the digest
 * is the first {@link DIGEST_LENGTH} hex characters of the SHA-256 of the entry ambit writes.
 *
 * - The key is derivable from the file alone, so `sectionKeys` needs no name the document does not
 *   carry, and `hooks.PostToolUse@a1b2c3` is an ordinary `<section>.<key>` pair like any other.
 * - An entry with any other digest is not a key ambit ever plans, so ownership never looks at it,
 *   pruning never names it, and a merge leaves it byte-identical. Hooks added outside ambit survive
 *   installs as a result of this identity scheme, not as a separate rule.
 *
 * Parsing and serialization are shared with the map-shaped JSON driver (`json.ts`): same files, same
 * syntax, differing only in what happens to one section of them.
 */
import { createHash } from "node:crypto";

import type { ConfigEntry, DocumentDriver, JsonObject } from "./format.js";
import { isRecord } from "./format.js";
import { parseJsonDocument, serializeJsonDocument } from "./json.js";
import { AmbitError, ExitCode, configError } from "../../errors.js";

/**
 * How much of the SHA-256 a key carries: 48 bits (12 hex chars).
 *
 * A file holds only a handful of hooks, so collision risk is not worth widening a key that a person
 * reads in `.ambit/state.json` and in every `status` row.
 */
export const DIGEST_LENGTH = 12;

/**
 * What separates the event from the digest.
 *
 * Neither half can contain it: an event is a PascalCase name from a closed set, a digest is hex. So
 * the key parses back unambiguously, which `removeKeys` needs to act from state alone.
 */
const DIGEST_SEPARATOR = "@";

/** The empty document, and the empty section within one. */
const EMPTY: JsonObject = {};

/**
 * The digest of one entry as ambit would write it.
 *
 * Canonical JSON here means no whitespace, with keys kept in the order {@link ConfigEntry} already
 * promises (the order the profile's renderer built them in). Sorting keys would make the digest
 * describe something other than the bytes on disk, since `JSON.parse` preserves original key order.
 *
 * Nothing outside the entry feeds the digest: no timestamps, no absolute paths, no environment. Two
 * people installing the same bundle get the same digests, which the lock relies on.
 */
export function entryDigest(value: unknown): string {
  // `JSON.stringify` returns `undefined` only for `undefined` itself, which no parsed document holds.
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null", "utf8")
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

/** The key within the section that names one entry: `<Event>@<digest>`. */
export function arrayEntryKey(event: string, value: unknown): string {
  return `${event}${DIGEST_SEPARATOR}${entryDigest(value)}`;
}

/**
 * Reads a key back into the event and digest it names.
 *
 * @throws {AmbitError} exit 1 for a key this driver could not have produced. Both callers (append and
 *   remove) reach the file through such a key, so guessing at it would mean writing a duplicate hook
 *   or leaving an entry ambit claims to own in place forever.
 */
function splitEntryKey(key: string, file: string): readonly [event: string, digest: string] {
  const at = key.lastIndexOf(DIGEST_SEPARATOR);
  if (at <= 0 || at === key.length - 1) {
    throw new AmbitError(ExitCode.Internal, `cannot address "${key}" in ${file}`, [
      `an entry in an array section is keyed \`<Event>${DIGEST_SEPARATOR}<digest>\`, and this is not`,
      "this is a bug in ambit; deleting `.ambit/state.json` and installing again clears it",
    ]);
  }
  return [key.slice(0, at), key.slice(at + 1)];
}

/** The managed section as an object; anything unusable reads as empty. */
function sectionOf(document: JsonObject, section: string): JsonObject {
  const existing = document[section];
  return isRecord(existing) ? existing : EMPTY;
}

/**
 * Every entry in the section, keyed the way state records it.
 *
 * An event whose value is not an array is skipped rather than refused: it is not a collision with
 * anything ambit would write, and an unusable section is `mergeSection`'s error to raise, since that
 * is the code which cannot proceed with it.
 */
function keysOf(text: string | undefined, section: string, file: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [event, entries] of Object.entries(
    sectionOf(parseJsonDocument(text, file), section),
  )) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) keys.add(arrayEntryKey(event, entry));
  }
  return keys;
}

/** The root keys a document is missing, so that applying defaults never overwrites or reorders. */
function missingDefaults(document: JsonObject, rootDefaults: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(rootDefaults).filter(([key]) => !Object.hasOwn(document, key)),
  );
}

/**
 * Builds the driver.
 *
 * @param rootDefaults root keys to seed, e.g. Cursor's `version: 1`. Written only where the document
 *   does not already have the key, so ambit adds it on file creation but never overwrites a
 *   `version: 2` someone else wrote. A removal applies none of them: pruning must not add keys.
 */
export function arraySectionDriver(rootDefaults: JsonObject = EMPTY): DocumentDriver {
  return {
    format: "json",

    sectionKeys: keysOf,

    /**
     * The digest is the value, so presence of the key is the whole question. An entry a person
     * reformatted has a different digest and is therefore a different entry.
     */
    entryMatches: (text, section, entry, file) => keysOf(text, section, file).has(entry.key),

    mergeSection: (
      text: string | undefined,
      section: string,
      entries: readonly ConfigEntry[],
      file: string,
    ): string => {
      const document = parseJsonDocument(text, file);
      const existing = document[section];
      if (existing !== undefined && !isRecord(existing)) {
        throw configError(`"${section}" in ${file} is not a JSON object`, [
          `ambit appends its entries to the arrays inside \`${section}\``,
          `make \`${section}\` an object, or move its current value aside`,
        ]);
      }

      const merged: Record<string, unknown> = { ...existing };
      for (const entry of entries) {
        const [event, digest] = splitEntryKey(entry.key, file);
        const current = merged[event];
        if (current !== undefined && !Array.isArray(current)) {
          throw configError(`"${section}.${event}" in ${file} is not a JSON array`, [
            `ambit appends one entry per managed hook to \`${section}.${event}\``,
            `make \`${section}.${event}\` an array, or move its current value aside`,
          ]);
        }

        const present: readonly unknown[] = current ?? [];
        // Already there, by digest: skip it, so a second install is a no-op instead of adding a
        // duplicate hook.
        if (present.some((item) => entryDigest(item) === digest)) continue;
        merged[event] = [...present, entry.value];
      }

      // Defaults first, so a file ambit creates reads in the order a person would write it. The
      // document's own keys then keep their values and positions.
      return serializeJsonDocument({
        ...missingDefaults(document, rootDefaults),
        ...document,
        [section]: merged,
      });
    },

    /**
     * Both the section and an event's array survive emptying out. ambit owns entries inside this file,
     * not its containers, and a person may add a hook of their own to the array it just vacated.
     */
    removeKeys: (
      text: string | undefined,
      section: string,
      keys: readonly string[],
      file: string,
    ): string | undefined => {
      const document = parseJsonDocument(text, file);
      const existing = document[section];
      if (!isRecord(existing)) return undefined;

      const wanted = new Map<string, Set<string>>();
      for (const key of keys) {
        const [event, digest] = splitEntryKey(key, file);
        const digests = wanted.get(event) ?? new Set<string>();
        digests.add(digest);
        wanted.set(event, digests);
      }

      const kept: Record<string, unknown> = { ...existing };
      let removed = false;
      for (const [event, digests] of wanted) {
        const current = kept[event];
        if (!Array.isArray(current)) continue;
        const remaining = current.filter((item) => !digests.has(entryDigest(item)));
        if (remaining.length === current.length) continue;
        kept[event] = remaining;
        removed = true;
      }

      // Nothing matched: no write to make. Keeps a prune with nothing stale byte-identical, and does
      // not recreate a file someone deleted by hand.
      if (!removed) return undefined;
      return serializeJsonDocument({ ...document, [section]: kept });
    },
  };
}

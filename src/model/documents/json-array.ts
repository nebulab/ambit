/**
 * The array-section driver — `.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json`.
 *
 * Every harness writes hooks as `<Event>: [entries]`, and an array has no identity key: nothing in
 * `[{"matcher": "Bash", "hooks": [...]}, ...]` says which entry a tool wrote and which a person did.
 * That is why hooks cannot be merged the way MCP servers are, and why the tool ambit replaces
 * replaces the whole hooks root on every install, destroying anything hand-written in it.
 *
 * The way out is to make the content the identity: **a managed key is `<Event>@<digest>`**, where the
 * digest is the first {@link DIGEST_LENGTH} hex characters of the SHA-256 of the entry ambit writes.
 * Two consequences carry the whole design:
 *
 * - The key is derivable from the file alone, so `sectionKeys` can answer without a name the document
 *   does not carry, and the `DocumentDriver` interface needs no widening — `hooks.PostToolUse@a1b2c3`
 *   is an ordinary `<section>.<key>` pair, which `managedKey` composes and `splitManagedKey` splits.
 * - An entry with any other digest is not a key ambit ever plans, so ownership never looks at it,
 *   pruning never names it, and a merge leaves it byte-identical. The issue's headline promise — hooks
 *   managed outside ambit survive installs — falls out of the identity scheme rather than being a rule
 *   somewhere that could be forgotten.
 *
 * Parsing and serialization are shared with the map-shaped JSON driver (`json.ts`): these are the same
 * files in the same syntax, and only what happens to one section of them differs.
 */
import { createHash } from "node:crypto";

import type { ConfigEntry, DocumentDriver, JsonObject } from "./format.js";
import { isRecord } from "./format.js";
import { parseJsonDocument, serializeJsonDocument } from "./json.js";
import { AmbitError, ExitCode, configError } from "../../errors.js";

/**
 * How much of the SHA-256 a key carries.
 *
 * 48 bits: a file holds a handful of hooks, so a collision is not a risk worth widening a key that a
 * person reads in `.ambit/state.json` and in every `status` row.
 */
export const DIGEST_LENGTH = 12;

/**
 * What separates the event from the digest.
 *
 * Neither half can contain it — an event is a PascalCase name from a closed set, a digest is hex — so
 * the key parses back unambiguously, which is what `removeKeys` needs to act from state alone.
 */
const DIGEST_SEPARATOR = "@";

/** The empty document, and the empty section within one. */
const EMPTY: JsonObject = {};

/**
 * The digest of one entry as ambit would write it.
 *
 * Canonical JSON here means *no whitespace*, with keys in the order they already sit in — the order
 * the profile's renderer built them in, which is what {@link ConfigEntry} already promises. Sorting
 * them would make the digest describe something other than the bytes on disk, and every entry ambit
 * compares against comes back off disk through `JSON.parse`, which preserves that order.
 *
 * Nothing outside the entry feeds it: no timestamps, no absolute paths, no environment. Two people
 * installing the same bundle get the same digests, which is the property the lock already relies on.
 */
export function entryDigest(value: unknown): string {
  // `JSON.stringify` is `undefined` for `undefined` alone, which no parsed document can hold.
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
 * @throws {AmbitError} exit 1 for a key this driver could not have produced. Both callers reach the
 *   file through such a key — one to append, one to remove — so guessing at it would mean writing a
 *   duplicate hook or leaving an entry ambit claims to own in place forever.
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
 * An event whose value is not an array is skipped rather than refused, for the reason
 * {@link DocumentDriver.sectionKeys} gives: it is not a *collision* with anything ambit would write,
 * and an unusable section is `mergeSection`'s error to raise, since that is the code which cannot
 * proceed with it.
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
 * @param rootDefaults root keys to seed — Cursor's `version: 1`. Written only where the document does
 *   not already have the key, so ambit adds it when it creates the file and never overwrites a
 *   `version: 2` someone else wrote. A removal applies none of them: pruning must not add keys.
 */
export function arraySectionDriver(rootDefaults: JsonObject = EMPTY): DocumentDriver {
  return {
    format: "json",

    sectionKeys: keysOf,

    /**
     * The digest *is* the value, so presence of the key is the whole question — there is no separate
     * comparison to make, and an entry a person reformatted has a different digest and is therefore a
     * different entry.
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
        // Already there, by digest. Skipping it is what makes a second install a no-op instead of a
        // file that grows a duplicate hook every time.
        if (present.some((item) => entryDigest(item) === digest)) continue;
        merged[event] = [...present, entry.value];
      }

      // Defaults first so a file ambit creates reads in the order a person would write it; the
      // document's own keys then keep their values and their positions.
      return serializeJsonDocument({
        ...missingDefaults(document, rootDefaults),
        ...document,
        [section]: merged,
      });
    },

    /**
     * Both the section and an event's array survive emptying out, for the reason the map-shaped
     * driver leaves `{}` behind: ambit owns entries inside this file and not its containers, and a
     * person may be about to add a hook of their own to the array it just vacated.
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

      // Nothing matched: the file holds none of these digests, so there is no write to make. That is
      // what keeps a prune with nothing stale byte-identical, and what stops it from recreating a
      // file someone deleted by hand.
      if (!removed) return undefined;
      return serializeJsonDocument({ ...document, [section]: kept });
    },
  };
}

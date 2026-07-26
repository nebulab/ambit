/**
 * The document-format seam.
 *
 * A harness config file is never ambit's document. `.mcp.json` may hold servers someone added by
 * hand; `.codex/config.toml` holds a person's model, sandbox and approval settings; an
 * `opencode.jsonc` holds their comments. So every driver here answers the same three questions —
 * what keys are in the managed section, what the file looks like with ambit's entries merged in, and
 * what it looks like with them removed — and each one is required to leave everything it does not own
 * exactly as it found it.
 *
 * Drivers take and return **text** rather than a parsed document. Two formats here cannot be
 * round-tripped through a parse without losing something a person wrote (TOML comments, JSONC
 * comments), so text is the only representation all three share, and the only one in which
 * "unchanged" means what it says. The files are a few hundred bytes; parsing one twice costs nothing
 * worth designing around.
 */
import { readFile } from "node:fs/promises";

import { configError } from "../../errors.js";

/** The formats a harness config file can be written in. */
export const DOCUMENT_FORMATS = ["json", "jsonc", "toml"] as const;

/** Which of them a given file is. */
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** One key ambit owns inside a section, and the value it writes there. */
export interface ConfigEntry {
  readonly key: string;
  /**
   * The value, as plain JSON-compatible data. A driver renders it in its own syntax, so this must
   * already be built in the order it should emit in.
   */
  readonly value: unknown;
}

/** A JSON object — what a document root and a managed section must both be. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Anything with keys. */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural equality, ignoring key order.
 *
 * What "unchanged" means for a format ambit can parse losslessly: a person may have reformatted the
 * file or reordered a server's keys, and ambit owns the server rather than its layout — so neither is
 * drift, and reporting it as drift would send someone to look at a file that is already correct.
 */
export function structurallyEqual(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    return (
      expected.length === actual.length &&
      expected.every((item, index) => structurallyEqual(item, actual[index]))
    );
  }

  if (!isRecord(expected) || !isRecord(actual)) return false;
  const keys = Object.keys(expected);
  return (
    keys.length === Object.keys(actual).length &&
    keys.every((key) => Object.hasOwn(actual, key) && structurallyEqual(expected[key], actual[key]))
  );
}

/** Reads and writes one file format, preserving everything ambit does not own. */
export interface DocumentDriver {
  readonly format: DocumentFormat;
  /**
   * The keys currently in the managed section — what ownership enforcement compares a plan against.
   *
   * An absent file, an absent section, or a section that is not a table of keys all read as empty:
   * none of them is a *collision* with anything ambit would write, and an unusable section is
   * {@link DocumentDriver.mergeSection}'s error to raise, since that is the code which cannot
   * proceed with it.
   */
  sectionKeys(text: string | undefined, section: string, file: string): ReadonlySet<string>;
  /**
   * The file with `entries` merged into the managed section.
   *
   * Keys already present keep their position and only new ones are appended, so an install does not
   * reorder lines ambit does not own.
   */
  mergeSection(
    text: string | undefined,
    section: string,
    entries: readonly ConfigEntry[],
    file: string,
  ): string;
  /**
   * Whether one entry is already in the file as install would write it — `status`'s drift question.
   *
   * Each format answers in its own terms rather than through a single shared rule, because what counts
   * as "the same" differs: where a document can be parsed losslessly, key order and indentation are
   * not differences, and where it cannot, the bytes ambit would write are the only available answer.
   */
  entryMatches(
    text: string | undefined,
    section: string,
    entry: ConfigEntry,
    file: string,
  ): boolean;
  /**
   * The file with `keys` removed from the managed section, or `undefined` when it held none of them.
   *
   * `undefined` is what lets a caller skip the write entirely rather than rewriting a file it has
   * nothing to change — which is what keeps a prune with nothing stale byte-identical, and what stops
   * pruning from recreating a file someone deleted by hand.
   */
  removeKeys(
    text: string | undefined,
    section: string,
    keys: readonly string[],
    file: string,
  ): string | undefined;
}

/**
 * Reads a config file, treating an absent one as no document at all.
 *
 * @param target the absolute path to read.
 * @param file how the file is named in errors, conventionally project-relative.
 * @throws {AmbitError} exit 2 when the file exists but cannot be read. "I could not look" is not the
 *   same answer as "nothing is there", and guessing the second would be guessing in the one
 *   direction that destroys data.
 */
export async function readDocumentText(target: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw configError(`cannot read ${file}`, [
      error instanceof Error ? error.message : String(error),
      `make ${target} readable, or move it aside so ambit can write a fresh one`,
    ]);
  }
}

/** The dotted key state records for one managed entry. */
export function managedKey(section: string, key: string): string {
  return `${section}.${key}`;
}

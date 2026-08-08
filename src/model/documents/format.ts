/**
 * The document-format seam.
 *
 * A harness config file is never ambit's document alone. `.mcp.json` may hold servers added by hand;
 * `.codex/config.toml` holds a person's model, sandbox and approval settings; `opencode.jsonc` holds
 * their comments. Every driver here answers the same three questions — what keys are in the managed
 * section, what the file looks like with ambit's entries merged in, and what it looks like with them
 * removed — and must leave everything it does not own exactly as it found it.
 *
 * Drivers take and return text rather than a parsed document. TOML and JSONC cannot round-trip
 * through a parse without losing comments, so text is the only representation all three formats
 * share, and the only one in which "unchanged" means what it says.
 */
import { readFile } from "node:fs/promises";

import { configError } from "../../errors.js";

/** The formats a harness config file can be written in. */
export const DOCUMENT_FORMATS = ["json", "jsonc", "toml"] as const;

/** Which of them a given file is. */
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/**
 * The two shapes a managed section can have.
 *
 * `map` is a table keyed by an entity's name (`mcpServers.<name>`), where identity is written in the
 * document and a merge is a key assignment. `array` is `<Event>: [entries]`, the shape every harness
 * uses for hooks, where nothing in the document says which entry belongs to whom: identity is derived
 * from the entry's content, and a merge is an append.
 *
 * Shape is not a property of format: `.mcp.json` and `.claude/settings.json` are both JSON, so format
 * alone cannot pick a driver and both have to be carried.
 */
export const DOCUMENT_SHAPES = ["map", "array"] as const;

export type DocumentShape = (typeof DOCUMENT_SHAPES)[number];

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
 * This is what "unchanged" means for a format ambit can parse losslessly. A person may have
 * reformatted the file or reordered a server's keys; ambit owns the server, not its layout, so
 * neither counts as drift.
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
   * none is a collision with anything ambit would write. An unusable section is
   * {@link DocumentDriver.mergeSection}'s error to raise instead, since that is the code which
   * cannot proceed with it.
   */
  sectionKeys(text: string | undefined, section: string, file: string): ReadonlySet<string>;
  /**
   * The file with `entries` merged into the managed section.
   *
   * Keys already present keep their position; only new ones are appended, so an install does not
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
   * Each format answers in its own terms, because what counts as "the same" differs: where a document
   * parses losslessly, key order and indentation are not differences; where it cannot, the bytes
   * ambit would write are the only available answer.
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
   * `undefined` lets a caller skip the write entirely: it keeps a prune with nothing stale
   * byte-identical, and stops pruning from recreating a file someone deleted by hand.
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
 *   same answer as "nothing is there"; treating it as the latter risks destroying data.
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

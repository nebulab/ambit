/**
 * The catalog editor (spec §6, "Catalog authoring") — the one module every authoring write goes
 * through.
 *
 * A catalog is hand-maintained, so the rules that matter here are about what an edit must *not*
 * change. Rule 2 is the demanding one: a mutation preserves comments, unknown keys, the order of keys
 * ambit did not touch, and the Markdown body byte-for-byte. That is why a document is kept as its
 * parsed node tree ({@link EditableYaml}) and re-emitted, rather than reduced to a plain object and
 * emitted afresh — a tool that reformats a catalog on every edit is a tool nobody runs twice. Where
 * ambit owns a whole file's shape, `emitYaml` still applies (rule 3); this module is for the other
 * case.
 *
 * The other three rules are all in {@link applyCatalogEdit}, because they are properties of the *set*
 * of files an edit touches rather than of any one of them:
 *
 * - **Rule 4, validate before writing.** The result is validated as a whole — including files the edit
 *   creates and removes — and nothing is written if it fails. The pending bytes are handed to parsing
 *   as a {@link CatalogOverlay} rather than staged on disk, so there is never a moment where the
 *   catalog on disk is the broken intermediate.
 * - **Rule 5, atomic writes inside the root.** Every path is checked against the root before anything
 *   is opened, and every write lands beside its target and is renamed onto it.
 * - **Rule 6, `--dry-run` touches nothing.** The same plan is computed and validated, and returned
 *   with the bytes each file holds now, so a caller can show a diff of exactly what it withheld.
 *
 * An edit that changes nothing writes nothing at all — not the file it was pointed at, and not any
 * other. Re-running a mutation is therefore a no-op in the strongest sense, which is what makes these
 * commands safe to script.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CatalogOverlay } from "./catalog.js";
import { MCPS_DIRNAME, SKILLS_DIRNAME, SKILL_FILENAME } from "./catalog.js";
import type { AmbitError } from "./errors.js";
import { configError, resolutionError } from "./errors.js";
import type { ValidationReport } from "./validate.js";
import { isValid, validateCatalogDirectory } from "./validate.js";
import { EditableYaml } from "./yaml.js";

/**
 * Where a write lands before it is renamed onto its target, so an interrupted one leaves the file it
 * was replacing untouched. The suffix is fixed rather than random for the reason `git.ts` uses one:
 * a leftover is recognizable, and neither `skills/**` nor `mcps/*` parsing looks at a file whose name
 * ends in anything but `SKILL.md` or `.yml`, so a stray one cannot be mistaken for catalog content.
 */
const INCOMING_SUFFIX = ".ambit-incoming";

/** Documents whose YAML lives in a Markdown frontmatter block rather than in the whole file. */
const MARKDOWN_EXTENSION = ".md";

/** A file an edit writes: the bytes it will hold, or `null` for a file it removes. */
export interface CatalogChange {
  /** Catalog-relative and `/`-separated — how a catalog's own errors and reports name a file. */
  readonly file: string;
  readonly text: string | null;
}

/** One change an edit would make, against what is on disk now. */
export interface EditedFile extends CatalogChange {
  /** The bytes the file holds now. Absent when the edit creates it. */
  readonly before?: string;
}

export interface EditOptions {
  /** `--dry-run`: validate the result and write none of it (spec §6 authoring rule 6). */
  readonly dryRun?: boolean;
}

/** What an edit amounted to. */
export interface EditResult {
  /**
   * The files whose bytes would change, in path order. Empty when the edit was a no-op — which is
   * also when nothing at all was written.
   */
  readonly changes: readonly EditedFile[];
  /** False under `--dry-run`, and false when there was nothing to change. */
  readonly written: boolean;
}

/**
 * The absolute path of a catalog-relative file, refusing anything outside the root (spec §6 authoring
 * rule 5).
 *
 * The check is on the path as given, not only on where it resolves: a `..` segment that happens to
 * land back inside the root is still a path the caller does not mean, and an absolute one would put a
 * machine path into a report.
 *
 * @throws {AmbitError} exit 2 for a path outside the catalog root.
 */
export function catalogFilePath(root: string, file: string): string {
  const outside = (reason: string): AmbitError =>
    configError(`refusing to write outside the catalog: "${file}"`, [
      reason,
      `name a path inside ${root}, relative to it`,
    ]);

  if (file === "") throw outside("it names no file");
  if (path.isAbsolute(file)) throw outside("it is an absolute path");
  if (file.split("/").includes("..")) throw outside("it climbs above the catalog root");

  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw outside(`it resolves to ${target}`);
  }

  return target;
}

/** Where a skill's document sits in a catalog, from its name (spec §2). */
export function skillDocumentPath(name: string): string {
  return `${SKILLS_DIRNAME}/${name.replaceAll(".", "/")}/${SKILL_FILENAME}`;
}

/** Where an MCP entity's document sits in a catalog, from its name (spec §3.3). */
export function mcpDocumentPath(name: string): string {
  return `${MCPS_DIRNAME}/${name}.yml`;
}

/**
 * One catalog document, open for editing.
 *
 * Whether the YAML is the whole file or a frontmatter block is decided by the extension and nowhere
 * else, so a caller asks for a path and gets the right treatment for it.
 */
export class CatalogDocument {
  private readonly original: string;

  private constructor(
    /** Catalog-relative path, as reports and errors name it. */
    readonly file: string,
    private readonly edit: EditableYaml,
    original: string,
  ) {
    this.original = original;
  }

  /**
   * Reads a document and parses it for editing.
   *
   * @param root the catalog root, absolute.
   * @param file the document, catalog-relative.
   * @throws {AmbitError} exit 2 for a path outside the root, a file that cannot be read, or a
   *   document that violates a §3.0 rule.
   */
  static async open(root: string, file: string): Promise<CatalogDocument> {
    const target = catalogFilePath(root, file);

    let text: string;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      throw configError(`cannot read ${file}`, [
        error instanceof Error ? error.message : String(error),
        `check that ${file} is in the catalog, and readable`,
      ]);
    }

    const edit = file.endsWith(MARKDOWN_EXTENSION)
      ? EditableYaml.frontmatter(text, file)
      : EditableYaml.yaml(text, file);

    return new CatalogDocument(file, edit, text);
  }

  /** Whether `path` — a key, or a path of keys into nested mappings — is present. */
  has(path: readonly string[]): boolean {
    return this.edit.has(path);
  }

  /** Sets `path` to a string, creating any mapping along the way that is not there yet. */
  setString(path: readonly string[], value: string): void {
    this.edit.setString(path, value);
  }

  /**
   * Sets `path` to a list of strings, keeping the layout and any comment the author gave it.
   *
   * The order is the caller's: a list ambit owns the contents of is sorted and deduplicated by
   * whichever command owns that decision, not here.
   */
  setStringList(path: readonly string[], values: readonly string[]): void {
    this.edit.setStringList(path, values);
  }

  /** Removes `path`, if it is there. */
  remove(path: readonly string[]): void {
    this.edit.remove(path);
  }

  /**
   * Renames keys of the mapping at `path`, keeping each entry where it was, comments included.
   *
   * The whole set is given at once because a rename can pass through a name another entry still holds;
   * see {@link EditableYaml.renameKeys}. Keys the mapping does not hold are ignored.
   */
  renameKeys(path: readonly string[], renames: ReadonlyMap<string, string>): void {
    this.edit.renameKeys(path, renames);
  }

  /** The bytes the document would be written with. Byte-identical to what was read until an edit. */
  text(): string {
    return this.edit.text();
  }

  /** Whether any edit actually changed the bytes. */
  get changed(): boolean {
    return this.text() !== this.original;
  }

  /** This document's edits as a change to hand to {@link applyCatalogEdit}. */
  change(): CatalogChange {
    return { file: this.file, text: this.text() };
  }
}

/**
 * The error for a mutation whose result would not validate (spec §6 authoring rule 4).
 *
 * Exit 3, the code every other resolution problem uses, since these *are* those problems — the same
 * report `ambit validate` prints, raised instead of listed because there is no result to report on.
 * The messages are quoted rather than the whole report, which would bury the one line that matters
 * under its own detail; the full report is one command away, and the message says which.
 */
function refusedByValidation(root: string, report: ValidationReport): AmbitError {
  const problems = report.problems;
  return resolutionError("refusing to write: the result would not validate", [
    `${problems.length} problem${problems.length === 1 ? "" : "s"} in the result, so nothing was written`,
    ...problems.map((problem) => problem.message),
    `correct what this command was asked to change, or run \`ambit validate --catalog ${root}\` for the whole report`,
  ]);
}

/** What parsing reads instead of the disk while an edit is being validated. */
function overlayOf(changes: readonly CatalogChange[]): CatalogOverlay {
  return new Map(changes.map((change) => [change.file, change.text]));
}

/**
 * The bytes a file holds now, or `undefined` when it does not exist.
 *
 * A file that exists but cannot be read reads as absent here, and then fails on the write with a
 * message about the write — which is the error the reader can act on.
 */
async function currentText(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Writes `text` to `target` through a neighbouring file, so a target is either its old contents or its
 * new ones and never a half-written mix (spec §6 authoring rule 5).
 *
 * @throws {AmbitError} exit 2 if the write fails, naming the file.
 */
async function writeAtomically(target: string, text: string, file: string): Promise<void> {
  const incoming = `${target}${INCOMING_SUFFIX}`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(incoming, text, "utf8");
    await rename(incoming, target);
  } catch (error) {
    await rm(incoming, { force: true });
    throw configError(`cannot write ${file}`, [
      error instanceof Error ? error.message : String(error),
      `check that ${path.dirname(target)} exists and is writable`,
    ]);
  }
}

/** @throws {AmbitError} exit 2 if the removal fails, naming the file. */
async function removeFile(target: string, file: string): Promise<void> {
  try {
    await rm(target, { force: true });
  } catch (error) {
    throw configError(`cannot remove ${file}`, [
      error instanceof Error ? error.message : String(error),
      `check the permissions on ${path.dirname(target)}`,
    ]);
  }
}

/** One pending change and where it lands. */
interface PendingWrite {
  readonly change: EditedFile;
  readonly target: string;
}

/** Path order, so an edit's writes and its report never depend on the order a caller listed them. */
function byFile(writes: readonly PendingWrite[]): readonly PendingWrite[] {
  return [...writes].sort((a, b) =>
    a.change.file < b.change.file ? -1 : a.change.file > b.change.file ? 1 : 0,
  );
}

/**
 * Validates an edit's result and writes it.
 *
 * Every authoring mutation ends here, whatever it changed: one document, several, or a file it
 * created. The order is what the authoring rules require — resolve and check every path, drop the
 * changes that are not changes, validate what would remain, and only then touch disk.
 *
 * @param root the catalog root, absolute.
 * @param changes the files to write, at most one entry per path.
 * @param options `--dry-run`.
 * @returns the changes that were written, or would have been, in path order.
 * @throws {AmbitError} exit 2 for a path outside the catalog root or a write that fails; exit 3 when
 *   the result would not validate, with every file left byte-identical.
 */
export async function applyCatalogEdit(
  root: string,
  changes: readonly CatalogChange[],
  options: EditOptions = {},
): Promise<EditResult> {
  // Every path is checked before any file is read, so a refusal costs no partial work.
  const resolved = changes.map((change) => ({
    change,
    target: catalogFilePath(root, change.file),
  }));

  const pending: PendingWrite[] = [];
  for (const { change, target } of resolved) {
    const before = await currentText(target);
    // A change that matches the bytes already there is not a change: re-running a mutation must leave
    // the catalog alone, down to the modification time.
    if (change.text === before || (change.text === null && before === undefined)) continue;
    pending.push({ change: { ...change, ...(before !== undefined && { before }) }, target });
  }

  if (pending.length === 0) return { changes: [], written: false };

  const report = await validateCatalogDirectory(
    root,
    overlayOf(pending.map((entry) => entry.change)),
  );
  if (!isValid(report)) throw refusedByValidation(root, report);

  const ordered = byFile(pending);
  if (options.dryRun === true) return { changes: ordered.map((entry) => entry.change), written: false };

  for (const { change, target } of ordered) {
    if (change.text === null) await removeFile(target, change.file);
    else await writeAtomically(target, change.text, change.file);
  }

  return { changes: ordered.map((entry) => entry.change), written: true };
}

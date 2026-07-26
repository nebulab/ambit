/**
 * The catalog editor — the one module every authoring write goes
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
 *
 * A skill lives in a *directory*, so an edit can also move or remove a whole tree
 * ({@link CatalogTreeChange}). That is not sugar for a list of file changes: a skill directory may
 * carry bytes ambit has no business reading as text — a PDF under `references/` — and re-writing those
 * through a `string` would corrupt them. A tree therefore travels by `rename`, and only the files
 * parsing actually reads are described to validation.
 */
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CatalogOverlay } from "../model/catalog.js";
import { MCPS_DIRNAME, SKILLS_DIRNAME, SKILL_FILENAME } from "../model/catalog.js";
import type { AmbitError } from "../errors.js";
import { configError, resolutionError } from "../errors.js";
import type { ValidationReport } from "../resolution/validate.js";
import { isValid, validateCatalogDirectory } from "../resolution/validate.js";
import { EditableYaml } from "../model/yaml.js";

/**
 * Where a write lands before it is renamed onto its target, so an interrupted one leaves the file it
 * was replacing untouched. The suffix is fixed rather than random for the reason `model/git.ts` uses one:
 * a leftover is recognizable, and neither `skills/**` nor `mcps/*` parsing looks at a file whose name
 * ends in anything but `SKILL.md` or `.yml`, so a stray one cannot be mistaken for catalog content.
 */
const INCOMING_SUFFIX = ".ambit-incoming";

/** Documents whose YAML lives in a Markdown frontmatter block rather than in the whole file. */
const MARKDOWN_EXTENSION = ".md";

/**
 * What catalog parsing reads inside a directory: a skill's `SKILL.md`, and the YAML an entity or the
 * registry is written as.
 *
 * Everything else a skill directory holds is opaque to ambit, so a moved tree only has to describe
 * *these* files to validation — which is also what keeps a binary asset from being read at all.
 */
const PARSED_FILENAMES: readonly string[] = [SKILL_FILENAME];
const PARSED_EXTENSIONS: readonly string[] = [".yml", ".yaml"];

function isParsedFile(name: string): boolean {
  return PARSED_FILENAMES.includes(name) || PARSED_EXTENSIONS.some((end) => name.endsWith(end));
}

/** A file an edit writes: the bytes it will hold, or `null` for a file it removes. */
export interface CatalogFileChange {
  /** Catalog-relative and `/`-separated — how a catalog's own errors and reports name a file. */
  readonly file: string;
  readonly text: string | null;
}

/**
 * A whole directory an edit moves or removes: the one operation a list of file changes cannot express
 * (see the module comment).
 *
 * A move is a `rename`, so every byte under it survives and the operation is atomic. A removal is
 * recursive and, unavoidably, is not — but it is the last thing anything reads about those files.
 */
export interface CatalogTreeChange {
  /** Catalog-relative and `/`-separated, like {@link CatalogFileChange.file}. */
  readonly directory: string;
  /** Where it moves to, or `null` to remove it. */
  readonly to: string | null;
}

/** One thing an edit does: rewrite a file, or move a whole directory. */
export type CatalogChange = CatalogFileChange | CatalogTreeChange;

function isTreeChange(change: CatalogChange): change is CatalogTreeChange {
  return "directory" in change;
}

/** One change an edit would make, against what is on disk now. */
export interface EditedFile extends CatalogFileChange {
  /** The bytes the file holds now. Absent when the edit creates it. */
  readonly before?: string;
}

export interface EditOptions {
  /** `--dry-run`: validate the result and write none of it. */
  readonly dryRun?: boolean;
}

/** What an edit amounted to. */
export interface EditResult {
  /**
   * The files whose bytes would change, in path order. Empty when the edit changed no file — which,
   * together with an empty {@link trees}, is also when nothing at all was written.
   */
  readonly changes: readonly EditedFile[];
  /** The directories moved or removed, in path order. */
  readonly trees: readonly CatalogTreeChange[];
  /** False under `--dry-run`, and false when there was nothing to change. */
  readonly written: boolean;
}

/**
 * The absolute path of a catalog-relative file, refusing anything outside the root.
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

/** Where a skill's directory sits in a catalog, from its name. */
export function skillDirectoryPath(name: string): string {
  return `${SKILLS_DIRNAME}/${name.replaceAll(".", "/")}`;
}

/** Where a skill's document sits in a catalog, from its name. */
export function skillDocumentPath(name: string): string {
  return `${skillDirectoryPath(name)}/${SKILL_FILENAME}`;
}

/** Where an MCP entity's document sits in a catalog, from its name. */
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
 * The error for a mutation whose result would not validate.
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

/** The error for a directory an edit means to move that is not in the catalog. */
function missingTree(directory: string): AmbitError {
  return configError(`cannot move ${directory}`, [
    "the catalog holds no such directory",
    "name a directory that is in the catalog, relative to its root",
  ]);
}

/**
 * The error for a move onto a path something already occupies.
 *
 * Refused rather than merged: `rename` would either fail or, for an empty target, silently absorb it,
 * and neither is an outcome the caller asked for.
 */
function occupiedTree(directory: string, to: string): AmbitError {
  return configError(`refusing to move ${directory} onto ${to}`, [
    `${to} already exists, so moving onto it would merge two trees`,
    `move or delete ${to} first`,
  ]);
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The files under `relative` that catalog parsing reads, catalog-relative and in path order.
 *
 * This is all a tree operation has to tell validation about: the rest of the directory is bytes ambit
 * neither parses nor rewrites, so a move leaves them out of the overlay entirely.
 */
async function parsedFilesUnder(root: string, relative: string): Promise<readonly string[]> {
  const found: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const inner = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(inner);
      else if (isParsedFile(entry.name)) found.push(inner);
    }
  };

  await walk(relative);
  return found;
}

/** Where `file` sits inside `directory`, or `undefined` when it is not inside it at all. */
function inside(directory: string, file: string): string | undefined {
  const prefix = `${directory}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
}

/** One pending directory operation, with both ends resolved and its parsed files listed. */
interface PendingTree {
  readonly change: CatalogTreeChange;
  readonly from: string;
  readonly to: string | null;
  readonly parsed: readonly string[];
}

/**
 * What parsing reads instead of the disk while an edit is being validated.
 *
 * The trees are laid down first and the file changes over them, because that is how a caller states a
 * move: the tree carries the bytes, and one file change restates the document whose contents the move
 * makes wrong — a skill's `name`, which has to agree with its new path. A caller that
 * forgets gets a validation problem rather than a quietly mismatched skill.
 */
async function overlayOf(
  root: string,
  trees: readonly PendingTree[],
  changes: readonly CatalogFileChange[],
): Promise<CatalogOverlay> {
  const overlay = new Map<string, string | null>();

  for (const tree of trees) {
    for (const file of tree.parsed) {
      overlay.set(file, null);
      const destination = tree.change.to;
      if (destination === null) continue;
      const moved = `${destination}/${inside(tree.change.directory, file) ?? ""}`;
      const text = await currentText(path.join(root, file));
      if (text !== undefined) overlay.set(moved, text);
    }
  }

  for (const change of changes) overlay.set(change.file, change.text);
  return overlay;
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
 * The bytes a file change is replacing when the file is not there *yet* — because a move in the same
 * edit is about to put it there.
 *
 * Without this a skill's `SKILL.md` that was moved and then had its `name` corrected would preview as a
 * created file, every line an addition, when what happened to it was a one-line edit.
 */
async function textArrivingAt(
  root: string,
  trees: readonly PendingTree[],
  file: string,
): Promise<string | undefined> {
  for (const tree of trees) {
    if (tree.change.to === null) continue;
    const within = inside(tree.change.to, file);
    if (within === undefined) continue;
    return currentText(path.join(root, tree.change.directory, within));
  }
  return undefined;
}

/**
 * Writes `text` to `target` through a neighbouring file, so a target is either its old contents or its
 * new ones and never a half-written mix.
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

/**
 * Removes the directories a tree operation left empty, stopping below the catalog's own layout.
 *
 * A skill's namespace directory exists only to hold skills, so leaving `skills/jane/` behind after the
 * last skill under it moved away would read as a half-finished command. The catalog's top-level
 * directories are a different thing — `skills/` and `mcps/` are its shape, not its contents —
 * so pruning stops at depth one and never reaches the root.
 *
 * Best-effort on purpose: a directory that cannot be removed is cosmetic, and failing the mutation over
 * it after the move already succeeded would be the worse answer.
 */
async function pruneEmptyAncestors(root: string, relative: string): Promise<void> {
  let directory = relative;
  while (directory.includes("/")) {
    try {
      if ((await readdir(path.join(root, directory))).length > 0) return;
      // `rmdir`, not `rm`: it removes an empty directory and refuses everything else, which is exactly
      // the guarantee this walk needs from the one call that deletes anything.
      await rmdir(path.join(root, directory));
    } catch {
      return;
    }
    directory = path.dirname(directory);
  }
}

/**
 * Moves or removes one directory.
 *
 * @throws {AmbitError} exit 2 if the operation fails, naming the directory.
 */
async function applyTree(root: string, pending: PendingTree): Promise<void> {
  const { change, from, to } = pending;
  try {
    if (to === null) await rm(from, { recursive: true, force: true });
    else {
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
    }
  } catch (error) {
    const verb = to === null ? "remove" : "move";
    throw configError(`cannot ${verb} ${change.directory}`, [
      error instanceof Error ? error.message : String(error),
      `check the permissions on ${path.dirname(from)}`,
    ]);
  }

  await pruneEmptyAncestors(root, path.dirname(change.directory));
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

/** The same order for directories, and for the same reason. */
function byDirectory(trees: readonly PendingTree[]): readonly PendingTree[] {
  return [...trees].sort((a, b) =>
    a.change.directory < b.change.directory ? -1 : a.change.directory > b.change.directory ? 1 : 0,
  );
}

/**
 * The directory operations an edit will actually perform, with the no-ops dropped.
 *
 * @throws {AmbitError} exit 2 for a path outside the catalog root, a directory that is not there, or a
 *   move onto an occupied path.
 */
async function pendingTrees(
  root: string,
  trees: readonly CatalogTreeChange[],
): Promise<readonly PendingTree[]> {
  const pending: PendingTree[] = [];

  for (const change of trees) {
    const destination = change.to;
    const from = catalogFilePath(root, change.directory);
    const to = destination === null ? null : catalogFilePath(root, destination);
    // Moving a directory onto itself is what a rename to the same name amounts to, and it is not a
    // change — the same stance a file change matching the bytes already there gets.
    if (destination === change.directory) continue;

    if (!(await isDirectory(from))) {
      // A directory that is already gone is a removal that already happened.
      if (destination === null) continue;
      throw missingTree(change.directory);
    }
    if (destination !== null && to !== null && (await exists(to))) {
      throw occupiedTree(change.directory, destination);
    }

    pending.push({ change, from, to, parsed: await parsedFilesUnder(root, change.directory) });
  }

  return byDirectory(pending);
}

/**
 * Validates an edit's result and writes it.
 *
 * Every authoring mutation ends here, whatever it changed: one document, several, a file it created, or
 * a whole directory it moved. The order is what the authoring rules require — resolve and check every
 * path, drop the changes that are not changes, validate what would remain, and only then touch disk.
 * Directories go first when the writing starts, because a file change in the same edit may be aimed at
 * where a move is about to put it.
 *
 * @param root the catalog root, absolute.
 * @param changes the files to write and the directories to move, at most one entry per path.
 * @param options `--dry-run`.
 * @returns the changes that were made, or would have been, in path order.
 * @throws {AmbitError} exit 2 for a path outside the catalog root, a directory that is not there, a
 *   move onto an occupied path, or a write that fails; exit 3 when the result would not validate, with
 *   every file left byte-identical.
 */
export async function applyCatalogEdit(
  root: string,
  changes: readonly CatalogChange[],
  options: EditOptions = {},
): Promise<EditResult> {
  const trees = await pendingTrees(root, changes.filter(isTreeChange));

  // Every path is checked before any file is read, so a refusal costs no partial work.
  const resolved = changes
    .filter((change): change is CatalogFileChange => !isTreeChange(change))
    .map((change) => ({ change, target: catalogFilePath(root, change.file) }));

  const pending: PendingWrite[] = [];
  for (const { change, target } of resolved) {
    const before = (await currentText(target)) ?? (await textArrivingAt(root, trees, change.file));
    // A change that matches the bytes already there is not a change: re-running a mutation must leave
    // the catalog alone, down to the modification time.
    if (change.text === before || (change.text === null && before === undefined)) continue;
    pending.push({ change: { ...change, ...(before !== undefined && { before }) }, target });
  }

  const moved = trees.map((tree) => tree.change);
  if (pending.length === 0 && moved.length === 0) return { changes: [], trees: [], written: false };

  const report = await validateCatalogDirectory(
    root,
    await overlayOf(
      root,
      trees,
      pending.map((entry) => entry.change),
    ),
  );
  if (!isValid(report)) throw refusedByValidation(root, report);

  const ordered = byFile(pending);
  const applied = ordered.map((entry) => entry.change);
  if (options.dryRun === true) return { changes: applied, trees: moved, written: false };

  for (const tree of trees) await applyTree(root, tree);

  for (const { change, target } of ordered) {
    if (change.text === null) await removeFile(target, change.file);
    else await writeAtomically(target, change.text, change.file);
  }

  return { changes: applied, trees: moved, written: true };
}

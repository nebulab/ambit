/**
 * The managed `.gitignore` blocks.
 *
 * Everything ambit materializes is derived (copied or linked from a catalog), so committing it
 * would give a project two answers to "what is installed": `ambit.yml` and git. Ambit writes the
 * paths it owns into `.gitignore` itself.
 *
 * Two files: `.agents/.gitignore` lists installed skills (the layout dotagents established; this
 * list churns as `requires` changes), and the root `.gitignore` holds what a nested file cannot
 * express — `.ambit/` and the skills link (`.claude/skills`, owned by the harness) — since git only
 * matches a pattern against paths beneath the file that holds it.
 *
 * `.agents/.gitignore` is tracked, not ignored: it is generated from `ambit.yml` and `ambit.lock`,
 * both committed, and is byte-stable, so a fresh clone or worktree gets the ignore list without
 * running ambit first.
 *
 * Ambit owns a block inside each file, marked by sentinel lines; everything outside a block is left
 * untouched, so a pre-existing `.gitignore` is a normal input. The block has no entry in
 * `.ambit/state.json` and needs no prune step: each install rewrites it from scratch. `clean`
 * removes the blocks using the same markers.
 *
 * A file with two blocks, or one missing its end marker, is ambiguous and fails with exit 2 rather
 * than guessing which lines to overwrite.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { configError } from "../errors.js";
import { SHARED_AGENTS_DIR } from "../harness/profile.js";
import type { OwnedArtifact } from "../model/state.js";
import { STATE_DIRNAME } from "../model/state.js";

/** The file the root block lives in, at the project root. */
export const GITIGNORE_FILENAME = ".gitignore";

/** The file the skill paths are listed in, inside the directory that holds them. */
export const SHARED_GITIGNORE_FILE = `${SHARED_AGENTS_DIR}/${GITIGNORE_FILENAME}`;

/** The sentinel a block's first line starts with. */
export const BLOCK_BEGIN = "# BEGIN ambit";

/** The sentinel a block's last line starts with, and the whole of that line as written. */
export const BLOCK_END = "# END ambit";

/**
 * The opening line as written.
 *
 * The explanation is part of the marker line, not a line of its own, so a block adds only one line
 * of prose regardless of how many paths it lists. Detection matches the sentinel prefix, not this
 * exact string, so an older block with different wording is still recognized and rewritten.
 */
const BEGIN_LINE = `${BLOCK_BEGIN} - managed block, rewritten by \`ambit install\`; edits are lost`;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One file ambit maintains a block in, and what that block should list.
 *
 * Entries are patterns relative to the file's own directory, since that is what git matches them
 * against; splitting between the two files also rewrites the paths, not just partitions them.
 */
export interface IgnoreBlock {
  /** Project-relative path of the file holding the block. */
  readonly file: string;
  /** The patterns the block should list. Empty means the block should not be there at all. */
  readonly entries: readonly string[];
}

/** Whether one managed block is already what an install would write. */
export interface GitignoreStatus {
  /** Project-relative path of the file holding the block. */
  readonly file: string;
  /** Whether install would rewrite it. */
  readonly changed: boolean;
}

/**
 * A `.gitignore` line is a glob, so characters that would change what it matches get escaped.
 *
 * This is nearly always a no-op for a skill name, but a pattern that decides what git tracks should
 * not rely on "nearly". A leading `#` or `!` needs no escape here because every path ambit writes
 * begins with a directory component.
 */
function escapePattern(entry: string): string {
  return entry.replaceAll(/[\\*?[]/g, (character) => `\\${character}`);
}

function isBegin(line: string): boolean {
  return line.trim().startsWith(BLOCK_BEGIN);
}

function isEnd(line: string): boolean {
  return line.trim().startsWith(BLOCK_END);
}

/**
 * The lines of a file, without the empty segment a trailing newline leaves behind.
 *
 * Splits on `\n` alone so a `\r` stays part of its line and is written back unchanged; a CRLF
 * `.gitignore` should not be rewritten wholesale just because ambit changed a few lines in the
 * middle.
 */
function splitLines(text: string | undefined): readonly string[] {
  if (text === undefined || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Where ambit's block sits, by line index, inclusive of both markers. */
interface Block {
  readonly start: number;
  readonly end: number;
}

/**
 * Locates the managed block, or reports that the file holds none.
 *
 * @param file the project-relative path, so an error names the file to fix rather than whichever of
 *   the two ambit happened to be writing.
 * @throws {AmbitError} exit 2 for two blocks, or a block with no end line, since either makes the
 *   span ambit may overwrite ambiguous.
 */
function findBlock(lines: readonly string[], file: string): Block | undefined {
  const begins = lines.flatMap((line, index) => (isBegin(line) ? [index] : []));
  const [start, second] = begins;
  if (start === undefined) return undefined;

  if (second !== undefined) {
    throw configError(`${file} holds more than one ambit block`, [
      `\`${BLOCK_BEGIN}\` appears on line ${start + 1} and line ${second + 1}, so ambit cannot tell which block is its own`,
      `delete all but one of them, keeping the paths you want, then run \`ambit install\` again`,
    ]);
  }

  const offset = lines.slice(start + 1).findIndex(isEnd);
  if (offset === -1) {
    throw configError(`${file} holds an unterminated ambit block`, [
      `the block opened on line ${start + 1} has no \`${BLOCK_END}\` line, so ambit cannot tell where it ends`,
      `add \`${BLOCK_END}\` after the last path ambit wrote, or delete line ${start + 1}`,
    ]);
  }

  return { start, end: start + 1 + offset };
}

/**
 * A path inside the shared directory, rewritten as a pattern anchored to that directory.
 *
 * The leading `/` is required: without it git would match the pattern at any depth below
 * `.agents/`, so a skill named `skills` would ignore unrelated paths.
 */
function sharedPattern(artifactPath: string): string {
  return `/${artifactPath.slice(`${SHARED_AGENTS_DIR}/`.length)}`;
}

/** Whether a path is one the nested file can express — anything under the shared directory. */
function isShared(artifactPath: string): boolean {
  return artifactPath.startsWith(`${SHARED_AGENTS_DIR}/`);
}

/**
 * The two blocks a project should hold, given what an install owns.
 *
 * Every installed skill, and every script a hook ships, lands under the shared directory and is
 * listed in the nested file. Ambit's state directory and the skills link cannot be reached from
 * there and stay at the root. The split is by path, not by artifact kind, so a harness that later
 * puts a skills link inside `.agents/` needs no change here.
 *
 * Every kind ambit owns as a path must be listed here, or its bytes show up as untracked in `git
 * status`. `.mcp.json` and `ambit.lock` are not listed: teams may want them committed, and
 * `ambit.lock` is not an owned artifact. `.agents/.gitignore` is generated but tracked (see the
 * module header), so it is not listed either.
 *
 * @param artifacts what the install owns — the applied artifacts, or a state file's.
 */
export function gitignoreBlocks(artifacts: readonly OwnedArtifact[]): readonly IgnoreBlock[] {
  const root = [`${STATE_DIRNAME}/`];
  const shared: string[] = [];

  for (const artifact of artifacts) {
    if (artifact.kind === "harness-config") continue;
    // No trailing slash: a `path:` skill installs as a symlink, which git does not read as a
    // directory, so a `dir/` pattern would leave linked skills tracked. The skills link is also
    // always a symlink and needs the same fix.
    if (isShared(artifact.path)) shared.push(sharedPattern(artifact.path));
    else root.push(artifact.path);
  }

  return [
    { file: GITIGNORE_FILENAME, entries: root },
    { file: SHARED_GITIGNORE_FILE, entries: shared },
  ];
}

/**
 * The `.gitignore` a project should hold, given the one it holds now.
 *
 * @param existing the current contents, or undefined when there is no file yet.
 * @param entries the paths to list, in any order. Empty renders no block, which for the nested file
 *   is the ordinary state of a project that installed no skills.
 * @param file the project-relative path, for the error naming an ambiguous block.
 * @returns the new contents, or `undefined` when nothing would change (so a caller skips the write,
 *   keeping a second identical install byte-identical). `""` when the block was the whole file and
 *   is now gone, telling a caller to delete the file.
 * @throws {AmbitError} exit 2 for a file whose markers cannot be read unambiguously.
 */
export function updateGitignoreText(
  existing: string | undefined,
  entries: readonly string[],
  file: string = GITIGNORE_FILENAME,
): string | undefined {
  if (entries.length === 0) return removeGitignoreText(existing, file);

  const lines = [...splitLines(existing)];
  const block = findBlock(lines, file);
  const rendered = [
    BEGIN_LINE,
    ...[...new Set(entries)].sort(compare).map(escapePattern),
    BLOCK_END,
  ];

  if (block === undefined) {
    // Add one blank line of separation, but only if there is something to separate; a file that
    // already ends in a blank line keeps its own shape.
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") lines.push("");
    lines.push(...rendered);
  } else {
    lines.splice(block.start, block.end - block.start + 1, ...rendered);
  }

  const text = `${lines.join("\n")}\n`;
  return text === existing ? undefined : text;
}

/**
 * The `.gitignore` a project should hold once ambit owns nothing in it — what `clean` writes.
 *
 * The blank line above the block is removed too, since `updateGitignoreText` is what added it;
 * otherwise `install` followed by `clean` would not return a hand-written file to its original
 * bytes. The edge case is a file whose author already ended it with a blank line of their own,
 * which then gets removed along with ambit's.
 *
 * @param existing the current contents, or undefined when there is no file.
 * @param file the project-relative path, for the error naming an ambiguous block.
 * @returns the new contents; `""` when ambit's block was the whole file (caller should delete it);
 *   `undefined` when there is no block to remove.
 * @throws {AmbitError} exit 2 for a file whose markers cannot be read unambiguously.
 */
export function removeGitignoreText(
  existing: string | undefined,
  file: string = GITIGNORE_FILENAME,
): string | undefined {
  const lines = [...splitLines(existing)];
  const block = findBlock(lines, file);
  if (block === undefined) return undefined;

  const start =
    block.start > 0 && lines[block.start - 1]?.trim() === "" ? block.start - 1 : block.start;
  lines.splice(start, block.end - start + 1);

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Reads one of a project's `.gitignore` files, treating an absent one as a file ambit is about to
 * create.
 *
 * @param projectDir the project root, absolute.
 * @param file the project-relative path to read. Defaults to the root file.
 * @throws {AmbitError} exit 2 for a file that is there but cannot be read; overwriting it would
 *   discard lines ambit does not own.
 */
export async function readGitignoreText(
  projectDir: string,
  file: string = GITIGNORE_FILENAME,
): Promise<string | undefined> {
  const target = path.join(projectDir, file);
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw configError(`cannot read ${file}`, [
      error instanceof Error ? error.message : String(error),
      `make ${target} readable, so ambit can rewrite its own block without discarding the rest`,
    ]);
  }
}

/**
 * Writes one file's block, or deletes the file when the block was all of it.
 *
 * @returns whether anything was written.
 */
async function applyBlock(projectDir: string, block: IgnoreBlock): Promise<boolean> {
  const next = updateGitignoreText(
    await readGitignoreText(projectDir, block.file),
    block.entries,
    block.file,
  );
  if (next === undefined) return false;

  const target = path.join(projectDir, block.file);
  if (next === "") {
    await rm(target, { force: true });
    return true;
  }
  // The nested file sits in a directory the install creates, but `prune` and a bundle that installs
  // no skills both reach here without one.
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, next, "utf8");
  return true;
}

/**
 * Rewrites the managed blocks for what an install just wrote.
 *
 * @param projectDir the project root, absolute.
 * @param artifacts what the install owns.
 * @returns the files that changed, in the order they are written.
 * @throws {AmbitError} exit 2 for a `.gitignore` that cannot be read, or whose markers are
 *   ambiguous.
 */
export async function writeGitignoreBlocks(
  projectDir: string,
  artifacts: readonly OwnedArtifact[],
): Promise<readonly string[]> {
  const written: string[] = [];
  for (const block of gitignoreBlocks(artifacts)) {
    if (await applyBlock(projectDir, block)) written.push(block.file);
  }
  return written;
}

/**
 * Whether each managed block is already what an install would write.
 *
 * Used by `install --dry-run` and `doctor`, both of which ask the same renderer that writes:
 * `updateGitignoreText` returning undefined means the file would not change.
 *
 * @param projectDir the project root, absolute.
 * @param artifacts what the install owns, or would own.
 * @throws {AmbitError} exit 2 for a `.gitignore` that cannot be read, or whose markers are
 *   ambiguous.
 */
export async function gitignoreStatus(
  projectDir: string,
  artifacts: readonly OwnedArtifact[],
): Promise<readonly GitignoreStatus[]> {
  const rows: GitignoreStatus[] = [];
  for (const block of gitignoreBlocks(artifacts)) {
    const next = updateGitignoreText(
      await readGitignoreText(projectDir, block.file),
      block.entries,
      block.file,
    );
    rows.push({ file: block.file, changed: next !== undefined });
  }
  return rows;
}

/**
 * Takes ambit's blocks out of a project's `.gitignore` files. Used by `clean`.
 *
 * A file that is nothing but the block is deleted rather than truncated: ambit created it, so
 * leaving an empty one behind would leave a file the project never had.
 *
 * @param projectDir the project root, absolute.
 * @returns the files a block was removed from.
 * @throws {AmbitError} exit 2 for a `.gitignore` that cannot be read, or whose markers are
 *   ambiguous.
 */
export async function removeGitignoreBlocks(projectDir: string): Promise<readonly string[]> {
  const removed: string[] = [];
  for (const file of [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE]) {
    const next = removeGitignoreText(await readGitignoreText(projectDir, file), file);
    if (next === undefined) continue;

    const target = path.join(projectDir, file);
    if (next === "") await rm(target, { force: true });
    else await writeFile(target, next, "utf8");
    removed.push(file);
  }
  return removed;
}

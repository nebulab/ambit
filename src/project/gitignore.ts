/**
 * The managed `.gitignore` blocks.
 *
 * Everything ambit materializes is derived: a skill directory is a copy of, or a link into, a
 * catalog, and `.ambit/state.json` is machine-local by definition. Committing any of it
 * is how a project ends up with two answers to "what is installed" — the one in `ambit.yml` and the
 * one in git — so ambit writes the paths it owns into `.gitignore` itself rather than leaving it to
 * whoever adopts the tool.
 *
 * **Two files, because one of them is the volatile one.** Every installed skill is a path under
 * `.agents/`, so those go in `.agents/.gitignore` where a nested `.gitignore` can reach them — the
 * layout dotagents established, and the reason is that this is the list that changes. Narrow a
 * project's scopes and it churns; the project root's `.gitignore` should not churn with it, because
 * that is a file people read. What stays at the root is what a nested file cannot express: git only
 * matches a pattern against paths beneath the `.gitignore` holding it, so `.ambit/` and the skills
 * link — `.claude/skills`, which belongs to a harness and not to this directory — have nowhere else
 * to go. That root block is two or three lines and identical from one install to the next.
 *
 * `.agents/.gitignore` is itself left tracked. It is generated, but it is generated from `ambit.yml`
 * and `ambit.lock`, both of which a project commits, and it is byte-stable — so committing it costs
 * a reviewable diff and buys a fresh clone and every git worktree the ignore list without running
 * ambit first. Ignoring it would need a root line to hide it and leave a worktree reporting every
 * copied skill as untracked.
 *
 * Neither file is ambit's, so ownership works the way it does for `.mcp.json`: ambit owns part of
 * each document and nothing else. The difference is that a text file has no keys to record in state,
 * so the record is **in band** — the two marker lines. Everything between them is rewritten from the
 * current install, everything outside them is copied through untouched, and a `.gitignore` that
 * predates ambit by years is a normal input rather than a conflict. That is also why a block needs no
 * entry in `.ambit/state.json` and no prune branch: each install renders it afresh from what it just
 * wrote, so a skill that left the bundle leaves the block in the same run. `clean` is the one caller
 * that removes the blocks outright — the same in-band record, read the other way, since state has
 * nothing here to tell it what to delete.
 *
 * The markers are the only thing that can be misread, so both ways of breaking them — a second
 * block, a block whose end line was deleted — stop with exit 2 instead of guessing at a span of
 * lines to overwrite. "Never disturbs surrounding lines" is the claim; a guess is how it would be
 * lost.
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
 * The explanation rides on the marker line rather than a line of its own so that a block is exactly
 * two lines of ambit's prose however many paths it holds — and so an older block written by an
 * earlier ambit, whose wording differed, is still recognized and rewritten rather than orphaned:
 * detection matches the sentinel prefix, not this string.
 */
const BEGIN_LINE = `${BLOCK_BEGIN} - managed block, rewritten by \`ambit install\`; edits are lost`;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One file ambit maintains a block in, and what that block should list.
 *
 * The entries are patterns relative to the file's own directory, because that is what git matches
 * them against — the split between the two files is therefore also a rewrite of the paths, not just
 * a partition of them.
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
 * A `.gitignore` line is a glob, so the characters that would make it match something other than
 * the path get escaped.
 *
 * A skill name is a directory name from a catalog, so this is nearly always a no-op — but "nearly"
 * is the wrong guarantee for a pattern that decides what git tracks. A leading `#` or `!` needs no
 * escape here because every path ambit writes begins with a directory component of its own.
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
 * Split on `\n` alone, so a `\r` stays part of the line it terminates and gets written back exactly
 * as it was found: a CRLF `.gitignore` must not be rewritten wholesale just because ambit rendered
 * three lines in the middle of it.
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
 * @param file the project-relative path, so an error names the file the reader has to go and fix
 *   rather than whichever of the two ambit happened to be writing.
 * @throws {AmbitError} exit 2 for two blocks, or for a block with no end line. Either one means the
 *   span ambit may overwrite is ambiguous, and the two failure modes of guessing — rewriting one
 *   block and leaving a stale second, or swallowing every line below an orphaned begin marker — are
 *   both worse than stopping.
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
 * The leading `/` is what anchors it: without one, git would match the pattern at any depth below
 * `.agents/`, so a skill called `skills` would start ignoring paths nobody asked about.
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
 * Every installed skill lands under the shared directory and is listed in the nested file; ambit's
 * state directory and the skills link cannot be reached from there and stay at the root. The
 * partition is by path rather than by artifact kind, so a harness that one day puts a skills link
 * inside `.agents/` needs no change here.
 *
 * Not `.mcp.json`, and not `ambit.lock`: both are files a team may well want committed, and only one
 * of them is even an owned artifact. Not `.agents/.gitignore` either — it is generated but tracked
 * (see this module's header). Ordering is the renderer's business, so the entries come back as the
 * install reported them.
 *
 * @param artifacts what the install owns — the applied artifacts, or a state file's.
 */
export function gitignoreBlocks(artifacts: readonly OwnedArtifact[]): readonly IgnoreBlock[] {
  const root = [`${STATE_DIRNAME}/`];
  const shared: string[] = [];

  for (const artifact of artifacts) {
    if (artifact.kind !== "skill-dir" && artifact.kind !== "skills-link") continue;
    // No trailing slash, deliberately: a `path:` skill is installed as a symlink, git does
    // not read a symlink as a directory, and a `dir/` pattern would therefore leave every linked
    // skill tracked. Without the slash one pattern covers both modes — and the skills link, which is
    // always a symlink, needs it for the same reason.
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
 * @returns the new contents, or `undefined` when they would be what is already there — so a caller
 *   skips the write rather than touching a file it has nothing to change, which is what keeps a
 *   second identical install byte-identical. `""` when the block was the whole file and the block is
 *   gone, which is a caller's cue to delete the file.
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
    // One blank line of separation, and only when there is something to separate the block from: a
    // file that already ends in a blank line keeps the shape its author gave it.
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
 * The blank line above the block goes with it, because that separator is ambit's own doing
 * (`updateGitignoreText` adds it), and leaving it behind would mean `install` followed by `clean`
 * never returns a hand-written file to the bytes it had. The one file that comes back changed is one
 * whose author happened to end it with a blank line of their own, which costs a blank line and
 * nothing else — the alternative costs every project one, forever.
 *
 * @param existing the current contents, or undefined when there is no file.
 * @param file the project-relative path, for the error naming an ambiguous block.
 * @returns the new contents; `""` when ambit's block was the whole file, which is a caller's cue to
 *   delete it rather than leave an empty one where the project had none; `undefined` when there is no
 *   block to remove, so a caller writes nothing at all.
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
 * @throws {AmbitError} exit 2 for a file that is there but cannot be read. Writing a fresh one over
 *   it would discard lines ambit does not own, which is the one thing this module exists to prevent.
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
 * @returns the files that changed, in the order they are written — so a report says which, rather
 *   than that something somewhere did.
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
 * The question `install --dry-run` and `doctor` both ask, and they ask it of the same renderer that
 * writes — `updateGitignoreText` returning undefined is precisely "this file would not change".
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
 * Takes ambit's blocks out of a project's `.gitignore` files — the other half of ownership, for
 * `clean`.
 *
 * A file that is nothing but the block is deleted rather than truncated: ambit created it, so
 * leaving an empty one behind would be leaving a file the project never had.
 *
 * @param projectDir the project root, absolute.
 * @returns the files a block was removed from, so a report can say which had one at all.
 * @throws {AmbitError} exit 2 for a `.gitignore` that cannot be read, or whose markers are
 *   ambiguous — the same refusal writing it makes, for the same reason.
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

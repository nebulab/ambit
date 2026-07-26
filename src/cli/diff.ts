/**
 * Rendering a catalog edit as a diff — what `--dry-run` shows instead of
 * writing.
 *
 * It lives beside the editor rather than inside any one command because every authoring mutation owes
 * the same promise, and a per-command renderer is a per-command chance for two previews of the same
 * edit to look different. {@link applyCatalogEdit} already returns each change with the bytes the file
 * holds now, which is everything needed here.
 *
 * This is a **reading aid, not a patch**. It is line-oriented and deliberately says nothing about a
 * missing final newline or about bytes inside a line, so it must not be fed to `git apply`; the bytes
 * themselves travel in `--json`, which is what a tool that wants to apply them should read. What the
 * renderer does guarantee is determinism: the operations are the longest-common-subsequence of the two
 * line lists with removals ordered before additions at every tie, so one edit renders one way.
 */
import type { CatalogTreeChange, EditedFile } from "../authoring/editor.js";

/** Unchanged lines kept either side of a change, so a reader can find it in the file. */
const CONTEXT_LINES = 3;

/** Stands in for the unchanged lines between two changes, so a long file shows only what moved. */
const ELISION = "...";

/** What happened to a file, as the diff's header for it says. */
export type ChangeKind = "created" | "removed" | "updated";

type OperationKind = "add" | "keep" | "remove";

const PREFIX: Readonly<Record<OperationKind, string>> = { add: "+ ", keep: "  ", remove: "- " };

interface Operation {
  readonly kind: OperationKind;
  readonly text: string;
}

/** What a change did to the file, from what it holds now and what it would hold. */
export function changeKindOf(change: EditedFile): ChangeKind {
  if (change.before === undefined) return "created";
  return change.text === null ? "removed" : "updated";
}

/**
 * What happened to a directory, in one phrase.
 *
 * Exported because a command's own report says the same thing about the same operation, and two
 * wordings for one move is exactly the drift this module exists to prevent. The trailing `/` is what
 * tells a reader the path is a directory rather than an oddly named file.
 */
export function treeChangeSummary(tree: CatalogTreeChange): string {
  return tree.to === null ? "removed" : `moved to ${tree.to}/`;
}

/**
 * A text's lines, without the empty one a trailing newline would otherwise produce.
 *
 * An empty file is zero lines rather than one, which is what makes a created file render as pure
 * additions with no phantom blank line at the top.
 */
function linesOf(text: string): readonly string[] {
  if (text === "") return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

/**
 * The edit from `before` to `after` as a line-by-line operation list.
 *
 * A full longest-common-subsequence table, because a catalog document is tens of lines and the cost of
 * an exact answer at that size is nothing next to the cost of a preview that misaligns a hunk. Ties
 * resolve toward removal, so the operations are a function of the two texts alone.
 */
function operations(before: readonly string[], after: readonly string[]): readonly Operation[] {
  const rows = before.length;
  const columns = after.length;

  // `table[row][column]` is the length of the longest common subsequence of the two *suffixes*
  // starting there, so the backtrack below can walk forward and emit in file order.
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  const lengthAt = (row: number, column: number): number => table[row]?.[column] ?? 0;

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const line = table[row];
      if (line === undefined) continue;
      line[column] =
        before[row] === after[column]
          ? lengthAt(row + 1, column + 1) + 1
          : Math.max(lengthAt(row + 1, column), lengthAt(row, column + 1));
    }
  }

  const result: Operation[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      result.push({ kind: "keep", text: before[row] ?? "" });
      row += 1;
      column += 1;
    } else if (lengthAt(row + 1, column) >= lengthAt(row, column + 1)) {
      result.push({ kind: "remove", text: before[row] ?? "" });
      row += 1;
    } else {
      result.push({ kind: "add", text: after[column] ?? "" });
      column += 1;
    }
  }
  for (; row < rows; row += 1) result.push({ kind: "remove", text: before[row] ?? "" });
  for (; column < columns; column += 1) result.push({ kind: "add", text: after[column] ?? "" });

  return result;
}

/** Which operations are shown: every change, and {@link CONTEXT_LINES} of unchanged lines around it. */
function shown(edit: readonly Operation[]): readonly boolean[] {
  const visible = edit.map(() => false);
  edit.forEach((operation, index) => {
    if (operation.kind === "keep") return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(edit.length - 1, index + CONTEXT_LINES);
    for (let position = from; position <= to; position += 1) visible[position] = true;
  });
  return visible;
}

/**
 * One file's diff body: a prefixed line per shown operation, with elided runs collapsed.
 *
 * Trailing whitespace is trimmed, so a blank added line reads as a bare `+` rather than as `+` and a
 * space — output no command in this tool emits.
 */
export function diffLines(before: string, after: string): readonly string[] {
  const edit = operations(linesOf(before), linesOf(after));
  const visible = shown(edit);
  // Nothing changed, so there is nothing to elide *around* either: two identical texts diff to nothing
  // rather than to a marker standing in for the whole file.
  if (!visible.includes(true)) return [];

  const lines: string[] = [];
  let elided = false;
  edit.forEach((operation, index) => {
    if (visible[index] !== true) {
      elided = true;
      return;
    }
    if (elided) lines.push(ELISION);
    elided = false;
    lines.push(`${PREFIX[operation.kind]}${operation.text}`.trimEnd());
  });
  if (elided) lines.push(ELISION);

  return lines;
}

/** One file's block: what happened to it, then its diff, indented under the header. */
function fileBlock(change: EditedFile): readonly string[] {
  const body = diffLines(change.before ?? "", change.text ?? "");
  return [`${change.file} (${changeKindOf(change)})`, ...body.map((line) => `  ${line}`)];
}

/**
 * One directory's block: a header and nothing else.
 *
 * A move changes no bytes and a removal's bytes are not worth reprinting, so there is no body to show —
 * what a reader needs from a destructive preview is the path, and the diff of any document inside it
 * that the same edit rewrites comes from {@link fileBlock}.
 */
function treeBlock(tree: CatalogTreeChange): readonly string[] {
  return [`${tree.directory}/ (${treeChangeSummary(tree)})`];
}

/**
 * An edit as a titled, counted diff section, in the shape every other command's output sections take
 * (`section` in `src/cli/output.ts`) so a preview reads like the rest of the tool.
 *
 * @param title the section's heading, conventionally `diff`.
 * @param changes the edit's file changes, in the path order {@link applyCatalogEdit} returns them in.
 * @param trees the directories it moves or removes, listed first: a reader has to see that a whole tree
 *   is going before reading a diff of one file inside it.
 */
export function diffSection(
  title: string,
  changes: readonly EditedFile[],
  trees: readonly CatalogTreeChange[] = [],
): readonly string[] {
  const blocks = [...trees.map(treeBlock), ...changes.map(fileBlock)];
  const body =
    blocks.length === 0
      ? ["(none)"]
      : blocks.flatMap((block, index) => [...(index === 0 ? [] : [""]), ...block]);

  return [`${title} (${blocks.length})`, ...body.map((line) => `  ${line}`.trimEnd()), ""];
}

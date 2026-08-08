/**
 * Shaping for command output.
 *
 * Both output modes have a determinism requirement behind them: `--json` is compared as a golden
 * file, and the text form is what a human diffs between runs. So JSON records are built
 * in the order they are given rather than by object-key luck, and text sections are laid out from
 * one place so `search` and `resolve` cannot drift into looking like different tools.
 */

/** A record with the keys in the order given, so the emitted JSON is byte-stable. */
export function keyed<T>(
  items: readonly T[],
  name: (item: T) => string,
  value: (item: T) => unknown,
): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  for (const item of items) record[name(item)] = value(item);
  return record;
}

/** Pads every column but the last, so the eye can run down a section. */
export function columns(rows: readonly (readonly string[])[]): readonly string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/** A titled, counted, indented block, closed by a blank line. */
export function section(title: string, rows: readonly (readonly string[])[]): readonly string[] {
  const body = rows.length === 0 ? ["(none)"] : columns(rows);
  return [`${title} (${rows.length})`, ...body.map((line) => `  ${line}`), ""];
}

/**
 * Prints section lines, dropping the trailing blank line that closes the last one — it separates
 * sections from each other, not the output from the shell prompt.
 */
export function printSections(lines: readonly string[], stdout: (line: string) => void): void {
  for (const line of lines.slice(0, lines.length - 1)) stdout(line);
}

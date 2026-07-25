/**
 * How ambit writes a scaffolded file that is documentation as much as configuration (spec §6).
 *
 * A scaffold is not a template. Every value goes through {@link emitYaml}, and the prose around it is
 * added as comments afterwards, so stripping the comment lines from a scaffolded file leaves exactly
 * what ambit would emit from the same values (spec §3.0) — sorted keys, quoting where a string could
 * coerce, byte-stable across runs and machines. Templating the same file as text would let it drift
 * into an unsorted key or an unquoted `1e5` that the very parser it is written for rejects, and
 * nothing would notice until someone ran the tool.
 *
 * Blocks are laid out in sorted-key order for the same reason, including a block shown commented out:
 * the one part of a scaffold a reader is expected to uncomment must leave the file sorted, and must be
 * valid YAML the moment the `# ` comes off.
 *
 * `ambit init` and `ambit catalog init` both render through here, so a project scaffold and a catalog
 * scaffold cannot look like the work of two different tools.
 */
import { emitYaml } from "./yaml.js";

/** One commented block of a scaffolded file: prose, then at most one of the two YAML forms. */
export interface ScaffoldBlock {
  /** Prose, one entry per emitted line. An empty entry is a bare `#` separator. */
  readonly comment: readonly string[];
  /** Keys this block sets. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Keys shown commented out, for something only the reader can supply. */
  readonly example?: Readonly<Record<string, unknown>>;
}

/** Prefixes prose as YAML comments, leaving a blank entry as a bare `#` rather than `# `. */
function commentOut(lines: readonly string[]): readonly string[] {
  return lines.map((line) => (line === "" ? "#" : `# ${line}`));
}

function emittedLines(values: Readonly<Record<string, unknown>>): readonly string[] {
  return emitYaml(values).trimEnd().split("\n");
}

function renderBlock(block: ScaffoldBlock): string {
  return [
    ...commentOut(block.comment),
    ...(block.example === undefined ? [] : commentOut(emittedLines(block.example))),
    ...(block.values === undefined ? [] : emittedLines(block.values)),
  ].join("\n");
}

/**
 * A scaffolded file, as bytes: each block separated by a blank line, with a trailing newline.
 *
 * Pure and byte-stable — the output is a function of the blocks alone, so two runs on two machines
 * scaffold the same file.
 */
export function renderScaffold(blocks: readonly ScaffoldBlock[]): string {
  return `${blocks.map(renderBlock).join("\n\n")}\n`;
}

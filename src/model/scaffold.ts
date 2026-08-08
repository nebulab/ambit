/**
 * How ambit writes a scaffolded file that is documentation as much as configuration.
 *
 * A scaffold is not a template. Every value goes through {@link emitYaml}, and prose is added as
 * comments afterwards, so stripping the comment lines from a scaffolded file leaves exactly what
 * ambit would emit from the same values: sorted keys, quoting where a string could coerce,
 * byte-stable across runs and machines. Templating the file as text instead could drift into an
 * unsorted key or an unquoted `1e5` that the parser it is written for rejects, unnoticed until
 * someone ran the tool.
 *
 * Blocks are laid out in sorted-key order for the same reason, including a block shown commented
 * out: uncommenting it must leave the file sorted and produce valid YAML immediately.
 *
 * `ambit init` is the only caller now that a project and a catalog are scaffolded by one command.
 * This stays a separate module because the emit-then-comment rule is a property of how ambit writes
 * a documented file, not of which file is being written, so a future scaffold should reuse it
 * rather than reinvent it as a template.
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

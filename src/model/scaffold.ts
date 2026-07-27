/**
 * How ambit writes a scaffolded file that is documentation as much as configuration.
 *
 * A scaffold is not a template. Every value goes through {@link emitYaml}, and the prose around it is
 * added as comments afterwards, so stripping the comment lines from a scaffolded file leaves exactly
 * what ambit would emit from the same values — sorted keys, quoting where a string could
 * coerce, byte-stable across runs and machines. Templating the same file as text would let it drift
 * into an unsorted key or an unquoted `1e5` that the very parser it is written for rejects, and
 * nothing would notice until someone ran the tool.
 *
 * Blocks are laid out in sorted-key order for the same reason, including a block shown commented out:
 * the one part of a scaffold a reader is expected to uncomment must leave the file sorted, and must be
 * valid YAML the moment the `# ` comes off.
 *
 * `ambit init` and `ambit catalog init` both render through here, so a project scaffold and a catalog
 * scaffold cannot look like the work of two different tools. They also aim at the *same file* — a repo
 * that publishes a catalog and installs skills for itself writes both halves of one `ambit.yml` — so
 * either may find the other's work already there, and {@link appendScaffold} is how the second one
 * adds its half without touching the first's.
 */
import { CONFIG_VERSION } from "./config.js";
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

/**
 * The `version` block, which both scaffolders write and neither owns.
 *
 * One config format, one version key: whichever command creates the file writes it, and the other
 * finds it already there. Shared rather than duplicated so the two cannot describe it differently in
 * the file they both write.
 */
export const VERSION_BLOCK: ScaffoldBlock = {
  comment: ["The config format version. `1` is the only one this build understands."],
  values: { version: CONFIG_VERSION },
};

/** The keys a block writes, or shows commented out for a reader to uncomment. */
function blockKeys(block: ScaffoldBlock): readonly string[] {
  return Object.keys(block.values ?? block.example ?? {});
}

/**
 * A scaffold's blocks appended to a document that already exists, skipping any the document already
 * answers.
 *
 * Appended as *text*, comments and all, rather than inserted key by key: that is what preserves the
 * other half's bytes exactly — its comments, its key order, its quoting — while keeping this half's
 * prose, which is most of what a scaffold is for. The cost is that the merged document's keys are no
 * longer in sorted order, which matters to a file ambit emits and not to one a person now maintains.
 *
 * A block with no keys is dropped: those carry the header prose that introduces a fresh file, and a
 * file that already exists has already been introduced.
 *
 * @param existing the document's current bytes.
 * @param holds whether the document already has a key.
 * @returns the bytes to write, or `existing` unchanged when the document answers every block.
 */
export function appendScaffold(
  existing: string,
  blocks: readonly ScaffoldBlock[],
  holds: (key: string) => boolean,
): string {
  const missing = blocks.filter((block) => {
    const keys = blockKeys(block);
    return keys.length > 0 && !keys.some(holds);
  });
  if (missing.length === 0) return existing;

  // Exactly one blank line between what was there and what is added, however the existing document
  // ended: a scaffold's own blocks are separated that way, and the seam should not read differently.
  return `${existing.replace(/\n*$/, "\n")}\n${renderScaffold(missing)}`;
}

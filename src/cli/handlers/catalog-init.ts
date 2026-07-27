/**
 * `ambit catalog init` — scaffold a catalog.
 *
 * Three sections rather than one, because "created", "updated" and "kept" are three different pieces of
 * news: a catalog is usually initialized inside a repo that already has a README, and a repo that ran
 * `ambit init` first has an `ambit.yml` this command adds its `catalog:` block to rather than writes. A
 * reader has to be able to see which of the three happened to each file. All are printed even when
 * empty, the way every other counted section in this tool is, so a quiet run is distinguishable from a
 * run that did nothing.
 *
 * `--dry-run` swaps the closing next-step line for the diff authoring rule 6 promises. It deliberately
 * does *not* follow `install --dry-run`'s "the same output plus extra sections" shape: there the preview
 * renders a plan that exists either way, whereas here the plan *is* the bytes, so the heading has to
 * hedge (`would create`) and the bytes themselves are the only thing worth previewing — the same call
 * `ambit init --dry-run` makes.
 */
import type { CatalogInitResult } from "../../authoring/init.js";
import { initCatalog } from "../../authoring/init.js";
import type { EditedFile } from "../../authoring/editor.js";
import type { CommandHandler } from "../commands.js";
import { catalogDirOf, dryRunRequested, jsonRequested } from "../commands.js";
import { diffSection } from "../diff.js";
import { ExitCode } from "../../errors.js";
import { printSections, section } from "../output.js";

/** The one thing left to do: a catalog with no skills installs nothing. */
const NEXT_STEP =
  "next: register your scopes with `ambit catalog scope add`, then add a skill with `ambit catalog skill new`";

/**
 * The changes that wrote a file that was not there, and the ones that added to a file that was.
 *
 * `before` is what says which: the editor records the bytes a change is replacing, and its absence
 * means there were none. That is the same fact the diff renders, read once for the headings.
 */
function split(changes: readonly EditedFile[]): {
  readonly created: readonly EditedFile[];
  readonly updated: readonly EditedFile[];
} {
  return {
    created: changes.filter((change) => change.before === undefined),
    updated: changes.filter((change) => change.before !== undefined),
  };
}

function files(changes: readonly EditedFile[]): readonly (readonly string[])[] {
  return changes.map((change) => [change.file]);
}

function bytes(changes: readonly EditedFile[]): readonly Readonly<Record<string, unknown>>[] {
  return changes.map((change) => ({ file: change.file, text: change.text }));
}

function toJson(result: CatalogInitResult): Readonly<Record<string, unknown>> {
  const { created, updated } = split(result.changes);
  return {
    created: bytes(created),
    updated: bytes(updated),
    kept: result.kept,
    written: result.written,
  };
}

function rows(names: readonly string[]): readonly (readonly string[])[] {
  return names.map((file) => [file]);
}

function toText(result: CatalogInitResult): readonly string[] {
  const { created, updated } = split(result.changes);

  return [
    ...section(result.written ? "created" : "would create", files(created)),
    ...section(result.written ? "updated" : "would update", files(updated)),
    ...section("kept", rows(result.kept)),
    ...(result.written ? [NEXT_STEP, ""] : diffSection("diff", result.changes)),
  ];
}

export const catalogInitHandler: CommandHandler = async (ctx) => {
  const result = await initCatalog(catalogDirOf(ctx), { dryRun: dryRunRequested(ctx) });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result), ctx.stdout);

  return ExitCode.Success;
};

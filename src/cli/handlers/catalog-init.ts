/**
 * `ambit catalog init` — scaffold a catalog.
 *
 * Two sections rather than one, because "created" and "kept" are different news: a catalog is usually
 * initialized inside a repo that already has a README, and a reader has to be able to see that theirs
 * was left alone. Both are printed even when empty, the way every other counted section in this tool
 * is, so a quiet run is distinguishable from a run that did nothing.
 *
 * The heading follows `--dry-run` rather than whether anything was written, because a run that wrote
 * nothing is now the ordinary second run: with no file left that makes a directory a catalog, every
 * scaffold file that is already there is kept, and "would create (0)" would be a preview of nothing.
 *
 * `--dry-run` swaps the closing next-step line for the diff authoring rule 6 promises. It deliberately
 * does *not* follow `install --dry-run`'s "the same output plus extra sections" shape: there the preview
 * renders a plan that exists either way, whereas here the plan *is* the bytes, so the heading has to
 * hedge (`would create`) and the bytes themselves are the only thing worth previewing — the same call
 * `ambit init --dry-run` makes.
 */
import type { CatalogInitResult } from "../../authoring/init.js";
import { initCatalog } from "../../authoring/init.js";
import type { CommandHandler } from "../commands.js";
import { catalogDirOf, dryRunRequested, jsonRequested } from "../commands.js";
import { diffSection } from "../diff.js";
import { ExitCode } from "../../errors.js";
import { printSections, section } from "../output.js";

/**
 * The one thing left to do: a catalog with no skills installs nothing.
 *
 * It names the file rather than a command, because there is no command: a catalog is Markdown and
 * YAML, and an author has an editor. `README.md` is in the scaffold, so the next step after that one
 * is written down where the person who runs this will be looking.
 */
const NEXT_STEP =
  "next: add a skill in `skills/<name>/SKILL.md`, tagged with who needs it — see `README.md`";

function toJson(result: CatalogInitResult): Readonly<Record<string, unknown>> {
  return {
    created: result.created.map((change) => ({ file: change.file, text: change.text })),
    kept: result.kept,
    written: result.written,
  };
}

function rows(files: readonly string[]): readonly (readonly string[])[] {
  return files.map((file) => [file]);
}

function toText(result: CatalogInitResult, dryRun: boolean): readonly string[] {
  const created = result.created.map((change) => change.file);

  return [
    ...section(dryRun ? "would create" : "created", rows(created)),
    ...section("kept", rows(result.kept)),
    ...(dryRun ? diffSection("diff", result.created) : [NEXT_STEP, ""]),
  ];
}

export const catalogInitHandler: CommandHandler = async (ctx) => {
  const dryRun = dryRunRequested(ctx);
  const result = await initCatalog(catalogDirOf(ctx), { dryRun });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result, dryRun), ctx.stdout);

  return ExitCode.Success;
};

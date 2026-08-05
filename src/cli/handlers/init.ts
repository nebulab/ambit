/**
 * `ambit init` — scaffold a project, which is also a catalog.
 *
 * Two counted sections rather than a line, because the command writes four files and "created" and
 * "kept" are different news: a project is routinely initialized inside a repo that already has a
 * `skills/` directory, and a reader has to be able to see that theirs was left alone. Both are
 * printed even when empty, the way every other counted section in this tool is, so a quiet run is
 * distinguishable from a run that did nothing.
 *
 * `--dry-run` prints the config's bytes in place of the next step. For every other command a preview
 * is a rendering of a plan; here the plan *is* the bytes, so printing anything less would be
 * withholding the only thing worth previewing. The three `.gitkeep` files have no bytes to withhold —
 * the whole of each one is its path, which the section above already lists. `--json` carries every
 * file either way, so a consuming tool that wants to write the scaffold itself can.
 */
import type { CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import type { InitResult } from "../../project/init.js";
import { initProject } from "../../project/init.js";
import { printSections, section } from "../output.js";

/**
 * The two things left to do, in the order they have to happen in.
 *
 * A scaffolded project selects nothing — its `requires` block is commented out, because an entry
 * matching nothing is exit 3 and its own `local` catalog is empty — so `ambit install` on it installs
 * nothing at all. That is the honest state of a fresh project, and saying so here is what stops a
 * reader hitting it as a surprise.
 */
const NEXT_STEPS: readonly string[] = [
  "next: put a skill in `skills/<name>/SKILL.md`, or add a catalog under `catalogs`",
  "      then uncomment a `requires` entry that selects it, and run `ambit install`",
];

function toJson(result: InitResult): Readonly<Record<string, unknown>> {
  return {
    created: result.created.map((scaffolded) => ({
      file: scaffolded.file,
      text: scaffolded.text,
    })),
    kept: result.kept,
    written: result.written,
  };
}

function rows(files: readonly string[]): readonly (readonly string[])[] {
  return files.map((file) => [file]);
}

/** The bytes `--dry-run` withheld: every created file that has any, which is the config. */
function preview(result: InitResult): readonly string[] {
  return result.created
    .filter((scaffolded) => scaffolded.text !== "")
    .flatMap((scaffolded) => [scaffolded.text.trimEnd(), ""]);
}

function toText(result: InitResult, dryRun: boolean): readonly string[] {
  return [
    ...section(dryRun ? "would create" : "created", rows(result.created.map((file) => file.file))),
    ...section("kept", rows(result.kept)),
    ...(dryRun ? preview(result) : [...NEXT_STEPS, ""]),
  ];
}

export const initHandler: CommandHandler = async (ctx) => {
  const dryRun = dryRunRequested(ctx);
  const result = await initProject(projectDirOf(ctx), { dryRun });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result, dryRun), ctx.stdout);

  return ExitCode.Success;
};

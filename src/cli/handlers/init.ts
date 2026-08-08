/**
 * `ambit init` — scaffold a project, which is also a catalog.
 *
 * Two counted sections, not one line: "created" and "kept" are different news, since a project is
 * routinely initialized inside a repo that already has a `skills/` directory and a reader needs to
 * see that theirs was left alone. Both sections print even when empty, so a quiet run is
 * distinguishable from a run that did nothing.
 *
 * `--dry-run` prints the config's bytes instead of the next step, since here the plan is the bytes.
 * The three `.gitkeep` files have nothing further to show; their whole content is the path already
 * listed above. `--json` carries every file either way, so a consuming tool can write the scaffold
 * itself.
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
 * A scaffolded project selects nothing: its `requires` block is commented out, because an entry
 * matching nothing is exit 3 and its own `local` catalog starts empty. `ambit install` on it would
 * install nothing, so these steps say so up front rather than let it be a surprise.
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

/**
 * `ambit init` — scaffold an `ambit.yml`.
 *
 * The output is deliberately two lines rather than a table: there is one artifact and one thing left
 * to do, and the thing left to do is not optional. A scaffolded config holds `core` and no catalog,
 * so `ambit install` on it fails with `core` unregistered — which is the honest state of a project
 * nobody has pointed at a catalog yet, and the next step says so before the reader hits it.
 *
 * `--dry-run` prints the bytes instead. For every other command a preview is a rendering of a plan;
 * here the plan *is* the bytes, so printing anything less would be withholding the only thing worth
 * previewing. A run that *adds* the project half to a catalog's existing config previews as a diff
 * instead: there the bytes are mostly the author's own, and a diff is what says which of them are new.
 * `--json` carries the whole document either way, so a consuming tool that wants to write it itself can.
 */
import type { CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, projectDirOf } from "../commands.js";
import { diffSection } from "../diff.js";
import { ExitCode } from "../../errors.js";
import { printSections } from "../output.js";
import type { InitResult } from "../../project/init.js";
import { initProject } from "../../project/init.js";

function toJson(result: InitResult): Readonly<Record<string, unknown>> {
  return {
    file: result.file,
    text: result.text,
    updated: result.before !== undefined,
    written: result.written,
  };
}

export const initHandler: CommandHandler = async (ctx) => {
  const result = await initProject(projectDirOf(ctx), { dryRun: dryRunRequested(ctx) });

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(result), null, 2));
    return ExitCode.Success;
  }

  // "created" or "updated": a catalog repo that runs this already has the file, and gets the consumer
  // keys added to it.
  const before = result.before;
  const verb = before === undefined ? "create" : "update";

  if (result.written) {
    ctx.stdout(`${verb}d ${result.file}`);
    ctx.stdout("next: add a catalog under `catalogs`, edit `scopes`, then run `ambit install`");
    return ExitCode.Success;
  }

  ctx.stdout(`would ${verb} ${result.file}`);
  ctx.stdout("");
  if (before === undefined) ctx.stdout(result.text.trimEnd());
  else
    printSections(
      diffSection("diff", [{ file: result.file, text: result.text, before }]),
      ctx.stdout,
    );

  return ExitCode.Success;
};

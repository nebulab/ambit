/**
 * `ambit init` — scaffold an `ambit.yml` (spec §6).
 *
 * The output is deliberately two lines rather than a table: there is one artifact and one thing left
 * to do, and the thing left to do is not optional. A scaffolded config holds `core` and no catalog,
 * so `ambit install` on it fails with `core` unregistered — which is the honest state of a project
 * nobody has pointed at a catalog yet, and the next step says so before the reader hits it.
 *
 * `--dry-run` prints the bytes instead. For every other command a preview is a rendering of a plan;
 * here the plan *is* the bytes, so printing anything less would be withholding the only thing worth
 * previewing. `--json` carries them either way, so a consuming tool that wants to write the scaffold
 * itself can.
 */
import type { CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../errors.js";
import type { InitResult } from "../init.js";
import { initProject } from "../init.js";

function toJson(result: InitResult): Readonly<Record<string, unknown>> {
  return { created: result.created, file: result.file, text: result.text };
}

export const initHandler: CommandHandler = async (ctx) => {
  const result = await initProject(projectDirOf(ctx), { dryRun: dryRunRequested(ctx) });

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(result), null, 2));
    return ExitCode.Success;
  }

  if (result.created) {
    ctx.stdout(`created ${result.file}`);
    ctx.stdout("next: add a catalog under `catalogs`, edit `scopes`, then run `ambit install`");
  } else {
    ctx.stdout(`would create ${result.file}`);
    ctx.stdout("");
    ctx.stdout(result.text.trimEnd());
  }

  return ExitCode.Success;
};

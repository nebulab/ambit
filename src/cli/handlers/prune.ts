/**
 * `ambit prune` — remove owned artifacts not in the current bundle (spec §6).
 *
 * The report is what was removed, not what survived: someone who narrows `ambit.yml` runs this to
 * find out that the skill they dropped is gone, and a list of everything still installed is what
 * `ambit status` is for. A run with nothing to remove says so explicitly — `(none)` under a counted
 * heading — rather than printing nothing, so a quiet prune is distinguishable from a prune that did
 * not run.
 */
import type { PruneResult } from "../clean.js";
import { pruneProject } from "../clean.js";
import type { CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, offlineRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../errors.js";
import { printSections, section } from "../output.js";
import { artifactJson, removalRows } from "./artifacts.js";

function toJson(result: PruneResult): Readonly<Record<string, unknown>> {
  return {
    pruned: result.pruned.map(artifactJson),
    remaining: result.remaining.map(artifactJson),
  };
}

function toText(result: PruneResult): readonly string[] {
  return [...section("pruned", removalRows(result.pruned))];
}

export const pruneHandler: CommandHandler = async (ctx) => {
  const result = await pruneProject(projectDirOf(ctx), {
    offline: offlineRequested(ctx),
    dryRun: dryRunRequested(ctx),
  });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result), ctx.stdout);
  return ExitCode.Success;
};

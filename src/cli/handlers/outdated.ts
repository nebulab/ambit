/**
 * `ambit outdated` — where every catalog's pin stands, and what moving it would bring.
 *
 * Four sections rather than a list of stale catalogs: the first says which pins have somewhere to go,
 * and the three after it say what going there would actually change. A catalog can be many commits
 * ahead while the bundle doesn't move at all, and only the second half of the report can show that.
 *
 * Reaches the remote but leaves the cache's own refs alone, so running it never changes what a later
 * `ambit install` installs. Under `--offline` it refuses rather than reporting `current` from a cache
 * that has no way to know that.
 *
 * Exit 0 whatever it finds: being behind is a fact, not a failure. `--json` carries `outdated` and
 * `changed` for a script that wants to branch on it.
 */
import type { CommandContext, CommandHandler, CommandRule } from "../commands.js";
import { jsonRequested, offlineRequested, projectDirOf } from "../commands.js";
import { ExitCode, networkError } from "../../errors.js";
import { isUnchanged } from "../../project/bundle-diff.js";
import type { UpdatePlan } from "../../project/update.js";
import { checkOutdated, hasOutdated } from "../../project/update.js";
import { diffJson, diffSections, pinJson, pinRows } from "./pins.js";
import { printSections, section } from "../output.js";

/**
 * Both commands' refusal of `--offline`.
 *
 * A rule, not a check inside the handler, so Commander enforces it before dispatch and a run that
 * cannot mean anything never starts. Refuses rather than silently falling back to the cache: only the
 * remote knows where a branch points now, and a cached commit reported as current is worse than no
 * report at all.
 *
 * @throws {AmbitError} exit 4 when `--offline` was given.
 */
export const refusesOfflineRule: CommandRule = (ctx: CommandContext) => {
  if (!offlineRequested(ctx)) return;

  throw networkError("`--offline` cannot answer where a ref points now", [
    "this command asks each catalog's remote for its current commit, which the cache cannot know",
    "run the command again without `--offline`",
  ]);
};

/** Whether every namespace agrees the bundle would not move — what the report leads with in JSON. */
function toJson(plan: UpdatePlan): Readonly<Record<string, unknown>> {
  return {
    catalogs: pinJson(plan.catalogs),
    changed: !isUnchanged(plan.diff),
    ...diffJson(plan.diff),
    outdated: hasOutdated(plan),
  };
}

/**
 * The four sections, catalogs first.
 *
 * Every configured catalog is listed, not only the moved ones: "your other three are current" is
 * part of the answer, and a report of only problems couldn't distinguish a clean project from one it
 * forgot to check.
 */
export function planText(plan: UpdatePlan): readonly string[] {
  return [...section("catalogs", pinRows(plan.catalogs)), ...diffSections(plan.diff)];
}

export const outdatedHandler: CommandHandler = async (ctx) => {
  const plan = await checkOutdated(projectDirOf(ctx));

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(plan), null, 2));
  else printSections(planText(plan), ctx.stdout);

  return ExitCode.Success;
};

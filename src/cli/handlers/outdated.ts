/**
 * `ambit outdated` — where every catalog's pin stands, and what moving it would bring.
 *
 * Four sections rather than a list of stale catalogs: the first says which pins have somewhere to go,
 * and the three after it say what going there would actually change. A project whose company catalog
 * is two hundred commits ahead and whose bundle would not move by a byte is a project with nothing to
 * do, and only the second half of the report can say so.
 *
 * Read-only in the sense that matters: it reaches the remote but leaves the cache's own refs alone, so
 * running it never changes what a later `ambit install` installs. Under `--offline` it refuses rather
 * than reporting `current` from a cache that has no way to know — which is exactly the answer that
 * would send someone away believing they were up to date.
 *
 * Exit 0 whatever it finds. Being behind is a fact about the world rather than a failure, and nothing
 * about it should stop a script; `--json` carries `outdated` and `changed` for a script that wants to
 * branch on it.
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
 * A rule rather than a check inside the handler, for the reason every rule exists: Commander enforces
 * it before dispatch, so a run that cannot mean anything never starts. And a refusal rather than a
 * silent fallback to the cache, because the fallback answers the question wrongly rather than not at
 * all — only the remote knows where a branch points now, and a cached commit reported as the current
 * one is worse than no report.
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
 * Every configured catalog is listed, not only the moved ones: "your other three are current" is part
 * of the answer, and a report that showed only problems would leave a reader unable to tell a clean
 * project from a catalog it forgot to check.
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

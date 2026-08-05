/**
 * `ambit update [<catalog>…]` — move the pins, write the lock, materialize, prune.
 *
 * The report is `outdated`'s with the install's own two sections appended, and in that order: what
 * changed about the *bundle* is the answer someone ran the command for, and what changed about the
 * *project* is how it landed. Reusing the projections is what keeps the two commands from describing
 * one update two ways (`pins.ts`).
 *
 * `--dry-run` prints exactly `outdated` restricted to the named catalogs, and nothing about artifacts.
 * That is not a gap: the run has deliberately not moved the pins, so an install plan drawn here would
 * be a plan against the resolution the update is trying to leave behind. `src/project/update.ts` makes
 * the case at length.
 *
 * `--offline` is refused, for the reason `outdated` refuses it: the cache cannot know where a branch
 * points now, so the flag can only produce a confident wrong answer.
 */
import type { CommandContext, CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import { isUnchanged } from "../../project/bundle-diff.js";
import type { UpdateInstallOptions, UpdatePlan, UpdateResult } from "../../project/update.js";
import { hasOutdated, previewUpdate, updateProject } from "../../project/update.js";
import { diffJson, pinJson } from "./pins.js";
import { planText } from "./outdated.js";
import { skipJson, skipWarnings } from "./install.js";
import type { ArtifactMode } from "../../model/state.js";
import { artifactJson, artifactRows } from "./artifacts.js";
import { printSections, section } from "../output.js";

/**
 * `--copy` / `--link`, as the materialization mode they force — `install`'s flags, meaning what they
 * mean there.
 *
 * The two together never reach here: Commander refuses the invocation with exit 2 before any handler
 * runs (`src/cli/commands.ts`).
 */
function modeOverride(ctx: CommandContext): ArtifactMode | undefined {
  if (ctx.options.copy === true) return "copy";
  if (ctx.options.link === true) return "link";
  return undefined;
}

function installOptionsOf(ctx: CommandContext): UpdateInstallOptions {
  const mode = modeOverride(ctx);
  return { adopt: ctx.options.adopt === true, ...(mode !== undefined && { mode }) };
}

function previewJson(plan: UpdatePlan): Readonly<Record<string, unknown>> {
  return {
    catalogs: pinJson(plan.catalogs),
    changed: !isUnchanged(plan.diff),
    ...diffJson(plan.diff),
    outdated: hasOutdated(plan),
  };
}

function toJson(result: UpdateResult): Readonly<Record<string, unknown>> {
  return {
    artifacts: result.install.artifacts.map(artifactJson),
    catalogs: pinJson(result.catalogs),
    changed: !isUnchanged(result.diff),
    harnesses: result.install.harnesses,
    ...diffJson(result.diff),
    outdated: hasOutdated(result),
    skipped: result.install.skipped.map(skipJson),
  };
}

function toText(result: UpdateResult): readonly string[] {
  return [
    ...planText(result),
    ...section(
      "harnesses",
      result.install.harnesses.map((harness) => [harness]),
    ),
    ...section("artifacts", artifactRows(result.install.artifacts)),
  ];
}

export const updateHandler: CommandHandler = async (ctx) => {
  const projectDir = projectDirOf(ctx);
  // A variadic positional, so every argument is a catalog name; none means every catalog.
  const options = { catalogs: ctx.args };

  if (dryRunRequested(ctx)) {
    const plan = await previewUpdate(projectDir, options);
    if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(previewJson(plan), null, 2));
    else printSections(planText(plan), ctx.stdout);
    return ExitCode.Success;
  }

  const result = await updateProject(projectDir, options, installOptionsOf(ctx));

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result), ctx.stdout);
  for (const line of skipWarnings(result.install.skipped)) ctx.stderr(line);
  return ExitCode.Success;
};

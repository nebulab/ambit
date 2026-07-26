/**
 * `ambit clean` — remove everything ambit owns (spec §6).
 *
 * Two sections, because clean removes two different kinds of thing: the artifacts state records, and
 * the two places ambit keeps its own record of having run — `.ambit/` and the managed `.gitignore`
 * block. The second section names them individually rather than reporting a boolean, because "was
 * there a state file" is the question someone asks after a clean that found less than they expected.
 *
 * What is deliberately absent from both: `ambit.lock` and a `.mcp.json` left holding an empty
 * `mcpServers`. Neither is ambit's to delete (see `clean.ts`), so neither is ambit's to report having
 * deleted.
 */
import type { CleanResult } from "../../project/clean.js";
import { cleanProject } from "../../project/clean.js";
import type { CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import { GITIGNORE_FILENAME } from "../../project/gitignore.js";
import { printSections, section } from "../output.js";
import { STATE_DIRNAME, STATE_FILENAME } from "../../model/state.js";
import { artifactJson, removalRows } from "./artifacts.js";

/** How the state file and the managed block are named in the report. */
const STATE_PATH = `${STATE_DIRNAME}/${STATE_FILENAME}`;
const BLOCK_PATH = `${GITIGNORE_FILENAME} (managed block)`;

function toJson(result: CleanResult): Readonly<Record<string, unknown>> {
  return {
    gitignoreRemoved: result.gitignoreRemoved,
    removed: result.removed.map(artifactJson),
    stateRemoved: result.stateRemoved,
  };
}

/** Only what was actually there is listed, so the count is what the command found to do. */
function recordRows(result: CleanResult): readonly (readonly string[])[] {
  return [
    ...(result.stateRemoved ? [[STATE_PATH]] : []),
    ...(result.gitignoreRemoved ? [[BLOCK_PATH]] : []),
  ];
}

function toText(result: CleanResult): readonly string[] {
  return [
    ...section("removed", removalRows(result.removed)),
    ...section("records", recordRows(result)),
  ];
}

export const cleanHandler: CommandHandler = async (ctx) => {
  const result = await cleanProject(projectDirOf(ctx), { dryRun: dryRunRequested(ctx) });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result), ctx.stdout);
  return ExitCode.Success;
};

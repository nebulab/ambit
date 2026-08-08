/**
 * `ambit clean` — remove everything ambit owns.
 *
 * Two sections: the artifacts state records, and the places ambit keeps its own record of having run
 * (`.ambit/` and each managed `.gitignore` block). The second names them individually rather than
 * reporting a boolean, since "was there a state file" is a question someone asks after a clean that
 * found less than expected.
 *
 * Deliberately absent from both: `ambit.lock` and a `.mcp.json` left holding an empty `mcpServers`.
 * Neither is ambit's to delete (see `project/clean.ts`), so neither is reported as deleted.
 */
import type { CleanResult } from "../../project/clean.js";
import { cleanProject } from "../../project/clean.js";
import type { CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import { printSections, section } from "../output.js";
import { STATE_DIRNAME, STATE_FILENAME } from "../../model/state.js";
import { artifactJson, removalRows } from "./artifacts.js";

/** How the state file and a managed block are named in the report. */
const STATE_PATH = `${STATE_DIRNAME}/${STATE_FILENAME}`;
const blockPath = (file: string): string => `${file} (managed block)`;

function toJson(result: CleanResult): Readonly<Record<string, unknown>> {
  return {
    gitignoreRemoved: [...result.gitignoreRemoved],
    removed: result.removed.map(artifactJson),
    stateRemoved: result.stateRemoved,
  };
}

/** Only what was actually there is listed, so the count is what the command found to do. */
function recordRows(result: CleanResult): readonly (readonly string[])[] {
  return [
    ...(result.stateRemoved ? [[STATE_PATH]] : []),
    ...result.gitignoreRemoved.map((file) => [blockPath(file)]),
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

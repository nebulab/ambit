/**
 * `ambit status` — compare what is installed against what resolve produces (spec §6).
 *
 * One table rather than a report of problems: every artifact carries its own verdict, so a clean
 * project says so explicitly instead of printing nothing, and a reader scanning the state column
 * finds the one row that differs. That is also what makes the output a diff between two runs.
 *
 * `--check` prints the same table and returns exit 5 (spec §6), rather than raising an error. Drift
 * is a finding, not a failure of ambit's — the exit code is the machine-readable half of the report,
 * which is exactly what a command handler returning a code is for.
 */
import type { CommandHandler } from "../commands.js";
import { jsonRequested, offlineRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import { printSections, section } from "../output.js";
import type { ProjectStatus, StatusArtifact } from "../../project/status.js";
import { isClean, projectStatus } from "../../project/status.js";

function artifactJson(artifact: StatusArtifact): Readonly<Record<string, unknown>> {
  return {
    // Omitted rather than empty where there is nothing to say, so a consumer can test for it.
    ...(artifact.detail !== "" && { detail: artifact.detail }),
    kind: artifact.kind,
    path: artifact.path,
    state: artifact.state,
  };
}

function toJson(status: ProjectStatus): Readonly<Record<string, unknown>> {
  return {
    artifacts: status.artifacts.map(artifactJson),
    clean: isClean(status),
  };
}

/**
 * The detail cell is emitted empty rather than omitted, so the state column is padded identically
 * down the whole section — `columns` trims the trailing blank away again.
 */
function toText(status: ProjectStatus): readonly string[] {
  return [
    ...section(
      "artifacts",
      status.artifacts.map((artifact) => [artifact.path, artifact.kind, artifact.state, artifact.detail]),
    ),
  ];
}

export const statusHandler: CommandHandler = async (ctx) => {
  const status = await projectStatus(projectDirOf(ctx), { offline: offlineRequested(ctx) });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(status), null, 2));
  else printSections(toText(status), ctx.stdout);

  if (ctx.options.check !== true || isClean(status)) return ExitCode.Success;
  return ExitCode.Drift;
};

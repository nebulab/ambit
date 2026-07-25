/**
 * `ambit install` — resolve, write the lock, materialize, record ownership (spec §6).
 *
 * The flags that would imply the parts still missing report themselves unimplemented rather than
 * being accepted and ignored: `install --copy` silently succeeding would tell a reader that link
 * mode exists to be overridden.
 *
 * Output names artifacts by their project-relative path, so it is comparable between machines and
 * says exactly what a reader can go and look at. The lock is not among them: it is a record of the
 * resolution rather than an owned artifact, so nothing prunes it and it is not ambit's to delete.
 */
import type { AppliedArtifact } from "../adapter.js";
import type { CommandContext, CommandHandler } from "../commands.js";
import { jsonRequested, offlineRequested, projectDirOf } from "../commands.js";
import { AmbitError, ExitCode } from "../errors.js";
import type { InstallResult } from "../install.js";
import { installProject } from "../install.js";
import { printSections, section } from "../output.js";

/** Stands in for an artifact kind that carries no mode. */
const NO_MODE = "-";

/** Declared flags with no behaviour yet, and what each is waiting on. */
const UNIMPLEMENTED: readonly (readonly [key: string, flag: string, reason: string])[] = [
  ["dryRun", "--dry-run", "printing a plan instead of applying it is not wired up yet"],
  ["adopt", "--adopt", "it takes ownership of unowned artifacts, which this build never refuses"],
  ["copy", "--copy", "every skill is copied on this build, so there is nothing to override"],
  ["link", "--link", "symlinking local sources is not implemented yet"],
];

/**
 * @throws {AmbitError} exit 1 naming the flag, rather than proceeding as if it had been honoured.
 */
function rejectUnimplemented(ctx: CommandContext): void {
  for (const [key, flag, reason] of UNIMPLEMENTED) {
    if (ctx.options[key] === true) {
      throw new AmbitError(ExitCode.Internal, `\`${flag}\` is not implemented yet`, [
        reason,
        "run `ambit install` without it",
      ]);
    }
  }
}

function artifactJson(artifact: AppliedArtifact): Readonly<Record<string, unknown>> {
  return {
    kind: artifact.kind,
    ...(artifact.managedKeys !== undefined && { managedKeys: artifact.managedKeys }),
    ...(artifact.mode !== undefined && { mode: artifact.mode }),
    path: artifact.path,
  };
}

function toJson(result: InstallResult): Readonly<Record<string, unknown>> {
  return {
    artifacts: result.artifacts.map(artifactJson),
    harnesses: result.harnesses,
    skills: result.bundle.skills.map((skill) => skill.name),
  };
}

function toText(result: InstallResult): readonly string[] {
  return [
    ...section("harnesses", result.harnesses.map((harness) => [harness])),
    ...section(
      "artifacts",
      result.artifacts.map((artifact) => [artifact.path, artifact.kind, artifact.mode ?? NO_MODE]),
    ),
  ];
}

export const installHandler: CommandHandler = async (ctx) => {
  rejectUnimplemented(ctx);

  const result = await installProject(projectDirOf(ctx), {
    frozen: ctx.options.frozen === true,
    offline: offlineRequested(ctx),
  });

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(result), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(result), ctx.stdout);
  return ExitCode.Success;
};

/**
 * `ambit install` — resolve, write the lock, materialize, record ownership (spec §6).
 *
 * The flags that would imply the parts still missing report themselves unimplemented rather than
 * being accepted and ignored: `install --dry-run` silently installing would be worse than no flag
 * at all, since the whole point of asking is to not touch the project.
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
import type { ArtifactMode } from "../state.js";

/** Stands in for an artifact kind that carries no mode. */
const NO_MODE = "-";

/** Declared flags with no behaviour yet, and what each is waiting on. */
const UNIMPLEMENTED: readonly (readonly [key: string, flag: string, reason: string])[] = [
  ["dryRun", "--dry-run", "printing a plan instead of applying it is not wired up yet"],
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

/**
 * `--copy` / `--link`, as the materialization mode they force (spec §5).
 *
 * Undefined — neither flag — is the mode that follows each skill's source, which is not the same as
 * either flag's value: it is the absence of an override.
 *
 * @throws {AmbitError} exit 2 for both flags at once. Picking one would be picking for the caller,
 *   and the two say opposite things about every skill in the bundle.
 */
function modeOverride(ctx: CommandContext): ArtifactMode | undefined {
  const copy = ctx.options.copy === true;
  const link = ctx.options.link === true;
  if (copy && link) {
    throw new AmbitError(ExitCode.Config, "`--copy` and `--link` contradict each other", [
      "one copies every skill and the other symlinks every skill",
      "pass whichever one you meant, or neither to let each skill follow its source",
    ]);
  }
  if (copy) return "copy";
  if (link) return "link";
  return undefined;
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

  const mode = modeOverride(ctx);
  const result = await installProject(projectDirOf(ctx), {
    frozen: ctx.options.frozen === true,
    offline: offlineRequested(ctx),
    adopt: ctx.options.adopt === true,
    ...(mode !== undefined && { mode }),
  });

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(result), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(result), ctx.stdout);
  return ExitCode.Success;
};

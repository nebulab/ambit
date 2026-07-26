/**
 * `ambit install` — resolve, write the lock, materialize, record ownership.
 *
 * Output names artifacts by their project-relative path, so it is comparable between machines and
 * says exactly what a reader can go and look at. The lock is not among them: it is a record of the
 * resolution rather than an owned artifact, so nothing prunes it and it is not ambit's to delete.
 *
 * `--dry-run` prints the same two sections the install would print, plus the two things only a
 * preview can usefully say: what install would *remove* and whether the two derived
 * files — `ambit.lock` and each managed `.gitignore` block — would change. The artifact rows are
 * identical in shape to the real run's, so the two outputs diff against each other.
 */
import type { CommandContext, CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, offlineRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import type { InstallOptions, InstallPreview, InstallResult } from "../../project/install.js";
import { installProject, previewInstall } from "../../project/install.js";
import { LOCK_FILENAME } from "../../project/lock.js";
import { printSections, section } from "../output.js";
import type { ArtifactMode } from "../../model/state.js";
import { artifactJson, artifactRows, removalRows } from "./artifacts.js";

/**
 * `--copy` / `--link`, as the materialization mode they force.
 *
 * Undefined — neither flag — is the mode that follows each skill's source, which is not the same as
 * either flag's value: it is the absence of an override.
 *
 * The two together never reach here: they are declared as conflicting options (`src/cli/commands.ts`), so
 * Commander refuses the invocation with exit 2 before any handler runs.
 */
function modeOverride(ctx: CommandContext): ArtifactMode | undefined {
  if (ctx.options.copy === true) return "copy";
  if (ctx.options.link === true) return "link";
  return undefined;
}

/** Every flag `installProject` and `previewInstall` share, so the two paths cannot diverge. */
function optionsOf(ctx: CommandContext): InstallOptions {
  const mode = modeOverride(ctx);
  return {
    frozen: ctx.options.frozen === true,
    offline: offlineRequested(ctx),
    adopt: ctx.options.adopt === true,
    ...(mode !== undefined && { mode }),
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
    ...section(
      "harnesses",
      result.harnesses.map((harness) => [harness]),
    ),
    ...section("artifacts", artifactRows(result.artifacts)),
  ];
}

function previewJson(preview: InstallPreview): Readonly<Record<string, unknown>> {
  return {
    artifacts: preview.artifacts.map(artifactJson),
    gitignore: preview.gitignore.map((block) => ({ changed: block.changed, file: block.file })),
    harnesses: preview.harnesses,
    lockChanged: preview.lockChanged,
    pruned: preview.pruned.map(artifactJson),
    skills: preview.bundle.skills.map((skill) => skill.name),
  };
}

function previewText(preview: InstallPreview): readonly string[] {
  return [
    ...section(
      "harnesses",
      preview.harnesses.map((harness) => [harness]),
    ),
    ...section("artifacts", artifactRows(preview.artifacts)),
    ...section("pruned", removalRows(preview.pruned)),
    ...section("files", [
      [LOCK_FILENAME, preview.lockChanged ? "changed" : "unchanged"],
      ...preview.gitignore.map((block) => [block.file, block.changed ? "changed" : "unchanged"]),
    ]),
  ];
}

export const installHandler: CommandHandler = async (ctx) => {
  const options = optionsOf(ctx);
  const projectDir = projectDirOf(ctx);

  if (dryRunRequested(ctx)) {
    const preview = await previewInstall(projectDir, options);
    if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(previewJson(preview), null, 2));
    else printSections(previewText(preview), ctx.stdout);
    return ExitCode.Success;
  }

  const result = await installProject(projectDir, options);

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result), ctx.stdout);
  return ExitCode.Success;
};

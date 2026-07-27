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
 *
 * A hook a configured harness cannot express is a warning on stderr and exit 0. Stderr, because stdout
 * is the report a script parses and a skip is not part of what was installed; a warning rather than an
 * error, because the hook did install everywhere else — failing would let one harness listed in
 * `harnesses` veto every other harness's hooks.
 */
import type { CommandContext, CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, offlineRequested, projectDirOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import type { SkippedHook } from "../../harness/adapter.js";
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

/**
 * Why one harness could not take one hook, in a sentence.
 *
 * The two reasons read differently on purpose: one is a permanent fact about the harness, the other is
 * this build's event vocabulary having outgrown that harness's map — so a reader can tell "opencode will
 * never run this" from "ambit does not know how to say this to Codex yet".
 */
function skipReason(skipped: SkippedHook): string {
  return skipped.reason === "no-mechanism"
    ? `${skipped.harness} has no declarative hook mechanism`
    : `${skipped.harness} has no spelling for the ${skipped.event} event`;
}

/** One line per skipped hook, named the way its declaration names it. */
function skipWarnings(skipped: readonly SkippedHook[]): readonly string[] {
  return skipped.map(
    (skip) => `warning: hook "${skip.hook}" (${skip.event}) not installed: ${skipReason(skip)}`,
  );
}

/**
 * One skipped hook as a JSON record, with the keys in a fixed order.
 *
 * The reason kind rather than the sentence: a `--json` consumer wants the fact, and the wording is the
 * text renderer's business.
 */
function skipJson(skipped: SkippedHook): Readonly<Record<string, unknown>> {
  return {
    event: skipped.event,
    harness: skipped.harness,
    hook: skipped.hook,
    reason: skipped.reason,
  };
}

function toJson(result: InstallResult): Readonly<Record<string, unknown>> {
  return {
    artifacts: result.artifacts.map(artifactJson),
    harnesses: result.harnesses,
    skills: result.bundle.skills.map((skill) => skill.name),
    skipped: result.skipped.map(skipJson),
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
    skipped: preview.skipped.map(skipJson),
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
    // A preview says what the run would skip, for the same reason it says what the run would remove.
    for (const line of skipWarnings(preview.skipped)) ctx.stderr(line);
    return ExitCode.Success;
  }

  const result = await installProject(projectDir, options);

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result), ctx.stdout);
  for (const line of skipWarnings(result.skipped)) ctx.stderr(line);
  return ExitCode.Success;
};

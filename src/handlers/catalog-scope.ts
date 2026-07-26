/**
 * `ambit catalog scope add|rm|mv` (spec §6, "Catalog authoring") — the three registry commands.
 *
 * One module, because the three print the same two sections and differ only in what the first one says:
 * what the registry now holds, then which files that took. Under `--dry-run` the second section is the
 * diff authoring rule 6 promises, rendered by the one renderer every authoring preview uses.
 *
 * The heading follows `--dry-run` rather than `written`, unlike `catalog init`'s: here a run that changed
 * nothing is not a preview but a no-op — `mv <name> <name>` reports the scope as renamed and no files
 * changed, which is the honest answer and would read as a lie under "would rename".
 *
 * `add`'s `--description` is required *here* rather than by Commander's `.makeOptionMandatory()`.
 * Commander's refusal now travels out as an exit code like any other (A30), so the reason is no longer
 * the defect but the message: spec §6 asks an error to name the offending file and give one concrete
 * next step, and `error: required option '--description <text>' not specified` does neither.
 */
import { SCOPES_FILENAME } from "../catalog.js";
import type { ScopeEdit } from "../catalog-scope.js";
import { addScope, removeScope, renameScope } from "../catalog-scope.js";
import type { CommandContext, CommandHandler } from "../commands.js";
import { catalogDirOf, dryRunRequested, jsonRequested, positional } from "../commands.js";
import { diffSection } from "../diff.js";
import { ExitCode, at, configError } from "../errors.js";
import { printSections, section } from "../output.js";

/** The first section's title: past tense for a run that happened, conditional for a preview. */
interface Heading {
  readonly done: string;
  readonly would: string;
}

const REGISTERED: Heading = { done: "registered", would: "would register" };
const UNREGISTERED: Heading = { done: "unregistered", would: "would unregister" };
const RENAMED: Heading = { done: "renamed", would: "would rename" };

/**
 * What a rename leaves for its author to do. A catalog command edits no `ambit.yml` — there is none to
 * edit — so every project holding a renamed scope now names something this catalog no longer registers,
 * and `ambit resolve` there will say so (exit 3).
 */
const RENAME_NEXT_STEP =
  "next: update `ambit.yml` in every project that holds a renamed scope — a catalog cannot do it for them";

/** What separates the two halves of a rename row. The same arrow a requirement cycle prints. */
const ARROW = "→";

/**
 * `--description`, which `add` requires.
 *
 * A registry entry without one does not parse at all, and the description is what a consuming tool
 * renders in its picker (spec §3.4) — so a blank one is refused for the same reason a missing one is,
 * rather than being written and rejected on the next read.
 *
 * @throws {AmbitError} exit 2, naming the scope and the flag to add.
 */
function requiredDescription(ctx: CommandContext, scope: string): string {
  const given = ctx.options.description;
  if (typeof given === "string" && given.trim() !== "") return given;

  throw configError(`scope "${scope}" needs a description ${at(SCOPES_FILENAME, undefined)}`, [
    "a registered scope's description is what a tool asking someone which scopes they hold renders",
    'add `--description "<what the scope means>"`',
  ]);
}

function fileRows(result: ScopeEdit): readonly (readonly string[])[] {
  return result.changes.map((change) => [change.file]);
}

/** What one command tells the reader, on top of the files it touched. */
interface Subject {
  readonly heading: Heading;
  /** The rows of the first section: what the registry now holds. */
  readonly rows: readonly (readonly string[])[];
  /** The `--json` keys for the same thing, which are the command's own. */
  readonly json: Readonly<Record<string, unknown>>;
  /** A closing line, printed only for a run that wrote something. */
  readonly next?: string;
}

/** Keys in one order, sorted, so the emitted JSON is byte-stable (`keyed` in `src/output.ts`). */
function toJson(subject: Subject, result: ScopeEdit): Readonly<Record<string, unknown>> {
  return {
    files: result.changes.map((change) => ({ file: change.file, text: change.text })),
    ...subject.json,
    written: result.written,
  };
}

function toText(subject: Subject, result: ScopeEdit, dryRun: boolean): readonly string[] {
  return [
    ...section(dryRun ? subject.heading.would : subject.heading.done, subject.rows),
    ...(dryRun ? diffSection("diff", result.changes) : section("files", fileRows(result))),
    ...(subject.next !== undefined && result.written ? [subject.next, ""] : []),
  ];
}

/** The one output path all three commands take. */
function report(ctx: CommandContext, subject: Subject, result: ScopeEdit): ExitCode {
  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(subject, result), null, 2));
  else printSections(toText(subject, result, dryRunRequested(ctx)), ctx.stdout);

  return ExitCode.Success;
}

export const catalogScopeAddHandler: CommandHandler = async (ctx) => {
  const scope = positional(ctx, 0, "ambit catalog scope add <name> --description <text>");
  const description = requiredDescription(ctx, scope);

  const result = await addScope(catalogDirOf(ctx), scope, description, {
    dryRun: dryRunRequested(ctx),
  });

  return report(
    ctx,
    {
      heading: REGISTERED,
      rows: [[result.registered.name, result.registered.description]],
      json: { registered: { description: result.registered.description, name: result.registered.name } },
    },
    result,
  );
};

export const catalogScopeRemoveHandler: CommandHandler = async (ctx) => {
  const scope = positional(ctx, 0, "ambit catalog scope rm <name>");

  const result = await removeScope(catalogDirOf(ctx), scope, { dryRun: dryRunRequested(ctx) });

  return report(
    ctx,
    { heading: UNREGISTERED, rows: [[result.unregistered]], json: { unregistered: result.unregistered } },
    result,
  );
};

export const catalogScopeRenameHandler: CommandHandler = async (ctx) => {
  const usage = "ambit catalog scope mv <old> <new>";
  const from = positional(ctx, 0, usage);
  const to = positional(ctx, 1, usage);

  const result = await renameScope(catalogDirOf(ctx), from, to, { dryRun: dryRunRequested(ctx) });

  return report(
    ctx,
    {
      heading: RENAMED,
      rows: result.renamed.map((rename) => [rename.from, ARROW, rename.to]),
      json: { renamed: result.renamed.map((rename) => ({ from: rename.from, to: rename.to })) },
      next: RENAME_NEXT_STEP,
    },
    result,
  );
};

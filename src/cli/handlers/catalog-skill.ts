/**
 * `ambit catalog skill new|rm|mv` (spec §6, "Catalog authoring") — the three skill commands.
 *
 * One module, for the reason `catalog-scope`'s handler is one: the three print the same two sections and
 * differ only in what the first one says. What differs from the registry commands is the second section,
 * because a skill lives in a directory — so each row says what happened to its path, and a directory
 * carries a trailing `/`. A destructive command that printed a bare path list would not say whether the
 * `references/` folder beside a `SKILL.md` went with it.
 *
 * The heading follows `--dry-run` rather than `written`, as it does for the registry commands: a run that
 * changed nothing is a no-op, not a preview.
 *
 * Two of the three close with a line about other people's projects. A catalog command edits no
 * `ambit.yml` — there is none to edit — and a project may name a skill explicitly in its own `skills`
 * list, so renaming or deleting one leaves that project naming something this catalog no longer
 * provides.
 */
import type { SkillEdit } from "../../authoring/skill.js";
import { newSkill, removeSkill, renameSkill } from "../../authoring/skill.js";
import type { CommandContext, CommandHandler } from "../commands.js";
import {
  catalogDirOf,
  dryRunRequested,
  jsonRequested,
  optionList,
  positional,
} from "../commands.js";
import { changeKindOf, diffSection, treeChangeSummary } from "../diff.js";
import { skillDocumentPath } from "../../authoring/editor.js";
import { ExitCode } from "../../errors.js";
import { printSections, section } from "../output.js";

/** The first section's title: past tense for a run that happened, conditional for a preview. */
interface Heading {
  readonly done: string;
  readonly would: string;
}

const CREATED: Heading = { done: "created", would: "would create" };
const REMOVED: Heading = { done: "removed", would: "would remove" };
const RENAMED: Heading = { done: "renamed", would: "would rename" };

/** What separates the two halves of a rename row. The same arrow a requirement cycle prints. */
const ARROW = "→";

const REMOVE_NEXT_STEP =
  "next: drop the skill from `ambit.yml` in every project that lists it explicitly — a catalog cannot do it for them";

const RENAME_NEXT_STEP =
  "next: update `ambit.yml` in every project that lists the old name — a catalog cannot do it for them";

/** What a command tells the reader, on top of the paths it touched. */
interface Subject {
  readonly heading: Heading;
  /** The rows of the first section: the skill this command was about. */
  readonly rows: readonly (readonly string[])[];
  /** The `--json` keys for the same thing, which are the command's own. */
  readonly json: Readonly<Record<string, unknown>>;
  /** A closing line, printed only for a run that wrote something. */
  readonly next: string;
}

/**
 * Every path the edit touched: the directories first, then the files, each with what happened to it.
 *
 * The two are one section rather than two because they answer one question — what is different on disk —
 * and because a `skill rm` whose only row is a directory would otherwise print an empty `files (0)`
 * beside it.
 */
function pathRows(result: SkillEdit): readonly (readonly string[])[] {
  return [
    ...result.trees.map((tree) => [`${tree.directory}/`, treeChangeSummary(tree)]),
    ...result.changes.map((change) => [change.file, changeKindOf(change)]),
  ];
}

/** Keys in one order, so the emitted JSON is byte-stable (`keyed` in `src/cli/output.ts`). */
function toJson(subject: Subject, result: SkillEdit): Readonly<Record<string, unknown>> {
  return {
    ...subject.json,
    files: result.changes.map((change) => ({ file: change.file, text: change.text })),
    trees: result.trees.map((tree) => ({ directory: tree.directory, to: tree.to })),
    written: result.written,
  };
}

function toText(subject: Subject, result: SkillEdit, dryRun: boolean): readonly string[] {
  return [
    ...section(dryRun ? subject.heading.would : subject.heading.done, subject.rows),
    ...(dryRun
      ? diffSection("diff", result.changes, result.trees)
      : section("files", pathRows(result))),
    ...(result.written ? [subject.next, ""] : []),
  ];
}

/** The one output path all three commands take. */
function report(ctx: CommandContext, subject: Subject, result: SkillEdit): ExitCode {
  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(subject, result), null, 2));
  else printSections(toText(subject, result, dryRunRequested(ctx)), ctx.stdout);

  return ExitCode.Success;
}

/** `--description`, which a skill may go without: the key is left out rather than written empty. */
function description(ctx: CommandContext): string | undefined {
  const given = ctx.options.description;
  return typeof given === "string" && given.trim() !== "" ? given : undefined;
}

export const catalogSkillNewHandler: CommandHandler = async (ctx) => {
  const name = positional(ctx, 0, "ambit catalog skill new <name>");
  const given = description(ctx);
  const scopes = optionList(ctx, "scope");
  const requires = optionList(ctx, "requires");
  const env = optionList(ctx, "env");

  const result = await newSkill(catalogDirOf(ctx), name, {
    dryRun: dryRunRequested(ctx),
    ...(given !== undefined && { description: given }),
    ...(scopes !== undefined && { scopes }),
    ...(requires !== undefined && { requires }),
    ...(env !== undefined && { env }),
  });

  return report(
    ctx,
    {
      heading: CREATED,
      rows: [
        [
          result.created.name,
          ...(result.created.description === undefined ? [] : [result.created.description]),
        ],
      ],
      json: {
        created: {
          ...(result.created.description !== undefined && { description: result.created.description }),
          name: result.created.name,
        },
      },
      next: `next: write the skill's instructions in ${skillDocumentPath(name)}`,
    },
    result,
  );
};

export const catalogSkillRemoveHandler: CommandHandler = async (ctx) => {
  const name = positional(ctx, 0, "ambit catalog skill rm <name>");

  const result = await removeSkill(catalogDirOf(ctx), name, { dryRun: dryRunRequested(ctx) });

  return report(
    ctx,
    {
      heading: REMOVED,
      rows: [[result.removed]],
      json: { removed: result.removed },
      next: REMOVE_NEXT_STEP,
    },
    result,
  );
};

export const catalogSkillRenameHandler: CommandHandler = async (ctx) => {
  const usage = "ambit catalog skill mv <old> <new>";
  const from = positional(ctx, 0, usage);
  const to = positional(ctx, 1, usage);

  const result = await renameSkill(catalogDirOf(ctx), from, to, { dryRun: dryRunRequested(ctx) });

  return report(
    ctx,
    {
      heading: RENAMED,
      rows: [[result.renamed.from, ARROW, result.renamed.to]],
      json: { renamed: { from: result.renamed.from, to: result.renamed.to } },
      next: RENAME_NEXT_STEP,
    },
    result,
  );
};

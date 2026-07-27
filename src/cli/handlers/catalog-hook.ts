/**
 * `ambit catalog hook new|rm` — the two hook commands.
 *
 * One module, printing the two sections every authoring command prints: what the catalog now provides,
 * then which paths that took — or, under `--dry-run`, the diff it withheld. The heading follows
 * `--dry-run` rather than `written`, as it does for every other authoring command. A hook lives in a
 * *directory*, so the second section is the skill commands' rather than the MCP commands': a row per
 * tree and a row per file, since `rm` removing a hook that shipped a script has to say the script went
 * with it.
 *
 * What is particular to this handler is argv's two vocabularies, and all of it lives here. `--event` is
 * a string, so turning it into the one {@link HookEvent} the model admits is the boundary's job; and
 * `--command`/`--script` are how argv spells the hook's `type`, so choosing between them is too. Both
 * are the split `catalog mcp new` makes over `--stdio`/`--http`, and for the same reason: below this
 * line a hook is a type that cannot name an event no harness supports, and cannot be undecided about
 * what its `command` is. Every way that can fail is refused by {@link catalogHookNewRule}, declared
 * with the command and run by Commander before dispatch, so the message names the file, names the
 * offending value, and gives one next step — which `.makeOptionMandatory()` and `.conflicts()` do not.
 *
 * Two refusals are deliberately *not* here, because the parser already owns them and a second copy
 * could drift: a `matcher` on an event that carries no tool, and a `type: script` hook naming a file
 * its directory does not hold. Both are raised when the editor validates the result, which is before
 * anything is written.
 *
 * `rm` closes with nothing, deliberately: no project's `ambit.yml` can name a catalog's hook — its
 * `hooks` key declares one inline rather than selecting one — so there is nothing for its author to
 * update.
 */
import type { HookDeclaration, HookEdit, HookSummary } from "../../authoring/hook.js";
import { newHook, removeHook } from "../../authoring/hook.js";
import { HOOKS_DIRNAME } from "../../model/catalog.js";
import type { CommandContext, CommandHandler, CommandRule } from "../commands.js";
import {
  catalogDirOf,
  dryRunRequested,
  jsonRequested,
  optionList,
  positional,
} from "../commands.js";
import { changeKindOf, diffSection, treeChangeSummary } from "../diff.js";
import { hookDocumentPath } from "../../authoring/editor.js";
import type { AmbitError } from "../../errors.js";
import { ExitCode, at, configError } from "../../errors.js";
import type { HookEvent } from "../../model/hook-entity.js";
import { HOOK_EVENTS } from "../../model/hook-entity.js";
import { printSections, section } from "../output.js";
import { requirementFor } from "../../resolution/resolve.js";

/** The first section's title: past tense for a run that happened, conditional for a preview. */
interface Heading {
  readonly done: string;
  readonly would: string;
}

const CREATED: Heading = { done: "created", would: "would create" };
const REMOVED: Heading = { done: "removed", would: "would remove" };

/** How every event refusal names what ambit understands. */
const SUPPORTED = `supported events: ${HOOK_EVENTS.join(", ")}`;

/** How `new` is invoked, for the messages that have to say so. */
const NEW_USAGE =
  "ambit catalog hook new <name> --event <event> (--command <command> | --script <path>)";

/** What a command tells the reader, on top of the paths it touched. */
interface Subject {
  readonly heading: Heading;
  /** The rows of the first section: the hook this command was about. */
  readonly rows: readonly (readonly string[])[];
  /** The `--json` keys for the same thing, which are the command's own. */
  readonly json: Readonly<Record<string, unknown>>;
  /** A closing line, printed only for a run that wrote something. */
  readonly next?: string;
}

/**
 * The error for an invocation that names no event.
 *
 * Exit 2 — a malformed invocation, not a resolution problem — and it lists the supported set, because
 * `event` decides when the hook runs at all and a hook nothing fires is not worth writing.
 */
function noEvent(name: string): AmbitError {
  return configError(`hook "${name}" names no event ${at(hookDocumentPath(name), undefined)}`, [
    SUPPORTED,
    "give `--event <event>`, one of them",
  ]);
}

/**
 * The error for an event no harness maps.
 *
 * The parser's own wording, deliberately: the same value written into a `HOOK.yml` by hand is refused
 * in these words, and one vocabulary for one rule is what keeps the two from disagreeing.
 */
function unknownEvent(name: string, given: string): AmbitError {
  return configError(`unknown hook event "${given}" ${at(hookDocumentPath(name), undefined)}`, [
    SUPPORTED,
    `replace \`${given}\` with one of them`,
  ]);
}

/** The error for an invocation that says nothing about what to run. */
function noCommand(name: string): AmbitError {
  return configError(`hook "${name}" names no command ${at(hookDocumentPath(name), undefined)}`, [
    "a hook has to say what to run, or there is nothing for the harness to execute",
    "give `--command <command>` for a command line, or `--script <path>` for a script the hook ships",
  ]);
}

/**
 * The error for an invocation that gives both flags.
 *
 * They are the two `type` values, and a hook has one: `--command` is run as written, `--script` names
 * a file the hook's directory ships and is rewritten to where it was installed. Refusing is the point
 * of the pair — picking one silently would put the guessing back that declaring the type removed.
 */
function bothCommandAndScript(name: string): AmbitError {
  return configError(
    `hook "${name}" is both a command and a script ${at(hookDocumentPath(name), undefined)}`,
    [
      "`--command` runs a command line as written; `--script` runs a file the hook's own directory ships",
      "give exactly one of them",
    ],
  );
}

/** The error for a `--timeout` argv entry that is not a whole number of seconds. */
function badTimeout(given: string): AmbitError {
  return configError(`cannot read \`--timeout ${given}\` ${at(HOOKS_DIRNAME, undefined)}`, [
    "a timeout is a whole number of seconds, and cannot be negative",
    "write it as `--timeout <seconds>`",
  ]);
}

/**
 * A flag's value, treating a blank one as absent.
 *
 * A `--matcher ""` or a `--description "  "` would be written, parsed back, and mean nothing, so it is
 * left out of the document instead — the shape every other authoring command gives an empty flag.
 */
function flag(ctx: CommandContext, name: string): string | undefined {
  const given = ctx.options[name];
  if (typeof given !== "string" || given.trim() === "") return undefined;
  return given;
}

/**
 * The one event this invocation declares.
 *
 * @throws {AmbitError} exit 2 when no event is named, or the one named is not in {@link HOOK_EVENTS}.
 */
function eventOf(ctx: CommandContext, name: string): HookEvent {
  const given = flag(ctx, "event");
  if (given === undefined) throw noEvent(name);
  if (!(HOOK_EVENTS as readonly string[]).includes(given)) throw unknownEvent(name, given);
  return given as HookEvent;
}

/**
 * `--timeout` as the document's integer, or absent.
 *
 * @throws {AmbitError} exit 2 for a value that is not a non-negative whole number.
 */
function timeoutOf(ctx: CommandContext): number | undefined {
  const given = flag(ctx, "timeout");
  if (given === undefined) return undefined;

  const seconds = Number(given);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw badTimeout(given);
  return seconds;
}

/**
 * The `type` and `command` this invocation declares, from the flag it chose.
 *
 * The same split `catalog mcp new` makes over `--stdio`/`--http`: two flags naming the two shapes, so
 * argv says which one it means and nothing below this line has to work it out from the string.
 *
 * @throws {AmbitError} exit 2 when neither flag is given, or both are.
 */
function runOf(ctx: CommandContext, name: string): Pick<HookDeclaration, "type" | "command"> {
  const command = flag(ctx, "command");
  const script = flag(ctx, "script");

  if (command !== undefined && script !== undefined) throw bothCommandAndScript(name);
  if (command !== undefined) return { type: "command", command };
  if (script !== undefined) return { type: "script", command: script };
  throw noCommand(name);
}

/**
 * What this invocation declares, read off argv.
 *
 * @throws {AmbitError} exit 2 for a missing or unknown event, a missing or doubled command, or a
 *   timeout that is not a whole number of seconds.
 */
function declarationOf(ctx: CommandContext, name: string): HookDeclaration {
  const event = eventOf(ctx, name);
  const { type, command } = runOf(ctx, name);

  const description = flag(ctx, "description");
  const matcher = flag(ctx, "matcher");
  const timeout = timeoutOf(ctx);
  const env = optionList(ctx, "env");

  return {
    event,
    type,
    command,
    ...(description !== undefined && { description }),
    ...(matcher !== undefined && { matcher }),
    ...(timeout !== undefined && { timeout }),
    ...(env !== undefined && { env }),
  };
}

/**
 * `new`'s flag rule: an event ambit knows, and something to run.
 *
 * The same pure read of argv the handler makes, run once more and for its refusals alone. Reading it
 * twice is what keeps the rule declarable with the command *and* the declaration built where it is
 * used — cheaper, and far plainer, than carrying a hook's result into an action.
 *
 * @throws {AmbitError} exit 2 for a missing or unknown event, a missing command, or a timeout that is
 *   not a whole number of seconds.
 */
export const catalogHookNewRule: CommandRule = (ctx) => {
  declarationOf(ctx, positional(ctx, 0, NEW_USAGE));
};

/** Keys in one order, so the emitted JSON is byte-stable (`keyed` in `src/cli/output.ts`). */
function toJson(subject: Subject, result: HookEdit): Readonly<Record<string, unknown>> {
  return {
    ...subject.json,
    files: result.changes.map((change) => ({ file: change.file, text: change.text })),
    trees: result.trees.map((tree) => ({ directory: tree.directory, to: tree.to })),
    written: result.written,
  };
}

/**
 * Every path the edit touched: the directories first, then the files, each with what happened to it.
 *
 * One section rather than two, as it is for a skill: they answer one question — what is different on
 * disk — and a `hook rm` whose only row is a directory would otherwise print an empty `files (0)`
 * beside it.
 */
function pathRows(result: HookEdit): readonly (readonly string[])[] {
  return [
    ...result.trees.map((tree) => [`${tree.directory}/`, treeChangeSummary(tree)]),
    ...result.changes.map((change) => [change.file, changeKindOf(change)]),
  ];
}

function toText(subject: Subject, result: HookEdit, dryRun: boolean): readonly string[] {
  return [
    ...section(dryRun ? subject.heading.would : subject.heading.done, subject.rows),
    ...(dryRun
      ? diffSection("diff", result.changes, result.trees)
      : section("files", pathRows(result))),
    ...(subject.next !== undefined && result.written ? [subject.next, ""] : []),
  ];
}

/** The one output path both commands take. */
function report(ctx: CommandContext, subject: Subject, result: HookEdit): ExitCode {
  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(subject, result), null, 2));
  else printSections(toText(subject, result, dryRunRequested(ctx)), ctx.stdout);

  return ExitCode.Success;
}

/**
 * What a new hook leaves for its author to do.
 *
 * `hook new` is given no way to declare a scope, so what it writes is selected by nothing yet — and a
 * hook nothing reaches is a hook no harness is ever configured to run.
 *
 * Both halves name `catalog annotate`: it is what gives a hook a scope and what gives a skill the
 * requirement, so neither half sends the reader to a file to hand-edit.
 */
function newNextStep(created: HookSummary): string {
  const target = requirementFor({ kind: "hook", name: created.name });
  return `next: nothing selects it yet — run \`ambit catalog annotate ${target} --add-scope <scope>\`, or \`ambit catalog annotate <skill> --add-requires ${target}\``;
}

export const catalogHookNewHandler: CommandHandler = async (ctx) => {
  const name = positional(ctx, 0, NEW_USAGE);
  const declaration = declarationOf(ctx, name);

  const result = await newHook(catalogDirOf(ctx), name, {
    ...declaration,
    dryRun: dryRunRequested(ctx),
  });

  return report(
    ctx,
    {
      heading: CREATED,
      rows: [
        [result.created.name, result.created.event, result.created.type, result.created.command],
      ],
      json: {
        created: {
          command: result.created.command,
          event: result.created.event,
          name: result.created.name,
          type: result.created.type,
        },
      },
      next: newNextStep(result.created),
    },
    result,
  );
};

export const catalogHookRemoveHandler: CommandHandler = async (ctx) => {
  const name = positional(ctx, 0, "ambit catalog hook rm <name>");

  const result = await removeHook(catalogDirOf(ctx), name, { dryRun: dryRunRequested(ctx) });

  return report(
    ctx,
    { heading: REMOVED, rows: [[result.removed]], json: { removed: result.removed } },
    result,
  );
};

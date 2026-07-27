/**
 * `ambit catalog annotate <name>` — changing what an item declares.
 *
 * The report is the one other authoring commands print with the first section turned around: instead of
 * naming what the command did to the catalog, it lists what the item declares *now*, key by key, because
 * that is the question someone editing an annotation is actually asking. The subject is named once on its
 * own line, the way `ambit why` names the item it is explaining.
 *
 * Two refusals live here rather than in `authoring/annotate.ts`, because both are about argv rather than
 * about the catalog: an invocation that asks for no change at all, and one that adds and removes the same
 * entry. Neither is a shape Commander's own primitives can state — both are about which *values* two
 * repeatable flags collected, not about which flags appeared — so {@link catalogAnnotateRule} states
 * them, declared with the command and run by Commander before dispatch.
 *
 * Both of them name a *directory* rather than a file, deliberately: neither has read the catalog yet, so
 * neither can know which §3.3 extension an entity carries, and a message that guessed `.yml` would send
 * the reader to a file that is not there. They can name a directory at all only because the subject is a
 * `<kind>:<name>` reference — a bare name would leave all three in play.
 */
import type { AnnotateResult, AnnotatedItem, AnnotationEdit } from "../../authoring/annotate.js";
import {
  annotate,
  annotationDirname,
  annotationSubject,
  assertRequirementRefs,
} from "../../authoring/annotate.js";
import type { AnnotationKey } from "../../model/catalog.js";
import type { CommandContext, CommandHandler, CommandRule } from "../commands.js";
import {
  catalogDirOf,
  dryRunRequested,
  jsonRequested,
  optionList,
  positional,
} from "../commands.js";
import { changeKindOf, diffSection } from "../diff.js";
import type { AmbitError } from "../../errors.js";
import { ExitCode, at, configError } from "../../errors.js";
import { keyed, printSections, section } from "../output.js";

/** What the first section is titled: the item's state, hedged under `--dry-run`. */
const DECLARES = "declares";
const WOULD_DECLARE = "would declare";

/** How an empty annotation reads in the text report, as an artifact's absent mode does. */
const NONE = "-";

/** How the command is invoked, for the messages that have to say so. */
const USAGE = "ambit catalog annotate <kind:name> --add-scope <scope>";

/** One annotation, and the two flags that change it. */
interface AnnotationFlags {
  readonly key: AnnotationKey;
  /** The flag as it is typed, and the name Commander gives its value. */
  readonly add: readonly [flag: string, option: string];
  readonly remove: readonly [flag: string, option: string];
}

/**
 * The six flags this command takes, paired with the annotation each changes.
 *
 * Both halves of each name are written out rather than derived from the key, so a reader can grep either
 * the flag or the key and land here.
 */
const ANNOTATION_FLAGS: readonly AnnotationFlags[] = [
  { key: "scopes", add: ["--add-scope", "addScope"], remove: ["--remove-scope", "removeScope"] },
  {
    key: "requires",
    add: ["--add-requires", "addRequires"],
    remove: ["--remove-requires", "removeRequires"],
  },
  { key: "env", add: ["--add-env", "addEnv"], remove: ["--remove-env", "removeEnv"] },
];

/** Every flag as it is typed, for the refusal that has to list them. */
function everyFlag(): string {
  return ANNOTATION_FLAGS.flatMap((flags) => [flags.add[0], flags.remove[0]]).join(", ");
}

/**
 * The error for an invocation that asks for nothing.
 *
 * Refused rather than treated as a request to print the current annotations: this is a mutating command,
 * and a run that reports success having been given no change to make is indistinguishable from one whose
 * flags were swallowed by a shell.
 */
function nothingAsked(name: string): AmbitError {
  return configError(
    `\`annotate ${name}\` names no change ${at(annotationDirname(name), undefined)}`,
    [
      "the command adds and removes entries, so it needs at least one of them",
      `give one of: ${everyFlag()}`,
    ],
  );
}

/**
 * The error for adding and removing the same entry in one run.
 *
 * One of the two flags was typed by mistake and ambit cannot tell which, so refusing is the only answer
 * that does not silently discard something the reader asked for.
 */
function contradiction(flags: AnnotationFlags, value: string, name: string): AmbitError {
  return configError(
    `\`${flags.add[0]} ${value}\` and \`${flags.remove[0]} ${value}\` contradict each other ${at(annotationDirname(name), undefined)}`,
    [
      `"${value}" cannot be both added to and removed from "${name}" in one run`,
      `drop one of the two flags`,
    ],
  );
}

/**
 * What each annotation is asked to gain and lose, read off argv.
 *
 * A key neither flag mentions is left out entirely, which is what tells the mutation to leave that list
 * alone rather than rewrite it in sorted order.
 *
 * @throws {AmbitError} exit 2 when no flag was given, or one entry is both added and removed.
 */
function editsOf(
  ctx: CommandContext,
  name: string,
): Readonly<Partial<Record<AnnotationKey, AnnotationEdit>>> {
  const edits: { -readonly [K in AnnotationKey]?: AnnotationEdit } = {};

  for (const flags of ANNOTATION_FLAGS) {
    const add = optionList(ctx, flags.add[1]);
    const remove = optionList(ctx, flags.remove[1]);
    if (add === undefined && remove === undefined) continue;

    const removed = new Set(remove ?? []);
    for (const value of add ?? []) {
      if (removed.has(value)) throw contradiction(flags, value, name);
    }

    edits[flags.key] = {
      ...(add !== undefined && { add }),
      ...(remove !== undefined && { remove }),
    };
  }

  // Before the catalog is opened, since a `requires` entry that names no namespace is a malformed
  // invocation rather than something the catalog could settle.
  assertRequirementRefs(edits.requires);

  if (Object.keys(edits).length === 0) throw nothingAsked(name);
  return edits;
}

/**
 * The command's flag rule: at least one flag, and no entry both added and removed in one run.
 *
 * The same pure read of argv the handler makes, run once more and for its refusals alone. Reading it
 * twice is what keeps the rule declarable with the command *and* the edits built where they are used —
 * cheaper, and far plainer, than carrying a hook's result into an action.
 *
 * @throws {AmbitError} exit 2 when no flag was given, or one entry is both added and removed.
 */
export const catalogAnnotateRule: CommandRule = (ctx) => {
  const name = positional(ctx, 0, USAGE);
  // The subject first: every other refusal here names the directory the annotation would land in,
  // which is a question only the subject's namespace can answer.
  annotationSubject(name);
  editsOf(ctx, name);
};

/** One row per annotation the subject may declare, in the order §3.2 tabulates them. */
function declareRows(annotated: AnnotatedItem): readonly (readonly string[])[] {
  return annotated.declares.map((list) => [
    list.key,
    list.values.length === 0 ? NONE : list.values.join(", "),
  ]);
}

/** Every file the edit touched, with what happened to it. An annotation is one file; no tree moves. */
function fileRows(result: AnnotateResult): readonly (readonly string[])[] {
  return result.changes.map((change) => [change.file, changeKindOf(change)]);
}

/** Keys in one order, so the emitted JSON is byte-stable (`keyed` in `src/cli/output.ts`). */
function toJson(result: AnnotateResult): Readonly<Record<string, unknown>> {
  return {
    annotated: {
      declares: keyed(
        result.annotated.declares,
        (list) => list.key,
        (list) => list.values,
      ),
      file: result.annotated.file,
      kind: result.annotated.kind,
      name: result.annotated.name,
    },
    files: result.changes.map((change) => ({ file: change.file, text: change.text })),
    written: result.written,
  };
}

function toText(result: AnnotateResult, dryRun: boolean): readonly string[] {
  return [
    `${result.annotated.kind} ${result.annotated.name}`,
    "",
    ...section(dryRun ? WOULD_DECLARE : DECLARES, declareRows(result.annotated)),
    ...(dryRun ? diffSection("diff", result.changes) : section("files", fileRows(result))),
  ];
}

export const catalogAnnotateHandler: CommandHandler = async (ctx) => {
  const name = positional(ctx, 0, USAGE);
  const edits = editsOf(ctx, name);

  const result = await annotate(catalogDirOf(ctx), name, {
    edits,
    dryRun: dryRunRequested(ctx),
  });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(result), null, 2));
  else printSections(toText(result, dryRunRequested(ctx)), ctx.stdout);

  return ExitCode.Success;
};

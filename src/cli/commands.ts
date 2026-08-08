import path from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";

import { AmbitError, ExitCode } from "../errors.js";
import { ITEM_KINDS } from "../model/requirement.js";
import type { SourceContext } from "../model/sources.js";

/**
 * Flags every command accepts — the same three on every one of them, since every command has the same
 * subject.
 *
 * They are attached to each subcommand rather than only to the root program so that
 * `ambit install --dry-run` works — Commander only accepts program-level options before the
 * subcommand name.
 *
 * `--catalog <dir>` was the fourth, on the commands whose subject was one catalog root rather than a
 * project. Every project is a catalog now — it lists itself as `source: path:.` — so there is one
 * subject, one directory flag, and no command that reads a directory instead of an `ambit.yml`.
 * `--offline` becomes uniform with it: it was withheld from the catalog commands because a catalog
 * directory is read off disk and resolves no source, and there is no such command left. `ambit
 * search` declares a `--catalog <name>` of its own, and it is not that flag returning: it takes an
 * alias out of `catalogs:`, it names one of the things being searched rather than where to search
 * from, and it belongs to the one command that has several of them to choose between.
 *
 * `--quiet` and `--no-color` are deliberately absent. Both were accepted here and read nowhere: ambit
 * prints no progress chatter to suppress and no color to disable, so each parsed cleanly and then did
 * nothing. A flag that lies about what it does is worse than one that does not exist — a script
 * passing `--quiet` now gets a usage error instead of silence it never actually asked for. Re-add
 * either only alongside the output it controls.
 */
function globalOptions(): Option[] {
  return [
    new Option("--project <dir>", "project directory").default(undefined, "cwd"),
    new Option("--json", "machine-readable output"),
    new Option("--offline", "use only cached catalogs"),
  ];
}

/** `--dry-run`, added only to commands that touch disk. */
function dryRunOption(): Option {
  return new Option("--dry-run", "print the plan without touching disk");
}

/**
 * A flag that may be given more than once, collecting into a list — `--catalog a --catalog b`.
 *
 * Repeating rather than accepting a list is deliberate: Commander's variadic form (`<name...>`) eats
 * every following word until the next `-`, so `ambit search --capability skill "foo*"` would read the
 * pattern as a second capability. One value per flag cannot do that, whatever order the arguments
 * come in.
 *
 * `allowed`, when given, is checked here rather than left to `.choices()`. Commander's `.choices()`
 * *replaces* the option's parser with one that returns a single value, so the two cannot both be
 * installed; the call below is kept anyway, because it is also what puts `(choices: …)` in `--help`,
 * and the parser attached after it does the checking with Commander's own wording.
 */
function listOption(flags: string, description: string, allowed?: readonly string[]): Option {
  const option = new Option(flags, description);
  if (allowed) option.choices([...allowed]);
  return option.argParser((value: string, previous: readonly string[] | undefined) => {
    if (allowed && !allowed.includes(value)) {
      throw new InvalidArgumentError(`Allowed choices are ${allowed.join(", ")}.`);
    }
    return [...(previous ?? []), value];
  });
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  /** Positional arguments in Commander syntax, e.g. `<name>`, in the order they are given. */
  readonly args?: readonly (readonly [spec: string, description: string])[];
  /** Command-specific flags, on top of the global set. */
  readonly options?: readonly Option[];
  /** Whether this command mutates its subject, and so takes `--dry-run`. */
  readonly mutating?: boolean;
  /**
   * Nested commands, for a name that is a group rather than a command.
   *
   * A group has no action of its own: bare `ambit <group>` prints its usage, the way bare `ambit`
   * does. It cannot be given one — a group that also ran a command was how `ambit catalog` came to
   * mean `ambit catalog dump`, and with it one word covering both a project and a catalog directory.
   *
   * Nothing declares one: the surface is flat, `catalog` having been the only group and its last
   * subcommand having been absorbed into `ambit validate`. Kept as the seam a future group hangs
   * off — the group machinery in {@link buildCommand} is what a second one would need, and with no
   * group on the surface it is exercised directly rather than through it (see the group-seam cases in
   * `test/model/catalog.test.ts`).
   */
  readonly subcommands?: readonly CommandSpec[];
}

/**
 * The full CLI surface, declared in one place so usage output and dispatch
 * cannot drift apart. Commands are wired to behaviour as the build reaches them; until then
 * they report that they are unimplemented rather than pretending to work.
 *
 * Twelve commands, and flat: one subject, one directory flag, and no word standing for a group. Nothing
 * writes into a catalog — a catalog is Markdown and YAML in a git repo, and an author has an editor —
 * and nothing reads a catalog directory instead of an `ambit.yml`, because a catalog repo lists
 * itself.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "init", summary: "scaffold ambit.yml, skills/, mcps/, hooks/", mutating: true },
  {
    name: "search",
    summary: "search the merged catalog",
    // Required, and `*` is how everything is asked for. An optional pattern would make the bare
    // command mean *match everything*, which is a default no one typed and the one reading of a
    // missing argument that cannot be told apart from a shell that swallowed it.
    args: [["<pattern>", "glob matched against item names; `*` matches every name"]],
    options: [
      listOption("--catalog <name>", "limit to this catalog; repeatable"),
      listOption("--capability <kind>", "limit to this namespace; repeatable", ITEM_KINDS),
    ],
  },
  {
    name: "resolve",
    summary: "compute the bundle and print it",
    options: [new Option("--explain", "annotate each item with why it was selected")],
  },
  {
    name: "why",
    summary: "explain why one item is in the bundle",
    args: [["<kind:name>", "`skill:<name>`, `mcp:<name>`, or `hook:<name>`"]],
  },
  {
    name: "install",
    summary: "resolve, write lock, materialize, prune",
    mutating: true,
    options: [
      new Option("--frozen", "fail if resolution would change ambit.lock"),
      new Option("--adopt", "take ownership of existing unowned artifacts"),
      // Mutually exclusive: one copies every skill and the other symlinks every skill, so there is
      // no run that means both. Commander enforces it, which it can only do now that a subcommand
      // inherits `exitOverride` and `configureOutput` (`inheritSettings` in `src/cli/program.ts`) and its
      // refusal therefore travels out of `run()` as exit 2 instead of leaving the process.
      new Option("--copy", "copy local-source skills instead of symlinking").conflicts("link"),
      new Option("--link", "symlink skills instead of copying"),
    ],
  },
  {
    name: "status",
    summary: "compare what is installed against what resolve produces",
    options: [new Option("--check", "exit 5 when drift is detected")],
  },
  // The pair, in the order they are used: find out, then act. Neither is `install` under a flag —
  // `install` deliberately resolves from the cache and never moves a pin, and these two are the only
  // commands that reach a remote for a ref the cache can already answer.
  { name: "outdated", summary: "check whether any catalog's ref now names a different commit" },
  {
    name: "update",
    summary: "move catalog pins forward, then install",
    args: [["[catalog...]", "catalogs to update; every one of them when none is named"]],
    mutating: true,
    options: [
      new Option("--adopt", "take ownership of existing unowned artifacts"),
      new Option("--copy", "copy local-source skills instead of symlinking").conflicts("link"),
      new Option("--link", "symlink skills instead of copying"),
    ],
  },
  { name: "prune", summary: "remove owned artifacts not in the current bundle", mutating: true },
  { name: "clean", summary: "remove everything ambit owns", mutating: true },
  // Everything this project configures: every catalog it lists, its own items, its own `requires`
  // entries. A catalog repo runs this one too — it lists itself, so its items are a catalog like any
  // other, and every item in the merged catalog is checked whether anything selects it or not.
  { name: "validate", summary: "validate everything this project configures, for CI" },
  { name: "doctor", summary: "check preconditions, drift, ownership" },
];

export type CommandOptions = Readonly<Record<string, unknown>>;

export interface CommandContext {
  readonly options: CommandOptions;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export type CommandHandler = (ctx: CommandContext) => Promise<ExitCode> | ExitCode;

/**
 * A rule about the flags one command was given, which Commander enforces before it dispatches
 * ({@link buildCommand} attaches it as a `preAction` hook).
 *
 * It exists for the rules Commander's own primitives cannot state without giving up the message:
 * `.makeOptionMandatory()` says `error: required option '--description <text>' not specified`, which
 * names no file and gives no next step, where every error has to name the offending file, name the
 * offending identifier, and give one concrete next step. A rule is declared with its command like any
 * of them and throws one of ambit's own errors, so the refusal is Commander's to make and the message
 * stays what §6 requires.
 *
 * No command declares one today: the four that did belonged to the catalog mutators, and went with
 * them, so `RULES` in `src/cli/program.ts` is empty. This is the seam a command whose flags need a
 * refusal Commander cannot word hangs off.
 *
 * It reads argv and nothing else — a rule that touched disk or printed would be a handler — and it runs
 * before the handler, so the handler is only ever entered on an invocation the rule accepted.
 *
 * @throws {AmbitError} whatever the rule refuses, already in the standard message shape.
 */
export type CommandRule = (ctx: CommandContext) => void;

/**
 * The project directory a command acts on: `--project` if given, otherwise the cwd.
 *
 * The only directory any command reads. `catalogDirOf` was its mirror, for the commands whose subject
 * was a catalog root with no `ambit.yml` in it; every project is a catalog now, so there is one
 * subject and one flag naming it.
 */
export function projectDirOf(ctx: CommandContext): string {
  const given = ctx.options.project;
  return typeof given === "string" ? path.resolve(ctx.cwd, given) : ctx.cwd;
}

/** Whether `--json` was requested. */
export function jsonRequested(ctx: CommandContext): boolean {
  return ctx.options.json === true;
}

/** Whether `--offline` was requested: resolve from the cache alone. */
export function offlineRequested(ctx: CommandContext): boolean {
  return ctx.options.offline === true;
}

/**
 * Every value given for a repeatable flag ({@link listOption}), in the order they were typed. Empty
 * when the flag was never given.
 *
 * Empty and absent are the same answer on purpose: a repeatable flag has no spelling that means *and
 * nothing at all*, so there is nothing for a caller to tell apart, and one of the two shapes would
 * only ever be handled by copying the other's branch.
 */
export function listOf(ctx: CommandContext, name: string): readonly string[] {
  const given = ctx.options[name];
  if (!Array.isArray(given)) return [];
  return given.filter((value): value is string => typeof value === "string");
}

/**
 * Whether `--dry-run` was requested: report what the command would do and touch nothing.
 *
 * Only a mutating command is given the flag (`dryRunOption`), so every command that can read this is
 * one that has something to withhold.
 */
export function dryRunRequested(ctx: CommandContext): boolean {
  return ctx.options.dryRun === true;
}

/**
 * What resolving a `source` needs from a command: the project directory, the environment the
 * catalog cache is looked for in, and whether fetching is allowed at all.
 *
 * `process.env` is read here, at the CLI boundary, so one command run sees one environment and
 * nothing further down reaches for ambient state of its own. `--offline` travels the same way,
 * because every command that reads a catalog accepts it and none of them should have to remember to.
 */
export function sourceContextOf(ctx: CommandContext): SourceContext {
  return { projectDir: projectDirOf(ctx), env: process.env, offline: offlineRequested(ctx) };
}

/**
 * Handlers, keyed by the words a user types: `"install"`, or `"<group> <command>"` for a nested one.
 * Absent means declared-but-unimplemented.
 */
export type CommandHandlers = Readonly<Record<string, CommandHandler>>;

/**
 * Flag rules, keyed exactly as {@link CommandHandlers} is: by the words a user types. Absent means the
 * command's flags need no rule beyond what Commander already states in its declaration.
 */
export type CommandRules = Readonly<Record<string, CommandRule>>;

export function notImplemented(name: string): AmbitError {
  return new AmbitError(ExitCode.Internal, `command "${name}" is not implemented yet`, [
    "it is declared in the CLI surface but has no behaviour on this build",
    "run `ambit --help` to see what does work",
  ]);
}

/**
 * What a rule and a handler both read: the flags and positionals Commander parsed for one command.
 *
 * A variadic argument — `[catalog...]` — arrives as one array where every other argument arrives as a
 * string, so it is flattened into the same list. That keeps {@link positional} meaning what it always
 * meant for the commands that take fixed arguments, and lets a variadic command read `ctx.args` as the
 * list it asked for; no command mixes the two, so nothing is ambiguous about the result.
 */
function contextOf(
  command: Command,
  io: Pick<CommandContext, "cwd" | "stdout" | "stderr">,
): CommandContext {
  const args = command.processedArgs.flatMap((value): readonly string[] => {
    if (typeof value === "string") return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
  });
  return { options: command.opts(), args, ...io };
}

/**
 * Builds the Commander subcommand for one spec, recursing into a group's subcommands. `onExit`
 * receives whatever the handler returns, so a meaningful non-zero code (drift, doctor failures)
 * travels out without being dressed up as an error.
 *
 * `trail` is the enclosing group's words, so a nested command finds its handler and names itself in
 * an error by the whole invocation (`<group> <command>`) rather than by the leaf. That whole
 * invocation is also the key its handler and its rule are filed under. No spec declares a group
 * today — see {@link CommandSpec.subcommands}.
 *
 * @throws {AmbitError} exit 1 when the command is declared in the surface but has no handler yet, and
 *   whatever this command's {@link CommandRule} refuses about the flags it was given.
 */
export function buildCommand(
  spec: CommandSpec,
  handlers: CommandHandlers,
  rules: CommandRules,
  io: Pick<CommandContext, "cwd" | "stdout" | "stderr">,
  onExit: (code: ExitCode) => void,
  trail: readonly string[] = [],
): Command {
  const words = [...trail, spec.name];
  const name = words.join(" ");
  // Whether this command does something itself, as opposed to only holding others.
  const acts = spec.subcommands === undefined;
  const command = new Command(spec.name)
    .description(spec.summary)
    .helpOption("--help", "show usage");

  for (const [argSpec, description] of spec.args ?? []) command.argument(argSpec, description);
  for (const option of spec.options ?? []) command.addOption(option);
  if (spec.mutating) command.addOption(dryRunOption());
  // A group takes no flags of its own: there is nothing for `--json` to shape when the answer is a
  // usage message, and a group holding a flag its children also hold is a flag the group silently
  // eats — which is how `ambit catalog` came to answer to `--project` while `ambit catalog validate`
  // answered to `--catalog`.
  if (acts) for (const option of globalOptions()) command.addOption(option);

  if (spec.subcommands) {
    // Stop the group's own option parsing at the subcommand name, for the reason `buildProgram` gives:
    // otherwise Commander claims a flag it recognizes wherever in argv it appears.
    command.enablePositionalOptions();
    for (const child of spec.subcommands) {
      command.addCommand(buildCommand(child, handlers, rules, io, onExit, words));
    }
  }

  // A rule is Commander's to enforce, so it hangs off the command rather than off the first lines of
  // the handler: it runs after parsing and before dispatch, and its refusal travels out of the parse
  // the way an unknown flag's does.
  //
  // Commander fires a `preAction` hook for the command that acted and for every ancestor of it, so a
  // hook on a *group* would see its children's invocations too. Only a leaf carries one — a group has
  // no flags for a rule to be about — and a leaf has no descendants to be fired for, so what runs the
  // rule is always the command the rule belongs to.
  const rule = acts ? rules[name] : undefined;
  if (rule !== undefined) command.hook("preAction", () => rule(contextOf(command, io)));

  command.action(async () => {
    // A group is a request for usage rather than a mistake, exactly as bare `ambit` is. Printing it
    // through `io` also keeps it out of Commander's own exit path.
    if (!acts) {
      io.stdout(command.helpInformation().replace(/\n$/, ""));
      return onExit(ExitCode.Success);
    }

    const handler = handlers[name];
    if (!handler) throw notImplemented(name);

    onExit(await handler(contextOf(command, io)));
  });

  return command;
}

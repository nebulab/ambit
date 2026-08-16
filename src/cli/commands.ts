import path from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";

import { AmbitError, ExitCode } from "../errors.js";
import { ITEM_KINDS } from "../model/requirement.js";
import type { SourceContext } from "../model/sources.js";

/**
 * Flags every command accepts.
 *
 * Attached to each subcommand rather than only to the root program, because Commander only
 * accepts program-level options before the subcommand name; without this, `ambit install
 * --dry-run` would not parse.
 *
 * There is no `--catalog <dir>` here: every project is a catalog now (it lists itself as
 * `source: path:.`), so there is one subject and one directory flag. `ambit search` has its own
 * `--catalog <name>` option, but that names one of several catalogs to search, not where to
 * search from.
 *
 * `--quiet` and `--no-color` are deliberately absent: ambit has no progress chatter to suppress
 * and no color to disable, so both flags used to parse and do nothing. Re-add either only
 * alongside the output it would control.
 *
 * The same rule is why `--project` is conditional. `self-update`'s subject is the binary, not a
 * project, so the flag would parse and do nothing there; {@link CommandSpec.readsProject} is how a
 * command opts out. `--offline` stays on it, because a user who habitually passes the flag is
 * better served by a refusal that explains itself than by `unknown option`.
 */
function globalOptions(readsProject: boolean): Option[] {
  return [
    ...(readsProject
      ? [new Option("--project <dir>", "project directory").default(undefined, "cwd")]
      : []),
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
 * Repeating rather than accepting a list is deliberate: Commander's variadic form (`<name...>`)
 * eats every following word until the next `-`, so `ambit search --capability skill "foo*"` would
 * read the pattern as a second capability.
 *
 * `allowed`, when given, is checked here rather than left to `.choices()`, because `.choices()`
 * replaces the option's parser with one that returns a single value. It is still called, because
 * that is what puts `(choices: …)` in `--help`; the custom parser attached after it does the
 * actual checking, with Commander's own error wording.
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
   * Whether this command acts on a project, and so takes `--project`. Default true.
   *
   * Only `self-update` sets it false: its subject is the ambit binary, and a directory flag it
   * ignored would be a flag that parses and does nothing.
   */
  readonly readsProject?: boolean;
  /**
   * Nested commands, for a name that is a group rather than a command.
   *
   * A group has no action of its own: bare `ambit <group>` prints its usage, the way bare `ambit`
   * does.
   *
   * Nothing declares one today: `catalog` was the only group, and its last subcommand was
   * absorbed into `ambit validate`. The group-handling code in {@link buildCommand} stays as the
   * seam a future group would need; with no group on the surface, it is exercised directly instead
   * (see the group-seam cases in `test/model/catalog.test.ts`).
   */
  readonly subcommands?: readonly CommandSpec[];
}

/**
 * The full CLI surface, declared in one place so usage output and dispatch cannot drift apart.
 * Commands are wired to behavior as the build reaches them; until then they report themselves
 * unimplemented rather than pretending to work.
 *
 * Thirteen commands, flat: no group. Twelve act on a project, and `self-update` acts on ambit
 * itself. Nothing writes into a catalog — a catalog is Markdown and YAML in a git repo, edited
 * directly — and nothing reads a catalog directory instead of an `ambit.yml`, because a catalog
 * repo lists itself.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "init", summary: "scaffold ambit.yml, skills/, mcps/, hooks/", mutating: true },
  {
    name: "search",
    summary: "search the merged catalog",
    // Required; `*` is how everything is asked for. An optional pattern would make a missing
    // argument silently mean "match everything," indistinguishable from a shell that swallowed it.
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
      // Mutually exclusive: one copies every skill, the other symlinks every skill. Commander
      // enforces this via `.conflicts()`; the refusal travels out of `run()` as exit 2 rather than
      // exiting the process directly because subcommands inherit `exitOverride` and
      // `configureOutput` (`inheritSettings` in `src/cli/program.ts`).
      new Option("--copy", "copy local-source skills instead of symlinking").conflicts("link"),
      new Option("--link", "symlink skills instead of copying"),
    ],
  },
  {
    name: "status",
    summary: "compare what is installed against what resolve produces",
    options: [new Option("--check", "exit 5 when drift is detected")],
  },
  // `outdated` and `update` are the only commands that reach a remote to check a ref the cache
  // already answers. `install` deliberately resolves from the cache alone and never moves a pin.
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
  // Validates everything this project configures: every catalog it lists, its own items, its own
  // `requires` entries. A catalog repo runs this too, since it lists itself as a catalog.
  { name: "validate", summary: "validate everything this project configures, for CI" },
  { name: "doctor", summary: "check preconditions, drift, ownership" },
  // The only command whose subject is ambit rather than a project. The version is a positional
  // because `--version` is already how the program prints its own, and a command where the two
  // spellings meant different things would be a trap.
  {
    name: "self-update",
    summary: "replace this ambit binary with a released one",
    args: [["[version]", "release to install, like `v0.3.1`; the latest release when omitted"]],
    mutating: true,
    readsProject: false,
  },
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
 * A rule about the flags one command was given, enforced by Commander before it dispatches
 * ({@link buildCommand} attaches it as a `preAction` hook).
 *
 * It exists because Commander's own primitives cannot word every refusal the way §6 requires:
 * `.makeOptionMandatory()` produces `error: required option '--description <text>' not
 * specified`, which names no file and gives no next step. A rule throws one of ambit's own errors
 * instead, so the message stays in the standard shape.
 *
 * A rule reads argv only — one that touched disk or printed would be a handler — and always runs
 * before the handler, so the handler only runs on an invocation the rule accepted.
 *
 * @throws {AmbitError} whatever the rule refuses, already in the standard message shape.
 */
export type CommandRule = (ctx: CommandContext) => void;

/**
 * The project directory a command acts on: `--project` if given, otherwise the cwd.
 *
 * The only directory any command reads; every project is a catalog now, so there is one subject
 * and one flag naming it.
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
 * Every value given for a repeatable flag ({@link listOption}), in the order they were typed.
 * Empty when the flag was never given; there is no separate way to spell "given but empty," so
 * callers never need to tell the two cases apart.
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
 * nothing further down reaches for ambient state of its own.
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
 * A variadic argument — `[catalog...]` — arrives as an array, where every other argument arrives
 * as a string; both are flattened into the same `ctx.args` list. No command mixes fixed and
 * variadic arguments, so the flattening is never ambiguous.
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
 * `trail` is the enclosing group's words, so a nested command names itself in an error by the
 * whole invocation (`<group> <command>`) rather than by the leaf; that same string is the key its
 * handler and rule are filed under. No spec declares a group today — see
 * {@link CommandSpec.subcommands}.
 *
 * @throws {AmbitError} exit 1 when the command is declared in the surface but has no handler yet,
 *   and whatever this command's {@link CommandRule} refuses about the flags it was given.
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
  // Whether this command acts, as opposed to only holding other commands.
  const acts = spec.subcommands === undefined;
  const command = new Command(spec.name)
    .description(spec.summary)
    .helpOption("--help", "show usage");

  for (const [argSpec, description] of spec.args ?? []) command.argument(argSpec, description);
  for (const option of spec.options ?? []) command.addOption(option);
  if (spec.mutating) command.addOption(dryRunOption());
  // A group takes no flags of its own: there is nothing for `--json` to shape when the answer is a
  // usage message, and a group sharing a flag with its children would silently claim it first.
  if (acts) {
    for (const option of globalOptions(spec.readsProject !== false)) command.addOption(option);
  }

  if (spec.subcommands) {
    // Stop the group's own option parsing at the subcommand name; otherwise Commander claims a
    // flag it recognizes wherever in argv it appears (see `buildProgram`).
    command.enablePositionalOptions();
    for (const child of spec.subcommands) {
      command.addCommand(buildCommand(child, handlers, rules, io, onExit, words));
    }
  }

  // A rule hangs off the command as a `preAction` hook rather than living in the handler, so it
  // runs after parsing and before dispatch and its refusal travels out the same way an unknown
  // flag's does.
  //
  // Commander fires `preAction` for the command that acted and for every ancestor, so a hook on a
  // *group* would also fire for its children's invocations. Only a leaf carries one.
  const rule = acts ? rules[name] : undefined;
  if (rule !== undefined) command.hook("preAction", () => rule(contextOf(command, io)));

  command.action(async () => {
    // A group is a request for usage, not a mistake, exactly like bare `ambit`. Printing through
    // `io` keeps it out of Commander's own exit path.
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

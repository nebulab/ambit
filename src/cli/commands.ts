import path from "node:path";

import { Command, Option } from "commander";

import { AmbitError, ExitCode } from "../errors.js";
import type { SourceContext } from "../model/sources.js";

/**
 * What a command acts on. Consumer commands read a project's `ambit.yml`; authoring commands read a
 * catalog root, which has no `ambit.yml` at all.
 */
export type CommandSubject = "project" | "catalog";

/**
 * Flags every command accepts.
 *
 * They are attached to each subcommand rather than only to the root program so that
 * `ambit install --dry-run` works — Commander only accepts program-level options before the
 * subcommand name.
 *
 * The subject decides the directory flag, because the two are the same flag in different clothes:
 * `--project <dir>` names a project, `--catalog <dir>` names a catalog root, and both default to the
 * cwd. An authoring command also drops `--offline`: it reads one directory on disk, resolves no
 * source, and so has neither a fetch to refuse nor a cache to fall back to.
 *
 * `--quiet` and `--no-color` are deliberately absent. Both were accepted here and read nowhere: ambit
 * prints no progress chatter to suppress and no color to disable, so each parsed cleanly and then did
 * nothing. A flag that lies about what it does is worse than one that does not exist — a script
 * passing `--quiet` now gets a usage error instead of silence it never actually asked for. Re-add
 * either only alongside the output it controls.
 */
function globalOptions(spec: CommandSpec): Option[] {
  const json = new Option("--json", "machine-readable output");

  if (spec.subject === "catalog") {
    const catalog = new Option("--catalog <dir>", "catalog directory").default(undefined, "cwd");
    return [catalog, json];
  }

  return [
    new Option("--project <dir>", "project directory").default(undefined, "cwd"),
    json,
    new Option("--offline", "use only cached catalogs"),
  ];
}

/** `--dry-run`, added only to commands that touch disk. */
function dryRunOption(): Option {
  return new Option("--dry-run", "print the plan without touching disk");
}

/**
 * A flag that may be given more than once, collecting its values in the order given —
 * `--scope a --scope b` rather than `--scope a,b`, because a scope name can hold a comma far more
 * easily than an argv entry can.
 *
 * The value is absent rather than `[]` when the flag never appeared, so a handler can tell "no
 * entries asked for" from "an empty list asked for".
 */
function repeatable(flags: string, description: string): Option {
  return new Option(flags, description).argParser<readonly string[] | undefined>(
    (value, previous) => [...(previous ?? []), value],
  );
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
  /** What the command acts on. Absent means the project. */
  readonly subject?: CommandSubject;
  /** Nested commands, for a name that is a group rather than a command. */
  readonly subcommands?: readonly CommandSpec[];
  /**
   * The subcommand a bare invocation of the group runs. A group without one prints its own usage
   * instead, the way bare `ambit` does.
   */
  readonly defaultSubcommand?: string;
}

/**
 * The catalog-authoring surface, nested under `catalog` so the group
 * that dumps a catalog is also the group that maintains one.
 *
 * Every command here takes `--catalog <dir>` and every mutation takes `--dry-run`, since authoring
 * rule 6 promises a diff and no writes. `dump` is the exception on both counts: it is the consumer
 * command `ambit catalog` has always been, so it keeps reading `ambit.yml`.
 */
const CATALOG_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: "dump", summary: "dump the merged catalog" },
  {
    name: "init",
    summary: "scaffold a catalog repo, as `ambit init` does a project",
    subject: "catalog",
    mutating: true,
  },
  {
    name: "tree",
    summary: "the scope tree, and what each scope selects",
    subject: "catalog",
  },
  {
    name: "audit",
    summary: "find dead scopes and unreachable items",
    subject: "catalog",
    options: [new Option("--check", "exit 6 when anything was found")],
  },
  {
    name: "scope",
    summary: "maintain scopes.yml",
    subcommands: [
      {
        name: "add",
        summary: "register a scope",
        args: [["<name>", "scope name"]],
        subject: "catalog",
        mutating: true,
        // Mandatory, but through a `CommandRule` rather than `.makeOptionMandatory()`: Commander's own
        // refusal reads `error: required option '--description <text>' not specified`, which names no
        // file and gives no next step. `catalogScopeAddRule` refuses it before the handler runs, in
        // the standard error shape.
        options: [new Option("--description <text>", "what the scope means")],
      },
      {
        name: "rm",
        summary: "unregister a scope nothing declares",
        args: [["<name>", "scope name"]],
        subject: "catalog",
        mutating: true,
      },
      {
        name: "mv",
        summary: "rename a scope and every descendant",
        args: [
          ["<old>", "the scope to rename"],
          ["<new>", "its new name"],
        ],
        subject: "catalog",
        mutating: true,
      },
    ],
  },
  {
    name: "skill",
    summary: "maintain a skill directory",
    subcommands: [
      {
        name: "new",
        summary: "create a skill directory and its SKILL.md",
        args: [["<name>", "skill name"]],
        subject: "catalog",
        mutating: true,
        options: [
          new Option("--description <text>", "what the skill is for"),
          repeatable("--scope <scope>", "a scope the skill is selected by"),
          repeatable("--requires <name>", "a skill, or `mcp.<name>`, the skill needs"),
          repeatable("--env <var>", "an environment variable the skill needs"),
        ],
      },
      {
        name: "rm",
        summary: "delete a skill nothing requires",
        args: [["<name>", "skill name"]],
        subject: "catalog",
        mutating: true,
      },
      {
        name: "mv",
        summary: "rename a skill, rewriting every `requires` that names it",
        args: [
          ["<old>", "the skill to rename"],
          ["<new>", "its new name"],
        ],
        subject: "catalog",
        mutating: true,
      },
    ],
  },
  {
    name: "mcp",
    summary: "maintain an MCP entity",
    subcommands: [
      {
        name: "new",
        summary: "create an MCP entity, with exactly one transport",
        args: [["<name>", "server name"]],
        subject: "catalog",
        mutating: true,
        // Exactly one of `--stdio`/`--http`, and no flag belonging to the other kind — a rule rather
        // than `.conflicts()`, which can say nothing about *neither* flag and would name neither the
        // file nor the supported kinds. `catalogMcpNewRule` refuses all of it before the handler runs.
        options: [
          new Option("--stdio <command>", "spawn this command as the server"),
          repeatable("--arg <arg>", "an argument for the stdio command"),
          new Option("--http <url>", "reach the server over http"),
          repeatable("--header <key=value>", "a header for the http transport"),
          repeatable("--env <var>", "an environment variable the server needs"),
        ],
      },
      {
        name: "rm",
        summary: "delete an MCP entity nothing requires",
        args: [["<name>", "server name"]],
        subject: "catalog",
        mutating: true,
      },
    ],
  },
  {
    name: "annotate",
    summary: "change a skill or MCP's scopes, requires, or env",
    args: [["<name>", "skill name, or `mcp.<name>` for a server"]],
    subject: "catalog",
    mutating: true,
    // At least one flag, and never one entry both added and removed — `catalogAnnotateRule`, since
    // both are about the *values* two repeatable flags collected rather than about which flags
    // appeared, which is not a shape Commander's own primitives can state.
    options: [
      repeatable("--add-scope <scope>", "add a scope"),
      repeatable("--remove-scope <scope>", "remove a scope"),
      repeatable("--add-requires <name>", "add a requirement"),
      repeatable("--remove-requires <name>", "remove a requirement"),
      repeatable("--add-env <var>", "add an environment variable"),
      repeatable("--remove-env <var>", "remove an environment variable"),
    ],
  },
];

/**
 * The full CLI surface, declared in one place so usage output and dispatch
 * cannot drift apart. Commands are wired to behaviour as the build reaches them; until then
 * they report that they are unimplemented rather than pretending to work.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "init", summary: "scaffold an ambit.yml", mutating: true },
  { name: "scopes", summary: "list registered scopes with descriptions" },
  {
    name: "catalog",
    summary: "dump the merged catalog, or author one",
    subcommands: CATALOG_SUBCOMMANDS,
    defaultSubcommand: "dump",
  },
  {
    name: "resolve",
    summary: "compute the bundle and print it",
    options: [new Option("--explain", "annotate each item with why it was selected")],
  },
  {
    name: "why",
    summary: "explain why one item is in the bundle",
    args: [["<name>", "skill or MCP name"]],
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
  { name: "prune", summary: "remove owned artifacts not in the current bundle", mutating: true },
  { name: "clean", summary: "remove everything ambit owns", mutating: true },
  {
    name: "validate",
    summary: "full-catalog validation, for CI",
    options: [new Option("--catalog <dir>", "validate this catalog directory")],
  },
  { name: "doctor", summary: "check env vars, drift, ownership" },
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
 * `.makeOptionMandatory()` says `error: required option '--description <text>' not specified`, and
 * `.conflicts()` can say nothing at all about a *missing* transport, where every error has to
 * name the offending file, name the offending identifier, and give one concrete next step. A rule is
 * declared with its command like any of them and throws one of ambit's own errors, so the refusal is
 * Commander's to make and the message stays what §6 requires.
 *
 * It reads argv and nothing else — a rule that touched disk or printed would be a handler — and it runs
 * before the handler, so the handler is only ever entered on an invocation the rule accepted.
 *
 * @throws {AmbitError} whatever the rule refuses, already in the standard message shape.
 */
export type CommandRule = (ctx: CommandContext) => void;

/** The project directory a command acts on: `--project` if given, otherwise the cwd. */
export function projectDirOf(ctx: CommandContext): string {
  const given = ctx.options.project;
  return typeof given === "string" ? path.resolve(ctx.cwd, given) : ctx.cwd;
}

/**
 * The catalog directory an authoring command acts on: `--catalog` if given, otherwise the cwd.
 *
 * The mirror of {@link projectDirOf}, and separate from it on purpose: a catalog is not a project and
 * has no `ambit.yml`, so a command reads exactly one of the two and the flag it accepts says
 * which.
 */
export function catalogDirOf(ctx: CommandContext): string {
  const given = ctx.options.catalog;
  return typeof given === "string" ? path.resolve(ctx.cwd, given) : ctx.cwd;
}

/**
 * A positional argument Commander has already required.
 *
 * @param index its position, from zero.
 * @param usage how the command is invoked, for the message nobody should see.
 * @throws {AmbitError} exit 1 — unreachable through the CLI, and a clearer failure than `undefined`
 *   reaching a mutation if a caller ever wires a handler up by hand.
 */
export function positional(ctx: CommandContext, index: number, usage: string): string {
  const value = ctx.args[index];
  if (value !== undefined) return value;

  throw new AmbitError(ExitCode.Internal, `\`${usage}\` was given too few arguments`, [
    `argument ${index + 1} is missing`,
    `run \`${usage}\``,
  ]);
}

/**
 * The values of a {@link repeatable} flag, in argv order.
 *
 * `undefined` when the flag never appeared, which is deliberately not the same as an empty list: a
 * handler can tell "no entries asked for" from "an empty list asked for".
 */
export function optionList(ctx: CommandContext, name: string): readonly string[] | undefined {
  const given = ctx.options[name];
  if (!Array.isArray(given)) return undefined;
  return given.filter((value): value is string => typeof value === "string");
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
 * Handlers, keyed by the words a user types: `"install"`, `"catalog scope add"`. Absent means
 * declared-but-unimplemented.
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

/** What a rule and a handler both read: the flags and positionals Commander parsed for one command. */
function contextOf(
  command: Command,
  io: Pick<CommandContext, "cwd" | "stdout" | "stderr">,
): CommandContext {
  const args = command.processedArgs.filter((value): value is string => typeof value === "string");
  return { options: command.opts(), args, ...io };
}

/**
 * Builds the Commander subcommand for one spec, recursing into a group's subcommands. `onExit`
 * receives whatever the handler returns, so a meaningful non-zero code (drift, doctor failures)
 * travels out without being dressed up as an error.
 *
 * `trail` is the enclosing group's words, so a nested command finds its handler and names itself in
 * an error by the whole invocation (`catalog scope add`) rather than by the leaf.
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
  const acts = spec.subcommands === undefined || spec.defaultSubcommand !== undefined;
  // What this command runs when it is the one invoked, which for a group is its default subcommand:
  // the key its handler and its rule are both filed under, so bare `ambit catalog` and
  // `ambit catalog dump` cannot be given different behaviour.
  const invoked = spec.defaultSubcommand === undefined ? name : `${name} ${spec.defaultSubcommand}`;
  const command = new Command(spec.name).description(spec.summary).helpOption("--help", "show usage");

  for (const [argSpec, description] of spec.args ?? []) command.argument(argSpec, description);
  for (const option of spec.options ?? []) command.addOption(option);
  if (spec.mutating) command.addOption(dryRunOption());
  // A group that does nothing by default takes no flags of its own: there is nothing for `--json` to
  // shape when the answer is a usage message, and a group holding a flag its children also hold is a
  // flag the group silently eats.
  if (acts) for (const option of globalOptions(spec)) command.addOption(option);

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
  // A hook also fires for every action *below* the command it is attached to, which is not what a rule
  // about this command's own flags means — hence the guard. Each command below carries its own.
  const rule = acts ? rules[invoked] : undefined;
  if (rule !== undefined) {
    command.hook("preAction", (_parent, actionCommand) => {
      if (actionCommand === command) rule(contextOf(command, io));
    });
  }

  command.action(async () => {
    // A group with nothing to do by default is a request for usage rather than a mistake, exactly as
    // bare `ambit` is. Printing it through `io` also keeps it out of Commander's own exit path.
    if (!acts) {
      io.stdout(command.helpInformation().replace(/\n$/, ""));
      return onExit(ExitCode.Success);
    }

    const handler = handlers[invoked];
    if (!handler) throw notImplemented(invoked);

    onExit(await handler(contextOf(command, io)));
  });

  return command;
}

import path from "node:path";

import { Command, Option } from "commander";

import { AmbitError, ExitCode } from "./errors.js";
import type { SourceContext } from "./sources.js";

/**
 * Flags every command accepts, per spec §6.
 *
 * They are attached to each subcommand rather than only to the root program so that
 * `ambit install --dry-run` works — Commander only accepts program-level options before the
 * subcommand name.
 */
function globalOptions(): Option[] {
  return [
    new Option("--project <dir>", "project directory").default(undefined, "cwd"),
    new Option("--json", "machine-readable output"),
    new Option("--offline", "use only cached catalogs"),
    new Option("--quiet", "suppress progress output"),
    new Option("--no-color", "disable colorized output"),
  ];
}

/** `--dry-run`, added only to commands that touch disk. */
function dryRunOption(): Option {
  return new Option("--dry-run", "print the plan without touching disk");
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  /** Positional arguments in Commander syntax, e.g. `<name>`. */
  readonly argument?: readonly [spec: string, description: string];
  /** Command-specific flags, on top of the global set. */
  readonly options?: readonly Option[];
  /** Whether this command mutates the project, and so takes `--dry-run`. */
  readonly mutating?: boolean;
}

/**
 * The full CLI surface from spec §6, declared in one place so usage output and dispatch
 * cannot drift apart. Commands are wired to behaviour as the build reaches them; until then
 * they report that they are unimplemented rather than pretending to work.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "init", summary: "scaffold an ambit.yml", mutating: true },
  { name: "scopes", summary: "list registered scopes with descriptions" },
  { name: "catalog", summary: "dump the merged catalog" },
  {
    name: "resolve",
    summary: "compute the bundle and print it",
    options: [new Option("--explain", "annotate each item with why it was selected")],
  },
  {
    name: "why",
    summary: "explain why one item is in the bundle",
    argument: ["<name>", "skill or MCP name"],
  },
  {
    name: "install",
    summary: "resolve, write lock, materialize, prune",
    mutating: true,
    options: [
      new Option("--frozen", "fail if resolution would change ambit.lock"),
      new Option("--adopt", "take ownership of existing unowned artifacts"),
      // Mutually exclusive, but deliberately not through Commander's `.conflicts()`: a subcommand
      // added with `addCommand` inherits neither `exitOverride` nor `configureOutput`, so
      // Commander's own refusal would leave the process rather than travel out as an exit code. The
      // handler refuses them instead, in spec §6's message shape.
      new Option("--copy", "copy local-source skills instead of symlinking"),
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

/** The project directory a command acts on: `--project` if given, otherwise the cwd. */
export function projectDirOf(ctx: CommandContext): string {
  const given = ctx.options.project;
  return typeof given === "string" ? path.resolve(ctx.cwd, given) : ctx.cwd;
}

/** Whether `--json` was requested. */
export function jsonRequested(ctx: CommandContext): boolean {
  return ctx.options.json === true;
}

/** Whether `--offline` was requested: resolve from the cache alone (spec §5). */
export function offlineRequested(ctx: CommandContext): boolean {
  return ctx.options.offline === true;
}

/**
 * Whether `--dry-run` was requested: report what the command would do and touch nothing (spec §6).
 *
 * Only a mutating command is given the flag (`dryRunOption`), so every command that can read this is
 * one that has something to withhold.
 */
export function dryRunRequested(ctx: CommandContext): boolean {
  return ctx.options.dryRun === true;
}

/**
 * What resolving a `source` needs from a command: the project directory, the environment the
 * catalog cache is looked for in, and whether fetching is allowed at all (spec §5).
 *
 * `process.env` is read here, at the CLI boundary, so one command run sees one environment and
 * nothing further down reaches for ambient state of its own. `--offline` travels the same way,
 * because every command that reads a catalog accepts it and none of them should have to remember to.
 */
export function sourceContextOf(ctx: CommandContext): SourceContext {
  return { projectDir: projectDirOf(ctx), env: process.env, offline: offlineRequested(ctx) };
}

/** Handlers, keyed by command name. Absent means declared-but-unimplemented. */
export type CommandHandlers = Readonly<Record<string, CommandHandler>>;

export function notImplemented(name: string): AmbitError {
  return new AmbitError(ExitCode.Internal, `command "${name}" is not implemented yet`, [
    "it is declared in the CLI surface but has no behaviour on this build",
    "run `ambit --help` to see what does work",
  ]);
}

/**
 * Builds the Commander subcommand for one spec. `onExit` receives whatever the handler
 * returns, so a meaningful non-zero code (drift, doctor failures) travels out without being
 * dressed up as an error.
 */
export function buildCommand(
  spec: CommandSpec,
  handlers: CommandHandlers,
  io: Pick<CommandContext, "cwd" | "stdout" | "stderr">,
  onExit: (code: ExitCode) => void,
): Command {
  const command = new Command(spec.name).description(spec.summary).helpOption("--help", "show usage");

  if (spec.argument) command.argument(spec.argument[0], spec.argument[1]);
  for (const option of spec.options ?? []) command.addOption(option);
  if (spec.mutating) command.addOption(dryRunOption());
  for (const option of globalOptions()) command.addOption(option);

  command.action(async () => {
    const handler = handlers[spec.name];
    if (!handler) throw notImplemented(spec.name);

    const args = command.processedArgs.filter((value): value is string => typeof value === "string");
    onExit(await handler({ options: command.opts(), args, ...io }));
  });

  return command;
}

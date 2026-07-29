import { Command, CommanderError } from "commander";

import type { CommandContext, CommandHandlers, CommandRules } from "./commands.js";
import { COMMAND_SPECS, buildCommand } from "./commands.js";
import { AmbitError, ExitCode } from "../errors.js";
import { catalogInitHandler } from "./handlers/catalog-init.js";
import { cleanHandler } from "./handlers/clean.js";
import { doctorHandler } from "./handlers/doctor.js";
import { dumpCatalogHandler } from "./handlers/dump-catalog.js";
import { initHandler } from "./handlers/init.js";
import { installHandler } from "./handlers/install.js";
import { pruneHandler } from "./handlers/prune.js";
import { resolveHandler } from "./handlers/resolve.js";
import { statusHandler } from "./handlers/status.js";
import { catalogValidateHandler, validateHandler } from "./handlers/validate.js";
import { whyHandler } from "./handlers/why.js";
import { VERSION } from "../version.js";

export type Io = Pick<CommandContext, "cwd" | "stdout" | "stderr">;

/**
 * Handlers, keyed by the words a user types. Every command the surface declares now has one; a command
 * added without an entry here reports itself unimplemented (exit 1) rather than silently succeeding.
 *
 * A group is absent on purpose: `catalog` holds commands and runs none itself, so bare
 * `ambit catalog` prints usage rather than dispatching to whichever child was picked as its default.
 */
export const HANDLERS: CommandHandlers = {
  "catalog init": catalogInitHandler,
  "catalog validate": catalogValidateHandler,
  clean: cleanHandler,
  doctor: doctorHandler,
  "dump-catalog": dumpCatalogHandler,
  init: initHandler,
  install: installHandler,
  prune: pruneHandler,
  resolve: resolveHandler,
  status: statusHandler,
  validate: validateHandler,
  why: whyHandler,
};

/**
 * Flag rules, keyed by the same words {@link HANDLERS} is: what each command refuses about the flags it
 * was given, before it is dispatched (`buildCommand` hangs each one off its command as a `preAction`
 * hook).
 *
 * Empty, and honestly so. The four rules that lived here belonged to the catalog mutators — a scope
 * needing a description, a server needing exactly one transport, an annotation contradicting itself —
 * and went when those commands did. No command left has a flag shape Commander cannot word a refusal
 * for: `install`'s `--copy`/`--link` is on `.conflicts()`, whose wording for two flags that cannot
 * appear together is already the whole of what there is to say.
 */
export const RULES: CommandRules = {};

/**
 * Copies the program's settings down the whole command tree.
 *
 * `Command.addCommand` — unlike `.command()`, which ambit cannot use because every command is built
 * from a spec — copies nothing from its parent, so a subcommand keeps Commander's own defaults for
 * both of the settings that decide how a usage error leaves the process: it writes to the real
 * `process.stderr` and then calls `process.exit`. That bypasses the exit-code contract on every
 * subcommand (and takes the test worker with it). Copying `configureOutput` and `exitOverride` down
 * is what makes an unknown flag on `ambit catalog validate` print through ambit's own output and
 * travel out of {@link run} as a code.
 *
 * Runs after the tree is assembled, and top-down, so a group and its children end up with the same
 * settings. It copies wholesale, and the program's value wins: the three settings `buildCommand` also
 * touches — `--help`, positional options, and the disabled implicit `help` command — already say the
 * same thing there, but a per-command setting added later has to be applied *after* this or it is lost.
 */
function inheritSettings(parent: Command): void {
  for (const child of parent.commands) {
    child.copyInheritedSettings(parent);
    inheritSettings(child);
  }
}

export function buildProgram(
  io: Io,
  handlers: CommandHandlers,
  onExit: (code: ExitCode) => void,
  rules: CommandRules = RULES,
): Command {
  const program = new Command()
    .name("ambit")
    .description("a deterministic dependency manager for AI-agent capabilities")
    .version(VERSION, "--version", "print the ambit version")
    .helpOption("--help", "show usage")
    .addHelpCommand(false)
    .showHelpAfterError("(run `ambit --help` for usage)")
    // Every flag belongs to the command it follows. Without this, Commander gives an option to
    // whichever command up the chain declares it, so `ambit catalog validate --json` would leave
    // `--json` with the `catalog` group and `validate` believing it was never asked for.
    .enablePositionalOptions()
    .configureOutput({
      writeOut: (str) => io.stdout(str.replace(/\n$/, "")),
      writeErr: (str) => io.stderr(str.replace(/\n$/, "")),
    })
    .exitOverride();

  for (const spec of COMMAND_SPECS) {
    program.addCommand(buildCommand(spec, handlers, rules, io, onExit));
  }
  inheritSettings(program);

  return program;
}

/**
 * Runs the CLI and returns the process exit code. Never throws: every failure path is
 * translated into an exit code, with the message already printed.
 */
export async function run(
  argv: readonly string[],
  io: Io,
  handlers: CommandHandlers = HANDLERS,
  rules: CommandRules = RULES,
): Promise<ExitCode> {
  let code: ExitCode = ExitCode.Success;
  const program = buildProgram(
    io,
    handlers,
    (handlerCode) => {
      code = handlerCode;
    },
    rules,
  );

  // Bare `ambit` is a request for usage, not a mistake: print it and succeed.
  if (argv.length === 0) {
    io.stdout(program.helpInformation().replace(/\n$/, ""));
    return ExitCode.Success;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has already written help or its own message via configureOutput.
      return error.exitCode === 0 ? ExitCode.Success : ExitCode.Config;
    }
    if (error instanceof AmbitError) {
      io.stderr(error.format());
      return error.code;
    }
    io.stderr(`error: unexpected internal error`);
    io.stderr(`       ${error instanceof Error ? error.message : String(error)}`);
    io.stderr(`       this is a bug in ambit; please report it`);
    return ExitCode.Internal;
  }
}

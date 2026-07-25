import { Command, CommanderError } from "commander";

import type { CommandContext, CommandHandlers } from "./commands.js";
import { COMMAND_SPECS, buildCommand } from "./commands.js";
import { AmbitError, ExitCode } from "./errors.js";
import { catalogHandler } from "./handlers/catalog.js";
import { resolveHandler } from "./handlers/resolve.js";
import { VERSION } from "./version.js";

export type Io = Pick<CommandContext, "cwd" | "stdout" | "stderr">;

/** Handlers wired up so far. Each task in the build fills in one more. */
export const HANDLERS: CommandHandlers = {
  catalog: catalogHandler,
  resolve: resolveHandler,
};

export function buildProgram(io: Io, handlers: CommandHandlers, onExit: (code: ExitCode) => void): Command {
  const program = new Command()
    .name("ambit")
    .description("a deterministic dependency manager for AI-agent capabilities")
    .version(VERSION, "--version", "print the ambit version")
    .helpOption("--help", "show usage")
    .addHelpCommand(false)
    .showHelpAfterError("(run `ambit --help` for usage)")
    .configureOutput({
      writeOut: (str) => io.stdout(str.replace(/\n$/, "")),
      writeErr: (str) => io.stderr(str.replace(/\n$/, "")),
    })
    .exitOverride();

  for (const spec of COMMAND_SPECS) {
    program.addCommand(buildCommand(spec, handlers, io, onExit));
  }

  return program;
}

/**
 * Runs the CLI and returns the process exit code. Never throws: every failure path is
 * translated into a code from spec §6, with the message already printed.
 */
export async function run(argv: readonly string[], io: Io, handlers: CommandHandlers = HANDLERS): Promise<ExitCode> {
  let code: ExitCode = ExitCode.Success;
  const program = buildProgram(io, handlers, (handlerCode) => {
    code = handlerCode;
  });

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

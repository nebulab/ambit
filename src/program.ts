import { Command, CommanderError } from "commander";

import type { CommandContext, CommandHandlers } from "./commands.js";
import { COMMAND_SPECS, buildCommand } from "./commands.js";
import { AmbitError, ExitCode } from "./errors.js";
import { catalogAnnotateHandler } from "./handlers/catalog-annotate.js";
import { catalogInitHandler } from "./handlers/catalog-init.js";
import { catalogMcpNewHandler, catalogMcpRemoveHandler } from "./handlers/catalog-mcp.js";
import {
  catalogScopeAddHandler,
  catalogScopeRemoveHandler,
  catalogScopeRenameHandler,
} from "./handlers/catalog-scope.js";
import {
  catalogSkillNewHandler,
  catalogSkillRemoveHandler,
  catalogSkillRenameHandler,
} from "./handlers/catalog-skill.js";
import { catalogTreeHandler } from "./handlers/catalog-tree.js";
import { catalogHandler } from "./handlers/catalog.js";
import { cleanHandler } from "./handlers/clean.js";
import { doctorHandler } from "./handlers/doctor.js";
import { initHandler } from "./handlers/init.js";
import { installHandler } from "./handlers/install.js";
import { pruneHandler } from "./handlers/prune.js";
import { resolveHandler } from "./handlers/resolve.js";
import { scopesHandler } from "./handlers/scopes.js";
import { statusHandler } from "./handlers/status.js";
import { validateHandler } from "./handlers/validate.js";
import { whyHandler } from "./handlers/why.js";
import { VERSION } from "./version.js";

export type Io = Pick<CommandContext, "cwd" | "stdout" | "stderr">;

/**
 * Handlers wired up so far, keyed by the words a user types. Each task in the build fills in one
 * more; a declared command with no entry here reports itself unimplemented (exit 1).
 *
 * `catalog dump` is the whole of `ambit catalog`: the group's default action dispatches to it, so
 * the two invocations cannot render the catalog differently.
 */
export const HANDLERS: CommandHandlers = {
  "catalog annotate": catalogAnnotateHandler,
  "catalog dump": catalogHandler,
  "catalog init": catalogInitHandler,
  "catalog mcp new": catalogMcpNewHandler,
  "catalog mcp rm": catalogMcpRemoveHandler,
  "catalog scope add": catalogScopeAddHandler,
  "catalog scope mv": catalogScopeRenameHandler,
  "catalog scope rm": catalogScopeRemoveHandler,
  "catalog skill mv": catalogSkillRenameHandler,
  "catalog skill new": catalogSkillNewHandler,
  "catalog skill rm": catalogSkillRemoveHandler,
  "catalog tree": catalogTreeHandler,
  clean: cleanHandler,
  doctor: doctorHandler,
  init: initHandler,
  install: installHandler,
  prune: pruneHandler,
  resolve: resolveHandler,
  scopes: scopesHandler,
  status: statusHandler,
  validate: validateHandler,
  why: whyHandler,
};

export function buildProgram(io: Io, handlers: CommandHandlers, onExit: (code: ExitCode) => void): Command {
  const program = new Command()
    .name("ambit")
    .description("a deterministic dependency manager for AI-agent capabilities")
    .version(VERSION, "--version", "print the ambit version")
    .helpOption("--help", "show usage")
    .addHelpCommand(false)
    .showHelpAfterError("(run `ambit --help` for usage)")
    // Every flag belongs to the command it follows. Without this, Commander gives an option to
    // whichever command up the chain declares it, so `ambit catalog dump --json` would leave
    // `--json` with the `catalog` group and `dump` believing it was never asked for.
    .enablePositionalOptions()
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

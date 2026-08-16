import { Command, CommanderError } from "commander";

import type { CommandContext, CommandHandlers, CommandRules } from "./commands.js";
import { COMMAND_SPECS, buildCommand } from "./commands.js";
import { AmbitError, ExitCode } from "../errors.js";
import { cleanHandler } from "./handlers/clean.js";
import { doctorHandler } from "./handlers/doctor.js";
import { initHandler } from "./handlers/init.js";
import { installHandler } from "./handlers/install.js";
import { outdatedHandler, refusesOfflineRule } from "./handlers/outdated.js";
import { pruneHandler } from "./handlers/prune.js";
import { resolveHandler } from "./handlers/resolve.js";
import { searchHandler } from "./handlers/search.js";
import { refusesOfflineSelfUpdateRule, selfUpdateHandler } from "./handlers/self-update.js";
import { statusHandler } from "./handlers/status.js";
import { updateHandler } from "./handlers/update.js";
import { validateHandler } from "./handlers/validate.js";
import { whyHandler } from "./handlers/why.js";
import { VERSION } from "../version.js";

export type Io = Pick<CommandContext, "cwd" | "stdout" | "stderr">;

/**
 * Handlers, keyed by the words a user types. Every command the surface declares has one here; a
 * command added without an entry reports itself unimplemented (exit 1) rather than silently
 * succeeding.
 *
 * Thirteen entries, none with a space: the surface is flat. A group, were one declared, would
 * still have no entry here, since it holds commands and runs none itself.
 */
export const HANDLERS: CommandHandlers = {
  clean: cleanHandler,
  doctor: doctorHandler,
  init: initHandler,
  install: installHandler,
  outdated: outdatedHandler,
  prune: pruneHandler,
  resolve: resolveHandler,
  search: searchHandler,
  "self-update": selfUpdateHandler,
  status: statusHandler,
  update: updateHandler,
  validate: validateHandler,
  why: whyHandler,
};

/**
 * Flag rules, keyed by the same words {@link HANDLERS} is: what each command refuses about the
 * flags it was given, before dispatch (`buildCommand` hangs each one off its command as a
 * `preAction` hook).
 *
 * Three commands need one, and all three refuse `--offline`. `outdated` and `update` share a rule,
 * since both refuse for the same reason: only a remote knows where a ref points now. `self-update`
 * refuses for a different reason — no cache holds a binary it has not downloaded — so it carries
 * its own wording. Rules exist instead of Commander primitives like `.makeOptionMandatory()`
 * because those produce a message that names no file and gives no next step. `install`'s
 * `--copy`/`--link` still uses `.conflicts()` directly, since Commander's wording for two flags
 * that cannot appear together already says everything needed.
 */
export const RULES: CommandRules = {
  outdated: refusesOfflineRule,
  "self-update": refusesOfflineSelfUpdateRule,
  update: refusesOfflineRule,
};

/**
 * Copies the program's settings down the whole command tree.
 *
 * `Command.addCommand` — unlike `.command()`, which ambit cannot use because every command is
 * built from a spec — copies nothing from its parent, so a subcommand keeps Commander's own
 * defaults for how a usage error leaves the process: writing to the real `process.stderr` and
 * calling `process.exit` directly, bypassing the exit-code contract (and taking the test worker
 * with it). Copying `configureOutput` and `exitOverride` down is what makes an unknown flag on
 * `ambit status` print through ambit's own output and travel out of {@link run} as a code.
 *
 * Recurses because a group could nest further, though with no group declared today the walk is
 * one level deep. Runs top-down after the tree is assembled, so a group and its children end up
 * with the same settings. Any per-command setting added later must be applied after this call, or
 * this overwrites it.
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
    // Every flag belongs to the command it follows; without this, `ambit <group> <command> --json`
    // would let the group claim `--json` before the command ever sees it.
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

  // Bare `ambit` is a request for usage, not a mistake.
  if (argv.length === 0) {
    io.stdout(program.helpInformation().replace(/\n$/, ""));
    return ExitCode.Success;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already wrote help or its own message via configureOutput.
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

/**
 * `ambit self-update [version]` — replace this binary with a released one.
 *
 * The one command whose subject is ambit rather than a project, which is why it takes no
 * `--project` and why the version is a positional rather than a `--version` flag: `--version` is
 * already how the program prints its own.
 *
 * A named version is installed whether it is newer or older, so a bad release can be backed out
 * without hunting down the install script. Only the report says which direction it went.
 *
 * `--dry-run` prints the plan, which is the whole decision: the plan is made before anything is
 * downloaded, so it is also what every refusal comes out of.
 */
import type { CommandContext, CommandHandler, CommandRule } from "../commands.js";
import { dryRunRequested, jsonRequested, offlineRequested } from "../commands.js";
import { ExitCode, networkError } from "../../errors.js";
import { columns } from "../output.js";
import { MODULE_URL } from "../../self/platform.js";
import type { SelfContext, SelfUpdatePlan } from "../../self/update.js";
import { applySelfUpdate, isUpgrade, planSelfUpdate } from "../../self/update.js";

/**
 * The refusal of `--offline`.
 *
 * A rule rather than a check in the handler, so Commander enforces it before dispatch and a run
 * that cannot mean anything never starts. Worded for this command rather than shared with
 * `outdated` and `update`: those refuse because only a remote knows where a ref points now, and
 * this one refuses because the bytes it installs do not exist locally.
 *
 * @throws {AmbitError} exit 4 when `--offline` was given.
 */
export const refusesOfflineSelfUpdateRule: CommandRule = (ctx: CommandContext) => {
  if (!offlineRequested(ctx)) return;

  throw networkError("`--offline` cannot install a release", [
    "this command downloads a binary from GitHub, which no local cache holds",
    "run the command again without `--offline`",
  ]);
};

/**
 * What the machine looks like to self-update.
 *
 * Built here, at the CLI boundary, for the same reason `sourceContextOf` is: one command run sees
 * one machine, and nothing further down reaches for ambient state of its own.
 */
export function selfContextOf(): SelfContext {
  return {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    moduleUrl: MODULE_URL,
    mainPath: process.argv[1] ?? "",
    fetch: (url, init) => fetch(url, init),
  };
}

function toJson(plan: SelfUpdatePlan, installed: boolean): Readonly<Record<string, unknown>> {
  return {
    asset: plan.asset,
    binary: plan.binary,
    changed: plan.changed,
    current: plan.current,
    installed,
    target: plan.target,
    upgrade: isUpgrade(plan),
  };
}

/** The last line: what happened, or what would have. */
function verdict(plan: SelfUpdatePlan, dryRun: boolean): string {
  if (!plan.changed) return `ambit ${plan.target} is already installed`;
  if (dryRun) return `would install ambit ${plan.target}`;
  if (isUpgrade(plan)) return `installed ambit ${plan.target}`;
  return `installed ambit ${plan.target}, a downgrade from ${plan.current}`;
}

function toText(plan: SelfUpdatePlan, dryRun: boolean): readonly string[] {
  return [
    ...columns([
      ["current", plan.current],
      ["target", plan.target],
      ["asset", plan.asset],
      ["binary", plan.binary],
    ]),
    "",
    verdict(plan, dryRun),
  ];
}

export const selfUpdateHandler: CommandHandler = async (ctx) => {
  const dryRun = dryRunRequested(ctx);
  const context = selfContextOf();
  const plan = await planSelfUpdate(context, ctx.args[0]);

  const installed = plan.changed && !dryRun;
  if (installed) await applySelfUpdate(plan, context);

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(plan, installed), null, 2));
  else for (const line of toText(plan, dryRun)) ctx.stdout(line);

  return ExitCode.Success;
};

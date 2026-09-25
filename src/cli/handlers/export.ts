import { configError, ExitCode } from "../../errors.js";
import { exportPlugins } from "../../export/export.js";
import type { CommandHandler } from "../commands.js";
import { dryRunRequested, jsonRequested, sourceContextOf } from "../commands.js";

export const exportHandler: CommandHandler = async (ctx) => {
  if (ctx.options.format !== "claude-plugin" || typeof ctx.options.output !== "string") {
    throw configError("export requires --format claude-plugin and --output <dir>", [
      "run `ambit export --format claude-plugin --output dist/plugins`",
    ]);
  }
  const result = await exportPlugins(sourceContextOf(ctx), {
    output: ctx.options.output,
    dryRun: dryRunRequested(ctx),
    link: ctx.options.link === true,
    force: ctx.options.force === true,
    check: ctx.options.check === true,
  });
  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(result, null, 2));
  else {
    ctx.stdout(
      `${ctx.options.check ? "Verified" : dryRunRequested(ctx) ? "Would export" : "Exported"} ${result.plugins.length} Claude plugins to ${result.output}`,
    );
    for (const plugin of result.plugins)
      ctx.stdout(`  ${plugin.directory}/ (${plugin.name}, ${plugin.files} files)`);
  }
  return ExitCode.Success;
};

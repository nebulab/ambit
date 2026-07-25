/**
 * `ambit resolve` — compute the bundle and print it (spec §6).
 *
 * `--json` is the golden-file surface (spec §7), so it carries no absolute paths and every key is
 * emitted in sorted order. The shape mirrors `ambit.lock` (spec §3.5) minus the parts only a
 * fetched catalog can supply, so the lock later becomes a serialization of this rather than a
 * second, differently-shaped view.
 */
import { loadCatalogs, mergeCatalogs } from "../catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, projectDirOf } from "../commands.js";
import { loadProjectConfig } from "../config.js";
import { AmbitError, ExitCode } from "../errors.js";
import { keyed, printSections, section } from "../output.js";
import type { Bundle } from "../resolve.js";
import { resolveBundle } from "../resolve.js";

function toJson(bundle: Bundle): Readonly<Record<string, unknown>> {
  return {
    env: bundle.env,
    mcps: keyed(bundle.mcps, (mcp) => mcp.name, (mcp) => ({ catalog: mcp.catalog })),
    scopes: bundle.scopes,
    skills: keyed(bundle.skills, (skill) => skill.name, (skill) => ({
      catalog: skill.catalog,
      path: skill.path,
    })),
  };
}

function toText(bundle: Bundle): readonly string[] {
  return [
    ...section("scopes", bundle.scopes.map((scope) => [scope])),
    ...section("skills", bundle.skills.map((skill) => [skill.name, skill.catalog])),
    ...section("mcps", bundle.mcps.map((mcp) => [mcp.name, mcp.catalog])),
    ...section("env", bundle.env.map((name) => [name])),
  ];
}

export const resolveHandler: CommandHandler = async (ctx) => {
  // Rather than print an unannotated bundle and let it read as "nothing to explain".
  if (ctx.options.explain === true) {
    throw new AmbitError(ExitCode.Internal, "`--explain` is not implemented yet", [
      "selection reasons arrive with `ambit why`",
      "run `ambit resolve` without it",
    ]);
  }

  const projectDir = projectDirOf(ctx);
  const config = await loadProjectConfig(projectDir);
  const bundle = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, projectDir)));

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(bundle), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(bundle), ctx.stdout);
  return ExitCode.Success;
};

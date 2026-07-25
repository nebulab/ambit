/**
 * `ambit resolve` — compute the bundle and print it (spec §6).
 *
 * `--json` is the golden-file surface (spec §7), so it carries no absolute paths and every key is
 * emitted in sorted order. The shape mirrors `ambit.lock` (spec §3.5) minus the parts only a
 * fetched catalog can supply, so the lock later becomes a serialization of this rather than a
 * second, differently-shaped view.
 *
 * `--explain` adds one column and one key rather than a different report: the annotated bundle is
 * the same bundle, and a reader comparing the two should not have to re-find their bearings. The
 * reason is deliberately the short form — `ambit why` is where a whole chain belongs.
 */
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, projectDirOf } from "../commands.js";
import { loadProjectConfig } from "../config.js";
import { ExitCode } from "../errors.js";
import { keyed, printSections, section } from "../output.js";
import type { Bundle, BundleItem } from "../resolve.js";
import { formatReason, reasonOf, resolveBundle } from "../resolve.js";

/** The reason column and key, present only under `--explain`. */
function reason(bundle: Bundle, item: BundleItem, explain: boolean): string | undefined {
  return explain ? formatReason(reasonOf(bundle, item)) : undefined;
}

function toJson(bundle: Bundle, explain: boolean): Readonly<Record<string, unknown>> {
  return {
    env: bundle.env,
    mcps: keyed(bundle.mcps, (mcp) => mcp.name, (mcp) => {
      const why = reason(bundle, { kind: "mcp", name: mcp.name }, explain);
      return { catalog: mcp.catalog, ...(why !== undefined && { reason: why }) };
    }),
    scopes: bundle.scopes,
    skills: keyed(bundle.skills, (skill) => skill.name, (skill) => {
      const why = reason(bundle, { kind: "skill", name: skill.name }, explain);
      return {
        catalog: skill.catalog,
        path: skill.path,
        ...(why !== undefined && { reason: why }),
      };
    }),
  };
}

/** A row with the reason appended, or the row unchanged when nothing was asked to explain it. */
function row(cells: readonly string[], why: string | undefined): readonly string[] {
  return why === undefined ? cells : [...cells, why];
}

function toText(bundle: Bundle, explain: boolean): readonly string[] {
  return [
    ...section("scopes", bundle.scopes.map((scope) => [scope])),
    ...section(
      "skills",
      bundle.skills.map((skill) =>
        row([skill.name, skill.catalog], reason(bundle, { kind: "skill", name: skill.name }, explain)),
      ),
    ),
    ...section(
      "mcps",
      bundle.mcps.map((mcp) =>
        row([mcp.name, mcp.catalog], reason(bundle, { kind: "mcp", name: mcp.name }, explain)),
      ),
    ),
    ...section("env", bundle.env.map((name) => [name])),
  ];
}

export const resolveHandler: CommandHandler = async (ctx) => {
  const explain = ctx.options.explain === true;

  const projectDir = projectDirOf(ctx);
  const config = await loadProjectConfig(projectDir);
  const catalogs = mergeCatalogs(await loadCatalogs(config, projectDir));
  const bundle = resolveBundle(config, await mergeConfigEntities(catalogs, config, projectDir));

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(bundle, explain), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(bundle, explain), ctx.stdout);
  return ExitCode.Success;
};

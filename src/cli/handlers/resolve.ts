/**
 * `ambit resolve` — compute the bundle and print it.
 *
 * `--json` is the golden-file surface, so it carries no absolute paths and every key is
 * emitted in sorted order. The shape mirrors `ambit.lock` minus the parts only a
 * fetched catalog can supply, so the lock later becomes a serialization of this rather than a
 * second, differently-shaped view.
 *
 * `--explain` adds one column and one key rather than a different report: the annotated bundle is
 * the same bundle, and a reader comparing the two should not have to re-find their bearings. The
 * reason is deliberately the short form — `ambit why` is where a whole chain belongs.
 *
 * Shadowing is annotated beside the reason rather than in place of it. Spec §6 lists
 * `catalog:company (shadows personal)` alongside the three selection reasons, but the two answer
 * different questions — *why is this here* and *whose copy is this* — and only one item in a bundle
 * can be shadowed while every item has a reason. Folding the first into the second would cost a
 * shadowed item its reason, in `--explain` and in `ambit why`'s chain both.
 */
import type { MergedCatalog, Shadowing } from "../../model/catalog.js";
import { formatShadowing, loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { loadProjectConfig } from "../../model/config.js";
import { ExitCode } from "../../errors.js";
import { keyed, printSections, section } from "../output.js";
import type { Bundle, BundleItem } from "../../resolution/resolve.js";
import { formatReason, reasonOf, resolveBundle } from "../../resolution/resolve.js";

/** The reason column and key, present only under `--explain`. */
function reason(bundle: Bundle, item: BundleItem, explain: boolean): string | undefined {
  return explain ? formatReason(reasonOf(bundle, item)) : undefined;
}

/**
 * The shadowing an item carries, present only under `--explain` and only where two catalogs both
 * provided the name.
 */
function shadowing(
  merged: MergedCatalog,
  item: BundleItem,
  explain: boolean,
): Shadowing | undefined {
  if (!explain) return undefined;
  const shadowed = item.kind === "skill" ? merged.shadowing.skills : merged.shadowing.mcps;
  return shadowed.get(item.name);
}

function toJson(
  bundle: Bundle,
  merged: MergedCatalog,
  explain: boolean,
): Readonly<Record<string, unknown>> {
  return {
    env: bundle.env,
    mcps: keyed(bundle.mcps, (mcp) => mcp.name, (mcp) => {
      const item: BundleItem = { kind: "mcp", name: mcp.name };
      const why = reason(bundle, item, explain);
      const shadowed = shadowing(merged, item, explain);
      return {
        catalog: mcp.catalog,
        ...(why !== undefined && { reason: why }),
        ...(shadowed !== undefined && { shadows: shadowed.shadows }),
      };
    }),
    scopes: bundle.scopes,
    skills: keyed(bundle.skills, (skill) => skill.name, (skill) => {
      const item: BundleItem = { kind: "skill", name: skill.name };
      const why = reason(bundle, item, explain);
      const shadowed = shadowing(merged, item, explain);
      return {
        catalog: skill.catalog,
        path: skill.path,
        ...(why !== undefined && { reason: why }),
        // Structured rather than the `--explain` string: the record already names the winning
        // catalog, so a consumer needs the losers, not a sentence about them.
        ...(shadowed !== undefined && { shadows: shadowed.shadows }),
      };
    }),
  };
}

/**
 * A row with the reason appended, or the row unchanged when nothing was asked to explain it.
 *
 * The shadowing cell is emitted empty rather than omitted where there is none, so the reason column
 * is padded identically down the whole section — a table where one row's last column is aligned and
 * the next row's is not reads as a bug.
 */
function row(
  cells: readonly string[],
  why: string | undefined,
  shadowed: Shadowing | undefined,
): readonly string[] {
  if (why === undefined) return cells;
  return [...cells, why, shadowed === undefined ? "" : formatShadowing(shadowed)];
}

function toText(bundle: Bundle, merged: MergedCatalog, explain: boolean): readonly string[] {
  return [
    ...section("scopes", bundle.scopes.map((scope) => [scope])),
    ...section(
      "skills",
      bundle.skills.map((skill) => {
        const item: BundleItem = { kind: "skill", name: skill.name };
        return row(
          [skill.name, skill.catalog],
          reason(bundle, item, explain),
          shadowing(merged, item, explain),
        );
      }),
    ),
    ...section(
      "mcps",
      bundle.mcps.map((mcp) => {
        const item: BundleItem = { kind: "mcp", name: mcp.name };
        return row(
          [mcp.name, mcp.catalog],
          reason(bundle, item, explain),
          shadowing(merged, item, explain),
        );
      }),
    ),
    ...section("env", bundle.env.map((name) => [name])),
  ];
}

export const resolveHandler: CommandHandler = async (ctx) => {
  const explain = ctx.options.explain === true;

  const context = sourceContextOf(ctx);
  const config = await loadProjectConfig(context.projectDir);
  const catalogs = mergeCatalogs(await loadCatalogs(config, context));
  const merged = await mergeConfigEntities(catalogs, config, context);
  const bundle = resolveBundle(config, merged);

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(bundle, merged, explain), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(bundle, merged, explain), ctx.stdout);
  return ExitCode.Success;
};

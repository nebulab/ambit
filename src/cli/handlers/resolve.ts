/**
 * `ambit resolve` — compute the bundle and print it.
 *
 * `--json` is the golden-file surface: no absolute paths, every key emitted in sorted order. The
 * shape mirrors `ambit.lock` minus the parts only a fetched catalog can supply, so the lock is later
 * a serialization of this rather than a second, differently-shaped view.
 *
 * `--explain` adds one column and one key rather than a different report, so a reader comparing the
 * two doesn't need to re-find their bearings. The reason is the short form; `ambit why` prints the
 * whole chain.
 *
 * A bundle holds one item per name; a selection reaching two catalogs' copies of the same name is
 * refused at resolve, not reported here, since both would be installed at one path.
 */
import { loadCatalogs, mergeCatalogs } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { loadProjectConfig } from "../../model/config.js";
import { ExitCode } from "../../errors.js";
import { EXPECTATION_KINDS } from "../../model/expectation.js";
import { keyed, printSections, section } from "../output.js";
import type { Bundle, BundleItem } from "../../resolution/resolve.js";
import { formatReason, reasonOf, resolveBundle } from "../../resolution/resolve.js";

/** The reason column and key, present only under `--explain`. */
function reason(bundle: Bundle, item: BundleItem, explain: boolean): string | undefined {
  return explain ? formatReason(reasonOf(bundle, item)) : undefined;
}

function toJson(bundle: Bundle, explain: boolean): Readonly<Record<string, unknown>> {
  return {
    expects: bundle.expects,
    hooks: keyed(
      bundle.hooks,
      (hook) => hook.name,
      (hook) => {
        const why = reason(bundle, { kind: "hook", name: hook.name }, explain);
        return {
          catalog: hook.catalog,
          event: hook.event,
          ...(why !== undefined && { reason: why }),
        };
      },
    ),
    mcps: keyed(
      bundle.mcps,
      (mcp) => mcp.name,
      (mcp) => {
        const why = reason(bundle, { kind: "mcp", name: mcp.name }, explain);
        return {
          catalog: mcp.catalog,
          ...(why !== undefined && { reason: why }),
        };
      },
    ),
    // A pack materializes nothing, so this record carries no path and no bytes: it only says the
    // project asked for it.
    packs: keyed(
      bundle.packs,
      (pack) => pack.name,
      (pack) => {
        const why = reason(bundle, { kind: "pack", name: pack.name }, explain);
        return {
          catalog: pack.catalog,
          ...(why !== undefined && { reason: why }),
        };
      },
    ),
    skills: keyed(
      bundle.skills,
      (skill) => skill.name,
      (skill) => {
        const why = reason(bundle, { kind: "skill", name: skill.name }, explain);
        return {
          catalog: skill.catalog,
          path: skill.path,
          ...(why !== undefined && { reason: why }),
        };
      },
    ),
  };
}

/** A row with the reason appended, or the row unchanged when nothing was asked to explain it. */
function row(cells: readonly string[], why: string | undefined): readonly string[] {
  return why === undefined ? cells : [...cells, why];
}

function toText(bundle: Bundle, explain: boolean): readonly string[] {
  return [
    // Packs first: they are what a project usually wrote down; the sections below are what they
    // expanded to.
    ...section(
      "packs",
      bundle.packs.map((pack) =>
        row([pack.name, pack.catalog], reason(bundle, { kind: "pack", name: pack.name }, explain)),
      ),
    ),
    ...section(
      "skills",
      bundle.skills.map((skill) =>
        row(
          [skill.name, skill.catalog],
          reason(bundle, { kind: "skill", name: skill.name }, explain),
        ),
      ),
    ),
    ...section(
      "mcps",
      bundle.mcps.map((mcp) =>
        row([mcp.name, mcp.catalog], reason(bundle, { kind: "mcp", name: mcp.name }, explain)),
      ),
    ),
    ...section(
      "hooks",
      bundle.hooks.map((hook) =>
        row(
          [hook.name, hook.catalog, hook.event],
          reason(bundle, { kind: "hook", name: hook.name }, explain),
        ),
      ),
    ),
    // One row per precondition, kind in its own column, so `env` and `bin` entries are distinguishable
    // at a glance.
    ...section(
      "expects",
      EXPECTATION_KINDS.flatMap((kind) => (bundle.expects[kind] ?? []).map((name) => [kind, name])),
    ),
  ];
}

export const resolveHandler: CommandHandler = async (ctx) => {
  const explain = ctx.options.explain === true;

  const context = sourceContextOf(ctx);
  const config = await loadProjectConfig(context.projectDir);
  const merged = mergeCatalogs(await loadCatalogs(config, context));
  const bundle = resolveBundle(config, merged);

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(bundle, explain), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(bundle, explain), ctx.stdout);
  return ExitCode.Success;
};

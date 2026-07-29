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
 * There is nothing to annotate about *whose* copy an item is. Every row already names its catalog,
 * and a bundle holds one item per name — a selection reaching two catalogs' copies of one name is
 * refused at resolve rather than reported here, since both would be installed at one path.
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
        // The event beside the catalog, not instead of it: the catalog says where to change the hook,
        // and the event is what a reader scanning the list is looking for.
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
    // One row per precondition, its kind in its own column: the kind is what says how the thing is
    // checked, so a reader scanning the section can see `env` and the `bin` beside it for what they are
    // rather than having to read the names.
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

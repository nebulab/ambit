/**
 * `ambit why <name>` — explain why one item is in the bundle (spec §6).
 *
 * The chain is the answer, not the reason on its own: being told a skill arrived through
 * `required-by:acme.projects.use-acme-brief` only moves the question one level up, and it is the
 * held scope at the far end that a reader can actually change. So this prints every link from the
 * root cause down to the item asked about.
 *
 * A bare name means a skill when one exists and a server otherwise, and an `mcp.`-prefixed name
 * always means a server — the same disambiguation `requires` uses (spec §3.2), so a name copied out
 * of a `requires` list works here unchanged.
 *
 * A name that resolves to nothing selected is an error rather than an empty report: "not in the
 * bundle" is a resolution answer a script has to be able to detect, and the two ways of getting
 * there — no catalog provides it, or nothing selects it — call for different fixes.
 */
import type { MergedCatalog, MergedMcp, MergedSkill } from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import type { ProjectConfig } from "../../model/config.js";
import { loadProjectConfig } from "../../model/config.js";
import { AmbitError, ExitCode, resolutionError } from "../../errors.js";
import { printSections, section } from "../output.js";
import type { Bundle, BundleItem, ReasonedItem, SelectionReason } from "../../resolution/resolve.js";
import {
  MCP_REQUIREMENT_PREFIX,
  explainSelection,
  formatReason,
  isSelected,
  reasonOf,
  resolveBundle,
} from "../../resolution/resolve.js";

/** How an item is named in messages. */
function subject(item: BundleItem): string {
  return item.kind === "skill" ? `skill "${item.name}"` : `MCP server "${item.name}"`;
}

/**
 * What a name could mean, in the order a tie is broken.
 *
 * A skill wins a bare name: skills are what a project mostly holds, and `mcp.` is already the way to
 * insist on a server. The prefixed reading is tried before the literal one, so `mcp.close` finds the
 * server `close` — a skill whose own name starts with `mcp.` is still found first, by the exact
 * match ahead of both.
 */
function candidates(name: string): readonly BundleItem[] {
  const options: BundleItem[] = [{ kind: "skill", name }];
  if (name.startsWith(MCP_REQUIREMENT_PREFIX)) {
    options.push({ kind: "mcp", name: name.slice(MCP_REQUIREMENT_PREFIX.length) });
  }
  options.push({ kind: "mcp", name });
  return options;
}

/** The merged-catalog entry a candidate names, if anything provides it. */
function provided(merged: MergedCatalog, item: BundleItem): MergedSkill | MergedMcp | undefined {
  return item.kind === "skill"
    ? merged.skills.find((skill) => skill.name === item.name)
    : merged.mcps.find((mcp) => mcp.name === item.name);
}

/** How to get an item that exists into the bundle, given what it declares. */
function selectionAdvice(item: BundleItem, scopes: readonly string[]): string {
  const hold = scopes.length === 0 ? undefined : `hold one of its scopes (${scopes.join(", ")})`;
  const name = item.kind === "skill" ? item.name : `${MCP_REQUIREMENT_PREFIX}${item.name}`;
  const otherwise =
    item.kind === "skill"
      ? "list it under `skills`"
      : `have a selected skill \`require\` ${name}`;

  return hold === undefined ? otherwise : `${hold}, or ${otherwise}`;
}

/**
 * The error for an item a catalog provides but nothing selects (spec §6).
 *
 * Names the catalog it came from, so a reader knows the config is otherwise fine, and says which
 * scopes would reach it rather than leaving them to be looked up. Only a catalog can be named here:
 * everything the config declares itself is selected outright, so it is never the unselected one.
 */
function notSelected(
  item: BundleItem,
  entry: MergedSkill | MergedMcp,
  config: ProjectConfig,
): AmbitError {
  return resolutionError(`${subject(item)} is not in the bundle`, [
    `catalog "${entry.catalog}" provides it, but nothing ${config.origin.file} holds selects it`,
    selectionAdvice(item, entry.scopes),
  ]);
}

/** The error for a name nothing provides at all (spec §6). */
function unknownName(name: string, config: ProjectConfig): AmbitError {
  return resolutionError(`unknown skill or MCP server "${name}"`, [
    `nothing configured in ${config.origin.file} provides a skill or a server by that name`,
    "run `ambit catalog` to see what is available",
  ]);
}

/**
 * The bundle item a name asks about.
 *
 * @throws {AmbitError} exit 3 for a name nothing provides, or one nothing selects.
 */
function locate(
  name: string,
  bundle: Bundle,
  merged: MergedCatalog,
  config: ProjectConfig,
): BundleItem {
  const options = candidates(name);

  const selected = options.find((item) => isSelected(bundle, item));
  if (selected !== undefined) return selected;

  for (const item of options) {
    const entry = provided(merged, item);
    if (entry !== undefined) throw notSelected(item, entry, config);
  }

  throw unknownName(name, config);
}

/**
 * The reason as `why` shows it: with the held scope too, when the item declares a different one and
 * the subtree rule did the rest.
 */
function reasonLabel(reason: SelectionReason): string {
  const label = formatReason(reason);
  return reason.kind === "scope" && reason.held !== reason.scope
    ? `${label} (held ${reason.held})`
    : label;
}

function linkJson(link: ReasonedItem): Readonly<Record<string, unknown>> {
  return {
    ...(link.reason.kind === "scope" && { held: link.reason.held }),
    kind: link.kind,
    name: link.name,
    reason: formatReason(link.reason),
  };
}

function toJson(item: BundleItem, chain: readonly ReasonedItem[], reason: SelectionReason) {
  return {
    chain: chain.map(linkJson),
    kind: item.kind,
    name: item.name,
    reason: formatReason(reason),
  };
}

function toText(item: BundleItem, chain: readonly ReasonedItem[]): readonly string[] {
  return [
    `${item.kind} ${item.name}`,
    "",
    ...section(
      "chain",
      chain.map((link) => [link.name, link.kind, reasonLabel(link.reason)]),
    ),
  ];
}

export const whyHandler: CommandHandler = async (ctx) => {
  const [name] = ctx.args;
  if (name === undefined) {
    // Commander enforces the argument, so this is unreachable rather than a user-facing path.
    throw new AmbitError(ExitCode.Internal, "`ambit why` was given no name", [
      "the command takes the name of a skill or an MCP server",
      "run `ambit why <name>`",
    ]);
  }

  const context = sourceContextOf(ctx);
  const config = await loadProjectConfig(context.projectDir);
  const catalogs = mergeCatalogs(await loadCatalogs(config, context));
  const merged = await mergeConfigEntities(catalogs, config, context);
  const bundle = resolveBundle(config, merged);

  const item = locate(name, bundle, merged, config);
  const chain = explainSelection(bundle, item);

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(item, chain, reasonOf(bundle, item)), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(item, chain), ctx.stdout);
  return ExitCode.Success;
};

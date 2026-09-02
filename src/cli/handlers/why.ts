/**
 * `ambit why <kind>:<name>` — explain why one item is in the bundle.
 *
 * Prints the full chain, not just the immediate reason: being told a skill arrived through
 * `required-by:acme-brief` only moves the question up one level. The `requires` entry at the far end
 * is what a reader can actually change.
 *
 * A bundle item is the only valid subject. An `expects` entry is not one: nothing provides an
 * environment variable, so there is no chain to walk. Whether the machine satisfies an expectation is
 * `doctor`'s question.
 *
 * The subject must declare its namespace (`mcp:sentry`); a bare name is refused rather than looked up.
 * This keeps this command and a `requires` entry from disagreeing about what a bare name means:
 * `skill:mcp.sentry` and `mcp:sentry` stay distinct and both askable.
 *
 * A name that resolves to nothing selected is an error, not an empty report, since "not in the
 * bundle" is a resolution answer a script needs to detect. No catalog providing it, versus nothing
 * selecting it, are different problems with different fixes.
 */
import type {
  MergedCatalog,
  MergedHook,
  MergedMcp,
  MergedPack,
  MergedPlugin,
  MergedSkill,
} from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import type { ProjectConfig } from "../../model/config.js";
import { loadProjectConfig } from "../../model/config.js";
import { AmbitError, ExitCode, resolutionError } from "../../errors.js";
import { printSections, section } from "../output.js";
import type {
  Bundle,
  BundleItem,
  ItemKind,
  ReasonedItem,
  SelectionReason,
} from "../../resolution/resolve.js";
import {
  explainSelection,
  formatReason,
  isSelected,
  reasonOf,
  resolveBundle,
} from "../../resolution/resolve.js";
import { REQUIRES_KEY, entryYaml } from "../../model/pattern.js";
import { parseItemSubject } from "../../model/requirement.js";

/** How an item is named in messages, one entry per namespace so a sixth is a type error. */
const SUBJECTS: Readonly<Record<ItemKind, string>> = {
  pack: "pack",
  plugin: "plugin",
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
};

/** The same five with an article, for a sentence that needs one. */
const NOUNS: Readonly<Record<ItemKind, string>> = {
  pack: "a pack",
  plugin: "a plugin",
  skill: "a skill",
  mcp: "an MCP server",
  hook: "a hook",
};

/** How an item is named in messages. */
function subject(item: BundleItem): string {
  return `${SUBJECTS[item.kind]} "${item.name}"`;
}

/**
 * Every merged-catalog entry a candidate names. Several, where more than one catalog provides the
 * name.
 *
 * Returns all of them, not the first: no catalog takes precedence, and naming one copy when two
 * catalogs ship it would leave a reader editing the wrong catalog. Ordered as the merged catalog
 * orders them.
 */
function providers(
  merged: MergedCatalog,
  item: BundleItem,
): readonly (MergedPack | MergedPlugin | MergedSkill | MergedMcp | MergedHook)[] {
  switch (item.kind) {
    case "pack":
      return merged.packs.filter((pack) => pack.name === item.name);
    case "plugin":
      return merged.plugins.filter((plugin) => plugin.name === item.name);
    case "skill":
      return merged.skills.filter((skill) => skill.name === item.name);
    case "mcp":
      return merged.mcps.filter((mcp) => mcp.name === item.name);
    case "hook":
      return merged.hooks.filter((hook) => hook.name === item.name);
  }
}

/**
 * The `requires` entry that would select an item, written out for the reader to paste.
 *
 * By exact name and qualified with the catalog that provides it: that is the one entry guaranteed to
 * select this copy and nothing else. A wildcard could reach other items under the same prefix.
 */
function selectionEntry(item: BundleItem, catalog: string): string {
  return entryYaml({ kind: item.kind, pattern: item.name, catalog });
}

/**
 * The error for an item one or more catalogs provide but nothing selects.
 *
 * Names every catalog it could have come from, so a reader knows the config is otherwise fine, and
 * ends on an entry they can paste.
 *
 * The advice is one entry, on the first providing catalog in merged order. There's only one route
 * into a bundle: a pack, a hook, and a server are addressable exactly as a skill is.
 *
 * The entry names the item directly. That's always a valid answer, though not always the one the
 * catalog intends (an item a pack already covers is more naturally taken by requiring the pack).
 * Finding that pack would mean searching every pack's `requires` for a match, so the direct entry is
 * offered instead; `ambit search --capability pack "*"` is where to look for packs.
 */
function notSelected(
  item: BundleItem,
  entries: readonly (MergedPack | MergedPlugin | MergedSkill | MergedMcp | MergedHook)[],
  config: ProjectConfig,
): AmbitError {
  const names = entries.map((entry) => `"${entry.catalog}"`).join(", ");
  const provided =
    entries.length === 1 ? `catalog ${names} provides it` : `catalogs ${names} provide it`;

  return resolutionError(`${subject(item)} is not in the bundle`, [
    `${provided}, but no \`${REQUIRES_KEY}\` entry in ${config.origin.file} selects it`,
    `select it with \`${selectionEntry(item, entries[0]!.catalog)}\``,
  ]);
}

/** The error for a reference nothing provides at all. Names the specific namespace asked for. */
function unknownName(item: BundleItem, config: ProjectConfig): AmbitError {
  return resolutionError(`unknown ${subject(item)}`, [
    `nothing configured in ${config.origin.file} provides ${NOUNS[item.kind]} by that name`,
    // Wrapped in wildcards since the likely cause is a name remembered slightly wrong.
    `run \`ambit search --capability ${item.kind} "*${item.name}*"\` to see what is available`,
  ]);
}

/**
 * The bundle item the subject names.
 *
 * Taken at its word and never looked up: `mcp:sentry` is the server whether or not a skill of that
 * name exists, so naming the wrong namespace is a miss, not a search that wanders into the right one.
 *
 * @throws {AmbitError} exit 2 for a subject naming no namespace; exit 3 for one nothing provides, or
 *   one nothing selects.
 */
function locate(
  name: string,
  bundle: Bundle,
  merged: MergedCatalog,
  config: ProjectConfig,
): BundleItem {
  const item = parseItemSubject(name, `\`why ${name}\` does not say what to explain`);
  if (isSelected(bundle, item)) return item;

  const entries = providers(merged, item);
  if (entries.length === 0) throw unknownName(item, config);
  throw notSelected(item, entries, config);
}

function linkJson(link: ReasonedItem): Readonly<Record<string, unknown>> {
  return {
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
      chain.map((link) => [link.name, link.kind, formatReason(link.reason)]),
    ),
  ];
}

export const whyHandler: CommandHandler = async (ctx) => {
  const [name] = ctx.args;
  if (name === undefined) {
    // Commander enforces the argument, so this is unreachable rather than a user-facing path.
    throw new AmbitError(ExitCode.Internal, "`ambit why` was given no name", [
      "the command takes the name of a pack, a plugin, a skill, an MCP server, or a hook",
      "run `ambit why <kind>:<name>`",
    ]);
  }

  const context = sourceContextOf(ctx);
  const config = await loadProjectConfig(context.projectDir);
  const merged = mergeCatalogs(await loadCatalogs(config, context));
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

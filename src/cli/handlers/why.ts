/**
 * `ambit why <kind>:<name>` — explain why one item is in the bundle.
 *
 * The chain is the answer, not the reason on its own: being told a skill arrived through
 * `required-by:acme-brief` only moves the question one level up, and it is the `requires` entry at
 * the far end that a reader can actually change. So this prints every link from the root cause down
 * to the item asked about.
 *
 * A bundle item is the only subject. An `expects` entry is not one: nothing provides an environment
 * variable, so there is no chain to walk and no selection to explain, and the question of whether the
 * machine satisfies one is `doctor`'s.
 *
 * The subject declares its namespace — `mcp:sentry` — the way a `requires` entry does, and a bare name
 * is refused rather than looked up. Nothing here reads a meaning out of the string, so this command and
 * a `requires` entry cannot end up disagreeing about what `mcp.sentry` names, which is exactly what a
 * prefix convention made them do. The extra keystrokes buy the question always having one answer:
 * `skill:mcp.sentry` and `mcp:sentry` are different things, and both are askable.
 *
 * A name that resolves to nothing selected is an error rather than an empty report: "not in the
 * bundle" is a resolution answer a script has to be able to detect, and the two ways of getting
 * there — no catalog provides it, or nothing selects it — call for different fixes.
 */
import type { MergedCatalog, MergedHook, MergedMcp, MergedSkill } from "../../model/catalog.js";
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
import { CAPABILITY_OF_KIND, REQUIRES_KEY, entryYaml } from "../../model/pattern.js";
import { parseSubject } from "../../model/reference.js";
import { ITEM_REFERENCE } from "../../model/requirement.js";

/** How an item is named in messages, one entry per namespace so a fourth is a type error. */
const SUBJECTS: Readonly<Record<ItemKind, string>> = {
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
};

/** The same three with an article, for a sentence that needs one. */
const NOUNS: Readonly<Record<ItemKind, string>> = {
  skill: "a skill",
  mcp: "an MCP server",
  hook: "a hook",
};

/** How an item is named in messages. */
function subject(item: BundleItem): string {
  return `${SUBJECTS[item.kind]} "${item.name}"`;
}

/**
 * Every merged-catalog entry a candidate names — several, where more than one catalog provides the
 * name.
 *
 * All of them rather than the first, because there is no first: no catalog takes precedence, and an
 * answer naming one copy of a name two catalogs ship would leave a reader editing the wrong catalog.
 * In the merged catalog's order, so the answer is a function of the names alone.
 */
function providers(
  merged: MergedCatalog,
  item: BundleItem,
): readonly (MergedSkill | MergedMcp | MergedHook)[] {
  switch (item.kind) {
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
 * By exact name and qualified with the catalog that provides it, because that is the one entry
 * guaranteed to select this copy and nothing else: a tag entry would reach every other item carrying
 * the label, and an unqualified address is not a spelling a project config has.
 *
 * One entry for one namespace, since `capabilities` is not defaulted — the item's own kind is the
 * only member that could belong there.
 */
function selectionEntry(item: BundleItem, catalog: string): string {
  return entryYaml({
    field: "name",
    pattern: item.name,
    catalog,
    capabilities: [CAPABILITY_OF_KIND[item.kind]],
  });
}

/**
 * The error for an item one or more catalogs provide but nothing selects.
 *
 * Names every catalog it could have come from, so a reader knows the config is otherwise fine, and
 * says which tags would reach it rather than leaving them to be looked up.
 *
 * The advice is one entry, on the first providing catalog in merged order. There is only one route
 * into a bundle now, so there is no second suggestion to make: a hook and a server are addressable
 * exactly as a skill is, which is what folding the explicit list into `requires` bought.
 *
 * The tags are the union across the copies, since an entry on any one of them selects at least one
 * copy — and if it selects two, the collision refusal at resolve is the better message for that.
 */
function notSelected(
  item: BundleItem,
  entries: readonly (MergedSkill | MergedMcp | MergedHook)[],
  config: ProjectConfig,
): AmbitError {
  const names = entries.map((entry) => `"${entry.catalog}"`).join(", ");
  const provided =
    entries.length === 1 ? `catalog ${names} provides it` : `catalogs ${names} provide it`;
  const tags = [...new Set(entries.flatMap((entry) => entry.tags))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  return resolutionError(`${subject(item)} is not in the bundle`, [
    `${provided}, but no \`${REQUIRES_KEY}\` entry in ${config.origin.file} selects it`,
    ...(tags.length === 0 ? [] : [`it declares tags: ${tags.join(", ")}`]),
    `select it with \`${selectionEntry(item, entries[0]!.catalog)}\``,
  ]);
}

/**
 * The error for a reference nothing provides at all.
 *
 * The namespace is named rather than hedged over all three — this message used to open "unknown skill,
 * MCP server or hook" precisely because it did not know which the reader meant, and now it does.
 */
function unknownName(item: BundleItem, config: ProjectConfig): AmbitError {
  return resolutionError(`unknown ${subject(item)}`, [
    `nothing configured in ${config.origin.file} provides ${NOUNS[item.kind]} by that name`,
    "run `ambit dump-catalog` to see what is available",
  ]);
}

/**
 * The bundle item the subject names.
 *
 * Taken at its word and never looked up: `mcp:sentry` is the server whether or not a skill of that
 * name exists, so naming the wrong namespace is a miss rather than a search that wanders into the
 * right one. That is what makes the ambiguous catalog — a skill `mcp.sentry` beside an entity
 * `sentry` — a pair of ordinary questions rather than a coin toss.
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
  const item = parseSubject<ItemKind>(
    ITEM_REFERENCE,
    name,
    `\`why ${name}\` does not say what to explain`,
  );
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
      "the command takes the name of a skill, an MCP server, or a hook",
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

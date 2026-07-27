/**
 * `ambit why <name>` — explain why one item is in the bundle.
 *
 * The chain is the answer, not the reason on its own: being told a skill arrived through
 * `required-by:acme-brief` only moves the question one level up, and it is the held scope at the
 * far end that a reader can actually change. So this prints every link from the root cause down to
 * the item asked about.
 *
 * The subject is either a `<kind>:<name>` reference — `mcp:sentry` — or a bare name, which is
 * **looked up** across the three namespaces and refused when more than one of them holds it. That is a
 * search, not a reading of the string: nothing here decides what `mcp.sentry` means, so this command
 * and a `requires` entry cannot end up disagreeing about it, which is exactly what a prefix convention
 * made them do. The bare form exists because a name is copied here out of a report that printed it
 * bare, and the reference is what makes the ambiguous case expressible rather than merely refused.
 *
 * A name that resolves to nothing selected is an error rather than an empty report: "not in the
 * bundle" is a resolution answer a script has to be able to detect, and the two ways of getting
 * there — no catalog provides it, or nothing selects it — call for different fixes.
 */
import type { MergedCatalog, MergedHook, MergedMcp, MergedSkill } from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../../model/catalog.js";
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
import {
  ITEM_KINDS,
  formatRequirement,
  isRequirementReference,
  parseRequirement,
  requirementYaml,
} from "../../model/requirement.js";

/** How an item is named in messages, one entry per namespace so a fourth is a type error. */
const SUBJECTS: Readonly<Record<ItemKind, string>> = {
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
};

/** How an item is named in messages. */
function subject(item: BundleItem): string {
  return `${SUBJECTS[item.kind]} "${item.name}"`;
}

/**
 * What a bare name could mean: one candidate per namespace, in {@link ITEM_KINDS} order.
 *
 * No precedence between them, deliberately. Every candidate is checked against what the merged catalog
 * actually provides, and two survivors are an ambiguity this refuses ({@link ambiguousName}) rather
 * than resolves — a name two namespaces hold is a question with two true answers, and picking one
 * silently is how a bare `mcp.sentry` used to reach a server while naming a skill.
 */
function candidates(name: string): readonly BundleItem[] {
  return ITEM_KINDS.map((kind) => ({ kind, name }));
}

/** The merged-catalog entry a candidate names, if anything provides it. */
function provided(
  merged: MergedCatalog,
  item: BundleItem,
): MergedSkill | MergedMcp | MergedHook | undefined {
  switch (item.kind) {
    case "skill":
      return merged.skills.find((skill) => skill.name === item.name);
    case "mcp":
      return merged.mcps.find((mcp) => mcp.name === item.name);
    case "hook":
      return merged.hooks.find((hook) => hook.name === item.name);
  }
}

/** How to get an item that exists into the bundle, given what it declares. */
function selectionAdvice(item: BundleItem, scopes: readonly string[]): string {
  const hold = scopes.length === 0 ? undefined : `hold one of its scopes (${scopes.join(", ")})`;
  // A skill is the one namespace a project can name outright in a way resolution reaches by name;
  // a server and a hook a *catalog* provides are reached by a scope or by a `requires` edge.
  const otherwise =
    item.kind === "skill"
      ? "list it under `skills`"
      : `have a selected skill require it, with \`${requirementYaml(item)}\``;

  return hold === undefined ? otherwise : `${hold}, or ${otherwise}`;
}

/**
 * The error for an item a catalog provides but nothing selects.
 *
 * Names the catalog it came from, so a reader knows the config is otherwise fine, and says which
 * scopes would reach it rather than leaving them to be looked up. Only a catalog can be named here:
 * everything the config declares itself is selected outright, so it is never the unselected one.
 */
function notSelected(
  item: BundleItem,
  entry: MergedSkill | MergedMcp | MergedHook,
  config: ProjectConfig,
): AmbitError {
  return resolutionError(`${subject(item)} is not in the bundle`, [
    `catalog "${entry.catalog}" provides it, but nothing ${config.origin.file} holds selects it`,
    selectionAdvice(item, entry.scopes),
  ]);
}

/** The error for a name nothing provides at all. */
function unknownName(name: string, config: ProjectConfig): AmbitError {
  return resolutionError(`unknown skill, MCP server or hook "${name}"`, [
    `nothing configured in ${config.origin.file} provides a skill, a server or a hook by that name`,
    "run `ambit dump-catalog` to see what is available",
  ]);
}

/**
 * The error for a bare name more than one namespace holds.
 *
 * Refused rather than ranked. Two namespaces answering to one name is a legitimate catalog — they are
 * independent — so "which did you mean" has no answer this command can supply, and the one it used to
 * supply was a precedence rule that made `ambit why` and a `requires` entry read the same string two
 * different ways. Every reading is offered instead, spelled the way the command accepts it.
 */
function ambiguousName(name: string, options: readonly BundleItem[]): AmbitError {
  return resolutionError(`"${name}" names ${options.length} things`, [
    `${options.map((item) => `${SUBJECTS[item.kind]} "${item.name}"`).join(", ")} — the namespaces are independent, so a bare name reaches all of them`,
    `say which: ${options.map((item) => `\`ambit why ${formatRequirement(item)}\``).join(", ")}`,
  ]);
}

/**
 * The bundle item a name asks about: the reference it spells, or the one thing a bare name finds.
 *
 * A reference is taken at its word and never looked up — `mcp:sentry` is the server whether or not a
 * skill of that name exists — which is what makes every ambiguity expressible. A bare name is resolved
 * against what the merged catalog provides, so the question it answers is "which of these exists?"
 * rather than "what does this string look like?".
 *
 * @throws {AmbitError} exit 2 for a reference naming no namespace; exit 3 for a name nothing provides,
 *   one two namespaces hold, or one nothing selects.
 */
function locate(
  name: string,
  bundle: Bundle,
  merged: MergedCatalog,
  config: ProjectConfig,
): BundleItem {
  if (isRequirementReference(name)) {
    const item = parseRequirement(name);
    if (isSelected(bundle, item)) return item;

    const entry = provided(merged, item);
    if (entry === undefined) throw unknownName(name, config);
    throw notSelected(item, entry, config);
  }

  const options = candidates(name).filter((item) => provided(merged, item) !== undefined);
  if (options.length === 0) throw unknownName(name, config);
  if (options.length > 1) throw ambiguousName(name, options);

  const item = options[0]!;
  if (isSelected(bundle, item)) return item;
  throw notSelected(item, provided(merged, item)!, config);
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
      "the command takes the name of a skill, an MCP server, or a hook",
      "run `ambit why <name>`, or `ambit why <kind>:<name>` to name one namespace",
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

/**
 * `ambit why <kind>:<name>` — explain why one item is in the bundle.
 *
 * The chain is the answer, not the reason on its own: being told a skill arrived through
 * `required-by:acme-brief` only moves the question one level up, and it is the held scope at the
 * far end that a reader can actually change. So this prints every link from the root cause down to
 * the item asked about.
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
import { parseSubject } from "../../model/reference.js";
import { REQUIRES, requirementYaml } from "../../model/requirement.js";

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
    REQUIRES,
    name,
    `\`why ${name}\` does not say what to explain`,
  );
  if (isSelected(bundle, item)) return item;

  const entry = provided(merged, item);
  if (entry === undefined) throw unknownName(item, config);
  throw notSelected(item, entry, config);
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
      "run `ambit why <kind>:<name>`",
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

/**
 * `ambit search <pattern>` — search the merged catalog.
 *
 * A consumer command, and named as one. Its subject is a *project*: the merged view is what several
 * catalogs and one `ambit.yml` add up to, which no catalog directory holds on its own. It spent its
 * first life as `ambit catalog` — the default action of the group that also maintains a catalog —
 * where it was the one command under that word reading `ambit.yml` while every other read a catalog
 * root, and then as `ambit dump-catalog`, which named the *implementation* (a dump) after a noun that
 * is plural in every real project. What a reader wants from this command is one item they half
 * remember, so the name is the question and the filters are how it is narrowed.
 *
 * This is still the window onto everything resolution works from, so it prints what was parsed rather
 * than a summary of it, and `ambit search "*"` is the whole merged catalog. `--json` output carries no
 * absolute paths and emits every record in the merged catalog's own order — by name, then by
 * catalog — so it is comparable between machines and stable enough to commit as a golden file.
 *
 * Each JSON record is keyed by an item's **address** — `<catalog>/<name>` — and not by its name,
 * because a name is not unique in this view: two catalogs may both provide `house-style`, both copies
 * are here, and a name-keyed record would silently drop one of them. That is exactly the loss the
 * merge stopped performing, so the window onto it must not reintroduce it. The text form needs no
 * such thing: it already prints one row per copy with the catalog in its own column.
 *
 * **Three filters, and the pattern is one of them.** `<pattern>` matches names, `--capability` picks
 * namespaces, `--catalog` picks catalogs. Repeating one flag widens (`--catalog a --catalog b` is
 * *either*), and different flags narrow (a skill in neither catalog is not a result). That is the
 * only combination a person means by typing both, and stating it here is cheaper than a reader
 * inferring it from the loop.
 *
 * **A pattern matching nothing is exit 0**, which is the opposite of what the same pattern means in a
 * `requires` entry. The two are asking different questions: a requirement that reaches nothing is a
 * config that will not do what it says, while a search that finds nothing is the answer to the search.
 */
import type {
  Catalog,
  MergedCatalog,
  MergedHook,
  MergedMcp,
  MergedPack,
  MergedSkill,
} from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs, qualifiedName } from "../../model/catalog.js";
import type { CommandContext, CommandHandler } from "../commands.js";
import { jsonRequested, listOf, sourceContextOf } from "../commands.js";
import { CONFIG_FILENAMES, loadProjectConfig } from "../../model/config.js";
import { ExitCode, configError } from "../../errors.js";
import type { McpTransport } from "../../model/mcp-entity.js";
import type { PatternEntry } from "../../model/pattern.js";
import { matchesPattern } from "../../model/pattern.js";
import type { ItemKind } from "../../model/requirement.js";
import { ITEM_KINDS } from "../../model/requirement.js";
import { keyed, printSections, section } from "../output.js";

/** Stands in for a description an item does not declare. */
const UNDESCRIBED = "-";

/**
 * A `requires` list as a record carries it: the namespace and the pattern kept apart, as the document
 * writes them.
 *
 * No `catalog` key, because a catalog's own entry carries no qualifier — it resolves within the
 * catalog the record is already keyed by.
 */
function requiresJson(
  requires: readonly PatternEntry[],
): readonly Readonly<Record<string, unknown>>[] {
  return requires.map((entry) => ({ kind: entry.kind, pattern: entry.pattern }));
}

/**
 * One pack: what it is for, and what asking for it gets you.
 *
 * This is the record that makes a pack worth being a document. The grouping it replaced was a
 * free-form label, so this view could only ever have listed which strings an item happened to carry;
 * a pack has a description and an enumerable membership, and both are here.
 */
function packJson(pack: MergedPack): Readonly<Record<string, unknown>> {
  return {
    catalog: pack.catalog,
    ...(pack.description !== undefined && { description: pack.description }),
    requires: requiresJson(pack.requires),
  };
}

function transportJson(transport: McpTransport): Readonly<Record<string, unknown>> {
  switch (transport.kind) {
    case "stdio":
      return { args: transport.args, command: transport.command, kind: transport.kind };
    case "http":
      return { headers: transport.headers, kind: transport.kind, url: transport.url };
  }
}

function skillJson(skill: MergedSkill): Readonly<Record<string, unknown>> {
  return {
    catalog: skill.catalog,
    ...(skill.description !== undefined && { description: skill.description }),
    expects: skill.expects.map((item) => ({ kind: item.kind, name: item.name })),
    path: skill.path,
    requires: requiresJson(skill.requires),
  };
}

function mcpJson(mcp: MergedMcp): Readonly<Record<string, unknown>> {
  return {
    catalog: mcp.catalog,
    expects: mcp.expects.map((item) => ({ kind: item.kind, name: item.name })),
    transport: transportJson(mcp.transport),
  };
}

/**
 * One hook, including the one fact a reader cannot see in the document: which catalog provided it.
 */
function hookJson(hook: MergedHook): Readonly<Record<string, unknown>> {
  return {
    catalog: hook.catalog,
    command: hook.command,
    ...(hook.description !== undefined && { description: hook.description }),
    event: hook.event,
    expects: hook.expects.map((item) => ({ kind: item.kind, name: item.name })),
    ...(hook.matcher !== undefined && { matcher: hook.matcher }),
    path: hook.path,
    ...(hook.timeout !== undefined && { timeout: hook.timeout }),
    type: hook.type,
  };
}

function toJson(merged: MergedCatalog): Readonly<Record<string, unknown>> {
  return {
    catalogs: merged.catalogs,
    hooks: keyed(merged.hooks, qualifiedName, hookJson),
    mcps: keyed(merged.mcps, qualifiedName, mcpJson),
    packs: keyed(merged.packs, qualifiedName, packJson),
    skills: keyed(merged.skills, qualifiedName, skillJson),
  };
}

function transportSummary(transport: McpTransport): string {
  switch (transport.kind) {
    case "stdio":
      return `stdio: ${[transport.command, ...transport.args].join(" ")}`;
    case "http":
      return `http: ${transport.url}`;
  }
}

/** What the hook runs, and — for a shipped script — that it is one, since the name alone cannot say. */
function commandSummary(hook: MergedHook): string {
  return hook.type === "script" ? `${hook.command} (shipped)` : hook.command;
}

/**
 * The three filters, already checked against the project, in the form the walk below wants them.
 *
 * A filter absent from the command line is an empty set rather than a set holding everything, and
 * every test is `set.size === 0 || set.has(x)`. The alternative — expanding an absent `--capability`
 * into all four kinds — reads the same for one run and lies for the next: it makes *asked for
 * nothing* and *asked for all four* indistinguishable, and the only place that matters is the one
 * place it would be checked.
 */
interface SearchFilter {
  /** The glob every result's name must match. Always present: the pattern is a required argument. */
  readonly pattern: string;
  /** Which namespaces to search. Empty means every one of them. */
  readonly capabilities: ReadonlySet<ItemKind>;
  /** Which catalogs to search. Empty means every one of them. */
  readonly catalogs: ReadonlySet<string>;
}

/**
 * The filters as the command line gave them, with every `--catalog` checked against what the project
 * actually lists.
 *
 * An unknown catalog alias is exit 2 rather than an empty result, and this is the one place in the
 * command where nothing-found is an error. The difference is what a reader can act on: a pattern
 * matching nothing has the pattern to look at, while `--catalog acme` when the config spells it
 * `acme-core` produces an empty listing that looks exactly like a catalog with no matching items.
 * So the flag that names a thing is checked, and the flag that describes a thing is not.
 *
 * @throws {AmbitError} exit 2 when a `--catalog` names no catalog in `ambit.yml`.
 */
function filterOf(ctx: CommandContext, configured: readonly string[]): SearchFilter {
  const requested = listOf(ctx, "catalog");
  const unknown = requested.filter((name) => !configured.includes(name));
  if (unknown.length > 0) {
    throw configError(
      `no catalog named "${unknown[0]}" (${CONFIG_FILENAMES[0]})`,
      configured.length === 0
        ? [
            `${CONFIG_FILENAMES[0]} lists no catalogs`,
            "add one under `catalogs:`, or drop --catalog",
          ]
        : [
            `this project lists: ${configured.join(", ")}`,
            "name one of those, or drop --catalog to search every catalog",
          ],
    );
  }

  // Filtered out of `ITEM_KINDS` rather than built from what was typed, so the set is `ItemKind`
  // without a cast — the CLI already refuses a value that is not one of the four.
  const capabilities = listOf(ctx, "capability");
  return {
    pattern: ctx.args[0] ?? "",
    capabilities: new Set(ITEM_KINDS.filter((kind) => capabilities.includes(kind))),
    catalogs: new Set(requested),
  };
}

/** Whether this namespace was asked for. Empty means every one of them — see {@link SearchFilter}. */
function wants(filter: SearchFilter, kind: ItemKind): boolean {
  return filter.capabilities.size === 0 || filter.capabilities.has(kind);
}

/**
 * The items of one namespace that survive the pattern and the `--catalog` filter.
 *
 * The `--capability` filter is not applied here: it decides whether a *section* is printed at all,
 * which is a question about the report rather than about any item, and applying it per item would
 * leave `--capability skill` printing three empty sections it was told not to show.
 */
function matching<T extends { readonly name: string; readonly catalog: string }>(
  items: readonly T[],
  filter: SearchFilter,
): readonly T[] {
  return items.filter(
    (item) =>
      matchesPattern(filter.pattern, item.name) &&
      (filter.catalogs.size === 0 || filter.catalogs.has(item.catalog)),
  );
}

/**
 * The merged catalog narrowed to what the filters asked for.
 *
 * A namespace `--capability` excluded becomes empty here rather than absent, so both output modes
 * take the same shape from the same value: the text form asks {@link wants} which sections to print,
 * and the JSON form emits all four keys whatever was asked for, so a script reading `.skills` never
 * has to check whether the key exists.
 */
function narrow(merged: MergedCatalog, filter: SearchFilter): MergedCatalog {
  return {
    catalogs:
      filter.catalogs.size === 0
        ? merged.catalogs
        : merged.catalogs.filter((name) => filter.catalogs.has(name)),
    packs: wants(filter, "pack") ? matching(merged.packs, filter) : [],
    skills: wants(filter, "skill") ? matching(merged.skills, filter) : [],
    mcps: wants(filter, "mcp") ? matching(merged.mcps, filter) : [],
    hooks: wants(filter, "hook") ? matching(merged.hooks, filter) : [],
  };
}

function toText(
  catalogs: readonly Catalog[],
  merged: MergedCatalog,
  filter: SearchFilter,
): readonly string[] {
  // The catalogs actually searched, so the header answers "where did I just look" rather than
  // "what does this project list" — the two differ exactly when `--catalog` was given.
  const searched = catalogs.filter(
    (catalog) => filter.catalogs.size === 0 || filter.catalogs.has(catalog.name),
  );
  const heading =
    searched.length === 0
      ? ["no catalogs configured", ""]
      : [...searched.map((catalog) => `${catalog.name}  ${catalog.source}`), ""];

  return [
    ...heading,
    // Packs first, and carrying their descriptions, because this is the section a person browsing a
    // catalog is actually reading: it is the list of things there are names for.
    ...(wants(filter, "pack")
      ? section(
          "packs",
          merged.packs.map((pack) => [pack.name, pack.catalog, pack.description ?? UNDESCRIBED]),
        )
      : []),
    ...(wants(filter, "skill")
      ? section(
          "skills",
          merged.skills.map((skill) => [skill.name, skill.catalog]),
        )
      : []),
    ...(wants(filter, "mcp")
      ? section(
          "mcps",
          merged.mcps.map((mcp) => [mcp.name, mcp.catalog, transportSummary(mcp.transport)]),
        )
      : []),
    ...(wants(filter, "hook")
      ? section(
          "hooks",
          merged.hooks.map((hook) => [hook.name, hook.catalog, hook.event, commandSummary(hook)]),
        )
      : []),
  ];
}

export const searchHandler: CommandHandler = async (ctx) => {
  const context = sourceContextOf(ctx);
  const config = await loadProjectConfig(context.projectDir);
  const catalogs = await loadCatalogs(config, context);
  const merged = mergeCatalogs(catalogs);
  const filter = filterOf(ctx, merged.catalogs);
  const found = narrow(merged, filter);

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(found), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(catalogs, found, filter), ctx.stdout);
  return ExitCode.Success;
};

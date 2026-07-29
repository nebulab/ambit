/**
 * `ambit dump-catalog` — dump the merged catalog.
 *
 * A consumer command, and named as one. Its subject is a *project*: the merged view is what several
 * catalogs and one `ambit.yml` add up to, which no catalog directory holds on its own. It spent its
 * first life as `ambit catalog` — the default action of the group that also maintains a catalog —
 * where it was the one command under that word reading `ambit.yml` while every other read a catalog
 * root. Two subjects under one noun is a confusion the name now avoids rather than documents.
 *
 * This is the window onto everything resolution works from, so it prints what was parsed rather
 * than a summary of it. `--json` output carries no absolute paths and emits every record in the
 * merged catalog's own order — by name, then by catalog — so it is comparable between machines and
 * stable enough to commit as a golden file.
 *
 * Each JSON record is keyed by an item's **address** — `<catalog>/<name>` — and not by its name,
 * because a name is not unique in this view: two catalogs may both provide `house-style`, both copies
 * are here, and a name-keyed record would silently drop one of them. That is exactly the loss the
 * merge stopped performing, so the window onto it must not reintroduce it. The text form needs no
 * such thing: it already prints one row per copy with the catalog in its own column.
 */
import type {
  Catalog,
  MergedCatalog,
  MergedHook,
  MergedMcp,
  MergedSkill,
} from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs, qualifiedName } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { loadProjectConfig } from "../../model/config.js";
import { ExitCode } from "../../errors.js";
import type { McpTransport } from "../../model/mcp-entity.js";
import { keyed, printSections, section } from "../output.js";

/** Stands in for an empty tag list, which means no `tag:` entry can reach the item. */
const UNTAGGED = "-";

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
    // Each entry keeps its two halves apart, as the document writes them: a consumer filtering for
    // what a skill pulls in should not have to re-derive a namespace from a name.
    requires: skill.requires.map((item) => ({ kind: item.kind, name: item.name })),
    tags: skill.tags,
  };
}

function mcpJson(mcp: MergedMcp): Readonly<Record<string, unknown>> {
  return {
    catalog: mcp.catalog,
    expects: mcp.expects.map((item) => ({ kind: item.kind, name: item.name })),
    tags: mcp.tags,
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
    tags: hook.tags,
    ...(hook.timeout !== undefined && { timeout: hook.timeout }),
    type: hook.type,
  };
}

function toJson(merged: MergedCatalog): Readonly<Record<string, unknown>> {
  return {
    catalogs: merged.catalogs,
    hooks: keyed(merged.hooks, qualifiedName, hookJson),
    mcps: keyed(merged.mcps, qualifiedName, mcpJson),
    skills: keyed(merged.skills, qualifiedName, skillJson),
  };
}

function tagList(tags: readonly string[]): string {
  return tags.length === 0 ? UNTAGGED : [...tags].join(", ");
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

function toText(catalogs: readonly Catalog[], merged: MergedCatalog): readonly string[] {
  const heading =
    catalogs.length === 0
      ? ["no catalogs configured", ""]
      : [...catalogs.map((catalog) => `${catalog.name}  ${catalog.source}`), ""];

  return [
    ...heading,
    ...section(
      "skills",
      merged.skills.map((skill) => [skill.name, skill.catalog, tagList(skill.tags)]),
    ),
    ...section(
      "mcps",
      merged.mcps.map((mcp) => [
        mcp.name,
        mcp.catalog,
        tagList(mcp.tags),
        transportSummary(mcp.transport),
      ]),
    ),
    ...section(
      "hooks",
      merged.hooks.map((hook) => [
        hook.name,
        hook.catalog,
        tagList(hook.tags),
        hook.event,
        commandSummary(hook),
      ]),
    ),
  ];
}

export const dumpCatalogHandler: CommandHandler = async (ctx) => {
  const context = sourceContextOf(ctx);
  const config = await loadProjectConfig(context.projectDir);
  const catalogs = await loadCatalogs(config, context);
  const merged = mergeCatalogs(catalogs);

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(merged), null, 2));
    return ExitCode.Success;
  }

  printSections(toText(catalogs, merged), ctx.stdout);
  return ExitCode.Success;
};

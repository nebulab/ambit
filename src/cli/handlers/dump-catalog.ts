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
 * than a summary of it. `--json` output carries no absolute paths and sorts every key, so it is
 * comparable between machines and stable enough to commit as a golden file.
 */
import type {
  Catalog,
  MergedCatalog,
  MergedHook,
  MergedMcp,
  MergedSkill,
  ScopeDefinition,
} from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { loadProjectConfig } from "../../model/config.js";
import { ExitCode } from "../../errors.js";
import type { McpTransport } from "../../model/mcp-entity.js";
import { keyed, printSections, section } from "../output.js";

/** Stands in for an empty scope list, which means "not selectable by scope". */
const UNSCOPED = "-";

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
    env: skill.env,
    path: skill.path,
    // Each entry keeps its two halves apart, as the document writes them: a consumer filtering for
    // what a skill pulls in should not have to re-derive a namespace from a name.
    requires: skill.requires.map((item) => ({ kind: item.kind, name: item.name })),
    scopes: skill.scopes,
  };
}

function mcpJson(mcp: MergedMcp): Readonly<Record<string, unknown>> {
  return {
    catalog: mcp.catalog,
    env: mcp.env,
    scopes: mcp.scopes,
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
    env: hook.env,
    event: hook.event,
    ...(hook.matcher !== undefined && { matcher: hook.matcher }),
    ...(hook.path !== undefined && { path: hook.path }),
    scopes: hook.scopes,
    ...(hook.timeout !== undefined && { timeout: hook.timeout }),
    type: hook.type,
  };
}

function toJson(merged: MergedCatalog): Readonly<Record<string, unknown>> {
  return {
    catalogs: merged.catalogs,
    hooks: keyed(merged.hooks, (hook) => hook.name, hookJson),
    mcps: keyed(merged.mcps, (mcp) => mcp.name, mcpJson),
    scopes: keyed(
      merged.scopes,
      (scope) => scope.name,
      (scope) => ({
        description: scope.description,
      }),
    ),
    skills: keyed(merged.skills, (skill) => skill.name, skillJson),
  };
}

function scopeList(scopes: readonly string[]): string {
  return scopes.length === 0 ? UNSCOPED : [...scopes].join(", ");
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
      "scopes",
      merged.scopes.map((scope: ScopeDefinition) => [scope.name, scope.description]),
    ),
    ...section(
      "skills",
      merged.skills.map((skill) => [skill.name, skill.catalog, scopeList(skill.scopes)]),
    ),
    ...section(
      "mcps",
      merged.mcps.map((mcp) => [
        mcp.name,
        mcp.catalog,
        scopeList(mcp.scopes),
        transportSummary(mcp.transport),
      ]),
    ),
    ...section(
      "hooks",
      merged.hooks.map((hook) => [
        hook.name,
        hook.catalog,
        scopeList(hook.scopes),
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

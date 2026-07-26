/**
 * `ambit catalog dump` — dump the merged catalog (spec §6), and the default action of the `catalog`
 * group, so bare `ambit catalog` is this command rather than a second rendering of it.
 *
 * It is the one command under `catalog` that reads a *project*: the merged view is what several
 * catalogs and one `ambit.yml` add up to, which no catalog directory holds on its own. Everything else
 * in the group maintains a single catalog and takes `--catalog <dir>` instead.
 *
 * This is the window onto everything resolution works from, so it prints what was parsed rather
 * than a summary of it. `--json` output carries no absolute paths and sorts every key, so it is
 * comparable between machines and stable enough to commit as a golden file.
 */
import type { Catalog, MergedCatalog, MergedMcp, MergedSkill, ScopeDefinition } from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { loadProjectConfig } from "../../model/config.js";
import { ExitCode } from "../../errors.js";
import type { McpTransport } from "../../model/mcp-entity.js";
import { keyed, printSections, section } from "../output.js";

/** Stands in for an empty scope list, which means "not selectable by scope" (spec §3.2). */
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
    requires: skill.requires,
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

function toJson(merged: MergedCatalog): Readonly<Record<string, unknown>> {
  return {
    catalogs: merged.catalogs,
    mcps: keyed(merged.mcps, (mcp) => mcp.name, mcpJson),
    scopes: keyed(merged.scopes, (scope) => scope.name, (scope) => ({
      description: scope.description,
    })),
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
  ];
}

export const catalogHandler: CommandHandler = async (ctx) => {
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

/**
 * `ambit catalog` — dump the merged catalog (spec §6).
 *
 * This is the window onto everything resolution works from, so it prints what was parsed rather
 * than a summary of it. `--json` output carries no absolute paths and sorts every key, so it is
 * comparable between machines and stable enough to commit as a golden file.
 */
import type { Catalog, MergedCatalog, MergedMcp, MergedSkill, ScopeDefinition } from "../catalog.js";
import { loadCatalogs, mergeCatalogs } from "../catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, projectDirOf } from "../commands.js";
import { loadProjectConfig } from "../config.js";
import { ExitCode } from "../errors.js";
import type { McpTransport } from "../mcp.js";

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

/** Keys in the order given, so the emitted JSON is byte-stable. */
function keyed<T>(
  items: readonly T[],
  name: (item: T) => string,
  value: (item: T) => unknown,
): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  for (const item of items) record[name(item)] = value(item);
  return record;
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

/** Pads every column but the last, so the eye can run down a section. */
function columns(rows: readonly (readonly string[])[]): readonly string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
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

function section(title: string, count: number, rows: readonly (readonly string[])[]): readonly string[] {
  const body = count === 0 ? ["(none)"] : columns(rows);
  return [`${title} (${count})`, ...body.map((line) => `  ${line}`), ""];
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
      merged.scopes.length,
      merged.scopes.map((scope: ScopeDefinition) => [scope.name, scope.description]),
    ),
    ...section(
      "skills",
      merged.skills.length,
      merged.skills.map((skill) => [skill.name, skill.catalog, scopeList(skill.scopes)]),
    ),
    ...section(
      "mcps",
      merged.mcps.length,
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
  const projectDir = projectDirOf(ctx);
  const config = await loadProjectConfig(projectDir);
  const catalogs = await loadCatalogs(config, projectDir);
  const merged = mergeCatalogs(catalogs);

  if (jsonRequested(ctx)) {
    ctx.stdout(JSON.stringify(toJson(merged), null, 2));
    return ExitCode.Success;
  }

  // A trailing blank line closes the last section; drop it rather than print it.
  const lines = toText(catalogs, merged);
  for (const line of lines.slice(0, lines.length - 1)) ctx.stdout(line);
  return ExitCode.Success;
};

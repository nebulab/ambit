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
  MergedPack,
  MergedSkill,
} from "../../model/catalog.js";
import { loadCatalogs, mergeCatalogs, qualifiedName } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { loadProjectConfig } from "../../model/config.js";
import { ExitCode } from "../../errors.js";
import type { McpTransport } from "../../model/mcp-entity.js";
import type { PatternEntry } from "../../model/pattern.js";
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

function toText(catalogs: readonly Catalog[], merged: MergedCatalog): readonly string[] {
  const heading =
    catalogs.length === 0
      ? ["no catalogs configured", ""]
      : [...catalogs.map((catalog) => `${catalog.name}  ${catalog.source}`), ""];

  return [
    ...heading,
    // Packs first, and carrying their descriptions, because this is the section a person browsing a
    // catalog is actually reading: it is the list of things there are names for.
    ...section(
      "packs",
      merged.packs.map((pack) => [pack.name, pack.catalog, pack.description ?? UNDESCRIBED]),
    ),
    ...section(
      "skills",
      merged.skills.map((skill) => [skill.name, skill.catalog]),
    ),
    ...section(
      "mcps",
      merged.mcps.map((mcp) => [mcp.name, mcp.catalog, transportSummary(mcp.transport)]),
    ),
    ...section(
      "hooks",
      merged.hooks.map((hook) => [hook.name, hook.catalog, hook.event, commandSummary(hook)]),
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

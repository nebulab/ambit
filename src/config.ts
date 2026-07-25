/**
 * `ambit.yml` — the project config (spec §3.1).
 *
 * Parsing is total: whatever comes back is fully typed and needs no further checking, and
 * anything the config could not express has already been rejected with an exit-2 error naming
 * the file, the key, and the line.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import { configError } from "./errors.js";
import type { McpEntity } from "./mcp.js";
import { parseMcpEntity } from "./mcp.js";
import type { PositionedString, YamlMapping } from "./yaml.js";
import { parseYamlMapping, readYamlMapping } from "./yaml.js";

/** The only config version this build understands. */
export const CONFIG_VERSION = 1;

/** Used when `harnesses` is absent. */
export const DEFAULT_HARNESSES: readonly string[] = ["claude"];

/** Accepted config filenames, in preference order. Having both is an error. */
export const CONFIG_FILENAMES: readonly string[] = ["ambit.yml", "ambit.yaml"];

const CONFIG_KEYS = ["catalogs", "harnesses", "mcps", "scopes", "skills", "version"] as const;
const CATALOG_KEYS = ["name", "ref", "source"] as const;
const SKILL_KEYS = ["name", "path", "ref", "source"] as const;

/** A catalog to fetch and parse. */
export interface CatalogRef {
  readonly name: string;
  readonly source: string;
  /** Tag, branch, or commit. Absent means the source's default branch. */
  readonly ref?: string;
}

/** A skill named for lookup in the configured catalogs. */
export interface CatalogSkillRequest {
  readonly kind: "catalog";
  readonly name: string;
}

/** A skill declared with its own source, which need not be a full catalog. */
export interface SourceSkillRequest {
  readonly kind: "source";
  readonly name: string;
  readonly source: string;
  readonly ref?: string;
  /** Overrides the name→path convention within the source. */
  readonly path?: string;
}

/** An entry of `skills`: a bare name, or a mapping carrying its own source. */
export type SkillRequest = CatalogSkillRequest | SourceSkillRequest;

/**
 * Where the config came from, and where inside it the values live that a later stage judges.
 *
 * Resolution runs long after parsing, so an error about a held scope has no YAML node left to
 * point at — yet spec §6 still requires it to name the file and the line. This carries just
 * enough of the document's positions for that, keeping {@link ProjectConfig} itself a plain
 * object with no parser state hanging off it.
 */
export interface ConfigOrigin {
  /** How the config file is named in messages — `ambit.yml` or `ambit.yaml`, project-relative. */
  readonly file: string;
  /** 1-based line each held scope was written on, keyed by scope. */
  readonly scopeLines: ReadonlyMap<string, number>;
}

/** A parsed, validated `ambit.yml`. */
export interface ProjectConfig {
  readonly version: number;
  /** Positions for the errors raised after parsing (spec §6). */
  readonly origin: ConfigOrigin;
  readonly harnesses: readonly string[];
  /** Held scopes, exactly as listed — nothing is added implicitly (spec §2). */
  readonly scopes: readonly string[];
  /** Catalogs in priority order: on a name collision the earlier one wins. */
  readonly catalogs: readonly CatalogRef[];
  /** Skills wanted regardless of scope. */
  readonly skills: readonly SkillRequest[];
  /** Servers defined inline rather than in a catalog. */
  readonly mcps: readonly McpEntity[];
}

function parseCatalogs(root: YamlMapping): readonly CatalogRef[] {
  const entries = root.optionalMappingList("catalogs") ?? [];
  const catalogs: CatalogRef[] = [];
  const lines = new Map<string, number | undefined>();

  for (const entry of entries) {
    entry.rejectUnknownKeys(CATALOG_KEYS);
    const name = entry.requireString("name");

    if (lines.has(name)) {
      const first = lines.get(name);
      throw entry.keyError("name", `duplicate catalog name "${name}"`, [
        first === undefined ? "already declared earlier" : `first declared on line ${first}`,
        "give each catalog a distinct name",
      ]);
    }
    lines.set(name, entry.lineOf("name"));

    const ref = entry.optionalString("ref");
    catalogs.push({
      name,
      source: entry.requireString("source"),
      ...(ref !== undefined && { ref }),
    });
  }

  return catalogs;
}

function parseSkills(root: YamlMapping): readonly SkillRequest[] {
  const entries = root.optionalEntryList("skills") ?? [];

  return entries.map((entry): SkillRequest => {
    if (typeof entry === "string") return { kind: "catalog", name: entry };

    entry.rejectUnknownKeys(SKILL_KEYS);
    const ref = entry.optionalString("ref");
    const within = entry.optionalString("path");
    return {
      kind: "source",
      name: entry.requireString("name"),
      source: entry.requireString("source"),
      ...(ref !== undefined && { ref }),
      ...(within !== undefined && { path: within }),
    };
  });
}

/**
 * Where each held scope was written.
 *
 * A scope listed twice keeps the first line: that is the one a reader scanning downward finds,
 * and duplicates are harmless to resolution, which deduplicates them.
 */
function scopeLines(scopes: readonly PositionedString[]): ReadonlyMap<string, number> {
  const lines = new Map<string, number>();
  for (const entry of scopes) {
    if (entry.line !== undefined && !lines.has(entry.value)) lines.set(entry.value, entry.line);
  }
  return lines;
}

/** Validates a config mapping, whatever it was read from. */
function fromMapping(root: YamlMapping): ProjectConfig {
  root.rejectUnknownKeys(CONFIG_KEYS);

  const version = root.requireInteger("version");
  if (version !== CONFIG_VERSION) {
    throw root.keyError("version", `unsupported config version ${version}`, [
      `this build of ambit understands version ${CONFIG_VERSION}`,
      `set \`version: ${CONFIG_VERSION}\`, or upgrade ambit`,
    ]);
  }

  const scopes = root.optionalPositionedStringList("scopes") ?? [];

  return {
    version,
    origin: { file: root.file, scopeLines: scopeLines(scopes) },
    harnesses: root.optionalStringList("harnesses") ?? DEFAULT_HARNESSES,
    scopes: scopes.map((entry) => entry.value),
    catalogs: parseCatalogs(root),
    skills: parseSkills(root),
    mcps: (root.optionalMappingList("mcps") ?? []).map(parseMcpEntity),
  };
}

/**
 * Parses an `ambit.yml` document.
 *
 * @param text the document.
 * @param file how it is named in error messages, conventionally project-relative.
 * @throws {AmbitError} exit 2 for anything malformed.
 */
export function parseProjectConfig(text: string, file: string): ProjectConfig {
  return fromMapping(parseYamlMapping(text, file));
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the config file in `projectDir`.
 *
 * @returns its absolute path, and the project-relative name to use in messages.
 * @throws {AmbitError} exit 2 if there is no config, or more than one.
 */
export async function findConfigFile(
  projectDir: string,
): Promise<{ readonly path: string; readonly file: string }> {
  const present: string[] = [];
  for (const name of CONFIG_FILENAMES) {
    if (await isFile(path.join(projectDir, name))) present.push(name);
  }

  if (present.length === 0) {
    throw configError(`no ambit config in ${projectDir}`, [
      `expected one of: ${CONFIG_FILENAMES.join(", ")}`,
      "run `ambit init` to scaffold one",
    ]);
  }
  if (present.length > 1) {
    throw configError(`${present.join(" and ")} both exist in ${projectDir}`, [
      "ambit cannot tell which one is authoritative",
      `delete one, keeping ${CONFIG_FILENAMES[0]}`,
    ]);
  }

  const file = present[0]!;
  return { path: path.join(projectDir, file), file };
}

/**
 * Loads the config for a project directory.
 *
 * @throws {AmbitError} exit 2 if the config is missing, ambiguous, or malformed.
 */
export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  const found = await findConfigFile(projectDir);
  return fromMapping(await readYamlMapping(found.path, found.file));
}

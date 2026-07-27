/**
 * `ambit.yml` — the one config format, in both of its roles.
 *
 * A repo can be two things at once, and one file says which. Top-level keys are what a repo
 * *installs for itself*: the catalogs it draws from, the scopes it holds, the harnesses it writes
 * into. Everything under `catalog:` is what it *publishes as a catalog*: the scope registry its
 * skills declare against, and whatever catalog-level metadata comes after it. A project writes only
 * the first, a catalog only the second, and a catalog that installs its own skills writes both — in
 * one document, which is the case two files could not express.
 *
 * One parser for both, deliberately. A second one for the catalog half would put `rejectUnknownKeys`
 * on half a document each, and a typo'd `catlog:` would then be a catalog that registers nothing and
 * warns nobody. So {@link parseProjectConfig} reads the whole thing and {@link parseCatalogDirectory}
 * is handed the section it cares about.
 *
 * Parsing is total: whatever comes back is fully typed and needs no further checking, and
 * anything the config could not express has already been rejected with an exit-2 error naming
 * the file, the key, and the line.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import { at, configError } from "../errors.js";
import type { HookEntity } from "./hook-entity.js";
import { parseHookEntity } from "./hook-entity.js";
import type { McpEntity } from "./mcp-entity.js";
import { parseMcpEntity } from "./mcp-entity.js";
import type { PositionedString } from "./yaml.js";
import { YamlMapping, parseYamlMapping, readYamlMapping } from "./yaml.js";

/** The only config version this build understands. */
export const CONFIG_VERSION = 1;

/** Used when `harnesses` is absent. */
export const DEFAULT_HARNESSES: readonly string[] = ["claude"];

/**
 * Accepted config filenames, in preference order. Having both is an error.
 *
 * A tuple rather than a `string[]` so the first name — the one `ambit init` writes — is known at
 * the type level and needs no fallback at the one place that scaffolds it.
 */
export const CONFIG_FILENAMES = ["ambit.yml", "ambit.yaml"] as const;

const CONFIG_KEYS = [
  "catalog",
  "catalogs",
  "harnesses",
  "hooks",
  "mcps",
  "scopes",
  "skills",
  "version",
] as const;
const CATALOG_KEYS = ["name", "ref", "source"] as const;
const SKILL_KEYS = ["name", "path", "ref", "source"] as const;

/**
 * The key everything a repo publishes as a catalog nests under — and whose presence is what makes a
 * directory a catalog at all.
 */
export const CATALOG_KEY = "catalog";

const CATALOG_SECTION_KEYS = ["scopes"] as const;
const SCOPE_KEYS = ["description"] as const;

/**
 * The scope registry's key path within a catalog's config, and the dotted spelling errors use.
 *
 * Both, because both are needed and they must not drift: the path is what an authoring edit writes
 * through, and the dotted name is what a message says out loud. `scopes.yml` used to identify the
 * registry by its filename; now that several `ambit.yml` are in play at once — the project's and one
 * per catalog — the key path is what identifies it, and the filename says only which document.
 */
export const REGISTRY_KEY_PATH: readonly string[] = [CATALOG_KEY, "scopes"];

/** How {@link REGISTRY_KEY_PATH} reads in a message: `catalog.scopes`. */
export const REGISTRY_PATH = REGISTRY_KEY_PATH.join(".");

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

/** One registered scope. The description is the picker label a consuming tool renders. */
export interface ScopeDefinition {
  readonly name: string;
  readonly description: string;
}

/**
 * What a repo publishes as a catalog: everything under `catalog:`.
 *
 * Separate from the consumer keys around it because the two roles are separate — a project holds
 * scopes, a catalog defines them — and because a reader four lines away from both needs the nesting
 * to tell which `scopes:` is which.
 */
export interface CatalogSection {
  /** Registered scopes, sorted by name. */
  readonly scopes: readonly ScopeDefinition[];
}

/**
 * Where the config came from, and where inside it the values live that a later stage judges.
 *
 * Resolution runs long after parsing, so an error about a held scope has no YAML node left to
 * point at — yet it still has to name the file and the line. This carries just
 * enough of the document's positions for that, keeping {@link ProjectConfig} itself a plain
 * object with no parser state hanging off it.
 */
export interface ConfigOrigin {
  /** How the config file is named in messages — `ambit.yml` or `ambit.yaml`, project-relative. */
  readonly file: string;
  /** 1-based line each held scope was written on, keyed by scope. */
  readonly scopeLines: ReadonlyMap<string, number>;
  /** 1-based line each `skills` entry was written on, keyed by skill name. */
  readonly skillLines: ReadonlyMap<string, number>;
  /** 1-based line each `mcps` entry was written on, keyed by server name. */
  readonly mcpLines: ReadonlyMap<string, number>;
  /** 1-based line each `hooks` entry was written on, keyed by hook name. */
  readonly hookLines: ReadonlyMap<string, number>;
}

/** A parsed, validated `ambit.yml`. */
export interface ProjectConfig {
  readonly version: number;
  /** Positions for the errors raised after parsing. */
  readonly origin: ConfigOrigin;
  /**
   * What this repo publishes as a catalog, when it publishes one. Absent means it is a project
   * only — and a directory whose config has no `catalog:` block is not a catalog.
   */
  readonly catalog?: CatalogSection;
  readonly harnesses: readonly string[];
  /** Held scopes, exactly as listed — nothing is added implicitly. */
  readonly scopes: readonly string[];
  /** Catalogs in priority order: on a name collision the earlier one wins. */
  readonly catalogs: readonly CatalogRef[];
  /** Skills wanted regardless of scope. */
  readonly skills: readonly SkillRequest[];
  /** Servers defined inline rather than in a catalog. */
  readonly mcps: readonly McpEntity[];
  /** Hooks defined inline rather than in a catalog. */
  readonly hooks: readonly HookEntity[];
}

/**
 * Records the names one config list has used, rejecting a repeat and naming both lines.
 *
 * Every list in `ambit.yml` is keyed by `name`, and every later stage looks each name up exactly
 * once — so a repeat is never a merge, always a mistake, and refusing it here is what lets
 * resolution treat the lists as maps.
 *
 * @param subject how the list's entries are named in the message.
 * @param advice the concrete next step.
 * @returns a function that throws on the second use of a name.
 */
function nameTracker(
  file: string,
  subject: string,
  advice: string,
): (name: string, line: number | undefined) => void {
  const seen = new Map<string, number | undefined>();

  return (name, line) => {
    if (seen.has(name)) {
      const first = seen.get(name);
      throw configError(`duplicate ${subject} "${name}" ${at(file, line)}`, [
        first === undefined ? "already declared earlier" : `first declared on line ${first}`,
        advice,
      ]);
    }
    seen.set(name, line);
  };
}

/** A parsed config list, with the line each entry was written on for the errors raised later. */
interface Positioned<T> {
  readonly entries: readonly T[];
  readonly lines: ReadonlyMap<string, number>;
}

/**
 * Parses `catalog:`, the block that makes this repo a catalog.
 *
 * Descriptions are required: they are the labels a tool asking someone which scopes they hold
 * renders, not decoration. The mapping itself is required too, and may be empty — a catalog that has
 * registered nothing yet is a catalog, whereas one that never says the word is a project.
 */
function parseCatalogSection(root: YamlMapping): CatalogSection {
  const section = root.requireMapping(CATALOG_KEY);
  section.rejectUnknownKeys(CATALOG_SECTION_KEYS);

  const registry = section.requireMapping(REGISTRY_KEY_PATH[1]!);
  const scopes = registry.keys().map((name) => {
    const entry = registry.requireMapping(name);
    entry.rejectUnknownKeys(SCOPE_KEYS);
    return { name, description: entry.requireString("description") };
  });

  return { scopes: [...scopes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

function parseCatalogs(root: YamlMapping): readonly CatalogRef[] {
  const track = nameTracker(root.file, "catalog name", "give each catalog a distinct name");
  const catalogs: CatalogRef[] = [];

  for (const entry of root.optionalMappingList("catalogs") ?? []) {
    entry.rejectUnknownKeys(CATALOG_KEYS);
    const name = entry.requireString("name");
    track(name, entry.lineOf("name"));

    const ref = entry.optionalString("ref");
    catalogs.push({
      name,
      source: entry.requireString("source"),
      ...(ref !== undefined && { ref }),
    });
  }

  return catalogs;
}

function parseSourceSkill(entry: YamlMapping): SourceSkillRequest {
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
}

function parseSkills(root: YamlMapping): Positioned<SkillRequest> {
  const track = nameTracker(root.file, "skills entry", "list each skill once");
  const entries: SkillRequest[] = [];
  const lines = new Map<string, number>();

  const add = (request: SkillRequest, line: number | undefined): void => {
    track(request.name, line);
    if (line !== undefined) lines.set(request.name, line);
    entries.push(request);
  };

  for (const entry of root.optionalEntryList("skills") ?? []) {
    if (entry instanceof YamlMapping) add(parseSourceSkill(entry), entry.lineOf("name"));
    else add({ kind: "catalog", name: entry.value }, entry.line);
  }

  return { entries, lines };
}

function parseMcps(root: YamlMapping): Positioned<McpEntity> {
  const track = nameTracker(root.file, "mcps entry", "define each server once");
  const entries: McpEntity[] = [];
  const lines = new Map<string, number>();

  for (const entry of root.optionalMappingList("mcps") ?? []) {
    const entity = parseMcpEntity(entry);
    const line = entry.lineOf("name");
    track(entity.name, line);
    if (line !== undefined) lines.set(entity.name, line);
    entries.push(entity);
  }

  return { entries, lines };
}

/**
 * Refuses an inline hook that says it ships a script.
 *
 * A `type: script` hook runs a file its own directory holds, and a hook declared in `ambit.yml` has no
 * directory — there is nowhere to put the script and nothing for ambit to materialize. Refused here
 * rather than in the shared parser because it is a fact about *where* the hook was written, which the
 * parser cannot see: the same document under `hooks/<name>/HOOK.yml` is perfectly legal.
 */
function assertNotScript(entry: YamlMapping, entity: HookEntity): void {
  if (entity.type !== "script") return;

  throw entry.keyError("type", `hook "${entity.name}" cannot ship a script from ${entry.file}`, [
    "a script lives in the hook's own directory, and a hook declared here has none",
    "say `type: command`, or move the hook into a catalog at `hooks/<name>/HOOK.yml`",
  ]);
}

function parseHooks(root: YamlMapping): Positioned<HookEntity> {
  const track = nameTracker(root.file, "hooks entry", "define each hook once");
  const entries: HookEntity[] = [];
  const lines = new Map<string, number>();

  for (const entry of root.optionalMappingList("hooks") ?? []) {
    const entity = parseHookEntity(entry);
    assertNotScript(entry, entity);
    const line = entry.lineOf("name");
    track(entity.name, line);
    if (line !== undefined) lines.set(entity.name, line);
    entries.push(entity);
  }

  return { entries, lines };
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

  // Read in the order §3.1 lists the keys, rather than left to the return statement's evaluation
  // order: a config with two problems should report the earlier key's, not whichever key the
  // object literal happens to mention first. `catalog:` comes first of the lot because it is what
  // the document *is* rather than what it wants.
  const catalog = root.has(CATALOG_KEY) ? parseCatalogSection(root) : undefined;
  const harnesses = root.optionalStringList("harnesses") ?? DEFAULT_HARNESSES;
  const scopes = root.optionalPositionedStringList("scopes") ?? [];
  const catalogs = parseCatalogs(root);
  const skills = parseSkills(root);
  const mcps = parseMcps(root);
  const hooks = parseHooks(root);

  return {
    version,
    origin: {
      file: root.file,
      scopeLines: scopeLines(scopes),
      skillLines: skills.lines,
      mcpLines: mcps.lines,
      hookLines: hooks.lines,
    },
    ...(catalog !== undefined && { catalog }),
    harnesses,
    scopes: scopes.map((entry) => entry.value),
    catalogs,
    skills: skills.entries,
    mcps: mcps.entries,
    hooks: hooks.entries,
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
 * Which accepted config filenames `projectDir` already holds, in preference order.
 *
 * Shared with `ambit init`, whose question is the opposite of {@link findConfigFile}'s: it must
 * refuse a directory that holds *either* name, and refuse it naming the file it found rather than
 * the one it was about to write.
 */
export async function existingConfigFiles(projectDir: string): Promise<readonly string[]> {
  const present: string[] = [];
  for (const name of CONFIG_FILENAMES) {
    if (await isFile(path.join(projectDir, name))) present.push(name);
  }
  return present;
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
  const present = await existingConfigFiles(projectDir);

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

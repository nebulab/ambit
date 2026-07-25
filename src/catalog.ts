/**
 * Catalog parsing (spec §3.2–§3.4).
 *
 * A catalog is a plain skills repo: skills at `skills/<namespace>/<name>/SKILL.md`, MCP
 * entities at `mcps/<name>.yml`, and a `scopes.yml` registry at the root. Nothing here is
 * ambit-specific except the extra frontmatter keys and the two extra files, which other tools
 * ignore — that compatibility is a hard requirement (spec §1).
 *
 * A skill's name is not stored anywhere authoritative: it is derived from the path, and the
 * frontmatter `name` must agree. Disagreement is an error rather than a preference for one over
 * the other, because every other tool derives the name from the path and would silently
 * install the thing under a different name than ambit resolved.
 *
 * This module reads from a directory. Fetching a catalog from git into that directory comes
 * later; until then only `path:` sources resolve.
 *
 * A project can also declare a skill or a server itself (spec §3.1), and those are folded into the
 * same merged namespace here rather than handled beside it — see {@link mergeConfigEntities} — so
 * resolution has exactly one place to look a name up.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { CatalogRef, ConfigOrigin, ProjectConfig, SourceSkillRequest } from "./config.js";
import { AmbitError, at, configError, resolutionError } from "./errors.js";
import type { McpEntity } from "./mcp.js";
import { parseMcpEntity } from "./mcp.js";
import type { YamlMapping } from "./yaml.js";
import { readFrontmatterMapping, readYamlMapping } from "./yaml.js";

/** The catalog's scope registry (spec §3.4). */
export const SCOPES_FILENAME = "scopes.yml";

/** Where skills live within a catalog. */
export const SKILLS_DIRNAME = "skills";

/** Where MCP entities live within a catalog. */
export const MCPS_DIRNAME = "mcps";

/** The file whose presence makes a directory a skill. */
export const SKILL_FILENAME = "SKILL.md";

/** MCP entity extensions, in preference order. One stem carrying both is an error. */
const MCP_EXTENSIONS: readonly string[] = [".yml", ".yaml"];

/** The prefix marking a source as a local directory (spec §3.1). */
const PATH_SOURCE_PREFIX = "path:";

const SCOPES_KEYS = ["scopes"] as const;
const SCOPE_KEYS = ["description"] as const;

/** One registered scope. The description is the picker label a consuming tool renders. */
export interface ScopeDefinition {
  readonly name: string;
  readonly description: string;
}

/** A skill as the catalog declares it. */
export interface CatalogSkill {
  /** Derived from `path`, and equal to the frontmatter `name`. */
  readonly name: string;
  /** The skill directory, relative to the catalog root, `/`-separated. */
  readonly path: string;
  /** The harness's own summary, carried through for `catalog` and `scopes` output. */
  readonly description?: string;
  /** Declared scopes. Empty means reachable only via `requires` or an explicit listing. */
  readonly scopes: readonly string[];
  /** Skill names, or MCP names prefixed `mcp.`. */
  readonly requires: readonly string[];
  /** Env vars the skill itself reads, not via an MCP. */
  readonly env: readonly string[];
}

/** One parsed catalog. */
export interface Catalog {
  readonly name: string;
  /** The `source` it was resolved from, as written in config. */
  readonly source: string;
  /** Absolute path to the catalog root on disk. */
  readonly root: string;
  /** Registered scopes, sorted by name. */
  readonly scopes: readonly ScopeDefinition[];
  /** Skills, sorted by name. */
  readonly skills: readonly CatalogSkill[];
  /** MCP entities, sorted by name. */
  readonly mcps: readonly McpEntity[];
}

/** A skill in the merged view, tagged with the catalog it came from. */
export interface MergedSkill extends CatalogSkill {
  readonly catalog: string;
  /**
   * Absolute path to that catalog's root on disk, so materialization can find the skill without
   * looking the catalog up again. Deliberately absent from every output surface: it is
   * machine-specific, and golden files must not carry it.
   */
  readonly catalogRoot: string;
}

/** An MCP entity in the merged view, tagged with the catalog it came from. */
export interface MergedMcp extends McpEntity {
  readonly catalog: string;
}

/** Every configured catalog, merged into one namespace per kind. */
export interface MergedCatalog {
  /** Catalog names, in config order — which is priority order. */
  readonly catalogs: readonly string[];
  readonly scopes: readonly ScopeDefinition[];
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
}

function byName<T extends { readonly name: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Directory entries in name order, so a catalog parses identically whatever the filesystem says. */
async function sortedEntries(dir: string): Promise<readonly { name: string; directory: boolean }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Resolves a `source` to a directory on disk.
 *
 * Shared by catalogs and by `skills` entries carrying their own source (spec §3.1), because the
 * source formats are the same set for both and there is nothing catalog-specific about resolving
 * one — only about what is read from the result.
 *
 * @param subject how the thing being resolved is named in errors: `catalog "company"`.
 * @param where the `(file line N)` suffix the config entry sits at.
 * @param projectDir what a relative `path:` source is relative to.
 * @throws {AmbitError} exit 2 for a source this build cannot resolve, or a missing directory.
 */
async function resolveSourceRoot(
  subject: string,
  source: string,
  where: string,
  projectDir: string,
): Promise<string> {
  if (!source.startsWith(PATH_SOURCE_PREFIX)) {
    throw configError(`cannot resolve ${subject} ${where}`, [
      `\`${source}\` is not a local path, and this build fetches nothing`,
      "point `source` at a directory with `path:./dir`",
    ]);
  }

  const within = source.slice(PATH_SOURCE_PREFIX.length);
  if (within.trim() === "") {
    throw configError(`${subject} has an empty path source ${where}`, [
      `\`${source}\` names no directory`,
      "write the directory after the prefix, as `path:./dir`",
    ]);
  }

  const root = path.resolve(projectDir, within);
  if (!(await isDirectory(root))) {
    throw configError(`${subject} is not a directory ${where}`, [
      `${root} does not exist, or is not a directory`,
      "correct `source`, or create the directory",
    ]);
  }

  return root;
}

/**
 * Resolves a catalog's `source` to a directory on disk.
 *
 * @param projectDir what a relative `path:` source is relative to.
 * @param file how the config file is named in errors.
 * @throws {AmbitError} exit 2 for a source this build cannot resolve, or a missing directory.
 */
export async function resolveCatalogRoot(
  catalog: CatalogRef,
  projectDir: string,
  file: string,
): Promise<string> {
  return resolveSourceRoot(
    `catalog "${catalog.name}"`,
    catalog.source,
    at(file, undefined),
    projectDir,
  );
}

/** Parses `scopes.yml`. Descriptions are required: they are the picker's labels, not decoration. */
function parseScopeRegistry(root: YamlMapping): readonly ScopeDefinition[] {
  root.rejectUnknownKeys(SCOPES_KEYS);
  const scopes = root.requireMapping("scopes");

  return byName(
    scopes.keys().map((name) => {
      const entry = scopes.requireMapping(name);
      entry.rejectUnknownKeys(SCOPE_KEYS);
      return { name, description: entry.requireString("description") };
    }),
  );
}

/** The name↔path convention: the path under `skills/`, with `/` → `.` (spec §2). */
export function skillNameFromPath(relative: string): string {
  return relative.replaceAll("/", ".");
}

/** Every skill directory under `skills/`, relative to it and `/`-separated. */
async function findSkillDirectories(root: string): Promise<readonly string[]> {
  const skillsDir = path.join(root, SKILLS_DIRNAME);
  if (!(await isDirectory(skillsDir))) return [];

  const found: string[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of await sortedEntries(dir)) {
      if (entry.directory) {
        await walk(path.join(dir, entry.name), relative === "" ? entry.name : `${relative}/${entry.name}`);
      } else if (entry.name === SKILL_FILENAME) {
        found.push(relative);
      }
    }
  };

  await walk(skillsDir, "");
  return found;
}

/**
 * What ambit reads off a skill's frontmatter once its name is settled (spec §3.2).
 *
 * Unknown keys are deliberately allowed, unlike everywhere else: this frontmatter is the harness's,
 * and ambit only adds keys to it.
 */
function skillAnnotations(mapping: YamlMapping): Omit<CatalogSkill, "name" | "path"> {
  const description = mapping.optionalString("description");
  return {
    ...(description !== undefined && { description }),
    scopes: mapping.optionalStringList("scopes") ?? [],
    requires: mapping.optionalStringList("requires") ?? [],
    env: mapping.optionalStringList("env") ?? [],
  };
}

async function parseSkill(root: string, relative: string): Promise<CatalogSkill> {
  const file = `${SKILLS_DIRNAME}/${relative}/${SKILL_FILENAME}`;

  if (relative === "") {
    throw configError(`${SKILLS_DIRNAME}/${SKILL_FILENAME} is not inside a skill directory`, [
      "a skill's name is its path under `skills/`, so it needs at least one directory",
      `move it to ${SKILLS_DIRNAME}/<namespace>/<name>/${SKILL_FILENAME}`,
    ]);
  }

  const mapping = await readFrontmatterMapping(path.join(root, file), file);

  const name = mapping.requireString("name");
  const derived = skillNameFromPath(relative);
  if (name !== derived) {
    throw mapping.keyError("name", `skill name "${name}" does not match its path`, [
      `${file} derives the name "${derived}"`,
      "rename the directory, or correct `name` to match it",
    ]);
  }

  return { name, path: `${SKILLS_DIRNAME}/${relative}`, ...skillAnnotations(mapping) };
}

/** MCP entity stems under `mcps/`, each with the one file that defines it. */
async function findMcpFiles(root: string): Promise<readonly { stem: string; file: string }[]> {
  const mcpsDir = path.join(root, MCPS_DIRNAME);
  if (!(await isDirectory(mcpsDir))) return [];

  const byStem = new Map<string, string[]>();
  for (const entry of await sortedEntries(mcpsDir)) {
    if (entry.directory) continue;
    const extension = MCP_EXTENSIONS.find((candidate) => entry.name.endsWith(candidate));
    if (extension === undefined) continue;
    const stem = entry.name.slice(0, -extension.length);
    byStem.set(stem, [...(byStem.get(stem) ?? []), entry.name]);
  }

  return [...byStem.entries()].map(([stem, names]) => {
    if (names.length > 1) {
      const paths = names.map((name) => `${MCPS_DIRNAME}/${name}`);
      throw configError(`${paths.join(" and ")} both define "${stem}"`, [
        "ambit cannot tell which one is authoritative",
        `delete one, keeping ${MCPS_DIRNAME}/${stem}${MCP_EXTENSIONS[0]!}`,
      ]);
    }
    return { stem, file: `${MCPS_DIRNAME}/${names[0]!}` };
  });
}

async function parseMcpFile(root: string, stem: string, file: string): Promise<McpEntity> {
  const mapping = await readYamlMapping(path.join(root, file), file);
  const entity = parseMcpEntity(mapping);

  if (entity.name !== stem) {
    throw mapping.keyError("name", `MCP name "${entity.name}" does not match its filename`, [
      `${file} declares the name "${stem}"`,
      `rename the file to ${MCPS_DIRNAME}/${entity.name}${MCP_EXTENSIONS[0]!}, or correct \`name\``,
    ]);
  }

  return entity;
}

/**
 * Adds where an error came from, so a message about `skills/a/b/SKILL.md` says which of several
 * sources holds that path. Prepended, keeping the concrete next step last (spec §6).
 *
 * @param subject the source as errors name it: `catalog "company"`.
 */
function inSource(subject: string, root: string, error: unknown): unknown {
  if (!(error instanceof AmbitError)) return error;
  return new AmbitError(error.code, error.message, [`in ${subject} (${root})`, ...error.detail]);
}

/**
 * Parses the catalog rooted at `root`.
 *
 * @param name the catalog's name, as errors report it.
 * @param source the `source` it was resolved from.
 * @throws {AmbitError} exit 2 for a missing registry, a malformed file, or a name that
 *   disagrees with its path.
 */
export async function parseCatalogDirectory(
  name: string,
  source: string,
  root: string,
): Promise<Catalog> {
  try {
    const registryPath = path.join(root, SCOPES_FILENAME);
    if (!(await isFile(registryPath))) {
      throw configError(`${SCOPES_FILENAME} is missing`, [
        "a catalog must register every scope its skills and MCPs declare",
        `add ${SCOPES_FILENAME} at the catalog root`,
      ]);
    }

    const scopes = parseScopeRegistry(await readYamlMapping(registryPath, SCOPES_FILENAME));

    const skills: CatalogSkill[] = [];
    for (const relative of await findSkillDirectories(root)) {
      skills.push(await parseSkill(root, relative));
    }

    const mcps: McpEntity[] = [];
    for (const { stem, file } of await findMcpFiles(root)) {
      mcps.push(await parseMcpFile(root, stem, file));
    }

    return { name, source, root, scopes, skills: byName(skills), mcps: byName(mcps) };
  } catch (error) {
    throw inSource(`catalog "${name}"`, root, error);
  }
}

/**
 * Loads every catalog the config declares, in config order.
 *
 * @param projectDir what a relative `path:` source is relative to.
 * @throws {AmbitError} exit 2 for an unresolvable source or a malformed catalog.
 */
export async function loadCatalogs(
  config: ProjectConfig,
  projectDir: string,
): Promise<readonly Catalog[]> {
  const catalogs: Catalog[] = [];
  for (const ref of config.catalogs) {
    const root = await resolveCatalogRoot(ref, projectDir, config.origin.file);
    catalogs.push(await parseCatalogDirectory(ref.name, ref.source, root));
  }
  return catalogs;
}

/** Where a skill sits inside a source that follows the catalog convention (spec §2). */
function skillPathFromName(name: string): string {
  return `${SKILLS_DIRNAME}/${name.replaceAll(".", "/")}`;
}

/**
 * Loads one skill declared with its own `source` rather than through a catalog (spec §3.1).
 *
 * A source need not be a catalog: only the one skill directory is read, nothing expects a
 * `scopes.yml`, and `path` may point anywhere inside it. What the skill declares still counts —
 * `requires` is closed over as usual — so an explicit entry can carry dependencies with it.
 *
 * The config's `name` is authoritative, since it is what resolution, `requires`, and the installed
 * directory all use; a frontmatter `name` that disagrees is an error for the same reason a catalog
 * skill's must match its path.
 *
 * @param origin where the config's `skills` entry was written, so errors can cite the line.
 * @throws {AmbitError} exit 2 for a source this build cannot resolve, a skill directory that is not
 *   there, malformed frontmatter, or a `name` that disagrees with the config's.
 */
export async function loadSourceSkill(
  request: SourceSkillRequest,
  projectDir: string,
  origin: ConfigOrigin,
): Promise<MergedSkill> {
  const subject = `skill "${request.name}"`;
  const where = at(origin.file, origin.skillLines.get(request.name));
  const root = await resolveSourceRoot(subject, request.source, where, projectDir);

  const directory = request.path ?? skillPathFromName(request.name);
  const file = `${directory}/${SKILL_FILENAME}`;

  if (!(await isFile(path.join(root, file)))) {
    throw configError(`${subject} is not in its source ${where}`, [
      `${root} has no ${file}`,
      request.path === undefined
        ? "add `path:` naming the skill's directory within the source"
        : "correct `path`, or point `source` at the directory that holds it",
    ]);
  }

  try {
    const mapping = await readFrontmatterMapping(path.join(root, file), file);
    const declared = mapping.requireString("name");
    if (declared !== request.name) {
      throw mapping.keyError(
        "name",
        `skill name "${declared}" does not match the name it is declared under`,
        [`${origin.file} lists it as "${request.name}"`, "correct one of the two so they agree"],
      );
    }

    return {
      name: request.name,
      path: directory,
      ...skillAnnotations(mapping),
      // No catalog provided it, so the column that would name one names the source instead: with
      // `path` it locates the skill, and it is how the config refers to it.
      catalog: request.source,
      catalogRoot: root,
    };
  } catch (error) {
    throw inSource(`skill source "${request.source}"`, root, error);
  }
}

/**
 * The error for a config declaration a catalog already provides (spec §4.5, §6).
 *
 * Spec §3.1 describes both surfaces as being for things no catalog defines, so a collision means
 * one of the two declarations is a mistake — and which one ambit cannot know, so it refuses rather
 * than letting either quietly win.
 */
function declarationConflict(
  kind: string,
  name: string,
  provider: string,
  where: string,
  advice: string,
): AmbitError {
  return resolutionError(`${kind} "${name}" is also provided by catalog "${provider}" ${where}`, [
    `catalog "${provider}" already defines "${name}", and a name means one thing`,
    advice,
  ]);
}

/**
 * Folds a project's own declarations into the merged catalog: `skills` entries carrying their own
 * `source`, and inline `mcps` (spec §3.1, §4.8).
 *
 * They join the same namespace rather than sitting beside it, so resolution has exactly one place
 * to look a name up — which also lets a catalog skill's `requires` reach a server the project
 * defined inline.
 *
 * @param projectDir what a relative `path:` source is relative to.
 * @throws {AmbitError} exit 2 for a skill source that cannot be read; exit 3 for a name a catalog
 *   already provides.
 */
export async function mergeConfigEntities(
  merged: MergedCatalog,
  config: ProjectConfig,
  projectDir: string,
): Promise<MergedCatalog> {
  const skills = [...merged.skills];
  const mcps = [...merged.mcps];

  for (const request of config.skills) {
    if (request.kind !== "source") continue;
    const shadowed = merged.skills.find((skill) => skill.name === request.name);
    if (shadowed !== undefined) {
      throw declarationConflict(
        "skill",
        request.name,
        shadowed.catalog,
        at(config.origin.file, config.origin.skillLines.get(request.name)),
        "drop `source` to take the catalog's copy, or rename one of the two",
      );
    }
    skills.push(await loadSourceSkill(request, projectDir, config.origin));
  }

  for (const entity of config.mcps) {
    const shadowed = merged.mcps.find((mcp) => mcp.name === entity.name);
    if (shadowed !== undefined) {
      throw declarationConflict(
        "MCP server",
        entity.name,
        shadowed.catalog,
        at(config.origin.file, config.origin.mcpLines.get(entity.name)),
        "remove the `mcps` entry to take the catalog's, or rename one of the two",
      );
    }
    // Defined in the config itself, so that is what the origin column says: it is where a reader
    // goes to change it, and it carries no path of its own.
    mcps.push({ ...entity, catalog: config.origin.file });
  }

  return { ...merged, skills: byName(skills), mcps: byName(mcps) };
}

/**
 * Merges catalogs into one namespace per kind.
 *
 * On a duplicate name the earlier catalog in config order wins (spec §4.5). Reporting the
 * shadowing, and rejecting scopes whose descriptions disagree, arrive with multi-catalog
 * support; until then the first definition simply stands.
 */
export function mergeCatalogs(catalogs: readonly Catalog[]): MergedCatalog {
  const scopes = new Map<string, ScopeDefinition>();
  const skills = new Map<string, MergedSkill>();
  const mcps = new Map<string, MergedMcp>();

  for (const catalog of catalogs) {
    for (const scope of catalog.scopes) {
      if (!scopes.has(scope.name)) scopes.set(scope.name, scope);
    }
    for (const skill of catalog.skills) {
      if (!skills.has(skill.name)) {
        skills.set(skill.name, { ...skill, catalog: catalog.name, catalogRoot: catalog.root });
      }
    }
    for (const mcp of catalog.mcps) {
      if (!mcps.has(mcp.name)) mcps.set(mcp.name, { ...mcp, catalog: catalog.name });
    }
  }

  return {
    catalogs: catalogs.map((catalog) => catalog.name),
    scopes: byName([...scopes.values()]),
    skills: byName([...skills.values()]),
    mcps: byName([...mcps.values()]),
  };
}

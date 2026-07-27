/**
 * Catalog parsing.
 *
 * A catalog is a plain skills repo: skills at `skills/<name>/SKILL.md`, MCP
 * entities at `mcps/<name>.yml`, hooks at `hooks/<name>/HOOK.yml`, and a `scopes.yml` registry at the
 * root. Nothing here is ambit-specific except one extra frontmatter key and the extra directories,
 * which other tools ignore — that compatibility is a hard requirement.
 *
 * A skill's name is not stored anywhere authoritative: it is derived from the path, and the
 * frontmatter `name` must agree. Disagreement is an error rather than a preference for one over
 * the other, because every other tool derives the name from the path and would silently
 * install the thing under a different name than ambit resolved.
 *
 * This module reads from a directory, and nothing more: turning a `source` into one — a local path,
 * or a git repository fetched into the cache — is `sources.ts`'s job, so parsing is identical
 * whichever a catalog came from.
 *
 * A project can also declare a skill, a server or a hook itself, and those are folded into the
 * same merged namespace here rather than handled beside it — see {@link mergeConfigEntities} — so
 * resolution has exactly one place to look a name up.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { CatalogRef, ConfigOrigin, ProjectConfig, SourceSkillRequest } from "./config.js";
import { AmbitError, at, configError, resolutionError } from "../errors.js";
import type { HookEntity } from "./hook-entity.js";
import { commandProgram, parseHookEntity, scriptReference } from "./hook-entity.js";
import type { McpEntity } from "./mcp-entity.js";
import { parseMcpEntity } from "./mcp-entity.js";
import type { Requirement } from "./requirement.js";
import { parseRequirements } from "./requirement.js";
import type { ResolvedSource, SourceContext, SourceRequest } from "./sources.js";
import { resolveSource } from "./sources.js";
import type { YamlMapping } from "./yaml.js";
import {
  parseFrontmatterMapping,
  parseYamlMapping,
  readFrontmatterMapping,
  readYamlMapping,
} from "./yaml.js";

/** The catalog's scope registry. */
export const SCOPES_FILENAME = "scopes.yml";

/** Where skills live within a catalog. */
export const SKILLS_DIRNAME = "skills";

/** Where MCP entities live within a catalog. */
export const MCPS_DIRNAME = "mcps";

/** Where hooks live within a catalog. */
export const HOOKS_DIRNAME = "hooks";

/** The file whose presence makes a directory a skill. */
export const SKILL_FILENAME = "SKILL.md";

/**
 * The file whose presence makes a directory a hook.
 *
 * A hook is always a directory, like a skill and unlike an MCP entity, because a hook may ship its
 * own script — and one that does not is a directory holding only this file, so both kinds are found,
 * named and materialized the same way.
 */
export const HOOK_FILENAME = "HOOK.yml";

/**
 * MCP entity extensions, in preference order. One stem carrying both is an error.
 *
 * Exported because an authoring command that edits an existing entity has to find the file the
 * author actually wrote, not the one ambit would have written (see `mcpDocumentFile`).
 */
export const MCP_EXTENSIONS: readonly string[] = [".yml", ".yaml"];

const SCOPES_KEYS = ["scopes"] as const;
const SCOPE_KEYS = ["description"] as const;

/**
 * The one top-level `SKILL.md` frontmatter key ambit owns.
 *
 * Every annotation lives under it, so the block a harness reads and the block ambit reads cannot
 * collide however either grows: a harness that one day defines its own `scopes` or `requires` takes
 * the top-level name, and ambit's are a level down where they always were. The cost is one line of
 * nesting; the alternative was a standing bet that no harness ever picks those two words.
 */
export const AMBIT_FRONTMATTER_KEY = "ambit";

/**
 * The keys ambit reads under {@link AMBIT_FRONTMATTER_KEY}, in the order the format tabulates them —
 * which is also the order `catalog annotate` reports them in, so the report reads like the format's
 * own documentation.
 *
 * Lives here rather than beside the command that edits them because this is where they are *read*:
 * one list, so the parser and the writer cannot drift apart on what an annotation is.
 */
export const ANNOTATION_KEYS = ["scopes", "requires", "env"] as const;

export type AnnotationKey = (typeof ANNOTATION_KEYS)[number];

/**
 * How a catalog is parsed when the caller wants every problem rather than only the first — the validation split.
 *
 * Only validation passes one — both `validate` commands, and every authoring mutation checking its
 * own result. Everything else parses strictly, because a resolution that
 * carried on past a broken skill would install something nobody described.
 */
export interface CatalogParseOptions {
  /**
   * Receives a problem that would otherwise have been thrown, letting parsing continue past it.
   *
   * Exactly one problem takes this route: a skill whose frontmatter `name` disagrees with its path.
   * It is the one violation parsing can recover from — the path is what every other tool derives
   * the name from, so taking the path's answer and reporting the disagreement leaves a catalog
   * whose remaining checks still mean something. Everything else is a document ambit cannot read,
   * and there is no useful report to build on top of that.
   */
  readonly collect?: (problem: AmbitError) => void;
  /** Files to read instead of what is on disk — see {@link CatalogOverlay}. */
  readonly overlay?: CatalogOverlay;
}

/**
 * Files an in-flight edit would write, keyed by catalog-relative `/`-separated path: the text to parse
 * instead of what is on disk, or `null` for a file the edit removes.
 *
 * This is how an authoring mutation validates its own *result* before writing it. The alternative — write, validate, undo — leaves a window in which the catalog on disk is
 * broken, which is the one thing rule 4 exists to prevent.
 */
export type CatalogOverlay = ReadonlyMap<string, string | null>;

/** Nothing pending: what every read path outside an edit parses through. */
const NO_OVERLAY: CatalogOverlay = new Map();

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
  /**
   * What this skill pulls into a bundle with it, each entry naming its own namespace — see
   * {@link Requirement}. In the order the author wrote them.
   */
  readonly requires: readonly Requirement[];
  /** Env vars the skill itself reads, not via an MCP. */
  readonly env: readonly string[];
}

/** An MCP entity as one catalog declares it, carrying the document it was read from. */
export interface CatalogMcp extends McpEntity {
  /**
   * The file that defines it, relative to the catalog root — whichever §3.3 extension it actually
   * carries.
   *
   * Carried from parsing rather than derived from the name, because `mcps/<name>.yml` is only the
   * extension ambit *writes*: an entity spelled `.yaml` has no `.yml` for an error to send a reader
   * to. Parsing already knows which one is there, so nothing downstream has to ask the
   * filesystem again — or guess.
   */
  readonly file: string;
}

/** A hook as one catalog declares it, carrying the directory it was read from. */
export interface CatalogHook extends HookEntity {
  /** The hook directory, relative to the catalog root, `/`-separated. */
  readonly path: string;
}

/** One parsed catalog. */
export interface Catalog {
  readonly name: string;
  /** The `source` it was resolved from, as written in config. */
  readonly source: string;
  /**
   * The `ref` its config entry asked for, as written. Absent when the entry named none, which
   * means the source's default branch. Carried alongside `commit` because the lock records both:
   * the commit says what was installed, the ref says what will be resolved next time.
   */
  readonly ref?: string;
  /** Absolute path to the catalog root on disk. */
  readonly root: string;
  /**
   * The commit its contents are, for a git source. Absent for a `path:` source, which has no
   * revision — a working directory is whatever it currently says.
   */
  readonly commit?: string;
  /** Registered scopes, sorted by name. */
  readonly scopes: readonly ScopeDefinition[];
  /** Skills, sorted by name. */
  readonly skills: readonly CatalogSkill[];
  /** MCP entities, sorted by name. */
  readonly mcps: readonly CatalogMcp[];
  /** Hooks, sorted by name. */
  readonly hooks: readonly CatalogHook[];
}

/** A skill in the merged view, tagged with the catalog it came from. */
export interface MergedSkill extends CatalogSkill {
  readonly catalog: string;
  /**
   * The commit the skill's bytes came from, when its source has one: a catalog skill inherits its
   * catalog's, and a `source` skill carries its own. Absent for a `path:` source.
   *
   * Recorded per skill rather than left to the catalog entry alone because a `source` skill has no
   * catalog entry to inherit from, and pinning it is the whole point of the lock.
   */
  readonly commit?: string;
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
  /**
   * The file that defines it inside that catalog, catalog-relative — see {@link CatalogMcp.file}.
   *
   * Absent for an entity a project declares inline in its `ambit.yml`, which has no
   * document of its own. There is nothing to invent in that case: `catalog` already names the config
   * file, which is where a reader goes to change it, so an error still has a real file to cite.
   */
  readonly file?: string;
}

/**
 * A hook in the merged view, tagged with the catalog it came from.
 *
 * The union of what {@link MergedSkill} needs and what {@link MergedMcp} needs, because a hook is both
 * kinds of thing at once: it renders into a harness's config file, and — when it ships a script — it
 * also materializes a directory.
 */
export interface MergedHook extends HookEntity {
  readonly catalog: string;
  /**
   * The hook directory inside that catalog, catalog-relative.
   *
   * Absent for a hook a project declares inline in its `ambit.yml`, which has no directory of its own
   * — the same argument {@link MergedMcp.file} makes: `catalog` already names the config file, which
   * is where a reader goes to change it.
   *
   * Load-bearing beyond attribution, and this is the one place that says so: its absence is what makes
   * a `type: script` hook's `command` project-relative rather than directory-relative. There are only
   * the two anchors, and a hook has a directory or it does not — so `path` answers "which one" for
   * {@link hookCommand} and for materialization (`planHookDir`, `harness/profile.ts`) without a second
   * field that could disagree with it.
   */
  readonly path?: string;
  /** The commit the hook's bytes came from, when its catalog has one — see {@link MergedSkill.commit}. */
  readonly commit?: string;
  /**
   * Absolute path to that catalog's root on disk, so materialization can find the script without
   * looking the catalog up again. Absent for an inline hook, and deliberately absent from every
   * output surface: it is machine-specific.
   */
  readonly catalogRoot?: string;
}

/**
 * One name more than one catalog provides.
 *
 * Recorded rather than merely resolved, because the loss is otherwise silent in a way nobody can
 * debug: someone who adds a personal catalog and finds their copy of a skill ignored has no way to
 * see that a company catalog earlier in the list is the one being installed. Which copy *should*
 * win is not ambit's call — config order already decided that — but that a choice was made has to
 * be visible.
 */
export interface Shadowing {
  readonly name: string;
  /** The catalog whose copy is in the merged view: the earliest in config order. */
  readonly catalog: string;
  /** The catalogs whose copies were dropped, in config order — so the list reads as priority does. */
  readonly shadows: readonly string[];
}

/** Every shadowed name, keyed by name within each namespace. Empty when nothing collided. */
export interface Shadowings {
  readonly skills: ReadonlyMap<string, Shadowing>;
  readonly mcps: ReadonlyMap<string, Shadowing>;
  readonly hooks: ReadonlyMap<string, Shadowing>;
}

/** Every configured catalog, merged into one namespace per kind. */
export interface MergedCatalog {
  /** Catalog names, in config order — which is priority order. */
  readonly catalogs: readonly string[];
  readonly scopes: readonly ScopeDefinition[];
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
  readonly hooks: readonly MergedHook[];
  /** Which names came from more than one catalog, for `--explain` and `validate`. */
  readonly shadowing: Shadowings;
}

/**
 * How a shadowing reads in `--explain`: `catalog:company (shadows personal)`.
 *
 * The winning catalog is named even though the item's own `catalog` column already says it, so the
 * annotation still answers "which copy is this?" when it is read on its own — which is how it is
 * read, one row at a time.
 */
export function formatShadowing(shadowing: Shadowing): string {
  return `catalog:${shadowing.catalog} (shadows ${shadowing.shadows.join(", ")})`;
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

/** One entry of a catalog directory, as parsing sees it. */
interface CatalogEntry {
  readonly name: string;
  readonly directory: boolean;
}

function byEntryName(entries: readonly CatalogEntry[]): readonly CatalogEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Directory entries in name order, so a catalog parses identically whatever the filesystem says. */
async function sortedEntries(dir: string): Promise<readonly CatalogEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return byEntryName(
    entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
  );
}

/**
 * A catalog's files, read through an edit's pending contents where it has any.
 *
 * Every read parsing does goes through here, so an authoring command validating its own result sees
 * exactly what the next `ambit catalog validate` would see — including files the edit creates, which
 * are in no directory listing yet, and files it removes, which are still in one.
 */
class CatalogFiles {
  constructor(
    private readonly root: string,
    private readonly overlay: CatalogOverlay,
  ) {}

  private absolute(relative: string): string {
    return path.join(this.root, relative);
  }

  async isFile(relative: string): Promise<boolean> {
    const pending = this.overlay.get(relative);
    if (pending !== undefined) return pending !== null;
    return isFile(this.absolute(relative));
  }

  /** Whether a directory holds anything: on disk, or only in the edit. */
  async isDirectory(relative: string): Promise<boolean> {
    if (await isDirectory(this.absolute(relative))) return true;
    const prefix = `${relative}/`;
    return [...this.overlay].some(([file, text]) => text !== null && file.startsWith(prefix));
  }

  /** The entries of a directory, in name order, with the edit's additions and removals applied. */
  async entries(relative: string): Promise<readonly CatalogEntry[]> {
    const found = new Map<string, boolean>();
    if (await isDirectory(this.absolute(relative))) {
      for (const entry of await sortedEntries(this.absolute(relative))) {
        found.set(entry.name, entry.directory);
      }
    }

    const prefix = relative === "" ? "" : `${relative}/`;
    for (const [file, text] of this.overlay) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        if (text === null) found.delete(rest);
        else found.set(rest, false);
      } else if (text !== null) {
        found.set(rest.slice(0, slash), true);
      }
      // A removal deeper down leaves the directories above it listed: the walk simply finds no
      // `SKILL.md` inside, which is the same answer as an emptied directory on disk.
    }

    return byEntryName([...found].map(([name, directory]) => ({ name, directory })));
  }

  /** Parses a YAML file under the §3.0 rules. */
  async mapping(relative: string): Promise<YamlMapping> {
    const pending = this.overlay.get(relative);
    return typeof pending === "string"
      ? parseYamlMapping(pending, relative)
      : readYamlMapping(this.absolute(relative), relative);
  }

  /** Parses a Markdown file's frontmatter block under the §3.0 rules. */
  async frontmatter(relative: string): Promise<YamlMapping> {
    const pending = this.overlay.get(relative);
    return typeof pending === "string"
      ? parseFrontmatterMapping(pending, relative)
      : readFrontmatterMapping(this.absolute(relative), relative);
  }
}

/**
 * Resolves a catalog's `source` to a directory on disk, fetching it if it is a git source.
 *
 * @param file how the config file is named in errors. Catalog entries carry no line of their own, so
 *   the message names the file alone.
 * @throws {AmbitError} exit 2 for a source ambit cannot read, a missing directory, or an unknown
 *   ref; exit 4 if a fetch fails.
 */
export async function resolveCatalogRoot(
  catalog: CatalogRef,
  context: SourceContext,
  file: string,
): Promise<ResolvedSource> {
  return resolveSource(
    {
      source: catalog.source,
      ...(catalog.ref !== undefined && { ref: catalog.ref }),
      subject: `catalog "${catalog.name}"`,
      where: at(file, undefined),
    },
    context,
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

/**
 * The name↔path convention: the path under `skills/` — or under `hooks/` — with `/` → `.`.
 *
 * One function for both namespaces rather than one each, because it is one convention: a hook is
 * named from its directory exactly as a skill is, and two copies of the rule could drift.
 */
export function skillNameFromPath(relative: string): string {
  return relative.replaceAll("/", ".");
}

/**
 * Every directory under `parent` holding `marker`, relative to `parent` and `/`-separated.
 *
 * The walk skills and hooks share: both are named from their path under one directory, and both are
 * found by the file that marks one.
 */
async function findEntityDirectories(
  files: CatalogFiles,
  parent: string,
  marker: string,
): Promise<readonly string[]> {
  if (!(await files.isDirectory(parent))) return [];

  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await files.entries(relative === "" ? parent : `${parent}/${relative}`)) {
      if (entry.directory) {
        await walk(relative === "" ? entry.name : `${relative}/${entry.name}`);
      } else if (entry.name === marker) {
        found.push(relative);
      }
    }
  };

  await walk("");
  return found;
}

/** Every skill directory under `skills/`, relative to it and `/`-separated. */
async function findSkillDirectories(files: CatalogFiles): Promise<readonly string[]> {
  return findEntityDirectories(files, SKILLS_DIRNAME, SKILL_FILENAME);
}

/** Every hook directory under `hooks/`, relative to it and `/`-separated. */
async function findHookDirectories(files: CatalogFiles): Promise<readonly string[]> {
  return findEntityDirectories(files, HOOKS_DIRNAME, HOOK_FILENAME);
}

/**
 * What ambit reads off a skill's frontmatter once its name is settled.
 *
 * Two opposite stances on unknown keys, and both are deliberate. At the top level they are allowed,
 * unlike everywhere else, because that block is the harness's and ambit is a guest in it. Under
 * `ambit:` they are rejected like everywhere else, because that block is ambit's: a misspelled
 * `scope:` there would otherwise be a skill that declares nothing and warns nobody, which is the
 * same silence the namespace exists to remove.
 *
 * @throws {AmbitError} exit 2 for an `ambit:` that is not a mapping, or a key under it that §3.2
 *   does not define.
 */
function skillAnnotations(mapping: YamlMapping): Omit<CatalogSkill, "name" | "path"> {
  const description = mapping.optionalString("description");
  const ambit = mapping.optionalMapping(AMBIT_FRONTMATTER_KEY);
  ambit?.rejectUnknownKeys(ANNOTATION_KEYS);

  return {
    ...(description !== undefined && { description }),
    scopes: ambit?.optionalStringList("scopes") ?? [],
    requires: ambit === undefined ? [] : parseRequirements(ambit, "requires"),
    env: ambit?.optionalStringList("env") ?? [],
  };
}

/**
 * Parses one skill directory.
 *
 * @param collect when given, a name that disagrees with its path is reported through it and the
 *   path's name is used, rather than thrown — see {@link CatalogParseOptions}.
 */
async function parseSkill(
  files: CatalogFiles,
  relative: string,
  collect?: (problem: AmbitError) => void,
): Promise<CatalogSkill> {
  const file = `${SKILLS_DIRNAME}/${relative}/${SKILL_FILENAME}`;

  if (relative === "") {
    throw configError(`${SKILLS_DIRNAME}/${SKILL_FILENAME} is not inside a skill directory`, [
      "a skill's name is its path under `skills/`, so it needs at least one directory",
      `move it to ${SKILLS_DIRNAME}/<name>/${SKILL_FILENAME}`,
    ]);
  }

  const mapping = await files.frontmatter(file);

  const name = mapping.requireString("name");
  const derived = skillNameFromPath(relative);
  if (name !== derived) {
    const problem = mapping.keyError("name", `skill name "${name}" does not match its path`, [
      `${file} derives the name "${derived}"`,
      "rename the directory, or correct `name` to match it",
    ]);
    if (collect === undefined) throw problem;
    collect(problem);
  }

  // The path's name, always: it is what every other tool would install the skill under, so it is
  // the answer that keeps a collected disagreement from cascading into a second, invented problem.
  return { name: derived, path: `${SKILLS_DIRNAME}/${relative}`, ...skillAnnotations(mapping) };
}

/** MCP entity stems under `mcps/`, each with the one file that defines it. */
async function findMcpFiles(
  files: CatalogFiles,
): Promise<readonly { stem: string; file: string }[]> {
  if (!(await files.isDirectory(MCPS_DIRNAME))) return [];

  const byStem = new Map<string, string[]>();
  for (const entry of await files.entries(MCPS_DIRNAME)) {
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

async function parseMcpFile(files: CatalogFiles, stem: string, file: string): Promise<CatalogMcp> {
  const mapping = await files.mapping(file);
  const entity = parseMcpEntity(mapping);

  if (entity.name !== stem) {
    throw mapping.keyError("name", `MCP name "${entity.name}" does not match its filename`, [
      `${file} declares the name "${stem}"`,
      `rename the file to ${MCPS_DIRNAME}/${entity.name}${MCP_EXTENSIONS[0]!}, or correct \`name\``,
    ]);
  }

  return { ...entity, file };
}

/**
 * How one harness spells the two places a `type: script` hook's script can be.
 *
 * A profile declares both because the anchoring is the harness's problem rather than the hook's: a
 * script has to be named the way *that* harness resolves a path, and there are two roots to name — the
 * shared directory ambit materializes a catalog hook's script into, and the project root an inline
 * hook's script is already somewhere under. Chosen per harness in `harness/definitions.ts`.
 */
export interface HookRoots {
  /** Where materialized hook directories sit, so a shipped script is at `<hooks>/<name>/<script>`. */
  readonly hooks: string;
  /**
   * How this harness spells the project root, for a script the project itself holds.
   *
   * Absent for a harness that interpolates nothing in a `command`: there the path as written *is* the
   * way there, since the harness resolves a relative command against the project root already, and a
   * prefix would be a directory name invented in front of a path that was correct.
   */
  readonly project?: string;
}

/**
 * One hook's `command` as a harness should read it: a script's path anchored to wherever it actually is.
 *
 * The rewrite is the whole reason a hook can name a script at all. A catalog declares
 * `command: guard.sh`, which names a file relative to the hook's own directory — a location that exists
 * in the catalog and nowhere a harness looks. Once installed the script sits at
 * `<roots.hooks>/<name>/guard.sh`. An inline hook declares `command: scripts/guard.sh`, which names a
 * file relative to the project root — already a real location, so nothing is materialized and the path
 * only has to be anchored: `<roots.project>/scripts/guard.sh`, or left as written for a harness that
 * resolves a relative command against the project root itself.
 *
 * Which of the two applies is `hook.path`: a hook with a directory names a file inside it, and a hook
 * without one names a file in the repo that declared it. See {@link MergedHook.path}.
 *
 * Only the program is rewritten. Everything after the first token is arguments, and a `command` is a
 * shell fragment ambit does not parse: rewriting inside it would corrupt a quoted string or a path that
 * means something to the program rather than to ambit. So `guard.sh --strict` becomes
 * `<roots.hooks>/<name>/guard.sh --strict`, and the arguments arrive exactly as written.
 *
 * A `type: command` hook is returned verbatim, which is most of them: `npx --yes prettier` is a command
 * line the harness runs as-is, and prefixing it with a directory would break it.
 */
export function hookCommand(hook: MergedHook, roots: HookRoots): string {
  if (hook.type !== "script") return hook.command;

  const command = hook.command.trim();
  const program = commandProgram(command);
  const reference = scriptReference(program);
  const anchor = hook.path === undefined ? roots.project : `${roots.hooks}/${hook.name}`;
  const script = anchor === undefined ? reference : `${anchor}/${reference}`;
  return `${script}${command.slice(program.length)}`;
}

/** Every file a hook's directory holds besides its own `HOOK.yml`, in path order. */
async function hookDirectoryContents(
  files: CatalogFiles,
  directory: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await files.entries(
      relative === "" ? directory : `${directory}/${relative}`,
    )) {
      const within = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.directory) await walk(within);
      else if (within !== HOOK_FILENAME) found.push(within);
    }
  };

  await walk("");
  return found;
}

/**
 * Asserts that a `type: script` hook ships the file its `command` names.
 *
 * The declaration says a script is there; this is the catalog being asked whether it is. A hook that
 * claims a file it does not hold is refused naming the directory's contents, because installing it
 * would write a command pointing at bytes that never arrive — a hook that cannot run, and says nothing
 * about why.
 *
 * The shape of the reference was already settled by the parser, so what is left here is existence
 * alone. A `type: command` hook is never asked: its `command` is a command line, and whether a file of
 * that name happens to sit in the directory is a coincidence.
 *
 * @param name the hook's name as its path derives it, which is what it will be installed under.
 * @throws {AmbitError} exit 2 for a `command` that names a file the directory does not hold.
 */
async function assertScriptShipped(
  files: CatalogFiles,
  mapping: YamlMapping,
  directory: string,
  name: string,
  command: string,
): Promise<void> {
  const reference = scriptReference(commandProgram(command));
  if (await files.isFile(`${directory}/${reference}`)) return;

  const contents = await hookDirectoryContents(files, directory);
  throw mapping.keyError("command", `hook "${name}" ships no ${reference}`, [
    `\`type: script\` means \`command\` names a file ${directory} holds`,
    contents.length === 0
      ? `${directory} holds nothing but ${HOOK_FILENAME}`
      : `${directory} holds: ${contents.join(", ")}`,
    "correct the name, add the file to the hook's directory, or say `type: command` instead",
  ]);
}

/**
 * Parses one hook directory.
 *
 * A disagreement between `name` and the path is thrown rather than collected, unlike a skill's: the
 * recovery there exists because every other tool installs a skill under its path's name, and nothing
 * but ambit reads a `hooks/` directory at all.
 *
 * @throws {AmbitError} exit 2 for a malformed document, a `name` that disagrees with the path, or a
 *   `command` naming a file the directory does not hold.
 */
async function parseHookDirectory(files: CatalogFiles, relative: string): Promise<CatalogHook> {
  if (relative === "") {
    throw configError(`${HOOKS_DIRNAME}/${HOOK_FILENAME} is not inside a hook directory`, [
      "a hook's name is its path under `hooks/`, so it needs at least one directory",
      `move it to ${HOOKS_DIRNAME}/<name>/${HOOK_FILENAME}`,
    ]);
  }

  const directory = `${HOOKS_DIRNAME}/${relative}`;
  const file = `${directory}/${HOOK_FILENAME}`;
  const mapping = await files.mapping(file);
  const entity = parseHookEntity(mapping, "catalog");

  const derived = skillNameFromPath(relative);
  if (entity.name !== derived) {
    throw mapping.keyError("name", `hook name "${entity.name}" does not match its path`, [
      `${file} derives the name "${derived}"`,
      "rename the directory, or correct `name` to match it",
    ]);
  }

  if (entity.type === "script") {
    await assertScriptShipped(files, mapping, directory, derived, entity.command);
  }

  return { ...entity, path: directory };
}

/**
 * Adds where an error came from, so a message about `skills/a/b/SKILL.md` says which of several
 * sources holds that path. Prepended, keeping the concrete next step last.
 *
 * @param subject the source as errors name it: `catalog "company"`.
 */
function inSource(subject: string, root: string, error: unknown): unknown {
  if (!(error instanceof AmbitError)) return error;
  return new AmbitError(error.code, error.message, [`in ${subject} (${root})`, ...error.detail]);
}

/**
 * The same attribution for a *collected* problem, naming the catalog but not its root.
 *
 * The root is a machine path — a cache checkout, for a git source — and a collected problem is
 * printed as part of a report rather than as a fatal error, which is output tests compare
 * byte-for-byte across machines. The catalog's name is what disambiguates two catalogs holding the
 * same relative path anyway.
 */
function fromCatalog(name: string, problem: AmbitError): AmbitError {
  return new AmbitError(problem.code, problem.message, [`in catalog "${name}"`, ...problem.detail]);
}

/**
 * Parses the catalog rooted at `root`.
 *
 * @param name the catalog's name, as errors report it.
 * @param source the `source` it was resolved from.
 * @param commit the commit the directory holds, for a git source.
 * @param options a collector for the one problem parsing can continue past, and an edit's pending
 *   files to read through — see {@link CatalogParseOptions}.
 * @throws {AmbitError} exit 2 for a missing registry, a malformed file, or a name that
 *   disagrees with its path.
 */
export async function parseCatalogDirectory(
  name: string,
  source: string,
  root: string,
  commit?: string,
  options: CatalogParseOptions = {},
): Promise<Catalog> {
  const collect = options.collect;
  const collectFromCatalog =
    collect === undefined
      ? undefined
      : (problem: AmbitError) => collect(fromCatalog(name, problem));
  const files = new CatalogFiles(root, options.overlay ?? NO_OVERLAY);

  try {
    if (!(await files.isFile(SCOPES_FILENAME))) {
      throw configError(`${SCOPES_FILENAME} is missing`, [
        "a catalog must register every scope its skills and MCPs declare",
        `add ${SCOPES_FILENAME} at the catalog root`,
      ]);
    }

    const scopes = parseScopeRegistry(await files.mapping(SCOPES_FILENAME));

    const skills: CatalogSkill[] = [];
    for (const relative of await findSkillDirectories(files)) {
      skills.push(await parseSkill(files, relative, collectFromCatalog));
    }

    const mcps: CatalogMcp[] = [];
    for (const { stem, file } of await findMcpFiles(files)) {
      mcps.push(await parseMcpFile(files, stem, file));
    }

    const hooks: CatalogHook[] = [];
    for (const relative of await findHookDirectories(files)) {
      hooks.push(await parseHookDirectory(files, relative));
    }

    return {
      name,
      source,
      root,
      ...(commit !== undefined && { commit }),
      scopes,
      skills: byName(skills),
      mcps: byName(mcps),
      hooks: byName(hooks),
    };
  } catch (error) {
    throw inSource(`catalog "${name}"`, root, error);
  }
}

/**
 * Loads every catalog the config declares, in config order.
 *
 * Sequential rather than concurrent: two catalogs can be two refs of one repository, and a shared
 * cache directory is not something two fetches may race over.
 *
 * @param options a collector for the one problem parsing can continue past — see
 *   {@link CatalogParseOptions}.
 * @throws {AmbitError} exit 2 for an unresolvable source or a malformed catalog; exit 4 if a fetch
 *   fails.
 */
export async function loadCatalogs(
  config: ProjectConfig,
  context: SourceContext,
  options: CatalogParseOptions = {},
): Promise<readonly Catalog[]> {
  const catalogs: Catalog[] = [];
  for (const entry of config.catalogs) {
    const resolved = await resolveCatalogRoot(entry, context, config.origin.file);
    const parsed = await parseCatalogDirectory(
      entry.name,
      entry.source,
      resolved.root,
      resolved.commit,
      options,
    );
    // `ref` is a fact about the config entry, not about the directory that was parsed, so it is
    // attached here rather than threaded through parsing — which also keeps a catalog parsed
    // straight off disk (`ambit catalog validate`) from having to invent one.
    catalogs.push({ ...parsed, ...(entry.ref !== undefined && { ref: entry.ref }) });
  }
  return catalogs;
}

/** Where a skill sits inside a source that follows the catalog convention. */
function skillPathFromName(name: string): string {
  return `${SKILLS_DIRNAME}/${name.replaceAll(".", "/")}`;
}

/**
 * Loads one skill declared with its own `source` rather than through a catalog.
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
 * @throws {AmbitError} exit 2 for a source ambit cannot read, a skill directory that is not there,
 *   malformed frontmatter, or a `name` that disagrees with the config's; exit 4 if a fetch fails.
 */
export async function loadSourceSkill(
  request: SourceSkillRequest,
  context: SourceContext,
  origin: ConfigOrigin,
): Promise<MergedSkill> {
  const subject = `skill "${request.name}"`;
  const where = at(origin.file, origin.skillLines.get(request.name));
  const source: SourceRequest = {
    source: request.source,
    ...(request.ref !== undefined && { ref: request.ref }),
    subject,
    where,
  };
  const { root, commit } = await resolveSource(source, context);

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
      ...(commit !== undefined && { commit }),
      catalogRoot: root,
    };
  } catch (error) {
    throw inSource(`skill source "${request.source}"`, root, error);
  }
}

/**
 * The error for a config declaration a catalog already provides.
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
 * `source`, inline `mcps`, and inline `hooks`.
 *
 * They join the same namespace rather than sitting beside it, so resolution has exactly one place
 * to look a name up — which also lets a catalog skill's `requires` reach a server the project
 * defined inline.
 *
 * @throws {AmbitError} exit 2 for a skill source that cannot be read; exit 3 for a name a catalog
 *   already provides; exit 4 if a fetch fails.
 */
export async function mergeConfigEntities(
  merged: MergedCatalog,
  config: ProjectConfig,
  context: SourceContext,
): Promise<MergedCatalog> {
  const skills = [...merged.skills];
  const mcps = [...merged.mcps];
  const hooks = [...merged.hooks];

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
    skills.push(await loadSourceSkill(request, context, config.origin));
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

  for (const entity of config.hooks) {
    const shadowed = merged.hooks.find((hook) => hook.name === entity.name);
    if (shadowed !== undefined) {
      throw declarationConflict(
        "hook",
        entity.name,
        shadowed.catalog,
        at(config.origin.file, config.origin.hookLines.get(entity.name)),
        "remove the `hooks` entry to take the catalog's, or rename one of the two",
      );
    }
    // No `path`, and that is the whole of what an inline hook is: a command line, or a script the
    // consuming repo already holds at a project-relative path. Either way there is no directory for
    // ambit to materialize, and nothing here for it to own.
    hooks.push({ ...entity, catalog: config.origin.file });
  }

  return { ...merged, skills: byName(skills), mcps: byName(mcps), hooks: byName(hooks) };
}

/** One scope registration, remembering which catalog made it so a conflict can name both. */
interface RegisteredScope {
  readonly catalog: string;
  readonly definition: ScopeDefinition;
}

/**
 * The error for one scope two catalogs describe differently.
 *
 * Identical descriptions merge silently — two catalogs agreeing about a shared scope is how a
 * company catalog and a personal one are meant to overlap. Disagreeing ones are rejected because
 * the description is what a consuming tool shows a human in the picker, and quietly
 * keeping one of two contradictory labels would make a project's own catalog order decide what a
 * scope appears to mean.
 */
function scopeDescriptionConflict(first: RegisteredScope, second: RegisteredScope): AmbitError {
  const name = first.definition.name;
  return resolutionError(`conflicting descriptions for scope "${name}" (${SCOPES_FILENAME})`, [
    `catalog "${first.catalog}" describes it as "${first.definition.description}"`,
    `catalog "${second.catalog}" describes it as "${second.definition.description}"`,
    "make the two descriptions identical, or rename the scope in one of the two catalogs",
  ]);
}

/**
 * Notes that `loser` also provides `name`, which `winner` already did.
 *
 * Appends rather than replaces, so a name three catalogs provide records both losers in the order
 * config listed them.
 */
function recordShadowing(
  shadowed: Map<string, Shadowing>,
  name: string,
  winner: string,
  loser: string,
): void {
  const existing = shadowed.get(name);
  shadowed.set(name, {
    name,
    catalog: winner,
    shadows: [...(existing?.shadows ?? []), loser],
  });
}

/** A name-keyed map in name order, so iterating it never depends on the order catalogs were read. */
function mapByName<T>(entries: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  return new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Merges catalogs into one namespace per kind.
 *
 * On a duplicate skill, MCP or hook name the earlier catalog in config order wins, and the shadowing is
 * recorded rather than discarded — see {@link Shadowing}. Scope registries merge on
 * matching descriptions and are rejected on differing ones.
 *
 * A config-declared skill or server colliding with a catalog is deliberately *not* this: that is an
 * error, not a precedence question, because both config surfaces are for
 * things no catalog defines. See {@link mergeConfigEntities}.
 *
 * @throws {AmbitError} exit 3 for one scope two catalogs describe differently.
 */
export function mergeCatalogs(catalogs: readonly Catalog[]): MergedCatalog {
  const scopes = new Map<string, RegisteredScope>();
  const skills = new Map<string, MergedSkill>();
  const mcps = new Map<string, MergedMcp>();
  const hooks = new Map<string, MergedHook>();
  const shadowedSkills = new Map<string, Shadowing>();
  const shadowedMcps = new Map<string, Shadowing>();
  const shadowedHooks = new Map<string, Shadowing>();

  for (const catalog of catalogs) {
    for (const definition of catalog.scopes) {
      const registered = scopes.get(definition.name);
      const here: RegisteredScope = { catalog: catalog.name, definition };
      if (registered === undefined) {
        scopes.set(definition.name, here);
      } else if (registered.definition.description !== definition.description) {
        throw scopeDescriptionConflict(registered, here);
      }
    }

    for (const skill of catalog.skills) {
      const winner = skills.get(skill.name);
      if (winner !== undefined) {
        recordShadowing(shadowedSkills, skill.name, winner.catalog, catalog.name);
        continue;
      }
      skills.set(skill.name, {
        ...skill,
        catalog: catalog.name,
        ...(catalog.commit !== undefined && { commit: catalog.commit }),
        catalogRoot: catalog.root,
      });
    }

    for (const mcp of catalog.mcps) {
      const winner = mcps.get(mcp.name);
      if (winner !== undefined) {
        recordShadowing(shadowedMcps, mcp.name, winner.catalog, catalog.name);
        continue;
      }
      mcps.set(mcp.name, { ...mcp, catalog: catalog.name });
    }

    for (const hook of catalog.hooks) {
      const winner = hooks.get(hook.name);
      if (winner !== undefined) {
        recordShadowing(shadowedHooks, hook.name, winner.catalog, catalog.name);
        continue;
      }
      // `catalogRoot` for the same reason a skill carries one: a hook that ships a script is
      // materialized out of the catalog it came from, and nothing downstream should have to look the
      // catalog up again to find it.
      hooks.set(hook.name, {
        ...hook,
        catalog: catalog.name,
        ...(catalog.commit !== undefined && { commit: catalog.commit }),
        catalogRoot: catalog.root,
      });
    }
  }

  return {
    catalogs: catalogs.map((catalog) => catalog.name),
    scopes: byName([...scopes.values()].map((registered) => registered.definition)),
    skills: byName([...skills.values()]),
    mcps: byName([...mcps.values()]),
    hooks: byName([...hooks.values()]),
    shadowing: {
      skills: mapByName(shadowedSkills),
      mcps: mapByName(shadowedMcps),
      hooks: mapByName(shadowedHooks),
    },
  };
}

/**
 * Catalog parsing.
 *
 * A catalog is a plain skills repo, and nothing else: skills at `skills/<name>/SKILL.md`, MCP
 * entities at `mcps/<name>.yml`, hooks at `hooks/<name>/hook.yml`. Nothing here is ambit-specific
 * except one extra frontmatter key and the extra directories, which other tools ignore — that
 * compatibility is a hard requirement.
 *
 * There is no catalog-side config: parsing scans those three directories and takes what is there.
 * A file at the root ambit would read as a *project's* config is therefore ignored rather than
 * refused, because a project that publishes its own items lists itself as `source: path:.` — so a
 * directory that is both a catalog and a project is the ordinary case, not a mistake.
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
 * Every definition ambit reads arrives this way. A project that ships a skill, a server or a hook of
 * its own puts it in `skills/`, `mcps/` or `hooks/` and lists itself as a catalog, so there is one
 * kind of thing to merge and resolution has exactly one place to look a name up.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { CatalogRef, ProjectConfig } from "./config.js";
import { AmbitError, at, configError } from "../errors.js";
import type { RefreshMode } from "./git.js";
import type { HookEntity } from "./hook-entity.js";
import { commandProgram, parseHookEntity, scriptReference } from "./hook-entity.js";
import type { McpEntity } from "./mcp-entity.js";
import { parseMcpEntity } from "./mcp-entity.js";
import type { Expectation } from "./expectation.js";
import { parseExpectations } from "./expectation.js";
import type { PatternEntry } from "./pattern.js";
import { parseEntries } from "./pattern.js";
import type { ResolvedSource, SourceContext } from "./sources.js";
import { resolveSource } from "./sources.js";
import type { YamlMapping } from "./yaml.js";
import { readFrontmatterMapping, readYamlMapping } from "./yaml.js";

/**
 * The registry a catalog used to carry, kept only so its presence can be refused.
 *
 * Not exported: nothing reads this file any more, and the one thing left to say about it is the
 * rewrite in {@link removedRegistry}.
 */
const REMOVED_REGISTRY_FILENAME = "scopes.yml";

/** Where skills live within a catalog. */
export const SKILLS_DIRNAME = "skills";

/** Where MCP entities live within a catalog. */
export const MCPS_DIRNAME = "mcps";

/** Where hooks live within a catalog. */
export const HOOKS_DIRNAME = "hooks";

/**
 * The file whose presence makes a directory a skill.
 *
 * Uppercase because ambit does not get to choose: harnesses and other tools walk
 * `skills/<name>/SKILL.md` already, and this is that file.
 */
export const SKILL_FILENAME = "SKILL.md";

/**
 * The file whose presence makes a directory a hook.
 *
 * A hook is always a directory, like a skill and unlike an MCP entity, because a hook may ship its
 * own script — and one that does not is a directory holding only this file, so both kinds are found,
 * named and materialized the same way.
 *
 * Lowercase, unlike {@link SKILL_FILENAME}, because nothing outside ambit reads it — so it is spelled
 * like every other file ambit owns: `ambit.yml`, `ambit.lock`, `mcps/<name>.yml`.
 */
export const HOOK_FILENAME = "hook.yml";

/**
 * MCP entity extensions, in preference order. One stem carrying both is an error.
 *
 * Both are read because both are what an author may have written; `.yml` is the one ambit names in a
 * refusal, since a message telling someone to rename a file has to pick one.
 */
export const MCP_EXTENSIONS: readonly string[] = [".yml", ".yaml"];

/**
 * The one top-level `SKILL.md` frontmatter key ambit owns.
 *
 * Every annotation lives under it, so the block a harness reads and the block ambit reads cannot
 * collide however either grows: a harness that one day defines its own `tags` or `requires` takes
 * the top-level name, and ambit's are a level down where they always were. The cost is one line of
 * nesting; the alternative was a standing bet that no harness ever picks those two words.
 */
export const AMBIT_FRONTMATTER_KEY = "ambit";

/**
 * The keys ambit reads under {@link AMBIT_FRONTMATTER_KEY}, in the order the format tabulates them, so
 * a message about one of them reads like the format's own documentation.
 *
 * One list, in the layer that reads them, so nothing can drift apart on what an annotation is.
 */
export const ANNOTATION_KEYS = ["tags", "requires", "expects"] as const;

export type AnnotationKey = (typeof ANNOTATION_KEYS)[number];

/**
 * How a catalog is parsed when the caller wants every problem rather than only the first — the validation split.
 *
 * Only validation passes one — both `validate` commands. Everything else parses strictly, because a
 * resolution that carried on past a broken skill would install something nobody described.
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
}

/** A skill as the catalog declares it. */
export interface CatalogSkill {
  /** Derived from `path`, and equal to the frontmatter `name`. */
  readonly name: string;
  /** The skill directory, relative to the catalog root, `/`-separated. */
  readonly path: string;
  /** The harness's own summary, carried through to every report that lists the skill. */
  readonly description?: string;
  /**
   * Declared tags: free-form labels, registered nowhere and described nowhere, that a consumer can
   * select on. Empty means reachable by a `name:` entry or a `requires` edge, and by nothing else.
   */
  readonly tags: readonly string[];
  /**
   * What this skill pulls into a bundle with it: a `requires` list in the same entry grammar a
   * project selects with, minus the qualifier — see {@link PatternEntry}. In the order the author
   * wrote them.
   *
   * Unqualified, and therefore confined to this catalog: the alias belongs to the consumer's config,
   * so a catalog author cannot write one, and a catalog can only require what it ships.
   */
  readonly requires: readonly PatternEntry[];
  /**
   * What must be true of the world for this skill to work, each entry naming its own kind — see
   * {@link Expectation}. In the order the author wrote them.
   */
  readonly expects: readonly Expectation[];
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
  /**
   * Whether its `ref` is one that can move — a branch, a tag, or the source's default branch — as
   * against a `ref` naming a commit, which is already a pin.
   *
   * Present only when the load refreshed this catalog: it is `ambit outdated`'s question, and only a
   * run that reached the remote can answer it without guessing.
   */
  readonly moving?: boolean;
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
   * The commit the skill's bytes came from, inherited from its catalog. Absent for a `path:` source,
   * which has no revision.
   *
   * Recorded per skill rather than left to the catalog entry alone because pinning the bytes is the
   * whole point of the lock, and every surface that writes one reads the item rather than looking its
   * catalog up again.
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
   * Always present: every definition lives in a file, so there is no server without a document to
   * cite, and nothing downstream has to invent a location for one.
   */
  readonly file: string;
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
   * Always present, for the reason {@link MergedMcp.file} is: a hook is a directory holding
   * `hook.yml`, and there is no other way to declare one.
   */
  readonly path: string;
  /** The commit the hook's bytes came from, when its catalog has one — see {@link MergedSkill.commit}. */
  readonly commit?: string;
  /**
   * Absolute path to that catalog's root on disk, so materialization can find the script without
   * looking the catalog up again. Deliberately absent from every output surface: it is
   * machine-specific.
   */
  readonly catalogRoot: string;
}

/**
 * Every configured catalog, merged into one namespace per kind — every catalog's copy of every name.
 *
 * A name is not an identity here. Two catalogs may both provide `house-style`, and both copies
 * survive the merge, each identified by its catalog *and* its name — see {@link qualifiedName}. So
 * anything that keys, groups or looks up a merged item keys on the pair, and a lookup by name alone
 * answers with a set rather than an item.
 *
 * There is no name-keyed grouping helper here to do that with. One was added when the merge stopped
 * collapsing copies, on the expectation that the callers of the name-keyed `Map` it replaced would
 * want it, and not one of them did. `ambit why` wants a *filter*: one name it already has, in one
 * namespace it already knows, so grouping the whole namespace to read a single bucket out of it is
 * work for nothing. Resolution's collision check wants the opposite — every name at once — but keyed
 * by *catalog* rather than by item, since what its message needs is where each copy came from. Two
 * call sites, two shapes, neither of them a lookup.
 */
export interface MergedCatalog {
  /**
   * Catalog names, in config order.
   *
   * A record of what the config listed, and nothing more: the order settles nothing, because no
   * copy of a name is dropped and no catalog takes precedence over another.
   */
  readonly catalogs: readonly string[];
  readonly skills: readonly MergedSkill[];
  readonly mcps: readonly MergedMcp[];
  readonly hooks: readonly MergedHook[];
}

/**
 * What separates a catalog from a name in the address of a merged item.
 *
 * `/` rather than `.`, so an address introduces no phantom level into the dotted name space a
 * catalog already has — `company/core.a` is the item `core.a` in the catalog `company`, and a dot in
 * a catalog's alias needs no refusing.
 */
export const CATALOG_SEPARATOR = "/";

/**
 * The address of one item in the merged catalog: `<catalog>/<name>`.
 *
 * The identity a bare name stopped being once every catalog's copy survives the merge. Anything that
 * needs one string per item — a `Map` key, a JSON record key, a set of what a walk has already
 * followed — uses this, so two catalogs' copies of `house-style` cannot collapse into one entry by
 * accident, which is the silent loss the merge no longer performs.
 *
 * A *bundle* is the one view where a bare name is still an identity, and it is one because
 * resolution refuses a selection holding two copies of a name (`assertNoCollisions`) rather than
 * because the merge guarantees it.
 */
export function qualifiedName(item: { readonly catalog: string; readonly name: string }): string {
  return `${item.catalog}${CATALOG_SEPARATOR}${item.name}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One catalog's items in name order, which is a total order within a single catalog. */
function byName<T extends { readonly name: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * Merged items in name order, then catalog order.
 *
 * Name first, so two catalogs' copies of one name sit next to each other in every listing that walks
 * this — a reader scanning `dump-catalog` sees the pair rather than having to notice it. Catalog
 * second, because a name alone is no longer a total order, and an order that fell back to the order
 * catalogs happened to be read in would make every downstream listing depend on config order again.
 */
function byNameThenCatalog<T extends { readonly name: string; readonly catalog: string }>(
  items: readonly T[],
): readonly T[] {
  return [...items].sort(
    (a, b) => compareStrings(a.name, b.name) || compareStrings(a.catalog, b.catalog),
  );
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
 * A catalog's files, addressed the way its own errors and reports address them.
 *
 * Every read parsing does goes through here, which is what keeps a catalog-relative `/`-separated
 * path the only kind of path the walk below deals in: the root is joined on in one place, so nothing
 * that reports a file has an absolute one to accidentally print.
 *
 * It used to do more. An in-flight authoring edit handed its pending bytes to parsing as an overlay,
 * so a mutation could validate its own result before writing it, and every read had to consult that
 * overlay first. Nothing mutates a catalog any more, so the pending case is gone and these are five
 * plain reads.
 */
class CatalogFiles {
  constructor(private readonly root: string) {}

  private absolute(relative: string): string {
    return path.join(this.root, relative);
  }

  async isFile(relative: string): Promise<boolean> {
    return isFile(this.absolute(relative));
  }

  async isDirectory(relative: string): Promise<boolean> {
    return isDirectory(this.absolute(relative));
  }

  /** The entries of a directory, in name order, or none at all when it is not there. */
  async entries(relative: string): Promise<readonly CatalogEntry[]> {
    if (!(await isDirectory(this.absolute(relative)))) return [];
    return sortedEntries(this.absolute(relative));
  }

  /** Parses a YAML file under the §3.0 rules. */
  async mapping(relative: string): Promise<YamlMapping> {
    return readYamlMapping(this.absolute(relative), relative);
  }

  /** Parses a Markdown file's frontmatter block under the §3.0 rules. */
  async frontmatter(relative: string): Promise<YamlMapping> {
    return readFrontmatterMapping(this.absolute(relative), relative);
  }
}

/**
 * Resolves a catalog's `source` to a directory on disk, fetching it if it is a git source.
 *
 * @param file how the config file is named in errors. Catalog entries carry no line of their own, so
 *   the message names the file alone.
 * @param refresh how much of the remote this one catalog may consult. Defaults to `"none"`, which is
 *   every command but `ambit outdated` and `ambit update`.
 * @throws {AmbitError} exit 2 for a source ambit cannot read, a missing directory, or an unknown
 *   ref; exit 4 if a fetch fails.
 */
export async function resolveCatalogRoot(
  catalog: CatalogRef,
  context: SourceContext,
  file: string,
  refresh: RefreshMode = "none",
): Promise<ResolvedSource> {
  return resolveSource(
    {
      source: catalog.source,
      ...(catalog.ref !== undefined && { ref: catalog.ref }),
      subject: `catalog "${catalog.name}"`,
      where: at(file, undefined),
      refresh,
    },
    context,
  );
}

/**
 * The refusal for a catalog that still holds the registry.
 *
 * A hard break, and loud on purpose: the file parses as YAML and every scope in it looks like it is
 * still doing something, so silence would leave an author believing a catalog is labelled when
 * nothing in it is. The message carries the whole rewrite, since it is short enough to state.
 */
function removedRegistry(): AmbitError {
  return configError(`the scope registry is gone (${REMOVED_REGISTRY_FILENAME})`, [
    "scopes are gone; tag items with `ambit.tags` and select them with `tag:`",
    `delete ${REMOVED_REGISTRY_FILENAME}, carrying each scope over as a tag on the items that declared it`,
  ]);
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
 * `tag:` there would otherwise be a skill that declares nothing and warns nobody, which is the
 * same silence the namespace exists to remove.
 *
 * A *value* under `tags` is unguarded by contrast — a misspelled tag is a new tag, and nothing can
 * tell the difference. That is the cost of dropping the registry, paid here.
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
    tags: ambit?.optionalStringList("tags") ?? [],
    // Unqualified: a catalog author cannot write a consumer's alias, so the pattern stands alone and
    // the entry resolves within this catalog.
    requires: ambit === undefined ? [] : parseEntries(ambit, "unqualified"),
    expects: ambit === undefined ? [] : parseExpectations(ambit),
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
 * One hook's `command` as a harness should read it: a shipped script's path moved under `root`.
 *
 * The rewrite is the whole reason a hook can ship bytes. A catalog declares `command: guard.sh`, which
 * names a file relative to the hook's own directory — a location that exists in the catalog and nowhere
 * a harness looks. Once installed the script sits at `<root>/<name>/guard.sh`, and `root` is how each
 * harness spells the way there — its profile's `hookConfig` chooses it (`harness/definitions.ts`).
 *
 * Only the program is rewritten. Everything after the first token is arguments, and a `command` is a
 * shell fragment ambit does not parse: rewriting inside it would corrupt a quoted string or a path that
 * means something to the program rather than to ambit. So `guard.sh --strict` becomes
 * `<root>/<name>/guard.sh --strict`, and the arguments arrive exactly as written.
 *
 * A `type: command` hook is returned verbatim, which is most of them: `npx --yes prettier` is a command
 * line the harness runs as-is, and prefixing it with a directory would break it.
 */
export function hookCommand(hook: MergedHook, root: string): string {
  if (hook.type !== "script") return hook.command;

  const command = hook.command.trim();
  const program = commandProgram(command);
  const script = `${root}/${hook.name}/${scriptReference(program)}`;
  return `${script}${command.slice(program.length)}`;
}

/** Every file a hook's directory holds besides its own `hook.yml`, in path order. */
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
  const entity = parseHookEntity(mapping);

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
 * @param options a collector for the one problem parsing can continue past — see
 *   {@link CatalogParseOptions}.
 * @throws {AmbitError} exit 2 for a leftover scope registry, a malformed file, or a name that
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
  const files = new CatalogFiles(root);

  try {
    // The one file at a catalog root ambit still has an opinion about, and the opinion is that it
    // must not be there. Nothing else is read: a directory holding none of the three subdirectories
    // is a catalog with zero items, which the patterns selecting from it report far better than a
    // missing-file error here could.
    if (await files.isFile(REMOVED_REGISTRY_FILENAME)) throw removedRegistry();

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
      skills: byName(skills),
      mcps: byName(mcps),
      hooks: byName(hooks),
    };
  } catch (error) {
    throw inSource(`catalog "${name}"`, root, error);
  }
}

/**
 * How a load reaches each catalog's source, on top of what parsing needs.
 *
 * Separate from {@link CatalogParseOptions} because it is about the fetch rather than the parse:
 * `parseCatalogDirectory` is handed a directory and never learns where it came from, so a refresh has
 * nothing to say to it.
 */
export interface CatalogLoadOptions extends CatalogParseOptions {
  /**
   * How each catalog may consult its remote, keyed by catalog name.
   *
   * A name the map does not hold — and an absent map — resolves from the cache exactly as every other
   * command does. Per catalog rather than per run because `ambit update company` moves one pin: a
   * run-wide setting would move every catalog's, which is a pin nobody asked to move.
   */
  readonly refresh?: ReadonlyMap<string, RefreshMode>;
}

/**
 * Loads every catalog the config declares, in config order.
 *
 * Sequential rather than concurrent: two catalogs can be two refs of one repository, and a shared
 * cache directory is not something two fetches may race over.
 *
 * @param options a collector for the one problem parsing can continue past — see
 *   {@link CatalogParseOptions} — and the per-catalog refresh plan, see {@link CatalogLoadOptions}.
 * @throws {AmbitError} exit 2 for an unresolvable source or a malformed catalog; exit 4 if a fetch
 *   fails.
 */
export async function loadCatalogs(
  config: ProjectConfig,
  context: SourceContext,
  options: CatalogLoadOptions = {},
): Promise<readonly Catalog[]> {
  const catalogs: Catalog[] = [];
  for (const entry of config.catalogs) {
    const resolved = await resolveCatalogRoot(
      entry,
      context,
      config.origin.file,
      options.refresh?.get(entry.name),
    );
    const parsed = await parseCatalogDirectory(
      entry.name,
      entry.source,
      resolved.root,
      resolved.commit,
      options,
    );
    // `ref` and `moving` are facts about the config entry and about how its source answered, not
    // about the directory that was parsed, so both are attached here rather than threaded through
    // parsing — which also keeps a `path:` catalog, whose directory has neither a ref nor a
    // revision to speak of, from having to invent either.
    catalogs.push({
      ...parsed,
      ...(entry.ref !== undefined && { ref: entry.ref }),
      ...(resolved.moving !== undefined && { moving: resolved.moving }),
    });
  }
  return catalogs;
}

/**
 * Merges catalogs into one namespace per kind, keeping every catalog's copy of every name.
 *
 * Nothing is dropped and nothing is arbitrated. Two catalogs both providing `house-style` is a
 * non-event here: both copies are in the merged view, each addressable by its catalog and its name,
 * and `catalogs:` order therefore settles nothing — there is no precedence left to establish.
 *
 * The collision this function used to decide is decided at *materialization* instead. Harness layout
 * is flat and externally imposed — Claude reads `.claude/skills/<name>` — so two copies of one name
 * that are both *selected* would want one path, and resolution refuses that (`assertNoCollisions`).
 * Refusing a selection is a different thing from refusing a catalog: a name two catalogs ship costs
 * nothing until a project asks for both.
 *
 * Every item in the result came out of a catalog directory, since that is the only place a definition
 * can be written — so there is nothing to fold in beside these lists, and no item without a file.
 */
export function mergeCatalogs(catalogs: readonly Catalog[]): MergedCatalog {
  const skills: MergedSkill[] = [];
  const mcps: MergedMcp[] = [];
  const hooks: MergedHook[] = [];

  for (const catalog of catalogs) {
    for (const skill of catalog.skills) {
      skills.push({
        ...skill,
        catalog: catalog.name,
        ...(catalog.commit !== undefined && { commit: catalog.commit }),
        catalogRoot: catalog.root,
      });
    }

    for (const mcp of catalog.mcps) {
      mcps.push({ ...mcp, catalog: catalog.name });
    }

    for (const hook of catalog.hooks) {
      // `catalogRoot` for the same reason a skill carries one: a hook that ships a script is
      // materialized out of the catalog it came from, and nothing downstream should have to look the
      // catalog up again to find it.
      hooks.push({
        ...hook,
        catalog: catalog.name,
        ...(catalog.commit !== undefined && { commit: catalog.commit }),
        catalogRoot: catalog.root,
      });
    }
  }

  return {
    catalogs: catalogs.map((catalog) => catalog.name),
    skills: byNameThenCatalog(skills),
    mcps: byNameThenCatalog(mcps),
    hooks: byNameThenCatalog(hooks),
  };
}

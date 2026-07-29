/**
 * `ambit.yml` — the project config.
 *
 * Parsing is total: whatever comes back is fully typed and needs no further checking, and
 * anything the config could not express has already been rejected with an exit-2 error naming
 * the file, the key, and the line.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import type { AmbitError } from "../errors.js";
import { at, configError } from "../errors.js";
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

const CONFIG_KEYS = ["catalogs", "harnesses", "scopes", "skills", "version"] as const;
const CATALOG_KEYS = ["name", "ref", "source"] as const;

/** A catalog to fetch and parse. */
export interface CatalogRef {
  readonly name: string;
  readonly source: string;
  /** Tag, branch, or commit. Absent means the source's default branch. */
  readonly ref?: string;
}

/**
 * The second half of every rewrite below.
 *
 * A definition lives in a file, and a file is only reachable through a catalog — so wherever a
 * definition used to sit in `ambit.yml`, moving it takes two steps, and the second one is always this
 * one. The catalog that holds a project's own files is the project.
 */
const SELF_CATALOG_ADVICE =
  "then list this project as a catalog: `- name: local` with `source: path:.`";

/**
 * The keys that used to carry a definition in `ambit.yml`, with the file each entry moves into.
 *
 * Kept only so their presence can be refused. {@link YamlMapping.rejectUnknownKeys} would already
 * stop a config that still writes one, but its message says *unknown key* and lists the accepted
 * set — which reads as a typo, and leaves a reader holding a definition that used to work with no
 * idea where it went. The rewrite is two lines, so it is stated.
 */
const REMOVED_INLINE_KEYS: readonly {
  readonly key: string;
  /** How the message names one of the entries. */
  readonly subject: string;
  /** Where one of them lives now, relative to the catalog root. */
  readonly file: string;
}[] = [
  { key: "mcps", subject: "an MCP server", file: "mcps/<name>.yml" },
  { key: "hooks", subject: "a hook", file: "hooks/<name>/HOOK.yml" },
];

/**
 * Refuses a top-level `mcps:` or `hooks:`, naming the file the definitions move into.
 *
 * Runs before {@link YamlMapping.rejectUnknownKeys} for the reason above: the generic message would
 * fire first and say the wrong thing.
 */
function assertNoInlineDefinitions(root: YamlMapping): void {
  for (const removed of REMOVED_INLINE_KEYS) {
    if (!root.has(removed.key)) continue;
    throw root.keyError(removed.key, `top-level \`${removed.key}\` is gone`, [
      `${removed.subject} is defined by a file of its own: move each entry to \`${removed.file}\``,
      SELF_CATALOG_ADVICE,
    ]);
  }
}

/**
 * The refusal for a `skills` entry that is a mapping rather than a bare name.
 *
 * The mapping form carried the skill's own `source`, so a project could name one skill out of a
 * directory that was not a catalog at all. What replaces it is listing that directory in `catalogs:`
 * and leaving the bare name here — the same two steps every other definition takes, since a catalog
 * with one skill in it is a catalog.
 *
 * Positioned at `source` because that is the key that made the entry a definition; a mapping without
 * one is refused here too, and {@link YamlMapping.lineOf} falls back to the entry's own line.
 */
function removedSourceSkill(entry: YamlMapping): AmbitError {
  return entry.keyError("source", "a `skills` entry is a name, not a definition", [
    "a skill is defined by a file: `skills/<name>/SKILL.md`, in the catalog that ships it",
    "list the source in `catalogs:` under a name of its own, and leave the bare name in `skills:`",
    `or move the skill into this project's own \`skills/\`, ${SELF_CATALOG_ADVICE}`,
  ]);
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
}

/** A parsed, validated `ambit.yml`. */
export interface ProjectConfig {
  readonly version: number;
  /** Positions for the errors raised after parsing. */
  readonly origin: ConfigOrigin;
  readonly harnesses: readonly string[];
  /** Held scopes, exactly as listed — nothing is added implicitly. */
  readonly scopes: readonly string[];
  /**
   * Catalogs to fetch and parse, in the order they were listed.
   *
   * The order carries no meaning: every catalog's copy of a name survives the merge, so there is no
   * precedence between them to establish. It is kept because it is what the config says, and because
   * the lock lists catalogs as inputs.
   */
  readonly catalogs: readonly CatalogRef[];
  /** Names of skills wanted regardless of scope, each provided by one of the catalogs above. */
  readonly skills: readonly string[];
}

/**
 * Records the names one config list has used, rejecting a repeat and naming both lines.
 *
 * Every list in `ambit.yml` is keyed by a name, and every later stage looks each name up exactly
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

function parseSkills(root: YamlMapping): Positioned<string> {
  const track = nameTracker(root.file, "skills entry", "list each skill once");
  const entries: string[] = [];
  const lines = new Map<string, number>();

  for (const entry of root.optionalEntryList("skills") ?? []) {
    if (entry instanceof YamlMapping) throw removedSourceSkill(entry);
    track(entry.value, entry.line);
    if (entry.line !== undefined) lines.set(entry.value, entry.line);
    entries.push(entry.value);
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
  assertNoInlineDefinitions(root);
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
  // object literal happens to mention first.
  const harnesses = root.optionalStringList("harnesses") ?? DEFAULT_HARNESSES;
  const scopes = root.optionalPositionedStringList("scopes") ?? [];
  const catalogs = parseCatalogs(root);
  const skills = parseSkills(root);

  return {
    version,
    origin: {
      file: root.file,
      scopeLines: scopeLines(scopes),
      skillLines: skills.lines,
    },
    harnesses,
    scopes: scopes.map((entry) => entry.value),
    catalogs,
    skills: skills.entries,
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

/**
 * `ambit.yml` — the project config.
 *
 * Parsing is total: whatever comes back is fully typed and needs no further checking, and
 * anything the config could not express has already been rejected with an exit-2 error naming
 * the file, the key, and the line.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import { at, configError } from "../errors.js";
import type { PatternEntry } from "./pattern.js";
import { REQUIRES_KEY, entryYaml, parseEntries, uniqueEntries } from "./pattern.js";
import type { ItemKind } from "./requirement.js";
import { CATALOG_SEPARATOR } from "./requirement.js";
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

const CONFIG_KEYS = ["catalogs", "harnesses", REQUIRES_KEY, "version"] as const;
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
 * A definition lives in a file, and a file is only reachable through a catalog, so moving a
 * definition out of `ambit.yml` always takes two steps, and this is always the second one. The
 * catalog that holds a project's own files is the project.
 */
const SELF_CATALOG_ADVICE =
  "then list this project as a catalog: `- name: local` with `source: path:.`";

/**
 * The keys that used to carry a definition in `ambit.yml`, with the file each entry moves into.
 *
 * Kept only so their presence can be refused with a specific message. {@link
 * YamlMapping.rejectUnknownKeys} would already stop a config that still writes one, but its
 * message says "unknown key" and lists the accepted set, which reads as a typo rather than telling
 * the reader where the definition went.
 */
const REMOVED_INLINE_KEYS: readonly {
  readonly key: string;
  /** How the message names one of the entries. */
  readonly subject: string;
  /** Where one of them lives now, relative to the catalog root. */
  readonly file: string;
}[] = [
  { key: "mcps", subject: "an MCP server", file: "mcps/<name>.yml" },
  { key: "hooks", subject: "a hook", file: "hooks/<name>/hook.yml" },
];

/**
 * Refuses a top-level `mcps:` or `hooks:`, naming the file the definitions move into.
 *
 * Runs before {@link YamlMapping.rejectUnknownKeys} so this message fires first instead of the
 * generic "unknown key" one.
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
 * The two keys a project used to select with, and the entry each of their members becomes.
 *
 * Both are gone in favour of one `requires:` list of one-key entries. A `skills` entry selected one
 * skill by name, so it becomes `- skill:` qualified with an alias, and the rewrite is mechanical
 * enough to print. A held scope selected across every namespace at once by label, which no single
 * entry does any more — that job belongs to a pack declared in the catalog — so its refusal
 * explains that instead of printing a rewrite that would only be half true.
 */
const REMOVED_SELECTION_KEYS: readonly {
  readonly key: string;
  /** How the message names one of the entries. */
  readonly subject: string;
  /** Which namespace each member selected from, where one entry can still say it. */
  readonly kind?: ItemKind;
}[] = [
  { key: "scopes", subject: "a held scope" },
  { key: "skills", subject: "a skill name", kind: "skill" },
];

/** Stands in for a catalog alias the config does not name unambiguously. */
const ALIAS_PLACEHOLDER = "<catalog>";

/**
 * The catalog aliases this config declares, for the rewrite a removed key's refusal prints.
 *
 * Read defensively rather than through {@link parseCatalogs}: a malformed `catalogs:` is refused
 * on its own terms once the removed key is gone, so a failure here should only cost the message a
 * concrete alias, nothing else.
 */
function catalogAliases(root: YamlMapping): readonly string[] {
  try {
    return (root.optionalMappingList("catalogs") ?? []).flatMap((entry) => {
      const name = entry.optionalString("name");
      return name === undefined ? [] : [name];
    });
  } catch {
    return [];
  }
}

/**
 * Which alias a rewrite qualifies its patterns with.
 *
 * The one the config declares, when it declares exactly one. With several there is nothing to pick
 * with: a held scope reached every catalog at once, and which of them a given entry should now
 * name is the reader's call, so the placeholder is used instead of guessing.
 */
function rewriteAlias(root: YamlMapping): string {
  const aliases = catalogAliases(root);
  return aliases.length === 1 ? aliases[0]! : ALIAS_PLACEHOLDER;
}

/**
 * Refuses a top-level `scopes:` or `skills:`, naming the `requires` entry each member becomes.
 *
 * Runs before {@link YamlMapping.rejectUnknownKeys} for the same reason
 * {@link assertNoInlineDefinitions} does: the generic "unknown key" message would say nothing about
 * where the selection went.
 */
function assertNoRemovedSelection(root: YamlMapping): void {
  for (const removed of REMOVED_SELECTION_KEYS) {
    if (!root.has(removed.key)) continue;

    const catalog = rewriteAlias(root);
    const kind = removed.kind;
    const rewrites =
      kind === undefined
        ? []
        : (root.optionalPositionedStringList(removed.key) ?? []).map((entry) => {
            const yaml = entryYaml({ kind, pattern: entry.value, catalog });
            const where = entry.line === undefined ? "" : `line ${entry.line}: `;
            return `${where}\`${entry.value}\` becomes \`${yaml}\``;
          });

    throw root.keyError(removed.key, `top-level \`${removed.key}\` is gone`, [
      `a project selects by pattern now: one \`${REQUIRES_KEY}:\` list, each entry one key naming a namespace and qualified with a \`catalogs:\` alias`,
      ...rewrites,
      ...(kind === undefined
        ? [
            "a scope reached items across every namespace at once, which one entry does not: declare a pack in the catalog that requires them, and select it with `pack:`",
          ]
        : []),
      catalog === ALIAS_PLACEHOLDER
        ? `rename the key to \`${REQUIRES_KEY}\`, qualifying each entry with the alias it should select from`
        : `rename the key to \`${REQUIRES_KEY}\``,
    ]);
  }
}

/**
 * Where the config came from, and where inside it the values live that a later stage judges.
 *
 * Resolution runs long after parsing, so an error about a `requires` entry has no YAML node left
 * to point at, yet it still has to name the file and the line. This carries just enough of the
 * document's positions for that, keeping {@link ProjectConfig} itself a plain object with no
 * parser state hanging off it.
 */
export interface ConfigOrigin {
  /** How the config file is named in messages — `ambit.yml` or `ambit.yaml`, project-relative. */
  readonly file: string;
  /**
   * 1-based line each `requires` entry was written on, keyed by {@link entryYaml}.
   *
   * An entry renders to exactly one line, so the rendering is the key: two entries that render
   * alike are the same selection, and the first line either was written on is the one a reader
   * scanning downward finds.
   */
  readonly entryLines: ReadonlyMap<string, number>;
}

/** A parsed, validated `ambit.yml`. */
export interface ProjectConfig {
  readonly version: number;
  /** Positions for the errors raised after parsing. */
  readonly origin: ConfigOrigin;
  readonly harnesses: readonly string[];
  /**
   * Catalogs to fetch and parse, in the order they were listed.
   *
   * The order carries no meaning: every catalog's copy of a name survives the merge, so there is no
   * precedence between them to establish. It is kept because it is what the config says, and because
   * the lock lists catalogs as inputs.
   */
  readonly catalogs: readonly CatalogRef[];
  /**
   * What this project selects: pattern entries in the order they were written, literal duplicates
   * dropped.
   *
   * Deduplicated here because an entry written twice is one selection and one finding — a pattern
   * matching nothing is reported per entry, and reporting the same entry twice would be noise. The
   * order is the document's, so nothing downstream has to sort to be deterministic.
   */
  readonly requires: readonly PatternEntry[];
}

/**
 * Records the names one config list has used, rejecting a repeat and naming both lines.
 *
 * Every list in `ambit.yml` is keyed by a name, and every later stage looks each name up exactly
 * once, so a repeat is always a mistake rather than a merge. Refusing it here is what lets
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

/**
 * Refuses a catalog alias holding the one character that separates an alias from a pattern.
 *
 * An alias is the qualifier half of `<catalog>/<pattern>`, so an alias holding a `/` cannot appear
 * in an address at all: every entry qualified with it would read as a second separator. The alias
 * is refused where it is written, since that is the only place a rename can happen.
 *
 * The separator is the only character an alias may not hold. A dot is fine — the reason the
 * separator is `/` and not `.` — and so is a `*`, matched literally, because a qualifier is an
 * alias rather than a pattern.
 */
function assertAddressableAlias(entry: YamlMapping, name: string): void {
  if (!name.includes(CATALOG_SEPARATOR)) return;

  throw entry.keyError("name", `catalog name "${name}" holds a \`${CATALOG_SEPARATOR}\``, [
    `a \`${REQUIRES_KEY}\` entry addresses an item as \`<catalog>${CATALOG_SEPARATOR}<pattern>\`, so nothing can select from an alias holding one`,
    `rename the catalog to something without a \`${CATALOG_SEPARATOR}\` — a dot is fine`,
  ]);
}

function parseCatalogs(root: YamlMapping): readonly CatalogRef[] {
  const track = nameTracker(root.file, "catalog name", "give each catalog a distinct name");
  const catalogs: CatalogRef[] = [];

  for (const entry of root.optionalMappingList("catalogs") ?? []) {
    entry.rejectUnknownKeys(CATALOG_KEYS);
    const name = entry.requireString("name");
    assertAddressableAlias(entry, name);
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

/** A `requires` list, with the line each surviving entry was written on. */
interface Selection {
  readonly entries: readonly PatternEntry[];
  readonly lines: ReadonlyMap<string, number>;
}

/**
 * The project's `requires` list, deduplicated, with each entry's line kept.
 *
 * The lines come from a second read of the same key rather than from {@link parseEntries}, which
 * returns entries and not positions. Pairing them by index is exact: the parse maps one entry to
 * one item of the sequence, in document order, so item *i* is where entry *i* was written. An
 * entry repeated verbatim keeps the first line, the one a reader scanning downward finds.
 */
function parseSelection(root: YamlMapping): Selection {
  const written = parseEntries(root, "qualified");
  // Every item is a mapping by now: `parseEntries` refuses a bare pattern before returning.
  const items = root.optionalEntryList(REQUIRES_KEY) ?? [];

  const lines = new Map<string, number>();
  written.forEach((entry, index) => {
    const item = items[index];
    const line = item instanceof YamlMapping ? item.line : undefined;
    const key = entryYaml(entry);
    if (line !== undefined && !lines.has(key)) lines.set(key, line);
  });

  return { entries: uniqueEntries(written), lines };
}

/** Validates a config mapping, whatever it was read from. */
function fromMapping(root: YamlMapping): ProjectConfig {
  assertNoInlineDefinitions(root);
  assertNoRemovedSelection(root);
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
  const catalogs = parseCatalogs(root);
  const selection = parseSelection(root);

  return {
    version,
    origin: { file: root.file, entryLines: selection.lines },
    harnesses,
    catalogs,
    requires: selection.entries,
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
 * refuse a directory that holds either name, naming the file it found rather than the one it was
 * about to write.
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

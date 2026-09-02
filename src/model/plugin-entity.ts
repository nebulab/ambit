/**
 * A Claude Code plugin manifest, as much of it as ambit reads.
 *
 * The document is `.claude-plugin/plugin.json`, and it is not ambit's: it is authored for Claude
 * Code, which defines every key in it. Ambit is a guest, so unknown keys pass without comment — the
 * same posture `SKILL.md`'s top-level frontmatter gets, and the opposite of the `ambit:` block,
 * which ambit owns and validates strictly.
 *
 * JSON, so this is the one entity with no `YamlMapping` (`yaml.ts`) behind it. That buys nothing to
 * share with the YAML entities beyond the error shape, which is why the reader is written out here
 * rather than folded into a format-neutral abstraction that would have two callers and one of each.
 *
 * Three keys are read and the rest ignored: `name`, because it is what Claude namespaces the
 * plugin's own skills and agents under and a reader needs to know what to type; `description`,
 * carried into every report that lists the plugin; and `version`, which is what a consumer of a
 * marketplace pins to and so belongs in a report about what a catalog offers.
 */
import type { JsonObject } from "./documents/index.js";
import { isRecord } from "./documents/index.js";
import { configError } from "../errors.js";

/** The directory inside a plugin holding its manifest. Claude Code's own spelling. */
export const PLUGIN_MANIFEST_DIRNAME = ".claude-plugin";

/** The manifest itself, within {@link PLUGIN_MANIFEST_DIRNAME}. */
export const PLUGIN_MANIFEST_FILENAME = "plugin.json";

/** The manifest, relative to a plugin's own directory. */
export const PLUGIN_MANIFEST_PATH = `${PLUGIN_MANIFEST_DIRNAME}/${PLUGIN_MANIFEST_FILENAME}`;

/** What ambit reads off a plugin manifest. */
export interface PluginEntity {
  /**
   * The manifest's own `name`: the namespace Claude prefixes the plugin's components with, as in
   * `nebulab-git-workflow:commit-changes`.
   *
   * Deliberately not ambit's name for the plugin, which is its path under `plugins/` — see
   * `CatalogPlugin` (`catalog.ts`). The two answer different questions and a catalog is free to have
   * them differ, so neither is checked against the other.
   */
  readonly namespace: string;
  /** The manifest's `description`, absent when it declares none. */
  readonly description?: string;
  /** The manifest's `version`, absent when it declares none. Semver by Claude's convention. */
  readonly version?: string;
}

/**
 * Reads an optional string key, refusing a value of the wrong type rather than ignoring it.
 *
 * A key ambit does not read is another matter: the manifest is Claude's document and may hold
 * anything Claude defines. This only judges the three keys ambit does read.
 */
function optionalString(document: JsonObject, key: string, file: string): string | undefined {
  const value = document[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw configError(`"${key}" must be a string (${file})`, [
      `it is ${Array.isArray(value) ? "an array" : typeof value}`,
      `correct \`${key}\` in ${file}`,
    ]);
  }
  return value;
}

/**
 * Parses a plugin manifest.
 *
 * @param text the file's contents.
 * @param file how it is named in errors, catalog-relative.
 * @throws {AmbitError} exit 2 for malformed JSON, a document that is not an object, a missing or
 *   empty `name`, or one of the three read keys holding the wrong type.
 */
export function parsePluginManifest(text: string, file: string): PluginEntity {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw configError(`${file} is not valid JSON`, [
      error instanceof Error ? error.message : String(error),
      `correct the syntax in ${file}`,
    ]);
  }

  if (!isRecord(document)) {
    throw configError(`${file} must be a JSON object`, [
      "a plugin manifest is a mapping of keys, as Claude Code defines them",
      `rewrite ${file} as an object`,
    ]);
  }

  const namespace = optionalString(document, "name", file);
  if (namespace === undefined || namespace === "") {
    throw configError(`plugin manifest declares no \`name\` (${file})`, [
      "Claude Code namespaces a plugin's skills and agents under its `name`, so it is required",
      `add \`"name": "<kebab-case-name>"\` to ${file}`,
    ]);
  }

  const description = optionalString(document, "description", file);
  const version = optionalString(document, "version", file);

  return {
    namespace,
    ...(description !== undefined && { description }),
    ...(version !== undefined && { version }),
  };
}

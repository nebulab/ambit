import type { YamlMapping } from "./yaml.js";

export interface PluginMetadata {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: Readonly<Record<string, string>>;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  /** External plugin names; local dependencies come from pack requirements. */
  readonly dependencies?: readonly string[];
  /** Output directory basename. Defaults to the plugin name. */
  readonly directory?: string;
  /** Catalog-relative directory copied into the plugin commands directory. */
  readonly commands?: string;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Parses export metadata without changing a pack's installation requirements. */
export function parsePluginMetadata(mapping: YamlMapping): PluginMetadata {
  mapping.rejectUnknownKeys([
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "dependencies",
    "directory",
    "commands",
  ]);
  const name = mapping.requireString("name");
  if (!NAME.test(name)) {
    throw mapping.keyError(
      "name",
      "plugin names must use lowercase letters, digits, and single hyphens",
      ["use a name such as `company-engineering`"],
    );
  }
  const result: { -readonly [K in keyof PluginMetadata]: PluginMetadata[K] } = { name };
  for (const key of [
    "version",
    "description",
    "homepage",
    "repository",
    "license",
    "directory",
    "commands",
  ] as const) {
    const value = mapping.optionalString(key);
    if (value !== undefined) result[key] = value;
  }
  if (result.directory !== undefined && !NAME.test(result.directory)) {
    throw mapping.keyError(
      "directory",
      "plugin directory must be a lowercase hyphenated basename",
      ["use a directory such as `engineering` without path separators"],
    );
  }
  if (
    result.commands !== undefined &&
    (result.commands.startsWith("/") ||
      result.commands.includes("\\") ||
      result.commands.split("/").some((part) => part === ".." || part === "." || part === ""))
  ) {
    throw mapping.keyError("commands", "commands must name a directory inside the catalog", [
      "use a catalog-relative path such as `commands/engineering`",
    ]);
  }
  for (const key of ["keywords", "dependencies"] as const) {
    const value = mapping.optionalStringList(key);
    if (value !== undefined) result[key] = value;
  }
  for (const dependency of result.dependencies ?? []) {
    if (!NAME.test(dependency) || dependency === name) {
      throw mapping.keyError("dependencies", `invalid plugin dependency "${dependency}"`, [
        "list other plugins by their lowercase hyphenated names",
      ]);
    }
  }
  const author = mapping.optionalMapping("author");
  if (author !== undefined) {
    author.rejectUnknownKeys(["name", "email", "url"]);
    author.requireString("name");
    result.author = author.stringEntries();
  }
  for (const [field, url] of [
    ["homepage", result.homepage],
    ["author.url", result.author?.url],
  ] as const) {
    if (url !== undefined && !URL.canParse(url))
      throw mapping.keyError(field, `invalid URL "${url}"`, [
        "use an absolute URL such as https://example.com",
      ]);
  }
  return result;
}

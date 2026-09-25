import { parsePluginMetadata } from "./plugin.js";
import type { PluginMetadata } from "./plugin.js";
import type { PatternEntry } from "./pattern.js";
import { REQUIRES_KEY, parseEntries } from "./pattern.js";
import type { YamlMapping } from "./yaml.js";

export interface PackEntity {
  readonly name: string;
  readonly plugin?: PluginMetadata;
  /** Shown by `ambit search`. */
  readonly description?: string;
  /**
   * What asking for this pack gets you: a `requires` list in the same entry grammar a project
   * selects with, minus the qualifier — see {@link PatternEntry}. In the order the author wrote them.
   *
   * May name other packs, which lets a small pack compose into a large one; the resolution closure
   * follows these to a fixpoint. Entries are unqualified and so confined to this catalog: the
   * qualifier is a consumer-config alias a catalog author cannot write, so a catalog can only
   * require what it ships.
   */
  readonly requires: readonly PatternEntry[];
}

/**
 * The keys a pack document may hold.
 *
 * No `expects`, unlike the other three kinds. An expectation is read by something that runs: a
 * skill's instructions, a server's credentials, a hook's command. A pack runs nothing itself; each
 * item it names carries its own `expects` into the union instead.
 */
const ENTITY_KEYS = ["description", "name", "plugin", REQUIRES_KEY] as const;

/**
 * Parses a pack document.
 *
 * @throws {AmbitError} exit 2 for a missing or malformed `name`, an unknown key, or a `requires`
 *   entry the grammar refuses.
 */
export function parsePackEntity(mapping: YamlMapping): PackEntity {
  mapping.rejectUnknownKeys(ENTITY_KEYS);

  const name = mapping.requireString("name");
  const description = mapping.optionalString("description");
  const plugin = mapping.optionalMapping("plugin");

  return {
    name,
    ...(plugin !== undefined && { plugin: parsePluginMetadata(plugin) }),
    ...(description !== undefined && { description }),
    // Unqualified: a catalog author cannot write a consumer's alias, so the pattern stands alone and
    // the entry resolves within this catalog.
    requires: parseEntries(mapping, "unqualified"),
  };
}

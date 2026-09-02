/**
 * Pack parsing.
 *
 * A **pack** is a capability whose whole job is to pull in other capabilities. It ships no bytes,
 * runs nothing, and materializes into no harness. It has a name, a description, and a `requires`
 * list naming the skills, servers, hooks, and other packs a consumer gets by asking for it.
 *
 * Packs replace tagging as the way to group items. A tag was a free-form label declared per item,
 * registered nowhere and described nowhere: a misspelled tag silently created a new one reaching no
 * one, and there was no way to list what groups a catalog offered. A pack is a document instead: it
 * is browsable with `ambit search`, carries a description, and a `requires` entry naming a
 * nonexistent pack is exit 3 like any other unmatched pattern; `ambit why` walks back through it.
 *
 * This also moves who decides a grouping from the consumer to the catalog author. A tag let a
 * consumer invent a grouping the catalog never defined; a pack means the catalog author decides
 * what a group like `engineering` means, in one place, and a consumer wanting something different
 * writes the entries directly or asks the catalog for a new pack.
 *
 * One shape, one place it can be written: `packs/<name>.yml` in a catalog, flat like `mcps/`, since
 * a pack is always a single document, never a directory.
 */
import type { PatternEntry } from "./pattern.js";
import { REQUIRES_KEY, parseEntries } from "./pattern.js";
import type { YamlMapping } from "./yaml.js";

export interface PackEntity {
  readonly name: string;
  /**
   * What this pack is for, in the author's own words. A tag never carried this; it is why
   * `ambit search` can print what `engineering` means and a consumer can choose between packs.
   */
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
 * No `expects`, unlike skills, servers and hooks. An expectation is read by something that runs: a
 * skill's instructions, a server's credentials, a hook's command. A pack runs nothing itself; each
 * item it names carries its own `expects` into the union instead.
 */
const ENTITY_KEYS = ["description", "name", REQUIRES_KEY] as const;

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

  return {
    name,
    ...(description !== undefined && { description }),
    // Unqualified: a catalog author cannot write a consumer's alias, so the pattern stands alone and
    // the entry resolves within this catalog.
    requires: parseEntries(mapping, "unqualified"),
  };
}

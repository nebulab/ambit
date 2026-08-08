/**
 * Pack parsing.
 *
 * A **pack** is a capability whose whole job is to pull in other capabilities. It ships no bytes, it
 * runs nothing, and it materializes into no harness — what it has is a name, a description, and a
 * `requires` list naming the skills, servers, hooks and other packs a consumer gets by asking for it.
 *
 * It exists because grouping needs a home. Before this, an author grouped items by tagging them:
 * free-form labels declared per item, registered nowhere and described nowhere, so a misspelled tag
 * was silently a new tag reaching nobody, and there was no surface that could list what groups a
 * catalog offered or say what one was for. A pack is a **document**: it is browsable with
 * `ambit dump-catalog`, it carries a description, a `requires` entry naming a pack that does not
 * exist is exit 3 like every other unmatched pattern, and `ambit why` walks back through it.
 *
 * The consequence worth stating is that grouping moved from the consumer's side of the boundary to
 * the author's. A tag let a consumer invent a grouping the catalog had never blessed — *everything
 * labelled `function.engineering`, as skills and servers but not hooks* — and a pack does not: the
 * catalog decides what `engineering` means, in one place, and a consumer who wants a different set
 * writes the entries for it or asks the catalog for a pack. That is the trade, and it is the point:
 * the grouping is now something you can read.
 *
 * One shape, one place it can be written: `packs/<name>.yml` in a catalog, flat like `mcps/`, because
 * a pack is one document and never a directory — there are no bytes for a directory to hold.
 */
import type { PatternEntry } from "./pattern.js";
import { REQUIRES_KEY, parseEntries } from "./pattern.js";
import type { YamlMapping } from "./yaml.js";

export interface PackEntity {
  readonly name: string;
  /**
   * What this pack is for, in the author's own words.
   *
   * The half a tag never had. It is why a pack is worth being a document: `ambit dump-catalog` can
   * print what `engineering` means, and a consumer choosing between two packs has something to
   * choose on.
   */
  readonly description?: string;
  /**
   * What asking for this pack gets you: a `requires` list in the same entry grammar a project selects
   * with, minus the qualifier — see {@link PatternEntry}. In the order the author wrote them.
   *
   * May name other packs, which is what makes a small pack composable into a large one, and what the
   * resolution closure follows to a fixpoint. Unqualified, and therefore confined to this catalog:
   * the alias belongs to the consumer's config, so a catalog author cannot write one, and a catalog
   * can only require what it ships.
   */
  readonly requires: readonly PatternEntry[];
}

/**
 * The keys a pack document may hold.
 *
 * No `expects`, unlike the other three kinds. An expectation says something must be true of the
 * world, and every one of those is read by something that runs: a skill's instructions, a server's
 * credentials, a hook's command. A pack runs nothing and reads nothing — it names items, and each of
 * those carries its own `expects` into the union. A pack declaring one would be a precondition with
 * no consumer behind it.
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

/**
 * The annotation command: `ambit catalog annotate <name>`.
 *
 * This is the only authoring command that edits a document's *contents* rather than its existence, so
 * it is where authoring rule 2 is under the most pressure: the document it opens is hand-written, its
 * frontmatter belongs to the harness, and ambit is being asked to change three keys inside it. Three
 * decisions follow from that.
 *
 * - **A list ambit rewrites comes out sorted and deduplicated.** Two runs asking for the same set of
 *   entries in a different argv order have to produce the same bytes, and a set of scopes carries no
 *   order to preserve (unlike a stdio command's `args`, which are nothing but order).
 * - **A key whose *membership* the request would not change is left byte-for-byte alone** — layout,
 *   comment, and even a hand-written duplicate. So `annotate` is a no-op in the strongest sense when it
 *   is asked for what the document already says, which is what makes it safe to script, and reordering
 *   is confined to the keys the reader actually asked to change.
 * - **Removing the last entry leaves `[]`, not a removed key.** "Declares none" and "says nothing" read
 *   the same to the parser, but only one of them is a statement the author made, and a
 *   command that deleted the key would quietly undo the annotation rather than empty it.
 *
 * The two subjects it edits are asymmetric, because §3.2 and §3.3 are, in two ways. A skill declares
 * `scopes`, `requires`, and `env`, while an MCP entity has no `requires` at all — a server is
 * *required*, it does not require; asking to change one is refused rather than ignored, naming the
 * skill-side flag that does what the reader meant. And a skill's annotations are nested under
 * `ambit:` while an entity's sit at the top level, because a `SKILL.md`'s frontmatter is the
 * harness's document and an `mcps/<name>.yml` is ambit's own end to end — so the two differ only in
 * where the keys are written, which is a key path this module carries per subject rather than a
 * branch inside the loop that writes them.
 *
 * `--add-scope` is pre-checked against the registry ({@link assertRegisteredScopes}) so a typo gets its
 * "did you mean"; `--add-requires` deliberately is not, because validation's own message already names
 * an unresolvable requirement and there is no better advice to add. Everything else — atomic writes, the
 * root check, `--dry-run`, and validation of the whole result — comes from the B02 editor.
 */
import path from "node:path";

import type { AnnotationKey, Catalog } from "../model/catalog.js";
import {
  AMBIT_FRONTMATTER_KEY,
  ANNOTATION_KEYS,
  MCPS_DIRNAME,
  SKILL_FILENAME,
  SKILLS_DIRNAME,
  parseCatalogDirectory,
} from "../model/catalog.js";
import { mcpDocumentFile, unknownMcp } from "./mcp.js";
import { assertRegisteredScopes } from "./scope.js";
import { unknownSkill } from "./skill.js";
import type { EditOptions, EditResult } from "./editor.js";
import { CatalogDocument, applyCatalogEdit } from "./editor.js";
import type { AmbitError } from "../errors.js";
import { at, configError } from "../errors.js";
import { MCP_REQUIREMENT_PREFIX } from "../resolution/resolve.js";

/** What an annotatable subject is: the two file shapes §3.2 and §3.3 describe. */
export type AnnotatedKind = "skill" | "mcp";

/**
 * The keys an MCP entity may declare.
 *
 * `requires` is absent because a server is required by skills rather than requiring anything itself, and
 * the §3.3 parser rejects the key outright — so writing one would produce a document ambit cannot read.
 */
const MCP_ANNOTATION_KEYS: readonly AnnotationKey[] = ANNOTATION_KEYS.filter(
  (key) => key !== "requires",
);

/**
 * What one key is asked to gain and to lose.
 *
 * Both halves absent still counts as a request for that key: it means "leave the membership alone", and
 * the key is reported without being rewritten.
 */
export interface AnnotationEdit {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export interface AnnotateOptions extends EditOptions {
  /** Per annotation, what to add and what to remove. A key with no entry here is not touched. */
  readonly edits?: Readonly<Partial<Record<AnnotationKey, AnnotationEdit>>>;
}

/** One annotation as a report names it: the key, and every entry it holds after the edit. */
export interface AnnotatedList {
  readonly key: AnnotationKey;
  readonly values: readonly string[];
}

/** What was annotated, and what it declares now. */
export interface AnnotatedItem {
  readonly kind: AnnotatedKind;
  /** The bare name, `mcp.` prefix stripped — how `ambit why` and `ambit dump-catalog` name the same thing. */
  readonly name: string;
  /** The document the annotations live in, catalog-relative. */
  readonly file: string;
  /** Every annotation the subject may declare, in {@link ANNOTATION_KEYS} order. */
  readonly declares: readonly AnnotatedList[];
}

export interface AnnotateResult extends EditResult {
  readonly annotated: AnnotatedItem;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A list as ambit rewrites one: sorted and deduplicated, so argv order is not information. */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The error for asking to change an MCP entity's `requires`.
 *
 * Exit 2 — a malformed invocation, like every other flag that would be written nowhere — and it names
 * the skill-side flag that does what the reader meant, because wanting a server to follow a skill into
 * the bundle is the sensible thing behind the request.
 */
function noRequirements(name: string, file: string): AmbitError {
  return configError(`MCP server "${name}" declares no requirements ${at(file, undefined)}`, [
    "`requires` is a skill's key: an entity declares `name`, `scopes`, `transport`, and `env`",
    `to pull the server in behind a skill, run \`ambit catalog annotate <skill> --add-requires ${MCP_REQUIREMENT_PREFIX}${name}\``,
  ]);
}

/**
 * Parses the catalog in `root`, which is also the check that it is one.
 *
 * The whole catalog rather than the one document: the subject is found by name, and an added scope is
 * checked against the registry. The same read every other authoring command does.
 */
async function readCatalog(root: string): Promise<Catalog> {
  return parseCatalogDirectory(path.basename(root), `path:${root}`, root);
}

/** The subject of an annotation: which document to open, and what it says now. */
interface Subject {
  readonly kind: AnnotatedKind;
  readonly name: string;
  readonly file: string;
  /** The keys this shape may declare, in `ANNOTATION_KEYS` order. */
  readonly keys: readonly AnnotationKey[];
  /**
   * The mapping the keys are written inside, as a path from the document root: `["ambit"]` for a
   * skill, and the root itself for an entity.
   */
  readonly under: readonly string[];
  readonly current: Readonly<Record<AnnotationKey, readonly string[]>>;
}

/**
 * Whether a name refers to an MCP server: the `mcp.` prefix, the same disambiguation `requires` and
 * `ambit why` use. A bare name is a skill, because that is what a catalog is mostly made of.
 */
export function isMcpTarget(name: string): boolean {
  return name.startsWith(MCP_REQUIREMENT_PREFIX);
}

/**
 * Where an annotation *would* be written, from the name alone — for a refusal raised before the catalog
 * is read, which therefore cannot know which §3.3 extension an entity actually carries.
 *
 * Exported because the handler's argv refusals name the directory rather than a file for exactly that
 * reason; this names the two directories in one place.
 */
export function annotationDirname(name: string): string {
  return isMcpTarget(name) ? MCPS_DIRNAME : SKILLS_DIRNAME;
}

/**
 * The item `name` refers to, and the document its annotations live in.
 *
 * An entity is reached through {@link mcpDocumentFile} rather than through the editor's
 * `mcpDocumentPath`, because this command edits a file the author wrote: `mcps/<name>.yaml` is as legal
 * as `.yml`, and writing the other one would leave two files defining one server — which
 * parsing rejects.
 *
 * @throws {AmbitError} exit 3 when the catalog provides no such skill or server.
 */
async function subjectOf(root: string, catalog: Catalog, name: string): Promise<Subject> {
  if (isMcpTarget(name)) {
    const bare = name.slice(MCP_REQUIREMENT_PREFIX.length);
    const entity = catalog.mcps.find((candidate) => candidate.name === bare);
    if (entity === undefined) throw unknownMcp(bare);

    return {
      kind: "mcp",
      name: entity.name,
      file: await mcpDocumentFile(root, entity.name),
      keys: MCP_ANNOTATION_KEYS,
      under: [],
      current: { scopes: entity.scopes, requires: [], env: entity.env },
    };
  }

  const skill = catalog.skills.find((candidate) => candidate.name === name);
  if (skill === undefined) throw unknownSkill(name);

  return {
    kind: "skill",
    name: skill.name,
    file: `${skill.path}/${SKILL_FILENAME}`,
    keys: ANNOTATION_KEYS,
    under: [AMBIT_FRONTMATTER_KEY],
    current: { scopes: skill.scopes, requires: skill.requires, env: skill.env },
  };
}

/** What a key would hold after the edit: the additions in, the removals out, sorted and deduplicated. */
function desiredList(current: readonly string[], edit: AnnotationEdit): readonly string[] {
  const removed = new Set(edit.remove ?? []);
  return sortedUnique([...current, ...(edit.add ?? [])]).filter((value) => !removed.has(value));
}

/**
 * Every scope the request adds, sorted so the refusal depends on the names rather than on argv order.
 *
 * Only the additions: a scope the registry does not hold is exactly what someone runs
 * `--remove-scope` to clear, and pre-checking removals would make the one command that can fix such a
 * catalog refuse to run against it.
 */
function addedScopes(options: AnnotateOptions): readonly string[] {
  return sortedUnique(options.edits?.scopes?.add ?? []);
}

/**
 * Adds and removes entries in a skill's or an MCP entity's `scopes`, `requires`, and `env`.
 *
 * @param root the catalog root, absolute.
 * @param name the skill's name, or `mcp.<name>` for a server.
 * @param options what each annotation gains and loses, and `--dry-run`.
 * @throws {AmbitError} exit 2 for a catalog that does not parse, a `requires` edit aimed at an MCP
 *   entity, or a write that fails; exit 3 for a skill or server the catalog does not provide, an added
 *   scope its registry does not hold, or a result that would not validate — with nothing written.
 */
export async function annotate(
  root: string,
  name: string,
  options: AnnotateOptions = {},
): Promise<AnnotateResult> {
  const catalog = await readCatalog(root);
  const subject = await subjectOf(root, catalog, name);

  if (subject.kind === "mcp" && options.edits?.requires !== undefined) {
    throw noRequirements(subject.name, subject.file);
  }

  assertRegisteredScopes(catalog, addedScopes(options));

  const document = await CatalogDocument.open(root, subject.file);
  const declares: AnnotatedList[] = [];

  for (const key of subject.keys) {
    const current = subject.current[key];
    const values = desiredList(current, options.edits?.[key] ?? {});
    declares.push({ key, values });
    // Only a change of membership is written. Rewriting a list whose entries are the same would cost
    // the author their layout and any duplicate they wrote, for no change anybody asked for.
    if (!sameList(values, sortedUnique(current))) {
      document.setStringList([...subject.under, key], values);
    }
  }

  const result = await applyCatalogEdit(root, document.changed ? [document.change()] : [], options);

  return {
    annotated: { kind: subject.kind, name: subject.name, file: subject.file, declares },
    ...result,
  };
}

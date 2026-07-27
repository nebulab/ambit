/**
 * The annotation command: `ambit catalog annotate <kind>:<name>`.
 *
 * The subject declares its namespace, and so does every `requires` entry the command writes. That is
 * not ceremony: a catalog's three namespaces are flat and independent, so a skill may legitimately be
 * called `mcp.sentry`, and a command that read the namespace off the name would be unable to reach it —
 * see `src/model/requirement.ts`. The subject is a reference rather than a lookup because this command
 * *writes*, and a lookup cannot name a requirement whose target has already gone.
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
 * The three subjects it edits are asymmetric, because the file shapes are, in two ways. A skill
 * declares `scopes`, `requires`, and `env`, while an MCP entity and a hook have no `requires` at all —
 * both are *required*, neither requires; asking to change one is refused rather than ignored, naming
 * the skill-side flag that does what the reader meant. And a skill's annotations are nested under
 * `ambit:` while the other two sit at the top level, because a `SKILL.md`'s frontmatter is the
 * harness's document and an `mcps/<name>.yml` or a `hooks/<name>/HOOK.yml` is ambit's own end to end —
 * so they differ only in where the keys are written, which is a key path this module carries per
 * subject rather than a branch inside the loop that writes them.
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
  HOOKS_DIRNAME,
  HOOK_FILENAME,
  MCPS_DIRNAME,
  SKILL_FILENAME,
  SKILLS_DIRNAME,
  parseCatalogDirectory,
} from "../model/catalog.js";
import { unknownHook } from "./hook.js";
import { mcpDocumentFile, unknownMcp } from "./mcp.js";
import { assertRegisteredScopes } from "./scope.js";
import { unknownSkill } from "./skill.js";
import type { EditOptions, EditResult } from "./editor.js";
import { CatalogDocument, applyCatalogEdit } from "./editor.js";
import type { AmbitError } from "../errors.js";
import { at, configError } from "../errors.js";
import type { ItemKind, Requirement } from "../model/requirement.js";
import { formatRequirement, parseRequirement, parseSubject } from "../model/requirement.js";

/** What an annotatable subject is: the three file shapes a catalog holds. */
export type AnnotatedKind = ItemKind;

/**
 * The keys a leaf may declare — an MCP entity, or a hook.
 *
 * `requires` is absent because both are *required* by skills rather than requiring anything
 * themselves, and both parsers reject the key outright — so writing one would produce a document ambit
 * cannot read.
 */
const LEAF_ANNOTATION_KEYS: readonly AnnotationKey[] = ANNOTATION_KEYS.filter(
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
  /** The bare name, without its kind — how `ambit dump-catalog` names the same thing. */
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
 * How a refusal names a leaf: the noun it is called, and the keys it does declare.
 *
 * A skill has none, which is what {@link Subject.leaf} being absent means — and is what makes the one
 * refusal below reachable for exactly the two kinds it is about.
 */
interface LeafWording {
  readonly noun: string;
  readonly declares: string;
}

const MCP_WORDING: LeafWording = {
  noun: "MCP server",
  declares: "an entity declares `name`, `scopes`, `transport`, and `env`",
};

const HOOK_WORDING: LeafWording = {
  noun: "hook",
  declares: "a hook declares its `event` and `command`, with `scopes` and `env` beside them",
};

/**
 * The error for asking to change an MCP entity's or a hook's `requires`.
 *
 * Exit 2 — a malformed invocation, like every other flag that would be written nowhere — and it names
 * the skill-side flag that does what the reader meant, because wanting a server or a hook to follow a
 * skill into the bundle is the sensible thing behind the request. The requirement is spelled by
 * {@link formatRequirement}, so the advice cannot disagree with what `--add-requires` accepts.
 */
function noRequirements(subject: Subject, leaf: LeafWording): AmbitError {
  const requirement = formatRequirement({ kind: subject.kind, name: subject.name });

  return configError(
    `${leaf.noun} "${subject.name}" declares no requirements ${at(subject.file, undefined)}`,
    [
      `\`requires\` is a skill's key: ${leaf.declares}`,
      `to pull it in behind a skill, run \`ambit catalog annotate skill:<skill> --add-requires ${requirement}\``,
    ],
  );
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
   * skill, and the root itself for an entity or a hook, whose whole document is ambit's.
   */
  readonly under: readonly string[];
  readonly current: Readonly<Record<AnnotationKey, readonly string[]>>;
  /** How a refusal names it, for the kinds that declare no `requires`. Absent for a skill. */
  readonly leaf?: LeafWording;
}

/** Where each namespace's documents live, so one place answers it for all three. */
const NAMESPACE_DIRNAME: Readonly<Record<AnnotatedKind, string>> = {
  skill: SKILLS_DIRNAME,
  mcp: MCPS_DIRNAME,
  hook: HOOKS_DIRNAME,
};

/**
 * Where an annotation *would* be written, from the reference alone — for a refusal raised before the
 * catalog is read, which therefore cannot know which §3.3 extension an entity actually carries.
 *
 * Total, because the reference declares its namespace: there is no reading of `mcp:sentry` under which
 * this has to guess between two directories, which is exactly what a bare `mcp.sentry` used to force.
 *
 * Exported because the handler's argv refusals name the directory rather than a file for that reason;
 * this names the three directories in one place.
 *
 * @throws {AmbitError} exit 2 for a reference that names no namespace.
 */
export function annotationDirname(name: string): string {
  return NAMESPACE_DIRNAME[annotationSubject(name).kind];
}

/**
 * The subject reference a name asks for.
 *
 * Through {@link parseSubject}, which every command taking a subject shares — so a bare name is
 * refused here in the words `ambit why` refuses one, and there is one grammar to learn rather than one
 * per command.
 *
 * Exported so the command's argv rule refuses before Commander dispatches, in the same words the
 * mutation would.
 *
 * @throws {AmbitError} exit 2 for a name that does not declare its namespace.
 */
export function annotationSubject(name: string): Requirement {
  return parseSubject(name, `\`annotate ${name}\` does not say what to annotate`);
}

/**
 * The item `name` refers to, and the document its annotations live in.
 *
 * An entity is reached through {@link mcpDocumentFile} rather than through the editor's
 * `mcpDocumentPath`, because this command edits a file the author wrote: `mcps/<name>.yaml` is as legal
 * as `.yml`, and writing the other one would leave two files defining one server — which
 * parsing rejects. A hook needs none of that: its document has exactly one spelling, and parsing
 * carries the directory it was found in.
 *
 * @throws {AmbitError} exit 3 when the catalog provides no such skill, server or hook.
 */
async function subjectOf(root: string, catalog: Catalog, name: string): Promise<Subject> {
  const target = annotationSubject(name);

  if (target.kind === "mcp") {
    const entity = catalog.mcps.find((candidate) => candidate.name === target.name);
    if (entity === undefined) throw unknownMcp(target.name);

    return {
      kind: "mcp",
      name: entity.name,
      file: await mcpDocumentFile(root, entity.name),
      keys: LEAF_ANNOTATION_KEYS,
      under: [],
      current: { scopes: entity.scopes, requires: [], env: entity.env },
      leaf: MCP_WORDING,
    };
  }

  if (target.kind === "hook") {
    const hook = catalog.hooks.find((candidate) => candidate.name === target.name);
    if (hook === undefined) throw unknownHook(target.name);

    return {
      kind: "hook",
      name: hook.name,
      file: `${hook.path}/${HOOK_FILENAME}`,
      keys: LEAF_ANNOTATION_KEYS,
      under: [],
      current: { scopes: hook.scopes, requires: [], env: hook.env },
      leaf: HOOK_WORDING,
    };
  }

  const skill = catalog.skills.find((candidate) => candidate.name === target.name);
  if (skill === undefined) throw unknownSkill(target.name);

  return {
    kind: "skill",
    name: skill.name,
    file: `${skill.path}/${SKILL_FILENAME}`,
    keys: ANNOTATION_KEYS,
    under: [AMBIT_FRONTMATTER_KEY],
    current: {
      scopes: skill.scopes,
      // As references, so every annotation is a set of strings here and the arithmetic below is one
      // loop rather than one per key. They are parsed back on the way out, which is also what makes a
      // `requires` list sort by namespace and then by name.
      requires: skill.requires.map(formatRequirement),
      env: skill.env,
    },
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
 * Rejects a `requires` entry the edit names without a namespace.
 *
 * Both halves, unlike {@link addedScopes}: a removal has to be expressible for a target no catalog
 * provides — clearing a dangling requirement is what `--remove-requires` is *for* — but it still has
 * to say which namespace the dangling entry is in, since two of them could hold the name.
 *
 * Exported so the command's argv rule can refuse before Commander dispatches, in the same words.
 *
 * @throws {AmbitError} exit 2 for an entry that names no namespace.
 */
export function assertRequirementRefs(edit: AnnotationEdit | undefined): void {
  for (const value of [...(edit?.add ?? []), ...(edit?.remove ?? [])]) parseRequirement(value);
}

/**
 * Adds and removes entries in a skill's, an MCP entity's or a hook's `scopes`, `requires`, and `env`.
 *
 * @param root the catalog root, absolute.
 * @param name the subject, as `skill:<name>`, `mcp:<name>` or `hook:<name>`.
 * @param options what each annotation gains and loses, and `--dry-run`.
 * @throws {AmbitError} exit 2 for a subject or a `requires` entry that names no namespace, a catalog
 *   that does not parse, a `requires` edit aimed at an MCP entity or a hook, or a write that fails;
 *   exit 3 for a skill, server or hook the catalog does not provide, an added scope its registry does
 *   not hold, or a result that would not validate — with nothing written.
 */
export async function annotate(
  root: string,
  name: string,
  options: AnnotateOptions = {},
): Promise<AnnotateResult> {
  assertRequirementRefs(options.edits?.requires);

  const catalog = await readCatalog(root);
  const subject = await subjectOf(root, catalog, name);

  if (subject.leaf !== undefined && options.edits?.requires !== undefined) {
    throw noRequirements(subject, subject.leaf);
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
    if (sameList(values, sortedUnique(current))) continue;

    const path = [...subject.under, key];
    // `requires` is the one annotation whose entries are not bare strings: each declares the namespace
    // its name is in, so it is written back as the one-key mappings it was read as.
    if (key === "requires") {
      document.setRequirementList(
        path,
        values.map((value) => parseRequirement(value)),
      );
    } else {
      document.setStringList(path, values);
    }
  }

  const result = await applyCatalogEdit(root, document.changed ? [document.change()] : [], options);

  return {
    annotated: { kind: subject.kind, name: subject.name, file: subject.file, declares },
    ...result,
  };
}

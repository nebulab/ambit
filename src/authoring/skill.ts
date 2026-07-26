/**
 * The skill commands (spec §6, "Catalog authoring"): `ambit catalog skill new|rm|mv`.
 *
 * A skill is the one entity in a catalog whose identity is a *path*: its name is where it sits under
 * `skills/`, and the frontmatter `name` merely has to agree (spec §2, §3.2). Everything odd about this
 * module follows from that.
 *
 * - **`new` writes one file**, and the directories exist because that file is written inside them. A
 *   skill needs nothing else — no registry entry, no index — so a catalog authored by ambit is the plain
 *   skills repo authoring rule 1 promises. The frontmatter is a document ambit owns the shape of, so it
 *   goes through `emitYaml` (rule 3); the body below it is Markdown, which nothing parses back.
 * - **`rm` deletes a directory, not a file.** A skill may carry `references/`, and a command that
 *   removed only the `SKILL.md` would leave a directory nothing can explain. It refuses while another
 *   skill requires the one named, because the alternative is a catalog whose `requires` dangles — and
 *   naming every requirer is more useful than the news that the result would not validate.
 * - **`mv` moves that directory**, and the name follows from the new path rather than being carried
 *   with it: the same edit rewrites the moved document's `name` and every `requires` entry that pointed
 *   at the old one, so nothing in the catalog is left naming a skill that has gone.
 *
 * Neither `rm` nor `mv` will touch a directory that holds *another* skill. Moving one would rename a
 * skill nobody named, and removing one would delete it; both are refused, naming what is in the way.
 *
 * All three write through the B02 editor, so they inherit atomic writes, the root check, `--dry-run`,
 * and validation of the whole result. None of them reads an `ambit.yml`: a catalog is not a project, so
 * a project that names a renamed or deleted skill in its own `skills` list is the author's to update,
 * and the command says so on the way out.
 */
import path from "node:path";

import type { Catalog, CatalogSkill } from "../model/catalog.js";
import {
  AMBIT_FRONTMATTER_KEY,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
  parseCatalogDirectory,
} from "../model/catalog.js";
import { assertRegisteredScopes } from "./scope.js";
import type { CatalogChange, EditOptions, EditResult } from "./editor.js";
import { CatalogDocument, applyCatalogEdit, skillDirectoryPath, skillDocumentPath } from "./editor.js";
import type { AmbitError } from "../errors.js";
import { at, configError, resolutionError } from "../errors.js";
import { emitYaml } from "../model/yaml.js";

/**
 * What joins a skill name's segments, which is what `/` becomes in its path (spec §2). The same
 * character scopes use, and a different namespace — a skill named like a scope is a coincidence.
 */
const NAME_SEPARATOR = ".";

/**
 * The frontmatter keys this module writes (spec §3.2).
 *
 * `name` and `description` are the harness's and sit at the top level; the other three are ambit's
 * and sit under `AMBIT_FRONTMATTER_KEY`. `name` is the one key always written, because it is what
 * the path has to agree with.
 */
const NAME_KEY = "name";
const DESCRIPTION_KEY = "description";
const SCOPES_KEY = "scopes";
const REQUIRES_KEY = "requires";
const ENV_KEY = "env";

/** Where a skill declares its requirements, as a path from the frontmatter root (spec §3.2). */
const REQUIRES_PATH: readonly string[] = [AMBIT_FRONTMATTER_KEY, REQUIRES_KEY];

/** What an edit to a skill amounted to: the editor's own report, unchanged. */
export type SkillEdit = EditResult;

/** A skill as a report names it: what it is called, and what it says it is for. */
export interface SkillSummary {
  readonly name: string;
  readonly description?: string;
}

export interface SkillNewResult extends SkillEdit {
  readonly created: SkillSummary;
}

export interface SkillRemoveResult extends SkillEdit {
  readonly removed: string;
}

export interface SkillRename {
  readonly from: string;
  readonly to: string;
}

export interface SkillRenameResult extends SkillEdit {
  readonly renamed: SkillRename;
}

/** The annotations `new` writes into a skill's frontmatter (spec §3.2). */
export interface SkillAnnotations {
  /** The harness's own summary. Absent leaves the key out rather than writing an empty one. */
  readonly description?: string;
  readonly scopes?: readonly string[];
  readonly requires?: readonly string[];
  readonly env?: readonly string[];
}

export interface SkillNewOptions extends EditOptions, SkillAnnotations {}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A list as ambit writes it into a file it is creating: sorted and deduplicated.
 *
 * The order argv happened to give is not information, and sorting is what makes two runs with the same
 * flags in a different order produce the same bytes. An *existing* list is never reordered — that is
 * authoring rule 2, and `annotate` is where it applies.
 */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

/** Where a skill's annotations are written, from the path the catalog derived its name from. */
function skillDocumentOf(skill: CatalogSkill): string {
  return `${skill.path}/${SKILL_FILENAME}`;
}

/**
 * Rejects a name that cannot be a path under `skills/`.
 *
 * The name↔path convention is the whole of a skill's identity, so a name that does not survive the
 * round trip is refused here rather than written and rejected on the next read: an empty segment would
 * make `a..b` a child of `a.`, and a segment carrying a separator of its own would derive a different
 * name than it was given.
 *
 * @throws {AmbitError} exit 2, naming the directory the skill would have gone in.
 */
function assertSkillName(name: string): void {
  const segments = name.split(NAME_SEPARATOR);
  const usable = segments.every(
    (segment) => segment.trim() !== "" && !segment.includes("/") && !segment.includes("\\"),
  );
  if (usable) return;

  throw configError(`invalid skill name "${name}" ${at(SKILLS_DIRNAME, undefined)}`, [
    `a skill's name is its path under ${SKILLS_DIRNAME}/, so it is segments joined by \`${NAME_SEPARATOR}\`, none of them empty and none a path of its own`,
    "name it like `acme.sales.use-close`",
  ]);
}

/** The error for a name this catalog already provides a skill under (spec §6: a name conflict). */
function alreadyProvided(skill: CatalogSkill): AmbitError {
  return resolutionError(
    `skill "${skill.name}" already exists ${at(skillDocumentOf(skill), undefined)}`,
    [
      "a name means one thing, and this catalog already gave it to a skill",
      "pick another name, or edit the skill that is there",
    ],
  );
}

/**
 * The error for a skill this catalog does not provide.
 *
 * No "did you mean": a skill name is not chosen from a registry the way a scope is, so a near miss is
 * as likely to be a different skill as a typo — the same stance resolution takes on an explicitly
 * listed skill. What the reader gets instead is the rule that turns a path into a name.
 *
 * Exported so `catalog annotate` refuses an unknown skill in these exact words: one identity, one way of
 * saying the catalog does not have it.
 */
export function unknownSkill(name: string): AmbitError {
  return resolutionError(`unknown skill "${name}" ${at(skillDocumentPath(name), undefined)}`, [
    "this catalog provides no skill by that name",
    `a skill's name is its path under ${SKILLS_DIRNAME}/ with \`/\` replaced by \`${NAME_SEPARATOR}\``,
  ]);
}

/** How a requirer reads in a refusal: what it is called, and where the `requires` entry is written. */
function requires(skill: CatalogSkill): string {
  return `skill "${skill.name}" requires it ${at(skillDocumentOf(skill), undefined)}`;
}

/**
 * The error for removing a skill something still requires (spec §6).
 *
 * The next step names `catalog annotate`, which postdates this refusal: `--remove-requires` is what
 * clears a `requires` entry now, and spec §6 asks for a next step that exists rather than for work
 * the reader is told to do by hand.
 */
function stillRequired(name: string, requirers: readonly string[]): AmbitError {
  return resolutionError(`skill "${name}" is still required ${at(skillDocumentPath(name), undefined)}`, [
    ...requirers,
    `clear it from each with \`ambit catalog annotate <skill> --remove-requires ${name}\`, or rename it with \`ambit catalog skill mv ${name} <new>\``,
  ]);
}

/**
 * The error for a skill directory that holds another skill.
 *
 * A nested skill is legal — the walk finds a `SKILL.md` wherever it sits — but it is not part of the
 * skill above it, so moving or removing the outer directory would silently rename or delete it.
 */
function holdsSkill(skill: CatalogSkill, nested: CatalogSkill, verb: string): AmbitError {
  return resolutionError(
    `cannot ${verb} skill "${skill.name}": it holds another skill ${at(skill.path, undefined)}`,
    [
      `skill "${nested.name}" is written inside it ${at(skillDocumentOf(nested), undefined)}`,
      `move it out of ${skill.path} first, with \`ambit catalog skill mv ${nested.name} <new>\``,
    ],
  );
}

/**
 * Parses the catalog in `root`, which is also the check that it is one.
 *
 * The whole catalog rather than the one skill: every question these commands ask — who requires this,
 * what is registered, what is nested inside — is a question about the rest of it. The same read
 * `catalog scope` does.
 */
async function readCatalog(root: string): Promise<Catalog> {
  return parseCatalogDirectory(path.basename(root), `path:${root}`, root);
}

/**
 * The skill `name` refers to.
 *
 * @throws {AmbitError} exit 3 when the catalog provides no such skill.
 */
function provided(catalog: Catalog, name: string): CatalogSkill {
  const skill = catalog.skills.find((candidate) => candidate.name === name);
  if (skill === undefined) throw unknownSkill(name);
  return skill;
}

/** @throws {AmbitError} exit 3 if any other skill requires `skill`, naming every one of them. */
function assertNothingRequires(catalog: Catalog, skill: CatalogSkill): void {
  const requirers = catalog.skills.filter(
    (candidate) => candidate.name !== skill.name && candidate.requires.includes(skill.name),
  );
  if (requirers.length === 0) return;
  throw stillRequired(skill.name, requirers.map(requires));
}

/** @throws {AmbitError} exit 3 if another skill's directory sits inside `skill`'s. */
function assertHoldsNoSkill(catalog: Catalog, skill: CatalogSkill, verb: string): void {
  const nested = catalog.skills.find((candidate) => candidate.path.startsWith(`${skill.path}/`));
  if (nested === undefined) return;
  throw holdsSkill(skill, nested, verb);
}

/**
 * The Markdown a new skill opens with.
 *
 * Prose, not YAML: the frontmatter is what tools read and the body is what the agent reads, so the
 * instructions about writing one belong here rather than in comments inside a block other tools parse.
 */
function skillBody(name: string): string {
  return [
    `# ${name}`,
    "",
    "Replace this body with the instructions an agent should follow: what to do, when to do it, and",
    "what to leave alone. Keep the frontmatter's `description` in step with it — that is what a harness",
    "reads when it decides whether to load the skill at all.",
    "",
    "ambit reads only the frontmatter keys above the delimiter; everything below it is the skill's own.",
    "",
  ].join("\n");
}

/**
 * A new skill's `SKILL.md`.
 *
 * The frontmatter goes through `emitYaml`, so its keys are sorted and a value that would otherwise
 * coerce is quoted (spec §3.0); the delimiters and the body are bytes around it. Empty lists are left
 * out rather than written as `[]`: absent and empty mean the same thing (spec §3.2), and the shorter
 * file is the one a reader can see the point of. An `ambit:` holding none of the three is left out
 * for the same reason — an empty mapping is not a statement anybody made.
 */
function renderSkill(name: string, annotations: SkillAnnotations): string {
  const scopes = sortedUnique(annotations.scopes ?? []);
  const required = sortedUnique(annotations.requires ?? []);
  const env = sortedUnique(annotations.env ?? []);

  const ambit = {
    ...(scopes.length > 0 && { [SCOPES_KEY]: scopes }),
    ...(required.length > 0 && { [REQUIRES_KEY]: required }),
    ...(env.length > 0 && { [ENV_KEY]: env }),
  };

  const frontmatter = emitYaml({
    [NAME_KEY]: name,
    ...(annotations.description !== undefined && { [DESCRIPTION_KEY]: annotations.description }),
    ...(Object.keys(ambit).length > 0 && { [AMBIT_FRONTMATTER_KEY]: ambit }),
  });

  return `---\n${frontmatter}---\n\n${skillBody(name)}`;
}

/**
 * A `requires` list with one name rewritten, or `undefined` when the rename leaves it alone.
 *
 * The order is the author's: this rewrites names, it does not sort or reformat a list (authoring
 * rule 2). A duplicate the rewrite creates is dropped at its later position, since one requirement
 * written twice is not something anybody wrote.
 */
function rewrittenRequires(
  declared: readonly string[],
  from: string,
  to: string,
): readonly string[] | undefined {
  const mapped: string[] = [];
  for (const requirement of declared) {
    const next = requirement === from ? to : requirement;
    if (!mapped.includes(next)) mapped.push(next);
  }

  const same =
    mapped.length === declared.length && mapped.every((value, index) => value === declared[index]);
  return same ? undefined : mapped;
}

/**
 * Creates a skill: one directory, one `SKILL.md`, and nothing else.
 *
 * @param root the catalog root, absolute.
 * @param name the skill's name, which decides where it is written.
 * @param options the annotations to write, and `--dry-run`.
 * @throws {AmbitError} exit 2 for a name that cannot be a path, a catalog that does not parse, or a
 *   write that fails; exit 3 for a name the catalog already provides, a `--scope` its registry does not
 *   hold, or a result that would not validate — with nothing written.
 */
export async function newSkill(
  root: string,
  name: string,
  options: SkillNewOptions = {},
): Promise<SkillNewResult> {
  assertSkillName(name);

  const catalog = await readCatalog(root);
  const existing = catalog.skills.find((candidate) => candidate.name === name);
  if (existing !== undefined) throw alreadyProvided(existing);

  assertRegisteredScopes(catalog, sortedUnique(options.scopes ?? []));

  const change: CatalogChange = { file: skillDocumentPath(name), text: renderSkill(name, options) };
  const result = await applyCatalogEdit(root, [change], options);

  return {
    created: {
      name,
      ...(options.description !== undefined && { description: options.description }),
    },
    ...result,
  };
}

/**
 * Deletes a skill's whole directory.
 *
 * @param root the catalog root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for a catalog that does not parse or a removal that fails; exit 3 for a
 *   skill the catalog does not provide, one another skill still requires, or one whose directory holds
 *   another skill — with nothing removed.
 */
export async function removeSkill(
  root: string,
  name: string,
  options: EditOptions = {},
): Promise<SkillRemoveResult> {
  const catalog = await readCatalog(root);
  const skill = provided(catalog, name);

  assertNothingRequires(catalog, skill);
  assertHoldsNoSkill(catalog, skill, "remove");

  const result = await applyCatalogEdit(root, [{ directory: skill.path, to: null }], options);
  return { removed: skill.name, ...result };
}

/**
 * Renames a skill: moves its directory, corrects its `name`, and rewrites every `requires` that named
 * it.
 *
 * One edit, not several. The moved document is only valid at its new path once its `name` agrees with
 * it, and the catalog is only valid once nothing requires the old name, so validating the three
 * together is the difference between a rename that can be refused and one that half-lands.
 *
 * @param root the catalog root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for a new name that cannot be a path, a catalog that does not parse, or a
 *   write that fails; exit 3 for a skill the catalog does not provide, a name it already provides, or
 *   one whose directory holds another skill — with nothing moved.
 */
export async function renameSkill(
  root: string,
  from: string,
  to: string,
  options: EditOptions = {},
): Promise<SkillRenameResult> {
  assertSkillName(to);

  const catalog = await readCatalog(root);
  const skill = provided(catalog, from);
  assertHoldsNoSkill(catalog, skill, "move");

  if (to !== from) {
    const taken = catalog.skills.find((candidate) => candidate.name === to);
    if (taken !== undefined) throw alreadyProvided(taken);
  }

  const changes: CatalogChange[] = [{ directory: skill.path, to: skillDirectoryPath(to) }];

  // The skill's own document, restated at the path the move puts it: its `name` is derived from that
  // path, so leaving the old one there is the name↔path disagreement parsing rejects (spec §3.2).
  const moved = await CatalogDocument.open(root, skillDocumentOf(skill));
  moved.setString([NAME_KEY], to);
  const self = rewrittenRequires(skill.requires, from, to);
  if (self !== undefined) moved.setStringList(REQUIRES_PATH, self);
  changes.push({ file: skillDocumentPath(to), text: moved.text() });

  for (const other of catalog.skills) {
    if (other.name === skill.name) continue;
    const declared = rewrittenRequires(other.requires, from, to);
    if (declared === undefined) continue;
    const document = await CatalogDocument.open(root, skillDocumentOf(other));
    document.setStringList(REQUIRES_PATH, declared);
    changes.push(document.change());
  }

  const result = await applyCatalogEdit(root, changes, options);
  return { renamed: { from, to }, ...result };
}

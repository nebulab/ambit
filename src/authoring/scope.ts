/**
 * The scope registry commands: `ambit catalog scope add|rm|mv`.
 *
 * `scopes.yml` is the one file in a catalog whose shape reaches outside it. Every project's `ambit.yml`
 * names these scopes by hand, and a held scope selects its whole subtree, so the three edits
 * here are deliberately not symmetric:
 *
 * - **`add` refuses a name the registry already holds.** Registering a scope is not rewording one:
 *   quietly overwriting the entry that is there would let a re-run redefine what every project holding
 *   that scope gets, and the description is the label a picker shows for it. Nothing else in
 *   the CLI edits a description, so the refusal sends the reader to `scopes.yml` itself rather than to a
 *   command that does not exist.
 * - **`rm` refuses while anything still declares the scope**, naming every declarer. The editor would
 *   refuse the write anyway — a declared scope nothing registers is a validation problem — but the useful
 *   answer is the list of files to fix, not the news that the result would not validate. It unregisters
 *   the one entry and no descendant: nothing requires a scope's parent to be registered (`person.jane`
 *   with no `person`), so cascading would delete entries nobody named.
 * - **`mv` renames the subtree**, because what sits beneath a scope is part of what holding it selects.
 *   Renaming `function.engineering` and leaving `function.engineering.frontend` under a name no longer
 *   registered would quietly change what every project holding the parent gets. Every skill, every
 *   server and every hook declaring any renamed scope is rewritten in the *same* edit, which is what
 *   lets the result validate as a whole (see `CatalogOverlay` in `model/catalog.ts`).
 *
 * All three write through the B02 editor, so they inherit atomic writes, the root check, `--dry-run`, and
 * validation of the result. None of them reads an `ambit.yml`: a catalog is not a project, so a rename
 * cannot update the projects that hold the scope, and the command says so on the way out.
 */
import path from "node:path";

import type { Catalog, CatalogHook, CatalogSkill, ScopeDefinition } from "../model/catalog.js";
import {
  AMBIT_FRONTMATTER_KEY,
  HOOK_FILENAME,
  SCOPES_FILENAME,
  SKILL_FILENAME,
  parseCatalogDirectory,
} from "../model/catalog.js";
import { mcpDocumentFile } from "./mcp.js";
import type { CatalogChange, EditOptions, EditedFile } from "./editor.js";
import { CatalogDocument, applyCatalogEdit } from "./editor.js";
import type { AmbitError } from "../errors.js";
import { at, configError, resolutionError } from "../errors.js";
import {
  HOOK_REQUIREMENT_PREFIX,
  MCP_REQUIREMENT_PREFIX,
  SCOPE_SEPARATOR,
  inSubtree,
  scopeSuggestion,
} from "../resolution/resolve.js";

/** The registry's one top-level key. */
const REGISTRY_KEY = "scopes";

/** A registry entry's one key. Required: it is the picker's label, not decoration. */
const DESCRIPTION_KEY = "description";

/**
 * The key a skill, an MCP entity or a hook declares its scopes under. The same word as
 * {@link REGISTRY_KEY} and a different document — a rename rewrites both, and confusing the two would be
 * a hard bug to see.
 *
 * Where it sits differs by document: a skill's is under `ambit:`, since a `SKILL.md`'s frontmatter is
 * the harness's and ambit is namespaced inside it, while an entity's is at the root of a
 * file ambit owns end to end. See {@link SKILL_SCOPES_PATH} and {@link ENTITY_SCOPES_PATH}.
 */
const DECLARED_KEY = "scopes";

/** Where a skill declares its scopes, as a path from the frontmatter root. */
const SKILL_SCOPES_PATH: readonly string[] = [AMBIT_FRONTMATTER_KEY, DECLARED_KEY];

/**
 * Where an MCP entity and a hook declare their scopes, as a path from the document root.
 *
 * One constant for both: an `mcps/<name>.yml` and a `hooks/<name>/HOOK.yml` are files ambit owns end to
 * end, so neither namespaces its own keys the way a skill's frontmatter has to.
 */
const ENTITY_SCOPES_PATH: readonly string[] = [DECLARED_KEY];

/** What an edit to the registry amounted to. */
export interface ScopeEdit {
  /**
   * The files it changed, or would change under `--dry-run`, in path order and carrying their bytes.
   * Empty when the catalog already said this, which is also when nothing was written.
   */
  readonly changes: readonly EditedFile[];
  /** False under `--dry-run`, and false when there was nothing to change. */
  readonly written: boolean;
}

export interface ScopeAddResult extends ScopeEdit {
  /** What the registry now holds for the scope. */
  readonly registered: ScopeDefinition;
}

export interface ScopeRemoveResult extends ScopeEdit {
  readonly unregistered: string;
}

/** One scope a rename moved. */
export interface ScopeRename {
  readonly from: string;
  readonly to: string;
}

export interface ScopeRenameResult extends ScopeEdit {
  /** Every scope renamed — the one named, then its descendants — in old-name order. */
  readonly renamed: readonly ScopeRename[];
}

/**
 * The error for a scope this catalog's registry does not hold.
 *
 * Exit 3, the code for an unknown scope, and the summary shape resolution's own
 * `unknownScopeError` uses; `scopeSuggestion` supplies the "did you mean", so the advice cannot drift
 * from what `resolve` and `validate` give. The detail line differs on purpose — there is no merged
 * registry here, only the one file this command edits.
 */
function unknownScope(scope: string, registered: readonly ScopeDefinition[]): AmbitError {
  return resolutionError(`unknown scope "${scope}" ${at(SCOPES_FILENAME, undefined)}`, [
    `this catalog's ${SCOPES_FILENAME} does not register it`,
    scopeSuggestion(scope, registered),
  ]);
}

/**
 * The error for unregistering a scope something still declares.
 *
 * Every declarer is named, with the file to edit, because clearing them one refusal at a time is the
 * cost of reporting only the first — and the whole list is already in hand.
 *
 * The next step names `catalog annotate`, which postdates this refusal: telling a reader to edit each
 * declarer by hand is advice about work a command now does, and a next step has to be one that
 * exists.
 */
function stillDeclared(scope: string, declarers: Declarers): AmbitError {
  // `annotate` takes a skill by name and the other two by prefix, so each spelling is worth explaining
  // only when something that needs it is actually among the declarers.
  const prefixed: string[] = [];
  if (declarers.servers) prefixed.push(`a server \`${MCP_REQUIREMENT_PREFIX}<server>\``);
  if (declarers.hooks) prefixed.push(`a hook \`${HOOK_REQUIREMENT_PREFIX}<hook>\``);
  const naming = prefixed.length > 0 ? ` (naming ${prefixed.join(" and ")})` : "";

  return resolutionError(`scope "${scope}" is still declared ${at(SCOPES_FILENAME, undefined)}`, [
    ...declarers.lines,
    `clear it from each with \`ambit catalog annotate <name> --remove-scope ${scope}\`${naming}, or rename it with \`ambit catalog scope mv ${scope} <new>\``,
  ]);
}

/**
 * The error for registering a name the registry already holds.
 *
 * The next step is hand-editing, uniquely among this module's refusals, because it is the only thing
 * that is true: no command rewords a registered scope, and `rm` then `add` would move the entry to the
 * end of the mapping and take the author's comment with it (authoring rule 2). Naming a command that
 * would quietly reformat the file is worse advice than naming the file.
 */
function alreadyHeld(scope: string): AmbitError {
  return resolutionError(
    `scope "${scope}" is already registered ${at(SCOPES_FILENAME, undefined)}`,
    [
      "registering is not rewording: overwriting the entry would redefine a scope projects already hold",
      `edit its \`${DESCRIPTION_KEY}\` in ${SCOPES_FILENAME} by hand — no command rewords one — or register a name no entry there uses`,
    ],
  );
}

/** The error for a rename onto a name the registry already holds. */
function alreadyRegistered(from: string, to: string): AmbitError {
  return resolutionError(`scope "${to}" is already registered ${at(SCOPES_FILENAME, undefined)}`, [
    `renaming "${from}" to it would merge two scopes into one`,
    `pick a name no entry in ${SCOPES_FILENAME} uses, or unregister the other one first`,
  ]);
}

/**
 * Rejects a scope name that cannot mean anything.
 *
 * Only the shape the subtree rule depends on is enforced: a name is dot-separated segments,
 * and an empty one makes both halves of this module nonsense — `a..b` would be a child of `a.`, and a
 * rename to `""` would produce `.frontend` out of prefix arithmetic. Everything else a YAML key may hold
 * is the catalog author's business.
 *
 * @throws {AmbitError} exit 2, naming the registry and the name it refused.
 */
function assertScopeName(scope: string): void {
  if (scope.split(SCOPE_SEPARATOR).every((segment) => segment.trim() !== "")) return;

  throw configError(`invalid scope name "${scope}" ${at(SCOPES_FILENAME, undefined)}`, [
    `a scope name is segments joined by \`${SCOPE_SEPARATOR}\`, none of them empty`,
    "name it like `function.engineering`",
  ]);
}

/** Where a skill's annotations are written, from the path the catalog derived its name from. */
function skillDocumentOf(skill: CatalogSkill): string {
  return `${skill.path}/${SKILL_FILENAME}`;
}

/** Where a hook's annotations are written — its directory's own document. */
function hookDocumentOf(hook: CatalogHook): string {
  return `${hook.path}/${HOOK_FILENAME}`;
}

/** How a declarer reads in a refusal: what it is, what it is called, and where it is written. */
function declares(kind: string, name: string, file: string): string {
  return `${kind} "${name}" declares it ${at(file, undefined)}`;
}

/** Everything declaring one scope, as a refusal names them. */
interface Declarers {
  /**
   * One line per declarer: skills, then servers, then hooks, each group in name order, as the catalog
   * parsed them — the order every report lists the three namespaces in.
   */
  readonly lines: readonly string[];
  /** Whether a server is among them, which `catalog annotate` names differently from a skill. */
  readonly servers: boolean;
  /** Whether a hook is among them, which `catalog annotate` names by its own prefix. */
  readonly hooks: boolean;
}

/**
 * Everything declaring `scope`.
 *
 * An entity is named by the file it is actually written as (`CatalogMcp.file`), not by the `.yml` ambit
 * would have chosen: this list *is* the refusal's list of files to edit, and a catalog spelling an entity
 * `.yaml` has no `.yml` for the reader to open. Parsing already resolved that, so the answer is
 * read off the entity rather than looked for on disk — which is what keeps this synchronous, and what
 * keeps the refusal citing exactly the file the catalog was parsed from.
 */
function declarersOf(catalog: Catalog, scope: string): Declarers {
  const declaring = <T extends { readonly scopes: readonly string[] }>(items: readonly T[]): T[] =>
    items.filter((item) => item.scopes.includes(scope));

  const lines = declaring(catalog.skills).map((skill) =>
    declares("skill", skill.name, skillDocumentOf(skill)),
  );

  const servers = declaring(catalog.mcps);
  lines.push(...servers.map((mcp) => declares("MCP server", mcp.name, mcp.file)));

  const hooks = declaring(catalog.hooks);
  lines.push(...hooks.map((hook) => declares("hook", hook.name, hookDocumentOf(hook))));

  return { lines, servers: servers.length > 0, hooks: hooks.length > 0 };
}

/**
 * Parses the catalog in `root`, which is also the check that it is one.
 *
 * The whole catalog rather than only its registry: `rm` and `mv` are questions about who declares what,
 * and a catalog that does not parse is one no mutation may be built on anyway — the editor's own
 * validation would refuse the write a moment later.
 */
async function readCatalog(root: string): Promise<Catalog> {
  return parseCatalogDirectory(path.basename(root), `path:${root}`, root);
}

/**
 * Rejects any of `scopes` the registry does not hold, naming the nearest one it does.
 *
 * Exported because every command that *declares* a scope owes the same refusal — `catalog skill new`,
 * and after it `mcp new` and `annotate`. The editor would refuse those writes anyway, since a declared
 * scope nothing registers is a validation problem, but the refusal it raises carries no suggestion; this
 * is what makes a typo answerable rather than merely fatal.
 *
 * Reports the first offender in the order given, so a caller that sorts gets a refusal that depends on
 * the names alone.
 *
 * @throws {AmbitError} exit 3, before anything is opened for writing.
 */
export function assertRegisteredScopes(catalog: Catalog, scopes: readonly string[]): void {
  const registered = new Set(catalog.scopes.map((definition) => definition.name));
  for (const scope of scopes) {
    if (!registered.has(scope)) throw unknownScope(scope, catalog.scopes);
  }
}

/**
 * Rejects a scope the registry does not hold, naming the nearest one it does.
 *
 * @throws {AmbitError} exit 3, before anything is opened for writing.
 */
function assertRegistered(catalog: Catalog, scope: string): void {
  assertRegisteredScopes(catalog, [scope]);
}

/** Only the documents an edit actually changed: an untouched one is not part of the edit. */
function changesOf(documents: readonly CatalogDocument[]): readonly CatalogChange[] {
  return documents.filter((document) => document.changed).map((document) => document.change());
}

/**
 * Registers `scope`, refusing a name the registry already holds.
 *
 * A new entry lands at the end of the registry in block layout, where the editor puts every key ambit
 * adds — the alternative, sorting the mapping, would reorder entries the author placed (authoring
 * rule 2).
 *
 * The collision is asked of the one document this command writes rather than of a parsed catalog: the
 * question is whether the key is there to be overwritten, and the file the refusal names is this one.
 *
 * @param root the catalog root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for a name with an empty segment, a registry that cannot be read, or a
 *   write that fails; exit 3 for a name the registry already holds — with nothing written, under
 *   `--dry-run` too — or if the result would not validate.
 */
export async function addScope(
  root: string,
  scope: string,
  description: string,
  options: EditOptions = {},
): Promise<ScopeAddResult> {
  assertScopeName(scope);

  const registry = await CatalogDocument.open(root, SCOPES_FILENAME);
  if (registry.has([REGISTRY_KEY, scope])) throw alreadyHeld(scope);
  registry.setString([REGISTRY_KEY, scope, DESCRIPTION_KEY], description);

  const result = await applyCatalogEdit(root, changesOf([registry]), options);
  return {
    registered: { name: scope, description },
    changes: result.changes,
    written: result.written,
  };
}

/**
 * Unregisters `scope`, and nothing else.
 *
 * @param root the catalog root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for a catalog that does not parse or a write that fails; exit 3 for a
 *   scope the registry does not hold, or one something still declares — with nothing written.
 */
export async function removeScope(
  root: string,
  scope: string,
  options: EditOptions = {},
): Promise<ScopeRemoveResult> {
  const catalog = await readCatalog(root);
  assertRegistered(catalog, scope);

  const declarers = declarersOf(catalog, scope);
  if (declarers.lines.length > 0) throw stillDeclared(scope, declarers);

  const registry = await CatalogDocument.open(root, SCOPES_FILENAME);
  registry.remove([REGISTRY_KEY, scope]);

  const result = await applyCatalogEdit(root, changesOf([registry]), options);
  return { unregistered: scope, changes: result.changes, written: result.written };
}

/**
 * Every registered scope a rename moves, old name to new, in old-name order.
 *
 * The subtree comes along because it is what holding the scope selects, and the membership test is
 * resolution's own {@link inSubtree} rather than a prefix check of this module's — the two have to agree
 * or a rename would change what a held scope reaches.
 */
function renamesFor(
  registry: readonly ScopeDefinition[],
  from: string,
  to: string,
): ReadonlyMap<string, string> {
  const renames = new Map<string, string>();
  // `registry` arrives sorted by name, so the map's order — and therefore which of several collisions is
  // reported — is a function of the names alone.
  for (const definition of registry) {
    if (!inSubtree(from, definition.name)) continue;
    renames.set(definition.name, `${to}${definition.name.slice(from.length)}`);
  }
  return renames;
}

/**
 * Refuses a rename onto a name the registry already holds — unless that name is itself being renamed
 * away in the same edit, which is what lets a subtree move onto one of its own descendants.
 *
 * @throws {AmbitError} exit 3, naming both scopes.
 */
function assertNoCollision(
  registry: readonly ScopeDefinition[],
  renames: ReadonlyMap<string, string>,
): void {
  const taken = new Set(registry.map((definition) => definition.name));
  for (const [from, to] of renames) {
    if (!taken.has(to) || renames.has(to)) continue;
    throw alreadyRegistered(from, to);
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A declared `scopes` list with a rename applied, or `undefined` when the rename leaves it alone.
 *
 * The order is the author's: this rewrites names, it does not sort or reformat a list (authoring rule 2).
 * A duplicate the mapping creates is dropped at its later position, since one scope declared twice is
 * not something anybody wrote.
 */
function rewritten(
  declared: readonly string[],
  renames: ReadonlyMap<string, string>,
): readonly string[] | undefined {
  const mapped: string[] = [];
  for (const scope of declared) {
    const next = renames.get(scope) ?? scope;
    if (!mapped.includes(next)) mapped.push(next);
  }
  return sameList(mapped, declared) ? undefined : mapped;
}

/**
 * Renames `from` to `to`, along with every registered scope beneath it, and rewrites every skill and
 * every MCP entity that declares any of them.
 *
 * One edit, not several: the registry and its declarers are only valid together, so validating them as a
 * set is the difference between a rename that can be refused and one that half-lands.
 *
 * @param root the catalog root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for a new name with an empty segment, a catalog that does not parse, or a
 *   write that fails; exit 3 for a scope the registry does not hold and for a name it already holds —
 *   with nothing written.
 */
export async function renameScope(
  root: string,
  from: string,
  to: string,
  options: EditOptions = {},
): Promise<ScopeRenameResult> {
  assertScopeName(to);

  const catalog = await readCatalog(root);
  assertRegistered(catalog, from);

  const renames = renamesFor(catalog.scopes, from, to);
  assertNoCollision(catalog.scopes, renames);

  const registry = await CatalogDocument.open(root, SCOPES_FILENAME);
  registry.renameKeys([REGISTRY_KEY], renames);
  const documents: CatalogDocument[] = [registry];

  for (const skill of catalog.skills) {
    const declared = rewritten(skill.scopes, renames);
    if (declared === undefined) continue;
    const document = await CatalogDocument.open(root, skillDocumentOf(skill));
    document.setStringList(SKILL_SCOPES_PATH, declared);
    documents.push(document);
  }

  for (const mcp of catalog.mcps) {
    const declared = rewritten(mcp.scopes, renames);
    if (declared === undefined) continue;
    // The file the author wrote, not the extension ambit would have chosen: `mcps/<name>.yaml` is as
    // legal as `.yml`, and rewriting the other one would leave two files defining one
    // server — which parsing rejects, so the rename would fail with nothing written.
    const document = await CatalogDocument.open(root, await mcpDocumentFile(root, mcp.name));
    document.setStringList(ENTITY_SCOPES_PATH, declared);
    documents.push(document);
  }

  // The third namespace, on the same terms: a hook declares scopes like anything else in a catalog, so
  // a rename that skipped it would leave the hook declaring a name the registry no longer holds — which
  // the editor refuses as a whole, so the rename would fail rather than half-land.
  for (const hook of catalog.hooks) {
    const declared = rewritten(hook.scopes, renames);
    if (declared === undefined) continue;
    const document = await CatalogDocument.open(root, hookDocumentOf(hook));
    document.setStringList(ENTITY_SCOPES_PATH, declared);
    documents.push(document);
  }

  const result = await applyCatalogEdit(root, changesOf(documents), options);
  return {
    renamed: [...renames].map(([before, after]) => ({ from: before, to: after })),
    changes: result.changes,
    written: result.written,
  };
}

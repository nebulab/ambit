/**
 * The hook commands: `ambit catalog hook new|rm`.
 *
 * A hook sits between the two authoring modules that came before it, and takes one half from each.
 * Its *identity* is a skill's: a directory under `hooks/`, named by where it sits, because a hook may
 * ship the script it runs beside its own document. Its *document* is an MCP entity's: `HOOK.yml` is
 * ambit's own end to end, so `new` writes the whole file through `emitYaml` (authoring rule 3) rather
 * than editing a block inside somebody else's frontmatter.
 *
 * - **`new` writes one file**, and the directory exists because that file is written inside it. What it
 *   is given is a {@link HookDeclaration}, whose `event` is a `HookEvent` rather than a string — the
 *   same stance `catalog mcp new` takes on `transport`, so a document ambit writes can never name an
 *   event nothing supports. The two rules this module deliberately does *not* restate are the parser's:
 *   a `matcher` on an event that carries no tool, and a `command` naming a script the directory does
 *   not hold, are both refused when the editor validates the result — before anything is written, and
 *   in the one place each rule is stated.
 * - **`rm` deletes a directory, not a file**, because the hook may have shipped a script and a command
 *   that removed only the `HOOK.yml` would leave bytes nothing can explain. It refuses while any skill
 *   requires `hook.<name>`, naming every requirer: the editor would refuse the write anyway, since a
 *   dangling requirement does not validate, but the list of files to fix is the useful answer. It also
 *   refuses a directory that holds *another* hook, which removing would silently delete.
 *
 * `new` declares no scopes, because its own surface has no `--scope` — `catalog mcp new`'s argument,
 * and it holds here for the same reason: a new hook is reachable only through a skill's `requires`
 * until someone gives it a `scopes` entry, and the command says so on the way out.
 *
 * Both write through the B02 editor, so they inherit atomic writes, the root check, `--dry-run`, and
 * validation of the whole result.
 */
import path from "node:path";

import type { Catalog, CatalogHook, CatalogSkill } from "../model/catalog.js";
import {
  HOOKS_DIRNAME,
  HOOK_FILENAME,
  SKILL_FILENAME,
  parseCatalogDirectory,
} from "../model/catalog.js";
import type { EditOptions, EditResult } from "./editor.js";
import { applyCatalogEdit, hookDocumentPath } from "./editor.js";
import type { AmbitError } from "../errors.js";
import { at, configError, resolutionError } from "../errors.js";
import type { HookEvent } from "../model/hook-entity.js";
import { requirementFor } from "../resolution/resolve.js";
import { emitYaml } from "../model/yaml.js";

/**
 * What joins a hook name's segments, which is what `/` becomes in its path. The same separator a
 * skill's name uses, and the same convention: `hooks/repo/block-rm/` is the hook `repo.block-rm`.
 */
const NAME_SEPARATOR = ".";

/** The keys a hook document holds. Every one of them is ambit's. */
const NAME_KEY = "name";
const DESCRIPTION_KEY = "description";
const EVENT_KEY = "event";
const MATCHER_KEY = "matcher";
const COMMAND_KEY = "command";
const TIMEOUT_KEY = "timeout";
const ENV_KEY = "env";

/** What an edit to a hook amounted to: the editor's own report, unchanged. */
export type HookEdit = EditResult;

/** A hook as a report names it: what it is called, when it fires, and what it runs. */
export interface HookSummary {
  readonly name: string;
  readonly event: HookEvent;
  /** The `command` as written, before any harness rewrites a shipped script's path. */
  readonly command: string;
}

export interface HookNewResult extends HookEdit {
  readonly created: HookSummary;
}

export interface HookRemoveResult extends HookEdit {
  readonly removed: string;
}

/**
 * What a new hook declares: every key of the entity but the two the catalog decides — `name`, which
 * is the path, and `scopes`, which this command is given no way to set.
 */
export interface HookDeclaration {
  readonly event: HookEvent;
  /** A command line, or a path to a file the hook's own directory ships. */
  readonly command: string;
  /** Absent leaves the key out rather than writing an empty one. */
  readonly description?: string;
  /** Only meaningful on a matchable event, which the parser is what enforces. */
  readonly matcher?: string;
  /** Seconds. */
  readonly timeout?: number;
  /** Env vars the hook needs. */
  readonly env?: readonly string[];
}

export interface HookNewOptions extends EditOptions, HookDeclaration {}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A list as ambit writes it into a file it is creating: sorted and deduplicated.
 *
 * `env` only, and for the reason `mcp new` sorts its own: the order argv happened to give a set of
 * variable names is not information, and sorting is what makes two runs with the same flags in a
 * different order produce the same bytes.
 */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

/** Where a hook's annotations are written, from the path the catalog derived its name from. */
function hookDocumentOf(hook: CatalogHook): string {
  return `${hook.path}/${HOOK_FILENAME}`;
}

/**
 * Rejects a name that cannot be a path under `hooks/`.
 *
 * The name↔path convention is the whole of a hook's identity, so a name that does not survive the
 * round trip is refused here rather than written and rejected on the next read — the same check
 * `catalog skill new` makes, for the same reason.
 *
 * @throws {AmbitError} exit 2, naming the directory the hook would have gone in.
 */
function assertHookName(name: string): void {
  const segments = name.split(NAME_SEPARATOR);
  const usable = segments.every(
    (segment) => segment.trim() !== "" && !segment.includes("/") && !segment.includes("\\"),
  );
  if (usable) return;

  throw configError(`invalid hook name "${name}" ${at(HOOKS_DIRNAME, undefined)}`, [
    `a hook's name is its path under ${HOOKS_DIRNAME}/, so it is segments joined by \`${NAME_SEPARATOR}\`, none of them empty and none a path of its own`,
    "name it like `block-rm`",
  ]);
}

/** The error for a name this catalog already provides a hook under (a name conflict). */
function alreadyProvided(hook: CatalogHook): AmbitError {
  return resolutionError(
    `hook "${hook.name}" already exists ${at(hookDocumentOf(hook), undefined)}`,
    [
      "a name means one thing, and this catalog already gave it to a hook",
      "pick another name, or edit the hook that is there",
    ],
  );
}

/**
 * The error for a hook this catalog does not provide.
 *
 * No "did you mean": a hook name is not chosen from a registry the way a scope is, so a near miss is
 * as likely to be a different hook as a typo — the stance `catalog skill rm` and `catalog mcp rm` both
 * take. What the reader gets instead is the rule that turns a path into a name.
 *
 * Exported so `catalog annotate` refuses an unknown hook in these exact words: one identity, one way of
 * saying the catalog does not have it.
 */
export function unknownHook(name: string): AmbitError {
  return resolutionError(`unknown hook "${name}" ${at(hookDocumentPath(name), undefined)}`, [
    "this catalog provides no hook by that name",
    `a hook's name is its path under ${HOOKS_DIRNAME}/ with \`/\` replaced by \`${NAME_SEPARATOR}\``,
  ]);
}

/** How a requirer reads in a refusal: what it is called, and where the `requires` entry is written. */
function requires(skill: CatalogSkill): string {
  return `skill "${skill.name}" requires it ${at(`${skill.path}/${SKILL_FILENAME}`, undefined)}`;
}

/**
 * The error for removing a hook a skill still requires.
 *
 * The requirement is spelled by {@link requirementFor}, which is the one place a `requires` entry is
 * written from an item — so this refusal cannot disagree with the closure about what `hook.<name>`
 * means. Only a skill can require a hook, so the name the reader passes is a skill's: no prefix on
 * that one, unlike the requirement being cleared.
 */
function stillRequired(hook: CatalogHook, requirers: readonly string[]): AmbitError {
  const requirement = requirementFor({ kind: "hook", name: hook.name });
  return resolutionError(
    `hook "${hook.name}" is still required ${at(hookDocumentOf(hook), undefined)}`,
    [
      ...requirers,
      `clear it from each with \`ambit catalog annotate <skill> --remove-requires ${requirement}\``,
    ],
  );
}

/**
 * The error for a hook directory that holds another hook.
 *
 * A nested hook is legal — the walk finds a `HOOK.yml` wherever it sits — but it is not part of the
 * hook above it, so removing the outer directory would silently delete it. The same refusal
 * `catalog skill rm` makes about a nested skill.
 */
function holdsHook(hook: CatalogHook, nested: CatalogHook): AmbitError {
  return resolutionError(
    `cannot remove hook "${hook.name}": it holds another hook ${at(hook.path, undefined)}`,
    [
      `hook "${nested.name}" is written inside it ${at(hookDocumentOf(nested), undefined)}`,
      `remove it first, with \`ambit catalog hook rm ${nested.name}\``,
    ],
  );
}

/**
 * Parses the catalog in `root`, which is also the check that it is one.
 *
 * The whole catalog rather than the one hook: `rm` is a question about who requires it and what sits
 * inside it, and `new` is a question about what the catalog already provides. The same read every
 * other authoring command does.
 */
async function readCatalog(root: string): Promise<Catalog> {
  return parseCatalogDirectory(path.basename(root), `path:${root}`, root);
}

/**
 * The hook `name` refers to.
 *
 * @throws {AmbitError} exit 3 when the catalog provides no such hook.
 */
function provided(catalog: Catalog, name: string): CatalogHook {
  const hook = catalog.hooks.find((candidate) => candidate.name === name);
  if (hook === undefined) throw unknownHook(name);
  return hook;
}

/** @throws {AmbitError} exit 3 if any skill requires `hook`, naming every one of them. */
function assertNothingRequires(catalog: Catalog, hook: CatalogHook): void {
  const requirement = requirementFor({ kind: "hook", name: hook.name });
  const requirers = catalog.skills.filter((skill) => skill.requires.includes(requirement));
  if (requirers.length === 0) return;
  throw stillRequired(hook, requirers.map(requires));
}

/** @throws {AmbitError} exit 3 if another hook's directory sits inside `hook`'s. */
function assertHoldsNoHook(catalog: Catalog, hook: CatalogHook): void {
  const nested = catalog.hooks.find((candidate) => candidate.path.startsWith(`${hook.path}/`));
  if (nested === undefined) return;
  throw holdsHook(hook, nested);
}

/**
 * A new hook's `HOOK.yml`.
 *
 * The whole document goes through `emitYaml`, so its keys are sorted and a value that would otherwise
 * coerce is quoted — which matters most for `command`, the one key holding a shell fragment. Every key
 * ambit was given nothing for is left out rather than written empty: absent and empty mean the same
 * thing to the parser, and the shorter file is the one a reader can see the point of. That includes
 * `scopes`, which this command is given no way to set.
 */
function renderHook(name: string, declaration: HookDeclaration): string {
  const env = sortedUnique(declaration.env ?? []);

  return emitYaml({
    [COMMAND_KEY]: declaration.command,
    ...(declaration.description !== undefined && {
      [DESCRIPTION_KEY]: declaration.description,
    }),
    ...(env.length > 0 && { [ENV_KEY]: env }),
    [EVENT_KEY]: declaration.event,
    ...(declaration.matcher !== undefined && { [MATCHER_KEY]: declaration.matcher }),
    [NAME_KEY]: name,
    ...(declaration.timeout !== undefined && { [TIMEOUT_KEY]: declaration.timeout }),
  });
}

/**
 * Creates a hook: one directory, one `HOOK.yml`, and nothing else.
 *
 * A hook that ships a script is created the other way round — put the script in
 * `hooks/<name>/` first, then declare it — because `command` naming a file the directory does not hold
 * is what parsing refuses, and it refuses it here, before anything is written.
 *
 * @param root the catalog root, absolute.
 * @param name the hook's name, which decides where it is written.
 * @param options what the hook declares, and `--dry-run`.
 * @throws {AmbitError} exit 2 for a name that cannot be a path, a catalog that does not parse, a
 *   `matcher` on an event that carries no tool, a `command` naming a script the directory does not
 *   hold, or a write that fails; exit 3 for a name the catalog already provides or a result that would
 *   not validate — with nothing written.
 */
export async function newHook(
  root: string,
  name: string,
  options: HookNewOptions,
): Promise<HookNewResult> {
  assertHookName(name);

  const catalog = await readCatalog(root);
  const existing = catalog.hooks.find((candidate) => candidate.name === name);
  if (existing !== undefined) throw alreadyProvided(existing);

  const change = { file: hookDocumentPath(name), text: renderHook(name, options) };
  const result = await applyCatalogEdit(root, [change], options);

  return {
    created: { name, event: options.event, command: options.command },
    ...result,
  };
}

/**
 * Deletes a hook's whole directory, script included.
 *
 * @param root the catalog root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for a catalog that does not parse or a removal that fails; exit 3 for a
 *   hook the catalog does not provide, one a skill still requires, or one whose directory holds
 *   another hook — with nothing removed.
 */
export async function removeHook(
  root: string,
  name: string,
  options: EditOptions = {},
): Promise<HookRemoveResult> {
  const catalog = await readCatalog(root);
  const hook = provided(catalog, name);

  assertNothingRequires(catalog, hook);
  assertHoldsNoHook(catalog, hook);

  const result = await applyCatalogEdit(root, [{ directory: hook.path, to: null }], options);
  return { removed: hook.name, ...result };
}

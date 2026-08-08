/**
 * `ambit outdated` and `ambit update` — moving a pin, and finding out what moving it would cost.
 *
 * The lock records the commit each catalog resolved to, and until now nothing moved one forward: the
 * git cache refetches only when it cannot answer a ref (`src/model/git.ts`), so `ref: main` keeps
 * meaning whatever it meant the first time. Editing `ref:` by hand and reinstalling worked, and told
 * you nothing about what changed until you read the lock diff afterwards.
 *
 * Both commands are one shape with one switch. Resolve the project twice — once from the cache as it
 * stands, once with the named catalogs' refs resolved against the remote — and hand the two bundles to
 * {@link diffBundles}. What differs is the *refresh mode*: `outdated` probes, so the cache's own refs
 * are untouched and nothing a later command does changes; `update` advances, so the cache moves and
 * the install that follows writes the new commits into the lock. That is the whole of the difference
 * between reporting and doing, and it lives in one field.
 *
 * `update` installs by calling `installProject`, which resolves a third time. That is deliberate:
 * install is the only thing that knows how to install, and by the time it runs the cache already holds
 * the advanced refs, so it resolves to exactly what this module just reported and reaches the network
 * not at all. A seam for handing it a pre-resolved bundle would buy one catalog parse and cost the
 * guarantee that `ambit update` and `ambit install` install the same way.
 *
 * Every source a project has is a catalog — an item cannot be declared anywhere else — so `update`
 * naming catalogs is the whole of what there is to move, and no `ref:` is left outside its reach.
 */
import type { Catalog, CatalogLoadOptions } from "../model/catalog.js";
import { loadCatalogs, mergeCatalogs } from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import { loadProjectConfig } from "../model/config.js";
import { AmbitError, ExitCode, at, configError } from "../errors.js";
import { unionExpectations } from "../model/expectation.js";
import type { BundleDiff } from "./bundle-diff.js";
import { diffBundles } from "./bundle-diff.js";
import type { RefreshMode } from "../model/git.js";
import type { InstallOptions, InstallResult } from "./install.js";
import { installProject } from "./install.js";
import type { Bundle } from "../resolution/resolve.js";
import { resolveBundle } from "../resolution/resolve.js";
import type { SourceContext } from "../model/sources.js";

/**
 * Where one catalog stands against its own `ref`.
 *
 * - `outdated` — the ref names a different commit than the project resolves to now.
 * - `current` — it names the same one.
 * - `pinned` — the `ref` is a commit, so there is nothing for it to name differently.
 * - `unversioned` — a `path:` source, which has no revision at all.
 *
 * `unversioned` is a separate word rather than `current` because the two are not the same claim. A
 * directory's contents can change between two runs exactly as a branch's can; what it has no way to
 * do is be *behind*, since there is no other revision for it to be behind of. `ambit status` is the
 * command that answers whether a `path:` catalog's bundle still matches what is installed.
 */
export const CATALOG_FRESHNESS = ["outdated", "current", "pinned", "unversioned"] as const;

export type CatalogFreshness = (typeof CATALOG_FRESHNESS)[number];

/** One catalog, and where its pin stands. */
export interface CatalogPin {
  readonly name: string;
  /** The `source` as config wrote it. */
  readonly source: string;
  /** The `ref` as config wrote it, absent when the entry named none — the source's default branch. */
  readonly ref?: string;
  readonly freshness: CatalogFreshness;
  /** The commit the project resolves to now. Absent for a `path:` source. */
  readonly commit?: string;
  /** The commit the ref names on the remote. Absent for a `path:` source; equal to `commit` unless outdated. */
  readonly latest?: string;
}

/** What both commands compute: where every pin stands, and what moving them would change. */
export interface UpdatePlan {
  /** Every configured catalog, in config order, whether or not this run refreshed it. */
  readonly catalogs: readonly CatalogPin[];
  readonly diff: BundleDiff;
}

/** What `ambit update` did: the plan it acted on, and the install that carried it out. */
export interface UpdateResult extends UpdatePlan {
  readonly install: InstallResult;
}

/** How a check or an update was asked to behave. */
export interface UpdateOptions {
  /**
   * The catalogs to refresh, by name. Absent — and empty — means every one of them.
   *
   * A name no catalog carries is an error rather than a no-op: `ambit update compnay` reporting
   * "nothing to do" is a typo that looks like an answer.
   */
  readonly catalogs?: readonly string[];
}

/** Everything `update` passes through to the install it ends with. */
export type UpdateInstallOptions = Pick<InstallOptions, "adopt" | "mode">;

/** Whether any pin has somewhere to move. */
export function hasOutdated(plan: UpdatePlan): boolean {
  return plan.catalogs.some((catalog) => catalog.freshness === "outdated");
}

/**
 * The error for a named catalog the project does not configure.
 *
 * @throws {AmbitError} exit 2 naming the configured catalogs, since the fix is always one of them.
 */
function unknownCatalog(name: string, config: ProjectConfig): never {
  const configured = config.catalogs.map((catalog) => catalog.name);
  throw configError(
    `unknown catalog "${name}" ${at(config.origin.file, undefined)}`,
    configured.length === 0
      ? [
          "this project configures no catalogs at all",
          "add one under `catalogs`, then run the command again",
        ]
      : [
          `this project configures: ${configured.join(", ")}`,
          "correct the name, or omit it to take every catalog",
        ],
  );
}

/**
 * How each catalog may consult its remote: `mode` for the named ones, nothing for the rest.
 *
 * One case this cannot narrow, and it is a property of the cache rather than of the plan: two
 * catalogs can be two refs of *one* repository, and a clone is shared. Advancing either advances the
 * clone, so `ambit update company` moves a sibling pointed at the same repository too. The report
 * still tells the truth — the sibling's row reads `outdated` and its change appears in the diff — so
 * the run does more than it was asked rather than more than it says.
 *
 * @throws {AmbitError} exit 2 for a name no catalog carries.
 */
function refreshPlan(
  config: ProjectConfig,
  named: readonly string[] | undefined,
  mode: RefreshMode,
): ReadonlyMap<string, RefreshMode> {
  const configured = new Set(config.catalogs.map((catalog) => catalog.name));
  if (named === undefined || named.length === 0) {
    return new Map([...configured].map((name) => [name, mode]));
  }

  const plan = new Map<string, RefreshMode>();
  for (const name of named) {
    if (!configured.has(name)) unknownCatalog(name, config);
    plan.set(name, mode);
  }
  return plan;
}

/** One pass of the two below: what the catalogs were, and what they resolved to. */
interface Resolution {
  readonly catalogs: readonly Catalog[];
  readonly bundle: Bundle;
}

/** Resolves the project through one load, so the two passes below cannot differ in anything else. */
async function resolveWith(
  config: ProjectConfig,
  context: SourceContext,
  options: CatalogLoadOptions,
): Promise<Resolution> {
  const catalogs = await loadCatalogs(config, context, options);
  return { catalogs, bundle: resolveBundle(config, mergeCatalogs(catalogs)) };
}

/**
 * The `before` pass, with a cache it cannot resolve reported as *nothing* rather than thrown.
 *
 * The one pass that must not be fatal, because of what it is asked about. A catalog moves on, and the
 * commit sitting in the cache stops resolving — a skill now requiring a hook the older commit did not
 * ship yet, a name the catalog has since corrected. The project is fine and the remote is fine; the
 * only broken thing is the stale copy, and `ambit update` is precisely the command that replaces it.
 * Failing here would make the one command that can fix that state the second casualty of it, leaving
 * a hand-deleted cache directory as the only way out.
 *
 * So a config, catalog, or resolution failure means "there is no previous bundle" and the run reports
 * against an empty one: every item reads as added, which is the truth of it — nothing resolved before.
 * A *network* failure is re-thrown, because that one is not about the cache being stale and the
 * refreshing pass is about to hit it too, with a better message.
 */
async function resolveBefore(
  config: ProjectConfig,
  context: SourceContext,
): Promise<Resolution | undefined> {
  try {
    return await resolveWith(config, context, {});
  } catch (error) {
    if (error instanceof AmbitError && error.code !== ExitCode.Network) return undefined;
    throw error;
  }
}

/** The bundle a project that does not resolve is compared against: nothing selected, nothing expected. */
const NOTHING: Bundle = {
  skills: [],
  mcps: [],
  hooks: [],
  expects: unionExpectations([]),
  reasons: { skills: new Map(), mcps: new Map(), hooks: new Map() },
};

/**
 * Where one catalog's pin stands, from the two resolutions of it.
 *
 * `moving` decides `pinned` rather than the shape of the `ref` string: a hex-looking branch name is a
 * legitimate thing, and the refresh already asked git which kind of ref answered.
 */
function pinOf(before: Catalog, after: Catalog | undefined): CatalogPin {
  const base = {
    name: before.name,
    source: before.source,
    ...(before.ref !== undefined && { ref: before.ref }),
  };

  // No commit on either side is a `path:` source: there is no revision, so there is nothing to be
  // behind of.
  if (before.commit === undefined || after?.commit === undefined) {
    return { ...base, freshness: "unversioned" };
  }

  const commits = { commit: before.commit, latest: after.commit };
  if (after.moving === false) return { ...base, ...commits, freshness: "pinned" };
  return {
    ...base,
    ...commits,
    freshness: before.commit === after.commit ? "current" : "outdated",
  };
}

/**
 * Where one catalog's pin stands when the cache it stood on did not resolve at all.
 *
 * Read off the refreshing pass alone, since it is the only one there is. `outdated` rather than
 * `current` for anything that can move: what the cache held is unusable and what the remote holds is
 * not, so the pin has somewhere to go even in the case where the two commits turn out to be equal —
 * which they cannot be here, since one of them resolves and the other does not.
 */
function unresolvedPinOf(after: Catalog): CatalogPin {
  const base = {
    name: after.name,
    source: after.source,
    ...(after.ref !== undefined && { ref: after.ref }),
  };

  if (after.commit === undefined) return { ...base, freshness: "unversioned" };
  // No `commit`: the project resolves to nothing right now, and naming the commit it failed at as
  // the one it "resolves to" would be the one thing this row must not claim.
  if (after.moving === false) return { ...base, latest: after.commit, freshness: "pinned" };
  return { ...base, latest: after.commit, freshness: "outdated" };
}

/**
 * Resolves the project twice and compares the two bundles.
 *
 * The unrefreshed pass runs first, and that ordering is load-bearing under `advance`: once the cache's
 * refs have moved, the question "what does this project resolve to *now*" has no answer left.
 *
 * It is also allowed to come back empty-handed — see {@link resolveBefore} — in which case the report
 * is against a project that resolved to nothing, rather than a report that never happened.
 *
 * @param mode `"probe"` for a report that must change nothing, `"advance"` to move the cache forward.
 * @throws {AmbitError} exit 2 for a malformed config, a catalog name the project does not configure,
 *   or an unreadable catalog; exit 3 for a resolution error; exit 4 if a fetch fails, or under
 *   `--offline`, which forbids reaching a remote at all. All of them from the refreshing pass: the
 *   unrefreshed one throws only what it cannot answer by refreshing.
 */
async function planUpdate(
  projectDir: string,
  mode: RefreshMode,
  options: UpdateOptions,
): Promise<UpdatePlan> {
  const config = await loadProjectConfig(projectDir);
  const refresh = refreshPlan(config, options.catalogs, mode);
  const context: SourceContext = { projectDir, env: process.env };

  const before = await resolveBefore(config, context);
  const after = await resolveWith(config, context, { refresh });

  const latest = new Map(after.catalogs.map((catalog) => [catalog.name, catalog]));
  return {
    catalogs:
      before === undefined
        ? after.catalogs.map(unresolvedPinOf)
        : before.catalogs.map((catalog) => pinOf(catalog, latest.get(catalog.name))),
    diff: await diffBundles(before?.bundle ?? NOTHING, after.bundle),
  };
}

/**
 * `ambit outdated` — where every pin stands, and what moving it would bring.
 *
 * Probes rather than fetches, so running it changes nothing about what a later `ambit install` does.
 * That is not a nicety: the cache is what makes a moving `ref:` deterministic between runs, and a
 * read-only command that quietly advanced it would move a pin nobody asked to move.
 *
 * @param projectDir the project root, absolute.
 * @throws {AmbitError} everything {@link planUpdate} throws. Being outdated is never one of them: it
 *   is the report.
 */
export async function checkOutdated(
  projectDir: string,
  options: UpdateOptions = {},
): Promise<UpdatePlan> {
  return planUpdate(projectDir, "probe", options);
}

/**
 * `ambit update --dry-run` — the same report, restricted to the catalogs the run named.
 *
 * Literally {@link checkOutdated} with the options passed through, and that is the answer to whether a
 * dry-run update is its own thing: it is not. A preview cannot go on to preview the *install*, because
 * the install it would preview is the one against the pins as they stand — the run has deliberately
 * not moved them — so a plan of artifacts here would describe the wrong resolution. What a dry run
 * owes a reader is which pins would move and what the bundle would gain and lose, and that is exactly
 * the report `outdated` is.
 */
export async function previewUpdate(
  projectDir: string,
  options: UpdateOptions = {},
): Promise<UpdatePlan> {
  return checkOutdated(projectDir, options);
}

/**
 * `ambit update` — move the pins, then install.
 *
 * The install is `installProject`, unchanged and unhelped: by the time it runs the cache holds the
 * advanced refs, so it resolves to what was just reported without reaching the network, and `ambit
 * update` and `ambit install` install by exactly one code path.
 *
 * @param projectDir the project root, absolute.
 * @param options which catalogs to move.
 * @param install `--adopt` and `--copy`/`--link`, passed through. Not `--frozen`: an update exists to
 *   change the lock, so a flag that fails when the lock would change is a contradiction rather than a
 *   combination, and it is not offered.
 * @throws {AmbitError} everything {@link planUpdate} and `installProject` throw.
 */
export async function updateProject(
  projectDir: string,
  options: UpdateOptions = {},
  install: UpdateInstallOptions = {},
): Promise<UpdateResult> {
  const plan = await planUpdate(projectDir, "advance", options);
  return { ...plan, install: await installProject(projectDir, install) };
}

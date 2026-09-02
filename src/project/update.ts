/**
 * `ambit outdated` and `ambit update` — moving a pin, and finding out what moving it would cost.
 *
 * The lock records the commit each catalog resolved to, and every other command resolves to that
 * commit (`readCatalogPins`), so these two are the only way a pin moves. Editing `ref:` by hand and
 * reinstalling also works, but it tells you nothing about what changed until you read the lock diff
 * afterwards.
 *
 * Both commands share one shape with one switch: resolve the project twice (once from the cache as it
 * stands, once with the named catalogs' refs resolved against the remote) and hand the two bundles to
 * {@link diffBundles}. The *refresh mode* is what differs: `outdated` probes, leaving the cache's refs
 * untouched; `update` advances them, so the install that follows writes the new commits into the lock.
 *
 * `update` installs by calling `installProject`, which resolves a third time. This is deliberate:
 * install is the only thing that knows how to install, and by the time it runs the cache already holds
 * the advanced refs, so it resolves to exactly what this module just reported without touching the
 * network again. A seam for handing it a pre-resolved bundle would save one catalog parse at the cost
 * of the guarantee that `ambit update` and `ambit install` install the same way.
 *
 * Every source a project has is a catalog, so naming catalogs to `update` covers everything there is
 * to move; no `ref:` is left outside its reach.
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
import { readCatalogPins } from "./lock.js";
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
 * `unversioned` is a separate word from `current` because the two are not the same claim: a
 * directory's contents can change between runs exactly as a branch's can, but it has no way to be
 * *behind*, since there's no other revision to be behind of. `ambit status` is the command that
 * answers whether a `path:` catalog's bundle still matches what is installed.
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
 * One case this can't narrow: two catalogs can be two refs of one repository, sharing a clone.
 * Advancing either advances the clone, so `ambit update company` moves a sibling pointed at the same
 * repository too. The report still tells the truth: the sibling's row reads `outdated` and its change
 * appears in the diff.
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

/**
 * The report, plus which catalogs this run refreshed.
 *
 * The second field isn't part of the report — nobody reading `ambit outdated` needs it — but it's what
 * the install at the end of `ambit update` must be told: those catalogs' lock pins are the commits the
 * update is replacing, and an install that honored them would undo it. Kept internal for that reason.
 */
interface PlannedUpdate {
  readonly plan: UpdatePlan;
  /** The catalogs whose pin this run moved past, by name. */
  readonly released: readonly string[];
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
 * Both passes are given the lock's pins; the refresh is what overrides them.
 *
 * The `before` pass must be the commit the project resolves to today, which for a pinned catalog is the
 * locked commit, not whatever the shared clone's `refs/heads/main` happens to hold. Otherwise the
 * report's `commit` column would name a commit the project would not install. The `after` pass gets the
 * same pins plus the refresh plan on top; a refresh wins per catalog (`fetchGitSource` ignores a pin
 * unless it is resolving from the cache), so a named catalog is answered by the remote and an unnamed
 * one stays exactly where it was pinned. That's what makes `ambit update company` a claim about
 * `company` alone.
 */
function loadOptions(
  pins: ReadonlyMap<string, string>,
  refresh?: ReadonlyMap<string, RefreshMode>,
): CatalogLoadOptions {
  return { pins, ...(refresh !== undefined && { refresh }) };
}

/**
 * The `before` pass, with a cache it cannot resolve reported as nothing rather than thrown.
 *
 * This pass must not be fatal. A catalog can move on and leave the commit sitting in the cache
 * unresolvable (a skill now requiring a hook the older commit didn't ship, a name since corrected).
 * The project and the remote are both fine; only the stale copy is broken, and `ambit update` is the
 * command that replaces it. Failing here would make the fix for that state a casualty of it too,
 * leaving a hand-deleted cache directory as the only way out.
 *
 * So a config, catalog, or resolution failure means "there is no previous bundle," and the run reports
 * against an empty one: every item reads as added, which is true, since nothing resolved before. A
 * network failure is re-thrown: it isn't about the cache being stale, and the refreshing pass is about
 * to hit the same network with a better error message.
 */
async function resolveBefore(
  config: ProjectConfig,
  context: SourceContext,
  pins: ReadonlyMap<string, string>,
): Promise<Resolution | undefined> {
  try {
    return await resolveWith(config, context, loadOptions(pins));
  } catch (error) {
    if (error instanceof AmbitError && error.code !== ExitCode.Network) return undefined;
    throw error;
  }
}

/** The bundle a project that does not resolve is compared against: nothing selected, nothing expected. */
const NOTHING: Bundle = {
  packs: [],
  plugins: [],
  skills: [],
  mcps: [],
  hooks: [],
  expects: unionExpectations([]),
  reasons: {
    packs: new Map(),
    plugins: new Map(),
    skills: new Map(),
    mcps: new Map(),
    hooks: new Map(),
  },
};

/**
 * Where one catalog's pin stands, from the two resolutions of it.
 *
 * `moving` decides `pinned`, not the shape of the `ref` string: a hex-looking branch name is legitimate,
 * and the refresh already asked git which kind of ref answered.
 */
function pinOf(before: Catalog, after: Catalog | undefined): CatalogPin {
  const base = {
    name: before.name,
    source: before.source,
    ...(before.ref !== undefined && { ref: before.ref }),
  };

  // No commit on either side means a `path:` source: there is no revision, so nothing to be behind of.
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
 * Read off the refreshing pass alone, the only one there is. `outdated` rather than `current` for
 * anything that can move: what the cache held is unusable and what the remote holds is not, and the
 * two commits can't be equal here since one of them resolves and the other doesn't.
 */
function unresolvedPinOf(after: Catalog): CatalogPin {
  const base = {
    name: after.name,
    source: after.source,
    ...(after.ref !== undefined && { ref: after.ref }),
  };

  if (after.commit === undefined) return { ...base, freshness: "unversioned" };
  // No `commit`: the project resolves to nothing right now, so this row must not claim the commit it
  // failed at as the one it "resolves to".
  if (after.moving === false) return { ...base, latest: after.commit, freshness: "pinned" };
  return { ...base, latest: after.commit, freshness: "outdated" };
}

/**
 * Resolves the project twice and compares the two bundles.
 *
 * The unrefreshed pass runs first; that ordering is load-bearing under `advance`, since once the
 * cache's refs have moved, the question "what does this project resolve to now" has no answer left.
 *
 * It's also allowed to come back empty-handed (see {@link resolveBefore}), in which case the report is
 * against a project that resolved to nothing rather than a report that never happened.
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
): Promise<PlannedUpdate> {
  const config = await loadProjectConfig(projectDir);
  const refresh = refreshPlan(config, options.catalogs, mode);
  const context: SourceContext = { projectDir, env: process.env };
  const pins = await readCatalogPins(projectDir, config);

  const before = await resolveBefore(config, context, pins);
  const after = await resolveWith(config, context, loadOptions(pins, refresh));

  const latest = new Map(after.catalogs.map((catalog) => [catalog.name, catalog]));
  return {
    plan: {
      catalogs:
        before === undefined
          ? after.catalogs.map(unresolvedPinOf)
          : before.catalogs.map((catalog) => pinOf(catalog, latest.get(catalog.name))),
      diff: await diffBundles(before?.bundle ?? NOTHING, after.bundle),
    },
    released: [...refresh.keys()],
  };
}

/**
 * `ambit outdated` — where every pin stands, and what moving it would bring.
 *
 * Probes rather than fetches, so running it changes nothing about what a later `ambit install` does.
 * The cache is what makes a moving `ref:` deterministic between runs, so a read-only command that
 * quietly advanced it would move a pin nobody asked to move.
 *
 * @param projectDir the project root, absolute.
 * @throws {AmbitError} everything {@link planUpdate} throws. Being outdated is never one of them; it
 *   is the report.
 */
export async function checkOutdated(
  projectDir: string,
  options: UpdateOptions = {},
): Promise<UpdatePlan> {
  return (await planUpdate(projectDir, "probe", options)).plan;
}

/**
 * `ambit update --dry-run` — the same report, restricted to the catalogs the run named.
 *
 * Literally {@link checkOutdated} with the options passed through. It can't go on to preview the
 * install, because the install it would preview runs against the pins as they stand (this run has
 * deliberately not moved them), so a plan of artifacts here would describe the wrong resolution. What
 * a dry run owes a reader is which pins would move and what the bundle would gain and lose, which is
 * exactly the report `outdated` produces.
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
 * Installs via `installProject`, told one thing it doesn't otherwise know: which catalogs' lock pins
 * this run is replacing. Without that, it would reproduce the commits still written in the lock and
 * quietly undo the update. With it, those catalogs resolve from the cache whose refs this run just
 * advanced, so the install writes the commits that were reported without touching the network.
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
  const { plan, released } = await planUpdate(projectDir, "advance", options);
  return { ...plan, install: await installProject(projectDir, install, released) };
}

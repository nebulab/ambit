/**
 * Installation: resolve a project, then hand the bundle to each harness adapter.
 *
 * Order: load, resolve, plan, apply, write lock, write state, rewrite the gitignore block. The two
 * record-keeping writes (lock, state) come last: a crash mid-apply then leaves artifacts unowned but
 * present, which `doctor` can report, instead of state claiming files that were never written. The
 * lock records what *was* installed, so it must not claim a resolution that failed to materialize.
 *
 * Everything up to the first write is `planInstall`. `previewInstall` renders that plan for
 * `--dry-run` instead of applying it. `plan` is pure and testable; `apply` is the only thing that
 * touches disk. This split lets a dry run print the same plan rather than reimplement installation,
 * and lets `ambit prune` (`clean.ts`) reach the same bundle without materializing it.
 *
 * `--frozen` is checked before anything is written, so a CI run with a stale committed lock leaves
 * the project untouched (planning and reading state are both reads).
 *
 * Every adapter plans before any of them applies, so ownership (`ownership.ts`) is checked against
 * the complete set of targets while the project is still untouched.
 *
 * Pruning runs after the last adapter and before the two record-keeping writes, so a failed prune is
 * retryable (state still owns what it was about to remove) and a failed `apply` leaves the previous
 * install standing.
 *
 * Nothing here reads the environment. A `${VAR}` in an MCP entity becomes a reference in the target
 * harness's own syntax rather than a resolved value, so an adapter's `plan` is a pure function of the
 * bundle and the project; the environment is `doctor`'s concern, not install's.
 */
import type {
  AppliedArtifact,
  HarnessAdapter,
  PlannedArtifact,
  ProjectPaths,
  SkippedHook,
} from "../harness/adapter.js";
import { PROFILES } from "../harness/definitions.js";
import { adapterFor } from "../harness/profile.js";
import { loadCatalogs, mergeCatalogs } from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import { loadProjectConfig } from "../model/config.js";
import { configError } from "../errors.js";
import type { RefreshMode } from "../model/git.js";
import type { GitignoreStatus } from "./gitignore.js";
import { gitignoreStatus, writeGitignoreBlocks } from "./gitignore.js";
import type { Lock } from "./lock.js";
import {
  assertLockCurrent,
  buildLock,
  readCatalogPins,
  readLockText,
  serializeLock,
  writeLockText,
} from "./lock.js";
import { authorizePlan } from "./ownership.js";
import type { PrunedArtifact } from "./prune.js";
import { planPrune, pruneArtifacts } from "./prune.js";
import type { Bundle } from "../resolution/resolve.js";
import { resolveBundle } from "../resolution/resolve.js";
import type { SourceContext } from "../model/sources.js";
import type { ArtifactMode, State } from "../model/state.js";
import { STATE_VERSION, readState, writeState } from "../model/state.js";

/** Every adapter this build ships, keyed by the name `harnesses` uses. */
export const ADAPTERS: Readonly<Record<string, HarnessAdapter>> = Object.fromEntries(
  PROFILES.map((profile) => [profile.name, adapterFor(profile)]),
);

/** How an install was asked to behave. */
export interface InstallOptions {
  /** Fail rather than write when resolution would change the lock. */
  readonly frozen?: boolean;
  /** Resolve from the catalog cache alone, failing rather than fetching. */
  readonly offline?: boolean;
  /** Take ownership of existing unowned targets instead of refusing them. */
  readonly adopt?: boolean;
  /**
   * `--copy` / `--link`: materialize every skill this way, whatever its source would have chosen.
   * Absent means each skill follows its source, which is the mode to leave alone.
   */
  readonly mode?: ArtifactMode;
}

/** One adapter and the artifacts it would write. */
export interface AdapterPlan {
  readonly adapter: HarnessAdapter;
  readonly plan: readonly PlannedArtifact[];
}

/**
 * A project resolved and planned, with nothing written yet.
 *
 * Every mutating command starts from this: `install` applies it, `--dry-run` prints it, and `prune`
 * uses it to know what the current bundle keeps. Sharing it keeps the three from disagreeing about
 * what the bundle is.
 */
export interface PlannedInstall {
  readonly bundle: Bundle;
  /** The harnesses planned for, deduplicated and sorted. */
  readonly harnesses: readonly string[];
  /** Each adapter and its own plan, in harness order. */
  readonly plans: readonly AdapterPlan[];
  /** Every adapter's plan flattened — what ownership and pruning are answered against. */
  readonly artifacts: readonly PlannedArtifact[];
  /** Hooks a configured harness cannot express, in harness order. Reported, never fatal. */
  readonly skipped: readonly SkippedHook[];
  /** What the last install recorded owning. */
  readonly prior: State;
  readonly lock: Lock;
  /** The lock as the bytes an install would write, which is what `--frozen` compares. */
  readonly lockText: string;
}

/** What `install --dry-run` reports: everything the run would do, with the project untouched. */
export interface InstallPreview {
  readonly bundle: Bundle;
  readonly harnesses: readonly string[];
  /** What install would write. */
  readonly artifacts: readonly PlannedArtifact[];
  /** What install would skip: a hook a configured harness cannot express. */
  readonly skipped: readonly SkippedHook[];
  /** What install would remove, from state alone. */
  readonly pruned: readonly PrunedArtifact[];
  readonly lock: Lock;
  /** Whether `ambit.lock` would change. */
  readonly lockChanged: boolean;
  /** Whether each managed `.gitignore` block would change, one row per file. */
  readonly gitignore: readonly GitignoreStatus[];
}

/** What an install did, for the command to report. */
export interface InstallResult {
  readonly bundle: Bundle;
  /** The harnesses written for, deduplicated and sorted. */
  readonly harnesses: readonly string[];
  /** Everything now owned, in the order the adapters wrote it. */
  readonly artifacts: readonly AppliedArtifact[];
  /** Hooks a configured harness could not express, and so was not given. */
  readonly skipped: readonly SkippedHook[];
  /** What the previous install owned and this one does not, removed by path. */
  readonly pruned: readonly PrunedArtifact[];
  /** What was written to `ambit.lock`. */
  readonly lock: Lock;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolves configured harness names to adapters.
 *
 * Shared with `status.ts`, which has to plan through exactly the adapters install would use, or the
 * two commands could disagree about whether a project is installed.
 *
 * @throws {AmbitError} exit 2 for a harness this build has no adapter for — silently skipping it
 *   would leave a project believing it was installed.
 */
export function adaptersFor(harnesses: readonly string[]): readonly HarnessAdapter[] {
  return harnesses.map((name) => {
    const adapter = ADAPTERS[name];
    if (adapter === undefined) {
      throw configError(`unknown harness "${name}" (ambit.yml)`, [
        `this build ships adapters for: ${Object.keys(ADAPTERS).sort(compare).join(", ")}`,
        "remove it from `harnesses`, or correct the spelling",
      ]);
    }
    return adapter;
  });
}

/**
 * What makes two planned artifacts the same artifact.
 *
 * A path, for anything owned as a path. For a config file the path is not enough, because ambit owns
 * *keys* there, not the file: two harnesses writing different entries into one document both have to
 * write. Identity there is the whole write: the section, the driver, the root keys it seeds, and the
 * entries themselves.
 */
function identityOf(artifact: PlannedArtifact): string {
  if (artifact.kind !== "harness-config") return artifact.path;
  return JSON.stringify([
    artifact.path,
    artifact.section,
    artifact.format,
    artifact.shape,
    artifact.rootDefaults,
    artifact.entries,
  ]);
}

/**
 * Every adapter's plan, with each artifact planned exactly once.
 *
 * The skills directory is shared: every harness plans the same `.agents/skills/<name>` targets, and
 * two harnesses of one family plan the same skills link. A path is an artifact's identity, so the
 * first adapter to name one plans it and the rest defer. Without this, the second adapter's `apply`
 * finds a symlink the first just created and refuses, state records the same path twice, and
 * `install` prints it twice.
 *
 * A config file two harnesses write the *same* entries into is deduped the same way: Claude and VS
 * Code read one `.claude/settings.json`, so a project configuring both writes it once. Anything else
 * differing about a config artifact (a different section, a different rendering of the same hook)
 * makes it a second write, since dropping it would install less than the project asked for.
 *
 * A shared `.agents/hooks/<name>` dedupes the same way: every harness that can express a hook plans
 * the same directory for it.
 *
 * @param adapters the harnesses to plan for, in configured order, sorted so the result does not
 *   depend on `ambit.yml`'s spelling. This order decides who plans a shared target.
 */
export function planFor(
  adapters: readonly HarnessAdapter[],
  bundle: Bundle,
  project: ProjectPaths,
): readonly AdapterPlan[] {
  const claimed = new Set<string>();
  return adapters.map((adapter) => ({
    adapter,
    plan: adapter.plan(bundle, project).filter((artifact) => {
      const identity = identityOf(artifact);
      if (claimed.has(identity)) return false;
      claimed.add(identity);
      return true;
    }),
  }));
}

/**
 * What the command doing the planning contributes, as against what the CLI parsed into
 * {@link InstallOptions}.
 *
 * Separate from the options because neither field is a flag anyone types. They are how `install`,
 * `install --dry-run`, `prune`, and `ambit update`'s trailing install say which of them is asking.
 */
export interface PlanContext {
  /**
   * How a catalog with no pin to reproduce may consult its remote. Absent means not at all.
   *
   * See {@link catalogPlan} for why an unpinned catalog is the one that has to ask.
   */
  readonly refresh?: RefreshMode;
  /**
   * Catalogs whose recorded pin this run is deliberately moving past, by name.
   *
   * `ambit update`'s, and only `ambit update`'s. It has already advanced the shared clone's refs to the
   * commits it just reported, and the lock on disk still holds the commits it is replacing — so
   * honouring those pins would make the install undo the update it is part of.
   */
  readonly released?: readonly string[];
}

/** Which catalogs resolve to a recorded commit, and which are allowed to ask their remote. */
interface CatalogPlan {
  readonly pins: ReadonlyMap<string, string>;
  readonly refresh: ReadonlyMap<string, RefreshMode> | undefined;
}

/**
 * Decides, per catalog, whether it reproduces a commit or asks where its ref points.
 *
 * A pinned catalog reproduces: `readCatalogPins` hands back the commit the lock recorded for every
 * catalog whose `source` and `ref` still match config, and resolution takes that commit instead of
 * asking. This is what makes a committed lock mean something. Without it, a moving `ref:` would be
 * answered from the machine-wide git cache, which refetches only when it cannot resolve a ref at
 * all, so the commit a project got would be whatever the shared clone held, and any other project on
 * the machine could move it.
 *
 * An unpinned catalog asks. It is unpinned in three cases: no lock yet, a catalog added since the
 * lock was written, or a `ref:` just edited. None has an earlier resolution to reproduce, so `ref:
 * main` means the commit main names now. Inheriting the shared clone's answer instead would mean an
 * old catalog installs fine until it silently doesn't, surfacing later as a resolution error about a
 * catalog that has been correct upstream for weeks.
 *
 * A `released` catalog does neither: its pin is dropped, and it is not refreshed, because `ambit
 * update` already moved the clone to the commit it reported, and asking again risks a different
 * answer.
 *
 * `--offline` disables every refresh, but not pins: reproducing a recorded commit works offline
 * (the commit is in the cache), resolving a ref does not.
 *
 * `doctor`, `clean`, and `prune` plan with no refresh mode: they report on or dismantle what is
 * installed rather than asking what catalogs say today. They still honour pins, so all three agree
 * with the install they describe.
 *
 * `install` uses `"advance"`, not `"probe"`, for the same reason `ambit update` advances: the clone
 * is shared, so a probe would resolve against a commit the next run (reading the clone's own refs,
 * now with a lock) would disagree with. The cost, as `refreshPlan` in `update.ts` also notes, is that
 * another project pointed at the same repository sees the moved clone too.
 */
async function catalogPlan(
  projectDir: string,
  config: ProjectConfig,
  options: InstallOptions,
  plan: PlanContext,
): Promise<CatalogPlan> {
  const released = new Set(plan.released ?? []);
  const recorded = await readCatalogPins(projectDir, config);
  const pins = new Map([...recorded].filter(([name]) => !released.has(name)));

  if (plan.refresh === undefined || options.offline === true) return { pins, refresh: undefined };

  const mode = plan.refresh;
  const asking = config.catalogs
    .map((entry) => entry.name)
    .filter((name) => !pins.has(name) && !released.has(name));
  return {
    pins,
    refresh: asking.length === 0 ? undefined : new Map(asking.map((name) => [name, mode])),
  };
}

/**
 * Resolves the project and plans every adapter's writes, touching nothing.
 *
 * Everything up to the first write lives here, so `install`, `install --dry-run`, and `ambit prune`
 * share one notion of what the project resolves to. Reading state is part of it: it is an input to
 * the run, not something the run decides, and reading is not touching the project.
 *
 * @param projectDir the project root, absolute.
 * @param options `--offline` and `--copy`/`--link`, which are the two that change a plan.
 * @param plan which command is doing the planning — see {@link PlanContext} and {@link catalogPlan}.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, an unreadable
 *   state file, an unreadable `ambit.lock`, or a locked commit the repository does not have; exit 3 for
 *   a resolution error; exit 4 if a fetch fails, or under `--offline` when the cache cannot answer.
 */
export async function planInstall(
  projectDir: string,
  options: InstallOptions = {},
  plan: PlanContext = {},
): Promise<PlannedInstall> {
  const config = await loadProjectConfig(projectDir);
  const harnesses = [...new Set(config.harnesses)].sort(compare);
  const adapters = adaptersFor(harnesses);

  // `process.env` is read once, here, only for source resolution (where the cache lives, what a
  // `git:` source authenticates with). Nothing deeper reaches for ambient state of its own.
  const context: SourceContext = {
    projectDir,
    env: process.env,
    offline: options.offline === true,
  };

  const { pins, refresh } = await catalogPlan(projectDir, config, options, plan);
  const loaded = await loadCatalogs(config, context, {
    pins,
    ...(refresh !== undefined && { refresh }),
  });
  const bundle = resolveBundle(config, mergeCatalogs(loaded));

  // Serialized up front so `--frozen` compares the same bytes the run would go on to write, rather
  // than a second rendering that could differ.
  const lock = buildLock(loaded, bundle);
  const project: ProjectPaths = {
    root: projectDir,
    ...(options.mode !== undefined && { mode: options.mode }),
  };

  // Every adapter plans before any of them writes, so the ownership check sees every target before a
  // project whose second skill collides is left with its first one already installed.
  const plans = planFor(adapters, bundle, project);

  return {
    bundle,
    harnesses,
    plans,
    artifacts: plans.flatMap(({ plan }) => plan),
    // Asked of every configured adapter, not only the ones that planned something, so a harness with
    // no hook mechanism is reported as skipping every hook rather than silently.
    skipped: adapters.flatMap((adapter) => adapter.skips(bundle)),
    prior: await readState(projectDir),
    lock,
    lockText: serializeLock(lock),
  };
}

/**
 * What an install would do, without doing any of it — `install --dry-run`.
 *
 * A print of the plan rather than a second implementation of installation: the artifacts come from
 * the same `plan` call `apply` would receive, the removals from the same `planPrune` install acts on,
 * and the two derived files come from the same pure functions that write them, asked whether they
 * would change anything.
 *
 * Ownership is checked, because a refusal is part of what would happen: a dry run of an install that
 * would stop should also stop, and say why.
 *
 * @param projectDir the project root, absolute.
 * @param options every flag `install` takes; `--frozen` still refuses a stale lock, since refusing is
 *   not a mutation.
 * @throws {AmbitError} everything `installProject` throws before its first write — exit 2 for a
 *   malformed config or an unowned target, exit 3 for a resolution error, exit 4 for a fetch, exit 5
 *   under `--frozen`.
 */
export async function previewInstall(
  projectDir: string,
  options: InstallOptions = {},
): Promise<InstallPreview> {
  // `"probe"`, not `"advance"`: an unpinned catalog resolves against what the remote says now (see
  // {@link catalogPlan}), and a preview must report that commit without moving the cache's own refs.
  const planned = await planInstall(projectDir, options, { refresh: "probe" });
  if (options.frozen === true) await assertLockCurrent(projectDir, planned.lockText);
  await authorizePlan(planned.artifacts, planned.prior, { adopt: options.adopt === true });

  const pruned = planPrune(planned.artifacts, planned.prior);
  const gitignore = await gitignoreStatus(projectDir, planned.artifacts);

  return {
    bundle: planned.bundle,
    harnesses: planned.harnesses,
    artifacts: planned.artifacts,
    skipped: planned.skipped,
    pruned,
    lock: planned.lock,
    lockChanged: (await readLockText(projectDir)) !== planned.lockText,
    gitignore,
  };
}

/**
 * Resolves the project and materializes the bundle.
 *
 * @param projectDir the project root, absolute.
 * @param options `--frozen`, `--offline`, `--adopt`, `--copy`/`--link`.
 * @param released catalogs whose recorded pin this install is moving past — `ambit update`'s, and see
 *   {@link PlanContext.released}. Empty for every other caller, which is what makes a plain `install`
 *   reproduce the lock rather than move it.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, a target path
 *   or config key ambit does not own and was not told to adopt, or a locked commit the repository does
 *   not have; exit 4 if a fetch fails, or under `--offline` when the cache cannot answer; exit 5 under
 *   `--frozen` when the committed lock is not what resolution produces.
 */
export async function installProject(
  projectDir: string,
  options: InstallOptions = {},
  released: readonly string[] = [],
): Promise<InstallResult> {
  const planned = await planInstall(projectDir, options, { refresh: "advance", released });
  const { bundle, harnesses, plans, prior, lock, lockText, skipped } = planned;
  if (options.frozen === true) await assertLockCurrent(projectDir, lockText);

  const owner = await authorizePlan(planned.artifacts, prior, { adopt: options.adopt === true });

  const artifacts: AppliedArtifact[] = [];
  for (const { adapter, plan } of plans) {
    artifacts.push(...(await adapter.apply(plan, owner)));
  }

  // Against `prior`, not `owner`: what `--adopt` just took over is already in the plan, so the two
  // agree here, and pruning is answerable from what the last install recorded.
  const pruned = await pruneArtifacts(projectDir, planned.artifacts, prior);

  await writeLockText(projectDir, lockText);
  await writeState(projectDir, { version: STATE_VERSION, harnesses, artifacts });

  // Last, deliberately after state: the blocks are rendered afresh every run, so a failure here
  // costs nothing (the next install rewrites them), whereas failing before `writeState` would leave
  // correctly installed artifacts unowned and the next plain install refusing them.
  await writeGitignoreBlocks(projectDir, artifacts);

  return { bundle, harnesses, artifacts, skipped, pruned, lock };
}

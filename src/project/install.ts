/**
 * Installation: resolve a project, then hand the bundle to each harness adapter.
 *
 * The order is load → resolve → plan → apply → write lock → write state → rewrite the gitignore
 * block, and the two record-keeping
 * writes coming last is a safety property, not an implementation detail: a crash mid-apply leaves
 * artifacts unowned but present, which `doctor` can report, whereas recording ownership first would
 * leave state claiming files that were never written. The lock is written on the same terms — it
 * says what *was* installed, so it must not claim a resolution that failed to materialize.
 *
 * Everything up to the first write is `planInstall`, and `previewInstall` is that plan rendered for
 * `--dry-run` instead of applied: `plan` is pure and testable, and `apply` is the only thing
 * that touches disk. Keeping the split at the function boundary is what makes a dry run a print of
 * the same plan rather than a second implementation of installation — and what lets `ambit prune`
 * (`clean.ts`) reach the same bundle without materializing it.
 *
 * `--frozen` is checked before anything is written. A CI run whose committed lock is stale
 * has to leave the project exactly as it found it, so the comparison happens while nothing has been
 * touched — planning and reading state are both reads.
 *
 * Every adapter is asked to plan before any of them applies, so ownership can be checked against the
 * complete set of targets while the project is still untouched (`ownership.ts`).
 *
 * Pruning comes after the last adapter and before the two record-keeping writes, so
 * a prune that fails is retryable — state still owns what it was about to remove — and a failed
 * `apply` leaves the previous install standing rather than half-dismantled.
 *
 * Nothing here reads the environment on materialization's behalf. A `${VAR}` in an MCP entity becomes
 * a reference in the target harness's own syntax rather than a resolved value, so an adapter's `plan`
 * is a pure function of the bundle and the project, and the environment is `doctor`'s subject rather
 * than install's input.
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
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../model/catalog.js";
import { loadProjectConfig } from "../model/config.js";
import { configError } from "../errors.js";
import type { GitignoreStatus } from "./gitignore.js";
import { gitignoreStatus, writeGitignoreBlocks } from "./gitignore.js";
import type { Lock } from "./lock.js";
import {
  assertLockCurrent,
  buildLock,
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
 * This is the point every mutating command starts from: `install` applies it, `--dry-run` prints it,
 * and `prune` uses it only to know what the current bundle keeps. Sharing it is what stops the three
 * from disagreeing about what the bundle is — the same argument `status.ts` makes for planning
 * through the adapters rather than reasoning about state.
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
 * *keys* there rather than the file: two harnesses writing different entries into one document both
 * have to write, so identity is the whole write — the section, the driver it goes through, the root
 * keys it seeds, and the entries themselves.
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
 * The skills directory is shared, so *every* harness plans the same `.agents/skills/<name>` targets,
 * and two harnesses of one family plan the same skills link. Those are not two artifacts that happen
 * to collide — a path is an artifact's identity — so the first adapter to name one plans it and the
 * rest defer. Without this the second adapter's `apply` finds a symlink the first just created and
 * refuses, state records the same path twice, and `install` prints it twice.
 *
 * A config file two harnesses write the *same* entries into goes the same way, and for the same
 * reason: Claude and VS Code read one `.claude/settings.json`, so a project configuring both writes it
 * once. Anything else about a config artifact differing — a different section, a different rendering
 * of the same hook — makes it a second write rather than a duplicate, because dropping it would
 * quietly install less than the project asked for.
 *
 * @param adapters the harnesses to plan for, in the order they were configured — which is the order
 *   that decides who plans a shared target, and is sorted, so it does not depend on `ambit.yml`'s
 *   spelling.
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
 * Resolves the project and plans every adapter's writes, touching nothing.
 *
 * Everything up to the first write lives here so that `install`, `install --dry-run` and
 * `ambit prune` share one notion of what the project resolves to. Reading state is part of it: it is
 * an input to the run rather than something the run decides, and reading it is not touching the
 * project.
 *
 * @param projectDir the project root, absolute.
 * @param options `--offline` and `--copy`/`--link`, which are the two that change a plan.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, or an unreadable
 *   state file; exit 3 for a resolution error; exit 4 if a fetch fails, or under `--offline` when the
 *   cache cannot answer.
 */
export async function planInstall(
  projectDir: string,
  options: InstallOptions = {},
): Promise<PlannedInstall> {
  const config = await loadProjectConfig(projectDir);
  const harnesses = [...new Set(config.harnesses)].sort(compare);
  const adapters = adaptersFor(harnesses);

  // `process.env` is read once, here, and only for source resolution — where the cache lives, and
  // what a `git:` source authenticates with — so nothing deeper down reaches for ambient state of
  // its own.
  const context: SourceContext = {
    projectDir,
    env: process.env,
    offline: options.offline === true,
  };

  const loaded = await loadCatalogs(config, context);
  const catalogs = mergeCatalogs(loaded);
  const bundle = resolveBundle(config, await mergeConfigEntities(catalogs, config, context));

  // Serialized up front so `--frozen` compares the same bytes the run would go on to write, rather
  // than a second rendering that could differ from it.
  const lock = buildLock(loaded, bundle);
  const project: ProjectPaths = {
    root: projectDir,
    ...(options.mode !== undefined && { mode: options.mode }),
  };

  // Every adapter plans before any of them writes: the ownership check has to see every target
  // first, or a project whose second skill collides is left with its first one already installed.
  const plans = planFor(adapters, bundle, project);

  return {
    bundle,
    harnesses,
    plans,
    artifacts: plans.flatMap(({ plan }) => plan),
    // Asked of every configured adapter, not only the ones that planned something: a harness with no
    // hook mechanism plans nothing at all, which is exactly the case worth saying out loud.
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
 * and the two derived files are answered by asking the pure functions that write them whether they
 * would change anything. Nothing here is a prediction ambit makes twice.
 *
 * Ownership is checked, because a refusal is part of what would happen: a dry run of an install that
 * would stop should stop, and say the same thing.
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
  const planned = await planInstall(projectDir, options);
  if (options.frozen === true) await assertLockCurrent(projectDir, planned.lockText);
  await authorizePlan(planned.artifacts, planned.prior, { adopt: options.adopt === true });

  const pruned = planPrune(planned.artifacts, planned.prior);
  // The blocks install would write are derived from the artifacts it wrote, which here are the ones
  // it would write.
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
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, or a target path
 *   or config key ambit does not own and was not told to adopt; exit 4 if a
 *   fetch fails, or under `--offline` when the cache cannot answer; exit 5 under `--frozen` when the
 *   committed lock is not what resolution produces.
 */
export async function installProject(
  projectDir: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const planned = await planInstall(projectDir, options);
  const { bundle, harnesses, plans, prior, lock, lockText, skipped } = planned;
  if (options.frozen === true) await assertLockCurrent(projectDir, lockText);

  const owner = await authorizePlan(planned.artifacts, prior, { adopt: options.adopt === true });

  const artifacts: AppliedArtifact[] = [];
  for (const { adapter, plan } of plans) {
    artifacts.push(...(await adapter.apply(plan, owner)));
  }

  // Against `prior` rather than `owner`: what `--adopt` just took over is by definition in the plan,
  // so the two agree here, and pruning should be answerable from what the last install recorded.
  const pruned = await pruneArtifacts(projectDir, planned.artifacts, prior);

  await writeLockText(projectDir, lockText);
  await writeState(projectDir, { version: STATE_VERSION, harnesses, artifacts });

  // Last, and deliberately after state: the blocks are derived from what was just written and are
  // rendered afresh every run, so a failure here is the one that costs nothing — the next install
  // rewrites them — whereas failing before `writeState` would leave correctly installed artifacts
  // unowned and the next plain install refusing them.
  await writeGitignoreBlocks(projectDir, artifacts);

  return { bundle, harnesses, artifacts, skipped, pruned, lock };
}

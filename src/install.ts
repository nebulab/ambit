/**
 * Installation (spec §4–§5): resolve a project, then hand the bundle to each harness adapter.
 *
 * The order is load → resolve → plan → apply → write lock → write state, and the two record-keeping
 * writes coming last is a safety property, not an implementation detail: a crash mid-apply leaves
 * artifacts unowned but present, which `doctor` can report, whereas recording ownership first would
 * leave state claiming files that were never written. The lock is written on the same terms — it
 * says what *was* installed, so it must not claim a resolution that failed to materialize.
 *
 * `--frozen` is checked before any of that (spec §6). A CI run whose committed lock is stale has to
 * leave the project exactly as it found it, so the comparison happens while nothing has been touched.
 *
 * Every adapter is asked to plan before any of them applies, so ownership can be checked against the
 * complete set of targets while the project is still untouched (spec §5, `ownership.ts`).
 *
 * Pruning comes after the last adapter and before the two record-keeping writes (spec §5 rule 3), so
 * a prune that fails is retryable — state still owns what it was about to remove — and a failed
 * `apply` leaves the previous install standing rather than half-dismantled.
 *
 * The environment is captured here rather than inside an adapter, because `${VAR}` interpolation in
 * MCP headers (spec §5) is the one thing materialization reads outside its arguments, and an
 * adapter's `plan` has to stay a pure function of what it is given.
 */
import type { AppliedArtifact, HarnessAdapter, ProjectPaths } from "./adapter.js";
import { CLAUDE_HARNESS, claudeAdapter } from "./adapters/claude.js";
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "./catalog.js";
import { loadProjectConfig } from "./config.js";
import { configError } from "./errors.js";
import type { Lock } from "./lock.js";
import { assertLockCurrent, buildLock, serializeLock, writeLockText } from "./lock.js";
import { authorizePlan } from "./ownership.js";
import type { PrunedArtifact } from "./prune.js";
import { pruneArtifacts } from "./prune.js";
import type { Bundle } from "./resolve.js";
import { resolveBundle } from "./resolve.js";
import type { SourceContext } from "./sources.js";
import type { ArtifactMode } from "./state.js";
import { STATE_VERSION, readState, writeState } from "./state.js";

/** Every adapter this build ships, keyed by the name `harnesses` uses. */
export const ADAPTERS: Readonly<Record<string, HarnessAdapter>> = {
  [CLAUDE_HARNESS]: claudeAdapter,
};

/** How an install was asked to behave. */
export interface InstallOptions {
  /** Fail rather than write when resolution would change the lock (spec §6). */
  readonly frozen?: boolean;
  /** Resolve from the catalog cache alone, failing rather than fetching (spec §5). */
  readonly offline?: boolean;
  /** Take ownership of existing unowned targets instead of refusing them (spec §5). */
  readonly adopt?: boolean;
  /**
   * `--copy` / `--link`: materialize every skill this way, whatever its source would have chosen
   * (spec §5). Absent means each skill follows its source, which is the mode to leave alone.
   */
  readonly mode?: ArtifactMode;
}

/** What an install did, for the command to report. */
export interface InstallResult {
  readonly bundle: Bundle;
  /** The harnesses written for, deduplicated and sorted. */
  readonly harnesses: readonly string[];
  /** Everything now owned, in the order the adapters wrote it. */
  readonly artifacts: readonly AppliedArtifact[];
  /** What the previous install owned and this one does not, removed by path (spec §5 rule 3). */
  readonly pruned: readonly PrunedArtifact[];
  /** What was written to `ambit.lock` (spec §3.5). */
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
 * Resolves the project and materializes the bundle.
 *
 * @param projectDir the project root, absolute.
 * @param options `--frozen`, `--offline`, `--adopt`, `--copy`/`--link`, and, later, the rest of
 *   `install`'s flags.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, or a target path
 *   or config key ambit does not own and was not told to adopt; exit 4 if a
 *   fetch fails, or under `--offline` when the cache cannot answer; exit 5 under `--frozen` when the
 *   committed lock is not what resolution produces.
 */
export async function installProject(
  projectDir: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const config = await loadProjectConfig(projectDir);
  const harnesses = [...new Set(config.harnesses)].sort(compare);
  const adapters = adaptersFor(harnesses);

  // `process.env` is read once, here, so every adapter interpolates against the same environment,
  // the cache is looked for in one place (spec §5), and nothing deeper down reaches for ambient
  // state of its own.
  const context: SourceContext = { projectDir, env: process.env, offline: options.offline === true };

  const loaded = await loadCatalogs(config, context);
  const catalogs = mergeCatalogs(loaded);
  const bundle = resolveBundle(config, await mergeConfigEntities(catalogs, config, context));

  // Serialized up front so `--frozen` compares the same bytes the run would go on to write, rather
  // than a second rendering that could differ from it.
  const lock = buildLock(loaded, bundle);
  const lockText = serializeLock(lock);
  if (options.frozen === true) await assertLockCurrent(projectDir, lockText);

  const prior = await readState(projectDir);
  const project: ProjectPaths = {
    root: projectDir,
    env: process.env,
    ...(options.mode !== undefined && { mode: options.mode }),
  };

  // Plan everything first: the ownership check has to see every target before the first write, or a
  // project whose second skill collides is left with its first one already installed.
  const plans = adapters.map((adapter) => ({ adapter, plan: adapter.plan(bundle, project) }));
  const planned = plans.flatMap(({ plan }) => plan);
  const owner = await authorizePlan(planned, prior, { adopt: options.adopt === true });

  const artifacts: AppliedArtifact[] = [];
  for (const { adapter, plan } of plans) {
    artifacts.push(...(await adapter.apply(plan, owner)));
  }

  // Against `prior` rather than `owner`: what `--adopt` just took over is by definition in the plan,
  // so the two agree here, and pruning should be answerable from what the last install recorded.
  const pruned = await pruneArtifacts(projectDir, planned, prior);

  await writeLockText(projectDir, lockText);
  await writeState(projectDir, { version: STATE_VERSION, harnesses, artifacts });

  return { bundle, harnesses, artifacts, pruned, lock };
}

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
 * Pruning (A18) and ownership enforcement (A17) are not here yet, so this build adds and overwrites
 * but never removes.
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
import type { Bundle } from "./resolve.js";
import { resolveBundle } from "./resolve.js";
import type { SourceContext } from "./sources.js";
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
}

/** What an install did, for the command to report. */
export interface InstallResult {
  readonly bundle: Bundle;
  /** The harnesses written for, deduplicated and sorted. */
  readonly harnesses: readonly string[];
  /** Everything now owned, in the order the adapters wrote it. */
  readonly artifacts: readonly AppliedArtifact[];
  /** What was written to `ambit.lock` (spec §3.5). */
  readonly lock: Lock;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolves configured harness names to adapters.
 *
 * @throws {AmbitError} exit 2 for a harness this build has no adapter for — silently skipping it
 *   would leave a project believing it was installed.
 */
function adaptersFor(harnesses: readonly string[]): readonly HarnessAdapter[] {
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
 * @param options `--frozen`, `--offline`, and, later, the rest of `install`'s flags.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, or an unknown harness; exit 4 if a
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
  const project: ProjectPaths = { root: projectDir, env: process.env };

  const artifacts: AppliedArtifact[] = [];
  for (const adapter of adapters) {
    artifacts.push(...(await adapter.apply(adapter.plan(bundle, project), prior)));
  }

  await writeLockText(projectDir, lockText);
  await writeState(projectDir, { version: STATE_VERSION, harnesses, artifacts });

  return { bundle, harnesses, artifacts, lock };
}

/**
 * Installation (spec §4–§5): resolve a project, then hand the bundle to each harness adapter.
 *
 * The order is load → resolve → plan → apply → write state, and the state write coming last is a
 * safety property, not an implementation detail: a crash mid-apply leaves artifacts unowned but
 * present, which `doctor` can report, whereas recording ownership first would leave state
 * claiming files that were never written.
 *
 * The lock (A14), pruning (A18), and ownership enforcement (A17) are not here yet, so this build
 * adds and overwrites but never removes.
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
import type { Bundle } from "./resolve.js";
import { resolveBundle } from "./resolve.js";
import type { SourceContext } from "./sources.js";
import { STATE_VERSION, readState, writeState } from "./state.js";

/** Every adapter this build ships, keyed by the name `harnesses` uses. */
export const ADAPTERS: Readonly<Record<string, HarnessAdapter>> = {
  [CLAUDE_HARNESS]: claudeAdapter,
};

/** What an install did, for the command to report. */
export interface InstallResult {
  readonly bundle: Bundle;
  /** The harnesses written for, deduplicated and sorted. */
  readonly harnesses: readonly string[];
  /** Everything now owned, in the order the adapters wrote it. */
  readonly artifacts: readonly AppliedArtifact[];
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
 * @throws {AmbitError} exit 2 for a malformed config or catalog, or an unknown harness.
 */
export async function installProject(projectDir: string): Promise<InstallResult> {
  const config = await loadProjectConfig(projectDir);
  const harnesses = [...new Set(config.harnesses)].sort(compare);
  const adapters = adaptersFor(harnesses);

  // `process.env` is read once, here, so every adapter interpolates against the same environment,
  // the cache is looked for in one place (spec §5), and nothing deeper down reaches for ambient
  // state of its own.
  const context: SourceContext = { projectDir, env: process.env };

  const catalogs = mergeCatalogs(await loadCatalogs(config, context));
  const bundle = resolveBundle(config, await mergeConfigEntities(catalogs, config, context));
  const prior = await readState(projectDir);
  const project: ProjectPaths = { root: projectDir, env: process.env };

  const artifacts: AppliedArtifact[] = [];
  for (const adapter of adapters) {
    artifacts.push(...(await adapter.apply(adapter.plan(bundle, project), prior)));
  }

  await writeState(projectDir, { version: STATE_VERSION, harnesses, artifacts });

  return { bundle, harnesses, artifacts };
}

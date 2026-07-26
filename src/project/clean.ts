/**
 * `ambit prune` and `ambit clean` — the two commands that only remove.
 *
 * Both are `prune.ts`'s machinery reached without materializing anything, and the only thing that
 * separates them is what they consider worth keeping. `prune` keeps whatever the current bundle
 * selects, so it is the install-time prune with the install left out: someone who narrows
 * `ambit.yml` and wants the withdrawn skills gone now should not have to reinstall the rest to get
 * it. `clean` keeps nothing, which is why it is the same call against an empty plan rather than a
 * second traversal of state — "remove everything ambit owns" is exactly "prune against a bundle that
 * selects nothing".
 *
 * The difference that matters is that `clean` resolves nothing. It answers from `.ambit/state.json`
 * alone, so it still works on a project whose catalog is unreachable, whose config no longer parses,
 * or whose scopes were deleted — which is the state a project is usually in when someone reaches for
 * it. `prune` cannot: "not in the current bundle" is a question only resolution can answer.
 *
 * That asymmetry is also why only `prune` rewrites `ambit.lock`. Having resolved, it knows exactly what
 * install would record — the same `lockText` install writes — and a prune that left the lock describing
 * the wider bundle would leave the project failing `doctor`'s lock check and `install --frozen` on
 * account of the very change it had just carried out. `clean` resolves nothing, so it has no lock to
 * write; it leaves the file alone for the reason below.
 *
 * **What `clean` does not remove**, deliberately: `ambit.lock` and a `.mcp.json` left holding an empty
 * `mcpServers`. Neither is ambit's (teams commit the lock, and the config
 * file is co-owned with only its keys ambit's), and the safety core's first rule is that ambit deletes
 * only what it owns — a `clean` that deleted a tracked file would be a worse surprise than one that
 * leaves two lines behind. The empty `.claude/skills` directory a pruned skill leaves goes the same
 * way: it is the harness's directory, and git does not track an empty one, so removing it would buy
 * nothing and cost the same rule. What `clean` *does* remove beyond the owned artifacts is ambit's own
 * `.ambit/` directory and its `.gitignore` blocks, all of which are ambit's by definition.
 */
import { lstat, rm } from "node:fs/promises";
import path from "node:path";

import {
  GITIGNORE_FILENAME,
  readGitignoreText,
  removeGitignoreBlocks,
  removeGitignoreText,
  SHARED_GITIGNORE_FILE,
  writeGitignoreBlocks,
} from "./gitignore.js";
import { planInstall } from "./install.js";
import { writeLockText } from "./lock.js";
import type { PrunedArtifact } from "./prune.js";
import { planPrune, pruneArtifacts, remainingArtifacts } from "./prune.js";
import type { OwnedArtifact } from "../model/state.js";
import {
  STATE_DIRNAME,
  STATE_VERSION,
  readState,
  stateFilePath,
  writeState,
} from "../model/state.js";

/** How a prune was asked to behave. */
export interface PruneOptions {
  /** Resolve from the catalog cache alone, failing rather than fetching. */
  readonly offline?: boolean;
  /** `--dry-run`: report what would be removed and touch nothing. */
  readonly dryRun?: boolean;
}

/** What a prune removed. */
export interface PruneResult {
  /** What was removed, by path — under `--dry-run`, what would be. */
  readonly pruned: readonly PrunedArtifact[];
  /** What ambit still owns afterwards, which is what state now records. */
  readonly remaining: readonly OwnedArtifact[];
}

/** How a clean was asked to behave. */
export interface CleanOptions {
  /** `--dry-run`: report what would be removed and touch nothing. */
  readonly dryRun?: boolean;
}

/** What a clean removed. */
export interface CleanResult {
  /** Every owned artifact removed, by path — under `--dry-run`, what would be. */
  readonly removed: readonly PrunedArtifact[];
  /** Whether `.ambit/` was there to remove. */
  readonly stateRemoved: boolean;
  /** The `.gitignore` files a managed block was there to remove from. */
  readonly gitignoreRemoved: readonly string[];
}

/**
 * Which files a `clean` would take a block out of, for `--dry-run`.
 *
 * Asked of the same reader the real removal uses, so a preview cannot disagree with what follows it —
 * including by refusing, since an ambiguous block throws here exactly as it would there.
 */
async function plannedGitignoreRemovals(projectDir: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const file of [GITIGNORE_FILENAME, SHARED_GITIGNORE_FILE]) {
    if (removeGitignoreText(await readGitignoreText(projectDir, file), file) !== undefined) {
      files.push(file);
    }
  }
  return files;
}

/** Whether anything at all sits at a path. */
async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the owned artifacts the current bundle no longer selects.
 *
 * Ownership is not authorized first, unlike an install: nothing here writes an artifact, and pruning
 * removes only what state already claims, so a project whose next `install` would
 * refuse an unowned target can still be pruned.
 *
 * The writes are ordered as install orders them — filesystem, then the lock, then state, then the
 * `.gitignore` block — so a failure part way through leaves state still claiming what it was about to
 * give up, and the next run prunes the same set again. A run with nothing stale writes nothing at all,
 * which is what keeps `prune` on an untouched project from creating a state file, a lock, or a
 * `.gitignore` for it.
 *
 * @param projectDir the project root, absolute.
 * @param options `--offline` and `--dry-run`.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, an unreadable
 *   state file, a co-owned config file that cannot be parsed, or an ambiguous `.gitignore` block;
 *   exit 3 for a resolution error; exit 4 if a fetch fails, or under `--offline` when the cache cannot
 *   answer.
 */
export async function pruneProject(
  projectDir: string,
  options: PruneOptions = {},
): Promise<PruneResult> {
  const planned = await planInstall(projectDir, {
    ...(options.offline !== undefined && { offline: options.offline }),
  });

  // The planned removals, not the writes that happened: they are what state must stop claiming, even
  // where the file had already lost the key by hand.
  const stale = planPrune(planned.artifacts, planned.prior);
  const remaining = remainingArtifacts(planned.prior, stale);

  if (options.dryRun === true) return { pruned: stale, remaining };
  if (stale.length === 0) return { pruned: [], remaining: planned.prior.artifacts };

  const pruned = await pruneArtifacts(projectDir, planned.artifacts, planned.prior);

  // The bundle install would resolve, which after this prune is also the bundle on disk — so the lock
  // is `planned.lockText` verbatim, the same bytes through the same writer install uses. Writing it
  // here is what keeps `doctor`'s lock check clean after a prune: a prune that removed the artifacts a
  // narrowed `ambit.yml` dropped, but left the lock describing the wider bundle, left the project
  // reporting drift it had just finished resolving.
  await writeLockText(projectDir, planned.lockText);

  await writeState(projectDir, {
    version: STATE_VERSION,
    harnesses: planned.harnesses,
    artifacts: remaining,
  });
  await writeGitignoreBlocks(projectDir, remaining);

  return { pruned, remaining };
}

/**
 * Removes everything ambit owns in a project.
 *
 * The order is artifacts, then the `.gitignore` block, then `.ambit/` — state last, and one step
 * later than install puts it, because here the block is not free to rewrite: an ambiguous one is exit
 * 2, and leaving state in place until after that means the whole command is retryable once the file is
 * fixed. Nothing else reads state afterwards, so removing it last costs nothing.
 *
 * @param projectDir the project root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for an unreadable state file, a co-owned config file that cannot be
 *   parsed, a managed key state records in a form this build cannot act on, or a `.gitignore` whose
 *   markers are ambiguous. No catalog is read and nothing is resolved, so there is no exit 3 or 4.
 */
export async function cleanProject(
  projectDir: string,
  options: CleanOptions = {},
): Promise<CleanResult> {
  const prior = await readState(projectDir);
  const stateDir = path.join(projectDir, STATE_DIRNAME);

  if (options.dryRun === true) {
    return {
      removed: planPrune([], prior),
      stateRemoved: await exists(stateFilePath(projectDir)),
      gitignoreRemoved: await plannedGitignoreRemovals(projectDir),
    };
  }

  const removed = await pruneArtifacts(projectDir, [], prior);
  const gitignoreRemoved = await removeGitignoreBlocks(projectDir);

  const stateRemoved = await exists(stateFilePath(projectDir));
  await rm(stateDir, { recursive: true, force: true });

  return { removed, stateRemoved, gitignoreRemoved };
}

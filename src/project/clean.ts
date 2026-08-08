/**
 * `ambit prune` and `ambit clean` — the two commands that only remove.
 *
 * Both use `prune.ts`'s machinery without materializing anything; what differs is what they keep.
 * `prune` keeps whatever the current bundle selects: it is the install-time prune without the
 * install, so narrowing `ambit.yml` doesn't require reinstalling to drop the withdrawn skills.
 * `clean` keeps nothing, so it is the same call against an empty plan rather than a second traversal
 * of state.
 *
 * `clean` resolves nothing: it answers from `.ambit/state.json` alone, so it still works on a project
 * whose catalog is unreachable, whose config no longer parses, or whose `requires` entries were
 * deleted (the usual state a project is in when someone reaches for it). `prune` cannot skip
 * resolution, because "not in the current bundle" is a question only resolution can answer.
 *
 * Only `prune` rewrites `ambit.lock`, for the same reason: having resolved, it knows what install
 * would record (the same `lockText` install writes), and leaving the lock describing the wider
 * bundle would fail `doctor`'s lock check and `install --frozen` right after the prune that caused
 * it. `clean` has no lock to write and leaves the file alone.
 *
 * `clean` deliberately does not remove `ambit.lock` or a `.mcp.json` left holding an empty
 * `mcpServers`. Neither is ambit's (teams commit the lock; the config file is co-owned, with only its
 * keys ambit's), and ambit deletes only what it owns. The empty `.claude/skills` directory a pruned
 * skill leaves is the same: it belongs to the harness, and git does not track an empty directory
 * anyway. What `clean` does remove beyond the owned artifacts is ambit's own `.ambit/` directory and
 * its `.gitignore` blocks, since both are ambit's by definition.
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
 * Uses the same reader the real removal uses, so a preview cannot disagree with what follows it,
 * including by refusing: an ambiguous block throws here exactly as it would there.
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
 * removes only what state already claims, so a project whose next `install` would refuse an unowned
 * target can still be pruned.
 *
 * Writes are ordered as install orders them: filesystem, then lock, then state, then the `.gitignore`
 * block. A failure part way through leaves state still claiming what it was about to give up, so the
 * next run prunes the same set again. A run with nothing stale writes nothing, so `prune` on an
 * untouched project creates no state file, lock, or `.gitignore`.
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

  // The planned removals, not the writes that happened: what state must stop claiming, even where
  // the file already lost the key by hand.
  const stale = planPrune(planned.artifacts, planned.prior);
  const remaining = remainingArtifacts(planned.prior, stale);

  if (options.dryRun === true) return { pruned: stale, remaining };
  if (stale.length === 0) return { pruned: [], remaining: planned.prior.artifacts };

  const pruned = await pruneArtifacts(projectDir, planned.artifacts, planned.prior);

  // The bundle install would resolve is, after this prune, also the bundle on disk, so the lock is
  // `planned.lockText` verbatim, written the same way install writes it. This keeps `doctor`'s lock
  // check clean afterwards: without it, the lock would still describe the wider bundle and the
  // project would report drift it had just finished resolving.
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
 * Order: artifacts, then the `.gitignore` block, then `.ambit/`. State is removed last, one step
 * later than install puts it, because the `.gitignore` block is not free to rewrite here: an
 * ambiguous one is exit 2, and leaving state in place until after that keeps the whole command
 * retryable once the file is fixed. Nothing else reads state afterwards, so removing it last costs
 * nothing.
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

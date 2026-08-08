/**
 * Pruning — removes what the last install owned and this one does not.
 *
 * Without it, install would be purely additive: narrowing `requires` in `ambit.yml` would change
 * nothing on disk, and the harness would keep loading a skill the project no longer selects.
 *
 * The input is `.ambit/state.json`, never the filesystem. Ambit deletes only what it recorded
 * creating, so a hand-written skill beside ambit's is never touched, and dropping a harness from
 * `harnesses` prunes that adapter's artifacts automatically (they are simply absent from the plan).
 *
 * Granularity follows the artifact kind, same as ownership: a skill directory goes whole; a harness
 * config file loses only ambit's stale keys and stays where it is, because files like `.mcp.json`
 * are co-owned. The directories that held pruned skills stay too — `.claude/skills` and `.claude`
 * belong to the harness.
 *
 * Pruning runs after materialization and before state is rewritten, so a failure here is retryable
 * rather than destructive: state still owns everything, and the next install prunes the same set
 * again. A failed `apply` leaves the previous install intact instead of half-dismantled.
 *
 * Deciding what to remove (`planPrune`) is split from removing it (`pruneArtifacts`) because three
 * commands need the same answer for different reasons: `install` acts on it, `--dry-run` prints it,
 * and `ambit prune` acts on it without materializing anything first. `clean` is the same decision
 * against an empty plan, which is why nothing here has its own notion of "remove everything".
 */
import { lstat, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlannedArtifact } from "../harness/adapter.js";
import { configError } from "../errors.js";
import { driverFor, readDocumentText } from "../model/documents/index.js";
import type { DocumentFormat, DocumentShape } from "../model/documents/index.js";
import type { ArtifactKind, OwnedArtifact, State } from "../model/state.js";
import { STATE_DIRNAME, STATE_FILENAME } from "../model/state.js";

/** The empty key set a config file the plan does not mention stands in with. */
const NO_KEYS: ReadonlySet<string> = new Set<string>();

/** One artifact pruning removed, mirroring the state entry that authorized the removal. */
export interface PrunedArtifact {
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly kind: ArtifactKind;
  /** For `harness-config`: the dotted keys taken out of the file, in the order they were removed. */
  readonly managedKeys?: readonly string[];
  /**
   * For `harness-config`: how the file is written, carried over from the state entry.
   *
   * Pruning acts from state alone, so the format has to travel with the removal rather than be
   * re-derived from a project that may no longer resolve.
   */
  readonly format?: DocumentFormat;
  /**
   * For `harness-config`: how the managed section is laid out, carried over from the state entry.
   *
   * Not implied by `format`: a `.claude/settings.json` and a `.mcp.json` are both JSON, but reading
   * the first with the map driver would look for a `<Event>@<digest>` key among the event names,
   * find none, and prune nothing at all.
   */
  readonly shape?: DocumentShape;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The paths the new plan writes whole; a prior one absent from this set is stale.
 *
 * Every kind owned as a path must be listed, not only the ones that were here first. A kind left
 * out is a path the plan does write that this set would claim it doesn't, so pruning would delete
 * it right after `apply` created it, and the next install would recreate it forever.
 */
function plannedPaths(plan: readonly PlannedArtifact[]): ReadonlySet<string> {
  return new Set(
    plan.filter((artifact) => artifact.kind !== "harness-config").map((artifact) => artifact.path),
  );
}

/**
 * The managed keys the new plan writes, by config file.
 *
 * A file the plan does not mention at all maps to nothing rather than being missing from the map,
 * so the caller has one code path: a bundle that selects no servers plans no `.mcp.json` artifact,
 * and every key prior state claims there is therefore stale.
 */
function plannedKeys(plan: readonly PlannedArtifact[]): ReadonlyMap<string, ReadonlySet<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const artifact of plan) {
    if (artifact.kind !== "harness-config") continue;
    const keys = byFile.get(artifact.path) ?? new Set<string>();
    for (const key of artifact.managedKeys) keys.add(key);
    byFile.set(artifact.path, keys);
  }
  return byFile;
}

/**
 * Splits a state entry's dotted key back into the section and the key within it.
 *
 * Split at the first dot: a section is a name ambit chose and never contains one, whereas the key
 * is an entity name that can — `mcpServers.acme.internal` is one server called `acme.internal`, not
 * a nested object.
 *
 * @throws {AmbitError} exit 2 for a key naming no section, which this build cannot have written.
 */
function splitManagedKey(key: string, file: string): readonly [section: string, name: string] {
  const dot = key.indexOf(".");
  if (dot <= 0 || dot === key.length - 1) {
    throw configError(`cannot prune "${key}" from ${file}`, [
      `${STATE_DIRNAME}/${STATE_FILENAME} records it as a managed key, but it names no section`,
      `correct that entry, or delete ${STATE_DIRNAME}/${STATE_FILENAME} and run \`ambit install --adopt\``,
    ]);
  }
  return [key.slice(0, dot), key.slice(dot + 1)];
}

/**
 * What pruning a plan against prior state would remove, without touching disk.
 *
 * Answerable from state and the plan alone, which is what lets `--dry-run` and `ambit prune` report
 * the same set install would act on.
 *
 * Managed keys are validated here, before anything is deleted, so a state entry this build could
 * not have written is exit 2 with the project untouched, rather than failing after the first skill
 * directory is already gone.
 *
 * @param plan every artifact the run writes; empty means "keep nothing", which is `clean`.
 * @param prior the state from the last install — the only thing that authorizes a removal.
 * @returns the removals, ordered by path and then by key, so two identical runs read identically.
 * @throws {AmbitError} exit 2 for a managed key that names no section.
 */
export function planPrune(
  plan: readonly PlannedArtifact[],
  prior: State,
): readonly PrunedArtifact[] {
  const keptPaths = plannedPaths(plan);
  const keptKeys = plannedKeys(plan);
  const stale: PrunedArtifact[] = [];

  // Sorted by path so the order removals happen in — and are reported in — is a function of the
  // artifacts and not of however state came off disk.
  for (const artifact of [...prior.artifacts].sort((a, b) => compare(a.path, b.path))) {
    if (artifact.kind === "harness-config") {
      const kept = keptKeys.get(artifact.path) ?? NO_KEYS;
      const keys = [...(artifact.managedKeys ?? [])].sort(compare).filter((key) => !kept.has(key));
      if (keys.length === 0) continue;
      for (const key of keys) splitManagedKey(key, artifact.path);
      stale.push({
        path: artifact.path,
        kind: artifact.kind,
        managedKeys: keys,
        ...(artifact.format !== undefined && { format: artifact.format }),
        ...(artifact.shape !== undefined && { shape: artifact.shape }),
      });
      continue;
    }

    if (keptPaths.has(artifact.path)) continue;
    stale.push({ path: artifact.path, kind: artifact.kind });
  }

  return stale;
}

/**
 * What state records once `pruned` is gone — the entries that survive, in their prior order.
 *
 * Install has no need for this: it writes the artifacts it just applied. A standalone `prune` has
 * to subtract instead, and it subtracts the planned removals rather than the writes that happened,
 * so a key state claimed in a file someone had already emptied by hand stops being claimed too.
 */
export function remainingArtifacts(
  prior: State,
  pruned: readonly PrunedArtifact[],
): readonly OwnedArtifact[] {
  const removed = new Map(pruned.map((artifact) => [artifact.path, artifact]));
  const kept: OwnedArtifact[] = [];

  for (const artifact of prior.artifacts) {
    const gone = removed.get(artifact.path);
    if (gone === undefined) {
      kept.push(artifact);
      continue;
    }
    if (artifact.kind !== "harness-config") continue;

    const keys = (artifact.managedKeys ?? []).filter(
      (key) => !(gone.managedKeys ?? []).includes(key),
    );
    if (keys.length > 0) kept.push({ ...artifact, managedKeys: keys });
  }

  return kept;
}

/**
 * Takes `stale` out of one co-owned config file.
 *
 * The document is re-read here rather than carried over from planning, because `apply` has already
 * merged this run's own keys into it, and writing a pre-`apply` snapshot back would undo them.
 *
 * A key already gone — the file deleted by hand, the server removed by hand — is not an error and
 * not a write: an install that prunes nothing must leave the file byte-identical, and recreating a
 * file someone deleted would be worse than leaving it absent.
 *
 * @param format how the file is written, as prior state recorded it. Pruning runs from state alone,
 *   so the format must come from there rather than from re-resolving the project.
 * @param shape how the managed section is laid out, from state for the same reason. Absent reads as
 *   `map`, which is what every artifact written before the field existed was.
 * @throws {AmbitError} exit 2 if the file exists but cannot be parsed, or for a managed key that
 *   names no section.
 */
async function pruneConfigKeys(
  projectDir: string,
  file: string,
  stale: readonly string[],
  format: DocumentFormat,
  shape: DocumentShape | undefined,
): Promise<PrunedArtifact | undefined> {
  const target = path.join(projectDir, file);
  const driver = driverFor(format, shape);
  let text = await readDocumentText(target, file);
  const removed: string[] = [];

  for (const key of stale) {
    const [section, name] = splitManagedKey(key, file);
    const next = driver.removeKeys(text, section, [name], file);
    if (next === undefined) continue;
    text = next;
    removed.push(key);
  }

  if (removed.length === 0 || text === undefined) return undefined;
  await writeFile(target, text, "utf8");
  return { path: file, kind: "harness-config", managedKeys: removed };
}

/**
 * Whether a stale path still names the thing ambit recorded creating.
 *
 * Exists for the migration to the shared skills directory. An install from before it owned
 * `.claude/skills/<name>` directories; afterwards `.claude/skills` is a symlink to
 * `.agents/skills`, so those old paths resolve straight through it into the shared directory —
 * where the skills this run just installed now live. Deleting them would delete the new install.
 *
 * A symlinked ancestor means the directory ambit owned no longer exists as a directory, so there is
 * nothing at that path left to remove: whatever is reachable through it now belongs to whatever the
 * link points at. It is still reported as pruned, because state should stop claiming it either way.
 *
 * Only ancestors are inspected. The artifact itself is often a symlink — one of the two
 * materialization modes — and `rm` unlinks it without following it.
 */
async function ownedPathIntact(projectDir: string, relative: string): Promise<boolean> {
  let current = projectDir;
  for (const segment of relative.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch {
      // An ancestor that is not there at all means the artifact is not either, and `rm --force` on
      // it would be a no-op, so there is no reason to treat it as the link case.
      return true;
    }
  }
  return true;
}

/**
 * Removes every owned artifact the new plan no longer writes.
 *
 * Call it once with every adapter's plan flattened together: an artifact one adapter now writes may
 * be one prior state recorded under another, and pruning per adapter would delete it and then
 * rewrite it.
 *
 * @param projectDir the project root, absolute.
 * @param plan every artifact this run writes.
 * @param prior the state from the last install — the only thing that authorizes a deletion.
 * @returns what was actually removed, ordered by path and then by key. It is a subset of
 *   `planPrune`'s answer: a key already absent from its file is a removal with nothing left to do.
 * @throws {AmbitError} exit 2 for a co-owned config file that cannot be parsed, or a managed key
 *   state records in a form this build cannot act on. Nothing has been deleted in either case;
 *   state is still intact, so the next install prunes the same set again.
 */
export async function pruneArtifacts(
  projectDir: string,
  plan: readonly PlannedArtifact[],
  prior: State,
): Promise<readonly PrunedArtifact[]> {
  const pruned: PrunedArtifact[] = [];

  for (const artifact of planPrune(plan, prior)) {
    if (artifact.kind === "harness-config") {
      const removed = await pruneConfigKeys(
        projectDir,
        artifact.path,
        artifact.managedKeys ?? [],
        artifact.format ?? "json",
        artifact.shape,
      );
      if (removed !== undefined) pruned.push(removed);
      continue;
    }

    // `force` because an artifact someone already deleted is a prune that has nothing left to do,
    // not a failure; `recursive` removes the directory, and unlinks a symlink without following it.
    if (await ownedPathIntact(projectDir, artifact.path)) {
      await rm(path.join(projectDir, artifact.path), { recursive: true, force: true });
    }
    pruned.push(artifact);
  }

  return pruned;
}

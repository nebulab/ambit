/**
 * Pruning — removing what the last install owned and this one does not.
 *
 * Without it install is purely additive, so dropping a scope from `ambit.yml` changes nothing on
 * disk and the harness keeps loading a skill the project no longer holds. That is not a tidiness
 * problem: an agent acting on withdrawn instructions is the failure the scope list exists to
 * prevent.
 *
 * The input is `.ambit/state.json`, never the filesystem. Nothing here walks `.claude/skills`
 * looking for strangers to clean up — ambit deletes only what it recorded creating (rule 1), so a
 * hand-written skill beside ambit's is invisible to this module by construction rather than by a
 * check that could be forgotten. It also means dropping a harness from `harnesses` prunes that
 * adapter's artifacts for free: they are simply absent from the plan.
 *
 * Granularity follows the artifact kind, exactly as ownership does. A skill directory goes whole; a
 * harness config file loses only ambit's stale keys and stays where it is, because `.mcp.json` is
 * co-owned and emptying it out is not the same as it being ambit's to delete. The
 * directories that held pruned skills stay too — `.claude/skills` and `.claude` belong to the
 * harness.
 *
 * Pruning runs after materialization and before state is rewritten, which makes a failure here
 * retryable rather than destructive: state still owns everything, so the next install prunes the
 * same set again. Ordering it last also means a failed `apply` leaves the previous install intact
 * instead of half-dismantled.
 *
 * Deciding what to remove is split from removing it (`planPrune` and `pruneArtifacts`), because three
 * commands need the same answer for different reasons: `install` acts on it, `--dry-run` prints it,
 * and `ambit prune` acts on it without materializing anything first. One decision function
 * is what keeps the three from disagreeing about what is stale — and `clean` is the same decision
 * against an empty plan, which is why nothing here has a notion of "remove everything" of its own.
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlannedArtifact } from "../harness/adapter.js";
import { configError } from "../errors.js";
import { readJsonDocument, removeConfigKeys, serializeJsonDocument } from "../harness/config.js";
import type { ArtifactKind, OwnedArtifact, State } from "../model/state.js";
import { STATE_DIRNAME, STATE_FILENAME } from "../model/state.js";

/** The empty key set a config file the plan does not mention stands in with. */
const NO_KEYS: ReadonlySet<string> = new Set<string>();

/** One thing pruning removed — the mirror of the state entry that authorized removing it. */
export interface PrunedArtifact {
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly kind: ArtifactKind;
  /** For `harness-config`: the dotted keys taken out of the file, in the order they were removed. */
  readonly managedKeys?: readonly string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The skill-directory paths the new plan writes; a prior one absent from this set is stale. */
function plannedPaths(plan: readonly PlannedArtifact[]): ReadonlySet<string> {
  return new Set(
    plan.filter((artifact) => artifact.kind === "skill-dir").map((artifact) => artifact.path),
  );
}

/**
 * The managed keys the new plan writes, by config file.
 *
 * A file the plan does not mention at all maps to nothing rather than being missing from the map,
 * so the caller has one code path: a bundle that selects no servers plans no `.mcp.json` artifact
 * (see the Claude adapter), and every key prior state claims there is therefore stale.
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
 * Split at the *first* dot: a section is a name ambit chose and never contains one, whereas the key
 * is an entity name that can — `mcpServers.acme.internal` is one server called `acme.internal`, not
 * a nested object.
 *
 * @throws {AmbitError} exit 2 for a key naming no section, which this build cannot have written.
 *   The alternative is silently leaving an artifact ambit claims to own on disk forever.
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
 * The whole question is answerable from state and the plan (rule 1), which is what lets `--dry-run`
 * and `ambit prune` report the same set install would act on rather than a second opinion about it.
 *
 * Managed keys are validated here, before anything is deleted, so a state entry this build could not
 * have written is exit 2 with the project untouched instead of after the first skill directory is
 * already gone.
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
      stale.push({ path: artifact.path, kind: artifact.kind, managedKeys: keys });
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
 * Install has no need for this: it writes the artifacts it just applied. A standalone `prune` has to
 * subtract instead, and it subtracts the *planned* removals rather than the writes that happened, so
 * a key state claimed in a file someone had already emptied by hand stops being claimed too.
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
 * merged this run's own keys into it and writing a pre-`apply` snapshot back would undo them.
 *
 * A key already gone — the file deleted by hand, the server removed by hand — is not an error and
 * not a write: an install that prunes nothing must leave the file byte-identical (the idempotence claim), and recreating a file someone deleted would be worse than leaving it absent.
 *
 * @throws {AmbitError} exit 2 if the file exists but cannot be parsed (`readJsonDocument`), or for a
 *   managed key that names no section.
 */
async function pruneConfigKeys(
  projectDir: string,
  file: string,
  stale: readonly string[],
): Promise<PrunedArtifact | undefined> {
  const target = path.join(projectDir, file);
  let document = await readJsonDocument(target, file);
  const removed: string[] = [];

  for (const key of stale) {
    const [section, name] = splitManagedKey(key, file);
    const next = removeConfigKeys(document, section, [name]);
    if (next === undefined) continue;
    document = next;
    removed.push(key);
  }

  if (removed.length === 0) return undefined;
  await writeFile(target, serializeJsonDocument(document), "utf8");
  return { path: file, kind: "harness-config", managedKeys: removed };
}

/**
 * Removes every owned artifact the new plan no longer writes.
 *
 * Call it once with every adapter's plan flattened together, for the same reason `authorizePlan`
 * takes the whole plan: an artifact one adapter now writes may be one prior state recorded under
 * another, and pruning per adapter would delete it and then rewrite it.
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
      const removed = await pruneConfigKeys(projectDir, artifact.path, artifact.managedKeys ?? []);
      if (removed !== undefined) pruned.push(removed);
      continue;
    }

    // `force` because an artifact someone already deleted is a prune that has nothing left to do,
    // not a failure; `recursive` removes the directory, and unlinks a symlink without following it.
    await rm(path.join(projectDir, artifact.path), { recursive: true, force: true });
    pruned.push(artifact);
  }

  return pruned;
}

/**
 * Ownership enforcement — the safety core (spec §5).
 *
 * ambit overwrites only what `.ambit/state.json` says it created. Anything else at a target path
 * belongs to someone: a hand-written skill, a server added to `.mcp.json` long before ambit ran, a
 * directory another tool maintains. Refusing those is not politeness — being safe to point at a
 * project that already has content is the entire reason a state file exists.
 *
 * The check runs over the **whole** plan before any adapter writes anything, so a refusal leaves the
 * project exactly as it was rather than half-installed. `--adopt` is the explicit override, and it is
 * expressed by handing `apply` a state that already owns the adopted target: the target is then
 * replaced the way an owned one is, instead of being copied on top of and left carrying files the
 * catalog no longer ships.
 *
 * Granularity follows the artifact. A skill directory is owned as a path; a harness config file is
 * co-owned and only ambit's keys inside it are ambit's (spec §3.6), so a `.mcp.json` full of
 * hand-added servers is a normal input and only a *colliding* server name is a conflict.
 */
import { lstat } from "node:fs/promises";

import type { PlannedArtifact, PlannedHarnessConfig, PlannedSkillDir } from "./adapter.js";
import { configError } from "./errors.js";
import { managedKey, readJsonDocument, sectionKeys } from "./harness-config.js";
import type { OwnedArtifact, State } from "./state.js";
import { ownedPaths } from "./state.js";

/** How an install was told to treat a target ambit does not own. */
export interface OwnershipOptions {
  /** `--adopt`: take ownership of what is already there instead of refusing it (spec §6). */
  readonly adopt?: boolean;
}

/** Whether a filesystem error means the path simply is not there. */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Whether anything at all sits at `target`.
 *
 * `lstat`, not `stat`: a symlink — even a dangling one — is something ambit did not create and must
 * not silently replace, and a symlink is a shape ambit installs in its own right (spec §5).
 *
 * @throws {AmbitError} exit 2 when the path cannot be inspected. "I could not look" is not the same
 *   answer as "nothing is there", and guessing the second would be guessing in the one direction
 *   that destroys data.
 */
async function exists(target: string, file: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw configError(`cannot inspect ${file}`, [
      error instanceof Error ? error.message : String(error),
      `make ${target} readable, so ambit can tell whether it would overwrite something`,
    ]);
  }
}

/** @throws {AmbitError} exit 2, in spec §6's wording for this case. */
function refusePath(artifact: PlannedSkillDir): never {
  throw configError("refusing to overwrite unowned path", [
    `${artifact.path} exists but ambit did not create it`,
    "move it aside, or run `ambit install --adopt` to take ownership",
  ]);
}

/** @throws {AmbitError} exit 2. Says "remove", not "move aside": the file itself stays put. */
function refuseKey(artifact: PlannedHarnessConfig, key: string): never {
  throw configError("refusing to overwrite unowned key", [
    `"${key}" in ${artifact.path} exists but ambit did not create it`,
    `remove it from ${artifact.path}, or run \`ambit install --adopt\` to take ownership`,
  ]);
}

/**
 * The dotted keys prior state records as ambit's within one config file.
 *
 * Unioned across every artifact naming that path, so ownership survives two adapters writing into
 * one file — the path alone never grants it, because the file is co-owned.
 */
export function ownedKeys(prior: State, file: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const artifact of prior.artifacts) {
    if (artifact.path !== file) continue;
    for (const key of artifact.managedKeys ?? []) keys.add(key);
  }
  return keys;
}

/**
 * Checks one config file's planned keys against what is already in it.
 *
 * Adoption needs no bookkeeping here: `apply` writes managed keys unconditionally, precisely
 * because the file is co-owned, so allowing the collision is the whole of taking it over.
 *
 * @throws {AmbitError} exit 2 for a colliding key ambit does not own, or for a document that cannot
 *   be read at all (`readJsonDocument`). A section holding something other than an object is left to
 *   `mergeConfigSection` to report, which is the code that cannot proceed with it.
 */
async function checkConfigKeys(
  artifact: PlannedHarnessConfig,
  prior: State,
  options: OwnershipOptions,
): Promise<void> {
  const present = sectionKeys(await readJsonDocument(artifact.target, artifact.path), artifact.section);
  if (present.size === 0 || options.adopt === true) return;

  const owned = ownedKeys(prior, artifact.path);
  // Driven by the plan's entries, which arrive sorted, so which collision is reported first is a
  // function of the bundle and not of the order keys happen to sit in the file.
  for (const entry of artifact.entries) {
    const key = managedKey(artifact.section, entry.key);
    if (present.has(entry.key) && !owned.has(key)) refuseKey(artifact, key);
  }
}

/**
 * Checks a whole plan against prior ownership, and returns the ownership `apply` may act with.
 *
 * Call this once, with every adapter's plan, before any adapter runs (spec §5 rule 2): the point is
 * that a project with one conflict is left untouched rather than partly written.
 *
 * @param plan every artifact the run intends to write.
 * @param prior the state from the last install — what ambit already owns.
 * @param options `--adopt`.
 * @returns `prior`, plus an owned entry for every target `--adopt` just took over, so `apply`
 *   replaces an adopted directory instead of copying into it and leaving strangers' files behind.
 * @throws {AmbitError} exit 2 naming the path or key it will not overwrite, and `--adopt` as the way
 *   to say otherwise.
 */
export async function authorizePlan(
  plan: readonly PlannedArtifact[],
  prior: State,
  options: OwnershipOptions = {},
): Promise<State> {
  const owned = ownedPaths(prior);
  const adopted: OwnedArtifact[] = [];

  for (const artifact of plan) {
    if (artifact.kind === "harness-config") {
      await checkConfigKeys(artifact, prior, options);
      continue;
    }
    if (owned.has(artifact.path)) continue;
    if (!(await exists(artifact.target, artifact.path))) continue;
    if (options.adopt !== true) refusePath(artifact);
    adopted.push({ path: artifact.path, kind: artifact.kind, mode: artifact.mode });
  }

  if (adopted.length === 0) return prior;
  return { ...prior, artifacts: [...prior.artifacts, ...adopted] };
}

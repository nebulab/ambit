/**
 * Ownership enforcement — the safety core.
 *
 * ambit overwrites only what `.ambit/state.json` says it created. Anything else at a target path
 * belongs to someone else: a hand-written skill, a server added to `.mcp.json` before ambit ran, a
 * directory another tool maintains. This lets ambit be pointed at a project that already has content.
 *
 * The check runs over the whole plan before any adapter writes anything, so a refusal leaves the
 * project exactly as it was rather than half-installed. `--adopt` is expressed by handing `apply` a
 * state that already owns the adopted target, so the target is replaced the way an owned one is,
 * instead of copied on top of and left carrying files the catalog no longer ships.
 *
 * Granularity follows the artifact. A skill directory is owned as a path. A harness config file is
 * co-owned: only ambit's keys inside it are ambit's, so a `.mcp.json` full of hand-added servers is a
 * normal input, and only a colliding server name is a conflict.
 */
import { lstat, stat } from "node:fs/promises";
import path from "node:path";

import type {
  PlannedArtifact,
  PlannedHarnessConfig,
  PlannedPathArtifact,
} from "../harness/adapter.js";
import { configError } from "../errors.js";
import { driverFor, managedKey, readDocumentText } from "../model/documents/index.js";
import { holdsOnlyOwned, SHARED_SKILLS_DIR } from "../harness/profile.js";
import type { OwnedArtifact, State } from "../model/state.js";
import { ownedPaths } from "../model/state.js";

/** How an install was told to treat a target ambit does not own. */
export interface OwnershipOptions {
  /** `--adopt`: take ownership of what is already there instead of refusing it. */
  readonly adopt?: boolean;
}

/** Whether a filesystem error means the path simply is not there. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Whether anything at all sits at `target`.
 *
 * `lstat`, not `stat`: a symlink — even a dangling one — is something ambit did not create and must
 * not silently replace, and a symlink is a shape ambit installs in its own right.
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

/**
 * The first directory an artifact needs that something other than a directory occupies.
 *
 * `mkdir -p` cannot create a path whose ancestor is a dangling symlink (`ENOENT`) or a file
 * (`ENOTDIR`). Both mean something ambit did not create is in the way. Left to surface inside
 * `apply`, they'd show as "unexpected internal error … this is a bug in ambit", so they are caught
 * here, before anything is written, naming the ancestor (which is what has to move) rather than the
 * artifact.
 *
 * @returns the offending ancestor, project-relative, or `undefined` when the path is clear. A missing
 *   ancestor is clear: `mkdir -p` creates it.
 * @throws {AmbitError} exit 2 when an ancestor cannot be inspected at all.
 */
async function blockingAncestor(artifact: PlannedPathArtifact): Promise<string | undefined> {
  const segments = artifact.path.split("/");

  // Ancestors as absolute paths, outermost first, walked up from the target rather than down from a
  // project root: the plan already carries both forms of this location.
  const ancestors: string[] = [];
  let absolute = artifact.target;
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    absolute = path.dirname(absolute);
    ancestors.unshift(absolute);
  }

  for (const [index, directory] of ancestors.entries()) {
    const walked = segments.slice(0, index + 1).join("/");
    absolute = directory;

    try {
      // `stat`, following links: an ancestor that is a symlink to a real directory is a directory as
      // far as writing into it goes.
      if (!(await stat(absolute)).isDirectory()) return walked;
    } catch (error) {
      if (!isMissing(error)) {
        throw configError(`cannot inspect ${walked}`, [
          error instanceof Error ? error.message : String(error),
          `make ${absolute} readable, so ambit can tell whether it can write beneath it`,
        ]);
      }
      // Nothing resolves there: either the path is genuinely absent, or a link points at something
      // that is not there. Only `lstat` can tell those apart.
      try {
        await lstat(absolute);
      } catch {
        continue;
      }
      return walked;
    }
  }

  return undefined;
}

/**
 * @throws {AmbitError} exit 2. Deliberately does not offer `--adopt`: adoption governs what ambit may
 *   overwrite, and no amount of it lets `mkdir` descend through a dangling link.
 */
function refuseAncestor(artifact: PlannedPathArtifact, ancestor: string): never {
  throw configError("refusing to write under an unowned path", [
    `${ancestor} is not a directory ambit can write into, so ${artifact.path} cannot be created`,
    `move ${ancestor} aside, or point it at a directory that exists`,
  ]);
}

/** @throws {AmbitError} exit 2, in the standard wording for this case. */
function refusePath(artifact: PlannedPathArtifact): never {
  const detail =
    artifact.kind === "skills-link"
      ? `${artifact.path} exists but ambit did not create it, so it cannot be pointed at ${SHARED_SKILLS_DIR}`
      : `${artifact.path} exists but ambit did not create it`;
  throw configError("refusing to overwrite unowned path", [
    detail,
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
  const present = driverFor(artifact.format, artifact.shape).sectionKeys(
    await readDocumentText(artifact.target, artifact.path),
    artifact.section,
    artifact.path,
  );
  if (present.size === 0 || options.adopt === true) return;

  const owned = ownedKeys(prior, artifact.path);
  // Driven by the plan's entries, which arrive sorted, so which collision is reported first depends
  // on the bundle, not on the order keys happen to sit in the file.
  for (const entry of artifact.entries) {
    const key = managedKey(artifact.section, entry.key);
    if (present.has(entry.key) && !owned.has(key)) refuseKey(artifact, key);
  }
}

/**
 * Checks a whole plan against prior ownership, and returns the ownership `apply` may act with.
 *
 * Call this once, with every adapter's plan, before any adapter runs: the point is
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

    // Checked before the ownership question, regardless of what state says: an artifact ambit owns is
    // no more writable than a new one when the directory it lives in has been replaced by a dangling
    // link.
    const blocking = await blockingAncestor(artifact);
    if (blocking !== undefined) refuseAncestor(artifact, blocking);

    if (owned.has(artifact.path)) continue;
    if (!(await exists(artifact.target, artifact.path))) continue;

    // The one case adoption is implicit: a skills directory holding nothing but skills ambit itself
    // installed. This is what a pre-shared-layout install leaves behind, and replacing it with a link
    // to the shared directory loses nothing, since ambit wrote everything in it. One hand-written
    // skill in there and this is false, so the refusal below stands.
    const migrating =
      artifact.kind === "skills-link" &&
      (await holdsOnlyOwned(artifact.target, artifact.path, owned));

    if (!migrating && options.adopt !== true) refusePath(artifact);
    adopted.push({ path: artifact.path, kind: artifact.kind, mode: artifact.mode });
  }

  if (adopted.length === 0) return prior;
  return { ...prior, artifacts: [...prior.artifacts, ...adopted] };
}

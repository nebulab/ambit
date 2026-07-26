/**
 * `ambit status` — what is installed, against what resolution now produces (spec §6).
 *
 * Install is idempotent: run it twice on an unchanged project and not a byte moves. This is the
 * command that makes that claim inspectable without testing it destructively. It plans exactly as
 * install does and then compares the plan against the project, so every row answers one question —
 * would `ambit install` change this? — and `--check` turns the answer into exit 5, which is the form
 * a CI job can act on (spec §6).
 *
 * Nothing here writes, and nothing here throws for drift. Drift is the report: a project whose
 * skills were edited by hand is in a state a person needs described, not refused. The errors that do
 * escape are the ones resolution itself raises — a malformed config, an unreachable catalog — because
 * a status that cannot resolve has nothing to compare against.
 *
 * Comparison follows the artifact kind, the same split ownership and pruning make. A copied skill
 * directory is the source's bytes and nothing else, so it is compared as a tree; a symlinked one has
 * no bytes of its own, so the only thing to check is where it points — editing through the link is
 * editing the source, which is what linking is for and never drift. A harness config file is compared
 * key by key: it is co-owned (spec §3.6), so a hand-added server beside ambit's is not drift, and
 * only the keys ambit wrote are ambit's to have an opinion about.
 *
 * Ownership is part of the comparison rather than a separate audit. A target that exists but that
 * state does not claim is exactly what install would refuse (spec §5 rule 2), and reporting it as
 * `unowned` here is what lets someone find that out before the install that stops.
 */
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

import type { PlannedArtifact, PlannedHarnessConfig, PlannedSkillDir, ProjectPaths } from "../harness/adapter.js";
import { loadCatalogs, mergeCatalogs, mergeConfigEntities } from "../model/catalog.js";
import { loadProjectConfig } from "../model/config.js";
import { configError } from "../errors.js";
import type { JsonObject } from "../harness/config.js";
import { managedKey, readJsonDocument, sectionOf } from "../harness/config.js";
import { adaptersFor } from "./install.js";
import { ownedKeys } from "./ownership.js";
import { resolveBundle } from "../resolution/resolve.js";
import type { SourceContext } from "../model/sources.js";
import type { ArtifactKind, State } from "../model/state.js";
import { ownedPaths, readState } from "../model/state.js";

/**
 * What comparing one artifact against the project concluded.
 *
 * - `ok` — install would write exactly what is already there.
 * - `missing` — resolution wants it and nothing is installed.
 * - `modified` — it is installed and owned, but its contents are not what install would write.
 * - `stale` — ambit owns it and resolution no longer selects it, so install would prune it.
 * - `unowned` — something is there that ambit did not create, which install refuses to overwrite.
 */
export const ARTIFACT_STATES = ["missing", "modified", "ok", "stale", "unowned"] as const;

export type ArtifactState = (typeof ARTIFACT_STATES)[number];

/** One artifact's verdict. */
export interface StatusArtifact {
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly state: ArtifactState;
  /** One line naming what differs, empty when `ok`. */
  readonly detail: string;
}

/** What `status` found. */
export interface ProjectStatus {
  /** Every artifact resolution wants plus every one state still owns, sorted by path. */
  readonly artifacts: readonly StatusArtifact[];
}

/** How a status comparison was asked to behave. */
export interface StatusOptions {
  /** Resolve from the catalog cache alone, failing rather than fetching (spec §5). */
  readonly offline?: boolean;
}

/** A verdict before it is attached to a path — what every comparison below returns. */
type Verdict = Pick<StatusArtifact, "state" | "detail">;

const OK: Verdict = { state: "ok", detail: "" };

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Everything `status` would report, which is everything install would change. */
export function statusDrift(status: ProjectStatus): readonly StatusArtifact[] {
  return status.artifacts.filter((artifact) => artifact.state !== "ok");
}

/** Whether install would leave the project exactly as it is — the answer `--check` reports. */
export function isClean(status: ProjectStatus): boolean {
  return statusDrift(status).length === 0;
}

/** Whether a filesystem error means the path simply is not there. */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @throws {AmbitError} exit 2 when a target cannot be inspected. "I could not look" is not a
 *   comparison result: reporting it as drift would send someone editing files over a permission
 *   problem.
 */
function unreadable(file: string, target: string, error: unknown): never {
  throw configError(`cannot inspect ${file}`, [
    error instanceof Error ? error.message : String(error),
    `make ${target} readable, so ambit can tell whether it matches what it would install`,
  ]);
}

/**
 * What sits at a target: nothing, a symlink, a directory, or something else.
 *
 * `lstat`, not `stat`: a symlink is a legitimate install mode of its own (spec §5), so following it
 * here would compare a linked skill as though it were a copy — and would report a dangling link as
 * absent, when it is very much there.
 *
 * @throws {AmbitError} exit 2 when the path cannot be inspected.
 */
async function shapeOf(
  target: string,
  file: string,
): Promise<"absent" | "directory" | "link" | "other"> {
  try {
    const found = await lstat(target);
    if (found.isSymbolicLink()) return "link";
    return found.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (isMissing(error)) return "absent";
    unreadable(file, target, error);
  }
}

/**
 * Every file under `dir`, relative, `/`-separated and sorted.
 *
 * Directories are not listed in their own right: an empty one is not a difference worth a row, and
 * every difference that matters carries a file with it.
 *
 * @param label how the tree is named in errors.
 * @throws {AmbitError} exit 2 when it cannot be listed.
 */
async function fileList(dir: string, label: string): Promise<readonly string[]> {
  const found: string[] = [];

  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const within = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), within);
      else found.push(within);
    }
  };

  try {
    await walk(dir, "");
  } catch (error) {
    unreadable(label, dir, error);
  }
  return found.sort(compare);
}

/**
 * Whether two files hold the same bytes.
 *
 * A file that cannot be read counts as differing rather than as an error: "this is no longer what
 * the catalog ships" is true either way, and it is the answer someone can act on.
 */
async function sameBytes(source: string, target: string): Promise<boolean> {
  try {
    const [expected, actual] = await Promise.all([readFile(source), readFile(target)]);
    return expected.equals(actual);
  } catch {
    return false;
  }
}

/**
 * The first difference between a skill's source and what is installed, or undefined when the two
 * agree.
 *
 * One difference rather than all of them, and the first in sorted order rather than the first found,
 * so two identical projects report identically. A whole diff belongs to a diff tool; what a status
 * row needs is one concrete thing to go and look at.
 *
 * @throws {AmbitError} exit 2 when either tree cannot be listed.
 */
async function firstDifference(artifact: PlannedSkillDir): Promise<string | undefined> {
  const [expected, actual] = await Promise.all([
    fileList(artifact.source, `the source of "${artifact.name}"`),
    fileList(artifact.target, artifact.path),
  ]);
  const installed = new Set(actual);
  const shipped = new Set(expected);

  for (const relative of [...new Set([...expected, ...actual])].sort(compare)) {
    if (!installed.has(relative)) return `${relative} is missing`;
    if (!shipped.has(relative)) return `${relative} is not in its source`;
    if (!(await sameBytes(path.join(artifact.source, relative), path.join(artifact.target, relative)))) {
      return `${relative} differs from its source`;
    }
  }

  return undefined;
}

/**
 * Compares one installed symlink against the source it should name.
 *
 * The link is read rather than followed, and reported as written: a relative link is what `apply`
 * creates and what someone sees in `ls -l`, so it is what a detail line should say — and reporting
 * the resolved absolute path would put a machine-specific string into `status --json`.
 *
 * @throws {AmbitError} exit 2 when the link cannot be read.
 */
async function linkVerdict(artifact: PlannedSkillDir): Promise<Verdict> {
  let written: string;
  try {
    written = await readlink(artifact.target);
  } catch (error) {
    unreadable(artifact.path, artifact.target, error);
  }

  // Resolved against the link's own directory, so a relative link and an absolute one that name the
  // same directory compare equal. Deliberately not `realpath`: this is about where the link points,
  // not about what symlinks anywhere above it resolve to.
  const points = path.resolve(path.dirname(artifact.target), written);
  if (points === artifact.source) return OK;
  return { state: "modified", detail: `it points at ${written}, not at its source` };
}

/**
 * Compares one planned skill directory against the project.
 *
 * Existence, then ownership, then contents: something ambit did not create is `unowned` whatever it
 * holds, because install would refuse it rather than compare it.
 *
 * What is on disk decides *how* the comparison is made, not the plan's `mode`. A link is checked for
 * pointing at its source; a directory is compared byte for byte. So a project installed with `--copy`
 * whose copies are intact reads as clean even though a plain `install` would relink it: the mode is a
 * per-run choice (spec §5), both modes put the same bytes in front of the harness, and the
 * alternative would leave anyone who uses the flag with a `status --check` that can never pass.
 * Reporting mode divergence belongs to `doctor` (A24), which is the command for "this is not how it
 * would be set up today".
 *
 * @throws {AmbitError} exit 2 when the target cannot be inspected.
 */
async function skillVerdict(
  artifact: PlannedSkillDir,
  owned: ReadonlySet<string>,
): Promise<Verdict> {
  const shape = await shapeOf(artifact.target, artifact.path);
  if (shape === "absent") return { state: "missing", detail: "nothing is installed at this path" };
  if (!owned.has(artifact.path)) {
    return { state: "unowned", detail: "it exists but ambit did not create it" };
  }
  if (shape === "link") return linkVerdict(artifact);
  if (shape === "other") return { state: "modified", detail: "it is not a directory" };

  const difference = await firstDifference(artifact);
  return difference === undefined ? OK : { state: "modified", detail: difference };
}

/**
 * Structural JSON equality.
 *
 * Key order is deliberately not a difference: a person may have reformatted `.mcp.json`, and ambit
 * writes a server's keys in one order but owns the server rather than its layout.
 */
function jsonEqual(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    return (
      expected.length === actual.length &&
      expected.every((item, index) => jsonEqual(item, actual[index]))
    );
  }

  if (!isRecord(expected) || !isRecord(actual)) return false;
  const keys = Object.keys(expected);
  return (
    keys.length === Object.keys(actual).length &&
    keys.every((key) => Object.hasOwn(actual, key) && jsonEqual(expected[key], actual[key]))
  );
}

/**
 * Compares the managed keys of one co-owned config file against what is in it.
 *
 * The first problem in plan order decides the row, exactly as ownership enforcement refuses on the
 * first conflict: a file with three drifted servers needs one concrete key to go and look at, and
 * which one is reported must be a function of the bundle rather than of the file's layout. Stale
 * keys come last because they are the only ones that describe the *previous* install.
 *
 * @param stale the keys prior state claims here that the plan no longer writes, sorted.
 * @throws {AmbitError} exit 2 if the file exists but cannot be parsed (`readJsonDocument`).
 */
async function configVerdict(
  artifacts: readonly PlannedHarnessConfig[],
  file: string,
  target: string,
  claimed: ReadonlySet<string>,
  stale: readonly string[],
): Promise<Verdict> {
  const document = await readJsonDocument(target, file);

  for (const artifact of artifacts) {
    const section = sectionOf(document, artifact.section);
    for (const entry of artifact.entries) {
      const key = managedKey(artifact.section, entry.key);
      if (!Object.hasOwn(section, entry.key)) return { state: "missing", detail: `"${key}" is absent` };
      if (!claimed.has(key)) {
        return { state: "unowned", detail: `"${key}" exists but ambit did not create it` };
      }
      if (!jsonEqual(entry.value, section[entry.key])) {
        return { state: "modified", detail: `"${key}" is not what install would write` };
      }
    }
  }

  const [first] = stale;
  if (first !== undefined) return { state: "stale", detail: `"${first}" is no longer selected` };
  return OK;
}

/** The plan indexed by path, so a file two adapters write into is compared once. */
function plannedByPath(plan: readonly PlannedArtifact[]): ReadonlyMap<string, readonly PlannedArtifact[]> {
  const byPath = new Map<string, PlannedArtifact[]>();
  for (const artifact of plan) {
    const group = byPath.get(artifact.path) ?? [];
    group.push(artifact);
    byPath.set(artifact.path, group);
  }
  return byPath;
}

/** Every managed key the plan writes into one config file, across every artifact naming it. */
function plannedKeys(artifacts: readonly PlannedHarnessConfig[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const artifact of artifacts) {
    for (const key of artifact.managedKeys) keys.add(key);
  }
  return keys;
}

/**
 * Compares a plan and the previous install's state against what is on disk.
 *
 * Sorted by path so two identical projects report identically, and so a reader can find a row: the
 * order the adapters planned in is an implementation detail, whereas a path is what they came to
 * look up.
 *
 * Needs no project root of its own: a planned artifact carries its absolute target (spec §5), and a
 * stale one is only reported here rather than removed.
 *
 * @throws {AmbitError} exit 2 for a target that cannot be inspected or a config file that cannot be
 *   parsed. Neither is drift — both mean the comparison could not be made.
 */
async function compareArtifacts(
  plan: readonly PlannedArtifact[],
  prior: State,
): Promise<readonly StatusArtifact[]> {
  const owned = ownedPaths(prior);
  const groups = plannedByPath(plan);
  const rows: StatusArtifact[] = [];

  for (const [file, group] of groups) {
    const [first] = group;
    // A group is built from the plan, so it always has a member and every member shares a kind: two
    // artifacts of different kinds at one path would be an adapter bug, not a project's problem.
    if (first === undefined) continue;

    if (first.kind === "skill-dir") {
      rows.push({ path: file, kind: first.kind, ...(await skillVerdict(first, owned)) });
      continue;
    }

    const configs = group.filter(
      (artifact): artifact is PlannedHarnessConfig => artifact.kind === "harness-config",
    );
    const claimed = ownedKeys(prior, file);
    const kept = plannedKeys(configs);
    const stale = [...claimed].sort(compare).filter((key) => !kept.has(key));
    rows.push({
      path: file,
      kind: first.kind,
      ...(await configVerdict(configs, file, first.target, claimed, stale)),
    });
  }

  // What state still claims and the plan no longer writes: install would prune it (spec §5 rule 3).
  // One row per path, since two adapters writing into one config file record one entry each.
  const reported = new Set<string>();
  for (const artifact of prior.artifacts) {
    if (groups.has(artifact.path) || reported.has(artifact.path)) continue;
    reported.add(artifact.path);
    rows.push({
      path: artifact.path,
      kind: artifact.kind,
      state: "stale",
      detail: "ambit owns it, and nothing selects it now",
    });
  }

  return rows.sort((a, b) => compare(a.path, b.path));
}

/**
 * Compares an already-planned install against the project — the comparison without the resolution.
 *
 * Exported for `doctor` (spec §6), which needs both this verdict and the rest of `planInstall`'s
 * output and must not resolve the project twice to get them. Taking the plan as an argument is what
 * keeps the two commands from being able to disagree: there is one comparison, and `status` is it.
 *
 * @param plan every adapter's planned artifacts, flattened.
 * @param prior what the last install recorded owning.
 * @throws {AmbitError} exit 2 for a target that cannot be inspected or a config file that cannot be
 *   parsed.
 */
export async function statusOfPlan(
  plan: readonly PlannedArtifact[],
  prior: State,
): Promise<ProjectStatus> {
  return { artifacts: await compareArtifacts(plan, prior) };
}

/**
 * Compares a project against what resolution now produces.
 *
 * Plans through the adapters rather than reasoning about state alone, because the question is what
 * install *would* do: an adapter's plan is pure (spec §5), so asking it costs nothing and the two
 * commands cannot disagree about where an artifact belongs.
 *
 * @param projectDir the project root, absolute.
 * @param options `--offline`.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, an unreadable
 *   state file, or a target that cannot be inspected; exit 3 for a resolution error; exit 4 if a
 *   fetch fails, or under `--offline` when the cache cannot answer. Drift itself is never an error.
 */
export async function projectStatus(
  projectDir: string,
  options: StatusOptions = {},
): Promise<ProjectStatus> {
  const config = await loadProjectConfig(projectDir);
  const adapters = adaptersFor([...new Set(config.harnesses)].sort(compare));

  const context: SourceContext = { projectDir, env: process.env, offline: options.offline === true };
  const loaded = await loadCatalogs(config, context);
  const catalogs = mergeCatalogs(loaded);
  const bundle = resolveBundle(config, await mergeConfigEntities(catalogs, config, context));

  // The same environment install interpolates `${VAR}` from (spec §5), or every header would read as
  // drift on a machine whose variables are set.
  const project: ProjectPaths = { root: projectDir, env: process.env };
  const plan = adapters.flatMap((adapter) => adapter.plan(bundle, project));

  return statusOfPlan(plan, await readState(projectDir));
}

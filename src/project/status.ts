/**
 * `ambit status` — what is installed, against what resolution now produces.
 *
 * Install is idempotent: running it twice on an unchanged project moves no bytes. This command
 * checks that without touching anything: it plans exactly as install does, then compares the plan
 * against the project, so every row answers "would `ambit install` change this?" `--check` turns the
 * answer into exit 5 for CI.
 *
 * Nothing here writes, and nothing throws for drift; a project edited by hand is a state to describe,
 * not refuse. The errors that do escape are the ones resolution itself raises (a malformed config, an
 * unreachable catalog), since status cannot compare against a project it cannot resolve.
 *
 * Comparison follows the artifact kind, matching the split ownership and pruning make: a copied skill
 * directory is compared as a tree of bytes; a symlink has none of its own, so only where it points is
 * checked (editing through the link edits the source, and is never drift); a harness config file is
 * co-owned, so it is compared key by key and only the keys ambit wrote are ambit's to judge.
 *
 * Ownership is part of the comparison, not a separate audit: a target that exists but that state does
 * not claim is exactly what install would refuse, reported here as `unowned`.
 */
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import type {
  PlannedArtifact,
  PlannedCatalogDir,
  PlannedHarnessConfig,
  PlannedPathArtifact,
  PlannedSkillsLink,
  ProjectPaths,
} from "../harness/adapter.js";
import { loadCatalogs, mergeCatalogs } from "../model/catalog.js";
import { loadProjectConfig } from "../model/config.js";
import { configError } from "../errors.js";
import { driverFor, managedKey, readDocumentText } from "../model/documents/index.js";
import { SHARED_SKILLS_DIR } from "../harness/profile.js";
import { adaptersFor, installScope, planFor } from "./install.js";
import { fileList } from "./file-tree.js";
import { isCatalogDir } from "../harness/adapter.js";
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
  /** Resolve from the catalog cache alone, failing rather than fetching. */
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
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * @throws {AmbitError} exit 2 when a target cannot be inspected. "I could not look" is not a
 *   comparison result, and reporting it as drift would send someone editing files over a permission
 *   problem instead.
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
 * Uses `lstat`, not `stat`: a symlink is a legitimate install mode of its own. Following it would
 * compare a linked skill as though it were a copy, and would report a dangling link as absent when
 * it is actually there.
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
 * Every file under `dir`, as {@link fileList} lists them, with an unreadable tree reported as the
 * refusal every other inspection here uses.
 *
 * @param label how the tree is named in errors.
 * @throws {AmbitError} exit 2 when it cannot be listed.
 */
async function treeFiles(dir: string, label: string): Promise<readonly string[]> {
  try {
    return await fileList(dir);
  } catch (error) {
    unreadable(label, dir, error);
  }
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
 * The first difference between a materialized directory's source and what is installed, or undefined
 * when the two agree.
 *
 * Reports one difference, not all of them, and the first in sorted order rather than the first found,
 * so two identical projects report identically. A status row needs one concrete thing to look at; a
 * full diff belongs to a diff tool.
 *
 * @throws {AmbitError} exit 2 when either tree cannot be listed.
 */
async function firstDifference(artifact: PlannedCatalogDir): Promise<string | undefined> {
  const [expected, actual] = await Promise.all([
    treeFiles(artifact.source, `the source of "${artifact.name}"`),
    treeFiles(artifact.target, artifact.path),
  ]);
  const installed = new Set(actual);
  const shipped = new Set(expected);

  for (const relative of [...new Set([...expected, ...actual])].sort(compare)) {
    if (!installed.has(relative)) return `${relative} is missing`;
    if (!shipped.has(relative)) return `${relative} is not in its source`;
    if (
      !(await sameBytes(path.join(artifact.source, relative), path.join(artifact.target, relative)))
    ) {
      return `${relative} differs from its source`;
    }
  }

  return undefined;
}

/**
 * Compares one installed symlink against the source it should name.
 *
 * The link is read rather than followed, and reported as written: a relative link is what `apply`
 * creates and what someone sees in `ls -l`, so that is what a detail line should say. Reporting the
 * resolved absolute path would put a machine-specific string into `status --json`.
 *
 * @throws {AmbitError} exit 2 when the link cannot be read.
 */
async function linkVerdict(artifact: PlannedPathArtifact): Promise<Verdict> {
  let written: string;
  try {
    written = await readlink(artifact.target);
  } catch (error) {
    unreadable(artifact.path, artifact.target, error);
  }

  // Resolved against the link's own directory, so a relative link and an absolute one naming the
  // same directory compare equal. Deliberately not `realpath`: this checks where the link points,
  // not what symlinks above it resolve to.
  const points = path.resolve(path.dirname(artifact.target), written);
  if (points === artifact.source) return OK;
  return { state: "modified", detail: `it points at ${written}, not at its source` };
}

/**
 * The skills link: present, ambit's, and pointing where the plan says.
 *
 * A directory here is the pre-shared-layout install, which `install` migrates by replacing it, so it
 * reads as modified rather than as something in the way.
 */
async function skillsLinkVerdict(
  artifact: PlannedSkillsLink,
  owned: ReadonlySet<string>,
): Promise<Verdict> {
  const shape = await shapeOf(artifact.target, artifact.path);
  if (shape === "absent") return { state: "missing", detail: "nothing is installed at this path" };
  if (!owned.has(artifact.path)) {
    return { state: "unowned", detail: "it exists but ambit did not create it" };
  }
  if (shape === "link") return linkVerdict(artifact);
  return { state: "modified", detail: `it is not a symlink to ${SHARED_SKILLS_DIR}` };
}

/**
 * Compares one planned directory — a skill's, a hook's shipped script, or a plugin's — against the
 * project.
 *
 * Checks existence, then ownership, then contents: something ambit did not create is `unowned`
 * whatever it holds, since install would refuse it rather than compare it.
 *
 * What is on disk decides how the comparison is made, not the plan's `mode`: a link is checked for
 * pointing at its source, a directory compared byte for byte. Both modes put the same bytes in front
 * of the harness, so a `--copy` install with intact copies reads as clean even though a plain
 * `install` would relink it. Mode divergence is reported by `doctor` (A24) instead.
 *
 * One function handles all three; the {@link PlannedCatalogDir} argument type keeps a hook directory
 * from being handed to {@link configVerdict} and misread as a document.
 *
 * @throws {AmbitError} exit 2 when the target cannot be inspected.
 */
async function catalogDirVerdict(
  artifact: PlannedCatalogDir,
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
 * Compares the managed keys of one co-owned config file against what is in it.
 *
 * The first problem in plan order decides the row, matching how ownership enforcement refuses on the
 * first conflict, so which key is reported depends on the bundle, not the file's layout. Stale keys
 * come last since they describe the previous install, not the current one.
 *
 * Drift is decided by asking the driver to merge one entry and checking whether that changes the
 * file's bytes, not by comparing parsed values: two of the three formats cannot be parsed without
 * losing what a person wrote.
 *
 * In an array section the digest is the key, so an edited hook entry is not a changed value but an
 * absent key, and the row reads `missing`. This matters because install would append ambit's entry
 * beside the edited one, so the row must appear before that run, not as a second hook afterwards. An
 * edited declaration reads the same way, and prunes on the next install.
 *
 * @param stale the keys prior state claims here that the plan no longer writes, sorted.
 * @throws {AmbitError} exit 2 if the file exists but cannot be parsed.
 */
async function configVerdict(
  artifacts: readonly PlannedHarnessConfig[],
  file: string,
  target: string,
  claimed: ReadonlySet<string>,
  stale: readonly string[],
): Promise<Verdict> {
  const text = await readDocumentText(target, file);

  for (const artifact of artifacts) {
    const driver = driverFor(artifact.format, artifact.shape);
    const present = driver.sectionKeys(text, artifact.section, file);
    for (const entry of artifact.entries) {
      const key = managedKey(artifact.section, entry.key);
      if (!present.has(entry.key)) return { state: "missing", detail: `"${key}" is absent` };
      if (!claimed.has(key)) {
        return { state: "unowned", detail: `"${key}" exists but ambit did not create it` };
      }
      if (!driver.entryMatches(text, artifact.section, entry, file)) {
        return { state: "modified", detail: `"${key}" is not what install would write` };
      }
    }
  }

  const [first] = stale;
  if (first !== undefined) return { state: "stale", detail: `"${first}" is no longer selected` };
  return OK;
}

/** The plan indexed by path, so a file two adapters write into is compared once. */
function plannedByPath(
  plan: readonly PlannedArtifact[],
): ReadonlyMap<string, readonly PlannedArtifact[]> {
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
 * Sorted by path so two identical projects report identically and a reader can find a row: the
 * order the adapters planned in is an implementation detail, but a path is what they came to look up.
 *
 * Needs no project root of its own: a planned artifact carries its absolute target, and a stale one
 * is only reported here, not removed.
 *
 * @throws {AmbitError} exit 2 for a target that cannot be inspected or a config file that cannot be
 *   parsed. Neither is drift; both mean the comparison could not be made.
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
    // A group is built from the plan, so it always has a member and every member shares a kind. Two
    // artifacts of different kinds at one path would be an adapter bug, not a project's problem.
    if (first === undefined) continue;

    if (isCatalogDir(first)) {
      rows.push({ path: file, kind: first.kind, ...(await catalogDirVerdict(first, owned)) });
      continue;
    }

    if (first.kind === "skills-link") {
      rows.push({ path: file, kind: first.kind, ...(await skillsLinkVerdict(first, owned)) });
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

  // What state still claims and the plan no longer writes: install would prune it.
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
 * Compares an already-planned install against the project: the comparison without the resolution.
 *
 * Exported for `doctor`, which needs both this verdict and the rest of `planInstall`'s output and
 * must not resolve the project twice to get them. Taking the plan as an argument keeps the two
 * commands from disagreeing: there is one comparison, and `status` is it.
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
 * Plans through the adapters rather than reasoning about state alone, since the question is what
 * install would do: an adapter's plan is pure, so asking it costs nothing and the two commands
 * cannot disagree about where an artifact belongs.
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

  const context: SourceContext = {
    projectDir,
    env: process.env,
    offline: options.offline === true,
  };
  const bundle = resolveBundle(config, mergeCatalogs(await loadCatalogs(config, context)));

  // No environment involved on either side beyond the scope install decided from the same root:
  // install writes a reference rather than a value, so a plan reads the same on every machine and a
  // set variable can never read as drift.
  const project: ProjectPaths = {
    root: projectDir,
    scope: installScope(projectDir, process.env),
  };
  // Through `planFor`, so status sees the artifacts install would write: one entry per shared
  // skills target, not one per harness reading it.
  const plan = planFor(adapters, bundle, project).flatMap(({ plan: planned }) => planned);

  return statusOfPlan(plan, await readState(projectDir));
}

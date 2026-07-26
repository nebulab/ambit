/**
 * `ambit doctor` — env vars, drift, and ownership.
 *
 * The other two read-only commands each answer one question and deliberately stop there. `validate`
 * asks whether the *catalog* is coherent; `status` asks whether install would change an *artifact*.
 * Neither can answer "is this project going to work when someone runs an agent in it", because the
 * things that break that live between the two: a variable a skill needs and nobody exported, a
 * committed lock that no longer describes what resolution produces, artifacts a crashed install left
 * present but unowned. This is the command for those.
 *
 * Findings, not throws — the shape `validate` uses. Every check runs, the whole list is printed, and
 * the exit code carries the verdict (exit 6). A health command that stopped at the first
 * problem would cost one run per problem, and the person running it is usually trying to find out
 * *everything* that is wrong before touching anything.
 *
 * Two severities, and only failures reach exit 6. Spec §5 is explicit that an uninterpolated `${VAR}`
 * must not fail an install, and the same logic makes a materialization mode a warning here: `--copy`
 * and `--link` are per-run choices, both put identical bytes in front of the harness, and
 * failing on one would leave anyone who uses the flag with a `doctor` that can never pass — the
 * objection `status` already answered by ignoring mode entirely. A variable the environment does not
 * have is a failure, though: install cannot refuse it, which is precisely why this command must.
 *
 * One resolution answers everything. `planInstall` produces the bundle, the artifacts, the prior
 * state and the lock bytes, and `statusOfPlan` turns those into the same verdicts `ambit status`
 * prints — so `doctor` and `status` cannot disagree about an artifact, and `doctor` and
 * `install --frozen` cannot disagree about the lock. Nothing here writes.
 */
import { lstat } from "node:fs/promises";

import type { PlannedArtifact, PlannedHarnessConfig, PlannedSkillDir } from "../harness/adapter.js";
import { referencedNames } from "../harness/env.js";
import { gitignoreStatus } from "./gitignore.js";
import type { MergedMcp } from "../model/catalog.js";
import { managedKey } from "../model/documents/index.js";
import { planInstall } from "./install.js";
import { LOCK_FILENAME, readLockText } from "./lock.js";
import type { Bundle } from "../resolution/resolve.js";
import type { ArtifactMode } from "../model/state.js";
import type { StatusArtifact } from "./status.js";
import { statusOfPlan } from "./status.js";

/**
 * The checks, in the order they run and are reported.
 *
 * A declared order rather than an alphabetical one, because it is an argument: the environment
 * around the project first, then the record of the last install, then what that record and the
 * project disagree about, and last the one thing that is merely unusual. A fixed order is all
 * determinism needs.
 */
export const DOCTOR_CHECKS = ["env", "lock", "ownership", "drift", "mode"] as const;

export type DoctorCheck = (typeof DOCTOR_CHECKS)[number];

/**
 * How much a finding matters.
 *
 * - `fail` — the project will not do what it says it does. Exit 6.
 * - `warn` — worth knowing, and a legitimate way to run: reported, but never an exit code.
 */
export const DOCTOR_SEVERITIES = ["fail", "warn"] as const;

export type DoctorSeverity = (typeof DOCTOR_SEVERITIES)[number];

/** One finding, in the shape required of an error, since that is what it would have been. */
export interface DoctorFinding {
  readonly check: DoctorCheck;
  readonly severity: DoctorSeverity;
  /** The summary: the offending identifier, and the file it is in. */
  readonly message: string;
  /** The remaining lines, ending in one concrete next step. */
  readonly detail: readonly string[];
}

/** What one check concluded: its worst finding, or `ok` when it found none. */
export type CheckStatus = "fail" | "ok" | "warn";

export interface CheckResult {
  readonly check: DoctorCheck;
  readonly status: CheckStatus;
}

export interface DoctorReport {
  /** Every check, in {@link DOCTOR_CHECKS} order — so a clean report still says what it looked at. */
  readonly checks: readonly CheckResult[];
  /** Every finding, grouped by check in that same order. */
  readonly findings: readonly DoctorFinding[];
}

/** How a diagnosis was asked to behave. */
export interface DoctorOptions {
  /** Resolve from the catalog cache alone, failing rather than fetching. */
  readonly offline?: boolean;
}

/** The findings that decide the exit code. */
export function doctorFailures(report: DoctorReport): readonly DoctorFinding[] {
  return report.findings.filter((finding) => finding.severity === "fail");
}

/** The findings that are reported and nothing more. */
export function doctorWarnings(report: DoctorReport): readonly DoctorFinding[] {
  return report.findings.filter((finding) => finding.severity === "warn");
}

/** Whether every check passed: no failures. A warning leaves a project healthy. */
export function isHealthy(report: DoctorReport): boolean {
  return doctorFailures(report).length === 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

function fail(check: DoctorCheck, message: string, detail: readonly string[]): DoctorFinding {
  return { check, severity: "fail", message, detail };
}

function warn(check: DoctorCheck, message: string, detail: readonly string[]): DoctorFinding {
  return { check, severity: "warn", message, detail };
}

/** What wants one environment variable, and whether install left a placeholder waiting for it. */
interface EnvDemand {
  /** One line per declarer, in a fixed order: skills, then servers, then config references. */
  readonly wanted: string[];
}

function demandOf(demands: Map<string, EnvDemand>, variable: string): EnvDemand {
  const existing = demands.get(variable);
  if (existing !== undefined) return existing;

  const created: EnvDemand = { wanted: [] };
  demands.set(variable, created);
  return created;
}

/**
 * Every string inside a planned config value, in key order.
 *
 * A managed value is arbitrary JSON — the harness's shape, not ambit's — so finding the
 * placeholders in it means walking it rather than knowing where a transport puts headers. Sorted at
 * every object so the order findings are discovered in is a function of the value, not of how it was
 * built.
 */
function stringsIn(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([a], [b]) => compare(a, b))
      .flatMap(([, nested]) => stringsIn(nested));
  }
  return [];
}

/**
 * Every variable one MCP entity's own strings reference — its url and headers, or its arguments.
 *
 * The entity, not the installed server: a catalog writes `${VAR}` and every harness gets its own
 * spelling of it, so this is the one place the answer is the same for all five.
 */
function entityReferences(mcp: MergedMcp): readonly string[] {
  const strings =
    mcp.transport.kind === "http"
      ? [mcp.transport.url, ...stringsIn(mcp.transport.headers)]
      : mcp.transport.args;
  return strings.flatMap(referencedNames);
}

/**
 * Who wants each environment variable the bundle needs.
 *
 * Three routes, all of them reported, because they say different things about where the variable is
 * read: a skill's `env` is something the agent reads at runtime, a server's `env` is something that
 * server reads, and a reference in a config file is one the harness expands when it spawns the server.
 * The fix is the same for all three — set the variable — because ambit puts references into these
 * files rather than values, so nothing needs reinstalling once it is set.
 */
function envDemands(
  bundle: Bundle,
  artifacts: readonly PlannedArtifact[],
): ReadonlyMap<string, EnvDemand> {
  const demands = new Map<string, EnvDemand>();

  for (const skill of bundle.skills) {
    for (const variable of sortedUnique(skill.env)) {
      demandOf(demands, variable).wanted.push(`skill "${skill.name}" declares it in \`env\``);
    }
  }

  for (const mcp of bundle.mcps) {
    for (const variable of sortedUnique(mcp.env)) {
      demandOf(demands, variable).wanted.push(`MCP server "${mcp.name}" declares it in \`env\``);
    }
  }

  // Read off the *entity* rather than the config file's own bytes. Each harness spells a reference in
  // its own syntax — `${VAR}`, `${env:VAR}`, `{env:VAR}`, and Codex's bare variable name under
  // `env_http_headers` — so scanning what was written would answer this question for Claude Code and
  // silently skip it for the other four. The entity is where the reference is format-independent.
  const referenced = new Map(
    bundle.mcps.map((mcp) => [mcp.name, sortedUnique(entityReferences(mcp))]),
  );
  const configs = artifacts.filter(
    (artifact): artifact is PlannedHarnessConfig => artifact.kind === "harness-config",
  );
  for (const artifact of configs) {
    for (const entry of artifact.entries) {
      const key = managedKey(artifact.section, entry.key);
      for (const variable of referenced.get(entry.key) ?? []) {
        demandOf(demands, variable).wanted.push(
          `"${key}" in ${artifact.path} references it, for the harness to expand at spawn`,
        );
      }
    }
  }

  return demands;
}

/**
 * Every variable something in the bundle declares that the environment does not have.
 *
 * "Does not have" is strictly absent, not empty. An empty value is a decision someone made, and it
 * is what install interpolates — treating it as missing would report a project that is configured
 * exactly as its author meant it to be.
 *
 * Reported in variable order, so the list is a function of the bundle rather than of which check
 * happened to notice a variable first.
 */
function envFindings(
  bundle: Bundle,
  artifacts: readonly PlannedArtifact[],
  env: Readonly<Record<string, string | undefined>>,
): readonly DoctorFinding[] {
  const demands = envDemands(bundle, artifacts);

  return [...demands.keys()]
    .sort(compare)
    .filter((variable) => env[variable] === undefined)
    .map((variable) => {
      const demand = demands.get(variable);
      const wanted = demand === undefined ? [] : demand.wanted;
      const step = `set ${variable} in the environment the agent runs in`;

      return fail("env", `unset environment variable "${variable}"`, [...wanted, step]);
    });
}

/**
 * Whether the committed lock is what resolution now produces — `--frozen`'s question, asked without
 * failing an install over it.
 *
 * Compared as bytes, exactly as `--frozen` does: the lock is a record nothing parses, and a file
 * install would rewrite is out of date whatever the two documents mean. Deliberately not
 * `assertLockCurrent`, whose message names `--frozen` and the project's absolute path — neither
 * belongs in a report.
 */
async function lockFindings(
  projectDir: string,
  expected: string,
): Promise<readonly DoctorFinding[]> {
  const actual = await readLockText(projectDir);
  if (actual === expected) return [];

  if (actual === undefined) {
    return [
      fail("lock", `${LOCK_FILENAME} is missing`, [
        "resolution produces a lock, and this project has none recorded",
        "run `ambit install` to write it",
      ]),
    ];
  }

  return [
    fail("lock", `${LOCK_FILENAME} is out of date`, [
      `resolving this project produces a different ${LOCK_FILENAME} than the one on disk`,
      `${LOCK_FILENAME} is written by \`ambit install\` and \`ambit prune\`, so config or a catalog commit has moved since the last one`,
      "run `ambit install` to rewrite it",
    ]),
  ];
}

/**
 * Artifacts that are there and that state does not claim — what install refuses.
 *
 * The explanation matters more than the finding, because the usual cause is not carelessness: state
 * is written after the filesystem changes it describes, so an install that crashed
 * leaves its own artifacts present-but-unowned and the next plain install stops on them. Someone who
 * knows that reaches for `--adopt`; someone who does not starts deleting files.
 */
function ownershipFindings(artifacts: readonly StatusArtifact[]): readonly DoctorFinding[] {
  return artifacts
    .filter((artifact) => artifact.state === "unowned")
    .map((artifact) =>
      fail("ownership", `ambit does not own ${artifact.path}`, [
        artifact.detail,
        "an `ambit install` that crashed leaves this: state is written after the files it describes",
        "move it aside, or run `ambit install --adopt` to take ownership",
      ]),
    );
}

/** The one concrete next step for an artifact install would change. */
function driftStep(state: StatusArtifact["state"]): string {
  if (state === "stale") return "run `ambit install`, or `ambit prune`, to remove it";
  if (state === "missing") return "run `ambit install` to write it";
  return "run `ambit install` to restore it";
}

/**
 * Everything install would change about the project: `status`'s findings, plus the one file `status`
 * has no row for.
 *
 * The managed `.gitignore` blocks are checked here because nothing else checks them at all. They
 * carry no state entry — the markers are the record (`gitignore.ts`) — so neither can be a `status`
 * row, and a block someone edited or deleted is otherwise fixed silently by the next install.
 *
 * `unowned` is excluded: it is the ownership check's, and reporting it twice would double every
 * finding about a crashed install.
 */
async function driftFindings(
  projectDir: string,
  artifacts: readonly PlannedArtifact[],
  status: readonly StatusArtifact[],
): Promise<readonly DoctorFinding[]> {
  const rows = status
    .filter((artifact) => artifact.state !== "ok" && artifact.state !== "unowned")
    .map((artifact) =>
      fail("drift", `${artifact.path} is ${artifact.state}`, [
        artifact.detail,
        driftStep(artifact.state),
      ]),
    );

  // The same question install's `--dry-run` asks, of the same renderer that writes — and asked per
  // file, because the two blocks go stale for different reasons: the nested one whenever the bundle
  // changes, the root one almost never.
  const gitignore = await gitignoreStatus(projectDir, artifacts);

  return [
    ...rows,
    ...gitignore
      .filter((block) => block.changed)
      .map((block) =>
        fail("drift", `${block.file} does not hold the block install would write`, [
          "ambit owns the lines between `# BEGIN ambit` and `# END ambit`, and rewrites them each install",
          "run `ambit install` to rewrite the block",
        ]),
      ),
  ];
}

/**
 * Which mode a skill is installed in, read off the target rather than off state.
 *
 * `lstat`, so a symlink is seen as itself. An error is treated as "no answer" rather than raised:
 * this only runs on artifacts the comparison already read successfully, and a mode is the one thing
 * here worth less than the run it would abort.
 */
async function installedMode(target: string): Promise<ArtifactMode | undefined> {
  try {
    const found = await lstat(target);
    if (found.isSymbolicLink()) return "link";
    return found.isDirectory() ? "copy" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Skills installed in a mode a plain `ambit install` would not choose.
 *
 * A warning, and only on artifacts that are otherwise `ok`: `--copy` and `--link` are per-run flags
 * with nothing persisting them, so the divergence is permanent by design and both modes put the same
 * bytes in front of the harness. That is why `status` ignores mode altogether — but it is still worth
 * saying, because the next plain install will silently swap every one of these over.
 */
async function modeFindings(
  artifacts: readonly PlannedArtifact[],
  status: readonly StatusArtifact[],
): Promise<readonly DoctorFinding[]> {
  const matching = new Set(
    status.filter((artifact) => artifact.state === "ok").map((artifact) => artifact.path),
  );
  const skills = artifacts.filter(
    (artifact): artifact is PlannedSkillDir =>
      artifact.kind === "skill-dir" && matching.has(artifact.path),
  );

  const findings: DoctorFinding[] = [];
  for (const artifact of skills) {
    const found = await installedMode(artifact.target);
    if (found === undefined || found === artifact.mode) continue;

    findings.push(
      warn("mode", `${artifact.path} is installed as a ${found}`, [
        artifact.mode === "link"
          ? "its source is a local directory someone edits, so a plain `ambit install` would symlink it"
          : "its source is pinned to a commit, so a plain `ambit install` would copy it",
        `keep passing \`--${found}\` to \`ambit install\` to leave it as it is`,
      ]),
    );
  }

  return findings;
}

/** Each check's verdict, derived from its findings so the two halves cannot disagree. */
function checkResults(findings: readonly DoctorFinding[]): readonly CheckResult[] {
  return DOCTOR_CHECKS.map((check) => {
    const own = findings.filter((finding) => finding.check === check);
    if (own.some((finding) => finding.severity === "fail")) return { check, status: "fail" };
    return { check, status: own.length === 0 ? "ok" : "warn" };
  });
}

/**
 * Runs every check against a project.
 *
 * Reads `process.env` directly, the way `projectStatus` does: the environment is the subject of the
 * first check, and the same one `planInstall` interpolates from, so a variable passed in separately
 * could contradict what install would actually write.
 *
 * @param projectDir the project root, absolute.
 * @param options `--offline`.
 * @throws {AmbitError} exit 2 for a malformed config or catalog, an unknown harness, an unreadable
 *   state file, or an artifact that cannot be inspected; exit 3 for a resolution error; exit 4 if a
 *   fetch fails, or under `--offline` when the cache cannot answer. A finding is never an error.
 */
export async function diagnoseProject(
  projectDir: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const planned = await planInstall(projectDir, { offline: options.offline === true });
  const status = await statusOfPlan(planned.artifacts, planned.prior);

  const findings = [
    ...envFindings(planned.bundle, planned.artifacts, process.env),
    ...(await lockFindings(projectDir, planned.lockText)),
    ...ownershipFindings(status.artifacts),
    ...(await driftFindings(projectDir, planned.artifacts, status.artifacts)),
    ...(await modeFindings(planned.artifacts, status.artifacts)),
  ];

  return { checks: checkResults(findings), findings };
}

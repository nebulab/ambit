/**
 * `ambit doctor` — preconditions, drift, and ownership.
 *
 * `validate` checks whether the catalog is coherent; `status` checks whether install would change an
 * artifact. This command covers what neither does: an unset environment variable a skill needs, a
 * committed lock that no longer matches what resolution produces, and artifacts a crashed install left
 * present but unowned.
 *
 * Reports findings instead of throwing, like `validate`. Every check runs, the whole list is printed,
 * and the exit code carries the verdict (exit 6).
 *
 * Two severities; only failures reach exit 6. Per spec §5, an uninterpolated `${VAR}` must not fail an
 * install, so a missing environment variable is a failure here — install can't refuse it, so this
 * command must catch it. A materialization mode mismatch (`--copy` vs `--link`) is a warning: both put
 * identical bytes in front of the harness, and it's a per-run choice with nothing persisting it, so
 * `status` ignores mode entirely too. A harness limitation ambit can't write around is a warning for the
 * same reason.
 *
 * Runs `planInstall` once and derives everything else from it, so `doctor` can't disagree with `status`
 * about an artifact or with `install --frozen` about the lock. Nothing here writes.
 */
import { lstat } from "node:fs/promises";

import type {
  PlannedArtifact,
  PlannedCatalogDir,
  PlannedHarnessConfig,
} from "../harness/adapter.js";
import { codex } from "../harness/definitions.js";
import { referencedNames } from "../harness/env.js";
import { gitignoreStatus } from "./gitignore.js";
import type { MergedMcp } from "../model/catalog.js";
import { expectedEnv } from "../model/expectation.js";
import { managedKey } from "../model/documents/index.js";
import { planInstall } from "./install.js";
import { LOCK_FILENAME, readLockText } from "./lock.js";
import type { Bundle } from "../resolution/resolve.js";
import type { ArtifactMode } from "../model/state.js";
import type { StatusArtifact } from "./status.js";
import { statusOfPlan } from "./status.js";

/**
 * The checks, in the order they run and are reported: the world around the project, then the record
 * of the last install, then what that record and the project disagree about, then the two that are
 * merely worth knowing (materialization mode, harness limitations).
 *
 * `expects` covers every kind of precondition an entity can declare, not one check per kind, since they
 * share a verdict and a fix: something about the machine isn't as the catalog needs, and the reader
 * sets it. Today that's `env:` alone; `bin:` is a case inside this check, not a separate entry.
 */
export const DOCTOR_CHECKS = ["expects", "lock", "ownership", "drift", "mode", "harness"] as const;

export type DoctorCheck = (typeof DOCTOR_CHECKS)[number];

/**
 * How much a finding matters.
 *
 * - `fail` — the project will not do what it says it does. Exit 6.
 * - `warn` — worth knowing, and a legitimate way to run: reported, but never an exit code.
 */
export const DOCTOR_SEVERITIES = ["fail", "warn"] as const;

export type DoctorSeverity = (typeof DOCTOR_SEVERITIES)[number];

/** One finding, shaped like an error, since that is what it would have been. */
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

/** The line a Codex user has to have in their own config for any hook ambit writes to run. */
const CODEX_HOOKS_FEATURE = "[features] codex_hooks = true";

function fail(check: DoctorCheck, message: string, detail: readonly string[]): DoctorFinding {
  return { check, severity: "fail", message, detail };
}

function warn(check: DoctorCheck, message: string, detail: readonly string[]): DoctorFinding {
  return { check, severity: "warn", message, detail };
}

/** What wants one environment variable, and whether install left a placeholder waiting for it. */
interface EnvDemand {
  /** One line per declarer, in a fixed order: skills, servers, hooks, then config references. */
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
 * A managed value is arbitrary JSON in the harness's own shape, not ambit's, so finding placeholders
 * means walking it rather than knowing where a transport puts headers. Object keys are sorted so the
 * discovery order depends only on the value, not on how it was built.
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
 * Every variable one MCP entity's own strings reference: its url and headers, or its arguments.
 *
 * Read off the entity rather than the installed server, because each harness spells a reference in its
 * own syntax, and the entity is where the answer is the same for all of them.
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
 * Four routes: a skill's `env:` expectation (read by the agent at runtime), a server's `env:`
 * expectation (read by the server), a hook's `env:` expectation (read by the command the harness
 * spawns), and a `${VAR}` reference in a config file (expanded by the harness when it spawns the
 * server). The fix is the same for all four: set the variable. Ambit writes references into these
 * files, not values, so nothing needs reinstalling once it is set.
 *
 * The fourth route is why this check reads more than `expects`: an author can reference `${VAR}` in a
 * transport's headers without declaring it, and this is the only check that sees it.
 *
 * A hook contributes through its `expects` alone, never a config-reference line: a `${VAR}` inside a
 * hook's `command` is left intact for the shell the harness spawns, not rewritten into a harness's own
 * reference syntax, so there is no reference in the file to find.
 */
function envDemands(
  bundle: Bundle,
  artifacts: readonly PlannedArtifact[],
): ReadonlyMap<string, EnvDemand> {
  const demands = new Map<string, EnvDemand>();

  for (const skill of bundle.skills) {
    for (const variable of expectedEnv(skill.expects)) {
      demandOf(demands, variable).wanted.push(`skill "${skill.name}" expects it`);
    }
  }

  for (const mcp of bundle.mcps) {
    for (const variable of expectedEnv(mcp.expects)) {
      demandOf(demands, variable).wanted.push(`MCP server "${mcp.name}" expects it`);
    }
  }

  for (const hook of bundle.hooks) {
    for (const variable of expectedEnv(hook.expects)) {
      demandOf(demands, variable).wanted.push(`hook "${hook.name}" expects it`);
    }
  }

  // Read off the entity rather than the config file's bytes. Each harness spells a reference in its own
  // syntax (`${VAR}`, `${env:VAR}`, `{env:VAR}`, Codex's bare variable name under `env_http_headers`),
  // so scanning the written file would miss it for four of the five harnesses.
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
 * Every variable something in the bundle expects that the environment does not have.
 *
 * "Does not have" means strictly absent, not empty. An empty value is a decision someone made, and
 * it's what install interpolates; treating it as missing would flag a project configured exactly as
 * its author intended.
 *
 * Reported in variable order, so the list depends on the bundle, not on check order.
 */
function expectFindings(
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

      return fail("expects", `unset environment variable "${variable}"`, [...wanted, step]);
    });
}

/**
 * Whether the committed lock is what resolution now produces: `--frozen`'s question, asked without
 * failing an install over it.
 *
 * Compared as bytes, exactly as `--frozen` does; the lock is a record nothing parses. Deliberately not
 * `assertLockCurrent`, whose message names `--frozen` and the project's absolute path, neither of which
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
 * Artifacts that are present but that state does not claim: what install refuses.
 *
 * State is written after the filesystem changes it describes, so an install that crashed leaves its
 * own artifacts present-but-unowned, and the next plain install stops on them. The fix is `--adopt`.
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
 * Everything install would change about the project: `status`'s findings, plus the managed
 * `.gitignore` blocks, which `status` has no row for.
 *
 * The `.gitignore` blocks carry no state entry (the markers are the record, in `gitignore.ts`), so
 * they can't be a `status` row, and nothing else checks them.
 *
 * `unowned` is excluded here: it belongs to the ownership check, and reporting it twice would double
 * every finding about a crashed install.
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

  // Same question install's `--dry-run` asks, of the same renderer that writes. Checked per file
  // because the two blocks go stale for different reasons: the nested one whenever the bundle changes,
  // the root one almost never.
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
 * Uses `lstat` so a symlink is seen as itself. Errors are treated as "no answer" rather than raised:
 * this only runs on artifacts already read successfully, and a mode mismatch isn't worth aborting the
 * run over.
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
 * Directories installed in a mode a plain `ambit install` would not choose.
 *
 * A warning, only on artifacts that are otherwise `ok`. `--copy` and `--link` are per-run flags with
 * nothing persisting them, so the divergence is permanent by design and both modes put the same bytes
 * in front of the harness; that's why `status` ignores mode entirely. Still worth reporting, since the
 * next plain install will silently swap these over.
 *
 * Covers both directory kinds (skill and hook), since `status` is deliberately silent about mode and
 * this is the only check that reports it.
 */
async function modeFindings(
  artifacts: readonly PlannedArtifact[],
  status: readonly StatusArtifact[],
): Promise<readonly DoctorFinding[]> {
  const matching = new Set(
    status.filter((artifact) => artifact.state === "ok").map((artifact) => artifact.path),
  );
  const directories = artifacts.filter(
    (artifact): artifact is PlannedCatalogDir =>
      (artifact.kind === "skill-dir" || artifact.kind === "hook-dir") &&
      matching.has(artifact.path),
  );

  const findings: DoctorFinding[] = [];
  for (const artifact of directories) {
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

/**
 * What a configured harness needs that ambit is not allowed to write.
 *
 * One finding today, Codex's: hooks there are experimental and only read when a user's own
 * `config.toml` carries `[features] codex_hooks = true`. That file is user-level, not the project's, so
 * ambit writes `.codex/hooks.json` correctly and the hooks still never fire.
 *
 * A warning, not a failure: ambit cannot tell whether the flag is set, and failing would leave anyone
 * on Codex with a `doctor` that can never pass. Only raised when the project selects a hook.
 */
function harnessFindings(bundle: Bundle, harnesses: readonly string[]): readonly DoctorFinding[] {
  const layout = codex.hooks;
  if (layout === undefined || bundle.hooks.length === 0) return [];
  if (!harnesses.includes(codex.name)) return [];

  return [
    warn("harness", `${codex.name} runs hooks only with \`${CODEX_HOOKS_FEATURE}\` set`, [
      `this project selects ${bundle.hooks.length === 1 ? "a hook" : "hooks"}, and ambit writes them to ${layout.file}`,
      `${codex.name}'s hooks are experimental, and the flag enabling them is user-level config ambit must not write`,
      `set \`${CODEX_HOOKS_FEATURE}\` in your own ${codex.name} config to have them run`,
    ]),
  ];
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
 * Reads `process.env` directly, like `projectStatus` does: it's the same environment `planInstall`
 * interpolates from, so a variable passed in separately could contradict what install would write.
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
    ...expectFindings(planned.bundle, planned.artifacts, process.env),
    ...(await lockFindings(projectDir, planned.lockText)),
    ...ownershipFindings(status.artifacts),
    ...(await driftFindings(projectDir, planned.artifacts, status.artifacts)),
    ...(await modeFindings(planned.artifacts, status.artifacts)),
    ...harnessFindings(planned.bundle, planned.harnesses),
  ];

  return { checks: checkResults(findings), findings };
}

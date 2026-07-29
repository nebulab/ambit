/**
 * Full-catalog validation — what CI runs, for a catalog repo (`ambit catalog validate`) and for a
 * project that consumes one (`ambit validate`).
 *
 * `resolve` and `install` hard-validate the selected closure only, so one broken skill nobody holds
 * cannot block everyone. That leaves a gap this closes: a dangling `requires` or a cycle can sit in a
 * catalog for weeks until the first profile that reaches it fails, and the person it fails for is
 * never the person who wrote it. So every skill, every server and every hook is checked here,
 * selected or not — every catalog's copy of a name included, since two copies of one name are two
 * documents, each of which can be broken on its own.
 *
 * What is *not* checked is a tag: nothing registers one, so a misspelled tag inside a catalog is
 * indistinguishable from a new one and there is nowhere to put the check. Only the consumer-side
 * direction still fails — a `requires` entry that matches nothing, below.
 *
 * Problems are **collected, not thrown**. A CI run that reports the first of six costs six runs to
 * clear, which is what makes a validator people stop trusting. The command prints the list and
 * exits 3 once, at the end.
 *
 * The messages are the same builders resolution throws — `unmatchedEntryError`,
 * `missingRequirement`, `cycleError` — so a problem reads identically whether it was listed here or
 * raised there, and neither can drift into its own phrasing.
 *
 * One boundary is deliberate. A catalog that does not **parse** is still exit 2 at the first
 * error: there is no useful semantic report about a document ambit cannot read. The one exception is
 * a skill whose `name` disagrees with its path — which is collected instead,
 * because the path already answers what the skill is called (see {@link CatalogParseOptions}).
 */
import path from "node:path";

import type {
  CatalogOverlay,
  CatalogParseOptions,
  MergedCatalog,
  MergedSkill,
} from "../model/catalog.js";
import {
  copiesByName,
  loadCatalogs,
  mergeCatalogs,
  parseCatalogDirectory,
  qualifiedName,
} from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import { loadProjectConfig } from "../model/config.js";
import type { AmbitError } from "../errors.js";
import type { ItemKind } from "../model/requirement.js";
import { sortedUniqueRequirements } from "../model/requirement.js";
import {
  cycleError,
  entryPosition,
  matchesAnything,
  missingRequirement,
  unmatchedEntryError,
} from "./resolve.js";
import type { SourceContext } from "../model/sources.js";

/**
 * What kind of problem a report entry is, so `--json` can be filtered without parsing prose.
 *
 * The three a catalog can hold, plus the one a project's own config contributes: a `requires` entry
 * that matches nothing. That one is already a resolution error — `validate` is where every offender
 * is listed at once instead of one per run.
 *
 * One kind covers what used to be two, `unknown-scope` and `unknown-skill`, because there is one
 * grammar now: an exact name is a pattern with no wildcard, so a misspelled name and a stale glob are
 * the same finding and the message names which entry it is about.
 *
 * A name two catalogs provide is deliberately *not* one of them. It is a problem only where a project
 * selects both copies, which is resolution's judgement to make and not a fact about a catalog — see
 * `assertNoCollisions`.
 *
 * Each kind names a *class* of problem rather than a namespace: a dangling `requires` on a hook is the
 * same finding it is on a skill, and the message already names which of the three the offender is. So a
 * namespace joining the catalog adds no kind here.
 */
export const VALIDATION_PROBLEM_KINDS = [
  "cycle",
  "name-mismatch",
  "unmatched-pattern",
  "unresolvable-requirement",
] as const;

export type ValidationProblemKind = (typeof VALIDATION_PROBLEM_KINDS)[number];

/** One problem, in the shape required of an error, since that is what it would have been. */
export interface ValidationProblem {
  readonly kind: ValidationProblemKind;
  /** The summary: the offending identifier, and the file it is written in. */
  readonly message: string;
  /** The remaining lines, ending in one concrete next step. */
  readonly detail: readonly string[];
}

/** What the run covered, so a clean report says what it checked rather than saying nothing. */
export interface ValidationCounts {
  readonly hooks: number;
  readonly mcps: number;
  readonly skills: number;
}

export interface ValidationReport {
  readonly checked: ValidationCounts;
  /**
   * Every problem found, in a fixed order: the catalog's own integrity first — name mismatches,
   * unresolvable requirements, cycles — then how the project uses it. Within each check, findings
   * are in name order, or in document order where the subject is the project's own list, so the
   * report is a function of the inputs and not of the order anything was read in.
   */
  readonly problems: readonly ValidationProblem[];
}

/** Whether the catalog is valid: no problems at all, of any kind. */
export function isValid(report: ValidationReport): boolean {
  return report.problems.length === 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Wraps what would have been thrown as what is listed instead. */
function problem(kind: ValidationProblemKind, error: AmbitError): ValidationProblem {
  return { kind, message: error.message, detail: error.detail };
}

/**
 * Every `requires` entry no catalog can satisfy — across the whole catalog, not only the closure a
 * project's own entries reach.
 *
 * "Provided" is a question about the name, since that is all a `requires` entry names: an entry is
 * satisfied if any catalog provides its target. Two catalogs shipping copies of one broken skill
 * therefore yield one finding each, which is right — they are two documents, and each has to be
 * fixed where it is written.
 */
function requirementProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const provided: Readonly<Record<ItemKind, ReadonlySet<string>>> = {
    skill: new Set(merged.skills.map((skill) => skill.name)),
    mcp: new Set(merged.mcps.map((mcp) => mcp.name)),
    hook: new Set(merged.hooks.map((hook) => hook.name)),
  };
  const problems: ValidationProblem[] = [];

  for (const skill of merged.skills) {
    for (const target of sortedUniqueRequirements(skill.requires)) {
      if (!provided[target.kind].has(target.name)) {
        problems.push(problem("unresolvable-requirement", missingRequirement(skill, target)));
      }
    }
  }

  return problems;
}

/**
 * Every `requires` cycle, walked from every skill rather than from the ones a project selects.
 *
 * One cycle is reported per back edge the walk meets. Two independent cycles are therefore both
 * reported, which is what "all problems" has to mean here; two cycles sharing a back edge collapse
 * into the one the walk closed first, which is still enough to act on — the edge to remove is in
 * both.
 *
 * The walk visits skills in name order and never re-follows a skill it closed, so which member a
 * reported path opens on is a function of the names alone. The canonical-rotation guard makes
 * reporting one loop once a property of the report rather than of the traversal, so a later change
 * to how the graph is walked cannot turn into a duplicated problem.
 *
 * A skill edge is followed into *every* catalog's copy of the name, as the closure does, so a cycle
 * is found whichever copy the walk arrived through. The bookkeeping is addresses for the same reason:
 * two catalogs' copies of one name are two nodes, and one loop in each of two catalogs is two
 * problems, each in a catalog somebody has to fix.
 */
function cycleProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const copies = copiesByName(merged.skills);
  const problems: ValidationProblem[] = [];
  const reported = new Set<string>();

  const walked: MergedSkill[] = [];
  const closed = new Set<string>();

  const record = (cycle: readonly MergedSkill[], head: MergedSkill): void => {
    // The path closes on the skill it opened with, so the loop's members are all but the last.
    const members = cycle.slice(0, -1).map(qualifiedName);
    const first = [...members].sort(compare)[0];
    const start = first === undefined ? 0 : members.indexOf(first);
    // U+0000 as the separator, written as an escape rather than as the byte itself: a literal
    // NUL makes grep and every other tool that sniffs for one treat this file as binary.
    const key = [...members.slice(start), ...members.slice(0, start)].join("\u0000");

    if (reported.has(key)) return;
    reported.add(key);
    // Names in the printed path, addresses in the key: a path is read against the `requires` lists an
    // author wrote, which name siblings and never qualify them.
    problems.push(
      problem(
        "cycle",
        cycleError(
          cycle.map((skill) => skill.name),
          head,
        ),
      ),
    );
  };

  const follow = (skill: MergedSkill): void => {
    const address = qualifiedName(skill);
    const opened = walked.findIndex((entry) => qualifiedName(entry) === address);
    if (opened !== -1) {
      record([...walked.slice(opened), skill], skill);
      return;
    }
    if (closed.has(address)) return;

    walked.push(skill);
    for (const target of sortedUniqueRequirements(skill.requires)) {
      // Both leaf namespaces end the walk: only a skill can require anything, so only a skill edge
      // can close a loop.
      if (target.kind !== "skill") continue;
      // A requirement nothing provides is `requirementProblems`'s finding; here it is simply an
      // edge that goes nowhere, and following it would report the same thing twice.
      for (const required of copies.get(target.name) ?? []) follow(required);
    }
    walked.pop();
    closed.add(address);
  };

  for (const skill of merged.skills) follow(skill);
  return problems;
}

/**
 * What a project's own config contributes: every `requires` entry no item satisfies.
 *
 * Already an exit-3 resolution error, which stops at the first offender. Listing them all is the
 * point — a config holding four mistyped entries costs four `resolve` runs to find and one
 * `validate` run.
 *
 * In the order the entries were written, so the report reads down the file the reader has open. That
 * is a function of the config alone, which is all determinism asks for here; resolution sorts instead
 * because it reports one of them and the choice must not fall to incidental ordering.
 */
function configProblems(
  config: ProjectConfig,
  merged: MergedCatalog,
): readonly ValidationProblem[] {
  return config.requires
    .filter((entry) => !matchesAnything(entry, merged))
    .map((entry) =>
      problem(
        "unmatched-pattern",
        unmatchedEntryError(entry, entryPosition(config, entry), merged.catalogs),
      ),
    );
}

export interface ValidateOptions {
  /**
   * The project's config, when validation is running for a project rather than a bare catalog
   * directory. Absent means the catalog is validated on its own terms — a catalog is not a project
   * and has no `ambit.yml`.
   */
  readonly config?: ProjectConfig;
  /**
   * Problems collected while parsing, listed ahead of the rest — see {@link CatalogParseOptions}.
   */
  readonly parsed?: readonly ValidationProblem[];
}

/**
 * Validates a merged catalog. Pure, so every authoring command can check its own result before
 * writing it without touching the disk twice.
 */
export function validateCatalog(
  merged: MergedCatalog,
  options: ValidateOptions = {},
): ValidationReport {
  const config = options.config;

  return {
    // Every copy, not every name: two catalogs providing `house-style` is two documents this run
    // read and checked, and a count that said one would understate what the report covers.
    checked: {
      hooks: merged.hooks.length,
      mcps: merged.mcps.length,
      skills: merged.skills.length,
    },
    problems: [
      ...(options.parsed ?? []),
      ...requirementProblems(merged),
      ...cycleProblems(merged),
      ...(config === undefined ? [] : configProblems(config, merged)),
    ],
  };
}

/** Collects name↔path disagreements into `parsed`, the one problem parsing continues past. */
function collector(parsed: ValidationProblem[]): CatalogParseOptions {
  return { collect: (found) => parsed.push(problem("name-mismatch", found)) };
}

/**
 * Validates everything a project configures: every catalog it lists, and its own `requires` entries.
 *
 * Runs the same pipeline `resolve` does, minus resolution itself — one merged catalog, built the one
 * way there is to build one, so every finding here is a finding `resolve` would raise.
 *
 * @param context where sources resolve from, `--offline` included, so this adds no place that could
 *   forget it.
 * @throws {AmbitError} exit 2 for a missing or malformed config, an unresolvable source, or a
 *   catalog that does not parse; exit 4 if a fetch fails.
 */
export async function validateProject(context: SourceContext): Promise<ValidationReport> {
  const parsed: ValidationProblem[] = [];

  const config = await loadProjectConfig(context.projectDir);
  const merged = mergeCatalogs(await loadCatalogs(config, context, collector(parsed)));

  return validateCatalog(merged, { config, parsed });
}

/**
 * Validates one catalog directory on its own terms — `ambit catalog validate`, the check a catalog
 * repo runs in CI.
 *
 * Nothing about a project is read: no `ambit.yml`, no other catalog, no cache. A catalog is not a
 * project, and a CI job for one has neither.
 *
 * @param root the catalog root, absolute. Its basename names the catalog in problems; the name and
 *   the synthesized `source` appear nowhere in the report, which is what keeps the output free of
 *   machine paths.
 * @param overlay files an in-flight edit would write, read instead of what is on disk. This is how an
 *   authoring mutation checks its own result before writing it.
 * @throws {AmbitError} exit 2 if the directory is not a catalog, or does not parse.
 */
export async function validateCatalogDirectory(
  root: string,
  overlay?: CatalogOverlay,
): Promise<ValidationReport> {
  const parsed: ValidationProblem[] = [];
  const catalog = await parseCatalogDirectory(
    path.basename(root),
    `path:${root}`,
    root,
    undefined,
    { ...collector(parsed), ...(overlay !== undefined && { overlay }) },
  );

  return validateCatalog(mergeCatalogs([catalog]), { parsed });
}

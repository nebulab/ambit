/**
 * Full-catalog validation — what CI runs, for a catalog repo (`ambit catalog validate`) and for a
 * project that consumes one (`ambit validate`).
 *
 * `resolve` and `install` hard-validate the selected closure only, so one broken skill nobody holds
 * cannot block everyone. That leaves a gap this closes: a dangling `requires`, a cycle, an
 * unregistered scope, or a shadowed name can sit in a catalog for weeks until the first profile
 * that reaches it fails, and the person it fails for is never the person who wrote it. So every
 * skill and every server is checked here, selected or not.
 *
 * Problems are **collected, not thrown**. A CI run that reports the first of six costs six runs to
 * clear, which is what makes a validator people stop trusting. The command prints the list and
 * exits 3 once, at the end.
 *
 * The messages are the same builders resolution throws — `unknownScopeError`,
 * `missingRequirement`, `cycleError`, `unknownExplicitSkill` — so a problem reads identically
 * whether it was listed here or raised there, and neither can drift into its own phrasing.
 *
 * Two boundaries are deliberate. A catalog that does not **parse** is still exit 2 at the first
 * error: there is no useful semantic report about a document ambit cannot read. The one exception is
 * a skill whose `name` disagrees with its path — which is collected instead,
 * because the path already answers what the skill is called (see {@link CatalogParseOptions}).
 * Likewise a project whose config collides with a catalog, or whose catalogs describe one scope
 * differently, still fails one problem at a time: both are refusals to build a merged view, and
 * there is nothing to validate without one.
 */
import path from "node:path";

import type {
  CatalogOverlay,
  CatalogParseOptions,
  MergedCatalog,
  MergedMcp,
  MergedSkill,
  Shadowing,
} from "../model/catalog.js";
import {
  SCOPES_FILENAME,
  loadCatalogs,
  mergeCatalogs,
  mergeConfigEntities,
  parseCatalogDirectory,
} from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import { loadProjectConfig } from "../model/config.js";
import type { AmbitError } from "../errors.js";
import { at, resolutionError } from "../errors.js";
import {
  MCP_REQUIREMENT_PREFIX,
  cycleError,
  missingRequirement,
  scopeSuggestion,
  skillFile,
  unknownExplicitSkill,
  unknownScopeError,
} from "./resolve.js";
import type { SourceContext } from "../model/sources.js";

/**
 * What kind of problem a report entry is, so `--json` can be filtered without parsing prose.
 *
 * The five a catalog can hold, plus the two a project's own config contributes: a held scope no registry
 * knows, and a `skills` entry nothing provides. Those two are already resolution errors — `validate`
 * is where they are all listed at once instead of one per run.
 */
export const VALIDATION_PROBLEM_KINDS = [
  "cycle",
  "name-mismatch",
  "shadowed-name",
  "unknown-scope",
  "unknown-skill",
  "unregistered-scope",
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
  readonly mcps: number;
  readonly scopes: number;
  readonly skills: number;
}

export interface ValidationReport {
  readonly checked: ValidationCounts;
  /**
   * Every problem found, in a fixed order: the catalog's own integrity first — name mismatches,
   * unregistered scopes, unresolvable requirements, cycles, shadowed names — then how the project
   * uses it. Within each check, findings are in name order, so the report is a function of the
   * catalog's contents and not of the order anything was read in.
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

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

/** Wraps what would have been thrown as what is listed instead. */
function problem(kind: ValidationProblemKind, error: AmbitError): ValidationProblem {
  return { kind, message: error.message, detail: error.detail };
}

/**
 * Where an MCP entity is written, as a problem cites it.
 *
 * Read off the merged view rather than derived from the name: `mcps/<name>.yml` is only the
 * extension ambit *writes*, so a catalog spelling an entity `.yaml` would be reported against a file
 * that is not there. Parsing already found the real one and carries it ({@link MergedMcp.file}),
 * which also means nothing here has to re-decide which catalog's copy won.
 *
 * An entity a project declares inline has no file of its own, and its `catalog` is the config
 * filename — so its absence reads as "declared in `ambit.yml`", which is where a reader goes to
 * change it.
 */
function mcpFile(mcp: MergedMcp): string {
  return mcp.file ?? mcp.catalog;
}

/**
 * The problem for a scope a skill or a server declares that no catalog registers.
 *
 * Nothing else reports this: expansion runs against the registry, so an unregistered declared scope
 * simply never selects anything, and the skill carrying it is dead weight nobody is told about.
 * That makes it exactly the class of problem a catalog's CI exists to catch.
 */
function unregisteredScope(
  scope: string,
  where: string,
  declarer: string,
  registered: MergedCatalog["scopes"],
): ValidationProblem {
  return problem(
    "unregistered-scope",
    resolutionError(`unregistered scope "${scope}" ${where}`, [
      `${declarer} declares it, but no catalog's ${SCOPES_FILENAME} registers it`,
      scopeSuggestion(scope, registered),
    ]),
  );
}

function unregisteredScopeProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const known = new Set(merged.scopes.map((definition) => definition.name));
  const problems: ValidationProblem[] = [];

  for (const skill of merged.skills) {
    for (const scope of sortedUnique(skill.scopes)) {
      if (known.has(scope)) continue;
      problems.push(
        unregisteredScope(
          scope,
          at(skillFile(skill), undefined),
          `skill "${skill.name}"`,
          merged.scopes,
        ),
      );
    }
  }

  for (const mcp of merged.mcps) {
    for (const scope of sortedUnique(mcp.scopes)) {
      if (known.has(scope)) continue;
      problems.push(
        unregisteredScope(
          scope,
          at(mcpFile(mcp), undefined),
          `MCP server "${mcp.name}" (catalog "${mcp.catalog}")`,
          merged.scopes,
        ),
      );
    }
  }

  return problems;
}

/**
 * Every `requires` entry no catalog can satisfy — across the whole catalog, not only the closure a
 * project's scopes reach.
 */
function requirementProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const skills = new Set(merged.skills.map((skill) => skill.name));
  const mcps = new Set(merged.mcps.map((mcp) => mcp.name));
  const problems: ValidationProblem[] = [];

  for (const skill of merged.skills) {
    for (const requirement of sortedUnique(skill.requires)) {
      const resolved = requirement.startsWith(MCP_REQUIREMENT_PREFIX)
        ? mcps.has(requirement.slice(MCP_REQUIREMENT_PREFIX.length))
        : skills.has(requirement);
      if (!resolved) {
        problems.push(problem("unresolvable-requirement", missingRequirement(skill, requirement)));
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
 */
function cycleProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const byName = new Map(merged.skills.map((skill) => [skill.name, skill]));
  const problems: ValidationProblem[] = [];
  const reported = new Set<string>();

  const walked: string[] = [];
  const closed = new Set<string>();

  const record = (cycle: readonly string[], head: MergedSkill): void => {
    // The path closes on the name it opened with, so the loop's members are all but the last.
    const members = cycle.slice(0, -1);
    const first = [...members].sort(compare)[0];
    const start = first === undefined ? 0 : members.indexOf(first);
    // U+0000 as the separator, written as an escape rather than as the byte itself: a literal
    // NUL makes grep and every other tool that sniffs for one treat this file as binary.
    const key = [...members.slice(start), ...members.slice(0, start)].join("\u0000");

    if (reported.has(key)) return;
    reported.add(key);
    problems.push(problem("cycle", cycleError(cycle, head)));
  };

  const follow = (skill: MergedSkill): void => {
    const opened = walked.indexOf(skill.name);
    if (opened !== -1) {
      record([...walked.slice(opened), skill.name], skill);
      return;
    }
    if (closed.has(skill.name)) return;

    walked.push(skill.name);
    for (const requirement of sortedUnique(skill.requires)) {
      if (requirement.startsWith(MCP_REQUIREMENT_PREFIX)) continue;
      const required = byName.get(requirement);
      // A requirement nothing provides is `requirementProblems`'s finding; here it is simply an
      // edge that goes nowhere, and following it would report the same thing twice.
      if (required !== undefined) follow(required);
    }
    walked.pop();
    closed.add(skill.name);
  };

  for (const skill of merged.skills) follow(skill);
  return problems;
}

/**
 * The problem for a name more than one catalog provides.
 *
 * A problem rather than a note, even though resolution has a well-defined answer for it: in a
 * catalog repo two copies of one name means one of them is unreachable, and unreachable
 * instructions are worse than absent ones — someone maintains them believing they are in use.
 */
function shadowedName(kind: string, shadowing: Shadowing): AmbitError {
  return resolutionError(`shadowed ${kind} "${shadowing.name}" (catalog "${shadowing.catalog}")`, [
    `catalog "${shadowing.catalog}" provides the copy resolution uses`,
    `also provided by: ${shadowing.shadows.join(", ")}`,
    "rename one of the copies, or drop the catalog that should not provide it",
  ]);
}

function shadowingProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  return [
    ...[...merged.shadowing.skills.values()].map((shadowing) =>
      problem("shadowed-name", shadowedName("skill", shadowing)),
    ),
    ...[...merged.shadowing.mcps.values()].map((shadowing) =>
      problem("shadowed-name", shadowedName("MCP server", shadowing)),
    ),
  ];
}

/**
 * What a project's own config contributes: held scopes no registry knows, and `skills` entries
 * nothing provides.
 *
 * Both are already exit-3 resolution errors. Listing them is the point — a config naming four
 * mistyped scopes costs four `resolve` runs to find and one `validate` run.
 */
function configProblems(
  config: ProjectConfig,
  merged: MergedCatalog,
): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  const registered = new Set(merged.scopes.map((definition) => definition.name));
  for (const scope of sortedUnique(config.scopes)) {
    if (registered.has(scope)) continue;
    problems.push(
      problem(
        "unknown-scope",
        unknownScopeError(
          scope,
          at(config.origin.file, config.origin.scopeLines.get(scope)),
          merged.scopes,
        ),
      ),
    );
  }

  const provided = new Set(merged.skills.map((skill) => skill.name));
  for (const name of sortedUnique(config.skills.map((request) => request.name))) {
    if (provided.has(name)) continue;
    problems.push(problem("unknown-skill", unknownExplicitSkill(name, config)));
  }

  return problems;
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
    checked: {
      mcps: merged.mcps.length,
      scopes: merged.scopes.length,
      skills: merged.skills.length,
    },
    problems: [
      ...(options.parsed ?? []),
      ...unregisteredScopeProblems(merged),
      ...requirementProblems(merged),
      ...cycleProblems(merged),
      ...shadowingProblems(merged),
      ...(config === undefined ? [] : configProblems(config, merged)),
    ],
  };
}

/** Collects name↔path disagreements into `parsed`, the one problem parsing continues past. */
function collector(parsed: ValidationProblem[]): CatalogParseOptions {
  return { collect: (found) => parsed.push(problem("name-mismatch", found)) };
}

/**
 * Validates everything a project configures: every catalog it lists, its own declarations, and its
 * own held scopes.
 *
 * Runs the same pipeline `resolve` does, minus resolution itself — a project's `skills` entries and
 * inline `mcps` are folded in, so a `requires` edge to something the config defined resolves here
 * exactly as it would there.
 *
 * @param context where sources resolve from, `--offline` included, so this adds no place that could
 *   forget it.
 * @throws {AmbitError} exit 2 for a missing or malformed config, an unresolvable source, or a
 *   catalog that does not parse; exit 3 for a config declaration a catalog also provides or one
 *   scope two catalogs describe differently; exit 4 if a fetch fails.
 */
export async function validateProject(context: SourceContext): Promise<ValidationReport> {
  const parsed: ValidationProblem[] = [];

  const config = await loadProjectConfig(context.projectDir);
  const catalogs = mergeCatalogs(await loadCatalogs(config, context, collector(parsed)));
  const merged = await mergeConfigEntities(catalogs, config, context);

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

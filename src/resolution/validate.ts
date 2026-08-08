/**
 * Full-catalog validation for `ambit validate`, which is what CI runs. Covers a project and a catalog
 * repo with one report shape: a catalog repo scaffolded by `ambit init` lists itself via a `catalogs:`
 * entry naming `path:.`, whose `skills/`, `mcps/` and `hooks/` are read as the `local` catalog.
 *
 * Every item in the merged catalog is checked, whether anything selects it or not, including every
 * catalog's own copy of a name (two copies of one name are two documents that can each be broken
 * independently). `resolve` and `install` validate only the selected closure, so a broken skill
 * nobody selects can otherwise sit undetected for weeks until the first profile that reaches it fails;
 * this module closes that gap. Everything is checked by name, so a misspelled grouping cannot
 * silently become a new one.
 *
 * Problems are collected, not thrown: the command prints the whole list and exits 3 once, instead of
 * stopping at the first offender. Messages reuse the same builders resolution throws
 * (`unmatchedEntryError` and `cycleError`), so a problem reads the same whether listed here or raised
 * there.
 *
 * A catalog that fails to parse still exits 2 immediately. The one exception is a skill whose `name`
 * disagrees with its path, which is collected instead of thrown, because the path already answers
 * what the skill is called (see {@link CatalogParseOptions}).
 */
import type { CatalogParseOptions, MergedCatalog } from "../model/catalog.js";
import { CATALOG_SEPARATOR, loadCatalogs, mergeCatalogs, qualifiedName } from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import { loadProjectConfig } from "../model/config.js";
import type { AmbitError } from "../errors.js";
import { at, resolutionError } from "../errors.js";
import type { PatternEntry } from "../model/pattern.js";
import { REQUIRES_KEY } from "../model/pattern.js";
import type { Requirer } from "./resolve.js";
import {
  cycleError,
  entryCatalog,
  entryPosition,
  matchesAnything,
  matchesOwnCatalog,
  requiredEntries,
  requiredItems,
  requirerPosition,
  requirersOf,
  unmatchedEntryError,
} from "./resolve.js";
import type { SourceContext } from "../model/sources.js";

/**
 * What kind of problem a report entry is, so `--json` can be filtered without parsing prose.
 *
 * `unmatched-pattern` covers any `requires` entry that resolves to nothing: a project's entry against
 * its configured catalogs, or a skill's own entry against the catalog that ships it. An exact name is
 * a pattern with no wildcard, so a misspelled name, a stale glob, and a dangling requirement are all
 * this one kind.
 *
 * `unselected-catalog` is the one finding whose subject is the config alone rather than a document in
 * a catalog; see {@link unselectedCatalogProblems}.
 *
 * A name two catalogs provide is not itself a problem here. It is a problem only when a project
 * selects both copies, which is resolution's judgement to make (see `assertNoCollisions`).
 */
export const VALIDATION_PROBLEM_KINDS = [
  "cycle",
  "name-mismatch",
  "unmatched-pattern",
  "unselected-catalog",
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
  readonly packs: number;
  readonly skills: number;
}

export interface ValidationReport {
  readonly checked: ValidationCounts;
  /**
   * Every problem found, in a fixed order: the catalog's own integrity first (name mismatches, its
   * own `requires` entries, cycles), then how the project uses it (unmatched entries, then catalogs
   * it never reaches into). Within each check, findings are in name order, or in document order where
   * the subject is the project's own list, so the report is a function of the inputs, not of read order.
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
 * The refusal a catalog's `requires` entry earns when it selects nothing, built exactly as resolution
 * builds it.
 *
 * The catalog the entry resolves in is always the requirer's own: a catalog author cannot write a
 * consumer's alias, so a bare pattern inside a catalog means this catalog.
 */
function unmatchedRequirement(
  requirer: Requirer,
  entry: PatternEntry,
  catalogs: readonly string[],
): ValidationProblem {
  return problem(
    "unmatched-pattern",
    unmatchedEntryError(entry, requirer.catalog, requirerPosition(requirer), catalogs),
  );
}

/**
 * Every `requires` entry inside a catalog that selects nothing, across the whole catalog, not only
 * the closure a project's own entries reach.
 *
 * A requirement is a pattern, resolved within the catalog that ships the requiring skill, so an entry
 * satisfied by a sibling catalog's copy is not satisfied. Two catalogs shipping copies of one broken
 * skill therefore yield one finding each, since each is a separate document to fix.
 */
function requirementProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  for (const requirer of requirersOf(merged)) {
    for (const entry of requiredEntries(requirer)) {
      if (matchesOwnCatalog(entry, requirer, merged)) continue;
      problems.push(unmatchedRequirement(requirer, entry, merged.catalogs));
    }
  }

  return problems;
}

/**
 * Every `requires` cycle, walked from every pack and every skill rather than from the ones a project
 * selects.
 *
 * One cycle is reported per back edge the walk meets: two independent cycles are both reported, but
 * two sharing a back edge collapse into the one closed first (still enough to name an edge to remove).
 *
 * The walk visits requirers in a fixed order (packs first, then skills, each by name) and never
 * re-follows one it closed, so which member a reported path opens on is deterministic. The
 * canonical-rotation guard keeps a loop reported once regardless of traversal order.
 *
 * An edge goes wherever the entry that wrote it selects, within the requirer's own catalog and
 * nowhere else, through {@link requiredItems} (the same function the closure walks with). Bookkeeping
 * uses full addresses because two catalogs' copies of one name are two nodes, so a loop in each is two
 * separate problems.
 */
function cycleProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const reported = new Set<string>();

  const walked: Requirer[] = [];
  const closed = new Set<string>();

  // Node identity: namespace, catalog and name. A pack and a skill may share a name, so the
  // namespace is part of it; a loop through one is not a loop through the other.
  const key = (requirer: Requirer): string => `${requirer.kind}:${qualifiedName(requirer)}`;
  const byKey = new Map(requirersOf(merged).map((requirer) => [key(requirer), requirer]));

  const record = (cycle: readonly Requirer[], requirer: Requirer, entry: PatternEntry): void => {
    // The path closes on the node it opened with, so the loop's members are all but the last.
    const members = cycle.slice(0, -1).map(key);
    const first = [...members].sort(compare)[0];
    const start = first === undefined ? 0 : members.indexOf(first);
    // U+0000 as separator, written as an escape: a literal NUL byte would make grep and similar
    // tools treat this file as binary.
    const rotated = [...members.slice(start), ...members.slice(0, start)].join("\u0000");

    if (reported.has(rotated)) return;
    reported.add(rotated);
    // `<kind>:<name>` in the printed path, full addresses in the key: a path is read against the
    // `requires` lists an author wrote, which name siblings and never qualify them.
    problems.push(
      problem(
        "cycle",
        cycleError(
          cycle.map((seen) => ({ kind: seen.kind, name: seen.name })),
          requirer,
          entry,
        ),
      ),
    );
  };

  const follow = (requirer: Requirer): void => {
    if (closed.has(key(requirer))) return;

    walked.push(requirer);
    for (const entry of requiredEntries(requirer)) {
      // Packs and skills only: only those two can require anything, so only their edges can close a
      // loop. An entry that selects nothing at all is `requirementProblems`' finding; here it is
      // simply an edge that goes nowhere.
      const selected = requiredItems(entry, requirer, merged);
      const next = [
        ...selected.packs.map((pack) => byKey.get(`pack:${qualifiedName(pack)}`)),
        ...selected.skills.map((skill) => byKey.get(`skill:${qualifiedName(skill)}`)),
      ].filter((candidate): candidate is Requirer => candidate !== undefined);

      for (const child of next) {
        // Checked here rather than on entry to `follow`: the cycle error names the entry that closed
        // the loop, and this is the only place that knows which one that is.
        const opened = walked.findIndex((seen) => key(seen) === key(child));
        if (opened !== -1) {
          record([...walked.slice(opened), child], requirer, entry);
          continue;
        }
        follow(child);
      }
    }
    walked.pop();
    closed.add(key(requirer));
  };

  for (const requirer of byKey.values()) follow(requirer);
  return problems;
}

/**
 * What a project's own config contributes: every `requires` entry no item satisfies.
 *
 * This is already an exit-3 resolution error, which stops at the first offender; listing them all
 * means a config holding four mistyped entries costs one `validate` run instead of four `resolve` runs.
 *
 * Listed in the order the entries were written, so the report reads down the file the reader has
 * open. (Resolution itself sorts instead, because it reports only one of them and the choice must
 * not fall to incidental ordering.)
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
        unmatchedEntryError(
          entry,
          entryCatalog(entry),
          entryPosition(config, entry),
          merged.catalogs,
        ),
      ),
    );
}

/** How many items one catalog contributed to the merged view, across all three namespaces. */
function itemCount(merged: MergedCatalog, catalog: string): number {
  const mine = (items: readonly { readonly catalog: string }[]): number =>
    items.filter((item) => item.catalog === catalog).length;

  return mine(merged.packs) + mine(merged.skills) + mine(merged.mcps) + mine(merged.hooks);
}

/**
 * Every catalog the config lists that no `requires` entry selects from, that has items, and that the
 * project did not publish itself.
 *
 * This is the check that catches a typo'd `source:`. A catalog is a directory and nothing else, so a
 * misspelled path is no longer a parse failure: it is a directory holding none of the three item
 * directories, i.e. a catalog with zero items. Where some pattern is qualified with that alias,
 * `unmatched-pattern` catches it instead and names the pattern the config wrote; this finding covers
 * what is left over, an alias nothing mentions at all. "Referenced" means qualified with, not matched
 * by, so reporting both an unmatched pattern and its catalog would count one mistake twice.
 *
 * Two exemptions, both following the same rule: what `ambit init` scaffolds is never a finding.
 *
 * - A catalog with no items. The scaffolded `local` entry is live against three empty directories
 *   while the `requires` entry that would select it is commented out, so a finding here would fail
 *   `validate` on every freshly initialized project.
 * - The catalog the project is. This exemption stops applying once somebody puts a skill in
 *   `skills/`, which is what a catalog repo is: a repo that publishes and consumes nothing. Every item
 *   in it is checked regardless (this module's contract), and none of them being selected is the
 *   normal state of a catalog repo, not a mistake.
 *
 * Listed in `catalogs:` order (`merged.catalogs`' order), so the report reads down the file.
 *
 * @param own the catalogs whose root is the project directory itself, see {@link ValidateOptions.own}.
 */
function unselectedCatalogProblems(
  config: ProjectConfig,
  merged: MergedCatalog,
  own: readonly string[],
): readonly ValidationProblem[] {
  const mentioned = new Set(config.requires.map(entryCatalog));

  return merged.catalogs
    .filter((catalog) => !mentioned.has(catalog) && !own.includes(catalog))
    .map((catalog) => ({ catalog, items: itemCount(merged, catalog) }))
    .filter(({ items }) => items > 0)
    .map(({ catalog, items }) =>
      problem(
        "unselected-catalog",
        resolutionError(
          `catalog "${catalog}" is configured but nothing selects from it ${at(config.origin.file, undefined)}`,
          [
            `it provides ${items} item${items === 1 ? "" : "s"}, and no \`${REQUIRES_KEY}\` entry is qualified with "${catalog}${CATALOG_SEPARATOR}"`,
            `select what this project needs from it, or drop it from \`catalogs:\``,
          ],
        ),
      ),
    );
}

export interface ValidateOptions {
  /**
   * The project's config. Required: every report is about a project, because a catalog repo is
   * one too, listing itself as `source: path:.` and validated through the same config as any other.
   */
  readonly config: ProjectConfig;
  /** Problems collected while parsing, listed ahead of the rest; see {@link CatalogParseOptions}. */
  readonly parsed?: readonly ValidationProblem[];
  /**
   * The names of the catalogs the project is: the ones whose root resolved to the project directory
   * itself, which is what `source: path:.` means and what `ambit init` scaffolds.
   *
   * A fact about where a source resolved to, so it cannot be recovered from the parsed config alone;
   * passed in rather than worked out here. Read by {@link unselectedCatalogProblems} to tell
   * publishing from consuming. Absent means the project publishes nothing.
   */
  readonly own?: readonly string[];
}

/**
 * Validates a merged catalog against the config that assembled it. Pure: it reads only the parsed
 * catalog and the parsed config, so {@link validateProject} touches the disk once and this decides
 * everything afterwards.
 */
export function validateCatalog(merged: MergedCatalog, options: ValidateOptions): ValidationReport {
  const { config } = options;

  return {
    // Every copy, not every name: two catalogs providing `house-style` are two documents checked
    // here, and a count of one would understate what the report covers.
    checked: {
      hooks: merged.hooks.length,
      mcps: merged.mcps.length,
      packs: merged.packs.length,
      skills: merged.skills.length,
    },
    problems: [
      ...(options.parsed ?? []),
      ...requirementProblems(merged),
      ...cycleProblems(merged),
      ...configProblems(config, merged),
      ...unselectedCatalogProblems(config, merged, options.own ?? []),
    ],
  };
}

/** Collects name↔path disagreements into `parsed`, the one problem parsing continues past. */
function collector(parsed: ValidationProblem[]): CatalogParseOptions {
  return { collect: (found) => parsed.push(problem("name-mismatch", found)) };
}

/**
 * Validates everything a project configures: every catalog it lists, its own items among them, and
 * its own `requires` entries. The only entry point; a catalog repo runs this too, being a project
 * that lists itself.
 *
 * Runs the same pipeline `resolve` does, minus resolution itself, so every finding here is a finding
 * `resolve` would raise.
 *
 * @param context where sources resolve from, including `--offline`.
 * @throws {AmbitError} exit 2 for a missing or malformed config, an unresolvable source, or a
 *   catalog that does not parse; exit 4 if a fetch fails.
 */
export async function validateProject(context: SourceContext): Promise<ValidationReport> {
  const parsed: ValidationProblem[] = [];

  const config = await loadProjectConfig(context.projectDir);
  const catalogs = await loadCatalogs(config, context, collector(parsed));
  // Which catalogs the project published rather than fetched: the directory a source resolved to.
  // `path:.` lands on the project root, and so does any other spelling of the same directory.
  const own = catalogs.filter((catalog) => catalog.root === context.projectDir);

  return validateCatalog(mergeCatalogs(catalogs), {
    config,
    parsed,
    own: own.map((catalog) => catalog.name),
  });
}

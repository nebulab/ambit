/**
 * Full-catalog validation — `ambit validate`, what CI runs, for a project and for a catalog repo
 * alike.
 *
 * One subject, not two. `ambit catalog validate` existed because "a catalog is not a project and has
 * no `ambit.yml`, and a CI job for one has neither" — and a catalog repo now lists **itself**, which
 * is what `ambit init` scaffolds: a `catalogs:` entry naming `path:.`, whose `skills/`, `mcps/` and
 * `hooks/` are read as the `local` catalog. So the report has one shape, nothing dispatches on
 * whether a config is present, and no catalog identity is synthesized from a directory basename.
 *
 * The whole of the cost is a three-line `ambit.yml` in a repo that had none, and a `harnesses` list
 * sitting unread in a repo that never installs. Accepted, not fixed: it is a default doing no harm,
 * and a config key that a whole class of repo is exempt from would cost more to explain than it saves.
 *
 * What makes that enough is the contract below: every item in the merged catalog is checked whether
 * anything selects it or not. A catalog repo with no `requires:` list at all therefore has every
 * skill, server and hook it ships checked — which is exactly what the separate command was for.
 *
 * `resolve` and `install` hard-validate the selected closure only, so one broken skill nobody selects
 * cannot block everyone. That leaves a gap this closes: a dangling `requires` or a cycle can sit in a
 * catalog for weeks until the first profile that reaches it fails, and the person it fails for is
 * never the person who wrote it. So every skill, every server and every hook is checked here,
 * selected or not — every catalog's copy of a name included, since two copies of one name are two
 * documents, each of which can be broken on its own.
 *
 * What is *not* checked is a tag an item **declares**: nothing registers one, so a misspelled
 * `ambit.tags` label is indistinguishable from a new tag and there is nowhere to put the check. Every
 * direction that *selects* by one does fail, at both altitudes — a project's `requires` entry that
 * matches nothing, and a skill's own, both below.
 *
 * Problems are **collected, not thrown**. A CI run that reports the first of six costs six runs to
 * clear, which is what makes a validator people stop trusting. The command prints the list and
 * exits 3 once, at the end.
 *
 * The messages are the same builders resolution throws — `unmatchedEntryError` and `cycleError` — so a
 * problem reads identically whether it was listed here or raised there, and neither can drift into its
 * own phrasing. Two of them, not three: a `requires` entry inside a catalog that reaches nothing is the
 * *same finding* as a project entry that reaches nothing, one altitude down, and there is no
 * *unresolvable requirement* left to report separately now that a requirement is a pattern.
 *
 * One boundary is deliberate. A catalog that does not **parse** is still exit 2 at the first
 * error: there is no useful semantic report about a document ambit cannot read. The one exception is
 * a skill whose `name` disagrees with its path — which is collected instead,
 * because the path already answers what the skill is called (see {@link CatalogParseOptions}).
 */
import type { CatalogParseOptions, MergedCatalog, MergedSkill } from "../model/catalog.js";
import { CATALOG_SEPARATOR, loadCatalogs, mergeCatalogs, qualifiedName } from "../model/catalog.js";
import type { ProjectConfig } from "../model/config.js";
import { loadProjectConfig } from "../model/config.js";
import type { AmbitError } from "../errors.js";
import { at, resolutionError } from "../errors.js";
import type { PatternEntry } from "../model/pattern.js";
import { REQUIRES_KEY } from "../model/pattern.js";
import {
  cycleError,
  entryCatalog,
  entryPosition,
  matchesAnything,
  matchesOwnCatalog,
  requiredEntries,
  requiredItems,
  requirerPosition,
  unmatchedEntryError,
} from "./resolve.js";
import type { SourceContext } from "../model/sources.js";

/**
 * What kind of problem a report entry is, so `--json` can be filtered without parsing prose.
 *
 * `unmatched-pattern` is **one finding at both altitudes** a `requires` list is written at: a
 * project's entry that reaches nothing in the catalogs it configured, and a skill's own entry that
 * reaches nothing in the catalog that ships it. Both are already resolution errors — `validate` is
 * where every offender is listed at once instead of one per run.
 *
 * One kind covers what used to be three, `unknown-scope`, `unknown-skill` and
 * `unresolvable-requirement`, because there is one grammar now: an exact name is a pattern with no
 * wildcard, so a misspelled name, a stale glob and a dangling requirement are the same finding, and
 * the message names which entry and which file it is about.
 *
 * `unselected-catalog` is the one finding whose subject is the config alone rather than any document
 * in a catalog — see {@link unselectedCatalogProblems} for why it is the check that catches a typo'd
 * `source:`, which no longer fails at parse.
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
  readonly skills: number;
}

export interface ValidationReport {
  readonly checked: ValidationCounts;
  /**
   * Every problem found, in a fixed order: the catalog's own integrity first — name mismatches, its
   * own `requires` entries, cycles — then how the project uses it, its unmatched entries before the
   * catalogs it reaches into not at all. Within each check, findings are in name order, or in
   * document order where the subject is the project's own list, so the report is a function of the
   * inputs and not of the order anything was read in.
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
 * The refusal a skill's `requires` entry earns when it selects nothing, built exactly as resolution
 * builds it.
 *
 * The catalog the entry resolves in is the skill's own, always: a catalog author cannot write a
 * consumer's alias, so a bare pattern inside a catalog means *this catalog* and a message that named
 * any other would be describing a lookup ambit does not perform.
 */
function unmatchedRequirement(
  skill: MergedSkill,
  entry: PatternEntry,
  catalogs: readonly string[],
): ValidationProblem {
  return problem(
    "unmatched-pattern",
    unmatchedEntryError(entry, skill.catalog, requirerPosition(skill), catalogs),
  );
}

/**
 * Every `requires` entry inside a catalog that selects nothing — across the whole catalog, not only
 * the closure a project's own entries reach.
 *
 * The question is what the entry *matches*, not whether some name is provided: a requirement is a
 * pattern now, resolved within the catalog that ships the requiring skill, so an entry satisfied by a
 * sibling catalog's copy is not satisfied. Two catalogs shipping copies of one broken skill therefore
 * yield one finding each, which is right — they are two documents, and each has to be fixed where it
 * is written.
 */
function requirementProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  for (const skill of merged.skills) {
    for (const entry of requiredEntries(skill)) {
      if (matchesOwnCatalog(entry, skill, merged)) continue;
      problems.push(unmatchedRequirement(skill, entry, merged.catalogs));
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
 * An edge goes wherever the entry that wrote it selects, which is within the requiring skill's own
 * catalog and nowhere else — through {@link requiredItems}, the same function the closure walks with,
 * so the two cannot disagree about where an edge goes. The bookkeeping is addresses for the same
 * reason: two catalogs' copies of one name are two nodes, and one loop in each of two catalogs is two
 * problems, each in a catalog somebody has to fix.
 */
function cycleProblems(merged: MergedCatalog): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const reported = new Set<string>();

  const walked: MergedSkill[] = [];
  const closed = new Set<string>();

  const record = (
    cycle: readonly MergedSkill[],
    requirer: MergedSkill,
    entry: PatternEntry,
  ): void => {
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
          requirer,
          entry,
        ),
      ),
    );
  };

  const follow = (skill: MergedSkill): void => {
    const address = qualifiedName(skill);
    if (closed.has(address)) return;

    walked.push(skill);
    for (const entry of requiredEntries(skill)) {
      // Skills only, because only a skill can require anything and so only a skill edge can close a
      // loop. An entry that selects nothing at all is `requirementProblems`' finding; here it is
      // simply an edge that goes nowhere, and following it would report the same thing twice.
      for (const required of requiredItems(entry, skill, merged).skills) {
        // Checked here rather than on entry to `follow`, because the cycle error names the entry that
        // closed the loop and this is the only place that knows which one that is.
        const opened = walked.findIndex((seen) => qualifiedName(seen) === qualifiedName(required));
        if (opened !== -1) {
          record([...walked.slice(opened), required], skill, entry);
          continue;
        }
        follow(required);
      }
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

  return mine(merged.skills) + mine(merged.mcps) + mine(merged.hooks);
}

/**
 * Every catalog the config lists that no `requires` entry selects from — *that has items*, and *that
 * the project did not publish itself*.
 *
 * This is the case a typo'd `source:` escapes into. A catalog is a directory and nothing else, so a
 * misspelled path is no longer a parse failure: it is a directory holding none of the three item
 * directories, which is simply a catalog with zero items. Where some pattern is qualified with that
 * alias, `unmatched-pattern` catches it one step later and better — it names the pattern the config
 * went out of its way to write. This finding is what is left over: an alias nothing mentions at all,
 * which no other check has a reason to look at.
 *
 * Referenced means *qualified with*, not *matched by*: an entry spelled `personal/nope` mentions
 * `personal`, so it is the unmatched pattern that is reported and not the catalog. Reporting both
 * would be one mistake counted twice.
 *
 * Two exemptions, and both come down to one rule: **what `ambit init` scaffolds is never a finding.**
 *
 * - **A catalog with no items.** The scaffolded `local` entry is live against three empty
 *   directories while the `requires` entry that would select it is commented out, so a finding here
 *   would fail `validate` on every freshly initialized project. It is also just true: an empty
 *   catalog nobody selects from is empty, and nothing is being missed.
 * - **The catalog the project *is*.** The guard above stops holding the moment somebody puts a skill
 *   in `skills/`, which is what a catalog repo is — a repo that publishes and consumes nothing,
 *   carrying the three-line `ambit.yml` that lists itself and no `requires:` list at all. Every item
 *   in it is checked (that is this module's contract), and none of them is selected, and that is the
 *   normal state of a catalog repo rather than a mistake in it. Publishing is not consuming. A
 *   catalog fetched from elsewhere and then never selected from is the case worth a word, and it is
 *   the case left over.
 *
 * In `catalogs:` order, which is `merged.catalogs`' order, so the report reads down the file.
 *
 * @param own the catalogs whose root *is* the project directory — see {@link ValidateOptions.own}.
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
   * The project's config. Required: every report is about a project now, because a catalog repo is
   * one — it lists itself as `source: path:.` and is validated through the same config as any other.
   */
  readonly config: ProjectConfig;
  /**
   * Problems collected while parsing, listed ahead of the rest — see {@link CatalogParseOptions}.
   */
  readonly parsed?: readonly ValidationProblem[];
  /**
   * The names of the catalogs the project **is**: the ones whose root resolved to the project
   * directory itself, which is what `source: path:.` means and what `ambit init` scaffolds.
   *
   * A fact about where a source resolved to, so it cannot be recovered from the parsed config alone —
   * hence a parameter rather than something this module works out. Read by
   * {@link unselectedCatalogProblems}, the one check that has to tell publishing from consuming.
   * Absent means the project publishes nothing, which is the truthful default for a caller that has
   * not resolved any source.
   */
  readonly own?: readonly string[];
}

/**
 * Validates a merged catalog against the config that assembled it. Pure: it reads the parsed catalog
 * and the parsed config and nothing else, so {@link validateProject} touches the disk once and this
 * decides everything afterwards.
 */
export function validateCatalog(merged: MergedCatalog, options: ValidateOptions): ValidationReport {
  const { config } = options;

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
 * its own `requires` entries. The only entry point — a catalog repo runs this too, being a project
 * that lists itself.
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
  const catalogs = await loadCatalogs(config, context, collector(parsed));
  // Which of them the project published rather than fetched, by the only test that answers it
  // exactly: the directory a source resolved to. `path:.` lands on the project root, and so does any
  // other spelling of the same directory.
  const own = catalogs.filter((catalog) => catalog.root === context.projectDir);

  return validateCatalog(mergeCatalogs(catalogs), {
    config,
    parsed,
    own: own.map((catalog) => catalog.name),
  });
}

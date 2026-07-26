/**
 * Validation, for CI — one report in two commands, because there are two subjects to validate.
 *
 * `ambit validate` validates everything a project configures: every catalog it lists, its own
 * declarations, and its own held scopes. `ambit catalog validate` validates one catalog directory on
 * its own terms and reads no `ambit.yml`, since a catalog repo has none.
 *
 * They were one command with a `--catalog <dir>` flag that switched which of the two it meant, which
 * put a project flag and a catalog flag on the same command and left `--offline` accepted on a run
 * that resolves no source. The seam was already there under the CLI — {@link validateProject} and
 * {@link validateCatalogDirectory} share nothing but the report they return — so the split is only the
 * surface catching up with it. Both halves render through {@link toText} and {@link toJson} here, so
 * neither can drift into its own idea of what a report looks like.
 *
 * The report is printed and the exit code carries the verdict, the way `status --check` does: a
 * catalog with problems is a finding about the catalog, not a failure of ambit's, and a CI job needs
 * both halves — the list to fix and the code to fail on.
 *
 * A clean run still prints what it checked. "no problems found" on its own is indistinguishable from
 * a run that found nothing to look at — a catalog whose skills all failed to be discovered, say.
 */
import type { CommandHandler } from "../commands.js";
import { catalogDirOf, jsonRequested, sourceContextOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import { printSections } from "../output.js";
import type { ValidationProblem, ValidationReport } from "../../resolution/validate.js";
import { isValid, validateCatalogDirectory, validateProject } from "../../resolution/validate.js";

function problemJson(problem: ValidationProblem): Readonly<Record<string, unknown>> {
  return { detail: problem.detail, kind: problem.kind, message: problem.message };
}

function toJson(report: ValidationReport): Readonly<Record<string, unknown>> {
  return {
    checked: {
      mcps: report.checked.mcps,
      scopes: report.checked.scopes,
      skills: report.checked.skills,
    },
    problems: report.problems.map(problemJson),
    valid: isValid(report),
  };
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

/**
 * The problems block: each summary indented like a section row, each detail line indented under it
 * the way an error's own `format()` indents one — this is the same problem, printed in a list rather
 * than raised. Column padding is deliberately absent: these are sentences, not a table.
 */
function problemLines(problems: readonly ValidationProblem[]): readonly string[] {
  const body =
    problems.length === 0
      ? ["  (none)"]
      : problems.flatMap((problem) => [
          `  ${problem.message}`,
          ...problem.detail.map((line) => `      ${line}`),
        ]);

  return [`problems (${problems.length})`, ...body, ""];
}

function toText(report: ValidationReport): readonly string[] {
  const { checked } = report;
  return [
    `checked ${count(checked.scopes, "scope")}, ${count(checked.skills, "skill")}, ${count(checked.mcps, "mcp")}`,
    "",
    ...problemLines(report.problems),
  ];
}

/** Prints one report and turns it into the exit code, for whichever subject produced it. */
function report(ctx: Parameters<CommandHandler>[0], found: ValidationReport): ExitCode {
  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(found), null, 2));
  else printSections(toText(found), ctx.stdout);

  return isValid(found) ? ExitCode.Success : ExitCode.Resolution;
}

/** `ambit validate` — everything the project configures. */
export const validateHandler: CommandHandler = async (ctx) =>
  report(ctx, await validateProject(sourceContextOf(ctx)));

/** `ambit catalog validate` — one catalog directory, on its own terms. */
export const catalogValidateHandler: CommandHandler = async (ctx) =>
  report(ctx, await validateCatalogDirectory(catalogDirOf(ctx)));

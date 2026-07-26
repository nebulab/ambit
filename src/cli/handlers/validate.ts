/**
 * `ambit validate` — full-catalog validation, for CI (spec §6).
 *
 * The report is printed and the exit code carries the verdict, the way `status --check` does: a
 * catalog with problems is a finding about the catalog, not a failure of ambit's, and a CI job needs
 * both halves — the list to fix and the code to fail on.
 *
 * `--catalog <dir>` validates that directory alone and reads no `ambit.yml`, since a catalog repo has
 * none (spec §6). Without it, the subject is the project: every catalog it lists, its own
 * declarations, and its own held scopes.
 *
 * A clean run still prints what it checked. "no problems found" on its own is indistinguishable from
 * a run that found nothing to look at — a catalog whose skills all failed to be discovered, say.
 */
import path from "node:path";

import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
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

export const validateHandler: CommandHandler = async (ctx) => {
  const given = ctx.options.catalog;
  const report =
    typeof given === "string"
      ? await validateCatalogDirectory(path.resolve(ctx.cwd, given))
      : await validateProject(sourceContextOf(ctx));

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(report), null, 2));
  else printSections(toText(report), ctx.stdout);

  return isValid(report) ? ExitCode.Success : ExitCode.Resolution;
};

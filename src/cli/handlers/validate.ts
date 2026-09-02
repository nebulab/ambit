/**
 * `ambit validate`, for CI — one report over one subject.
 *
 * Validates everything a project configures: every catalog it lists, and its own `requires` entries.
 * This also covers a catalog repo, since a catalog repo lists itself as `source: path:.`, so its
 * `packs/`, `skills/`, `mcps/` and `hooks/` arrive as an ordinary catalog and get checked the same way.
 *
 * The report is printed and the exit code carries the verdict, like `status --check`: a catalog with
 * problems is a finding, not a failure of ambit's, and a CI job needs both the list to fix and the
 * code to fail on.
 *
 * A clean run still prints what it checked, since "no problems found" alone would be
 * indistinguishable from a run that found nothing to look at (e.g. a catalog whose skills all failed
 * to be discovered).
 */
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { ExitCode } from "../../errors.js";
import { printSections } from "../output.js";
import type { ValidationProblem, ValidationReport } from "../../resolution/validate.js";
import { isValid, validateProject } from "../../resolution/validate.js";

function problemJson(problem: ValidationProblem): Readonly<Record<string, unknown>> {
  return { detail: problem.detail, kind: problem.kind, message: problem.message };
}

function toJson(report: ValidationReport): Readonly<Record<string, unknown>> {
  return {
    checked: {
      hooks: report.checked.hooks,
      mcps: report.checked.mcps,
      packs: report.checked.packs,
      plugins: report.checked.plugins,
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
 * the way an error's own `format()` does. Column padding is deliberately absent: these are sentences,
 * not a table.
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
    `checked ${count(checked.packs, "pack")}, ${count(checked.plugins, "plugin")}, ${count(checked.skills, "skill")}, ${count(checked.mcps, "mcp")}, ${count(checked.hooks, "hook")}`,
    "",
    ...problemLines(report.problems),
  ];
}

/** `ambit validate` — everything the project configures, the project's own catalog included. */
export const validateHandler: CommandHandler = async (ctx) => {
  const found = await validateProject(sourceContextOf(ctx));

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(found), null, 2));
  else printSections(toText(found), ctx.stdout);

  return isValid(found) ? ExitCode.Success : ExitCode.Resolution;
};

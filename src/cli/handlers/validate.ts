/**
 * `ambit validate`, for CI — one report over one subject.
 *
 * It validates everything a project configures: every catalog it lists, and its own `requires`
 * entries. That covers a catalog repo too, without a second command: a catalog repo lists **itself**
 * as `source: path:.`, so its `packs/`, `skills/`, `mcps/` and `hooks/` arrive as an ordinary catalog and
 * `validateCatalog` checks every item in it whether the (possibly absent) `requires` list selects
 * anything or not.
 *
 * `ambit catalog validate` was the second command, and it existed because a catalog was not a project
 * and had no `ambit.yml`. Since it is one, the flag that named a catalog root goes, `--offline` is
 * uniform across the surface rather than absent on the one command that resolved no source, and
 * nothing here dispatches on which subject it was handed.
 *
 * The report is printed and the exit code carries the verdict, the way `status --check` does: a
 * catalog with problems is a finding about the catalog, not a failure of ambit's, and a CI job needs
 * both halves — the list to fix and the code to fail on.
 *
 * A clean run still prints what it checked. "no problems found" on its own is indistinguishable from
 * a run that found nothing to look at — a catalog whose skills all failed to be discovered, say.
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
    `checked ${count(checked.packs, "pack")}, ${count(checked.skills, "skill")}, ${count(checked.mcps, "mcp")}, ${count(checked.hooks, "hook")}`,
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

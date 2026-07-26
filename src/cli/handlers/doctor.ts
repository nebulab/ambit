/**
 * `ambit doctor` — env vars, drift, ownership (spec §6).
 *
 * Three sections, because the report answers two different questions. The `checks` table says what was
 * examined and how each one came out, so a healthy project says so explicitly rather than printing an
 * empty list — the same reason `validate` counts back what it checked. Failures and warnings are then
 * separated rather than tagged, because the split *is* the exit code: everything under `failures` is
 * why this run returned 6, and everything under `warnings` is why it did not.
 *
 * The findings themselves are printed the way `validate` prints a problem — summary indented like a
 * row, detail lines indented under it as an error's own `format()` indents them. They are the same
 * thing, listed instead of raised.
 */
import type { CommandHandler } from "../commands.js";
import { jsonRequested, offlineRequested, projectDirOf } from "../commands.js";
import type { DoctorFinding, DoctorReport } from "../../project/doctor.js";
import { diagnoseProject, doctorFailures, doctorWarnings, isHealthy } from "../../project/doctor.js";
import { ExitCode } from "../../errors.js";
import { printSections, section } from "../output.js";

function findingJson(finding: DoctorFinding): Readonly<Record<string, unknown>> {
  return {
    check: finding.check,
    detail: finding.detail,
    message: finding.message,
    severity: finding.severity,
  };
}

function toJson(report: DoctorReport): Readonly<Record<string, unknown>> {
  return {
    checks: report.checks.map((result) => ({ check: result.check, status: result.status })),
    findings: report.findings.map(findingJson),
    healthy: isHealthy(report),
  };
}

/** Column padding is deliberately absent from the body: these are sentences, not a table. */
function findingLines(title: string, findings: readonly DoctorFinding[]): readonly string[] {
  const body =
    findings.length === 0
      ? ["  (none)"]
      : findings.flatMap((finding) => [
          `  ${finding.message}`,
          ...finding.detail.map((line) => `      ${line}`),
        ]);

  return [`${title} (${findings.length})`, ...body, ""];
}

function toText(report: DoctorReport): readonly string[] {
  return [
    ...section(
      "checks",
      report.checks.map((result) => [result.check, result.status]),
    ),
    ...findingLines("failures", doctorFailures(report)),
    ...findingLines("warnings", doctorWarnings(report)),
  ];
}

export const doctorHandler: CommandHandler = async (ctx) => {
  const report = await diagnoseProject(projectDirOf(ctx), { offline: offlineRequested(ctx) });

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(report), null, 2));
  else printSections(toText(report), ctx.stdout);

  return isHealthy(report) ? ExitCode.Success : ExitCode.Doctor;
};

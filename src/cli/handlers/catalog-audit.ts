/**
 * `ambit catalog audit` (spec §6, "Catalog authoring") — dead scopes and unreachable items.
 *
 * Two sections, and the first is the reason the second is trustworthy: `audited` says what the run
 * looked at, so a catalog with nothing to report says so explicitly rather than printing an empty
 * list — the same argument `validate` makes for counting back what it checked. A report that had
 * silently found no skills at all would otherwise read exactly like a healthy one.
 *
 * The findings are printed the way `validate` prints a problem and `doctor` prints a finding —
 * summary indented like a row, detail lines indented under it as an error's own `format()` indents
 * them — because all three are the same thing, listed instead of raised. No column padding: these are
 * sentences, not a table.
 *
 * `--check` prints the same report and returns exit 6, rather than raising. Dead weight is a finding
 * about the catalog, not a failure of ambit's, so plain `ambit catalog audit` succeeds however much
 * it found: an audit that broke a build by existing is an audit nobody adds to CI. `--check` is how a
 * catalog opts into failing on it, which is why it carries `doctor`'s code — the same "a health check
 * found something" answer, one subject over.
 *
 * Read-only, so there is no `--dry-run` and no diff, and the determinism rules apply unchanged
 * (spec §4): every list is sorted upstream, and no absolute path reaches either output form.
 */
import type { AuditFinding, AuditReport } from "../../authoring/audit.js";
import { auditCatalogDirectory, isTidy } from "../../authoring/audit.js";
import type { CommandHandler } from "../commands.js";
import { catalogDirOf, jsonRequested } from "../commands.js";
import { ExitCode } from "../../errors.js";
import { printSections } from "../output.js";

function findingJson(finding: AuditFinding): Readonly<Record<string, unknown>> {
  return { detail: finding.detail, kind: finding.kind, message: finding.message };
}

function toJson(report: AuditReport): Readonly<Record<string, unknown>> {
  return {
    audited: {
      mcps: report.audited.mcps,
      scopes: report.audited.scopes,
      skills: report.audited.skills,
    },
    findings: report.findings.map(findingJson),
    tidy: isTidy(report),
  };
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

function findingLines(findings: readonly AuditFinding[]): readonly string[] {
  const body =
    findings.length === 0
      ? ["  (none)"]
      : findings.flatMap((finding) => [
          `  ${finding.message}`,
          ...finding.detail.map((line) => `      ${line}`),
        ]);

  return [`findings (${findings.length})`, ...body, ""];
}

function toText(report: AuditReport): readonly string[] {
  const { audited } = report;
  return [
    `audited ${count(audited.scopes, "scope")}, ${count(audited.skills, "skill")}, ${count(audited.mcps, "mcp")}`,
    "",
    ...findingLines(report.findings),
  ];
}

export const catalogAuditHandler: CommandHandler = async (ctx) => {
  const report = await auditCatalogDirectory(catalogDirOf(ctx));

  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(report), null, 2));
  else printSections(toText(report), ctx.stdout);

  if (ctx.options.check !== true || isTidy(report)) return ExitCode.Success;
  return ExitCode.Doctor;
};

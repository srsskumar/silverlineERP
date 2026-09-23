/**
 * Pure display/gating helpers behind the Reports screen (app/reports.tsx) —
 * kept dependency-free and separate from the screen file, same reasoning as
 * leadsFormat.ts/procurementFormat.ts (see their headers).
 *
 * The web /reports page is a type picker plus a recurring-schedule editor
 * that emails csv/xlsx/pdf exports. A phone has nowhere useful to put a
 * recurring schedule (mobile has no inbox-attachment flow, and the report
 * still lands in the same "Your reports" list either way), so mobile Reports
 * only generates one-off reports and shows past ones. It always asks for
 * pdf: that is the one binary content-type apps/mobile/src/api/client.ts
 * already unwraps to bytes for sharing (see src/ui/Payslip.tsx's payslip
 * download), so a generated report can be saved/shared with no change to
 * the shared fetch wrapper. A csv/xlsx report created elsewhere (e.g. a
 * desktop recurring schedule) still lists here with its status — it just
 * has no working Save button, which reportCanDownload below says plainly.
 */

export interface ReportTypeMetaLike {
  type: string;
  label: string;
  permission: string;
}

/** Report types the caller's permission list is actually allowed to generate. */
export function availableReportTypes(
  permissions: readonly string[] | null | undefined,
  meta: readonly ReportTypeMetaLike[],
): ReportTypeMetaLike[] {
  if (!Array.isArray(permissions)) return [];
  return meta.filter((m) => permissions.includes(m.permission));
}

export function reportStatusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" | "info" {
  if (status === "READY") return "success";
  if (status === "FAILED") return "danger";
  if (status === "PENDING") return "warning";
  return "neutral";
}

/** Mobile can only fetch and share a report it generated as pdf and that finished. */
export function reportCanDownload(report: { status: string; format: string }): boolean {
  return report.status === "READY" && report.format === "pdf";
}

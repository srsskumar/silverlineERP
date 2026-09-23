/**
 * Pure display helpers for the Payroll (runs) screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers).
 */

/** Mirrors PAYROLL_RUN_STATUSES (packages/shared/src/p1.ts). */
export function payrollRunStatusTone(
  status: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "LOCKED") return "success";
  if (status === "APPROVED" || status === "REVIEW") return "warning";
  if (status === "VALIDATING") return "info";
  if (status === "CALCULATED") return "info";
  return "neutral"; // OPEN
}

/** "2026-09-01" + "2026-09-30" -> "1–30 Sep 2026", for one line under the run number. */
export function payrollPeriodLabel(periodStart: string, periodEnd: string): string {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${periodStart} – ${periodEnd}`;
  }
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const sameMonth = start.getUTCFullYear() === end.getUTCFullYear()
    && start.getUTCMonth() === end.getUTCMonth();
  const endLabel = `${end.getUTCDate()} ${months[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  const startLabel = sameMonth
    ? String(start.getUTCDate())
    : `${start.getUTCDate()} ${months[start.getUTCMonth()]}`;
  return `${startLabel}–${endLabel}`;
}

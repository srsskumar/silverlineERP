/**
 * Pure display helpers for the Employee directory screen — dependency-free,
 * same reasoning as documentsFormat.ts/leadsFormat.ts (see their headers).
 *
 * PII stays exactly as the server sends it: the list and detail endpoints
 * already mask Aadhaar/PAN/bank account to their last four digits for anyone
 * without employee.pii.read (apps/api/src/modules/employees/routes.ts's
 * toShape()), and this client never tries to unmask or re-derive them.
 */

export function formatEmployeeName(e: {
  first_name?: string | null;
  last_name?: string | null;
}): string {
  return [e.first_name, e.last_name].filter((p) => p && p.trim()).join(" ").trim();
}

/** Mirrors packages/shared/src/s1.ts's EMPLOYEE_STATUSES. */
export function employeeStatusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "SUSPENDED") return "warning";
  if (status === "EXITED") return "danger";
  return "neutral"; // DRAFT
}

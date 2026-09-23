/**
 * Pure display helpers for the Expenses screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts, and split out of app/expenses.tsx so
 * they are importable from a plain node:test without pulling in React Native.
 */

/** Mirrors EXPENSE_CLAIM_STATUSES (packages/shared/src/expenses.ts). */
export function expenseStatusTone(
  status: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "APPROVED" || status === "REIMBURSED") return "success";
  if (status === "SUBMITTED") return "warning";
  if (status === "REJECTED" || status === "WITHDRAWN") return "danger";
  if (status === "DRAFT") return "info";
  return "neutral";
}

/** "SITE_MATERIALS_PETTY" -> "Site materials petty". */
export function categoryLabel(c: string): string {
  return c
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Which of a claim's own actions make sense given its current status, for
 * the person who raised it (expense.manage). Mirrors the transitions
 * apps/api's expense routes accept (EXPENSE_CLAIM_TRANSITIONS): a claim can
 * only be (re)submitted from DRAFT or REJECTED, and withdrawn from DRAFT or
 * SUBMITTED — never from a decided or already-withdrawn state.
 */
export function expenseClaimActions(status: string): { canSubmit: boolean; canWithdraw: boolean } {
  return {
    canSubmit: status === "DRAFT" || status === "REJECTED",
    canWithdraw: status === "DRAFT" || status === "SUBMITTED",
  };
}

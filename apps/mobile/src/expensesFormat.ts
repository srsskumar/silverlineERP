import { EXPENSE_CLAIM_STATUS_TONES, type Tone } from "@silverline/shared";

/**
 * Pure display helpers for the Expenses screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts, and split out of app/expenses.tsx so
 * they are importable from a plain node:test without pulling in React Native.
 */

/**
 * Mirrors EXPENSE_CLAIM_STATUSES (packages/shared/src/expenses.ts). Reads
 * the one shared tone map (R5-003/004) instead of a second copy that can
 * drift from web's.
 */
export function expenseStatusTone(status: string): Tone {
  return EXPENSE_CLAIM_STATUS_TONES[status as keyof typeof EXPENSE_CLAIM_STATUS_TONES] ?? "neutral";
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

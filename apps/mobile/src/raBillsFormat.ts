/**
 * Pure display helpers for the Project finance (RA bills) screen —
 * dependency-free, same reasoning as rbac.ts/validators.ts (see their
 * headers).
 */

/** Mirrors RA_BILL_STATUSES (packages/shared/src/ra-billing.ts). */
export function raBillStatusTone(
  status: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "CERTIFIED" || status === "PAID") return "success";
  if (status === "SUBMITTED") return "warning";
  if (status === "CANCELLED") return "danger";
  if (status === "DRAFT") return "info";
  return "neutral";
}

/**
 * A bill's headline figure. Once certified, the client may have accepted a
 * different amount than claimed (§ certifiableAmount permits certifying below
 * the claim) — the certified figure is what is actually owed from then on,
 * and the claimed net stands only before that.
 */
export function raBillAmount(bill: {
  certified_amount?: number | string | null;
  net_payable: number | string;
}): number {
  const certified = bill.certified_amount;
  return Number(certified !== null && certified !== undefined ? certified : bill.net_payable);
}

/**
 * Whether a bill is overdue as of today — certified/submitted but unpaid and
 * past its due date. Mirrors the same "not settled, past due" shape the
 * receivables ageing report applies server-side, without ageing buckets: a
 * single bill either has run past its date or it has not.
 */
export function raBillOverdue(
  bill: { status: string; due_date?: string | null },
  today: string,
): boolean {
  if (!bill.due_date) return false;
  if (bill.status !== "CERTIFIED") return false;
  return bill.due_date < today;
}

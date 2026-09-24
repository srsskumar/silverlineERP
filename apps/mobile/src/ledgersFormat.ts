import { PAYABLE_INVOICE_FLAG_TONES } from "@silverline/shared";

/**
 * Pure display helpers shared by Receivables and Payables — dependency-free,
 * same reasoning as rbac.ts/validators.ts (see their headers).
 *
 * Both screens read a single ageing summary (GET /api/v1/ar/ageing or
 * /api/v1/ap/ageing) that already carries its buckets, its overdue/disputed/
 * retention/on-hold splits and — for AR — a client, or — for AP — a vendor,
 * breakdown with the underlying bills/invoices embedded. Nothing here
 * recomputes the ageing; it only formats what the server already decided.
 */

export interface AgeingBucketsLike {
  NOT_DUE: number;
  D1_30: number;
  D31_60: number;
  D61_90: number;
  OVER_90: number;
}

/** Ordered, human labels for the bucket keys the server returns. */
export const AGEING_BUCKET_LABELS: Record<keyof AgeingBucketsLike, string> = {
  NOT_DUE: "Not yet due",
  D1_30: "1–30 days",
  D31_60: "31–60 days",
  D61_90: "61–90 days",
  OVER_90: "90+ days",
};

export const AGEING_BUCKET_ORDER: (keyof AgeingBucketsLike)[] = [
  "NOT_DUE", "D1_30", "D31_60", "D61_90", "OVER_90",
];

/** Colour a party's row by how much of its total is actually overdue. */
export function partyTone(
  totals: { overdue: number; total: number },
): "danger" | "warning" | "neutral" {
  if (totals.overdue <= 0) return "neutral";
  // Mostly overdue reads worse than a small slice of an otherwise current
  // account — the same distinction a collections call would make.
  if (totals.total > 0 && totals.overdue / totals.total >= 0.5) return "danger";
  return "warning";
}

/** The oldest non-empty bucket a party sits in, for a one-word "how late" badge. */
export function oldestBucket(buckets: AgeingBucketsLike): keyof AgeingBucketsLike | null {
  for (let i = AGEING_BUCKET_ORDER.length - 1; i >= 0; i -= 1) {
    const key = AGEING_BUCKET_ORDER[i];
    if (Number(buckets[key]) > 0.005) return key;
  }
  return null;
}

/**
 * Colour a payment run's own status badge (B-002). Mirrors PAYMENT_RUN_STATES
 * (packages/shared/src/ledgers.ts): DRAFT/APPROVED/PAID/CANCELLED.
 */
export function paymentRunTone(status: string): "success" | "warning" | "neutral" {
  if (status === "PAID" || status === "APPROVED") return "success";
  if (status === "CANCELLED") return "neutral";
  return "warning";
}

/**
 * Badge tone for a document's `on_hold`/`disputed` flag (R5-002, plus the
 * same divergence found on the receivables/RA-bill screens during the R5
 * mobile-parity sweep). Reads the one map web also reads
 * (`PAYABLE_INVOICE_FLAG_TONES`, packages/shared/src/financial-control.ts)
 * instead of a second copy that can drift from it -- despite the name it is
 * not payables-only: `disputed` means the same thing, coloured the same
 * warning, whichever side of the ledger it is on. Payables is the only side
 * with `on_hold`.
 */
export function payableFlagTone(flag: "on_hold" | "disputed"): "danger" | "warning" {
  return PAYABLE_INVOICE_FLAG_TONES[flag];
}

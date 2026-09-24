/**
 * Pure display/validation helpers behind the Expenses screen's receipts
 * section (B-003) — dependency-free, same reasoning as expensesFormat.ts's
 * header. The limits themselves (extension allow-list, byte cap, receipts
 * per claim) come straight from packages/shared/src/expenses.ts, so a client
 * pre-check here can never drift from what the API actually enforces; only
 * the "which claim states still take a receipt" rule is restated, mirroring
 * EXPENSE_CLAIM_TRANSITIONS' DRAFT/SUBMITTED editable window the same way
 * expensesFormat.ts's expenseClaimActions already restates it for submit.
 */
import {
  ALLOWED_RECEIPT_EXTENSIONS, MAX_RECEIPT_BYTES, MAX_RECEIPTS_PER_CLAIM,
} from "@silverline/shared";

export { ALLOWED_RECEIPT_EXTENSIONS, MAX_RECEIPT_BYTES, MAX_RECEIPTS_PER_CLAIM };

/** "taxi-bill.PNG" -> "png"; "no-extension" -> "". */
export function receiptExtension(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i === -1 || i === fileName.length - 1 ? "" : fileName.slice(i + 1).toLowerCase();
}

/** Whether a claim, in its current status, still takes new receipts (B-003). */
export function claimTakesReceipts(status: string): boolean {
  return status === "DRAFT" || status === "SUBMITTED";
}

export type ReceiptCheck = { ok: true } | { ok: false; reason: string };

/**
 * Client-side pre-check before spending a round trip on an upload that the
 * server would refuse anyway. Every reason here is one the API's own
 * expense-claims/:id/receipts route gives for the same input.
 */
export function checkReceiptFile(fileName: string, bytes: number): ReceiptCheck {
  const ext = receiptExtension(fileName);
  if (!ext || !(ALLOWED_RECEIPT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: `Only ${ALLOWED_RECEIPT_EXTENSIONS.join(", ")} files are allowed.` };
  }
  if (bytes > MAX_RECEIPT_BYTES) {
    return { ok: false, reason: "File exceeds the 10MB limit." };
  }
  return { ok: true };
}

/** Whether one more receipt may be added, given how many are on the claim already. */
export function canAddReceipt(status: string, existingCount: number): ReceiptCheck {
  if (!claimTakesReceipts(status)) {
    return { ok: false, reason: `A ${status.toLowerCase()} claim cannot take new receipts.` };
  }
  if (existingCount >= MAX_RECEIPTS_PER_CLAIM) {
    return { ok: false, reason: `A claim can carry at most ${MAX_RECEIPTS_PER_CLAIM} receipts.` };
  }
  return { ok: true };
}

/** 850 -> "850 B"; 12_400 -> "12.1 KB"; 3_400_000 -> "3.2 MB". */
export function formatReceiptSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** application/pdf shows a document icon; anything else here is an image. */
export function receiptIcon(mimeType: string | null | undefined): "document-text-outline" | "image-outline" {
  return mimeType === "application/pdf" ? "document-text-outline" : "image-outline";
}

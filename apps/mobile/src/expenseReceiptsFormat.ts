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
 * The three content types the API's receipt route actually stores
 * (RECEIPT_MIME_BY_EXT in apps/api/src/modules/expenses/routes.ts), keyed by
 * the same extensions ALLOWED_RECEIPT_EXTENSIONS allows.
 */
export const ALLOWED_RECEIPT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

const RECEIPT_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
};

/**
 * Client-side pre-check before spending a round trip on an upload that the
 * server would refuse anyway. Every reason here is one the API's own
 * expense-claims/:id/receipts route gives for the same input, except the
 * mime checks below (the server never sees a mime type — it only trusts the
 * extension and its own content sniff/virus scan — so these two extra
 * checks exist purely to catch, before an upload even starts, a gallery/file
 * picker result whose reported mime type contradicts what its name claims
 * to be, e.g. a renamed file).
 *
 * @param mimeType what the image/document picker reported (undefined/null
 *   when it didn't report one, e.g. the camera flow, which skips this check
 *   entirely).
 */
export function checkReceiptFile(fileName: string, bytes: number, mimeType?: string | null): ReceiptCheck {
  const ext = receiptExtension(fileName);
  if (!ext || !(ALLOWED_RECEIPT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: `Only ${ALLOWED_RECEIPT_EXTENSIONS.join(", ")} files are allowed.` };
  }
  if (bytes > MAX_RECEIPT_BYTES) {
    return { ok: false, reason: "File exceeds the 10MB limit." };
  }
  if (mimeType) {
    if (!(ALLOWED_RECEIPT_MIME_TYPES as readonly string[]).includes(mimeType)) {
      return { ok: false, reason: "This file type isn't supported. Attach a JPG, PNG or PDF." };
    }
    if (RECEIPT_MIME_BY_EXTENSION[ext] !== mimeType) {
      return { ok: false, reason: "This file's contents don't match its name. Try a different file." };
    }
  }
  return { ok: true };
}

/** Cap on a picker-supplied file name, well under the API's 255-char column. */
const MAX_FILE_NAME_LENGTH = 120;

/**
 * Turn whatever a gallery/file picker (or SAF content provider) hands back
 * into a name safe to send the API and show in the receipts list: the last
 * path segment only (some Android providers return a full on-device path),
 * control characters stripped, trimmed, and capped in length without
 * losing the extension.
 */
export function safeReceiptFileName(rawName: string): string {
  const base = rawName.split(/[/\\]/).pop() ?? rawName;
  // eslint-disable-next-line no-control-regex -- stripping ASCII control chars is the point
  const cleaned = base.replace(/[\x00-\x1F\x7F]/g, "").trim();
  const name = cleaned.length > 0 ? cleaned : "receipt";
  if (name.length <= MAX_FILE_NAME_LENGTH) return name;
  const ext = receiptExtension(name);
  const suffix = ext ? `.${ext}` : "";
  const stem = suffix ? name.slice(0, name.length - suffix.length) : name;
  const keep = Math.max(1, MAX_FILE_NAME_LENGTH - suffix.length);
  return `${stem.slice(0, keep)}${suffix}`;
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

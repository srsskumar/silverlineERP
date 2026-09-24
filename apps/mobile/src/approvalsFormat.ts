import { APPROVAL_STATUS_TONES, type Tone } from "@silverline/shared";

/**
 * Pure display helpers for the Approvals screen — kept dependency-free and
 * separate from the screen file so the wording rules are unit-testable
 * without React Native (mirrors how rbac.ts/validators.ts are split out).
 */

/** "EXPENSE_CLAIM" -> "Expense claim". Falls back to the same rule for any
 * future ApprovalDocumentType this client does not special-case. */
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  PURCHASE_REQUISITION: "Purchase requisition",
  PURCHASE_ORDER: "Purchase order",
  VENDOR_INVOICE: "Vendor invoice",
  EXPENSE_CLAIM: "Expense claim",
  PAYMENT: "Payment",
  RA_BILL: "RA bill",
  TENDER_SUBMISSION: "Tender submission",
  LEAVE_REQUEST: "Leave request",
  ADVANCE: "Advance",
  RETENTION_RELEASE: "Retention release",
};

export function formatDocumentType(code: string): string {
  const known = DOCUMENT_TYPE_LABELS[code];
  if (known) return known;
  return code
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Reads the one shared tone map (fix round 1, item 7) instead of a second
 * copy that can drift from web's -- this screen used to read SUPERSEDED as
 * danger where web reads it info, the same meaning that status carries for
 * every other document type on web.
 */
export function approvalStatusTone(status: string): Tone {
  return APPROVAL_STATUS_TONES[status as keyof typeof APPROVAL_STATUS_TONES] ?? "neutral";
}

/**
 * Client-side mirror of the server's approvalDecisionSchema
 * (packages/shared/src/approvals.ts): REJECT must carry a reason, APPROVE
 * need not. Checked here so a rejection with no comment fails on the phone
 * instead of round-tripping to learn the same thing.
 */
export function validateApprovalDecision(
  decision: "APPROVE" | "REJECT",
  comments: string,
): { ok: boolean; error: string | null } {
  if (decision === "REJECT" && comments.trim().length === 0) {
    return { ok: false, error: "Say why the request is being rejected." };
  }
  return { ok: true, error: null };
}

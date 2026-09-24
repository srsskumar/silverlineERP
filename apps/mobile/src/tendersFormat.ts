/**
 * Pure display helper for the Tenders screen — dependency-free, same
 * reasoning as documentsFormat.ts/leadsFormat.ts (see their headers).
 */

/** Mirrors the colouring apps/web/app/tenders/page.tsx's statusTone() applies. */
export function tenderStatusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" | "info" {
  if (status === "AWARDED") return "success";
  if (status === "REJECTED" || status === "CANCELLED") return "danger";
  if (status === "SUBMITTED" || status === "UNDER_EVALUATION") return "info";
  if (status === "SELECTED") return "warning";
  return "neutral";
}

/** Mirrors packages/shared/src/crm.ts's tenderBaseSchema.tender_type enum. */
export const TENDER_TYPES = ["OPEN", "LIMITED", "SINGLE", "EOI", "RFP"] as const;

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Task 5d: client-side mirror of tenderBaseSchema's two REQUIRED fields
 * (tender_no, tender_type). Every other field it accepts either has a
 * schema default (bid_type, cover_system, emd_exempt, jv_flag) or is
 * optional, and stays a desktop-only field on this screen (see
 * app/tenders.tsx's header comment).
 */
export function validateTenderCreate(input: {
  tender_no: string;
  tender_type: string;
}): { ok: boolean; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const tenderNo = input.tender_no.trim();
  if (!tenderNo) {
    errors.push({ field: "tender_no", message: "A tender number is required" });
  } else if (tenderNo.length > 50) {
    errors.push({ field: "tender_no", message: "Tender number must be 50 characters or fewer" });
  }
  if (!(TENDER_TYPES as readonly string[]).includes(input.tender_type)) {
    errors.push({ field: "tender_type", message: "Select a tender type" });
  }
  return { ok: errors.length === 0, errors };
}

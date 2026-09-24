import { PR_STATUS_TONES, PO_STATUS_TONES, type Tone } from "@silverline/shared";

/**
 * Pure display helpers for the Procurement screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers).
 */

/**
 * Mirrors PR_STATUSES (packages/shared/src/procurement.ts). Reads the one
 * shared tone map (mobile-parity sweep, R5 item 4) instead of a second copy
 * that can drift from web's -- this screen had CONVERTED and DRAFT wrong.
 */
export function requisitionStatusTone(status: string): Tone {
  return PR_STATUS_TONES[status as keyof typeof PR_STATUS_TONES] ?? "neutral";
}

/**
 * Mirrors PO_STATUSES (packages/shared/src/procurement.ts). Reads the one
 * shared tone map (mobile-parity sweep, R5 item 4) instead of a second copy
 * that can drift from web's -- this screen showed an APPROVED order as
 * still-pending amber instead of green, among other mismatches.
 */
export function poStatusTone(status: string): Tone {
  return PO_STATUS_TONES[status as keyof typeof PO_STATUS_TONES] ?? "neutral";
}

/**
 * Whether a requisition may be (re)submitted for approval. Mirrors
 * PR_TRANSITIONS: only DRAFT and REJECTED lead to SUBMITTED.
 */
export function requisitionCanSubmit(status: string): boolean {
  return status === "DRAFT" || status === "REJECTED";
}

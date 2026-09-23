/**
 * Pure display helpers for the Procurement screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers).
 */

/** Mirrors PR_STATUSES (packages/shared/src/procurement.ts). */
export function requisitionStatusTone(
  status: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "APPROVED" || status === "CONVERTED") return "success";
  if (status === "SUBMITTED") return "warning";
  if (status === "REJECTED" || status === "CANCELLED") return "danger";
  if (status === "DRAFT") return "info";
  return "neutral";
}

/** Mirrors PO_STATUSES (packages/shared/src/procurement.ts). */
export function poStatusTone(
  status: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "FULLY_RECEIVED" || status === "CLOSED") return "success";
  if (status === "PARTIALLY_RECEIVED" || status === "SENT" || status === "APPROVED") return "warning";
  if (status === "CANCELLED") return "danger";
  if (status === "DRAFT" || status === "PENDING_APPROVAL") return "info";
  return "neutral";
}

/**
 * Whether a requisition may be (re)submitted for approval. Mirrors
 * PR_TRANSITIONS: only DRAFT and REJECTED lead to SUBMITTED.
 */
export function requisitionCanSubmit(status: string): boolean {
  return status === "DRAFT" || status === "REJECTED";
}

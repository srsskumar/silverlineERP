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

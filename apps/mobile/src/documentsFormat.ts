/**
 * Pure display helper for the Documents screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers), and split out of
 * app/documents.tsx so it is importable from a plain node:test without
 * pulling in React Native.
 */
import { isDateString } from "./validators";

/** Mirrors the states apps/api's documentState() derives (packages/shared/src/documents.ts). */
export function documentStateTone(
  state: string,
): "success" | "warning" | "danger" | "neutral" {
  if (state === "VALID") return "success";
  if (state === "EXPIRING") return "warning";
  if (state === "EXPIRED") return "danger";
  return "neutral";
}

/**
 * B-009: client-side check before POST /api/v1/documents/:id/renew
 * (packages/shared/src/documents.ts's documentRenewSchema). The server only
 * requires expires_on for document types that expire; this form requires it
 * unconditionally, mirroring the web RenewDialog (its Save button is
 * disabled without one) rather than asking the type catalogue first.
 * issued_on, when given, must also be a real calendar date.
 */
export function validateDocumentRenew(input: {
  expires_on: string;
  issued_on?: string;
}): { ok: boolean; errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = [];
  if (!isDateString(input.expires_on)) {
    errors.push({ field: "expires_on", message: "Enter the new expiry date as YYYY-MM-DD" });
  }
  if (input.issued_on && !isDateString(input.issued_on)) {
    errors.push({ field: "issued_on", message: "Enter the issue date as YYYY-MM-DD" });
  }
  return { ok: errors.length === 0, errors };
}

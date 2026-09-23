/**
 * Pure display/validation helpers for the Attendance exceptions screen —
 * dependency-free, same reasoning as approvalsFormat.ts/documentsFormat.ts.
 *
 * IMPORTANT — the S2 contract has no `GET /attendance/exceptions` list (or
 * single-item) endpoint, confirmed against apps/api/src/modules/attendance/
 * routes.ts: only POST (create) and PATCH .../:id/decision exist. The web
 * client hits the same wall (see its own comment in
 * apps/web/app/attendance/exceptions/page.tsx and apps/web/lib/attendance.ts)
 * and works from "known ids" — ones surfaced by filing/regularizing an
 * exception, or by a 202 punch response's `exception_id` — rather than a
 * server-side queue. This mobile screen mirrors that same pattern instead of
 * inventing a queue the server cannot back. Tracked upstream as an S3
 * backend gap; see this round's report.
 */

/** Mirrors packages/shared/src/s2.ts's attendanceExceptionStatusSchema. */
export function exceptionStatusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "APPROVED") return "success";
  if (status === "PENDING") return "warning";
  if (status === "REJECTED") return "danger";
  return "neutral";
}

/** Mirrors packages/shared/src/s2.ts's attendanceExceptionTypeSchema (plus the
 * one legacy stored type, OUTSIDE_GEOFENCE, that old rows may still carry). */
const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  MISSED_PUNCH: "Missed punch",
  LATE_CHECKIN: "Late check-in",
  EARLY_CHECKOUT: "Early check-out",
  REGULARIZATION: "Regularization",
  SYSTEM_FLAG: "System flag",
  OUTSIDE_GEOFENCE: "Outside geofence (legacy)",
};

export function formatExceptionType(code: string): string {
  return EXCEPTION_TYPE_LABELS[code] ?? code;
}

/**
 * A pasted/typed record version. `If-Match` needs a positive integer; a
 * blank or non-numeric guess is worth catching before the round trip.
 */
export function parseVersionInput(v: string): number | null {
  const trimmed = v.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** An exception id is a UUID; catches an obvious paste error before it is tracked. */
export function isTrackableExceptionId(v: string): boolean {
  return UUID_RE.test(v.trim());
}

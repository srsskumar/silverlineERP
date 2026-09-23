/**
 * Pure display helpers behind the Projects screen (app/projects.tsx) — kept
 * dependency-free and separate from the screen file, same reasoning as
 * leadsFormat.ts/procurementFormat.ts (see their headers).
 *
 * Status tone mirrors apps/web/lib/projects.ts's projectStatusBadgeTone
 * exactly, so a project reads the same colour on the phone as it does on
 * the web project list.
 */

const PROJECT_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  DRAFT: "neutral",
  ACTIVE: "info",
  ON_HOLD: "warning",
  COMPLETED_PENDING_CLOSE: "warning",
  CLOSED: "success",
  CANCELLED: "danger",
};

export function projectStatusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" | "info" {
  return PROJECT_STATUS_TONE[status] ?? "neutral";
}

/** Closed/cancelled projects accept no further transitions (mirrors the web). */
export function isTerminalProjectStatus(status: string): boolean {
  return status === "CLOSED" || status === "CANCELLED";
}

/** "GOVERNMENT" | "PRIVATE" -> the label the web project list/detail use. */
export function formatProjectKind(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return kind === "GOVERNMENT" ? "Government" : "Private";
}

/**
 * Pure display helpers for the Analytics screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers).
 */

export function delayRiskTone(risk: string | null | undefined): "danger" | "success" | "neutral" {
  if (risk === "HIGH") return "danger";
  if (risk === "LOW") return "success";
  return "neutral";
}

/** "72%", or "unavailable" for null — matches the web page's own wording. */
export function formatConfidence(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined) return "unavailable";
  return `${Math.round(confidence * 100)}%`;
}

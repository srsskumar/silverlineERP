/**
 * Pure display helper for the Documents screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers), and split out of
 * app/documents.tsx so it is importable from a plain node:test without
 * pulling in React Native.
 */

/** Mirrors the states apps/api's documentState() derives (packages/shared/src/documents.ts). */
export function documentStateTone(
  state: string,
): "success" | "warning" | "danger" | "neutral" {
  if (state === "VALID") return "success";
  if (state === "EXPIRING") return "warning";
  if (state === "EXPIRED") return "danger";
  return "neutral";
}

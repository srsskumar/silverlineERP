/**
 * Pure display helpers for the Asset movements screen — dependency-free,
 * same reasoning as rbac.ts/validators.ts (see their headers).
 *
 * Mirrors packages/shared/src/assets.ts's ASSET_CONDITIONS literally rather
 * than importing it (Metro workspace linking is deferred for these files —
 * see rbac.ts's header); update both if the backend vocabulary changes.
 */

export type AssetMovementKind = "ISSUED" | "RETURNED";

const CONDITION_LABELS: Record<string, string> = {
  BRAND_NEW: "Brand new",
  EXCELLENT: "Excellent",
  GOOD: "Good",
  REPAIR: "Needs repair",
  UNUSABLE: "Unusable",
};

/** "Went out" / "Came back" — the words the web page uses for the same event. */
export function movementLabel(movement: string): string {
  return movement === "ISSUED" ? "Went out" : "Came back";
}

export function movementTone(movement: string): "warning" | "success" {
  return movement === "ISSUED" ? "warning" : "success";
}

/** A condition code as words, including one the register held before (unknown → title-cased). */
export function conditionLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const known = CONDITION_LABELS[code];
  if (known) return known;
  return code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");
}

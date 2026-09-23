/**
 * Pure display helpers for the Inventory screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers).
 */

/**
 * Whether an item's on-hand quantity has crossed its low-stock threshold.
 * Mirrors the server's own `lowStockLevel`/`available<=lowStockLevel(item)`
 * check in apps/api/src/common/stockLedger.ts closely enough for a client
 * badge — the server is still the one that refuses an OUT that would go
 * negative, this is display only.
 */
export function isLowStock(available: number | string, threshold: number | string): boolean {
  const a = Number(available);
  const th = Number(threshold);
  if (!Number.isFinite(a) || !Number.isFinite(th) || th <= 0) return false;
  return a <= th;
}

export function stockTone(
  available: number | string,
  threshold: number | string,
): "success" | "warning" | "danger" | "neutral" {
  const a = Number(available);
  if (!Number.isFinite(a) || a <= 0) return "danger";
  if (isLowStock(available, threshold)) return "warning";
  return "success";
}

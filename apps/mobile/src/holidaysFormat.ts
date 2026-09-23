/**
 * Pure display helpers for the Holidays screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers).
 */

export interface HolidayScopeLike {
  scope_type?: string | null;
  scope_id?: string | null;
  scope_name?: string | null;
}

/**
 * "Org-wide", or the scoped unit's name — falling back to a truncated id
 * when the server could not resolve a name (a unit later deleted). Mirrors
 * the web page's own fallback (apps/web/app/org/holidays/page.tsx).
 */
export function holidayScopeLabel(holiday: HolidayScopeLike): string {
  if (!holiday.scope_type) return "Org-wide";
  if (holiday.scope_name) return `${holiday.scope_name} (${holiday.scope_type})`;
  const id = holiday.scope_id ?? "";
  return `${holiday.scope_type} ${id.slice(0, 8)}…`;
}

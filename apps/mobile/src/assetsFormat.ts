/**
 * Pure helpers for the Assets tab (app/(tabs)/assets.tsx), importable from
 * node:test without React Native.
 */
import { ASSET_CONDITIONS } from "@silverline/shared";

/** A row of GET /api/v1/assets/eligible-employees, exactly as the API sends it. */
export interface EligibleEmployee {
  id: string;
  emp_no: string;
  first_name: string | null;
  last_name: string | null;
}

/**
 * MA-001: the list row carries first_name/last_name/emp_no and no `name`;
 * the screen read `e.name.toLowerCase()`, which threw the moment an asset
 * manager opened an AVAILABLE or RETURNED asset.
 */
export function eligibleEmployeeLabel(e: EligibleEmployee): string {
  const name = [e.first_name, e.last_name].filter((p) => p && p.trim()).join(" ").trim();
  return name ? `${name} · ${e.emp_no}` : e.emp_no;
}

export function filterEligibleEmployees(
  list: readonly EligibleEmployee[],
  query: string,
  max = 10,
): EligibleEmployee[] {
  const q = query.trim().toLowerCase();
  return list.filter((e) => !q || eligibleEmployeeLabel(e).toLowerCase().includes(q)).slice(0, max);
}

/**
 * MA-002: the conditions a receiver picks from, same list as web's
 * dropdown (packages/shared ASSET_CONDITIONS). OTHER is left out: the API
 * requires a condition_note with it, and this screen has no note field.
 */
export const ASSIGNABLE_CONDITIONS = ASSET_CONDITIONS.filter((c) => c.code !== "OTHER");

/** Null when the code is one the picker offers, else the message to show. */
export function validateAssetCondition(code: string): string | null {
  return ASSIGNABLE_CONDITIONS.some((c) => c.code === code)
    ? null
    : "Pick the condition it is in from the list";
}

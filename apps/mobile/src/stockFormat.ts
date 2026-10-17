/**
 * Pure helpers behind the Inventory screen's Stock tabs (B-008 —
 * stock-locations/stock-counts/stock-reservations/stock/reorder, previously
 * API-only with no mobile UI).
 *
 * Dependency-free, same reasoning as inventoryFormat.ts/validators.ts: no
 * zod, no @silverline/shared import at runtime, so Metro never needs the
 * schemas these mirror (packages/shared/src/inventory.ts). test/stock.test.ts
 * checks this file's shapes directly against those schemas, the same way
 * apps/web/tests/stock-forms.test.ts checks web's equivalent
 * (apps/web/lib/stock-forms.ts).
 */

/** Mirrors shared LOCATION_KINDS. */
export const LOCATION_KINDS = ["WAREHOUSE", "SITE", "SUB_LOCATION"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export function reservationStateTone(
  state: string,
): "success" | "warning" | "danger" | "neutral" {
  if (state === "ACTIVE") return "warning";
  if (state === "CONSUMED") return "success";
  if (state === "EXPIRED") return "danger";
  return "neutral";
}

export function countStatusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "APPROVED") return "success";
  if (status === "COUNTED") return "warning";
  return "neutral";
}

/** "+3"/"-2"/"0" — matches web's StockCountVariance rendering (components/v2/StockSection.tsx). */
export function formatVariance(variance: number | string): string {
  const n = Number(variance);
  if (!Number.isFinite(n)) return String(variance);
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Which of Inventory's five tabs the caller can even open.
 *
 * Stock (the pre-existing single-location register) and the four B-008 tabs
 * each gate on their OWN route permission, not a shared `inventory.*` pair —
 * the two permission sets are disjoint (apps/web/components/v2/StockSection.tsx's
 * header comment: a role can hold `stock.read` without `location.read`). A
 * tab with no permission is left out of the list entirely rather than shown
 * disabled, so a role missing every one of the five sees no tabs at all
 * (the screen then renders its own "no access" state) instead of five
 * buttons that all refuse.
 */
export const INVENTORY_TABS = ["items", "locations", "counts", "reservations", "reorder"] as const;
export type InventoryTab = (typeof INVENTORY_TABS)[number];

export const INVENTORY_TAB_LABELS: Record<InventoryTab, string> = {
  items: "Items",
  locations: "Locations",
  counts: "Counts",
  reservations: "Reservations",
  reorder: "Reorder",
};

export interface InventoryTabPermissions {
  inventoryRead: boolean;
  locationRead: boolean;
  locationManage: boolean;
  stockcountRead: boolean;
  stockcountManage: boolean;
  reservationRead: boolean;
  stockRead: boolean;
}

/**
 * The five tab chips, filtered to the ones the caller can actually open.
 *
 * A tab with no permission is left out of the array entirely rather than
 * returned alongside a "disabled" flag — the screen renders exactly this
 * list of chips, so a role missing one of the five never sees a chip for it
 * at all, let alone a greyed-out one that opens to a refusal.
 */
export function visibleInventoryTabs(perm: InventoryTabPermissions): InventoryTab[] {
  const tabs: InventoryTab[] = [];
  if (perm.inventoryRead) tabs.push("items");
  // Viewing the list needs location.read; creating one needs location.manage
  // — same either-alone reasoning as counts below, and the same shape web's
  // StockSection.tsx gates (<Can permission="location.read">/<Can
  // permission="location.manage"> around independent panels).
  if (perm.locationRead || perm.locationManage) tabs.push("locations");
  // Viewing the list needs stockcount.read; recording a count needs
  // stockcount.manage. Either alone still makes the tab worth opening.
  if (perm.stockcountRead || perm.stockcountManage) tabs.push("counts");
  if (perm.reservationRead) tabs.push("reservations");
  if (perm.stockRead) tabs.push("reorder");
  return tabs;
}

/**
 * Folds the single item/quantity/batch/remarks line this screen collects
 * into the `lines` array the API's stockCountSchema requires — mirrors
 * web's stockCountBody (apps/web/lib/stock-forms.ts) exactly, so the request
 * body each platform posts for the same screen has the same shape. A count
 * is still one item per count here too: the generic form framework web
 * built this against has no repeater field, and mobile has no reason to go
 * further than the screen it mirrors.
 */
export function buildStockCountBody(input: {
  count_no: string;
  location_id: string;
  counted_on: string;
  item_id: string;
  counted_quantity: number | string;
  batch_no?: string;
  remarks?: string;
  notes?: string;
}): {
  count_no: string;
  location_id: string;
  counted_on: string;
  notes?: string;
  lines: Array<{ item_id: string; counted_quantity: number; batch_no?: string; remarks?: string }>;
} {
  const { item_id, counted_quantity, batch_no, remarks, ...rest } = input;
  return {
    ...rest,
    lines: [
      {
        item_id,
        counted_quantity: Number(counted_quantity),
        ...(batch_no !== undefined ? { batch_no } : {}),
        ...(remarks !== undefined ? { remarks } : {}),
      },
    ],
  };
}

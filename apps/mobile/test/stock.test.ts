/// <reference types="node" />
/**
 * Pure logic behind the Inventory screen's Stock tabs (B-008 —
 * stock-locations/stock-counts/stock-reservations/stock/reorder). The
 * request-building helper (buildStockCountBody) and the location-kind list
 * are checked directly against the API's own zod schemas
 * (packages/shared/src/inventory.ts) — not just that a field exists per key,
 * but that the exact bodies this screen builds actually parse — the same
 * way apps/web/tests/stock-forms.test.ts checks web's equivalent
 * (apps/web/lib/stock-forms.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stockLocationSchema, stockCountSchema, LOCATION_KINDS as SHARED_LOCATION_KINDS } from "@silverline/shared";
import {
  LOCATION_KINDS,
  buildStockCountBody,
  countStatusTone,
  formatVariance,
  reservationStateTone,
  visibleInventoryTabs,
  type InventoryTabPermissions,
} from "../src/stockFormat";
import { validateStockCountCreate, validateStockLocationCreate } from "../src/validators";

const LOCATION_ID = "22222222-2222-2222-2222-222222222222";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";
const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

describe("LOCATION_KINDS", () => {
  it("matches the kinds the API's stock location schema accepts", () => {
    assert.deepEqual([...LOCATION_KINDS].sort(), [...SHARED_LOCATION_KINDS].sort());
  });
});

describe("buildStockCountBody", () => {
  const flat = {
    count_no: "SC1",
    location_id: LOCATION_ID,
    counted_on: "2026-09-24",
    item_id: ITEM_ID,
    counted_quantity: "42",
  };

  it("folds the single line this screen collects into the lines array the API requires", () => {
    const body = buildStockCountBody(flat);
    const parsed = stockCountSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
    assert.deepEqual(body.lines, [{ item_id: ITEM_ID, counted_quantity: 42 }]);
  });

  it("keeps an optional batch number and remark when given, and coerces the quantity to a number", () => {
    const body = buildStockCountBody({ ...flat, counted_quantity: "5", batch_no: "B1", remarks: "Shelf 4" });
    assert.equal(stockCountSchema.safeParse(body).success, true);
    assert.deepEqual(body.lines, [{ item_id: ITEM_ID, counted_quantity: 5, batch_no: "B1", remarks: "Shelf 4" }]);
  });

  it("allows a counted quantity of zero -- the schema's own min(0), not a positive-only check", () => {
    const body = buildStockCountBody({ ...flat, counted_quantity: "0" });
    assert.equal(stockCountSchema.safeParse(body).success, true);
    assert.deepEqual(body.lines, [{ item_id: ITEM_ID, counted_quantity: 0 }]);
  });
});

describe("validateStockLocationCreate", () => {
  const base = { code: "WH1", name: "Central store", kind: "WAREHOUSE" };

  it("accepts a well-formed warehouse, and the API's own schema agrees", () => {
    assert.equal(validateStockLocationCreate(base).ok, true);
    assert.equal(stockLocationSchema.safeParse(base).success, true);
  });

  it("requires code, name and kind", () => {
    assert.equal(validateStockLocationCreate({ ...base, code: "" }).ok, false);
    assert.equal(validateStockLocationCreate({ ...base, name: "" }).ok, false);
    assert.equal(validateStockLocationCreate({ ...base, kind: "" }).ok, false);
  });

  it("rejects a code or name over the schema's own length limit", () => {
    assert.equal(validateStockLocationCreate({ ...base, code: "x".repeat(31) }).ok, false);
    assert.equal(validateStockLocationCreate({ ...base, name: "x".repeat(151) }).ok, false);
  });

  it("requires a project for a site, matching the schema's superRefine", () => {
    assert.equal(validateStockLocationCreate({ ...base, kind: "SITE" }).ok, false);
    assert.equal(stockLocationSchema.safeParse({ ...base, kind: "SITE" }).success, false);

    assert.equal(validateStockLocationCreate({ ...base, kind: "SITE", project_id: PROJECT_ID }).ok, true);
    assert.equal(stockLocationSchema.safeParse({ ...base, kind: "SITE", project_id: PROJECT_ID }).success, true);
  });

  it("requires a parent for a sub-location, matching the schema's superRefine", () => {
    assert.equal(validateStockLocationCreate({ ...base, kind: "SUB_LOCATION" }).ok, false);
    assert.equal(stockLocationSchema.safeParse({ ...base, kind: "SUB_LOCATION" }).success, false);

    assert.equal(validateStockLocationCreate({ ...base, kind: "SUB_LOCATION", parent_id: LOCATION_ID }).ok, true);
    assert.equal(stockLocationSchema.safeParse({ ...base, kind: "SUB_LOCATION", parent_id: LOCATION_ID }).success, true);
  });
});

describe("validateStockCountCreate", () => {
  const base = {
    count_no: "SC1",
    location_id: LOCATION_ID,
    counted_on: "2026-09-24",
    item_id: ITEM_ID,
    counted_quantity: 42,
  };

  it("accepts a well-formed single-line count", () => {
    assert.equal(validateStockCountCreate(base).ok, true);
  });

  it("rejects a non-UUID location or item", () => {
    assert.equal(validateStockCountCreate({ ...base, location_id: "nope" }).ok, false);
    assert.equal(validateStockCountCreate({ ...base, item_id: "nope" }).ok, false);
  });

  it("rejects a malformed date", () => {
    assert.equal(validateStockCountCreate({ ...base, counted_on: "24-09-2026" }).ok, false);
  });

  it("rejects a missing or over-length count number", () => {
    assert.equal(validateStockCountCreate({ ...base, count_no: "" }).ok, false);
    assert.equal(validateStockCountCreate({ ...base, count_no: "x".repeat(51) }).ok, false);
  });

  it("allows a counted quantity of zero but not a negative one", () => {
    assert.equal(validateStockCountCreate({ ...base, counted_quantity: 0 }).ok, true);
    assert.equal(validateStockCountCreate({ ...base, counted_quantity: -1 }).ok, false);
    assert.equal(validateStockCountCreate({ ...base, counted_quantity: "not-a-number" }).ok, false);
  });
});

describe("reservationStateTone", () => {
  it("reads a sensible tone for each state", () => {
    assert.equal(reservationStateTone("ACTIVE"), "warning");
    assert.equal(reservationStateTone("CONSUMED"), "success");
    assert.equal(reservationStateTone("EXPIRED"), "danger");
    assert.equal(reservationStateTone("RELEASED"), "neutral");
  });
});

describe("countStatusTone", () => {
  it("reads a sensible tone for each status", () => {
    assert.equal(countStatusTone("APPROVED"), "success");
    assert.equal(countStatusTone("COUNTED"), "warning");
    assert.equal(countStatusTone("DRAFT"), "neutral");
  });
});

describe("formatVariance", () => {
  it("signs a positive variance, leaves zero and negative alone", () => {
    assert.equal(formatVariance(3), "+3");
    assert.equal(formatVariance("3"), "+3");
    assert.equal(formatVariance(0), "0");
    assert.equal(formatVariance(-2), "-2");
  });
});

/**
 * visibleInventoryTabs: which of Inventory's five tab chips a caller sees.
 * This is the gate that decides whether a tab chip renders at all (B-008's
 * own bug class per the QA history -- A-008/B-022/B-024 were all a wrong
 * permission check that silently showed or hid the wrong thing), so every
 * tab gets both a present and an absent case, not just one happy path.
 */
describe("visibleInventoryTabs", () => {
  const NONE: InventoryTabPermissions = {
    inventoryRead: false,
    locationRead: false,
    locationManage: false,
    stockcountRead: false,
    stockcountManage: false,
    reservationRead: false,
    stockRead: false,
  };

  it("shows no tabs at all when every permission is absent", () => {
    assert.deepEqual(visibleInventoryTabs(NONE), []);
  });

  it("shows Items only when inventory.read is held", () => {
    assert.deepEqual(visibleInventoryTabs({ ...NONE, inventoryRead: true }), ["items"]);
    assert.deepEqual(visibleInventoryTabs(NONE), []);
  });

  it("shows Locations on location.read alone", () => {
    assert.deepEqual(visibleInventoryTabs({ ...NONE, locationRead: true }), ["locations"]);
  });

  it("shows Locations on location.manage alone too -- a manage-only role still gets the tab", () => {
    assert.deepEqual(visibleInventoryTabs({ ...NONE, locationManage: true }), ["locations"]);
  });

  it("shows Counts on stockcount.read alone", () => {
    assert.deepEqual(visibleInventoryTabs({ ...NONE, stockcountRead: true }), ["counts"]);
  });

  it("shows Counts on stockcount.manage alone too", () => {
    assert.deepEqual(visibleInventoryTabs({ ...NONE, stockcountManage: true }), ["counts"]);
  });

  it("shows Reservations only when reservation.read is held", () => {
    assert.deepEqual(visibleInventoryTabs({ ...NONE, reservationRead: true }), ["reservations"]);
    assert.deepEqual(visibleInventoryTabs(NONE), []);
  });

  it("shows Reorder only when stock.read is held", () => {
    assert.deepEqual(visibleInventoryTabs({ ...NONE, stockRead: true }), ["reorder"]);
    assert.deepEqual(visibleInventoryTabs(NONE), []);
  });

  it("orders visible tabs Items, Locations, Counts, Reservations, Reorder regardless of which are missing", () => {
    const all: InventoryTabPermissions = {
      inventoryRead: true,
      locationRead: true,
      locationManage: false,
      stockcountRead: true,
      stockcountManage: false,
      reservationRead: true,
      stockRead: true,
    };
    assert.deepEqual(visibleInventoryTabs(all), ["items", "locations", "counts", "reservations", "reorder"]);
    assert.deepEqual(visibleInventoryTabs({ ...all, inventoryRead: false, reservationRead: false }), [
      "locations",
      "counts",
      "reorder",
    ]);
  });
});

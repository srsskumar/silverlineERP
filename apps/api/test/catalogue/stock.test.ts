/**
 * End-to-end cover for inventory and material control (§44).
 *
 * Stock questions are only answerable against a real ledger: on-hand is summed
 * from every transaction, availability subtracts live reservations, and a
 * count adjustment has to land as its own auditable transaction.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;

async function send(method: "POST" | "GET" | "PATCH", headers: Headers, url: string, payload?: unknown) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

async function ver(table: string, id: string): Promise<Headers> {
  const r = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  return { "if-match": String(r.rows[0].version) };
}

let store: string;
let site: string;

async function makeItem(over: Record<string, unknown> = {}) {
  const r = await w.pool.query(
    `INSERT INTO inventory_items(org_id, code, name, unit, alt_uom, conversion_factor,
       batch_tracked, serial_tracked, reorder_level)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [w.orgId, uniq("IT"), `Item ${uniq()}`, over.unit ?? "KG",
     over.alt_uom ?? null, over.conversion_factor ?? null,
     over.batch_tracked ?? false, over.serial_tracked ?? false, over.reorder_level ?? null]);
  return r.rows[0];
}

/** Put stock into a location so the test has something to move. */
async function receive(itemId: string, quantity: number, locationId = store, over: Record<string, unknown> = {}) {
  const res = await post(w.admin, "/api/v1/stock-transactions", {
    transaction_type: "PURCHASE_RECEIPT", item_id: itemId, quantity,
    to_location_id: locationId, reference: uniq("GRN"), ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data;
}

async function positionOf(itemId: string, locationId = store) {
  const res = await get(w.admin, `/api/v1/stock-locations/${locationId}/stock`);
  return res.data.find((r: any) => r.item_id === itemId);
}

beforeAll(async () => {
  w = await buildWorld();
  const warehouse = await post(w.admin, "/api/v1/stock-locations", {
    code: uniq("WH"), name: "Central store", kind: "WAREHOUSE",
  });
  expect(warehouse.status, JSON.stringify(warehouse.body)).toBe(201);
  store = warehouse.data.id;

  const siteLocation = await post(w.admin, "/api/v1/stock-locations", {
    code: uniq("ST"), name: "Site store", kind: "SITE", project_id: w.activeProject,
  });
  expect(siteLocation.status, JSON.stringify(siteLocation.body)).toBe(201);
  site = siteLocation.data.id;
}, 180_000);

afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("locations", () => {
  it("insists a site location names the project it belongs to", async () => {
    // Otherwise material cost cannot roll up into that project, which is the
    // only reason to have a site location.
    const res = await post(w.admin, "/api/v1/stock-locations", {
      code: uniq("ST"), name: "Orphan site", kind: "SITE",
    });
    expect(res.status).toBe(422);
  });

  it("refuses a location placed inside its own descendant", async () => {
    const parent = await post(w.admin, "/api/v1/stock-locations", {
      code: uniq("WH"), name: "Parent", kind: "WAREHOUSE",
    });
    const child = await post(w.admin, "/api/v1/stock-locations", {
      code: uniq("SL"), name: "Child", kind: "SUB_LOCATION", parent_id: parent.data.id,
    });
    expect(child.status, JSON.stringify(child.body)).toBe(201);

    const res = await patch(
      { ...w.admin, ...(await ver("stock_locations", parent.data.id)) },
      `/api/v1/stock-locations/${parent.data.id}`, { parent_id: child.data.id });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("LOCATION_CYCLE");
  });
});

describe("stock movement", () => {
  it("holds stock per location, not as an organisation-wide total", async () => {
    // The old ledger's total was true of nowhere: it could not answer whether
    // this site had fifty bags.
    const item = await makeItem();
    await receive(item.id, 100, store);
    await receive(item.id, 40, site);

    expect((await positionOf(item.id, store)).onHand).toBe(100);
    expect((await positionOf(item.id, site)).onHand).toBe(40);
  });

  it("moves stock between locations in one transaction", async () => {
    // Recorded as a separate issue and receipt, the second half gets forgotten
    // and stock evaporates in transit.
    const item = await makeItem();
    await receive(item.id, 100, store);
    const res = await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "TRANSFER", item_id: item.id, quantity: 30,
      from_location_id: store, to_location_id: site, reference: uniq("TR"),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect((await positionOf(item.id, store)).onHand).toBe(70);
    expect((await positionOf(item.id, site)).onHand).toBe(30);
  });

  it("converts an alternate unit into the base unit", async () => {
    // Fifty bags plus fifty kilograms is a hundred of nothing.
    const item = await makeItem({ unit: "KG", alt_uom: "BAG", conversion_factor: 50 });
    const res = await receive(item.id, 10, store, { uom: "BAG" });
    expect(Number(res.base_quantity)).toBe(500);
    expect(Number(res.entered_quantity)).toBe(10);
    expect(res.entered_uom).toBe("BAG");
    expect((await positionOf(item.id, store)).onHand).toBe(500);
  });

  it("refuses a unit the item is not measured in", async () => {
    const item = await makeItem({ unit: "KG" });
    const res = await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "PURCHASE_RECEIPT", item_id: item.id, quantity: 5,
      uom: "TONNE", to_location_id: store, reference: uniq("GRN"),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("UNKNOWN_UOM");
  });

  it("refuses an issue the location cannot cover", async () => {
    const item = await makeItem();
    await receive(item.id, 10, store);
    const res = await post(w.role.PROJECT_MANAGER, "/api/v1/stock-transactions", {
      transaction_type: "ISSUE", item_id: item.id, quantity: 25,
      from_location_id: store, reference: uniq("IS"),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK");
  });

  it("demands a batch for a batch-tracked item", async () => {
    const item = await makeItem({ batch_tracked: true });
    const res = await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "PURCHASE_RECEIPT", item_id: item.id, quantity: 5,
      to_location_id: store, reference: uniq("GRN"),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BATCH_REQUIRED");
  });

  it("demands a reason for damage but not for a receipt", async () => {
    const item = await makeItem();
    await receive(item.id, 50, store);
    const blind = await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "DAMAGE_LOSS", item_id: item.id, quantity: 5,
      from_location_id: store, reference: uniq("DM"),
    });
    expect(blind.status).toBe(422);
    const res = await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "DAMAGE_LOSS", item_id: item.id, quantity: 5,
      from_location_id: store, reference: uniq("DM"), reason: "Bags split in the rain",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("keeps consumption and damage apart in the ledger", async () => {
    // Both reduce stock; one is the job doing its work and one is a loss, and
    // a cost report that cannot tell them apart is worthless.
    const item = await makeItem();
    await receive(item.id, 100, store);
    await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "CONSUMPTION", item_id: item.id, quantity: 20,
      from_location_id: store, reference: uniq("CN"),
    });
    await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "DAMAGE_LOSS", item_id: item.id, quantity: 5,
      from_location_id: store, reference: uniq("DM"), reason: "Dropped",
    });
    const ledger = await get(w.admin, `/api/v1/stock-transactions?item_id=${item.id}&limit=50`);
    const types = ledger.data.map((t: any) => t.transaction_type);
    expect(types).toContain("CONSUMPTION");
    expect(types).toContain("DAMAGE_LOSS");
    expect((await positionOf(item.id, store)).onHand).toBe(75);
  });
});

describe("reservations", () => {
  it("holds stock without removing it", async () => {
    // The bags are still in the store; they are promised to somebody.
    const item = await makeItem();
    await receive(item.id, 100, store);
    const res = await post(w.role.PROJECT_MANAGER, "/api/v1/stock-reservations", {
      item_id: item.id, location_id: store, quantity: 40, project_id: w.activeProject,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const position = await positionOf(item.id, store);
    expect(position.onHand).toBe(100);
    expect(position.reserved).toBe(40);
    expect(position.available).toBe(60);
  });

  it("refuses an issue that would eat into somebody else's reservation", async () => {
    const item = await makeItem();
    await receive(item.id, 100, store);
    await post(w.role.PROJECT_MANAGER, "/api/v1/stock-reservations", {
      item_id: item.id, location_id: store, quantity: 80, project_id: w.activeProject,
    });
    const res = await post(w.role.PROJECT_MANAGER, "/api/v1/stock-transactions", {
      transaction_type: "ISSUE", item_id: item.id, quantity: 50,
      from_location_id: store, reference: uniq("IS"),
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain("reserved");
  });

  it("will not reserve stock that is not free", async () => {
    const item = await makeItem();
    await receive(item.id, 50, store);
    await post(w.role.PROJECT_MANAGER, "/api/v1/stock-reservations", {
      item_id: item.id, location_id: store, quantity: 40,
    });
    const res = await post(w.role.PROJECT_MANAGER, "/api/v1/stock-reservations", {
      item_id: item.id, location_id: store, quantity: 20,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK");
  });

  it("stops holding stock once the reservation expires", async () => {
    // A reservation nobody released would otherwise hold material for a
    // project that finished last year.
    const item = await makeItem();
    await receive(item.id, 100, store);
    await w.pool.query(
      `INSERT INTO stock_reservations(org_id, item_id, location_id, quantity, expires_on, created_by)
       VALUES($1,$2,$3,$4,'2020-01-01',$5)`,
      [w.orgId, item.id, store, 40, w.adminId]);
    expect((await positionOf(item.id, store)).available).toBe(100);
  });

  it("frees the stock when a reservation is released", async () => {
    const item = await makeItem();
    await receive(item.id, 100, store);
    const reservation = await post(w.role.PROJECT_MANAGER, "/api/v1/stock-reservations", {
      item_id: item.id, location_id: store, quantity: 40,
    });
    const released = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("stock_reservations", reservation.data.id)) },
      `/api/v1/stock-reservations/${reservation.data.id}/release`, {});
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect((await positionOf(item.id, store)).available).toBe(100);
  });
});

describe("stock counts", () => {
  async function countWith(itemId: string, counted: number) {
    const res = await post(w.role.INVENTORY_MANAGER, "/api/v1/stock-counts", {
      count_no: uniq("SC"), location_id: store, counted_on: "2026-09-15",
      lines: [{ item_id: itemId, counted_quantity: counted }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.data;
  }

  it("freezes what the ledger said at the moment of counting", async () => {
    const item = await makeItem();
    await receive(item.id, 100, store);
    const count = await countWith(item.id, 92);

    // More stock arrives after the aisles were walked; the count must still
    // compare against what the ledger said when it was taken.
    await receive(item.id, 25, store);

    const detail = await get(w.admin, `/api/v1/stock-counts/${count.id}`);
    expect(Number(detail.data.lines[0].system_quantity)).toBe(100);
    expect(Number(detail.data.lines[0].variance)).toBe(-8);
  });

  it("will not let the person who counted approve their own variance", async () => {
    // Otherwise a physical count is a way to write material off single-handed.
    const item = await makeItem();
    await receive(item.id, 50, store);
    const count = await countWith(item.id, 45);
    const res = await post(
      { ...w.role.INVENTORY_MANAGER, ...(await ver("stock_counts", count.id)) },
      `/api/v1/stock-counts/${count.id}/approval`,
      { action: "APPROVE", reason: "Counted twice" });
    expect(res.status).toBe(403);
  });

  it("moves no stock until the variance is approved", async () => {
    const item = await makeItem();
    await receive(item.id, 50, store);
    const count = await countWith(item.id, 45);
    expect((await positionOf(item.id, store)).onHand).toBe(50);

    const approved = await post(
      { ...w.admin, ...(await ver("stock_counts", count.id)) },
      `/api/v1/stock-counts/${count.id}/approval`,
      { action: "APPROVE", reason: "Shortage accepted after a recount" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await positionOf(item.id, store)).onHand).toBe(45);
  });

  it("posts the correction as its own auditable transaction", async () => {
    // §44.5: a count-driven adjustment is separately auditable from one
    // somebody keyed by hand.
    const item = await makeItem();
    await receive(item.id, 30, store);
    const count = await countWith(item.id, 34);
    await post({ ...w.admin, ...(await ver("stock_counts", count.id)) },
      `/api/v1/stock-counts/${count.id}/approval`,
      { action: "APPROVE", reason: "Surplus found behind the racking" });

    const rows = await w.pool.query(
      `SELECT t.transaction_type, t.document_type, l.adjustment_id
       FROM stock_count_lines l JOIN stock_transactions t ON t.id = l.adjustment_id
       WHERE l.count_id = $1`, [count.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].transaction_type).toBe("COUNT_ADJUSTMENT");
    expect(rows.rows[0].document_type).toBe("STOCK_COUNT");
  });

  it("demands a reason on either decision", async () => {
    const item = await makeItem();
    await receive(item.id, 10, store);
    const count = await countWith(item.id, 8);
    const res = await post({ ...w.admin, ...(await ver("stock_counts", count.id)) },
      `/api/v1/stock-counts/${count.id}/approval`, { action: "APPROVE" });
    expect(res.status).toBe(422);
  });
});

describe("reorder", () => {
  it("measures the reorder level against what is free, not what is on hand", async () => {
    // Stock entirely reserved needs reordering just as much as an empty shelf.
    const item = await makeItem({ reorder_level: 20 });
    await receive(item.id, 100, store);
    let list = await get(w.admin, "/api/v1/stock/reorder");
    expect(list.data.find((r: any) => r.item_id === item.id)).toBeUndefined();

    await post(w.role.PROJECT_MANAGER, "/api/v1/stock-reservations", {
      item_id: item.id, location_id: store, quantity: 90,
    });
    list = await get(w.admin, "/api/v1/stock/reorder");
    expect(list.data.find((r: any) => r.item_id === item.id)).toBeTruthy();
  });
});

describe("permissions", () => {
  it("does not let a project manager receive stock into the store", async () => {
    const item = await makeItem();
    const res = await post(w.role.PROJECT_MANAGER, "/api/v1/stock-transactions", {
      transaction_type: "PURCHASE_RECEIPT", item_id: item.id, quantity: 5,
      to_location_id: store, reference: uniq("GRN"),
    });
    expect(res.status).toBe(403);
  });

  it("keeps the auditor out of every write", async () => {
    expect((await get(w.role.AUDITOR, "/api/v1/stock-locations")).status).toBe(200);
    expect((await post(w.role.AUDITOR, "/api/v1/stock-locations", {
      code: uniq("WH"), name: "X", kind: "WAREHOUSE",
    })).status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("will not read another organisation's location", async () => {
    expect((await get(w.other.admin, `/api/v1/stock-locations/${store}/stock`)).status).toBe(404);
  });
});

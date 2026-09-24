/**
 * Data-integrity and concurrency round (2026-09-24, findings-integrity.md).
 *
 * Every race here is fired for real: Promise.all over app.inject, so each
 * request takes its own pooled connection and the database sees overlapping
 * transactions. A test that only passes when the requests happen to run one
 * after another proves nothing about the lock that is supposed to serialise
 * them.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, createActiveEmployee, createUser, grantLeaveBalance, idem, leaveTypeIds, loginAs,
  uniq, uniquePhone, workDate, type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;

async function send(method: "POST" | "GET" | "PATCH" | "PUT", headers: Headers, url: string, payload?: unknown, key = true) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" || !key ? {} : idem()) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);

function plusDays(days: number, from = workDate()): string {
  const base = new Date(`${from}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

/* ------------------------------------------------------------------ stock */

describe("D-001 stock reservations under concurrency", () => {
  it("never promises more than is on the shelf", async () => {
    const loc = await post(w.admin, "/api/v1/stock-locations", {
      code: uniq("WH"), name: "Race store", kind: "WAREHOUSE",
    });
    expect(loc.status, JSON.stringify(loc.body)).toBe(201);
    const item = (await w.pool.query(
      `INSERT INTO inventory_items(org_id, code, name, unit) VALUES($1,$2,$3,'KG') RETURNING id`,
      [w.orgId, uniq("IT"), `Race item ${uniq()}`])).rows[0].id as string;
    const received = await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "PURCHASE_RECEIPT", item_id: item, quantity: 10,
      to_location_id: loc.data.id, reference: uniq("GRN"),
    });
    expect(received.status, JSON.stringify(received.body)).toBe(201);

    // Eight people each reserve 4 of 10: at most two can be honoured.
    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      post(w.admin, "/api/v1/stock-reservations", {
        item_id: item, location_id: loc.data.id, quantity: 4, project_id: w.activeProject,
      })));
    const accepted = attempts.filter(a => a.status === 201).length;
    for (const a of attempts.filter(x => x.status !== 201)) {
      expect(a.body.code).toBe("INSUFFICIENT_STOCK");
    }
    const reserved = Number((await w.pool.query(
      "SELECT COALESCE(sum(quantity),0) AS q FROM stock_reservations WHERE item_id=$1 AND state='ACTIVE'",
      [item])).rows[0].q);
    expect(reserved).toBeLessThanOrEqual(10);
    expect(accepted).toBe(2);
  });
});

/* ------------------------------------------------------------------ leave */

describe("D-002 overlapping leave filed concurrently", () => {
  it("lets exactly one of several simultaneous identical requests stand", async () => {
    const types = await leaveTypeIds(w.app, w.admin);
    const employeeId = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    await grantLeaveBalance(w.app, w.admin, employeeId, types.CL!, 12);
    const username = `int_lv_${uniq()}`;
    await createUser(w.pool, w.orgId, { username, roles: ["EMPLOYEE"], employeeId });
    const headers = await loginAs(w.app, username);

    const from = plusDays(40), to = plusDays(41);
    const attempts = await Promise.all(Array.from({ length: 6 }, () =>
      w.app.inject({
        method: "POST", url: "/api/v1/leave/requests",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { leave_type_id: types.CL, from_date: from, to_date: to, reason: "race" },
      })));
    const codes = attempts.map(a => a.statusCode);
    expect(codes.filter(c => c >= 500)).toEqual([]);
    const standing = Number((await w.pool.query(
      "SELECT count(*)::int AS n FROM leave_requests WHERE employee_id=$1 AND status IN ('PENDING','APPROVED')",
      [employeeId])).rows[0].n);
    expect(standing).toBe(1);
    expect(codes.filter(c => c === 201).length).toBe(1);
  });
});

/* ----------------------------------------------------------------- budget */

describe("D-003 budget revised by two people at once", () => {
  it("serialises the revisions instead of failing one with a bare duplicate error", async () => {
    const head = await post(w.admin, "/api/v1/cost-heads", { code: uniq("CH"), name: "Race head", kind: "OTHER" });
    expect(head.status, JSON.stringify(head.body)).toBe(201);
    const first = await send("PUT", w.admin, `/api/v1/projects/${w.activeProject}/budget`, {
      lines: [{ cost_head_id: head.data.id, budgeted_amount: 1000 }],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const [a, b] = await Promise.all([1500, 2500].map(amount =>
      send("PUT", w.admin, `/api/v1/projects/${w.activeProject}/budget`, {
        revision_reason: "race", lines: [{ cost_head_id: head.data.id, budgeted_amount: amount }],
      })));
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    const live = (await w.pool.query(
      "SELECT revision FROM project_budgets WHERE project_id=$1 AND cost_head_id=$2 AND superseded_at IS NULL",
      [w.activeProject, head.data.id])).rows;
    expect(live).toHaveLength(1);
    expect(new Set([a.data.revision, b.data.revision]).size).toBe(2);
  });
});

/* ------------------------------------------------------------- allocation */

describe("receipt allocation to one invoice from two payments at once", () => {
  it("never allocates beyond the invoice's outstanding amount", async () => {
    const invoice = (await w.pool.query(
      `INSERT INTO invoices(org_id, serial_number, vendor_id, hsn, gst_enabled, gst_rate,
         subtotal, tax, total, payment_mode, reference)
       VALUES($1,$2,$3,'9954',false,0,1000,0,1000,'NEFT','ref') RETURNING id`,
      [w.orgId, uniq("INV"), w.vendorId])).rows[0].id as string;
    const payments = await Promise.all([1, 2, 3, 4].map(async () => {
      const p = await post(w.admin, "/api/v1/payments", {
        direction: "PAYABLE", payment_no: uniq("PAY"), paid_on: workDate(), amount: 800, mode: "NEFT",
      });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      return p.data.id as string;
    }));
    const attempts = await Promise.all(payments.map(id =>
      post(w.admin, `/api/v1/payments/${id}/allocations`, {
        document_type: "VENDOR_INVOICE", document_id: invoice, amount: 800,
      })));
    expect(attempts.filter(a => a.status === 201)).toHaveLength(1);
    expect(attempts.filter(a => a.status >= 500)).toEqual([]);
    const total = Number((await w.pool.query(
      "SELECT COALESCE(sum(amount),0) AS t FROM payment_allocations WHERE document_id=$1 AND reversed_at IS NULL",
      [invoice])).rows[0].t);
    expect(total).toBeLessThanOrEqual(1000);
  });
});

/* ------------------------------------------------------------ idempotency */

describe("idempotency", () => {
  it("mutate(): N concurrent same-key requests give one effect and one response", async () => {
    const key = randomUUID(), code = uniq("WH");
    const body = { code, name: "Idem store", kind: "WAREHOUSE" };
    const attempts = await Promise.all(Array.from({ length: 6 }, () =>
      w.app.inject({ method: "POST", url: "/api/v1/stock-locations",
        headers: { ...w.admin, "idempotency-key": key }, payload: body })));
    expect(attempts.filter(a => a.statusCode >= 400)).toEqual([]);
    const ids = new Set(attempts.map(a => (a.json() as any).data.id));
    expect(ids.size).toBe(1);
    const rows = (await w.pool.query("SELECT count(*)::int AS n FROM stock_locations WHERE org_id=$1 AND upper(code)=upper($2)",
      [w.orgId, code])).rows[0].n;
    expect(rows).toBe(1);
  });

  it("mutate(): the same key with a different body is refused", async () => {
    const key = randomUUID();
    const one = await w.app.inject({ method: "POST", url: "/api/v1/stock-locations",
      headers: { ...w.admin, "idempotency-key": key }, payload: { code: uniq("WH"), name: "A", kind: "WAREHOUSE" } });
    expect(one.statusCode).toBe(201);
    const two = await w.app.inject({ method: "POST", url: "/api/v1/stock-locations",
      headers: { ...w.admin, "idempotency-key": key }, payload: { code: uniq("WH"), name: "B", kind: "WAREHOUSE" } });
    expect(two.statusCode).toBe(409);
    expect((two.json() as any).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("mutationRoute(): concurrent same-key employee creates give one employee", async () => {
    const key = randomUUID(), empNo = `I${uniq().toUpperCase().slice(-8)}`;
    const body = { emp_no: empNo, first_name: "Idem", last_name: "Race", phone: uniquePhone(), date_of_joining: "2024-01-15" };
    const attempts = await Promise.all(Array.from({ length: 5 }, () =>
      w.app.inject({ method: "POST", url: "/api/v1/employees",
        headers: { ...w.admin, "idempotency-key": key }, payload: body })));
    expect(attempts.filter(a => a.statusCode >= 400).map(a => a.body)).toEqual([]);
    const n = (await w.pool.query("SELECT count(*)::int AS n FROM employees WHERE org_id=$1 AND emp_no=$2",
      [w.orgId, empNo])).rows[0].n;
    expect(n).toBe(1);
    const other = await w.app.inject({ method: "POST", url: "/api/v1/employees",
      headers: { ...w.admin, "idempotency-key": key }, payload: { ...body, first_name: "Different" } });
    expect(other.statusCode).toBe(409);
  });

  it("generated employee numbers stay unique under a burst", async () => {
    const attempts = await Promise.all(Array.from({ length: 6 }, () =>
      post(w.admin, "/api/v1/employees", {
        first_name: "Seq", last_name: "Burst", phone: uniquePhone(), date_of_joining: "2024-01-15",
      })));
    expect(attempts.map(a => a.status)).toEqual(Array(6).fill(201));
    expect(new Set(attempts.map(a => a.data?.emp_no ?? a.body?.emp_no)).size).toBe(6);
  });
});

/* ------------------------------------------------------------- pagination */

describe("D-004 paging through rows that share a timestamp", () => {
  it("returns every payment exactly once", async () => {
    // One statement, so every row carries the same created_at and paid_on —
    // exactly what a payment-run execution writes.
    await w.pool.query(
      `INSERT INTO payments(org_id, payment_no, direction, paid_on, amount, mode)
       SELECT $1, $2 || g, 'PAYABLE', '2031-01-15', 1, 'NEFT' FROM generate_series(1, 40) g`,
      [w.orgId, uniq("PG")]);
    const seen: string[] = [];
    for (let offset = 0; offset < 400; offset += 7) {
      const res = await send("GET", w.admin, `/api/v1/payments?limit=7&offset=${offset}`);
      expect(res.status).toBe(200);
      seen.push(...res.data.map((p: any) => p.id));
      if (!res.body.has_more) break;
    }
    expect(seen.length).toBe(new Set(seen).size);
    const total = (await w.pool.query("SELECT count(*)::int AS n FROM payments WHERE org_id=$1", [w.orgId])).rows[0].n;
    expect(seen.length).toBe(total);
  });
});

/* ---------------------------------------------------- referential integrity */

describe("D-005 inactive masters", () => {
  it("refuses a purchase order to a deactivated vendor", async () => {
    const vendor = (await w.pool.query(
      "INSERT INTO vendors(org_id, code, name, status) VALUES($1,$2,'Retired vendor','INACTIVE') RETURNING id",
      [w.orgId, uniq("V")])).rows[0].id as string;
    const res = await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor, po_date: workDate(),
      lines: [{ description: "Cement", unit: "BAG", quantity: 1, unit_rate: 100 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("VENDOR_INACTIVE");
  });

  it("refuses a stock movement on a deactivated item", async () => {
    const loc = await post(w.admin, "/api/v1/stock-locations", { code: uniq("WH"), name: "Inactive test", kind: "WAREHOUSE" });
    const item = (await w.pool.query(
      `INSERT INTO inventory_items(org_id, code, name, unit, status) VALUES($1,$2,'Retired item','KG','INACTIVE') RETURNING id`,
      [w.orgId, uniq("IT")])).rows[0].id as string;
    const res = await post(w.admin, "/api/v1/stock-transactions", {
      transaction_type: "PURCHASE_RECEIPT", item_id: item, quantity: 5,
      to_location_id: loc.data.id, reference: uniq("GRN"),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("ITEM_INACTIVE");
  });
});

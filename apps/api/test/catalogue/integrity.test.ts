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

/* ------------------------------------------------------------------- time */

describe("D-006 audit report date filter in the organisation's timezone", () => {
  it("puts an event at 01:30 IST on the IST day, as the audit screen does", async () => {
    const probe = `qa.tz.probe.${uniq()}`;
    // 2031-03-09 20:00 UTC is 2031-03-10 01:30 in Asia/Kolkata; the second is
    // 2031-03-10 20:00 UTC, which is already the 11th in India.
    await w.pool.query(
      `INSERT INTO audit_events(org_id, actor_id, action, entity_type, created_at)
       VALUES($1,$2,$3,'probe','2031-03-09T20:00:00Z'), ($1,$2,$3 || '.late','probe','2031-03-10T20:00:00Z')`,
      [w.orgId, w.adminId, probe]);
    const created = await w.app.inject({
      method: "POST", url: "/api/v1/reports", headers: { ...w.admin, ...idem() },
      payload: { type: "audit", format: "csv", filters: { from: "2031-03-10", to: "2031-03-10" } },
    });
    expect([200, 201], created.body).toContain(created.statusCode);
    const { id } = created.json() as { id: string };
    const csv = (await w.app.inject({ method: "GET", url: `/api/v1/reports/${id}/download`, headers: w.admin })).body;
    expect(csv).toContain(`${probe},probe`);
    expect(csv).not.toContain(`${probe}.late`);
  });
});

/* ------------------------------------------------- two settlement channels */

describe("D-008 an expense claim settled through both payment paths", () => {
  async function claim(status: string, amount = 1000): Promise<string> {
    return (await w.pool.query(
      `INSERT INTO expense_claims(org_id, claim_no, requested_by, claim_date, purpose,
         total_claimed, total_allowed, approved_amount, status)
       VALUES($1,$2,$3,'2026-09-01','Double pay probe',$4,$4,$4,$5) RETURNING id`,
      [w.orgId, uniq("EXP"), w.directUserId, amount, status])).rows[0].id as string;
  }
  async function payment(amount: number): Promise<string> {
    const p = await post(w.admin, "/api/v1/payments", {
      direction: "PAYABLE", payment_no: uniq("PAY"), paid_on: workDate(), amount, mode: "NEFT",
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    return p.data.id as string;
  }

  it("will not allocate a payment to a claim already reimbursed in full", async () => {
    const id = await claim("APPROVED");
    const paid = await post(w.admin, `/api/v1/expense-claims/${id}/reimburse`, {
      amount: 1000, paid_on: workDate(), mode: "NEFT",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const again = await post(w.admin, `/api/v1/payments/${await payment(1000)}/allocations`, {
      document_type: "EXPENSE_CLAIM", document_id: id, amount: 1000,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(422);
  });

  it("will not reimburse a claim a payment has already settled", async () => {
    const id = await claim("APPROVED");
    const allocated = await post(w.admin, `/api/v1/payments/${await payment(1000)}/allocations`, {
      document_type: "EXPENSE_CLAIM", document_id: id, amount: 1000,
    });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);
    const again = await post(w.admin, `/api/v1/expense-claims/${id}/reimburse`, {
      amount: 1000, paid_on: workDate(), mode: "NEFT",
    });
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(again.body.code).toBe("OVERPAYMENT");
  });

  it("will not allocate a payment to a claim nobody approved", async () => {
    for (const status of ["DRAFT", "SUBMITTED"]) {
      const id = await claim(status);
      const res = await post(w.admin, `/api/v1/payments/${await payment(500)}/allocations`, {
        document_type: "EXPENSE_CLAIM", document_id: id, amount: 500,
      });
      expect(res.status, `${status}: ${JSON.stringify(res.body)}`).toBe(422);
    }
  });

  it("will not allocate a receipt to an RA bill that was never certified", async () => {
    const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
    const project = await w.pool.query(
      `INSERT INTO projects(org_id, workspace_id, code, name, status) VALUES($1,$2,$3,'Draft bill project','ACTIVE') RETURNING id`,
      [w.orgId, ws.rows[0].id, uniq("PRJ")]);
    const bill = (await w.pool.query(
      `INSERT INTO ra_bills(org_id, project_id, bill_no, period_from, period_to, gross_value, net_payable, status)
       VALUES($1,$2,1,'2026-08-01','2026-08-31',1000,1000,'DRAFT') RETURNING id`,
      [w.orgId, project.rows[0].id])).rows[0].id as string;
    const receipt = await post(w.admin, "/api/v1/payments", {
      direction: "RECEIVABLE", payment_no: uniq("RCP"), paid_on: workDate(), amount: 1000, mode: "NEFT",
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const res = await post(w.admin, `/api/v1/payments/${receipt.data.id}/allocations`, {
      document_type: "RA_BILL", document_id: bill, amount: 1000,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
  });
});

/* ------------------------------------------------------------ lost update */

describe("D-009 two people editing different fields of one catalogue item", () => {
  it("keeps both edits instead of the second silently restoring the first's field", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await post(w.admin, "/api/v1/catalogue-items", {
        code: uniq("CAT"), name: "Original", kind: "GOOD", uom: "nos", standard_rate: 100, gst_rate: 18,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids.push(res.data.id);
    }
    await Promise.all(ids.flatMap(id => [
      send("PATCH", w.admin, `/api/v1/catalogue-items/${id}`, { standard_rate: 250 }),
      send("PATCH", w.admin, `/api/v1/catalogue-items/${id}`, { name: "Renamed" }),
    ]));
    const rows = (await w.pool.query(
      "SELECT name, standard_rate::float8 AS rate FROM catalogue_items WHERE id = ANY($1)", [ids])).rows;
    expect(rows.filter(r => r.name !== "Renamed" || r.rate !== 250)).toEqual([]);
  });

  it("refuses a stale If-Match when one is sent", async () => {
    const res = await post(w.admin, "/api/v1/catalogue-items", {
      code: uniq("CAT"), name: "Versioned", kind: "GOOD", uom: "nos", standard_rate: 100, gst_rate: 18,
    });
    const first = await send("PATCH", { ...w.admin, "if-match": "1" }, `/api/v1/catalogue-items/${res.data.id}`, { name: "One" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const stale = await send("PATCH", { ...w.admin, "if-match": "1" }, `/api/v1/catalogue-items/${res.data.id}`, { name: "Two" });
    expect(stale.status).toBe(409);
  });
});

/* ---------------------------------------------------------------- payroll */

describe("payroll run under concurrent calculate and transitions", () => {
  it("calculates once per employee however many times it is pressed, and moves state exactly once", async () => {
    const calcs = await Promise.all(Array.from({ length: 5 }, () =>
      w.app.inject({ method: "POST", url: `/api/v1/payroll/runs/${w.payrollRunId}/calculate`,
        headers: { ...w.admin, ...idem() }, payload: {} })));
    expect(calcs.filter(c => c.statusCode >= 500).map(c => c.body)).toEqual([]);
    const dup = (await w.pool.query(
      `SELECT employee_id, count(*)::int AS n FROM payslips WHERE payroll_run_id=$1
        GROUP BY employee_id HAVING count(*) > 1`, [w.payrollRunId])).rows;
    expect(dup).toEqual([]);
    const reviews = await Promise.all(Array.from({ length: 4 }, () =>
      w.app.inject({ method: "POST", url: `/api/v1/payroll/runs/${w.payrollRunId}/submit-review`,
        headers: { ...w.admin, ...idem() }, payload: {} })));
    expect(reviews.filter(r => r.statusCode >= 500).map(r => r.body)).toEqual([]);
    expect(reviews.filter(r => r.statusCode < 300).length).toBeLessThanOrEqual(1);
  });
});

/* --------------------------------------------------------------- rounding */

describe("D-010 paise rounding on order lines", () => {
  it("rounds a line that lands on half a paisa up, as NUMERIC and the invoice side do", async () => {
    const res = await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: w.vendorId, po_date: workDate(),
      lines: [
        { description: "Half-paisa A", unit: "KG", quantity: 0.5, unit_rate: 4.35, gst_rate_pct: 0 },
        { description: "Half-paisa B", unit: "KG", quantity: 0.3, unit_rate: 2.15, gst_rate_pct: 0 },
        { description: "Taxed", unit: "NOS", quantity: 1, unit_rate: 2.25, gst_rate_pct: 18 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const lines = (await w.pool.query(
      "SELECT taxable_value::text AS t, tax_amount::text AS x, line_total::text AS l FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY line_no",
      [res.data.id])).rows;
    // 0.5 x 4.35 = 2.175 and 0.3 x 2.15 = 0.645; 2.25 x 18% = 0.405.
    expect(lines.map(l => l.t)).toEqual(["2.18", "0.65", "2.25"]);
    expect(lines[2].x).toBe("0.41");
    const po = (await w.pool.query(
      "SELECT taxable_value::text AS t, tax_amount::text AS x, total_value::text AS v FROM purchase_orders WHERE id=$1",
      [res.data.id])).rows[0];
    expect(po).toEqual({ t: "5.08", x: "0.41", v: "5.49" });
  });
});

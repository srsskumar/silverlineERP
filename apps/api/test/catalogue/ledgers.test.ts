/**
 * End-to-end cover for accounts payable and receivable (§58).
 *
 * The answers depend on live allocations, a supplier's Udyam registration and
 * a retention ledger, so they can only be checked against real rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;

async function send(method: "POST" | "GET", headers: Headers, url: string, payload?: unknown) {
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

async function ver(table: string, id: string): Promise<Headers> {
  const r = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  return { "if-match": String(r.rows[0].version) };
}

/** A supplier registered under the MSMED Act. */
async function msmeVendor(over: Record<string, unknown> = {}) {
  const r = await w.pool.query(
    `INSERT INTO vendors(org_id, code, name, status, udyam_number, msme_category, has_written_agreement)
     VALUES($1,$2,$3,'ACTIVE',$4,$5,$6) RETURNING *`,
    [w.orgId, uniq("VN"), `MSME vendor ${uniq()}`,
     over.udyam_number ?? "UDYAM-KR-03-0000001",
     over.msme_category ?? "SMALL", over.has_written_agreement ?? true]);
  return r.rows[0];
}

async function invoice(over: Record<string, unknown> = {}) {
  const r = await w.pool.query(
    `INSERT INTO invoices(org_id, serial_number, vendor_id, hsn, gst_enabled, gst_rate,
       subtotal, tax, total, payment_mode, reference, due_date, accepted_on, match_status,
       purchase_order_id)
     VALUES($1,$2,$3,'9954',false,0,$4,0,$4,'NEFT','ref',$5,$6,$7,$8) RETURNING *`,
    [w.orgId, uniq("INV"), over.vendor_id ?? w.vendorId, over.total ?? 100000,
     over.due_date ?? null, over.accepted_on ?? null,
     "match_status" in over ? over.match_status : 'MATCHED',
     over.purchase_order_id ?? null]);
  return r.rows[0];
}

/** Build a run as the payments clerk; returns the run and the ids it took. */
async function buildRun(headers: Headers = w.role.PAYROLL_OFFICER, extra: Record<string, unknown> = {}) {
  const run = await post(headers, "/api/v1/payment-runs", {
    run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15", ...extra,
  });
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const lines = await w.pool.query(
    "SELECT document_id, match_override_reason FROM payment_run_lines WHERE run_id = $1", [run.data.id]);
  return {
    run: run.data,
    ids: lines.rows.map(l => String(l.document_id)),
    lines: lines.rows,
    excluded: Object.fromEntries(run.data.excluded.map((e: any) => [e.documentId, e.code])) as Record<string, string>,
  };
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("payables ageing", () => {
  it("ages an MSME invoice on the statutory date, not the agreed one", async () => {
    // 45 days under s.15 with a written agreement, against 180 days agreed.
    // A generic bucket would show this comfortably current while it is in fact
    // weeks past a date the law fixed.
    const vendor = await msmeVendor();
    await invoice({
      vendor_id: vendor.id, total: 500000,
      accepted_on: "2026-01-01", due_date: "2026-12-31",
    });
    const res = await get(w.admin, "/api/v1/ap/ageing?as_of=2026-09-15");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = res.data.vendors.find((x: any) => x.vendor_id === vendor.id);
    const row = v.invoices[0];
    expect(row.is_msme).toBe(true);
    expect(row.statutory_due_date).toBe("2026-02-15");
    expect(row.contractual_due_date).toBe("2026-12-31");
    // The earlier date governs, and it is the one the ageing uses.
    expect(row.effective_due_date).toBe("2026-02-15");
    expect(v.buckets.OVER_90).toBe(500000);
  });

  it("accrues s.16 interest on a late MSME payment", async () => {
    const res = await get(w.admin, "/api/v1/ap/ageing?as_of=2026-09-15");
    // A real liability whether or not anybody recorded it, and not deductible
    // for income tax.
    expect(res.data.msme_accrued_interest).toBeGreaterThan(0);
    expect(res.data.msme_outstanding).toBeGreaterThan(0);
  });

  it("leaves a supplier outside the Act on the agreed terms", async () => {
    const plain = await w.pool.query(
      `INSERT INTO vendors(org_id, code, name, status) VALUES($1,$2,$3,'ACTIVE') RETURNING *`,
      [w.orgId, uniq("VN"), `Plain vendor ${uniq()}`]);
    await invoice({ vendor_id: plain.rows[0].id, total: 200000, accepted_on: "2026-01-01", due_date: "2026-12-31" });
    const res = await get(w.admin, "/api/v1/ap/ageing?as_of=2026-09-15");
    const v = res.data.vendors.find((x: any) => x.vendor_id === plain.rows[0].id);
    expect(v.invoices[0].is_msme).toBe(false);
    expect(v.invoices[0].effective_due_date).toBe("2026-12-31");
    expect(v.buckets.NOT_DUE).toBe(200000);
  });

  it("keeps a held payable in the ageing", async () => {
    // The money is still owed; hiding it would flatter the position.
    const inv = await invoice({ total: 75000, due_date: "2026-08-01" });
    const held = await post(w.admin, `/api/v1/ap/invoices/${inv.id}/hold`,
      { on_hold: true, reason: "Awaiting a credit note for short delivery" });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const res = await get(w.admin, "/api/v1/ap/ageing?as_of=2026-09-15");
    expect(res.data.onHold).toBeGreaterThanOrEqual(75000);
    expect(res.data.total).toBeGreaterThanOrEqual(75000);
  });

  it("demands a reason to hold", async () => {
    const inv = await invoice();
    expect((await post(w.admin, `/api/v1/ap/invoices/${inv.id}/hold`, { on_hold: true })).status)
      .toBe(422);
  });
});

describe("payment run", () => {
  it("refuses a disputed invoice, an unmatched one and a held one", async () => {
    const disputed = await invoice({ total: 10000, due_date: "2026-01-01" });
    await post(w.admin, `/api/v1/invoices/${disputed.id}/dispute`,
      { disputed: true, reason: "Rate not as agreed" });
    const unmatched = await invoice({ total: 20000, due_date: "2026-01-01", match_status: "EXCEPTION" });
    const onHold = await invoice({ total: 30000, due_date: "2026-01-01" });
    await post(w.admin, `/api/v1/ap/invoices/${onHold.id}/hold`, { on_hold: true, reason: "Query raised" });

    const run = await post(w.role.PAYROLL_OFFICER, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const codes = Object.fromEntries(run.data.excluded.map((e: any) => [e.documentId, e.code]));
    expect(codes[disputed.id]).toBe("DISPUTED");
    expect(codes[unmatched.id]).toBe("NOT_MATCHED");
    expect(codes[onHold.id]).toBe("ON_HOLD");
  });

  it("pays the statutory obligations first", async () => {
    const vendor = await msmeVendor();
    await invoice({ vendor_id: vendor.id, total: 40000, accepted_on: "2026-06-01", due_date: "2026-12-31" });
    const run = await post(w.role.PAYROLL_OFFICER, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const detail = await get(w.admin, `/api/v1/payment-runs/${run.data.id}`);
    expect(detail.data.lines.length).toBeGreaterThan(0);
    // A legal consequence outranks a relationship one.
    expect(detail.data.lines[0].is_msme).toBe(true);
  });

  it("will not let the person who built a run release it", async () => {
    // Building a batch and paying it single-handed is how money reaches an
    // unintended account.
    const run = await post(w.admin, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    });
    const res = await post({ ...w.admin, ...(await ver("payment_runs", run.data.id)) },
      `/api/v1/payment-runs/${run.data.id}/decision`, { action: "APPROVE" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SELF_APPROVAL");
  });

  it("approves a run built by somebody else", async () => {
    const run = await post(w.role.PAYROLL_OFFICER, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    });
    const res = await post({ ...w.admin, ...(await ver("payment_runs", run.data.id)) },
      `/api/v1/payment-runs/${run.data.id}/decision`, { action: "APPROVE" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.approved_by).toBe(w.adminId);
  });

  it("demands a reason to cancel", async () => {
    const run = await post(w.role.PAYROLL_OFFICER, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    });
    const res = await post({ ...w.admin, ...(await ver("payment_runs", run.data.id)) },
      `/api/v1/payment-runs/${run.data.id}/decision`, { action: "CANCEL" });
    expect(res.status).toBe(422);
  });

  it("does not let the payments clerk release their own run", async () => {
    expect((await post(w.role.PAYROLL_OFFICER, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    })).status).toBe(201);
    const runs = await get(w.role.PAYROLL_OFFICER, "/api/v1/payment-runs?limit=1");
    const res = await post(
      { ...w.role.PAYROLL_OFFICER, ...(await ver("payment_runs", runs.data[0].id)) },
      `/api/v1/payment-runs/${runs.data[0].id}/decision`, { action: "APPROVE" });
    expect(res.status).toBe(403);
  });
});

describe("one invoice, one payment", () => {
  it("keeps an invoice on an open run out of the next run", async () => {
    // Two runs a day apart each took every unpaid invoice, and both were paid.
    const inv = await invoice({ total: 12345, due_date: "2026-02-01" });
    const first = await buildRun();
    expect(first.ids).toContain(inv.id);

    const second = await buildRun();
    expect(second.ids).not.toContain(inv.id);
    expect(second.excluded[inv.id]).toBe("IN_OPEN_RUN");

    // Cancelling the first run puts it back in the pool.
    const cancel = await post({ ...w.admin, ...(await ver("payment_runs", first.run.id)) },
      `/api/v1/payment-runs/${first.run.id}/decision`, { action: "CANCEL", reason: "Rebuilt" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const third = await buildRun();
    expect(third.ids).toContain(inv.id);
  });

  it("refuses the same invoice on two open runs at the database", async () => {
    const inv = await invoice({ total: 5000, due_date: "2026-02-01" });
    const first = await buildRun();
    expect(first.ids).toContain(inv.id);
    const other = await buildRun();
    const sneak = () => w.pool.query(
      `INSERT INTO payment_run_lines(org_id, run_id, document_type, document_id, amount)
       VALUES($1,$2,'VENDOR_INVOICE',$3,5000)`, [w.orgId, other.run.id, inv.id]);
    await expect(sneak()).rejects.toMatchObject({ code: "23505" });

    // A cancelled run no longer holds it.
    await post({ ...w.admin, ...(await ver("payment_runs", first.run.id)) },
      `/api/v1/payment-runs/${first.run.id}/decision`, { action: "CANCEL", reason: "Superseded" });
    await expect(sneak()).resolves.toBeTruthy();
  });

  it("will not approve a run whose invoice was put on hold after it was built", async () => {
    const inv = await invoice({ total: 7000, due_date: "2026-02-01" });
    const built = await buildRun();
    expect(built.ids).toContain(inv.id);
    await post(w.admin, `/api/v1/ap/invoices/${inv.id}/hold`, { on_hold: true, reason: "Supplier query" });
    const res = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("RUN_OUT_OF_DATE");
    expect(res.body.message).toContain(inv.serial_number);
  });

  it("will not approve a run whose invoice was disputed or part-paid since", async () => {
    const disputed = await invoice({ total: 8000, due_date: "2026-02-01" });
    const built = await buildRun();
    expect(built.ids).toContain(disputed.id);
    await post(w.admin, `/api/v1/invoices/${disputed.id}/dispute`, { disputed: true, reason: "Short supply" });
    const res = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    expect(res.status).toBe(409);

    const partPaid = await invoice({ total: 9000, due_date: "2026-02-01" });
    const run2 = await buildRun();
    expect(run2.ids).toContain(partPaid.id);
    const payment = await post(w.admin, "/api/v1/payments", {
      direction: "PAYABLE", payment_no: uniq("PAY"), paid_on: "2026-09-10", amount: 1000, mode: "NEFT",
    });
    expect((await post(w.admin, `/api/v1/payments/${payment.data.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: partPaid.id, amount: 1000,
    })).status).toBe(201);
    const res2 = await post({ ...w.admin, ...(await ver("payment_runs", run2.run.id)) },
      `/api/v1/payment-runs/${run2.run.id}/decision`, { action: "APPROVE" });
    expect(res2.status).toBe(409);
    expect(res2.body.message).toContain("8000.00 outstanding");
  });
});

describe("three-way match on the run", () => {
  it("releases an unmatched invoice only with a reason for it, kept on the line", async () => {
    const unmatched = await invoice({ total: 6100, due_date: "2026-02-01", match_status: "EXCEPTION" });
    const bare = await buildRun(w.role.SUPER_ADMIN);
    expect(bare.excluded[unmatched.id]).toBe("NOT_MATCHED");

    const reasoned = await buildRun(w.role.SUPER_ADMIN, {
      match_overrides: [{ document_id: unmatched.id, reason: "Rate difference credited on next bill" }],
    });
    const line = reasoned.lines.find(l => String(l.document_id) === unmatched.id);
    expect(line?.match_override_reason).toBe("Rate difference credited on next bill");
  });

  it("refuses match overrides from somebody without the permission", async () => {
    const unmatched = await invoice({ total: 6200, due_date: "2026-02-01", match_status: "EXCEPTION" });
    const res = await post(w.role.PAYROLL_OFFICER, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
      match_overrides: [{ document_id: unmatched.id, reason: "Looks fine" }],
    });
    expect(res.status).toBe(403);
  });
});

describe("receivables", () => {
  it("reports an ageing without crashing on an empty ledger", async () => {
    const res = await get(w.admin, "/api/v1/ar/ageing?as_of=2026-09-15");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data).toHaveProperty("buckets");
    expect(res.data).toHaveProperty("periodDays");
  });

  it("produces a statement that reconciles to the ledger", async () => {
    const client = await w.pool.query(
      `INSERT INTO clients(org_id, created_by, code, name, client_type, status)
       VALUES($1,$2,$3,$4,'GOVERNMENT','ACTIVE') RETURNING *`,
      [w.orgId, w.adminId, uniq("CL"), `Statement client ${uniq()}`]);
    const res = await get(w.admin, `/api/v1/ar/statement/${client.rows[0].id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // An opening plus the movements has to equal the closing, or the statement
    // is not something anybody can send to a client.
    const movement = (res.data.entries as any[]).reduce((t, e) => t + e.debit - e.credit, 0);
    expect(Math.round((res.data.opening_balance + movement) * 100) / 100)
      .toBe(res.data.closing_balance);
  });

  it("will not read a client from another organisation", async () => {
    const foreign = await w.pool.query(
      `INSERT INTO clients(org_id, created_by, code, name, client_type, status)
       VALUES($1,$2,$3,$4,'PRIVATE','ACTIVE') RETURNING id`,
      [w.other.orgId, w.other.adminId, uniq("CL"), "Foreign"]);
    expect((await get(w.admin, `/api/v1/ar/statement/${foreign.rows[0].id}`)).status).toBe(404);
  });
});

describe("permissions", () => {
  it("gives sales the receivables ledger and nothing else", async () => {
    expect((await get(w.role.SALES_BD_EXECUTIVE, "/api/v1/ar/ageing")).status).toBe(200);
    expect((await get(w.role.SALES_BD_EXECUTIVE, "/api/v1/ap/ageing")).status).toBe(403);
  });

  it("keeps the auditor out of every write", async () => {
    expect((await get(w.role.AUDITOR, "/api/v1/ap/ageing")).status).toBe(200);
    expect((await post(w.role.AUDITOR, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    })).status).toBe(403);
  });
});

/**
 * End-to-end cover for accounts payable and receivable (§58).
 *
 * The answers depend on live allocations, a supplier's Udyam registration and
 * a retention ledger, so they can only be checked against real rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;

async function send(method: "POST" | "GET" | "PUT" | "PATCH", headers: Headers, url: string, payload?: unknown) {
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
const put = (h: Headers, u: string, p?: unknown) => send("PUT", h, u, p);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

/** A client with one project of its own. */
async function clientProject() {
  const client = await w.pool.query(
    `INSERT INTO clients(org_id, created_by, code, name, client_type, status)
     VALUES($1,$2,$3,$4,'GOVERNMENT','ACTIVE') RETURNING id`,
    [w.orgId, w.adminId, uniq("CL"), `Receivable client ${uniq()}`]);
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  const project = await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status, contract_value, client_id)
     VALUES($1,$2,$3,'Receivable project','ACTIVE',10000000,$4) RETURNING id`,
    [w.orgId, ws.rows[0].id, uniq("PRJ"), client.rows[0].id]);
  return { clientId: String(client.rows[0].id), projectId: String(project.rows[0].id) };
}

let billNo = 0;
/** A bill certified at a given instant, straight into the table. */
async function certifiedBill(projectId: string, amount: number, certifiedAt: string, dueDate: string | null = null) {
  billNo += 1;
  const r = await w.pool.query(
    `INSERT INTO ra_bills(org_id, project_id, bill_no, period_from, period_to, gross_value,
       net_payable, status, certified_at, certified_by, certified_amount, due_date)
     VALUES($1,$2,$3,'2026-01-01','2026-01-31',$4,$4,'CERTIFIED',$5,$6,$4,$7) RETURNING id`,
    [w.orgId, projectId, billNo, amount, certifiedAt, w.adminId, dueDate]);
  return String(r.rows[0].id);
}

/** A receipt of `amount` on `paidOn`, applied to one bill. */
async function receipt(billId: string, amount: number, paidOn: string) {
  const payment = await post(w.admin, "/api/v1/payments", {
    direction: "RECEIVABLE", payment_no: uniq("RCPT"), paid_on: paidOn, amount, mode: "NEFT",
  });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  const alloc = await post(w.admin, `/api/v1/payments/${payment.data.id}/allocations`, {
    document_type: "RA_BILL", document_id: billId, amount,
  });
  expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
}

/** A manual payment settling a vendor invoice, outside any payment run. */
async function payInvoiceByHand(invoiceId: string, amount: number, paidOn: string) {
  const payment = await post(w.admin, "/api/v1/payments", {
    direction: "PAYABLE", payment_no: uniq("PAY"), paid_on: paidOn, amount, mode: "NEFT",
  });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  const alloc = await post(w.admin, `/api/v1/payments/${payment.data.id}/allocations`, {
    document_type: "VENDOR_INVOICE", document_id: invoiceId, amount,
  });
  expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
}

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

describe("execute a payment run (B-002)", () => {
  it("settles the invoice, posts the payment and writes the audit", async () => {
    const inv = await invoice({ total: 55500, due_date: "2026-01-01" });
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    expect(built.ids).toContain(inv.id);

    const approve = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    const exec = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2026-09-16", bank_reference: "UTR12345678" });
    expect(exec.status, JSON.stringify(exec.body)).toBe(200);
    expect(exec.data.status).toBe("PAID");
    expect(exec.data.paid_on).toBe("2026-09-16");
    expect(exec.data.bank_reference).toBe("UTR12345678");

    const settlement = await get(w.admin, `/api/v1/documents/vendor_invoice/${inv.id}/settlement`);
    expect(settlement.status, JSON.stringify(settlement.body)).toBe(200);
    expect(settlement.data.outstanding).toBeLessThanOrEqual(0.005);

    const line = await w.pool.query(
      "SELECT payment_id FROM payment_run_lines WHERE run_id = $1 AND document_id = $2",
      [built.run.id, inv.id]);
    expect(line.rows[0].payment_id).toBeTruthy();

    const audit = await w.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'paymentrun.execute' AND entity_id = $1",
      [built.run.id]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("refuses a run that is still a draft", async () => {
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    const res = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2026-09-16", bank_reference: "UTR-DRAFT" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a cancelled run", async () => {
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    const cancel = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "CANCEL", reason: "Superseded" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const res = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2026-09-16", bank_reference: "UTR-CANCELLED" });
    expect(res.status).toBe(422);
  });

  it("refuses to execute an already-paid run a second time", async () => {
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    const first = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2026-09-16", bank_reference: "UTR-FIRST" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2026-09-17", bank_reference: "UTR-SECOND" });
    expect(second.status).toBe(422);
  });

  it("will not let the person who built a run execute it", async () => {
    const run = await post(w.role.ADMIN, "/api/v1/payment-runs", {
      run_no: uniq("PR"), run_date: "2026-09-15", due_through: "2026-09-15",
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const approve = await post({ ...w.admin, ...(await ver("payment_runs", run.data.id)) },
      `/api/v1/payment-runs/${run.data.id}/decision`, { action: "APPROVE" });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    const res = await post({ ...w.role.ADMIN, ...(await ver("payment_runs", run.data.id)) },
      `/api/v1/payment-runs/${run.data.id}/execute`,
      { paid_on: "2026-09-16", bank_reference: "UTR-SELF" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SELF_APPROVAL");
  });

  it("has one effect on a repeated Idempotency-Key", async () => {
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    const headers = {
      ...w.admin, ...(await ver("payment_runs", built.run.id)), "idempotency-key": uniq("IDEM"),
    };
    const payload = { paid_on: "2026-09-16", bank_reference: "UTR-IDEM" };
    const res1 = await w.app.inject({
      method: "POST", url: `/api/v1/payment-runs/${built.run.id}/execute`, headers, payload,
    });
    expect(res1.statusCode, res1.body).toBe(200);
    const res2 = await w.app.inject({
      method: "POST", url: `/api/v1/payment-runs/${built.run.id}/execute`, headers, payload,
    });
    expect(res2.statusCode, res2.body).toBe(200);
    const lineIds = (await w.pool.query(
      "SELECT id FROM payment_run_lines WHERE run_id = $1", [built.run.id])).rows.map((r) => String(r.id));
    // Counted against the payment numbers execution actually generates
    // (PR-<line id>, fix round 1's minor 4), not against
    // payment_run_lines.payment_id (fix round 1, minor 5): that column is
    // self-consistent by construction — whatever it points at necessarily
    // exists as a payment row — so it cannot tell an idempotent replay from
    // a second, orphaned insert the numbers themselves would catch.
    const count = await w.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE payment_no LIKE ANY($1::text[])",
      [lineIds.map((lineId) => `PR-${lineId}%`)]);
    expect(count.rows[0].n).toBe(lineIds.length);
  });

  it("refuses an invoice that was already paid elsewhere, leaving no partial effect", async () => {
    const inv = await invoice({ total: 12000, due_date: "2026-01-01" });
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    expect(built.ids).toContain(inv.id);
    const approve = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    // Settled by hand, outside the run, after it was approved.
    await payInvoiceByHand(inv.id, 12000, "2026-09-15");

    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE org_id = $1", [w.orgId]);
    const res = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2026-09-16", bank_reference: "UTR-STALE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RUN_OUT_OF_DATE");

    // No line settled — not even the ones on the run ahead of the stale one.
    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE org_id = $1", [w.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const run = await get(w.admin, `/api/v1/payment-runs/${built.run.id}`);
    expect(run.data.status).toBe("APPROVED");
  });

  it("returns a stable 409 rather than a 500 on a payment_no collision (fix round 1, minor 4)", async () => {
    const inv = await invoice({ total: 4000, due_date: "2026-01-01" });
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    expect(built.ids).toContain(inv.id);
    const approve = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    const lineRow = await w.pool.query(
      "SELECT id FROM payment_run_lines WHERE run_id = $1 AND document_id = $2",
      [built.run.id, inv.id]);
    const collidingNo = `PR-${String(lineRow.rows[0].id)}`;
    // Occupies, ahead of time, the exact number execution will try to use
    // for this line.
    const collide = await post(w.admin, "/api/v1/payments", {
      direction: "PAYABLE", payment_no: collidingNo, paid_on: "2026-09-16", amount: 1, mode: "NEFT",
    });
    expect(collide.status, JSON.stringify(collide.body)).toBe(201);

    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE org_id = $1", [w.orgId]);
    const res = await post({ ...w.admin, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2026-09-16", bank_reference: "UTR-COLLIDE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PAYMENT_NUMBER_COLLISION");

    // No partial effect: only the pre-existing manual payment survives.
    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE org_id = $1", [w.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const run = await get(w.admin, `/api/v1/payment-runs/${built.run.id}`);
    expect(run.data.status).toBe("APPROVED");
  });

  it("refuses to execute into a closed accounting period, with no effect (fix round 1)", async () => {
    // The manual payment path (finance/routes.ts) already calls guardPeriod;
    // execute() bypassed it entirely, so a closed month could be posted into
    // by running a payment through instead of recording it directly.
    const period = await post(w.admin, "/api/v1/financial-periods", {
      code: uniq("P"), starts_on: "2031-06-01", ends_on: "2031-06-30",
    });
    expect(period.status, JSON.stringify(period.body)).toBe(201);
    const closed = await post(
      { ...w.admin, ...(await ver("financial_periods", period.data.id)) },
      `/api/v1/financial-periods/${period.data.id}/closure`, { action: "CLOSE" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const inv = await invoice({ total: 9000, due_date: "2026-01-01" });
    const built = await buildRun(w.role.PAYROLL_OFFICER);
    expect(built.ids).toContain(inv.id);
    // ADMIN, not SUPER_ADMIN: holds paymentrun.approve but, unlike w.admin,
    // not the period.override §4.1 reserves for the top role, so the block
    // is actually exercised rather than waved through.
    const approve = await post({ ...w.role.ADMIN, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/decision`, { action: "APPROVE" });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE org_id = $1", [w.orgId]);
    const res = await post({ ...w.role.ADMIN, ...(await ver("payment_runs", built.run.id)) },
      `/api/v1/payment-runs/${built.run.id}/execute`,
      { paid_on: "2031-06-15", bank_reference: "UTR-CLOSED-PERIOD" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PERIOD_CLOSED");

    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE org_id = $1", [w.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const run = await get(w.admin, `/api/v1/payment-runs/${built.run.id}`);
    expect(run.data.status).toBe("APPROVED");
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

  it("dates a certified bill from the project's payment terms", async () => {
    // Nothing ever wrote the due date, so every receivable was undated and
    // nothing was ever overdue.
    const { projectId } = await clientProject();
    const policy = await put(w.admin, `/api/v1/projects/${projectId}/billing-policy`, { payment_terms_days: 30 });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    expect(policy.data.payment_terms_days).toBe(30);
    const boq = await post(w.admin, `/api/v1/projects/${projectId}/boq`, {
      item_code: "1.1", description: "Survey", unit: "ha", quantity: 100, rate: 1000,
    });
    expect(boq.status, JSON.stringify(boq.body)).toBe(201);
    const bill = await post(w.admin, "/api/v1/ra-bills", {
      project_id: projectId, period_from: "2026-08-01", period_to: "2026-08-31",
      lines: [{ boq_item_id: boq.data.id, cumulative_quantity: 10 }],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    for (const status of ["SUBMITTED", "CERTIFIED"]) {
      const res = await post({ ...w.admin, ...(await ver("ra_bills", bill.data.id)) },
        `/api/v1/ra-bills/${bill.data.id}/status`, { status });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const row = await w.pool.query("SELECT due_date::text AS due FROM ra_bills WHERE id=$1", [bill.data.id]);
    const expected = new Date(Date.parse(`${workDate()}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(row.rows[0].due).toBe(expected);
  });

  it("leaves a bill undated where no terms are recorded, rather than guessing", async () => {
    const { projectId } = await clientProject();
    const boq = await post(w.admin, `/api/v1/projects/${projectId}/boq`, {
      item_code: "1.1", description: "Survey", unit: "ha", quantity: 100, rate: 1000,
    });
    const bill = await post(w.admin, "/api/v1/ra-bills", {
      project_id: projectId, period_from: "2026-08-01", period_to: "2026-08-31",
      lines: [{ boq_item_id: boq.data.id, cumulative_quantity: 10 }],
    });
    for (const status of ["SUBMITTED", "CERTIFIED"]) {
      await post({ ...w.admin, ...(await ver("ra_bills", bill.data.id)) },
        `/api/v1/ra-bills/${bill.data.id}/status`, { status });
    }
    const row = await w.pool.query("SELECT status, due_date FROM ra_bills WHERE id=$1", [bill.data.id]);
    expect(row.rows[0].status).toBe("CERTIFIED");
    expect(row.rows[0].due_date).toBeNull();
  });

  it("ages the position as it stood on as_of, not as it stands today", async () => {
    const { clientId, projectId } = await clientProject();
    const early = await certifiedBill(projectId, 1000, "2026-03-01T10:00:00+05:30", "2026-03-31");
    await certifiedBill(projectId, 500, "2026-06-01T10:00:00+05:30", "2026-07-01");
    await receipt(early, 400, "2026-05-01");
    await receipt(early, 600, "2026-07-01");

    const res = await get(w.admin, "/api/v1/ar/ageing?as_of=2026-05-15");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = res.data.clients.find((x: any) => x.client_id === clientId);
    // On 15 May only the March bill existed, and only 400 of it was paid.
    expect(c.total).toBe(600);
    expect(c.buckets.D31_60).toBe(600);
    expect(c.bills).toHaveLength(1);

    const now = await get(w.admin, "/api/v1/ar/ageing?as_of=2026-07-15");
    const later = now.data.clients.find((x: any) => x.client_id === clientId);
    expect(later.total).toBe(500);
  });

  it("does not count a bill certified late on as_of's evening in UTC as the next day", async () => {
    // 23:30 in Kolkata on 30 April is 18:00 UTC the same day, and 00:30 on
    // 1 May is still 30 April in UTC. The business day decides.
    const { clientId, projectId } = await clientProject();
    await certifiedBill(projectId, 700, "2026-05-01T00:30:00+05:30", "2026-06-01");
    const res = await get(w.admin, "/api/v1/ar/ageing?as_of=2026-04-30");
    expect(res.data.clients.find((x: any) => x.client_id === clientId)).toBeUndefined();
  });

  it("keeps a receipt against a cancelled bill off the statement", async () => {
    const { clientId, projectId } = await clientProject();
    const kept = await certifiedBill(projectId, 1000, "2026-02-01T10:00:00+05:30");
    const cancelled = await certifiedBill(projectId, 300, "2026-02-05T10:00:00+05:30");
    await receipt(cancelled, 300, "2026-02-10");
    await w.pool.query(
      "UPDATE ra_bills SET status='CANCELLED', cancelled_reason='Raised in error' WHERE id=$1", [cancelled]);

    const res = await get(w.admin, `/api/v1/ar/statement/${clientId}?to=2026-12-31`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.entries.filter((e: any) => e.kind === "RECEIPT")).toHaveLength(0);
    expect(res.data.closing_balance).toBe(1000);
    void kept;
  });

  it("opens a statement on the balance brought forward and closes it on the window", async () => {
    const { clientId, projectId } = await clientProject();
    const bill = await certifiedBill(projectId, 1000, "2026-01-10T10:00:00+05:30");
    await receipt(bill, 250, "2026-02-15");
    await receipt(bill, 250, "2026-04-15");
    await receipt(bill, 100, "2026-06-15");

    const res = await get(w.admin, `/api/v1/ar/statement/${clientId}?from=2026-03-01&to=2026-05-31`);
    expect(res.data.opening_balance).toBe(750);
    expect(res.data.entries).toHaveLength(1);
    // The June receipt is after the window and does not move the closing.
    expect(res.data.closing_balance).toBe(500);
  });

  it("reports a disputed bill apart from the buckets, and clears it", async () => {
    const { clientId, projectId } = await clientProject();
    const bill = await certifiedBill(projectId, 2000, "2026-01-10T10:00:00+05:30", "2026-02-10");

    expect((await patch(w.admin, `/api/v1/ra-bills/${bill}/dispute`, { disputed: true })).status).toBe(422);
    expect((await patch(w.role.AUDITOR, `/api/v1/ra-bills/${bill}/dispute`,
      { disputed: true, reason: "Measurement queried" })).status).toBe(403);

    const set = await patch(w.admin, `/api/v1/ra-bills/${bill}/dispute`,
      { disputed: true, reason: "Client disputes the measured area" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const res = await get(w.admin, "/api/v1/ar/ageing?as_of=2026-09-15");
    const c = res.data.clients.find((x: any) => x.client_id === clientId);
    expect(c.disputed).toBe(2000);
    expect(c.overdue).toBe(0);
    expect(c.bills[0].disputed).toBe(true);
    expect(c.bills[0].dispute_reason).toContain("measured area");

    await patch(w.admin, `/api/v1/ra-bills/${bill}/dispute`, { disputed: false });
    const after = await get(w.admin, "/api/v1/ar/ageing?as_of=2026-09-15");
    const c2 = after.data.clients.find((x: any) => x.client_id === clientId);
    expect(c2.disputed).toBe(0);
    expect(c2.buckets.OVER_90).toBe(2000);
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

/**
 * MSME registration on a vendor, written through the API (task 5c, finding
 * B-004). The columns (migration 032) and the due-date maths (payableDue,
 * above) already existed; vendorSchema never carried the fields, so the
 * generic vendor CRUD route silently dropped them from every request.
 */
describe("vendor MSME fields", () => {
  it("writes msme_registered, udyam_number and msme_category through the vendor API", async () => {
    const res = await post(w.admin, "/api/v1/vendors", {
      code: uniq("VN"), name: `Vendor ${uniq()}`,
      msme_registered: true, udyam_number: "UDYAM-MH-05-0001234", msme_category: "MICRO",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.udyam_number).toBe("UDYAM-MH-05-0001234");
    expect(res.data.msme_category).toBe("MICRO");
    expect(res.data.msme_registered).toBe(true);
  });

  it("rejects an Udyam number that is not the notified shape", async () => {
    const res = await post(w.admin, "/api/v1/vendors", {
      code: uniq("VN"), name: `Vendor ${uniq()}`,
      udyam_number: "NOT-A-UDYAM-NUMBER", msme_category: "SMALL",
    });
    expect(res.status).toBe(422);
  });

  it("lets an existing vendor's MSME registration be edited, and the edit takes effect in the ageing", async () => {
    const vendor = await msmeVendor();
    const bill = await invoice({ vendor_id: vendor.id, total: 1000, accepted_on: "2026-08-01" });
    const before = await get(w.admin, `/api/v1/ap/ageing?as_of=2026-09-15`);
    const beforeRow = before.data.vendors.find((v: Record<string, unknown>) => v.vendor_id === vendor.id);
    expect(beforeRow.invoices.find((i: Record<string, unknown>) => i.invoice_id === bill.id).is_msme).toBe(true);

    // The generic vendor PATCH (apps/api/src/modules/inventory/routes.ts)
    // validates the whole body against vendorSchema before filtering down to
    // what was actually sent, so code/name -- required, no default -- travel
    // on every edit, not only a full replace.
    const res = await patch(
      { ...w.admin, ...(await ver("vendors", vendor.id)) },
      `/api/v1/vendors/${vendor.id}`,
      { code: vendor.code, name: vendor.name, msme_registered: false },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.msme_registered).toBe(false);

    // Turning registration off takes the vendor out of statutory treatment
    // for the same invoice, even though udyam_number and msme_category are
    // still on file.
    const after = await get(w.admin, `/api/v1/ap/ageing?as_of=2026-09-15`);
    const afterRow = after.data.vendors.find((v: Record<string, unknown>) => v.vendor_id === vendor.id);
    expect(afterRow.invoices.find((i: Record<string, unknown>) => i.invoice_id === bill.id).is_msme).toBe(false);
  });
});

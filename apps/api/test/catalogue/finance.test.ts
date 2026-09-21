/**
 * End-to-end cover for financial control (§45).
 *
 * These run against a real database because the answers depend on things no
 * unit test can stand in for: a unique index refusing a re-imported statement
 * line, a check constraint refusing an unexplained withholding, and a closed
 * period blocking a write that would otherwise succeed.
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

/** A vendor invoice to settle against. */
async function makeInvoice(total: number, dueDate?: string): Promise<string> {
  const r = await w.pool.query(
    `INSERT INTO invoices(org_id, serial_number, vendor_id, hsn, gst_enabled, gst_rate,
       subtotal, tax, total, payment_mode, reference, due_date)
     VALUES($1,$2,$3,'9954',false,0,$4,0,$4,'NEFT','ref',$5) RETURNING id`,
    [w.orgId, uniq("INV"), w.vendorId, total, dueDate ?? null]);
  return String(r.rows[0].id);
}

async function makePayment(amount: number, over: Record<string, unknown> = {}) {
  const res = await post(w.admin, "/api/v1/payments", {
    direction: "PAYABLE", payment_no: uniq("PAY"), paid_on: "2026-09-10",
    amount, mode: "NEFT", ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data;
}

/** A certified RA bill whose net payable is `amount`. */
async function makeCertifiedBill(amount: number): Promise<string> {
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  const project = await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status)
     VALUES($1,$2,$3,'Receipt project','ACTIVE') RETURNING id`,
    [w.orgId, ws.rows[0].id, uniq("PRJ")]);
  const bill = await w.pool.query(
    `INSERT INTO ra_bills(org_id, project_id, bill_no, period_from, period_to, gross_value,
       net_payable, status, certified_at, certified_by, certified_amount)
     VALUES($1,$2,1,'2026-08-01','2026-08-31',$3,$3,'CERTIFIED',now(),$4,$3) RETURNING id`,
    [w.orgId, project.rows[0].id, amount, w.adminId]);
  return String(bill.rows[0].id);
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("financial periods", () => {
  it("refuses two periods covering the same day", async () => {
    // Which period a document falls into would otherwise be a matter of luck.
    const a = await post(w.admin, "/api/v1/financial-periods", {
      code: uniq("P"), starts_on: "2030-01-01", ends_on: "2030-01-31",
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await post(w.admin, "/api/v1/financial-periods", {
      code: uniq("P"), starts_on: "2030-01-15", ends_on: "2030-02-15",
    });
    expect(b.status).toBe(422);
    expect(b.body.code).toBe("PERIOD_OVERLAP");
  });

  it("blocks a payment dated into a closed period", async () => {
    const period = await post(w.admin, "/api/v1/financial-periods", {
      code: uniq("P"), starts_on: "2031-03-01", ends_on: "2031-03-31",
    });
    const closed = await post(
      { ...w.admin, ...(await ver("financial_periods", period.data.id)) },
      `/api/v1/financial-periods/${period.data.id}/closure`, { action: "CLOSE" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    // Closing a month and then letting somebody book into it is the same as
    // not closing it: figures that were signed off move afterwards. Raised as
    // the payment clerk, because the seeded admin is SUPER_ADMIN and holds the
    // period.override that §4.1 reserves for exactly this.
    const res = await post(w.role.PAYROLL_OFFICER, "/api/v1/payments", {
      direction: "RECEIVABLE", payment_no: uniq("PAY"), paid_on: "2031-03-15",
      amount: 1000, mode: "NEFT",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PERIOD_CLOSED");

    // And the reserved override does let it through, which is the whole point
    // of holding it narrowly.
    const override = await post(w.admin, "/api/v1/payments", {
      direction: "RECEIVABLE", payment_no: uniq("PAY"), paid_on: "2031-03-16",
      amount: 1000, mode: "NEFT",
    });
    expect(override.status, JSON.stringify(override.body)).toBe(201);
  });

  it("records who closed a period, and demands a reason to reopen", async () => {
    const period = await post(w.admin, "/api/v1/financial-periods", {
      code: uniq("P"), starts_on: "2032-04-01", ends_on: "2032-04-30",
    });
    await post({ ...w.admin, ...(await ver("financial_periods", period.data.id)) },
      `/api/v1/financial-periods/${period.data.id}/closure`, { action: "CLOSE" });

    const blind = await post(
      { ...w.admin, ...(await ver("financial_periods", period.data.id)) },
      `/api/v1/financial-periods/${period.data.id}/closure`, { action: "REOPEN" });
    expect(blind.status).toBe(422);

    const reopened = await post(
      { ...w.admin, ...(await ver("financial_periods", period.data.id)) },
      `/api/v1/financial-periods/${period.data.id}/closure`,
      { action: "REOPEN", reason: "A credit note arrived after the close" });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.data.closed_by).toBe(w.adminId);
    expect(reopened.data.reopen_reason).toContain("credit note");
  });

  it("allows a date no period covers", async () => {
    // Periods are a control an organisation opts into. Refusing everything
    // until somebody defines a calendar makes it a blocker, not a safeguard.
    const res = await post(w.admin, "/api/v1/payments", {
      direction: "RECEIVABLE", payment_no: uniq("PAY"), paid_on: "2029-06-15",
      amount: 500, mode: "UPI",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe("payment allocation", () => {
  it("settles one invoice from several payments", async () => {
    const invoice = await makeInvoice(1000);
    for (const amount of [400, 350, 250]) {
      const payment = await makePayment(amount);
      const alloc = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
        document_type: "VENDOR_INVOICE", document_id: invoice, amount,
      });
      expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
    }
    const s = await get(w.admin, `/api/v1/documents/vendor-invoice/${invoice}/settlement`);
    expect(s.data.state).toBe("PAID");
    expect(s.data.outstanding).toBe(0);
    expect(s.data.payments).toHaveLength(3);
  });

  it("settles several invoices from one payment", async () => {
    const a = await makeInvoice(300), b = await makeInvoice(700);
    const payment = await makePayment(1000);
    for (const [id, amount] of [[a, 300], [b, 700]] as const) {
      const alloc = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
        document_type: "VENDOR_INVOICE", document_id: id, amount,
      });
      expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
    }
    const detail = await get(w.admin, `/api/v1/payments/${payment.id}`);
    expect(detail.data.unallocated_amount).toBe(0);
  });

  it("treats TDS as settling the invoice", async () => {
    // The payer keeps 2 and deposits it with the government. The invoice is
    // settled — chasing them for it would be wrong.
    const invoice = await makeInvoice(100);
    // The payment records what moved through the bank: 98. The 2 never
    // reached us — the payer deposited it with the government.
    const payment = await makePayment(98);
    const alloc = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: invoice, amount: 98, tds_amount: 2,
    });
    expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
    const s = await get(w.admin, `/api/v1/documents/vendor-invoice/${invoice}/settlement`);
    expect(s.data.state).toBe("PAID");
    expect(s.data.settledNonCash).toBe(2);
  });

  it("does not let two receipts settle the same bill at once", async () => {
    // Each read the whole balance as free; without a lock on the document both
    // were accepted and the invoice was settled twice over.
    const invoice = await makeInvoice(1000);
    const [p1, p2] = [await makePayment(1000), await makePayment(1000)];
    const results = await Promise.all([p1, p2].map(p =>
      post(w.admin, `/api/v1/payments/${p.id}/allocations`, {
        document_type: "VENDOR_INVOICE", document_id: invoice, amount: 1000,
      })));
    expect(results.map(r => r.status).sort()).toEqual([201, 422]);
    const s = await get(w.admin, `/api/v1/documents/vendor-invoice/${invoice}/settlement`);
    expect(s.data.outstanding).toBe(0);
    expect(s.data.payments).toHaveLength(1);
  });

  it("does not treat retention as settling the invoice", async () => {
    // The 5 held back is still owed; counting it as paid writes off real money.
    const invoice = await makeInvoice(100);
    const payment = await makePayment(95);
    const alloc = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: invoice, amount: 95, retention_amount: 5,
    });
    expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
    const s = await get(w.admin, `/api/v1/documents/vendor-invoice/${invoice}/settlement`);
    expect(s.data.state).toBe("PARTIALLY_PAID");
    expect(s.data.outstanding).toBe(5);
    expect(s.data.deferred).toBe(5);
  });

  it("refuses to apply more than the document has outstanding", async () => {
    const invoice = await makeInvoice(100);
    const payment = await makePayment(500);
    const res = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: invoice, amount: 200,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EXCEEDS_DOCUMENT");
  });

  it("refuses to apply more of a payment than remains", async () => {
    const a = await makeInvoice(1000), b = await makeInvoice(1000);
    const payment = await makePayment(500);
    await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: a, amount: 400,
    });
    const res = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: b, amount: 300,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EXCEEDS_PAYMENT");
  });

  it("demands a reason for a discretionary withholding", async () => {
    const invoice = await makeInvoice(1000);
    const payment = await makePayment(1000);
    const res = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: invoice, amount: 900, other_deduction: 100,
    });
    expect(res.status).toBe(422);
  });

  it("reports what is still unallocated", async () => {
    // Money arrives before anybody knows which invoices it settles.
    const payment = await makePayment(1000);
    const invoice = await makeInvoice(1000);
    await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: invoice, amount: 600,
    });
    const list = await get(w.admin, "/api/v1/payments?unallocated=true&limit=100");
    const row = list.data.find((p: any) => p.id === payment.id);
    expect(row.unallocated_amount).toBe(400);
  });
});

describe("reversal", () => {
  it("never deletes — it reverses, and releases what the payment settled", async () => {
    const invoice = await makeInvoice(500);
    const payment = await makePayment(500);
    await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: invoice, amount: 500,
    });
    expect((await get(w.admin, `/api/v1/documents/vendor-invoice/${invoice}/settlement`)).data.state)
      .toBe("PAID");

    const reversed = await post(
      { ...w.admin, ...(await ver("payments", payment.id)) },
      `/api/v1/payments/${payment.id}/reverse`, { reason: "Banked against the wrong vendor" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);

    // The row is still there — a financial record that can vanish cannot be
    // audited — and the invoice is outstanding again.
    const still = await w.pool.query("SELECT reversed_at, reversal_reason FROM payments WHERE id = $1", [payment.id]);
    expect(still.rows[0].reversed_at).toBeTruthy();
    expect(still.rows[0].reversal_reason).toContain("wrong vendor");

    const after = await get(w.admin, `/api/v1/documents/vendor-invoice/${invoice}/settlement`);
    expect(after.data.state).toBe("UNPAID");
    expect(after.data.outstanding).toBe(500);
  });

  it("will not allocate a reversed payment", async () => {
    const payment = await makePayment(100);
    await post({ ...w.admin, ...(await ver("payments", payment.id)) },
      `/api/v1/payments/${payment.id}/reverse`, { reason: "Duplicate entry" });
    const invoice = await makeInvoice(100);
    const res = await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: invoice, amount: 100,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PAYMENT_REVERSED");
  });

  it("demands a reason to reverse", async () => {
    const payment = await makePayment(100);
    const res = await post({ ...w.admin, ...(await ver("payments", payment.id)) },
      `/api/v1/payments/${payment.id}/reverse`, {});
    expect(res.status).toBe(422);
  });
});

describe("bank reconciliation", () => {
  const line = (ref: string, amount: number) => ({
    statement_ref: ref, value_date: "2026-09-10", amount, narration: "NEFT credit",
  });

  it("imports a statement once, however many times the file is loaded", async () => {
    const ref = uniq("ST");
    const first = await post(w.admin, "/api/v1/bank-transactions/import", {
      bank_account: "HDFC-001", transactions: [line(ref, 5000)],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.data.created).toBe(1);

    const again = await post(w.admin, "/api/v1/bank-transactions/import", {
      bank_account: "HDFC-001", transactions: [line(ref, 5000)],
    });
    expect(again.data.created).toBe(0);
    expect(again.data.applied).toBe(1);

    const rows = await w.pool.query(
      "SELECT count(*)::int AS n FROM bank_transactions WHERE statement_ref = $1", [ref]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("never silently overwrites a line a person reconciled", async () => {
    const ref = uniq("ST");
    await post(w.admin, "/api/v1/bank-transactions/import", {
      bank_account: "HDFC-001", transactions: [line(ref, 5000)],
    });
    const payment = await makePayment(5000);
    const row = await w.pool.query(
      "SELECT id FROM bank_transactions WHERE statement_ref = $1", [ref]);
    const reconciled = await post(
      { ...w.admin, ...(await ver("bank_transactions", row.rows[0].id)) },
      `/api/v1/bank-transactions/${row.rows[0].id}/reconcile`, { payment_id: payment.id });
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    expect(reconciled.data.reconciliation_status).toBe("RECONCILED");

    // The feed now disagrees with what a person confirmed. It does not get to
    // decide it was right and they were wrong.
    const conflicting = await post(w.admin, "/api/v1/bank-transactions/import", {
      bank_account: "HDFC-001", transactions: [line(ref, 7000)],
    });
    expect(conflicting.data.exceptions).toBe(1);
    expect(conflicting.data.flagged[0].note).toContain("7000");

    const after = await w.pool.query(
      "SELECT amount, reconciliation_status FROM bank_transactions WHERE statement_ref = $1", [ref]);
    expect(Number(after.rows[0].amount)).toBe(5000);
    expect(after.rows[0].reconciliation_status).toBe("EXCEPTION");
  });

  it("leaves an unchanged reconciled line alone", async () => {
    const ref = uniq("ST");
    await post(w.admin, "/api/v1/bank-transactions/import", {
      bank_account: "HDFC-001", transactions: [line(ref, 2500)],
    });
    const payment = await makePayment(2500);
    const row = await w.pool.query("SELECT id FROM bank_transactions WHERE statement_ref = $1", [ref]);
    await post({ ...w.admin, ...(await ver("bank_transactions", row.rows[0].id)) },
      `/api/v1/bank-transactions/${row.rows[0].id}/reconcile`, { payment_id: payment.id });

    const same = await post(w.admin, "/api/v1/bank-transactions/import", {
      bank_account: "HDFC-001", transactions: [line(ref, 2500)],
    });
    expect(same.data.skipped).toBe(1);
    expect(same.data.exceptions).toBe(0);
  });

  it("reports a partial match rather than rounding the difference away", async () => {
    // The statement is the bank's record and the payment is ours; where they
    // disagree the difference is the point.
    const ref = uniq("ST");
    await post(w.admin, "/api/v1/bank-transactions/import", {
      bank_account: "HDFC-001", transactions: [line(ref, 5000)],
    });
    const payment = await makePayment(4800);
    const row = await w.pool.query("SELECT id FROM bank_transactions WHERE statement_ref = $1", [ref]);
    const res = await post({ ...w.admin, ...(await ver("bank_transactions", row.rows[0].id)) },
      `/api/v1/bank-transactions/${row.rows[0].id}/reconcile`, { payment_id: payment.id });
    expect(res.data.reconciliation_status).toBe("PARTIALLY_MATCHED");
    expect(res.data.exception_note).toContain("4800");
  });
});

describe("invoice lifecycle", () => {
  it("will not take an issued invoice back to draft", async () => {
    const id = await makeInvoice(100);
    const res = await post(w.admin, `/api/v1/invoices/${id}/status`, { status: "DRAFT" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_TRANSITION");
  });

  it("demands a reason to cancel", async () => {
    const id = await makeInvoice(100);
    const blind = await post(w.admin, `/api/v1/invoices/${id}/status`, { status: "CANCELLED" });
    expect(blind.status).toBe(422);
    const res = await post(w.admin, `/api/v1/invoices/${id}/status`,
      { status: "CANCELLED", reason: "Raised against the wrong vendor" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.cancelled_reason).toContain("wrong vendor");
  });

  it("carries disputed alongside the status rather than instead of it", async () => {
    // The invoice a client disputes is exactly the one that goes overdue, and
    // a single enum could only say one of those things.
    const id = await makeInvoice(1000, "2026-01-01");
    const res = await post(w.admin, `/api/v1/invoices/${id}/dispute`,
      { disputed: true, reason: "Quantities do not match the delivery note" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.disputed).toBe(true);
    expect(res.data.lifecycle_status).toBe("ISSUED");
  });

  it("demands to know what is being disputed", async () => {
    const id = await makeInvoice(100);
    expect((await post(w.admin, `/api/v1/invoices/${id}/dispute`, { disputed: true })).status).toBe(422);
  });
});

describe("outstanding ledger", () => {
  it("ages what is outstanding, and keeps disputed in its own column", async () => {
    const overdue = await makeInvoice(1000, "2020-01-01");
    const disputed = await makeInvoice(2000, "2020-01-01");
    await post(w.admin, `/api/v1/invoices/${disputed}/dispute`,
      { disputed: true, reason: "Rate not as agreed" });

    const res = await get(w.admin, "/api/v1/finance/outstanding?as_of=2026-09-15");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.buckets.older).toBeGreaterThanOrEqual(1000);
    expect(res.data.buckets.disputed).toBeGreaterThanOrEqual(2000);
    const row = res.data.items.find((i: any) => i.id === overdue);
    expect(row.overdue).toBe(true);
  });

  it("leaves a settled invoice out, however late it was paid", async () => {
    // A paid invoice is history, not a receivable.
    const id = await makeInvoice(400, "2020-01-01");
    const payment = await makePayment(400);
    await post(w.admin, `/api/v1/payments/${payment.id}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: id, amount: 400,
    });
    const res = await get(w.admin, "/api/v1/finance/outstanding?as_of=2026-09-15");
    expect(res.data.items.find((i: any) => i.id === id)).toBeUndefined();
  });
});

describe("permissions", () => {
  it("keeps a project manager to reading the money", async () => {
    expect((await get(w.role.PROJECT_MANAGER, "/api/v1/payments")).status).toBe(200);
    expect((await post(w.role.PROJECT_MANAGER, "/api/v1/payments", {
      direction: "RECEIVABLE", payment_no: uniq("PAY"), paid_on: "2026-09-10",
      amount: 100, mode: "NEFT",
    })).status).toBe(403);
  });

  it("keeps the auditor out of every write", async () => {
    expect((await get(w.role.AUDITOR, "/api/v1/financial-periods")).status).toBe(200);
    expect((await post(w.role.AUDITOR, "/api/v1/financial-periods", {
      code: uniq("P"), starts_on: "2033-01-01", ends_on: "2033-01-31",
    })).status).toBe(403);
  });

  it("will not let a payment clerk close a period", async () => {
    expect((await post(w.role.PAYROLL_OFFICER, "/api/v1/financial-periods", {
      code: uniq("P"), starts_on: "2034-01-01", ends_on: "2034-01-31",
    })).status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("will not read another organisation's payment", async () => {
    const payment = await makePayment(100);
    expect((await get(w.other.admin, `/api/v1/payments/${payment.id}`)).status).toBe(404);
  });
});

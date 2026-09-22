/**
 * Gaps found by the finance QA pass, pinned so they stay closed.
 *
 * Each block is one route the live system accepted something it should have
 * refused, or refused somebody it should have served.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchAllowsPayment } from "@silverline/shared";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

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

async function ver(table: string, id: string): Promise<Headers> {
  const r = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  return { "if-match": String(r.rows[0].version) };
}

/** A project with one BOQ line and one submitted bill worth 45,000 + 18% GST. */
async function submittedBill() {
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  const project = (await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status, contract_value)
     VALUES($1,$2,$3,'QA billing','ACTIVE',10000000) RETURNING id`,
    [w.orgId, ws.rows[0].id, uniq("PRJ")])).rows[0];
  const boq = await post(w.admin, `/api/v1/projects/${project.id}/boq`, {
    item_code: "1.1", description: "Earthwork", unit: "cum", quantity: 1000, rate: 450,
  });
  expect(boq.status, JSON.stringify(boq.body)).toBe(201);
  const policy = await send("PUT", w.admin, `/api/v1/projects/${project.id}/billing-policy`, {
    retention_pct: 5, gst_rate_pct: 18, payment_terms_days: 30,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  const bill = await post(w.admin, "/api/v1/ra-bills", {
    project_id: String(project.id), period_from: "2026-08-01", period_to: "2026-08-31",
    lines: [{ boq_item_id: boq.data.id, cumulative_quantity: 100 }],
  });
  expect(bill.status, JSON.stringify(bill.body)).toBe(201);
  const submitted = await post({ ...w.admin, ...(await ver("ra_bills", bill.data.id)) },
    `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return { projectId: String(project.id), billId: String(bill.data.id), gross: 45000, gst: 8100 };
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("certifying an RA bill", () => {
  it("refuses a negative or non-numeric certified amount", async () => {
    // Live, -5000 became the receivable and the client's statement went negative.
    const { billId } = await submittedBill();
    for (const certified_amount of [-5000, "abc"]) {
      const res = await post({ ...w.admin, ...(await ver("ra_bills", billId)) },
        `/api/v1/ra-bills/${billId}/status`, { status: "CERTIFIED", certified_amount });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    const row = await w.pool.query("SELECT status FROM ra_bills WHERE id=$1", [billId]);
    expect(row.rows[0].status).toBe("SUBMITTED");
  });

  it("refuses a certified amount above the work plus its tax, and takes one below", async () => {
    const { billId, gross, gst } = await submittedBill();
    const over = await post({ ...w.admin, ...(await ver("ra_bills", billId)) },
      `/api/v1/ra-bills/${billId}/status`, { status: "CERTIFIED", certified_amount: gross + gst + 0.01 });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("EXCEEDS_CLAIM");
    const ok = await post({ ...w.admin, ...(await ver("ra_bills", billId)) },
      `/api/v1/ra-bills/${billId}/status`, { status: "CERTIFIED", certified_amount: 40000 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(Number(ok.data.certified_amount)).toBe(40000);
    expect(ok.data.due_date).toBeTruthy();
  });

  it("refuses a status that is not one of the bill's", async () => {
    const { billId } = await submittedBill();
    const res = await post({ ...w.admin, ...(await ver("ra_bills", billId)) },
      `/api/v1/ra-bills/${billId}/status`, { status: "PAIDD" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("releasing retention", () => {
  it("refuses a negative amount rather than withholding more", async () => {
    const { projectId } = await submittedBill();
    const res = await post(w.admin, `/api/v1/projects/${projectId}/retention/release`, { amount: -100, reason: "x" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("ledger dates", () => {
  it("refuses an ageing as at a date that is not one", async () => {
    // AR came back as a 500; AP aged everything "as at nope".
    for (const url of ["/api/v1/ar/ageing?as_of=garbage", "/api/v1/ap/ageing?as_of=nope", "/api/v1/ar/ageing?as_of=2026-02-30"]) {
      const res = await get(w.admin, url);
      expect(res.status, url).toBe(422);
      expect(res.body.field_errors[0].field).toBe("as_of");
    }
    const ok = await get(w.admin, "/api/v1/ap/ageing?as_of=2026-09-22");
    expect(ok.status).toBe(200);
    expect(ok.data.as_of).toBe("2026-09-22");
  });

  it("refuses a statement whose window ends before it starts", async () => {
    const client = await post(w.admin, "/api/v1/clients", { name: `QA client ${uniq()}`, client_type: "PRIVATE" });
    expect(client.status, JSON.stringify(client.body)).toBe(201);
    const res = await get(w.admin, `/api/v1/ar/statement/${client.data.id}?from=2026-12-01&to=2026-09-01`);
    expect(res.status).toBe(422);
    const bad = await get(w.admin, `/api/v1/ar/statement/${client.data.id}?from=yesterday`);
    expect(bad.status).toBe(422);
  });
});

describe("payables", () => {
  it("pays an invoice with no purchase order without an override", () => {
    // The ledger stores UNMATCHED by default, never null; reading only null
    // made every utility bill unpayable without match.override.
    expect(matchAllowsPayment({ matchStatus: "UNMATCHED", hasPurchaseOrder: false })).toBe(true);
    expect(matchAllowsPayment({ matchStatus: null, hasPurchaseOrder: false })).toBe(true);
    expect(matchAllowsPayment({ matchStatus: "UNMATCHED", hasPurchaseOrder: true })).toBe(false);
    expect(matchAllowsPayment({ matchStatus: "EXCEPTION", hasPurchaseOrder: false })).toBe(false);
  });

  it("moves the invoice's version when it is held, and lists invoices for invoice.read", async () => {
    const invoice = (await w.pool.query(
      `INSERT INTO invoices(org_id, serial_number, vendor_id, hsn, gst_enabled, gst_rate,
         subtotal, tax, total, payment_mode, reference)
       VALUES($1,$2,$3,'9954',false,0,1000,0,1000,'BANK','ref') RETURNING id, version`,
      [w.orgId, uniq("INV"), w.vendorId])).rows[0];
    const held = await post(w.admin, `/api/v1/ap/invoices/${invoice.id}/hold`, { on_hold: true, reason: "query on quantity" });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(Number(held.data.version)).toBe(Number(invoice.version ?? 0) + 1);
    // The payables officer holds invoice.read and invoice.manage but no stores permission.
    const list = await get(w.role.PAYROLL_OFFICER, "/api/v1/invoices");
    expect(list.status).toBe(200);
    expect(list.data.some((i: any) => i.id === invoice.id)).toBe(true);
    expect((await get(w.role.EMPLOYEE, "/api/v1/invoices")).status).toBe(403);
  });
});

describe("reads that were gated on a write", () => {
  it("lets the auditor read asset audits", async () => {
    expect((await get(w.role.AUDITOR, "/api/v1/asset-audits")).status).toBe(200);
    expect((await get(w.role.EMPLOYEE, "/api/v1/asset-audits")).status).toBe(200);
  });
});

describe("tender corrigenda", () => {
  it("validates the amended values like the tender itself", async () => {
    const tender = await post(w.admin, "/api/v1/tenders", { tender_no: uniq("T"), tender_type: "OPEN", estimated_value: "100000" });
    expect(tender.status, JSON.stringify(tender.body)).toBe(201);
    const bad = await post(w.admin, `/api/v1/tenders/${tender.data.id}/corrigenda`, {
      corrigendum_no: "C1", date_issued: "2026-09-22", summary: "garbage", changes: { closing_date: "not-a-date" },
    });
    expect(bad.status).toBe(422);
    const negative = await post(w.admin, `/api/v1/tenders/${tender.data.id}/corrigenda`, {
      corrigendum_no: "C2", date_issued: "2026-09-22", summary: "negative", changes: { estimated_value: -5 },
    });
    expect(negative.status).toBe(422);
    const ok = await post(w.admin, `/api/v1/tenders/${tender.data.id}/corrigenda`, {
      corrigendum_no: "C3", date_issued: "2026-09-22", summary: "extended", changes: { closing_date: "2026-10-20" },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const row = await w.pool.query("SELECT estimated_value, closing_date::text FROM tenders WHERE id=$1", [tender.data.id]);
    expect(Number(row.rows[0].estimated_value)).toBe(100000);
    expect(row.rows[0].closing_date).toBe("2026-10-20");
  });
});

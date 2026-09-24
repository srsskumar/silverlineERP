// R5 post-deploy live smoke: one check per deploy-2 feature, against the
// real deployed API as admin. Creates its own QA- throwaway records.
import { loginAs, loadDataset, call } from "../integrations/qalib.mjs";
import crypto from "node:crypto";

const ds = loadDataset();
const admin = await loginAs("qa-admin-superadmin");
const T = admin.access_token;
const rand = Math.random().toString(36).slice(2, 8);
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) failures++;
};

// -- 1. vendor invoice lines from a PO + three-way match (exact 4dp rate) --
let newInvoiceId = null;
{
  const po = await call(T, "GET", `/purchase-orders/${ds.procurement.poId}`);
  const line = po.body?.data?.lines?.find(l => Number(l.receivedQuantity ?? l.received_quantity ?? 0) > 0)
    ?? po.body?.data?.lines?.[0];
  if (po.status === 200 && line) {
    const rate4dp = Math.round(Number(line.unit_rate) * 10000) / 10000;
    const qty = Number(line.receivedQuantity ?? line.received_quantity ?? line.quantity);
    const inv = await call(T, "POST", "/invoices", {
      serial_number: `QA-R5-INV-${rand}`,
      vendor_id: ds.procurement.vendorId,
      purchase_order_id: ds.procurement.poId,
      hsn: line.hsn_sac ?? "0000",
      gst_enabled: false,
      gst_rate: "0",
      subtotal: String(qty * rate4dp),
      payment_mode: "BANK",
      reference: `QA-R5-INV-${rand}`,
      lines: [{
        po_line_id: line.id, item_id: line.item_id ?? null,
        description: line.description, hsn_sac: line.hsn_sac ?? "0000",
        quantity: qty, unit_rate: rate4dp, gst_rate_pct: 0,
      }],
    });
    check("vendor invoice create w/ po_line_id -> 201", inv.status === 201, `status=${inv.status} body=${JSON.stringify(inv.body).slice(0,200)}`);
    // R5-001 FIXED: POST /invoices now wraps as {data: row} like every other
    // create this route exposes. Kept the dual-tolerant read below anyway --
    // cheap, and harmless if anything ever reverts it.
    const invId = inv.body?.data?.id ?? inv.body?.id;
    newInvoiceId = invId;
    if (invId) {
      const m = await call(T, "POST", `/invoices/${invId}/match`);
      check("three-way match: exact 4dp rate -> MATCH", m.status === 201 && m.body?.data?.matched === true,
        `status=${m.status} matched=${m.body?.data?.matched} exceptions=${JSON.stringify(m.body?.data?.exceptions)}`);
    }
  } else {
    check("vendor invoice / match setup", false, `po fetch status=${po.status}, no line found`);
  }
}

// -- 2. approval policy -----------------------------------------------------
{
  const p = await call(T, "POST", "/approval-policies", {
    document_type: "PURCHASE_ORDER", name: `QA R5 policy ${rand}`, mode: "CUMULATIVE",
    tolerance_pct: 5, active: true,
    levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_role: "ADMIN", sla_hours: 48 }],
  });
  check("approval policy create -> 201", p.status === 201, `status=${p.status} body=${JSON.stringify(p.body).slice(0,200)}`);
}

// -- 3. payment + allocation -------------------------------------------------
{
  const pay = await call(T, "POST", "/payments", {
    direction: "PAYABLE", payment_no: `QA-R5-PAY-${rand}`, paid_on: "2026-09-24",
    amount: 100, mode: "NEFT", party_type: "VENDOR", party_id: ds.procurement.vendorId,
  });
  check("payment create -> 201", pay.status === 201, `status=${pay.status} body=${JSON.stringify(pay.body).slice(0,200)}`);
  const payId = pay.body?.data?.id;
  if (payId) {
    const alloc = await call(T, "POST", `/payments/${payId}/allocations`, {
      document_type: "VENDOR_INVOICE", document_id: newInvoiceId ?? ds.procurement.invoiceId, amount: 100,
    });
    check("payment allocation -> 201", alloc.status === 201, `status=${alloc.status} body=${JSON.stringify(alloc.body).slice(0,200)}`);
  }
}

// -- 4. bank CSV import, 1 bad row must block the whole batch ---------------
{
  const good = { statement_ref: `QA-R5-BANK-${rand}-1`, value_date: "2026-09-24", amount: 500, narration: "QA good row" };
  const bad = { statement_ref: `QA-R5-BANK-${rand}-2`, value_date: "not-a-date", amount: 500 };
  const imp = await call(T, "POST", "/bank-transactions/import", { transactions: [good, bad] });
  check("bank import: 1 bad row -> blocked (4xx, not partial)", imp.status >= 400 && imp.status < 500,
    `status=${imp.status} body=${JSON.stringify(imp.body).slice(0,200)}`);
  const list = await call(T, "GET", `/bank-transactions?q=${encodeURIComponent(good.statement_ref)}`);
  const leaked = (list.body?.data ?? []).some(r => r.statement_ref === good.statement_ref);
  check("bank import: good row not applied when batch blocked", !leaked, `found=${leaked}`);

  const cleanImp = await call(T, "POST", "/bank-transactions/import", { transactions: [good] });
  check("bank import: clean single row -> 200/201", cleanImp.status === 200 || cleanImp.status === 201, `status=${cleanImp.status}`);
}

// -- 5. financial period close + reopen --------------------------------------
{
  const code = `QA-R5-${rand}`;
  // Unique, far-future day range keyed to this run so re-runs never collide
  // with a period a previous run left behind (PERIOD_OVERLAP).
  const day = 1 + (Date.now() % 27);
  const dd = String(day).padStart(2, "0");
  const per = await call(T, "POST", "/financial-periods", { code, starts_on: `2031-01-${dd}`, ends_on: `2031-01-${dd}` });
  check("financial period create -> 201", per.status === 201, `status=${per.status} body=${JSON.stringify(per.body).slice(0,200)}`);
  const perId = per.body?.data?.id;
  if (perId) {
    const close = await call(T, "POST", `/financial-periods/${perId}/closure`, { action: "CLOSE" }, { "if-match": String(per.body.data.version ?? 1) });
    check("financial period close -> 200", close.status === 200, `status=${close.status} body=${JSON.stringify(close.body).slice(0,200)}`);
    const noReason = await call(T, "POST", `/financial-periods/${perId}/closure`, { action: "REOPEN" }, { "if-match": String(close.body?.data?.version ?? 2) });
    check("financial period reopen w/o reason -> 4xx (validation)", noReason.status >= 400 && noReason.status < 500, `status=${noReason.status}`);
    const reopen = await call(T, "POST", `/financial-periods/${perId}/closure`, { action: "REOPEN", reason: "QA R5 regression reopen" }, { "if-match": String(close.body?.data?.version ?? 2) });
    check("financial period reopen w/ reason -> 200", reopen.status === 200, `status=${reopen.status} body=${JSON.stringify(reopen.body).slice(0,200)}`);
  }
}

// -- 6. shift -----------------------------------------------------------------
{
  const sh = await call(T, "POST", "/shifts", {
    code: `qar5${rand}`, name: `QA R5 Shift ${rand}`, starts_at: "09:00", ends_at: "18:00",
    break_minutes: 60, effective_from: "2026-09-24", active: true,
  });
  check("shift create -> 201", sh.status === 201, `status=${sh.status} body=${JSON.stringify(sh.body).slice(0,200)}`);
}

// -- 7. stock reservation ---------------------------------------------------
{
  const locs = await call(T, "GET", "/stock-locations?limit=20");
  let stocked = null;
  for (const l of locs.body?.data ?? []) {
    const s = await call(T, "GET", `/stock-locations/${l.id}/stock`);
    const row = (s.body?.data ?? []).find(r => Number(r.available) >= 2);
    if (row) { stocked = { locId: l.id, itemId: row.item_id, available: row.available }; break; }
  }
  if (stocked) {
    const res = await call(T, "POST", "/stock-reservations", {
      item_id: stocked.itemId, location_id: stocked.locId, quantity: 1,
      project_id: ds.projects["QA-SEED-ACTIVE"],
      notes: "QA R5 regression reservation",
    });
    check("stock reservation create -> 201", res.status === 201, `status=${res.status} body=${JSON.stringify(res.body).slice(0,200)}`);
    const resId = res.body?.data?.id;
    if (resId) {
      // over-reserving beyond what remains available must still be refused
      // (this is the exact scenario deploy-2's stock-reservation concurrency
      // fix targets).
      const over = await call(T, "POST", "/stock-reservations", {
        item_id: stocked.itemId, location_id: stocked.locId, quantity: 10000,
        project_id: ds.projects["QA-SEED-ACTIVE"], notes: "QA R5 over-reserve probe",
      });
      check("stock reservation: over-reserve beyond available -> 422 INSUFFICIENT_STOCK",
        over.status === 422 && over.body?.code === "INSUFFICIENT_STOCK", `status=${over.status} code=${over.body?.code}`);

      const rel = await call(T, "POST", `/stock-reservations/${resId}/release`, {}, { "if-match": String(res.body.data.version ?? 1) });
      check("stock reservation release -> 200", rel.status === 200, `status=${rel.status}`);
    }
  } else {
    check("stock reservation setup", false, `no location/item with >=2 available stock found`);
  }
}

// -- 8. tender instrument -------------------------------------------------------
{
  const ins = await call(T, "POST", "/instruments", {
    instrument_type: "EMD", issuing_bank: "QA Test Bank", instrument_number: `QA-R5-${rand}`,
    amount: 10000, issue_date: "2026-09-24", expiry_date: "2027-09-24", tender_id: ds.crm.tenderId,
  });
  check("tender instrument create -> 201", ins.status === 201, `status=${ins.status} body=${JSON.stringify(ins.body).slice(0,200)}`);
}

// -- 9. legal hold place + release ----------------------------------------------
{
  const docBefore = await call(T, "GET", `/documents/${ds.documentId}`);
  const v1 = docBefore.body?.data?.version;
  const hold = await call(T, "POST", `/documents/${ds.documentId}/legal-hold`, { legal_hold: true, reason: "QA R5 regression hold" }, { "if-match": String(v1) });
  check("legal hold place -> 200", hold.status === 200, `status=${hold.status} body=${JSON.stringify(hold.body).slice(0,200)}`);
  if (hold.status === 200) {
    const del = await call(T, "DELETE", `/documents/${ds.documentId}`, undefined, { "if-match": String(hold.body?.data?.version) });
    check("delete blocked while on legal hold -> RETENTION_BLOCKED", del.status === 409 && del.body?.code === "RETENTION_BLOCKED", `status=${del.status} body=${JSON.stringify(del.body).slice(0,150)}`);
    const v2 = hold.body?.data?.version;
    const rel = await call(T, "POST", `/documents/${ds.documentId}/legal-hold`, { legal_hold: false }, { "if-match": String(v2) });
    check("legal hold release -> 200", rel.status === 200, `status=${rel.status}`);
  }
}

// -- 10. PO amend -----------------------------------------------------------------
{
  let poId = ds.procurement.poId;
  let po = await call(T, "GET", `/purchase-orders/${poId}`);
  if (po.status !== 200 || ["CLOSED", "CANCELLED", "FULLY_RECEIVED"].includes(po.body?.data?.status)) {
    const list = await call(T, "GET", "/purchase-orders?limit=20");
    const alt = (list.body?.data ?? []).find(p => !["CLOSED", "CANCELLED", "FULLY_RECEIVED"].includes(p.status));
    if (alt) { poId = alt.id; po = await call(T, "GET", `/purchase-orders/${poId}`); }
  }
  const line = po.body?.data?.lines?.[0];
  if (po.status === 200 && line && !["CLOSED", "CANCELLED", "FULLY_RECEIVED"].includes(po.body.data.status)) {
    const amend = await call(T, "POST", `/purchase-orders/${poId}/amend`, {
      reason: "QA R5 regression amendment",
      lines: [{ po_line_id: line.id, quantity: Number(line.quantity) + 1 }],
    }, { "if-match": String(po.body.data.version) });
    check("PO amend -> 200/201", amend.status === 200 || amend.status === 201, `status=${amend.status} body=${JSON.stringify(amend.body).slice(0,200)}`);
  } else {
    check("PO amend setup", false, `no amendable PO found (last status=${po.body?.data?.status})`);
  }
}

// -- 11. document delete (throwaway doc, not the seeded one) --------------------
{
  const up = await call(T, "POST", "/documents", {
    type_code: "AGREEMENT", owner_type: "project", owner_id: ds.projects["QA-SEED-ACTIVE"],
    title: `QA R5 throwaway doc ${rand}`, issued_on: "2000-01-01",
  });
  const docId = up.body?.data?.id;
  const docVer = up.body?.data?.version;
  if (up.status === 201 && docId) {
    const del = await call(T, "DELETE", `/documents/${docId}`, undefined, { "if-match": String(docVer) });
    check("document delete (no hold) -> 200/204", del.status === 200 || del.status === 204, `status=${del.status} body=${JSON.stringify(del.body).slice(0,150)}`);
  } else {
    console.log(`NOTE  document delete: throwaway doc upload failed status=${up.status} body=${JSON.stringify(up.body).slice(0,200)}`);
  }
}

console.log(`\n=== deploy-2 smoke: ${failures} failure(s) ===`);
process.exit(failures ? 1 : 0);

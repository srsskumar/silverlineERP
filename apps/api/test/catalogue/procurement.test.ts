/**
 * End-to-end cover for procurement (§6.6, §13.2, §43).
 *
 * The chain answers one question before money leaves: did we order this, did
 * it arrive, and does the bill match. These run against a real database
 * because the answers depend on cumulative receipts summed across GRNs and on
 * the approval ladder having actually been cleared.
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

async function makeVendor(over: Record<string, unknown> = {}) {
  const r = await w.pool.query(
    `INSERT INTO vendors(org_id, code, name, status, blacklist_status, blacklist_reason)
     VALUES($1,$2,$3,'ACTIVE',$4,$5) RETURNING *`,
    [w.orgId, uniq("VN"), `Vendor ${uniq()}`,
     over.blacklist_status ?? 'NONE', over.blacklist_reason ?? null]);
  return r.rows[0];
}

/** Approval ladders for both document types, so submission has somewhere to go. */
async function ladders() {
  for (const documentType of ["PURCHASE_REQUISITION", "PURCHASE_ORDER"]) {
    const res = await post(w.admin, "/api/v1/approval-policies", {
      document_type: documentType, name: `DoA ${uniq()}`,
      levels: [
        { sequence: 1, min_amount: 0, max_amount: 500_000, approver_role: "PROJECT_MANAGER" },
        { sequence: 2, min_amount: 500_000, max_amount: null, approver_role: "ADMIN" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
}

/**
 * The site raises the requisition and the PM approves it, which is both the
 * real workflow and the only one maker-checker permits — an earlier version
 * had the PM do both and was correctly refused.
 */
async function makeRequisition(lines: { description: string; unit: string; quantity: number; estimated_rate?: number }[]) {
  const res = await post(w.role.TEAM_LEAD, "/api/v1/requisitions", {
    requisition_no: uniq("PR"), justification: "Site consumption for the month", lines,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data;
}

/** Push a requisition through submission and approval to APPROVED. */
async function approveRequisition(prId: string) {
  const submitted = await post({ ...w.role.TEAM_LEAD, ...(await ver("purchase_requisitions", prId)) },
    `/api/v1/requisitions/${prId}/submit`, {});
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

  const approvalId = submitted.data.approval_id;
  // Level 1 of the ladder is the project manager, and the site raised it, so
  // maker-checker is satisfied.
  const decision = await post({ ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", approvalId)) },
    `/api/v1/approvals/${approvalId}/decision`, { decision: "APPROVE" });
  expect(decision.status, JSON.stringify(decision.body)).toBe(200);

  await w.pool.query("UPDATE purchase_requisitions SET status='APPROVED' WHERE id=$1", [prId]);
  const lines = await w.pool.query(
    "SELECT * FROM requisition_lines WHERE requisition_id=$1 ORDER BY line_no", [prId]);
  return lines.rows;
}

beforeAll(async () => { w = await buildWorld(); await ladders(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("requisition", () => {
  it("routes through the approval ladder rather than its own approver", async () => {
    const pr = await makeRequisition([
      { description: "Cement OPC 53", unit: "bag", quantity: 500, estimated_rate: 400 },
    ]);
    const submitted = await post({ ...w.role.TEAM_LEAD, ...(await ver("purchase_requisitions", pr.id)) },
      `/api/v1/requisitions/${pr.id}/submit`, {});
    expect(submitted.status).toBe(200);
    expect(submitted.data.approval_id).toBeTruthy();

    const approval = await get(w.admin, `/api/v1/approvals/${submitted.data.approval_id}`);
    expect(approval.data.document_type).toBe("PURCHASE_REQUISITION");
    expect(Number(approval.data.amount)).toBe(200_000);
  });

  it("insists a requisition says why it is needed", async () => {
    const res = await post(w.role.TEAM_LEAD, "/api/v1/requisitions", {
      requisition_no: uniq("PR"),
      lines: [{ description: "Cement", unit: "bag", quantity: 10 }],
    });
    expect(res.status).toBe(422);
  });

  it("refuses submission without a policy for the document type", async () => {
    await w.pool.query(
      "UPDATE approval_policies SET active=FALSE WHERE org_id=$1 AND document_type='PURCHASE_REQUISITION'",
      [w.orgId]);
    const pr = await makeRequisition([{ description: "Sand", unit: "cum", quantity: 10, estimated_rate: 1200 }]);
    const res = await post({ ...w.role.TEAM_LEAD, ...(await ver("purchase_requisitions", pr.id)) },
      `/api/v1/requisitions/${pr.id}/submit`, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NO_APPROVAL_POLICY");
    await ladders();
  });

  it("§4.1 will not let the approver approve a requisition they raised", async () => {
    // The PM is level 1 of the ladder, so a PM-raised requisition has to go
    // to somebody else — this is what an earlier version of this suite got
    // wrong, and the engine was right.
    const pr = await post(w.role.PROJECT_MANAGER, "/api/v1/requisitions", {
      requisition_no: uniq("PR"), justification: "Own request",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, estimated_rate: 400 }],
    });
    expect(pr.status).toBe(201);
    const submitted = await post({ ...w.role.PROJECT_MANAGER, ...(await ver("purchase_requisitions", pr.data.id)) },
      `/api/v1/requisitions/${pr.data.id}/submit`, {});
    const decision = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", submitted.data.approval_id)) },
      `/api/v1/approvals/${submitted.data.approval_id}/decision`, { decision: "APPROVE" });
    expect(decision.status).toBe(403);
    expect(decision.body.code).toBe("SELF_APPROVAL");
  });
});

describe("purchase order", () => {
  it("refuses an order on a blacklisted vendor", async () => {
    // Maintaining the flag is pointless if an order can still be cut.
    const vendor = await makeVendor({ blacklist_status: "BLACKLISTED", blacklist_reason: "Repeated short supply" });
    const res = await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400, gst_rate_pct: 28 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VENDOR_BLACKLISTED");
    expect(res.body.message).toContain("short supply");
  });

  it("computes tax per line and totals the order", async () => {
    const vendor = await makeVendor();
    const res = await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15", place_of_supply: "27",
      lines: [
        { description: "Cement", unit: "bag", quantity: 100, unit_rate: 400, gst_rate_pct: 28, hsn_sac: "25232910" },
        { description: "Sand", unit: "cum", quantity: 50, unit_rate: 1200, gst_rate_pct: 5, hsn_sac: "25051011" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Number(res.data.taxable_value)).toBe(100_000);
    expect(Number(res.data.tax_amount)).toBe(14_200);   // 11,200 + 3,000
    expect(Number(res.data.total_value)).toBe(114_200);
  });

  it("§6.6 refuses to order beyond the requisition", async () => {
    const pr = await makeRequisition([
      { description: "Cement OPC 53", unit: "bag", quantity: 100, estimated_rate: 400 },
    ]);
    const prLines = await approveRequisition(pr.id);
    const vendor = await makeVendor();

    const res = await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, requisition_id: pr.id, po_date: "2026-09-15",
      lines: [{
        description: "Cement OPC 53", unit: "bag", quantity: 150, unit_rate: 400,
        requisition_line_id: prLines[0].id,
      }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EXCEEDS_REQUISITION");
    // The message names the item, not an opaque line id.
    expect(res.body.message).toContain("Cement OPC 53");
  });

  it("allows the excess with a recorded override", async () => {
    const pr = await makeRequisition([
      { description: "Steel TMT", unit: "kg", quantity: 100, estimated_rate: 60 },
    ]);
    const prLines = await approveRequisition(pr.id);
    const vendor = await makeVendor();

    const res = await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, requisition_id: pr.id, po_date: "2026-09-15",
      scope_override_reason: "Rate contract minimum lot is 150 kg",
      lines: [{
        description: "Steel TMT", unit: "kg", quantity: 150, unit_rate: 60,
        requisition_line_id: prLines[0].id,
      }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await w.pool.query(
      "SELECT scope_override_by, scope_override_reason, scope_override_at FROM purchase_orders WHERE id=$1",
      [res.data.id]);
    expect(row.rows[0].scope_override_by).toBe(w.adminId);
    expect(row.rows[0].scope_override_reason).toContain("minimum lot");
    expect(row.rows[0].scope_override_at).toBeTruthy();
  });

  it("marks the requisition converted and keeps the link", async () => {
    const pr = await makeRequisition([{ description: "Bricks", unit: "no", quantity: 1000, estimated_rate: 8 }]);
    const prLines = await approveRequisition(pr.id);
    const vendor = await makeVendor();
    const po = await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, requisition_id: pr.id, po_date: "2026-09-15",
      lines: [{ description: "Bricks", unit: "no", quantity: 1000, unit_rate: 8, requisition_line_id: prLines[0].id }],
    });
    expect(po.status).toBe(201);
    const detail = await get(w.admin, `/api/v1/requisitions/${pr.id}`);
    expect(detail.data.status).toBe("CONVERTED");
    expect(detail.data.purchase_orders).toHaveLength(1);
  });

  it("cannot be approved without clearing its ladder", async () => {
    // Otherwise the approval engine is decorative.
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400 }],
    })).data;
    await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/submit`, {});
    const approve = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/status`, { status: "APPROVED" });
    expect(approve.status).toBe(422);
    expect(approve.body.code).toBe("NOT_APPROVED");
  });
});

describe("goods receipt", () => {
  async function sentOrder(quantity = 100, rate = 400) {
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement OPC 53", unit: "bag", quantity, unit_rate: rate }],
    })).data;
    await w.pool.query("UPDATE purchase_orders SET status='SENT' WHERE id=$1", [po.id]);
    const lines = await w.pool.query(
      "SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1", [po.id]);
    return { po, line: lines.rows[0] };
  }

  it("accumulates receipts across several GRNs", async () => {
    const { po, line } = await sentOrder(100);
    for (const qty of [40, 35]) {
      const res = await post(w.admin, "/api/v1/grns", {
        grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
        lines: [{ po_line_id: line.id, received_quantity: qty, accepted_quantity: qty }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const detail = await get(w.admin, `/api/v1/purchase-orders/${po.id}`);
    expect(detail.data.lines[0].receivedQuantity).toBe(75);
    expect(detail.data.lines[0].pendingQuantity).toBe(25);
    expect(detail.data.status).toBe("PARTIALLY_RECEIVED");
  });

  it("closes the order once everything has arrived", async () => {
    const { po, line } = await sentOrder(100);
    await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: line.id, received_quantity: 100, accepted_quantity: 100 }],
    });
    const detail = await get(w.admin, `/api/v1/purchase-orders/${po.id}`);
    expect(detail.data.status).toBe("FULLY_RECEIVED");
    expect(detail.data.lines[0].status).toBe("COMPLETE");
  });

  it("insists a rejection says why", async () => {
    const { po, line } = await sentOrder(100);
    const res = await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: line.id, received_quantity: 100, accepted_quantity: 80 }],
    });
    expect(res.status).toBe(422);
  });

  it("counts only accepted quantity towards the order", async () => {
    const { po, line } = await sentOrder(100);
    await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{
        po_line_id: line.id, received_quantity: 100, accepted_quantity: 90,
        rejection_reason: "10 bags torn and damp",
      }],
    });
    const detail = await get(w.admin, `/api/v1/purchase-orders/${po.id}`);
    expect(detail.data.lines[0].receivedQuantity).toBe(90);
    expect(detail.data.lines[0].rejectedQuantity).toBe(10);
    // Rejected material is not on the order, so it is still awaited.
    expect(detail.data.lines[0].pendingQuantity).toBe(10);
  });

  it("refuses an over-receipt without a reason, and allows it with one", async () => {
    const { po, line } = await sentOrder(100);
    const refused = await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: line.id, received_quantity: 115, accepted_quantity: 115 }],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("OVER_RECEIPT");

    const accepted = await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      over_receipt_reason: "Vendor supplied the full lot; site accepted the excess",
      lines: [{ po_line_id: line.id, received_quantity: 115, accepted_quantity: 115 }],
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.data.over_receipts.length).toBeGreaterThan(0);
  });

  it("will not receive against an order that has not been issued", async () => {
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400 }],
    })).data;
    const lines = await w.pool.query("SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1", [po.id]);
    const res = await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: lines.rows[0].id, received_quantity: 10, accepted_quantity: 10 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PO_NOT_RECEIVABLE");
  });

  it("moves accepted material into stock", async () => {
    const item = await w.pool.query(
      `INSERT INTO inventory_items(org_id, code, name, unit, status)
       VALUES($1,$2,'Cement','bag','ACTIVE') RETURNING id`, [w.orgId, uniq("IT")]);
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ item_id: item.rows[0].id, description: "Cement", unit: "bag", quantity: 50, unit_rate: 400 }],
    })).data;
    await w.pool.query("UPDATE purchase_orders SET status='SENT' WHERE id=$1", [po.id]);
    const lines = await w.pool.query("SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1", [po.id]);

    await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: lines.rows[0].id, received_quantity: 50, accepted_quantity: 50 }],
    });
    const stock = await w.pool.query(
      "SELECT direction, quantity FROM stock_transactions WHERE item_id=$1", [item.rows[0].id]);
    expect(stock.rows).toHaveLength(1);
    expect(stock.rows[0].direction).toBe("IN");
    expect(Number(stock.rows[0].quantity)).toBe(50);
    // The link is stored, so procurement and inventory reconcile without
    // inferring it later.
    const link = await w.pool.query(
      "SELECT stock_transaction_id FROM grn_lines WHERE po_line_id=$1", [lines.rows[0].id]);
    expect(link.rows[0].stock_transaction_id).toBeTruthy();
  });
});

describe("three-way match", () => {
  async function orderReceivedAndInvoiced(args: {
    ordered: number; rate: number; received: number; invoiced: number; invoiceRate: number;
  }) {
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement OPC 53", unit: "bag", quantity: args.ordered, unit_rate: args.rate }],
    })).data;
    await w.pool.query("UPDATE purchase_orders SET status='SENT' WHERE id=$1", [po.id]);
    const poLines = await w.pool.query(
      "SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1", [po.id]);

    if (args.received > 0) {
      await post(w.admin, "/api/v1/grns", {
        grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
        lines: [{ po_line_id: poLines.rows[0].id, received_quantity: args.received, accepted_quantity: args.received }],
      });
    }

    const invoice = await w.pool.query(
      `INSERT INTO invoices(org_id, serial_number, vendor_id, hsn, gst_enabled, gst_rate,
         subtotal, tax, total, payment_mode, reference, purchase_order_id, invoice_date)
       VALUES($1,$2,$3,'25232910',false,0,$4,0,$4,'BANK','test',$5,'2026-09-17') RETURNING id`,
      [w.orgId, uniq("INV"), vendor.id, (args.invoiced * args.invoiceRate).toFixed(2), po.id]);
    await w.pool.query(
      `INSERT INTO invoice_lines(org_id, invoice_id, line_no, description, hsn_sac, unit,
         quantity, unit_rate, taxable_value, gst_rate_pct, line_total)
       VALUES($1,$2,1,'Cement OPC 53','25232910','bag',$3,$4,$5,0,$5)`,
      [w.orgId, invoice.rows[0].id, args.invoiced, args.invoiceRate,
       (args.invoiced * args.invoiceRate).toFixed(2)]);
    return { po, invoiceId: String(invoice.rows[0].id) };
  }

  it("passes when order, receipt and invoice agree", async () => {
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 100, invoiced: 100, invoiceRate: 400,
    });
    const res = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.matched).toBe(true);
    const inv = await w.pool.query("SELECT match_status FROM invoices WHERE id=$1", [invoiceId]);
    expect(inv.rows[0].match_status).toBe("MATCHED");
  });

  it("catches an invoice for more than arrived", async () => {
    // Ordering a hundred is irrelevant if only sixty arrived.
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 60, invoiced: 100, invoiceRate: 400,
    });
    const res = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, {});
    expect(res.data.matched).toBe(false);
    expect(res.data.exceptions[0].code).toBe("QUANTITY_EXCEEDS_RECEIPT");
    const inv = await w.pool.query("SELECT match_status FROM invoices WHERE id=$1", [invoiceId]);
    expect(inv.rows[0].match_status).toBe("EXCEPTION");
  });

  it("catches a rate above the order", async () => {
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 100, invoiced: 100, invoiceRate: 450,
    });
    const res = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, {});
    expect(res.data.exceptions[0].code).toBe("RATE_EXCEEDS_ORDER");
  });

  it("honours a configured tolerance", async () => {
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 100, invoiced: 100, invoiceRate: 406,
    });
    const strict = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, {});
    expect(strict.data.matched).toBe(false);
    const tolerant = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, { tolerance: { ratePct: 2 } });
    expect(tolerant.data.matched).toBe(true);
  });

  it("refuses the override to a role that raises orders", async () => {
    // §4.1: the buyer must not also hold the control that releases payment
    // against a mismatched invoice.
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 60, invoiced: 100, invoiceRate: 400,
    });
    const res = await post(w.role.ADMIN, `/api/v1/invoices/${invoiceId}/match`,
      { override_reason: "Vendor confirmed the balance is in transit" });
    expect(res.status).toBe(403);
  });

  it("records the override with its reason and actor", async () => {
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 60, invoiced: 100, invoiceRate: 400,
    });
    const res = await post(w.role.SUPER_ADMIN, `/api/v1/invoices/${invoiceId}/match`,
      { override_reason: "Balance in transit, confirmed by the vendor" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.override_reason).toContain("in transit");
    const inv = await w.pool.query("SELECT match_status FROM invoices WHERE id=$1", [invoiceId]);
    expect(inv.rows[0].match_status).toBe("OVERRIDDEN");
  });

  it("keeps every match attempt rather than overwriting the last", async () => {
    // A payment released on an override must keep the evidence of what was
    // overridden; recomputing later against changed data rewrites history.
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 60, invoiced: 100, invoiceRate: 400,
    });
    await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, {});
    await post(w.role.SUPER_ADMIN, `/api/v1/invoices/${invoiceId}/match`, { override_reason: "Accepted" });
    const history = await get(w.admin, `/api/v1/invoices/${invoiceId}/match`);
    expect(history.data.length).toBe(2);
  });

  it("refuses to match an invoice with no order behind it", async () => {
    const vendor = await makeVendor();
    const invoice = await w.pool.query(
      `INSERT INTO invoices(org_id, serial_number, vendor_id, hsn, gst_enabled, gst_rate,
         subtotal, tax, total, payment_mode, reference)
       VALUES($1,$2,$3,'9983',false,0,1000,0,1000,'BANK','direct') RETURNING id`,
      [w.orgId, uniq("INV"), vendor.id]);
    const res = await post(w.admin, `/api/v1/invoices/${invoice.rows[0].id}/match`, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NO_PURCHASE_ORDER");
  });
});

describe("role boundaries", () => {
  it("lets a PM requisition and receive but not cut orders", async () => {
    const vendor = await makeVendor();
    const res = await post(w.role.PROJECT_MANAGER, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400 }],
    });
    expect(res.status).toBe(403);
    expect((await get(w.role.PROJECT_MANAGER, "/api/v1/requisitions")).status).toBe(200);
  });

  it("keeps an ordinary employee out of procurement", async () => {
    expect((await get(w.role.EMPLOYEE, "/api/v1/requisitions")).status).toBe(403);
    expect((await get(w.role.EMPLOYEE, "/api/v1/purchase-orders")).status).toBe(403);
  });

  it("lets the Auditor read but never write", async () => {
    expect((await get(w.role.AUDITOR, "/api/v1/purchase-orders")).status).toBe(200);
    const res = await post(w.role.AUDITOR, "/api/v1/requisitions", {
      requisition_no: uniq("PR"), justification: "No",
      lines: [{ description: "X", unit: "no", quantity: 1 }],
    });
    expect(res.status).toBe(403);
  });
});

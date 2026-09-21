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

  it("honours the organisation's configured tolerance, not the caller's", async () => {
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 100, invoiced: 100, invoiceRate: 406,
    });
    const strict = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, {});
    expect(strict.data.matched).toBe(false);
    // A tolerance sent with the request is ignored: whoever runs the match
    // does not get to decide how close is close enough.
    const asked = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, { tolerance: { ratePct: 2 } });
    expect(asked.data.matched).toBe(false);

    const set = await w.app.inject({
      method: "PATCH", url: "/api/v1/admin/settings",
      headers: { ...w.admin, ...idem() },
      payload: { settings: { match_tolerance: { rate_pct: 2 } } },
    });
    expect(set.statusCode, set.body).toBe(200);
    try {
      const tolerant = await post(w.admin, `/api/v1/invoices/${invoiceId}/match`, {});
      expect(tolerant.data.matched).toBe(true);
    } finally {
      await w.pool.query(
        "UPDATE organizations SET settings = settings - 'match_tolerance' WHERE id = $1", [w.orgId]);
    }
  });

  it("does not let somebody who can only read matches record one", async () => {
    // Recording a match decides whether the invoice can be paid.
    const { invoiceId } = await orderReceivedAndInvoiced({
      ordered: 100, rate: 400, received: 100, invoiced: 100, invoiceRate: 400,
    });
    for (const role of ["AUDITOR", "INVENTORY_MANAGER", "PROJECT_MANAGER"] as const) {
      const res = await post(w.role[role], `/api/v1/invoices/${invoiceId}/match`, {});
      expect(res.status, role).toBe(403);
    }
    expect((await get(w.role.AUDITOR, `/api/v1/invoices/${invoiceId}/match`)).status).toBe(200);
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

describe("RFQ and competitive sourcing (§43.1)", () => {
  async function rfqWithQuotes(quotes: { rate: number; freight?: number; qualified?: boolean; creditable?: boolean }[]) {
    const vendors = await Promise.all(quotes.map(() => makeVendor()));
    const rfq = await post(w.admin, "/api/v1/rfqs", {
      rfq_no: uniq("RFQ"), due_date: "2026-09-30",
      vendor_ids: vendors.map(v => v.id),
      lines: [{ description: "Cement OPC 53", unit: "bag", quantity: 100 }],
    });
    expect(rfq.status, JSON.stringify(rfq.body)).toBe(201);
    const lines = await w.pool.query("SELECT id FROM rfq_lines WHERE rfq_id=$1", [rfq.data.id]);

    for (const [i, quote] of quotes.entries()) {
      const res = await post(w.admin, `/api/v1/rfqs/${rfq.data.id}/quotes`, {
        vendor_id: vendors[i].id, quote_date: "2026-09-20",
        freight: quote.freight ?? 0,
        technically_qualified: quote.qualified ?? true,
        gst_creditable: quote.creditable ?? true,
        ...(quote.qualified === false ? { disqualification_reason: "No ISO certification" } : {}),
        lines: [{ rfq_line_id: lines.rows[0].id, unit_rate: quote.rate, gst_rate_pct: 28 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    return { rfqId: String(rfq.data.id), vendors };
  }

  it("ranks on landed cost rather than unit rate", async () => {
    // 400 plus 5,000 freight beats nothing; 420 carriage paid wins.
    const { rfqId, vendors } = await rfqWithQuotes([
      { rate: 400, freight: 5_000 },
      { rate: 420 },
    ]);
    const sheet = await get(w.admin, `/api/v1/rfqs/${rfqId}/comparison`);
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    expect(sheet.data.recommended.vendorId).toBe(vendors[1].id);
    expect(sheet.data.recommended.landedCost).toBe(42_000);
  });

  it("counts unrecoverable GST as a real cost", async () => {
    // The composition supplier looks cheaper until their tax is counted.
    const { rfqId, vendors } = await rfqWithQuotes([
      { rate: 400 },
      { rate: 380, creditable: false },
    ]);
    const sheet = await get(w.admin, `/api/v1/rfqs/${rfqId}/comparison`);
    expect(sheet.data.recommended.vendorId).toBe(vendors[0].id);
  });

  it("shows an unqualified quote but never recommends it", async () => {
    const { rfqId, vendors } = await rfqWithQuotes([
      { rate: 300, qualified: false },
      { rate: 400 },
    ]);
    const sheet = await get(w.admin, `/api/v1/rfqs/${rfqId}/comparison`);
    expect(sheet.data.evaluations).toHaveLength(2);
    expect(sheet.data.recommended.vendorId).toBe(vendors[1].id);
  });

  it("refuses a quote from a vendor nobody invited", async () => {
    const { rfqId } = await rfqWithQuotes([{ rate: 400 }, { rate: 420 }]);
    const outsider = await makeVendor();
    const lines = await w.pool.query("SELECT id FROM rfq_lines WHERE rfq_id=$1", [rfqId]);
    const res = await post(w.admin, `/api/v1/rfqs/${rfqId}/quotes`, {
      vendor_id: outsider.id, quote_date: "2026-09-20",
      lines: [{ rfq_line_id: lines.rows[0].id, unit_rate: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VENDOR_NOT_INVITED");
  });

  it("refuses to invite a blacklisted vendor", async () => {
    const ok = await makeVendor();
    const bad = await makeVendor({ blacklist_status: "BLACKLISTED", blacklist_reason: "Quality failures" });
    const res = await post(w.admin, "/api/v1/rfqs", {
      rfq_no: uniq("RFQ"), due_date: "2026-09-30", vendor_ids: [ok.id, bad.id],
      lines: [{ description: "Cement", unit: "bag", quantity: 10 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VENDOR_BLACKLISTED");
  });

  it("insists competitive sourcing has more than one vendor", async () => {
    const vendor = await makeVendor();
    const res = await post(w.admin, "/api/v1/rfqs", {
      rfq_no: uniq("RFQ"), due_date: "2026-09-30", vendor_ids: [vendor.id],
      lines: [{ description: "Cement", unit: "bag", quantity: 10 }],
    });
    expect(res.status).toBe(422);
  });

  it("demands a justification for the award", async () => {
    // Choosing anyone — including L1 — has to be defensible later.
    const { rfqId, vendors } = await rfqWithQuotes([{ rate: 400 }, { rate: 420 }]);
    const noReason = await post({ ...w.admin, ...(await ver("rfqs", rfqId)) },
      `/api/v1/rfqs/${rfqId}/award`, { vendor_id: vendors[0].id });
    expect(noReason.status).toBe(422);

    const awarded = await post({ ...w.admin, ...(await ver("rfqs", rfqId)) },
      `/api/v1/rfqs/${rfqId}/award`,
      { vendor_id: vendors[0].id, reason: "Lowest landed cost and shortest lead time" });
    expect(awarded.status, JSON.stringify(awarded.body)).toBe(200);
    expect(awarded.data.selection_reason).toContain("landed cost");
  });

  it("refuses to award a technically disqualified quote", async () => {
    const { rfqId, vendors } = await rfqWithQuotes([{ rate: 300, qualified: false }, { rate: 400 }]);
    const res = await post({ ...w.admin, ...(await ver("rfqs", rfqId)) },
      `/api/v1/rfqs/${rfqId}/award`, { vendor_id: vendors[0].id, reason: "Cheapest" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NOT_QUALIFIED");
  });
});

describe("PO amendment (§43.2)", () => {
  async function approvedOrder(quantity = 100, rate = 400) {
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement OPC 53", unit: "bag", quantity, unit_rate: rate }],
    })).data;
    await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/submit`, {});
    const fresh = await w.pool.query("SELECT approval_id FROM purchase_orders WHERE id=$1", [po.id]);
    const approvalId = fresh.rows[0].approval_id;
    await post({ ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", approvalId)) },
      `/api/v1/approvals/${approvalId}/decision`, { decision: "APPROVE" });
    await w.pool.query("UPDATE purchase_orders SET status='SENT' WHERE id=$1", [po.id]);
    const lines = await w.pool.query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1", [po.id]);
    return { po, line: lines.rows[0] };
  }

  it("records a revision and re-routes approval when the value rises", async () => {
    const { po, line } = await approvedOrder(100, 400);
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/amend`, {
        reason: "Site scope increased", lines: [{ po_line_id: line.id, quantity: 200 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.revision).toBe(1);
    expect(res.data.reapproval.required).toBe(true);

    const after = await w.pool.query(
      "SELECT status, total_value, revision FROM purchase_orders WHERE id=$1", [po.id]);
    expect(Number(after.rows[0].total_value)).toBe(80_000);
    // An order approved at one value must not ship at another.
    expect(after.rows[0].status).toBe("PENDING_APPROVAL");
  });

  it("refuses to reduce a line below what has been received", async () => {
    // The material is on site and in stock.
    const { po, line } = await approvedOrder(100, 400);
    await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: line.id, received_quantity: 80, accepted_quantity: 80 }],
    });
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/amend`, {
        reason: "Reduce scope", lines: [{ po_line_id: line.id, quantity: 50 }],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_AMENDMENT");
    expect(res.body.message).toContain("already been received");
  });

  it("refuses a rate change once material has been received", async () => {
    const { po, line } = await approvedOrder(100, 400);
    await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: line.id, received_quantity: 20, accepted_quantity: 20 }],
    });
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/amend`, {
        reason: "Rate revision", lines: [{ po_line_id: line.id, unit_rate: 450 }],
      });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain("agreed price");
  });

  it("insists an amendment says why", async () => {
    const { po, line } = await approvedOrder();
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/amend`, { lines: [{ po_line_id: line.id, quantity: 120 }] });
    expect(res.status).toBe(422);
  });

  it("will not amend a closed order", async () => {
    const { po, line } = await approvedOrder();
    await w.pool.query("UPDATE purchase_orders SET status='CLOSED' WHERE id=$1", [po.id]);
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/amend`, {
        reason: "Too late", lines: [{ po_line_id: line.id, quantity: 120 }],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PO_NOT_AMENDABLE");
  });
});

describe("acknowledgement and returns (§43.3, §43.4)", () => {
  async function receivedOrder(quantity = 100) {
    const item = await w.pool.query(
      `INSERT INTO inventory_items(org_id, code, name, unit, status)
       VALUES($1,$2,'Cement','bag','ACTIVE') RETURNING id`, [w.orgId, uniq("IT")]);
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ item_id: item.rows[0].id, description: "Cement", unit: "bag", quantity, unit_rate: 400 }],
    })).data;
    await w.pool.query("UPDATE purchase_orders SET status='SENT' WHERE id=$1", [po.id]);
    const poLines = await w.pool.query("SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1", [po.id]);
    const grn = await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: poLines.rows[0].id, received_quantity: quantity, accepted_quantity: quantity }],
    });
    const grnLines = await w.pool.query("SELECT id FROM grn_lines WHERE grn_id=$1", [grn.data.id]);
    return { po, grnId: String(grn.data.id), grnLineId: String(grnLines.rows[0].id), itemId: item.rows[0].id };
  }

  it("refuses acknowledgement on an order that was never issued", async () => {
    const vendor = await makeVendor();
    const draft = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400 }],
    })).data;
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", draft.id)) },
      `/api/v1/purchase-orders/${draft.id}/acknowledge`, { acknowledged_on: "2026-09-16" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PO_NOT_ISSUED");
  });

  it("records a vendor acknowledgement with the promised date", async () => {
    // Recorded retrospectively here, which is ordinary — the order was issued,
    // and that is what makes an acknowledgement meaningful.
    const { po } = await receivedOrder();
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/acknowledge`, {
        acknowledged_on: "2026-09-16", promised_delivery_date: "2026-10-01",
        exceptions: "Available only in 50kg bags",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.acknowledgement_exceptions).toContain("50kg");
  });

  it("refuses a promised date before the order itself", async () => {
    const { po } = await receivedOrder();
    const res = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/acknowledge`, {
        acknowledged_on: "2026-09-16", promised_delivery_date: "2026-09-01",
      });
    expect(res.status).toBe(422);
  });

  it("returns material and posts a controlled stock movement", async () => {
    // §43.3: inventory moves only through controlled transactions, so the
    // return posts its own OUT rather than editing the original receipt.
    const { grnId, grnLineId, itemId } = await receivedOrder(100);
    const res = await post(w.admin, "/api/v1/vendor-returns", {
      return_no: uniq("RTV"), grn_id: grnId, return_date: "2026-09-20",
      reason: "QUALITY_REJECTION", remarks: "Bags damp on inspection",
      lines: [{ grn_line_id: grnLineId, quantity: 15 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const stock = await w.pool.query(
      "SELECT direction, quantity FROM stock_transactions WHERE item_id=$1 ORDER BY created_at", [itemId]);
    expect(stock.rows.map(r => r.direction)).toEqual(["IN", "OUT"]);
    expect(Number(stock.rows[1].quantity)).toBe(15);
    // The original receipt is untouched.
    const grnLine = await w.pool.query("SELECT accepted_quantity FROM grn_lines WHERE id=$1", [grnLineId]);
    expect(Number(grnLine.rows[0].accepted_quantity)).toBe(100);
  });

  it("refuses to return more than was accepted", async () => {
    const { grnId, grnLineId } = await receivedOrder(100);
    const res = await post(w.admin, "/api/v1/vendor-returns", {
      return_no: uniq("RTV"), grn_id: grnId, return_date: "2026-09-20",
      reason: "QUALITY_REJECTION", remarks: "All of it",
      lines: [{ grn_line_id: grnLineId, quantity: 150 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EXCEEDS_RECEIPT");
  });

  it("counts earlier returns against the remaining balance", async () => {
    const { grnId, grnLineId } = await receivedOrder(100);
    for (const qty of [60, 30]) {
      const res = await post(w.admin, "/api/v1/vendor-returns", {
        return_no: uniq("RTV"), grn_id: grnId, return_date: "2026-09-20",
        reason: "QUALITY_REJECTION", remarks: "Damp",
        lines: [{ grn_line_id: grnLineId, quantity: qty }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const third = await post(w.admin, "/api/v1/vendor-returns", {
      return_no: uniq("RTV"), grn_id: grnId, return_date: "2026-09-20",
      reason: "QUALITY_REJECTION", remarks: "Rest",
      lines: [{ grn_line_id: grnLineId, quantity: 20 }],
    });
    expect(third.status).toBe(422);
    expect(third.body.message).toContain("already returned");
  });

  it("insists a return explains itself", async () => {
    const { grnId, grnLineId } = await receivedOrder();
    const res = await post(w.admin, "/api/v1/vendor-returns", {
      return_no: uniq("RTV"), grn_id: grnId, return_date: "2026-09-20",
      reason: "OTHER", remarks: "",
      lines: [{ grn_line_id: grnLineId, quantity: 5 }],
    });
    expect(res.status).toBe(422);
  });
});

describe("RFQ listing", () => {
  it("lists RFQs with their response counts", async () => {
    const a = await makeVendor(), b = await makeVendor();
    const created = await post(w.admin, "/api/v1/rfqs", {
      rfq_no: uniq("RFQ"), due_date: "2026-09-30", vendor_ids: [a.id, b.id],
      lines: [{ description: "Cement", unit: "bag", quantity: 100 }],
    });
    expect(created.status).toBe(201);
    const list = await get(w.admin, "/api/v1/rfqs?limit=100");
    expect(list.status).toBe(200);
    const mine = list.data.find((r: any) => r.id === created.data.id);
    expect(mine.invited_count).toBe(2);
    expect(mine.quote_count).toBe(0);
  });

  it("shows who was invited but has not yet quoted", async () => {
    // The chase list before the due date.
    const a = await makeVendor(), b = await makeVendor();
    const rfq = (await post(w.admin, "/api/v1/rfqs", {
      rfq_no: uniq("RFQ"), due_date: "2026-09-30", vendor_ids: [a.id, b.id],
      lines: [{ description: "Cement", unit: "bag", quantity: 100 }],
    })).data;
    const lines = await w.pool.query("SELECT id FROM rfq_lines WHERE rfq_id=$1", [rfq.id]);
    await post(w.admin, `/api/v1/rfqs/${rfq.id}/quotes`, {
      vendor_id: a.id, quote_date: "2026-09-20",
      lines: [{ rfq_line_id: lines.rows[0].id, unit_rate: 400 }],
    });
    const detail = await get(w.admin, `/api/v1/rfqs/${rfq.id}`);
    expect(detail.data.awaiting.map((v: any) => v.vendor_id)).toEqual([b.id]);
  });
});

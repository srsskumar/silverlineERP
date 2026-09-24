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
/** PATCH .../invoices/:id/lines, with the current If-Match version merged in. */
async function patchInvoiceLines(headers: Headers, id: string, body: unknown) {
  return patch({ ...headers, ...(await ver("invoices", id)) }, `/api/v1/invoices/${id}/lines`, body);
}

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

  // The ladder's verdict lands on the requisition itself; nothing else moves
  // it, so an order can only follow a requisition the approvers cleared.
  const after = await w.pool.query("SELECT status FROM purchase_requisitions WHERE id=$1", [prId]);
  expect(after.rows[0].status).toBe("APPROVED");
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

  it("moves to APPROVED on its own the moment the ladder clears — B-013", async () => {
    // The web page's "Move to" panel says outright that "an order reaches
    // approved only when its ladder says so, never by moving it here" — that
    // promise only holds if the ladder's own verdict actually lands on the
    // order, the way it already does for a requisition.
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400 }],
    })).data;
    const submitted = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/submit`, {});
    const approvalId = submitted.data.approval_id;
    const decision = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", approvalId)) },
      `/api/v1/approvals/${approvalId}/decision`, { decision: "APPROVE" });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);

    const after = await w.pool.query("SELECT status FROM purchase_orders WHERE id=$1", [po.id]);
    expect(after.rows[0].status).toBe("APPROVED");
  });

  it("sends a rejected order back to DRAFT for rework — B-013", async () => {
    // PO_STATUSES has no REJECTED state of its own — DRAFT is the rework
    // state, and DRAFT is exactly what PENDING_APPROVAL is allowed to fall
    // back to.
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400 }],
    })).data;
    const submitted = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/submit`, {});
    const approvalId = submitted.data.approval_id;
    const decision = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", approvalId)) },
      `/api/v1/approvals/${approvalId}/decision`, { decision: "REJECT", comments: "Wrong vendor rate card" });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);

    const after = await w.pool.query("SELECT status FROM purchase_orders WHERE id=$1", [po.id]);
    expect(after.rows[0].status).toBe("DRAFT");
  });

  it("answers an empty JSON body with 4xx, never a 500 — B-020", async () => {
    // createApp.ts's content-type parser (B-016) maps an empty body sent
    // with Content-Type: application/json to a value the route can read
    // without throwing. `body.status` here used to read past an `undefined`
    // req.body and 500 instead of giving a real validation error.
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: [{ description: "Cement", unit: "bag", quantity: 10, unit_rate: 400 }],
    })).data;
    const res = await post(
      { ...w.admin, ...(await ver("purchase_orders", po.id)), "content-type": "application/json" },
      `/api/v1/purchase-orders/${po.id}/status`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
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
    const inv = await w.pool.query("SELECT match_status, version FROM invoices WHERE id=$1", [invoiceId]);
    expect(inv.rows[0].match_status).toBe("MATCHED");
    // Bumped (fix round 2) so a stale PATCH /invoices/:id/lines If-Match
    // taken before this match is refused rather than passing silently.
    expect(inv.rows[0].version).toBe(2);
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

describe("vendor invoice lines (finding B-004)", () => {
  /** A sent purchase order with the given lines, plus the vendor and PO-line ids. */
  async function poWithLines(
    lines: { description: string; quantity: number; rate: number; hsnSac?: string; gstRatePct?: number }[],
  ) {
    const vendor = await makeVendor();
    const po = (await post(w.admin, "/api/v1/purchase-orders", {
      po_number: uniq("PO"), vendor_id: vendor.id, po_date: "2026-09-15",
      lines: lines.map(l => ({
        description: l.description, unit: "bag", quantity: l.quantity, unit_rate: l.rate,
        hsn_sac: l.hsnSac, gst_rate_pct: l.gstRatePct ?? 0,
      })),
    })).data;
    await w.pool.query("UPDATE purchase_orders SET status='SENT' WHERE id=$1", [po.id]);
    const poLines = (await w.pool.query(
      "SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY line_no", [po.id])).rows;
    return { vendor, po, poLines };
  }

  async function receive(poId: string, poLineId: string, qty: number) {
    const res = await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: poId, received_date: "2026-09-16",
      lines: [{ po_line_id: poLineId, received_quantity: qty, accepted_quantity: qty }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  it("creates a vendor invoice with lines, pricing them on the server and ignoring client totals", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400, hsnSac: "25232910", gstRatePct: 28 },
    ]);
    const res = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: true,
      // A client that lies about its own totals is exactly the case the rule
      // guards against. gst_rate stays a legal value (it is still checked
      // against its own 0-100 bound before lines are even considered) but
      // subtotal is nowhere near the true line total.
      gst_rate: "0", subtotal: "1", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{
        po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910",
        quantity: 100, unit_rate: 400, gst_rate_pct: 28,
      }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Number(res.data.subtotal)).toBe(40_000);
    expect(Number(res.data.total)).toBeCloseTo(40_000 * 1.28, 2);
    // gst_enabled/gst_rate are recomputed from the lines too (fix round 1,
    // item 5) -- the client claimed no GST at all; the line says 28%.
    expect(res.data.gst_enabled).toBe(true);
    expect(Number(res.data.gst_rate)).toBeCloseTo(28, 2);
    const lines = (await w.pool.query(
      "SELECT * FROM invoice_lines WHERE invoice_id=$1", [res.data.id])).rows;
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].taxable_value)).toBe(40_000);
    expect(String(lines[0].po_line_id)).toBe(String(poLines[0].id));
  });

  it("R5-001: wraps the created invoice in the {data:...} envelope like every other create", async () => {
    const { vendor } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400, hsnSac: "25232910", gstRatePct: 0 },
    ]);
    const res = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "4000", payment_mode: "BANK", reference: "envelope check",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The raw body, not `res.data` (which tolerates either shape) -- this
    // pins the actual wire shape so a client written against the API's
    // usual {data:...} convention gets `.data.id`, not `undefined`.
    expect(res.body).toHaveProperty('data.id');
    expect(typeof res.body.data.id).toBe('string');
    expect(res.body.id).toBeUndefined();
  });

  it("recomputes gst_enabled/gst_rate on an edit too, not only on create (fix round 1, item 5)", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(inv.data.gst_enabled).toBe(false);

    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 18 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.gst_enabled).toBe(true);
    expect(Number(res.data.gst_rate)).toBeCloseTo(18, 2);
  });

  it("refuses a line whose po_line_id belongs to a different purchase order", async () => {
    const a = await poWithLines([{ description: "Cement OPC 53", quantity: 10, rate: 400 }]);
    const b = await poWithLines([{ description: "Sand", quantity: 10, rate: 100 }]);
    const res = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: a.vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: a.po.id,
      lines: [{
        po_line_id: b.poLines[0].id, description: "Sand", hsn_sac: "25232910",
        quantity: 10, unit_rate: 100, gst_rate_pct: 0,
      }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a line whose item_id belongs to a different organisation (fix round 1, item 2)", async () => {
    // The FK on invoice_lines.item_id only proves the item exists somewhere
    // -- inventory_items carries no per-org uniqueness that stops it
    // pointing at another tenant's item.
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const otherItem = await post(w.other.admin, "/api/v1/inventory/items", {
      code: uniq("ITM"), name: "Other org's item",
    });
    expect(otherItem.status, JSON.stringify(otherItem.body)).toBe(201);
    const res = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{
        item_id: otherItem.data.id, po_line_id: poLines[0].id, description: "Cement OPC 53",
        hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0,
      }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("matches by po_line_id when two order lines share a description", async () => {
    // The old fallback (item_id, else description) would collide on these
    // two lines and check one of them against the wrong price.
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
      { description: "Cement OPC 53", quantity: 50, rate: 450 },
    ]);
    await receive(po.id, poLines[0].id, 100);
    await receive(po.id, poLines[1].id, 50);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [
        { po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 0 },
        { po_line_id: poLines[1].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 50, unit_rate: 450, gst_rate_pct: 0 },
      ],
    });
    const res = await post(w.admin, `/api/v1/invoices/${inv.data.id}/match`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.matched).toBe(true);
  });

  it("sums multiple invoice lines billed against one order line", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
    ]);
    await receive(po.id, poLines[0].id, 100);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [
        { po_line_id: poLines[0].id, description: "Cement OPC 53 (part 1)", hsn_sac: "25232910", quantity: 40, unit_rate: 400, gst_rate_pct: 0 },
        { po_line_id: poLines[0].id, description: "Cement OPC 53 (part 2)", hsn_sac: "25232910", quantity: 60, unit_rate: 400, gst_rate_pct: 0 },
      ],
    });
    const res = await post(w.admin, `/api/v1/invoices/${inv.data.id}/match`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.matched).toBe(true);
    expect(res.data.invoicedValue).toBe(40_000);
  });

  it("fails the match when an invoice line is billed for something not on the order", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
    ]);
    await receive(po.id, poLines[0].id, 100);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [
        { po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 0 },
        { description: "Rebar 12mm (never ordered)", hsn_sac: "72142000", quantity: 20, unit_rate: 500, gst_rate_pct: 0 },
      ],
    });
    const res = await post(w.admin, `/api/v1/invoices/${inv.data.id}/match`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.matched).toBe(false);
    expect(res.data.exceptions.some((e: { code: string }) => e.code === "NOT_ON_ORDER")).toBe(true);
    const row = await w.pool.query("SELECT match_status FROM invoices WHERE id=$1", [inv.data.id]);
    expect(row.rows[0].match_status).toBe("EXCEPTION");
  });

  it("lets a vendor invoice's lines be edited while it is unmatched", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 80, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number(res.data.subtotal)).toBe(32_000);
    expect(res.data.lines).toHaveLength(1);
  });

  it("refuses to edit lines once the invoice has been matched", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
    ]);
    await receive(po.id, poLines[0].id, 100);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 0 }],
    });
    await post(w.admin, `/api/v1/invoices/${inv.data.id}/match`, {});
    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 50, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS");
  });

  it("lets lines be edited after a failed match (EXCEPTION), and resets match_status to UNMATCHED (fix round 1, item 1)", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
    ]);
    await receive(po.id, poLines[0].id, 60);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      // Invoiced for more than the 60 received -- fails the match.
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const matched = await post(w.admin, `/api/v1/invoices/${inv.data.id}/match`, {});
    expect(matched.data.matched).toBe(false);
    const afterMatch = await w.pool.query("SELECT match_status FROM invoices WHERE id=$1", [inv.data.id]);
    expect(afterMatch.rows[0].match_status).toBe("EXCEPTION");

    // Correct the line to what was actually received, and save.
    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 60, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.match_status).toBe("UNMATCHED");
    const afterEdit = await w.pool.query("SELECT match_status FROM invoices WHERE id=$1", [inv.data.id]);
    expect(afterEdit.rows[0].match_status).toBe("UNMATCHED");

    // And the corrected lines now match cleanly.
    const rematched = await post(w.admin, `/api/v1/invoices/${inv.data.id}/match`, {});
    expect(rematched.data.matched).toBe(true);
  });

  it("refuses to edit lines once the invoice has been overridden", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 100, rate: 400 },
    ]);
    await receive(po.id, poLines[0].id, 60);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 100, unit_rate: 400, gst_rate_pct: 0 }],
    });
    await post(w.admin, `/api/v1/invoices/${inv.data.id}/match`, {});
    // SUPER_ADMIN holds match.override, which the ADMIN role that raised
    // the order deliberately does not (§4.1).
    const overridden = await post(w.role.SUPER_ADMIN, `/api/v1/invoices/${inv.data.id}/match`, {
      override_reason: "Accepted short delivery",
    });
    expect(overridden.data.matched).toBe(false);
    const status = await w.pool.query("SELECT match_status FROM invoices WHERE id=$1", [inv.data.id]);
    expect(status.rows[0].match_status).toBe("OVERRIDDEN");

    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 60, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS");
  });

  it("refuses to edit lines once the invoice is approved", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    await w.pool.query("UPDATE invoices SET lifecycle_status='APPROVED' WHERE id=$1", [inv.data.id]);
    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 5, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS");
  });

  it("refuses to edit lines once a payment has been allocated against the invoice, even a partial one", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const payment = await w.pool.query(
      `INSERT INTO payments(org_id, payment_no, direction, paid_on, amount, mode, created_by)
       VALUES($1,$2,'PAYABLE','2026-09-20',1000,'NEFT',$3) RETURNING id`,
      [w.orgId, uniq("PAY"), w.adminId]);
    await w.pool.query(
      `INSERT INTO payment_allocations(org_id, payment_id, document_type, document_id, amount, created_by)
       VALUES($1,$2,'VENDOR_INVOICE',$3,500,$4)`,
      [w.orgId, payment.rows[0].id, inv.data.id, w.adminId]);

    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 5, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS");
  });

  it("refuses to edit lines once the invoice is on an open payment run", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const run = await w.pool.query(
      `INSERT INTO payment_runs(org_id, run_no, run_date, due_through, status, created_by)
       VALUES($1,$2,'2026-09-20','2026-09-20','DRAFT',$3) RETURNING id`,
      [w.orgId, uniq("PR"), w.adminId]);
    await w.pool.query(
      `INSERT INTO payment_run_lines(org_id, run_id, document_type, document_id, party_id, amount)
       VALUES($1,$2,'VENDOR_INVOICE',$3,$4,4000)`,
      [w.orgId, run.rows[0].id, inv.data.id, vendor.id]);

    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 5, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS");
  });

  it("refuses to edit lines while the invoice is on hold (fix round 2)", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const held = await post(w.admin, `/api/v1/ap/invoices/${inv.data.id}/hold`,
      { on_hold: true, reason: "Awaiting a credit note" });
    expect(held.status, JSON.stringify(held.body)).toBe(200);

    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 5, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS");
    expect(res.body.message).toContain("on hold");
  });

  it("refuses to edit lines while the invoice is disputed (fix round 2)", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const dispute = await post(w.admin, `/api/v1/invoices/${inv.data.id}/dispute`,
      { disputed: true, reason: "Wrong item delivered" });
    expect(dispute.status, JSON.stringify(dispute.body)).toBe(200);

    const res = await patchInvoiceLines(w.admin, inv.data.id, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 5, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATUS");
    expect(res.body.message).toContain("disputed");
  });

  it("GET /invoices/:id reports on-hold and disputed as reasons lines cannot be edited (fix round 2)", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect((await get(w.admin, `/api/v1/invoices/${inv.data.id}`)).data.lines_editable).toBe(true);

    await post(w.admin, `/api/v1/ap/invoices/${inv.data.id}/hold`, { on_hold: true, reason: "Query" });
    const held = await get(w.admin, `/api/v1/invoices/${inv.data.id}`);
    expect(held.data.lines_editable).toBe(false);
    expect(held.data.lines_lock_reason).toContain("on hold");
  });

  it("keeps invoice line writes behind invoice.manage, not invoice.read", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const res = await patch(w.role.AUDITOR, `/api/v1/invoices/${inv.data.id}/lines`, {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 5, unit_rate: 400, gst_rate_pct: 0 }],
    });
    expect(res.status).toBe(403);
  });

  it("requires If-Match on PATCH /invoices/:id/lines, and refuses a stale version (fix round 1, item 3)", async () => {
    const { vendor, po, poLines } = await poWithLines([
      { description: "Cement OPC 53", quantity: 10, rate: 400 },
    ]);
    const inv = await post(w.admin, "/api/v1/invoices", {
      serial_number: uniq("INV"), vendor_id: vendor.id, hsn: "25232910", gst_enabled: false,
      gst_rate: "0", subtotal: "0", payment_mode: "BANK", reference: "test",
      purchase_order_id: po.id,
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 10, unit_rate: 400, gst_rate_pct: 0 }],
    });
    const body = {
      lines: [{ po_line_id: poLines[0].id, description: "Cement OPC 53", hsn_sac: "25232910", quantity: 5, unit_rate: 400, gst_rate_pct: 0 }],
    };

    const noHeader = await patch(w.admin, `/api/v1/invoices/${inv.data.id}/lines`, body);
    expect(noHeader.status).toBe(422);
    expect(noHeader.body.code).toBe("VERSION_REQUIRED");

    const stale = await patch({ ...w.admin, "if-match": "999" }, `/api/v1/invoices/${inv.data.id}/lines`, body);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");

    // The version starts at 1 and bumps with every successful edit, exactly
    // as every other versioned mutation in this codebase does.
    const first = await patchInvoiceLines(w.admin, inv.data.id, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.data.version).toBe(2);
    const second = await patchInvoiceLines(w.admin, inv.data.id, body);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.data.version).toBe(3);
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

  /**
   * Item 2 (final QA fix wave): reflectOnDocument used to give every order
   * the same two outcomes regardless of what it was doing when the amendment
   * re-routed it — APPROVED on approval, DRAFT on rejection. That silently
   * un-shipped a SENT order the moment its amendment cleared, and un-issued a
   * PARTIALLY_RECEIVED order the moment its amendment was rejected, even
   * though nothing about the vendor relationship or the goods already
   * received changed.
   */
  it("restores SENT (not APPROVED) once an amendment on a SENT order clears the ladder", async () => {
    const { po, line } = await approvedOrder(100, 400);
    const amend = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/amend`, {
        reason: "Site scope increased", lines: [{ po_line_id: line.id, quantity: 200 }],
      });
    expect(amend.status, JSON.stringify(amend.body)).toBe(201);

    const pending = await w.pool.query("SELECT approval_id, status FROM purchase_orders WHERE id=$1", [po.id]);
    expect(pending.rows[0].status).toBe("PENDING_APPROVAL");
    const approvalId = pending.rows[0].approval_id;

    const decision = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", approvalId)) },
      `/api/v1/approvals/${approvalId}/decision`, { decision: "APPROVE" });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);

    const after = await w.pool.query("SELECT status FROM purchase_orders WHERE id=$1", [po.id]);
    expect(after.rows[0].status).toBe("SENT");
  });

  it("restores PARTIALLY_RECEIVED (not DRAFT) and flags the amendment when it is rejected", async () => {
    const { po, line } = await approvedOrder(100, 400);
    await post(w.admin, "/api/v1/grns", {
      grn_no: uniq("GRN"), purchase_order_id: po.id, received_date: "2026-09-16",
      lines: [{ po_line_id: line.id, received_quantity: 20, accepted_quantity: 20 }],
    });
    await w.pool.query("UPDATE purchase_orders SET status='PARTIALLY_RECEIVED' WHERE id=$1", [po.id]);

    const amend = await post({ ...w.admin, ...(await ver("purchase_orders", po.id)) },
      `/api/v1/purchase-orders/${po.id}/amend`, {
        reason: "Delivery schedule change", lines: [{ po_line_id: line.id, quantity: 150 }],
      });
    expect(amend.status, JSON.stringify(amend.body)).toBe(201);

    const pending = await w.pool.query("SELECT approval_id, status FROM purchase_orders WHERE id=$1", [po.id]);
    expect(pending.rows[0].status).toBe("PENDING_APPROVAL");
    const approvalId = pending.rows[0].approval_id;

    const decision = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", approvalId)) },
      `/api/v1/approvals/${approvalId}/decision`, { decision: "REJECT", comments: "Not agreed with vendor" });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);

    const after = await w.pool.query("SELECT status FROM purchase_orders WHERE id=$1", [po.id]);
    expect(after.rows[0].status).toBe("PARTIALLY_RECEIVED");
    const amendmentRow = await w.pool.query(
      "SELECT rejected_at, pre_status FROM po_amendments WHERE purchase_order_id=$1 ORDER BY revision DESC LIMIT 1",
      [po.id]);
    expect(amendmentRow.rows[0].pre_status).toBe("PARTIALLY_RECEIVED");
    expect(amendmentRow.rows[0].rejected_at).toBeTruthy();
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

  it("refuses to return material that has already been issued", async () => {
    // Accepted 100, issued 90 to site: ten bags are in the store, and a return
    // of fifteen would have left the ledger at minus five.
    const { grnId, grnLineId, itemId } = await receivedOrder(100);
    await w.pool.query(
      `INSERT INTO stock_transactions(org_id, created_by, item_id, direction, quantity, reference)
       VALUES($1,$2,$3,'OUT',90,'Issued to site')`, [w.orgId, w.adminId, itemId]);
    const res = await post(w.admin, "/api/v1/vendor-returns", {
      return_no: uniq("RTV"), grn_id: grnId, return_date: "2026-09-20",
      reason: "QUALITY_REJECTION", remarks: "Damp",
      lines: [{ grn_line_id: grnLineId, quantity: 15 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK");
    const total = await w.pool.query(
      `SELECT sum(CASE WHEN direction='IN' THEN quantity ELSE -quantity END) AS q
       FROM stock_transactions WHERE item_id=$1`, [itemId]);
    expect(Number(total.rows[0].q)).toBe(10);

    const within = await post(w.admin, "/api/v1/vendor-returns", {
      return_no: uniq("RTV"), grn_id: grnId, return_date: "2026-09-20",
      reason: "QUALITY_REJECTION", remarks: "Damp",
      lines: [{ grn_line_id: grnLineId, quantity: 10 }],
    });
    expect(within.status, JSON.stringify(within.body)).toBe(201);
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

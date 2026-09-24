/**
 * End-to-end cover for running-account billing (§15, §37.3).
 *
 * The rules under test are enforced by transactions and partial unique indexes
 * — one open bill per project, one final bill, cumulative measurement read
 * server-side — so these run against a real database.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;

async function send(method: "POST" | "PUT" | "GET", headers: Headers, url: string, payload?: unknown) {
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
const put = (h: Headers, u: string, p?: unknown) => send("PUT", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);

async function billVersion(id: string): Promise<Headers> {
  const r = await w.pool.query("SELECT version FROM ra_bills WHERE id = $1", [id]);
  return { "if-match": String(r.rows[0].version) };
}

/** A project with a BOQ of one item: 1000 units at 450. */
async function projectWithBoq(over: { contractValue?: number } = {}) {
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  const project = await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status, contract_value)
     VALUES($1,$2,$3,'Billing project','ACTIVE',$4) RETURNING *`,
    [w.orgId, ws.rows[0].id, uniq("PRJ"), over.contractValue ?? 10_000_000]);
  const boq = await post(w.admin, `/api/v1/projects/${project.rows[0].id}/boq`, {
    item_code: "1.1", description: "Earthwork in excavation", unit: "cum",
    quantity: 1000, rate: 450,
  });
  expect(boq.status, JSON.stringify(boq.body)).toBe(201);
  return { projectId: String(project.rows[0].id), boqItemId: String(boq.data.id) };
}

async function raiseBill(projectId: string, boqItemId: string, cumulative: number, extra: Record<string, unknown> = {}) {
  return post(w.admin, "/api/v1/ra-bills", {
    project_id: projectId, period_from: "2026-08-01", period_to: "2026-08-31",
    lines: [{ boq_item_id: boqItemId, cumulative_quantity: cumulative }],
    ...extra,
  });
}

async function certify(billId: string) {
  const res = await post({ ...w.admin, ...(await billVersion(billId)) },
    `/api/v1/ra-bills/${billId}/status`, { status: "SUBMITTED" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const cert = await post({ ...w.admin, ...(await billVersion(billId)) },
    `/api/v1/ra-bills/${billId}/status`, { status: "CERTIFIED" });
  expect(cert.status, JSON.stringify(cert.body)).toBe(200);
  return cert.data;
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("cumulative measurement", () => {
  it("bills the increment over what was already certified", async () => {
    const { projectId, boqItemId } = await projectWithBoq();

    const first = await raiseBill(projectId, boqItemId, 400);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(Number(first.data.gross_value)).toBe(180_000);
    await certify(first.data.id);

    // RA-2 measures 620 cumulative; only 220 is newly claimed.
    const second = await raiseBill(projectId, boqItemId, 620);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(Number(second.data.gross_value)).toBe(99_000);
    expect(Number(second.data.previous_value)).toBe(180_000);
    expect(Number(second.data.cumulative_value)).toBe(279_000);
  });

  it("does not let the caller decide what was already billed", async () => {
    // previous_quantity is read from certified bills inside the transaction.
    // If a caller could send it, the same work could be billed twice.
    const { projectId, boqItemId } = await projectWithBoq();
    await certify((await raiseBill(projectId, boqItemId, 400)).data.id);

    const second = await post(w.admin, "/api/v1/ra-bills", {
      project_id: projectId, period_from: "2026-09-01", period_to: "2026-09-30",
      lines: [{ boq_item_id: boqItemId, cumulative_quantity: 620, previous_quantity: 0 }],
    });
    expect(second.status).toBe(201);
    // The injected zero was ignored: still only the 220 increment.
    expect(Number(second.data.gross_value)).toBe(99_000);
  });

  it("ignores an uncertified bill when computing what was already billed", async () => {
    // A draft has not been accepted by the client, so treating its measurement
    // as billed would understate the next claim.
    const { projectId, boqItemId } = await projectWithBoq();
    const draft = await raiseBill(projectId, boqItemId, 400);
    expect(draft.status).toBe(201);

    await post({ ...w.admin, ...(await billVersion(draft.data.id)) },
      `/api/v1/ra-bills/${draft.data.id}/status`, { status: "CANCELLED", reason: "Re-measured" });

    const fresh = await raiseBill(projectId, boqItemId, 400);
    expect(Number(fresh.data.gross_value)).toBe(180_000);
    expect(Number(fresh.data.previous_value)).toBe(0);
  });

  it("refuses a bill that claims no further work", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    await certify((await raiseBill(projectId, boqItemId, 400)).data.id);
    const flat = await raiseBill(projectId, boqItemId, 400);
    expect(flat.status).toBe(422);
    expect(flat.body.code).toBe("NOTHING_TO_BILL");
  });

  it("records quantity executed beyond the BOQ as excess", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const over = await raiseBill(projectId, boqItemId, 1120);
    expect(over.status).toBe(201);
    expect(over.data.excess_items).toBe(1);
    const detail = (await get(w.admin, `/api/v1/ra-bills/${over.data.id}`)).data;
    expect(Number(detail.items[0].excess_quantity)).toBe(120);
  });
});

describe("deductions", () => {
  async function projectWithPolicy(policy: Record<string, unknown>) {
    const ctx = await projectWithBoq();
    const res = await put(w.admin, `/api/v1/projects/${ctx.projectId}/billing-policy`, policy);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ctx;
  }

  it("withholds every configured head on the gross", async () => {
    const { projectId, boqItemId } = await projectWithPolicy({
      retention_pct: 5, labour_cess_pct: 1, tds_income_tax_pct: 2, tds_gst_pct: 2, gst_rate_pct: 18,
    });
    const bill = await raiseBill(projectId, boqItemId, 1000); // gross 450,000
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect(Number(bill.data.gross_value)).toBe(450_000);
    expect(Number(bill.data.gst_amount)).toBe(81_000);
    expect(Number(bill.data.total_deductions)).toBe(45_000);
    expect(Number(bill.data.net_payable)).toBe(486_000);
  });

  it("charges GST on the gross while deductions come out of it", async () => {
    const { projectId, boqItemId } = await projectWithPolicy({ retention_pct: 10, gst_rate_pct: 18 });
    const bill = await raiseBill(projectId, boqItemId, 1000);
    const gross = Number(bill.data.gross_value);
    const gst = Number(bill.data.gst_amount);
    const ded = Number(bill.data.total_deductions);
    expect(Number((gross + gst - ded).toFixed(2))).toBe(Number(bill.data.net_payable));
  });

  it("omits GST TDS for a private client that does not deduct it", async () => {
    const { projectId, boqItemId } = await projectWithPolicy({ retention_pct: 5 });
    const bill = await raiseBill(projectId, boqItemId, 1000);
    const detail = (await get(w.admin, `/api/v1/ra-bills/${bill.data.id}`)).data;
    expect(detail.deductions.map((d: any) => d.head)).toEqual(["RETENTION"]);
  });

  it("requires a reason for a discretionary recovery", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const res = await raiseBill(projectId, boqItemId, 1000, {
      fixed_deductions: [{ head: "LIQUIDATED_DAMAGES", label: "LD", amount: 5000 }],
    });
    expect(res.status).toBe(422);
  });

  it("carries a reasoned liquidated-damages recovery onto the bill", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const res = await raiseBill(projectId, boqItemId, 1000, {
      fixed_deductions: [{
        head: "LIQUIDATED_DAMAGES", label: "LD for 12 days", amount: 27_000,
        reason: "Completion delayed 12 days beyond the extended date",
      }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const detail = (await get(w.admin, `/api/v1/ra-bills/${res.data.id}`)).data;
    const ld = detail.deductions.find((d: any) => d.head === "LIQUIDATED_DAMAGES");
    expect(Number(ld.amount)).toBe(27_000);
    expect(ld.reason).toContain("12 days");
  });

  it("refuses a policy change while a bill is open", async () => {
    // Redrawing the policy under an open measurement silently changes it.
    const { projectId, boqItemId } = await projectWithPolicy({ retention_pct: 5 });
    await raiseBill(projectId, boqItemId, 400);
    const res = await put(w.admin, `/api/v1/projects/${projectId}/billing-policy`, { retention_pct: 10 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BILL_IN_PROGRESS");
  });
});

describe("advance recovery", () => {
  it("recovers pro-rata and draws the balance down on certification", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const advance = await post(w.admin, "/api/v1/advances", {
      project_id: projectId, advance_type: "MOBILISATION", amount: 1_000_000,
      paid_on: "2026-07-01", recovery_pct: 20,
    });
    expect(advance.status, JSON.stringify(advance.body)).toBe(201);

    const bill = await raiseBill(projectId, boqItemId, 1000); // gross 450,000
    const detail = (await get(w.admin, `/api/v1/ra-bills/${bill.data.id}`)).data;
    const recovery = detail.deductions.find((d: any) => d.head === "MOBILISATION_ADVANCE");
    expect(Number(recovery.amount)).toBe(90_000);

    // The balance moves only when the bill is certified, not while drafting.
    let row = await w.pool.query("SELECT recovered_amount FROM project_advances WHERE id=$1", [advance.data.id]);
    expect(Number(row.rows[0].recovered_amount)).toBe(0);

    await certify(bill.data.id);
    row = await w.pool.query("SELECT recovered_amount, status FROM project_advances WHERE id=$1", [advance.data.id]);
    expect(Number(row.rows[0].recovered_amount)).toBe(90_000);
    expect(row.rows[0].status).toBe("OUTSTANDING");
  });

  it("never recovers more than remains outstanding", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const advance = await post(w.admin, "/api/v1/advances", {
      project_id: projectId, advance_type: "MOBILISATION", amount: 50_000,
      paid_on: "2026-07-01", recovery_pct: 20,
    });
    const bill = await raiseBill(projectId, boqItemId, 1000); // 20% would be 90,000
    const detail = (await get(w.admin, `/api/v1/ra-bills/${bill.data.id}`)).data;
    expect(Number(detail.deductions.find((d: any) => d.head === "MOBILISATION_ADVANCE").amount)).toBe(50_000);

    await certify(bill.data.id);
    const row = await w.pool.query("SELECT recovered_amount, status FROM project_advances WHERE id=$1", [advance.data.id]);
    expect(Number(row.rows[0].recovered_amount)).toBe(50_000);
    expect(row.rows[0].status).toBe("RECOVERED");
  });
});

/**
 * Item 6 (final QA fix wave): "New advance" on the billing page had no list
 * beside it and no GET to back one — an advance vanished from view the
 * moment it was created.
 */
describe("listing advances", () => {
  it("lists an advance just created, and filters it down to its project", async () => {
    const { projectId } = await projectWithBoq();
    const advance = await post(w.admin, "/api/v1/advances", {
      project_id: projectId, advance_type: "MOBILISATION", amount: 200_000,
      paid_on: "2026-07-01", recovery_pct: 10,
    });
    expect(advance.status, JSON.stringify(advance.body)).toBe(201);

    const all = await get(w.admin, "/api/v1/advances");
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.data.map((a: any) => a.id)).toContain(advance.data.id);

    const scoped = await get(w.admin, `/api/v1/advances?project_id=${projectId}`);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0].id).toBe(advance.data.id);
    expect(scoped.data[0].project_code).toBeTruthy();

    const { projectId: otherProjectId } = await projectWithBoq();
    const scopedElsewhere = await get(w.admin, `/api/v1/advances?project_id=${otherProjectId}`);
    expect(scopedElsewhere.status, JSON.stringify(scopedElsewhere.body)).toBe(200);
    expect(scopedElsewhere.data.map((a: any) => a.id)).not.toContain(advance.data.id);
  });

  it("never lists another organisation's advances", async () => {
    const { projectId } = await projectWithBoq();
    const advance = await post(w.admin, "/api/v1/advances", {
      project_id: projectId, advance_type: "MOBILISATION", amount: 75_000,
      paid_on: "2026-07-01", recovery_pct: 10,
    });
    expect(advance.status, JSON.stringify(advance.body)).toBe(201);

    const crossOrg = await get(w.other.admin, "/api/v1/advances");
    expect(crossOrg.status, JSON.stringify(crossOrg.body)).toBe(200);
    expect(crossOrg.data.map((a: any) => a.id)).not.toContain(advance.data.id);

    // Filtering by a project id from a different organisation is refused
    // outright, the same as any other cross-org project reference.
    const crossOrgFilter = await get(w.other.admin, `/api/v1/advances?project_id=${projectId}`);
    expect(crossOrgFilter.status).toBe(404);
  });
});

describe("bill lifecycle", () => {
  it("allows only one open bill per project", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    expect((await raiseBill(projectId, boqItemId, 200)).status).toBe(201);
    const second = await raiseBill(projectId, boqItemId, 400);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("BILL_IN_PROGRESS");
  });

  it("closes the account after the final bill", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const final = await raiseBill(projectId, boqItemId, 1000, { bill_type: "FINAL" });
    expect(final.status).toBe(201);
    await certify(final.data.id);

    const after = await raiseBill(projectId, boqItemId, 1000);
    expect(after.status).toBe(422);
    expect(after.body.code).toBe("FINAL_BILL_RAISED");
  });

  it("refuses a status jump the machine does not allow", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 400);
    const jump = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "PAID" });
    expect(jump.status).toBe(422);
    expect(jump.body.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("requires a reason to cancel", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 400);
    const res = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CANCELLED" });
    expect(res.status).toBe(422);
  });

  it("§4.1 keeps certification away from whoever measured", async () => {
    // The PM raises and submits the bill but holds no rabill.certify, so the
    // only check on their own measurement stays in place.
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 400);
    await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });

    const res = await post({ ...w.role.PROJECT_MANAGER, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CERTIFIED" });
    expect(res.status).toBe(403);
  });
});

describe("over-allocation guard on status change (owner decision 2026-09-24, fix round 1, C1)", () => {
  async function makeReceipt(amount: number) {
    const res = await post(w.admin, "/api/v1/payments", {
      direction: "RECEIVABLE", payment_no: uniq("RCP"), paid_on: "2026-09-10", amount, mode: "NEFT",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.data;
  }

  async function allocate(paymentId: string, billId: string, amount: number) {
    return post(w.admin, `/api/v1/payments/${paymentId}/allocations`, {
      document_type: "RA_BILL", document_id: billId, amount,
    });
  }

  async function reverse(paymentId: string) {
    const p = await w.pool.query("SELECT version FROM payments WHERE id = $1", [paymentId]);
    const res = await post({ ...w.admin, "if-match": String(p.rows[0].version) },
      `/api/v1/payments/${paymentId}/reverse`, { reason: "Unallocating for the test" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function billRow(id: string) {
    return (await w.pool.query("SELECT * FROM ra_bills WHERE id = $1", [id])).rows[0];
  }

  it("caps a SUBMITTED bill's allocation at net_payable, not gross_value", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    await put(w.admin, `/api/v1/projects/${projectId}/billing-policy`, { retention_pct: 5 });
    const bill = await raiseBill(projectId, boqItemId, 1000);
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });

    const row = await billRow(bill.data.id);
    const gross = Number(row.gross_value), net = Number(row.net_payable);
    expect(net).toBeLessThan(gross); // retention actually shrank the claim

    const atGross = await allocate((await makeReceipt(gross)).id, bill.data.id, gross);
    expect(atGross.status, JSON.stringify(atGross.body)).toBe(422);

    const atNet = await allocate((await makeReceipt(net)).id, bill.data.id, net);
    expect(atNet.status, JSON.stringify(atNet.body)).toBe(201);
  });

  it("refuses to certify below what is already allocated", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 1000); // gross 450,000, no deductions
    await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });
    const net = Number((await billRow(bill.data.id)).net_payable);

    const receipt = await makeReceipt(net);
    const alloc = await allocate(receipt.id, bill.data.id, net);
    expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);

    const lower = net - 50_000;
    const certified = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CERTIFIED", certified_amount: lower });
    expect(certified.status, JSON.stringify(certified.body)).toBe(422);
    expect(certified.body.code).toBe("RA_BILL_OVER_ALLOCATED");
    expect(certified.body.message).toContain("50000.00");

    // Unallocating first clears the way.
    await reverse(receipt.id);
    const retried = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CERTIFIED", certified_amount: lower });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it("refuses to send a submitted bill back to draft while a receipt is allocated", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 1000);
    await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });
    const net = Number((await billRow(bill.data.id)).net_payable);
    const receipt = await makeReceipt(net / 2);
    await allocate(receipt.id, bill.data.id, net / 2);

    const toDraft = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "DRAFT" });
    expect(toDraft.status, JSON.stringify(toDraft.body)).toBe(422);
    expect(toDraft.body.code).toBe("RA_BILL_OVER_ALLOCATED");

    await reverse(receipt.id);
    const retried = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "DRAFT" });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it("refuses to cancel a submitted bill while a receipt is allocated", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 1000);
    await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });
    const net = Number((await billRow(bill.data.id)).net_payable);
    const receipt = await makeReceipt(net);
    await allocate(receipt.id, bill.data.id, net);

    const cancelled = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CANCELLED", reason: "Client withdrew the claim" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(422);
    expect(cancelled.body.code).toBe("RA_BILL_OVER_ALLOCATED");

    await reverse(receipt.id);
    const retried = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CANCELLED", reason: "Client withdrew the claim" });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it("refuses to cancel a certified bill while a receipt is allocated", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 1000);
    const certified = await certify(bill.data.id);
    const receipt = await makeReceipt(Number(certified.certified_amount));
    await allocate(receipt.id, bill.data.id, Number(certified.certified_amount));

    const cancelled = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CANCELLED", reason: "Contract terminated" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(422);
    expect(cancelled.body.code).toBe("RA_BILL_OVER_ALLOCATED");

    await reverse(receipt.id);
    const retried = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CANCELLED", reason: "Contract terminated" });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it("never leaves the bill over-allocated when a receipt races certification", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 1000); // gross/net 450,000, no deductions
    await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });
    const net = Number((await billRow(bill.data.id)).net_payable);

    // Already allocated up to what a lower certification would still cover.
    const lower = net - 50_000;
    const firstReceipt = await makeReceipt(lower);
    const firstAlloc = await allocate(firstReceipt.id, bill.data.id, lower);
    expect(firstAlloc.status, JSON.stringify(firstAlloc.body)).toBe(201);

    // Fired together: one more receipt for the remaining slack under the OLD
    // (net_payable) cap, racing a certification that would shrink the cap
    // below what that second receipt claims.
    const secondReceipt = await makeReceipt(net - lower);
    const [certifyRes, allocRes] = await Promise.all([
      post({ ...w.admin, ...(await billVersion(bill.data.id)) },
        `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CERTIFIED", certified_amount: lower }),
      allocate(secondReceipt.id, bill.data.id, net - lower),
    ]);

    // Whichever wins the row lock first, the other must lose -- both
    // succeeding would over-allocate the bill.
    const succeeded = [certifyRes.status, allocRes.status].filter(s => s < 300);
    expect(succeeded.length, JSON.stringify({ certifyRes, allocRes })).toBeLessThanOrEqual(1);

    const finalBill = await billRow(bill.data.id);
    const finalPayable = finalBill.status === "CERTIFIED"
      ? Number(finalBill.certified_amount) : Number(finalBill.net_payable);
    const finalAllocated = Number((await w.pool.query(
      `SELECT COALESCE(sum(a.amount),0) AS total FROM payment_allocations a
        JOIN payments p ON p.id = a.payment_id
       WHERE a.document_type='RA_BILL' AND a.document_id=$1
         AND a.reversed_at IS NULL AND p.reversed_at IS NULL`, [bill.data.id])).rows[0].total);
    expect(finalAllocated).toBeLessThanOrEqual(finalPayable + 0.005);
  });

  it("counts TDS/advance toward what is already settled, not just cash (fix round 2, item 1(b), defence in depth)", async () => {
    // APAR-2 (packages/shared/src/financial-control.ts's
    // paymentAllocationSchema) already refuses a caller setting tds_amount
    // or advance_adjusted on an RA_BILL allocation through the API -- the
    // only path that writes payment_allocations with caller-controlled
    // fields (see ledgers.test.ts's "never lets the bulk payment-run path
    // ..." for the other one). This bypasses that schema on purpose, the
    // way a data import or a fix script would, to prove the certify-time
    // check itself does not silently under-count such a row if one ever
    // exists: settlementPosition/checkAllocation treat tds_amount and
    // advance_adjusted as settled money, same as cash, and the over-
    // allocation guard has to agree or it would let a bill certify below
    // what is genuinely already closed out.
    const { projectId, boqItemId } = await projectWithBoq();
    const bill = await raiseBill(projectId, boqItemId, 1000); // gross/net 450,000, no deductions
    await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "SUBMITTED" });

    const receipt = await w.pool.query(
      `INSERT INTO payments(org_id, created_by, payment_no, direction, paid_on, amount, mode)
       VALUES($1,$2,$3,'RECEIVABLE','2026-09-10',400000,'NEFT') RETURNING id`,
      [w.orgId, w.adminId, uniq("RCP")]);
    await w.pool.query(
      `INSERT INTO payment_allocations(org_id, created_by, payment_id, document_type, document_id,
         amount, tds_amount)
       VALUES($1,$2,$3,'RA_BILL',$4,400000,50000)`,
      [w.orgId, w.adminId, receipt.rows[0].id, bill.data.id]);

    // 400,000 cash + 50,000 TDS = 450,000 already settled. Certifying at
    // 440,000 would leave the bill claiming less than is already closed
    // out -- refused, even though the raw cash column alone (400,000)
    // would fit comfortably under 440,000.
    const tooLow = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CERTIFIED", certified_amount: 440_000 });
    expect(tooLow.status, JSON.stringify(tooLow.body)).toBe(422);
    expect(tooLow.body.code).toBe("RA_BILL_OVER_ALLOCATED");

    const enough = await post({ ...w.admin, ...(await billVersion(bill.data.id)) },
      `/api/v1/ra-bills/${bill.data.id}/status`, { status: "CERTIFIED", certified_amount: 450_000 });
    expect(enough.status, JSON.stringify(enough.body)).toBe(200);
  });
});

describe("retention", () => {
  async function certifiedWithRetention(dlpEndDate: string | null) {
    const { projectId, boqItemId } = await projectWithBoq();
    await put(w.admin, `/api/v1/projects/${projectId}/billing-policy`, { retention_pct: 5 });
    if (dlpEndDate) {
      await w.pool.query("UPDATE project_billing_policies SET dlp_end_date=$2 WHERE project_id=$1",
        [projectId, dlpEndDate]);
    }
    const bill = await raiseBill(projectId, boqItemId, 1000);
    await certify(bill.data.id);
    return projectId;
  }

  it("moves retention into the ledger on certification", async () => {
    const projectId = await certifiedWithRetention("2027-06-30");
    const view = (await get(w.admin, `/api/v1/projects/${projectId}/retention`)).data;
    expect(Number(view.held)).toBe(22_500);
    expect(view.ledger[0].entry_type).toBe("WITHHELD");
  });

  it("§6.7 refuses release before the defect liability period ends", async () => {
    const projectId = await certifiedWithRetention("2099-12-31");
    const res = await post(w.admin, `/api/v1/projects/${projectId}/retention/release`, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DLP_NOT_ENDED");
  });

  it("releases once the period has ended", async () => {
    const projectId = await certifiedWithRetention("2020-01-01");
    const res = await post(w.admin, `/api/v1/projects/${projectId}/retention/release`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const view = (await get(w.admin, `/api/v1/projects/${projectId}/retention`)).data;
    expect(Number(view.held)).toBe(0);
  });

  it("refuses to release more than is held", async () => {
    const projectId = await certifiedWithRetention("2020-01-01");
    const res = await post(w.admin, `/api/v1/projects/${projectId}/retention/release`, { amount: 99_999 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EXCEEDS_RELEASABLE");
  });

  it("refuses release when no defect liability period is configured", async () => {
    // Releasing with no DLP on file would bypass the §6.7 gate entirely.
    const projectId = await certifiedWithRetention(null);
    const res = await post(w.admin, `/api/v1/projects/${projectId}/retention/release`, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DLP_NOT_CONFIGURED");
  });
});

describe("role boundaries", () => {
  it("hides billing from an ordinary employee", async () => {
    const { projectId } = await projectWithBoq();
    expect((await get(w.role.EMPLOYEE, `/api/v1/projects/${projectId}/ra-bills`)).status).toBe(403);
    expect((await get(w.role.EMPLOYEE, `/api/v1/projects/${projectId}/retention`)).status).toBe(403);
  });

  it("lets the Auditor read bills but never raise one", async () => {
    const { projectId, boqItemId } = await projectWithBoq();
    expect((await get(w.role.AUDITOR, `/api/v1/projects/${projectId}/ra-bills`)).status).toBe(200);
    const res = await post(w.role.AUDITOR, "/api/v1/ra-bills", {
      project_id: projectId, period_from: "2026-08-01", period_to: "2026-08-31",
      lines: [{ boq_item_id: boqItemId, cumulative_quantity: 100 }],
    });
    expect(res.status).toBe(403);
  });
});

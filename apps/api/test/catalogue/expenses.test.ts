/**
 * End-to-end cover for expense management and project cost control
 * (§6.8, §15.6, §16).
 *
 * These run against a real database because the answers depend on things no
 * unit test can stand in for: the approval ladder actually having been
 * cleared, a unique index refusing a bill that was already claimed, and cost
 * reaching the project ledger only once.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;

async function send(
  method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE", headers: Headers, url: string, payload?: unknown,
) {
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
const del = (h: Headers, u: string) => send("DELETE", h, u);

async function ver(table: string, id: string): Promise<Headers> {
  const r = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  return { "if-match": String(r.rows[0].version) };
}

let materialHead: string;
let labourHead: string;

/** A DoA ladder for expense claims, so submission has somewhere to go. */
async function ladder() {
  const res = await post(w.admin, "/api/v1/approval-policies", {
    document_type: "EXPENSE_CLAIM", name: `Expense DoA ${uniq()}`,
    levels: [
      { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: "PROJECT_MANAGER" },
      { sequence: 2, min_amount: 50_000, max_amount: null, approver_role: "ADMIN" },
    ],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function makeCostHead(code: string, kind: string) {
  const res = await post(w.admin, "/api/v1/cost-heads", { code, name: `Head ${code}`, kind });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data.id as string;
}

async function makePolicy(body: Record<string, unknown>) {
  const res = await post(w.admin, "/api/v1/expense-policies", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data;
}

/** Raise a claim as the field employee, who is the claimant in most of these. */
async function makeClaim(lines: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  const res = await post(w.directUser, "/api/v1/expense-claims", {
    claim_no: uniq("EXP"), claim_date: "2026-05-05", purpose: "Site visit", lines, ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data;
}

/**
 * A claim charged to a project, raised by the admin.
 *
 * The platform-wide record-scope guard refuses a `project_id` from an actor
 * whose scope does not reach that project — correctly, since an employee
 * charging cost to a site they have nothing to do with is exactly what needs a
 * second look. So the admin raises and the project manager approves, which
 * also keeps maker-checker satisfied.
 */
async function makeProjectClaim(lines: Record<string, unknown>[]) {
  const res = await post(w.admin, "/api/v1/expense-claims", {
    claim_no: uniq("EXP"), claim_date: "2026-05-05", purpose: "Site spend",
    project_id: w.activeProject, lines,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data;
}

/** Submit a claim and clear its ladder, leaving it ready for a decision. */
async function clearLadder(claimId: string, raiser: Headers = w.directUser) {
  const submitted = await post(
    { ...raiser, ...(await ver("expense_claims", claimId)) },
    `/api/v1/expense-claims/${claimId}/submit`, {});
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const approvalId = submitted.data.approval_id;
  const decision = await post(
    { ...w.role.PROJECT_MANAGER, ...(await ver("approval_instances", approvalId)) },
    `/api/v1/approvals/${approvalId}/decision`, { decision: "APPROVE" });
  expect(decision.status, JSON.stringify(decision.body)).toBe(200);
  return approvalId;
}

beforeAll(async () => {
  w = await buildWorld();
  await ladder();
  materialHead = await makeCostHead(uniq("MAT"), "MATERIAL");
  labourHead = await makeCostHead(uniq("LAB"), "LABOUR");
  await makePolicy({ category: "TRAVEL", effective_from: "2026-04-01", requires_receipt_above: 1000 });
  await makePolicy({
    category: "LODGING", effective_from: "2026-04-01",
    per_line_limit: 3000, per_claim_limit: 5000, requires_receipt_above: 500,
  });
  await makePolicy({ category: "PER_DIEM", effective_from: "2026-04-01", unit_rate: 800 });
  await makePolicy({ category: "SITE_MATERIALS_PETTY", effective_from: "2026-04-01", requires_receipt_above: 500 });
}, 180_000);

afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("cost heads", () => {
  it("refuses a second head with the same code", async () => {
    const code = uniq("DUP");
    expect((await post(w.admin, "/api/v1/cost-heads", { code, name: "A", kind: "OTHER" })).status).toBe(201);
    const again = await post(w.admin, "/api/v1/cost-heads", { code, name: "B", kind: "OTHER" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("DUPLICATE_COST_HEAD");
  });

  it("keeps a project manager out of the master", async () => {
    // A PM sets budgets; the chart of cost heads is an organisation-wide
    // master and forking it per site defeats cross-project comparison.
    expect((await post(w.role.PROJECT_MANAGER, "/api/v1/cost-heads",
      { code: uniq("PM"), name: "X", kind: "OTHER" })).status).toBe(403);
  });
});

describe("project budget", () => {
  it("demands a reason before a budget is revised", async () => {
    const first = await put(w.role.PROJECT_MANAGER, `/api/v1/projects/${w.activeProject}/budget`, {
      lines: [{ cost_head_id: materialHead, budgeted_amount: 500000 }],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    // A budget that moves without a stated reason is the single hardest thing
    // to explain to an auditor six months later.
    const blind = await put(w.role.PROJECT_MANAGER, `/api/v1/projects/${w.activeProject}/budget`, {
      lines: [{ cost_head_id: materialHead, budgeted_amount: 900000 }],
    });
    expect(blind.status).toBe(422);
    expect(blind.body.code).toBe("REVISION_REASON_REQUIRED");
  });

  it("supersedes the prior revision rather than overwriting it", async () => {
    const revised = await put(w.role.PROJECT_MANAGER, `/api/v1/projects/${w.activeProject}/budget`, {
      revision_reason: "Scope increase approved by the client",
      lines: [{ cost_head_id: materialHead, budgeted_amount: 900000 }],
    });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);

    const live = await get(w.role.PROJECT_MANAGER, `/api/v1/projects/${w.activeProject}/budget`);
    expect(live.data).toHaveLength(1);
    expect(Number(live.data[0].budgeted_amount)).toBe(900000);

    const history = await w.pool.query(
      "SELECT count(*)::int AS n FROM project_budgets WHERE project_id = $1", [w.activeProject]);
    expect(history.rows[0].n).toBeGreaterThan(1);
  });

  it("refuses the same cost head twice in one budget", async () => {
    const res = await put(w.role.PROJECT_MANAGER, `/api/v1/projects/${w.activeProject}/budget`, {
      revision_reason: "Test",
      lines: [
        { cost_head_id: labourHead, budgeted_amount: 100 },
        { cost_head_id: labourHead, budgeted_amount: 200 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DUPLICATE_COST_HEAD");
  });
});

describe("expense policy", () => {
  it("closes the standing policy the day before its replacement starts", async () => {
    // Raising a limit must not retroactively legitimise last month's overspend,
    // so the old rule stays, closed on the day before.
    await makePolicy({ category: "COMMUNICATION", effective_from: "2026-04-01", per_line_limit: 500 });
    await makePolicy({ category: "COMMUNICATION", effective_from: "2026-09-01", per_line_limit: 900 });

    const rows = await w.pool.query(
      `SELECT effective_from, effective_to, per_line_limit FROM expense_policies
       WHERE org_id = $1 AND category = 'COMMUNICATION' ORDER BY effective_from`, [w.orgId]);
    expect(rows.rows).toHaveLength(2);
    expect(String(rows.rows[0].effective_to).slice(0, 10)).toBe("2026-08-31");
    expect(rows.rows[1].effective_to).toBeNull();
  });

  it("refuses a replacement that starts before the policy it replaces", async () => {
    await makePolicy({ category: "FUEL", effective_from: "2026-06-01", per_line_limit: 2000 });
    const res = await post(w.admin, "/api/v1/expense-policies", {
      category: "FUEL", effective_from: "2026-05-01", per_line_limit: 3000,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("POLICY_OVERLAP");
  });

  it("will not accept a per-diem policy with no rate", async () => {
    const res = await post(w.admin, "/api/v1/expense-policies", {
      category: "PER_DIEM", effective_from: "2027-01-01", per_line_limit: 1000,
    });
    expect(res.status).toBe(422);
  });
});

describe("claim evaluation", () => {
  it("tells a field engineer a bill is over the limit before they submit", async () => {
    // Mobile quick-capture needs the answer while they are still at the
    // counter, not a week later when finance rejects the claim.
    const res = await post(w.directUser, "/api/v1/expense-claims/evaluate", {
      lines: [{
        category: "LODGING", expense_date: "2026-05-01", description: "Hotel",
        amount: 4200, receipt_document_id: null,
      }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.totalAllowed).toBe(3000);
    expect(res.data.totalExcess).toBe(1200);
    expect(res.data.requiresOverride).toBe(true);
  });

  it("values a per-diem as days times rate with no receipt", async () => {
    const res = await post(w.directUser, "/api/v1/expense-claims/evaluate", {
      lines: [{
        category: "PER_DIEM", expense_date: "2026-05-01", description: "3 days on site",
        amount: 2400, units: 3,
      }],
    });
    expect(res.data.totalAllowed).toBe(2400);
    expect(res.data.requiresOverride).toBe(false);
  });
});

describe("duplicate receipts", () => {
  it("refuses a bill this organisation has already claimed", async () => {
    // The commonest expense fraud in field operations: one fuel bill claimed
    // by two engineers, or the same bill re-submitted next month.
    const invoice = uniq("INV");
    const line = {
      category: "SITE_MATERIALS_PETTY", expense_date: "2026-05-01", description: "Cement",
      amount: 1200, vendor_gstin: "29AAACS1234A1ZK", invoice_no: invoice,
      receipt_document_id: null,
    };
    await makeClaim([line]);

    const second = await post(w.siteUser, "/api/v1/expense-claims", {
      claim_no: uniq("EXP"), claim_date: "2026-06-01", purpose: "Same bill again",
      lines: [line],
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("DUPLICATE_RECEIPT");
    expect(second.body.message).toContain(invoice);
  });

  it("allows two genuine bills that carry no invoice number", async () => {
    // Two refuellings on one day is ordinary. A control that blocks it trains
    // people to work around it.
    const line = {
      category: "SITE_MATERIALS_PETTY", expense_date: "2026-05-02", description: "Sundries",
      amount: 300, receipt_document_id: null,
    };
    const claim = await makeClaim([line, { ...line }]);
    expect(claim.lines).toHaveLength(2);
  });

  it("releases the bills when a claim is withdrawn", async () => {
    const invoice = uniq("INV");
    const line = {
      category: "SITE_MATERIALS_PETTY", expense_date: "2026-05-03", description: "Sand",
      amount: 800, vendor_name: "Local supplier", invoice_no: invoice, receipt_document_id: null,
    };
    const claim = await makeClaim([line]);
    const withdrawn = await post(
      { ...w.directUser, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/withdraw`, { reason: "Keyed against the wrong project" });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);

    // A withdrawn claim never paid for the bill, so a corrected claim has to
    // be able to use it.
    const again = await makeClaim([line]);
    expect(again.lines).toHaveLength(1);
  });
});

describe("submission and maker-checker", () => {
  it("refuses to submit a claim with no lines", async () => {
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Taxi", amount: 400,
    }]);
    await w.pool.query("DELETE FROM expense_lines WHERE claim_id = $1", [claim.id]);
    const res = await post(
      { ...w.directUser, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/submit`, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NO_LINES");
  });

  it("will not let the raiser approve their own claim", async () => {
    // The raiser here holds approval.act, so the refusal comes from
    // maker-checker rather than from the permission guard.
    const claim = await post(w.role.PROJECT_MANAGER, "/api/v1/expense-claims", {
      claim_no: uniq("EXP"), claim_date: "2026-05-05", purpose: "Own travel",
      lines: [{ category: "TRAVEL", expense_date: "2026-05-01", description: "Taxi", amount: 400 }],
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    const submitted = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.data.id)) },
      `/api/v1/expense-claims/${claim.data.id}/submit`, {});
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const res = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.data.id)) },
      `/api/v1/expense-claims/${claim.data.id}/decision`, { status: "APPROVED" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SELF_APPROVAL");
  });

  it("will not let the claimant approve a claim a clerk keyed in for them", async () => {
    // The generic approval engine only knows the raiser. Without the claimant
    // check, a manager whose expenses were keyed in by a site clerk approves
    // their own spend.
    const pmUserId = w.roleUserId.PROJECT_MANAGER;
    await w.pool.query("UPDATE users SET employee_id = NULL WHERE id = $1", [w.directUserId]);
    await w.pool.query("UPDATE users SET employee_id = $2 WHERE id = $1", [pmUserId, w.directEmployee]);
    try {
      const claim = await post(w.admin, "/api/v1/expense-claims", {
        claim_no: uniq("EXP"), claim_date: "2026-05-05", purpose: "Manager travel",
        employee_id: w.directEmployee,
        lines: [{ category: "TRAVEL", expense_date: "2026-05-01", description: "Flight", amount: 900 }],
      });
      expect(claim.status, JSON.stringify(claim.body)).toBe(201);
      expect(claim.data.claimant_user_id).toBe(pmUserId);

      await clearLadder(claim.data.id, w.admin);

      const res = await post(
        { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.data.id)) },
        `/api/v1/expense-claims/${claim.data.id}/decision`, { status: "APPROVED" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("SELF_APPROVAL");
      expect(res.body.message).toContain("your own expenses");
    } finally {
      await w.pool.query("UPDATE users SET employee_id = NULL WHERE id = $1", [pmUserId]);
      await w.pool.query("UPDATE users SET employee_id = $2 WHERE id = $1", [w.directUserId, w.directEmployee]);
    }
  });

  it("will not let an ordinary employee record the outcome", async () => {
    // Every employee holds expense.read so they can follow their own claim.
    // Gating the decision on that would let any colleague flip a claim to
    // approved the moment the ladder cleared, and the authority matrix would
    // be deciding nothing.
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Taxi", amount: 350,
    }]);
    await clearLadder(claim.id);
    const res = await post(
      { ...w.siteUser, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(res.status).toBe(403);
  });

  it("refuses approval while the ladder is still pending", async () => {
    // Without this the claim is approved by whoever opens it first and the
    // authority matrix is decoration.
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Bus", amount: 300,
    }]);
    await post({ ...w.directUser, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/submit`, {});
    const res = await post(
      { ...w.admin, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NOT_APPROVED");
  });
});

describe("policy override", () => {
  it("refuses an over-policy approval from someone without the override", async () => {
    const claim = await makeClaim([{
      category: "LODGING", expense_date: "2026-05-01", description: "Hotel",
      amount: 4200, receipt_document_id: null,
    }]);
    await clearLadder(claim.id);
    const res = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OVERRIDE_REQUIRED");
  });

  it("demands a stated reason even from someone who holds the override", async () => {
    const claim = await makeClaim([{
      category: "LODGING", expense_date: "2026-05-01", description: "Hotel",
      amount: 4200, receipt_document_id: null,
    }]);
    await clearLadder(claim.id);
    const res = await post(
      { ...w.admin, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("OVERRIDE_REASON_REQUIRED");
  });

  it("records who allowed the excess and why", async () => {
    const claim = await makeClaim([{
      category: "LODGING", expense_date: "2026-05-01", description: "Hotel",
      amount: 4200, receipt_document_id: null,
    }]);
    await clearLadder(claim.id);
    const res = await post(
      { ...w.admin, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, {
        status: "APPROVED",
        override_reason: "Only room available during the district conference",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number(res.data.approved_amount)).toBe(4200);
    expect(res.data.override_by).toBe(w.adminId);

    // The policy-exception report at §16.5 is only possible because the reason
    // was captured here rather than reconstructed later.
    const report = await get(w.admin, "/api/v1/expense-reports?group_by=exception");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const row = report.data.find((r: any) => r.id === claim.id);
    expect(row.override_reason).toContain("district conference");
  });

  it("approves a within-policy claim at the allowed amount", async () => {
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Train", amount: 700,
    }]);
    await clearLadder(claim.id);
    const res = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number(res.data.approved_amount)).toBe(700);
    expect(res.data.override_reason).toBeNull();
  });
});

describe("project cost linkage", () => {
  it("moves nothing onto the project until the claim is approved", async () => {
    const claim = await makeProjectClaim([{
      category: "SITE_MATERIALS_PETTY", expense_date: "2026-05-01", description: "Bricks",
      amount: 5000, billable_to_client: true, cost_head_id: materialHead,
      receipt_document_id: null,
    }]);

    // Cost that might still be rejected is not cost. A project manager reading
    // it would be reading a number that is not yet true.
    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM project_cost_entries WHERE source_id = $1", [claim.id]);
    expect(before.rows[0].n).toBe(0);

    await clearLadder(claim.id, w.admin);
    const approved = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const after = await w.pool.query(
      "SELECT * FROM project_cost_entries WHERE source_id = $1", [claim.id]);
    expect(after.rows).toHaveLength(1);
    expect(Number(after.rows[0].amount)).toBe(5000);
    expect(after.rows[0].nature).toBe("ACTUAL");
  });

  it("charges the project net of the tax it gets back", async () => {
    // 11800 with 1800 recoverable GST costs the project 10000. Charging gross
    // is how site profitability is quietly understated.
    const claim = await makeProjectClaim([{
      category: "SITE_MATERIALS_PETTY", expense_date: "2026-05-04", description: "Steel",
      amount: 11800, gst_amount: 1800, vendor_gstin: "29AAACS1234A1ZK", invoice_no: uniq("INV"),
      billable_to_client: true, cost_head_id: materialHead, receipt_document_id: null,
    }]);
    await clearLadder(claim.id, w.admin);
    const approved = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const entry = await w.pool.query(
      "SELECT amount FROM project_cost_entries WHERE source_id = $1", [claim.id]);
    expect(Number(entry.rows[0].amount)).toBe(10000);
  });

  it("leaves a non-billable line off the project entirely", async () => {
    const claim = await makeProjectClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Taxi home", amount: 250,
    }]);
    await clearLadder(claim.id, w.admin);
    await post({ ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });

    const entry = await w.pool.query(
      "SELECT count(*)::int AS n FROM project_cost_entries WHERE source_id = $1", [claim.id]);
    expect(entry.rows[0].n).toBe(0);
  });

  it("reports budget, actual and variance by head", async () => {
    const res = await get(w.role.PROJECT_MANAGER, `/api/v1/projects/${w.activeProject}/cost-position`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const material = res.data.heads.find((h: any) => h.costHeadId === materialHead);
    expect(material.actual).toBeGreaterThan(0);
    expect(material.budgeted).toBe(900000);
    expect(material.variance).toBe(900000 - material.forecast);
    expect(res.data.totals.actual).toBeGreaterThan(0);
  });
});

describe("reimbursement", () => {
  async function approvedClaim(amount: number) {
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Travel", amount,
    }]);
    await clearLadder(claim.id);
    const approved = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return claim.id as string;
  }

  it("will not pay a claim nobody approved", async () => {
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Travel", amount: 500,
    }]);
    const res = await post(w.role.PAYROLL_OFFICER, `/api/v1/expense-claims/${claim.id}/reimburse`, {
      amount: 500, paid_on: "2026-05-10", mode: "NEFT",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NOT_APPROVED");
  });

  it("refuses to pay more than is outstanding", async () => {
    const claimId = await approvedClaim(800);
    const res = await post(w.role.PAYROLL_OFFICER, `/api/v1/expense-claims/${claimId}/reimburse`, {
      amount: 900, paid_on: "2026-05-10", mode: "NEFT",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("OVERPAYMENT");
  });

  it("settles a claim only when the balance reaches zero", async () => {
    const claimId = await approvedClaim(1000);
    const part = await post(w.role.PAYROLL_OFFICER, `/api/v1/expense-claims/${claimId}/reimburse`, {
      amount: 600, paid_on: "2026-05-10", mode: "NEFT", reference: "UTR600",
    });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    expect(part.data.claim_settled).toBe(false);

    const still = await get(w.admin, `/api/v1/expense-claims/${claimId}`);
    expect(still.data.status).toBe("APPROVED");
    expect(still.data.reimbursement.outstanding).toBe(400);

    const rest = await post(w.role.PAYROLL_OFFICER, `/api/v1/expense-claims/${claimId}/reimburse`, {
      amount: 400, paid_on: "2026-05-20", mode: "NEFT", reference: "UTR400",
    });
    expect(rest.data.claim_settled).toBe(true);

    const settled = await get(w.admin, `/api/v1/expense-claims/${claimId}`);
    expect(settled.data.status).toBe("REIMBURSED");
    expect(settled.data.reimbursement.outstanding).toBe(0);
  });

  it("keeps the project manager out of the payment run", async () => {
    const claimId = await approvedClaim(500);
    expect((await post(w.role.PROJECT_MANAGER, `/api/v1/expense-claims/${claimId}/reimburse`, {
      amount: 500, paid_on: "2026-05-10", mode: "NEFT",
    })).status).toBe(403);
  });
});

describe("visibility", () => {
  it("shows an employee their own claims and nobody else's", async () => {
    await makeClaim([{ category: "TRAVEL", expense_date: "2026-05-01", description: "Bus", amount: 100 }]);
    const mine = await get(w.directUser, "/api/v1/expense-claims");
    expect(mine.status).toBe(200);
    for (const claim of mine.data) {
      expect([claim.claimant_user_id, claim.requested_by]).toContain(w.directUserId);
    }

    const everything = await get(w.admin, "/api/v1/expense-claims");
    expect(everything.data.length).toBeGreaterThan(mine.data.length);
  });

  it("refuses an employee the detail of somebody else's claim", async () => {
    const other = await post(w.siteUser, "/api/v1/expense-claims", {
      claim_no: uniq("EXP"), claim_date: "2026-05-05", purpose: "Their trip",
      lines: [{ category: "TRAVEL", expense_date: "2026-05-01", description: "Taxi", amount: 200 }],
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const res = await get(w.directUser, `/api/v1/expense-claims/${other.data.id}`);
    expect(res.status).toBe(403);
  });

  it("keeps the report away from someone who only sees their own", async () => {
    expect((await get(w.directUser, "/api/v1/expense-reports?group_by=employee")).status).toBe(403);
  });
});

describe("reporting", () => {
  it("groups spend by category", async () => {
    const res = await get(w.admin, "/api/v1/expense-reports?group_by=category");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    for (const row of res.data) expect(Number(row.claimed)).toBeGreaterThan(0);
  });

  it("ages pending approvals from submission, not from the expense date", async () => {
    // An employee who sat on a receipt for a month has not created an
    // approval backlog.
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-01-01", description: "Old receipt", amount: 400,
    }]);
    await post({ ...w.directUser, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/submit`, {});
    const res = await get(w.admin, "/api/v1/expense-reports?group_by=aging");
    const row = res.data.find((r: any) => r.id === claim.id);
    expect(row).toBeTruthy();
    expect(row.days_pending).toBeLessThan(2);
  });

  it("rejects an unknown grouping rather than returning the wrong one", async () => {
    const res = await get(w.admin, "/api/v1/expense-reports?group_by=nonsense");
    expect(res.status).toBe(422);
  });
});

describe("tenant isolation", () => {
  it("will not read another organisation's claim", async () => {
    const claim = await makeClaim([{
      category: "TRAVEL", expense_date: "2026-05-01", description: "Taxi", amount: 300,
    }]);
    const res = await get(w.other.admin, `/api/v1/expense-claims/${claim.id}`);
    expect(res.status).toBe(404);
  });

  it("will not read another organisation's cost position", async () => {
    const res = await get(w.other.admin, `/api/v1/projects/${w.activeProject}/cost-position`);
    expect(res.status).toBe(404);
  });
});

describe("expense receipts (B-003)", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex");
  const png = (extra = "payload") => Buffer.concat([PNG, Buffer.from(extra)]).toString("base64");

  async function draftClaim() {
    return makeClaim(
      [{ category: "TRAVEL", expense_date: "2026-05-01", description: "Taxi", amount: 300 }],
    );
  }

  it("attaches a receipt while the claim is a draft, lists it and downloads it back", async () => {
    const claim = await draftClaim();
    const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "taxi-bill.png", content_base64: png(),
    });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    expect(upload.data.file_name).toBe("taxi-bill.png");
    expect(upload.data.mime_type).toBe("image/png");

    const list = await get(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(upload.data.id);

    const download = await w.app.inject({
      method: "GET", url: `/api/v1/expense-claims/${claim.id}/receipts/${upload.data.id}/download`,
      headers: w.directUser,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.rawPayload.equals(Buffer.concat([PNG, Buffer.from("payload")]))).toBe(true);
  });

  it("still takes a receipt once the claim has been submitted", async () => {
    const claim = await draftClaim();
    await post({ ...w.directUser, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/submit`, {});
    const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "late.pdf", content_base64: Buffer.concat([Buffer.from("%PDF-1.4")]).toString("base64"),
    });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  });

  it("refuses a receipt once the claim has been decided", async () => {
    const claim = await draftClaim();
    await clearLadder(claim.id);
    // Clearing the ladder only settles the approval instance; the claim
    // itself is decided separately (see "will not let an ordinary employee
    // record the outcome" above), so that step is repeated here too.
    const approved = await post(
      { ...w.role.PROJECT_MANAGER, ...(await ver("expense_claims", claim.id)) },
      `/api/v1/expense-claims/${claim.id}/decision`, { status: "APPROVED" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "toolate.png", content_base64: png(),
    });
    expect(upload.status).toBe(409);
    expect(upload.body.code).toBe("CLAIM_NOT_EDITABLE");
  });

  it("refuses a file type outside the allow-list", async () => {
    const claim = await draftClaim();
    const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "receipt.gif", content_base64: Buffer.from("GIF89a").toString("base64"),
    });
    expect(upload.status).toBe(422);
    expect(upload.body.code).toBe("VALIDATION_ERROR");
  });

  it("refuses content that does not match its claimed extension", async () => {
    const claim = await draftClaim();
    const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "lying.png", content_base64: Buffer.from("not really a png").toString("base64"),
    });
    expect(upload.status).toBe(422);
    expect(upload.body.code).toBe("FILE_TYPE_MISMATCH");
  });

  it("refuses a file over the 10MB limit", async () => {
    const claim = await draftClaim();
    const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "huge.png", content_base64: big.toString("base64"),
    });
    expect(upload.status).toBe(422);
    const stored = await w.pool.query(
      "SELECT count(*)::int AS n FROM expense_receipts WHERE claim_id = $1", [claim.id]);
    expect(stored.rows[0].n).toBe(0);
  });

  it("refuses a sixth receipt on the same claim", async () => {
    const claim = await draftClaim();
    for (let i = 0; i < 5; i += 1) {
      const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
        file_name: `bill-${i}.png`, content_base64: png(`payload-${i}`),
      });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    }
    const sixth = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "bill-6.png", content_base64: png("payload-6"),
    });
    expect(sixth.status).toBe(422);
    expect(sixth.body.code).toBe("TOO_MANY_RECEIPTS");
  });

  it("refuses a non-claimant", async () => {
    const claim = await draftClaim();
    const upload = await post(w.siteUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "not-mine.png", content_base64: png(),
    });
    expect(upload.status).toBe(403);
  });

  it("refuses an infected file", async () => {
    let server: Server | undefined;
    process.env["MALWARE_SCANNER_HOST"] = "127.0.0.1";
    try {
      let received = Buffer.alloc(0);
      server = createServer((socket) => socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= 10 && received.subarray(0, 10).toString() === "zINSTREAM\0") {
          socket.end("stream: Test.Signature FOUND\0");
        }
      }));
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      process.env["MALWARE_SCANNER_PORT"] = String((server.address() as { port: number }).port);

      const claim = await draftClaim();
      const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
        file_name: "infected.png", content_base64: png(),
      });
      expect(upload.status).toBe(422);
      expect(upload.body.code).toBe("UNSAFE_FILE");
      const stored = await w.pool.query(
        "SELECT count(*)::int AS n FROM expense_receipts WHERE claim_id = $1", [claim.id]);
      expect(stored.rows[0].n).toBe(0);
    } finally {
      delete process.env["MALWARE_SCANNER_HOST"];
      delete process.env["MALWARE_SCANNER_PORT"];
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it("removes a receipt while the claim is still editable", async () => {
    const claim = await draftClaim();
    const upload = await post(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "remove-me.png", content_base64: png(),
    });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const removed = await del(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts/${upload.data.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const list = await get(w.directUser, `/api/v1/expense-claims/${claim.id}/receipts`);
    expect(list.data).toHaveLength(0);
  });

  it("will not read, attach to, or list another organisation's claim", async () => {
    const claim = await draftClaim();
    const upload = await post(w.other.admin, `/api/v1/expense-claims/${claim.id}/receipts`, {
      file_name: "cross-org.png", content_base64: png(),
    });
    expect(upload.status).toBe(404);
    const list = await get(w.other.admin, `/api/v1/expense-claims/${claim.id}/receipts`);
    expect(list.status).toBe(404);
  });
});

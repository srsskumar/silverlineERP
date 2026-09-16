/**
 * End-to-end cover for the approval engine (§41, §4.1).
 *
 * The decision logic is unit-tested in packages/shared. What is tested here is
 * what only a database can show: sequential gating under real locking, the
 * live-instance unique index, and the re-routing that must happen when a
 * document's amount moves after approvals have begun.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { workDate, buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

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

async function instanceVersion(id: string): Promise<Headers> {
  const r = await w.pool.query("SELECT version FROM approval_instances WHERE id = $1", [id]);
  return { "if-match": String(r.rows[0].version) };
}

/** A four-rung procurement ladder: TL → PM → ADMIN → SUPER_ADMIN. */
async function ladderPolicy(documentType = "PURCHASE_ORDER", over: Record<string, unknown> = {}) {
  const res = await post(w.admin, "/api/v1/approval-policies", {
    document_type: documentType, name: `DoA ${uniq()}`,
    levels: [
      { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: "TEAM_LEAD", sla_hours: 24 },
      { sequence: 2, min_amount: 50_000, max_amount: 500_000, approver_role: "PROJECT_MANAGER" },
      { sequence: 3, min_amount: 500_000, max_amount: 2_500_000, approver_role: "ADMIN" },
      { sequence: 4, min_amount: 2_500_000, max_amount: null, approver_role: "SUPER_ADMIN" },
    ],
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.data;
}

/** Submit as an ordinary employee so maker-checker has something to bite on. */
async function submit(amount: number, documentType = "PURCHASE_ORDER", as: Headers = w.role.EMPLOYEE) {
  return post(as, "/api/v1/approvals", {
    document_type: documentType, document_id: randomUUID(), amount,
  });
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("policy configuration", () => {
  it("refuses slabs that leave a gap", async () => {
    const res = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "EXPENSE_CLAIM", name: "Gapped",
      levels: [
        { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: "TEAM_LEAD" },
        { sequence: 2, min_amount: 90_000, max_amount: null, approver_role: "ADMIN" },
      ],
    });
    expect(res.status).toBe(422);
  });

  it("replaces the previous policy rather than stacking a second", async () => {
    // Two active policies for one document type make routing ambiguous.
    await ladderPolicy("ADVANCE");
    await ladderPolicy("ADVANCE");
    const live = await w.pool.query(
      "SELECT count(*)::int AS n FROM approval_policies WHERE org_id=$1 AND document_type='ADVANCE' AND active",
      [w.orgId]);
    expect(live.rows[0].n).toBe(1);
  });

  it("needs configuration before anything can be submitted", async () => {
    const res = await submit(1000, "RETENTION_RELEASE");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NO_APPROVAL_POLICY");
  });
});

describe("routing", () => {
  beforeAll(async () => { await ladderPolicy(); });

  it("routes a small amount to one level", async () => {
    const res = await submit(20_000);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.steps.map((s: any) => s.sequence)).toEqual([1]);
  });

  it("escalates through every level below in cumulative mode", async () => {
    const res = await submit(600_000);
    expect(res.data.steps.map((s: any) => s.sequence)).toEqual([1, 2, 3]);
  });

  it("starts the clock only on the step that is actually waiting", async () => {
    // Starting every clock would report levels overdue for time they spent
    // legitimately blocked behind an earlier approver.
    const res = await submit(600_000);
    const steps = await w.pool.query(
      "SELECT sequence, pending_since FROM approval_steps WHERE instance_id=$1 ORDER BY sequence",
      [res.data.id]);
    expect(steps.rows[0].pending_since).not.toBeNull();
    expect(steps.rows[1].pending_since).toBeNull();
  });

  it("refuses a second live approval for one document", async () => {
    const documentId = randomUUID();
    const body = { document_type: "PURCHASE_ORDER", document_id: documentId, amount: 10_000 };
    expect((await post(w.role.EMPLOYEE, "/api/v1/approvals", body)).status).toBe(201);
    const second = await post(w.role.EMPLOYEE, "/api/v1/approvals", { ...body, amount: 20_000 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("ALREADY_PENDING");
  });
});

describe("maker-checker and sequence", () => {
  beforeAll(async () => { await ladderPolicy(); });

  it("refuses to let the raiser approve their own request", async () => {
    // The TEAM_LEAD raises it, and level 1 is the team lead's own rung.
    const res = await submit(20_000, "PURCHASE_ORDER", w.role.TEAM_LEAD);
    expect(res.status).toBe(201);
    const decision = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decision.status).toBe(403);
    expect(decision.body.code).toBe("SELF_APPROVAL");
  });

  it("lets a different holder of the role approve", async () => {
    const res = await submit(20_000);
    const decision = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    expect(decision.data.status).toBe("APPROVED");
  });

  it("blocks a later level while an earlier one is pending", async () => {
    const res = await submit(600_000);
    const jump = await post({ ...w.role.ADMIN, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(jump.status).toBe(422);
    expect(jump.body.code).toBe("OUT_OF_SEQUENCE");
  });

  it("walks the ladder rung by rung", async () => {
    const res = await submit(600_000);
    const id = res.data.id;
    for (const [actor, expected] of [
      [w.role.TEAM_LEAD, "PENDING"],
      [w.role.PROJECT_MANAGER, "PENDING"],
      [w.role.ADMIN, "APPROVED"],
    ] as const) {
      const step = await post({ ...actor, ...(await instanceVersion(id)) },
        `/api/v1/approvals/${id}/decision`, { decision: "APPROVE" });
      expect(step.status, JSON.stringify(step.body)).toBe(200);
      expect(step.data.status).toBe(expected);
    }
    const steps = await w.pool.query(
      "SELECT status, acted_by FROM approval_steps WHERE instance_id=$1 ORDER BY sequence", [id]);
    expect(steps.rows.map(r => r.status)).toEqual(["APPROVED", "APPROVED", "APPROVED"]);
    expect(steps.rows.every(r => r.acted_by !== null)).toBe(true);
  });

  it("ends the request on rejection and records the reason", async () => {
    const res = await submit(600_000);
    const reject = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "REJECT", comments: "Rate above market" });
    expect(reject.status).toBe(200);
    expect(reject.data.status).toBe("REJECTED");
    expect(reject.data.rejection_reason).toContain("market");
  });

  it("insists a rejection carries a reason", async () => {
    const res = await submit(20_000);
    const reject = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "REJECT" });
    expect(reject.status).toBe(422);
  });

  it("refuses somebody without the step's role", async () => {
    const res = await submit(20_000);
    const decision = await post({ ...w.role.HR_MANAGER, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decision.status).toBe(422);
    expect(decision.body.code).toBe("NOT_THE_APPROVER");
  });
});

describe("re-routing when the amount moves", () => {
  beforeAll(async () => { await ladderPolicy(); });

  it("supersedes the instance when the amount rises into a higher band", async () => {
    // The classic hole: approved at 4 lakh, edited to 6 lakh, ships on the
    // old signature.
    const res = await submit(400_000);
    await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });

    const revalidated = await post(w.role.EMPLOYEE, `/api/v1/approvals/${res.data.id}/revalidate`, { amount: 600_000 });
    expect(revalidated.status, JSON.stringify(revalidated.body)).toBe(200);
    expect(revalidated.data.reapproval_required).toBe(true);

    const old = await w.pool.query("SELECT status, superseded_by FROM approval_instances WHERE id=$1", [res.data.id]);
    expect(old.rows[0].status).toBe("SUPERSEDED");
    expect(old.rows[0].superseded_by).toBe(revalidated.data.id);

    // The fresh ladder starts from the bottom again, not from where the old
    // one had reached.
    const steps = await w.pool.query(
      "SELECT sequence, status FROM approval_steps WHERE instance_id=$1 ORDER BY sequence", [revalidated.data.id]);
    expect(steps.rows.map(r => r.sequence)).toEqual([1, 2, 3]);
    expect(steps.rows.every(r => r.status === "PENDING")).toBe(true);
  });

  it("leaves a reduction inside the same band standing", async () => {
    const res = await submit(400_000);
    const revalidated = await post(w.role.EMPLOYEE, `/api/v1/approvals/${res.data.id}/revalidate`, { amount: 350_000 });
    expect(revalidated.data.reapproval_required).toBe(false);
    const row = await w.pool.query("SELECT status, amount FROM approval_instances WHERE id=$1", [res.data.id]);
    expect(row.rows[0].status).toBe("PENDING");
    expect(Number(row.rows[0].amount)).toBe(350_000);
  });

  it("honours a configured tolerance for minor variation", async () => {
    // Freight or rounding on a PO should not restart the ladder.
    await post(w.admin, "/api/v1/approval-policies", {
      document_type: "VENDOR_INVOICE", name: "Tolerant", tolerance_pct: 5,
      levels: [
        { sequence: 1, min_amount: 0, max_amount: 500_000, approver_role: "TEAM_LEAD" },
        { sequence: 2, min_amount: 500_000, max_amount: null, approver_role: "ADMIN" },
      ],
    });
    const res = await submit(100_000, "VENDOR_INVOICE");
    const small = await post(w.role.EMPLOYEE, `/api/v1/approvals/${res.data.id}/revalidate`, { amount: 102_000 });
    expect(small.data.reapproval_required).toBe(false);
    const large = await post(w.role.EMPLOYEE, `/api/v1/approvals/${res.data.id}/revalidate`, { amount: 130_000 });
    expect(large.data.reapproval_required).toBe(true);
  });

  it("marks the abandoned steps skipped rather than leaving them pending", async () => {
    const res = await submit(400_000);
    await post(w.role.EMPLOYEE, `/api/v1/approvals/${res.data.id}/revalidate`, { amount: 3_000_000 });
    const steps = await w.pool.query(
      "SELECT status FROM approval_steps WHERE instance_id=$1", [res.data.id]);
    expect(steps.rows.every(r => r.status !== "PENDING")).toBe(true);
  });
});

describe("delegation", () => {
  beforeAll(async () => { await ladderPolicy(); });

  it("lets the delegate act inside the window and records on whose authority", async () => {
    const today = workDate();
    const policy = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "PAYMENT", name: "Named approver",
      levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_user_id: w.roleUserId.PROJECT_MANAGER }],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);

    const delegation = await post(w.role.PROJECT_MANAGER, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.TEAM_LEAD,
      valid_from: today, valid_to: today, reason: "Annual leave",
    });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);

    const res = await submit(10_000, "PAYMENT");
    const decision = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);

    const step = await w.pool.query(
      "SELECT acted_by, acted_on_behalf_of FROM approval_steps WHERE instance_id=$1", [res.data.id]);
    expect(step.rows[0].acted_by).toBe(w.roleUserId.TEAM_LEAD);
    // The audit shows the act was taken on delegated authority.
    expect(step.rows[0].acted_on_behalf_of).toBe(w.roleUserId.PROJECT_MANAGER);
  });

  it("refuses a delegation that would close a cycle", async () => {
    // Both roles hold approval.delegate — delegating authority is a narrower
    // grant than exercising it, so most approvers cannot delegate at all.
    const today = workDate();
    const out = await post(w.role.ADMIN, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.PROJECT_MANAGER, valid_from: today, valid_to: today, reason: "Cover",
    });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const back = await post(w.role.PROJECT_MANAGER, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.ADMIN, valid_from: today, valid_to: today, reason: "Return cover",
    });
    expect(back.status).toBe(422);
    expect(back.body.code).toBe("DELEGATION_CYCLE");
  });

  it("refuses to let an approver without the grant delegate at all", async () => {
    const today = workDate();
    const res = await post(w.role.HR_MANAGER, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.TEAM_LEAD, valid_from: today, valid_to: today, reason: "Cover",
    });
    expect(res.status).toBe(403);
  });

  it("refuses delegating to yourself", async () => {
    const today = workDate();
    const res = await post(w.role.PROJECT_MANAGER, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.PROJECT_MANAGER, valid_from: today, valid_to: today, reason: "No-op",
    });
    expect(res.status).toBe(422);
  });

  it("stops the delegate acting once revoked", async () => {
    const today = workDate();
    const policy = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "LEAVE_REQUEST", name: "Named",
      levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_user_id: w.roleUserId.SUPER_ADMIN }],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);
    const delegation = await post(w.role.SUPER_ADMIN, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.PAYROLL_OFFICER, valid_from: today, valid_to: today, reason: "Cover",
    });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);
    const revoke = await post(w.role.SUPER_ADMIN,
      `/api/v1/approval-delegations/${delegation.data.id}/revoke`, {});
    expect(revoke.status).toBe(200);

    const res = await submit(5_000, "LEAVE_REQUEST");
    const decision = await post({ ...w.role.PAYROLL_OFFICER, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decision.status).toBe(422);
    expect(decision.body.code).toBe("NOT_THE_APPROVER");
  });
});

describe("recall and visibility", () => {
  beforeAll(async () => { await ladderPolicy(); });

  it("lets the requester withdraw a pending request", async () => {
    const res = await submit(20_000);
    const recall = await post({ ...w.role.EMPLOYEE, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/recall`, { reason: "Raised against the wrong project" });
    expect(recall.status, JSON.stringify(recall.body)).toBe(200);
    expect(recall.data.status).toBe("RECALLED");
  });

  it("does not let somebody else withdraw it", async () => {
    const res = await submit(20_000);
    const recall = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/recall`, { reason: "Not mine to pull" });
    expect(recall.status).toBe(403);
  });

  it("cannot withdraw a request already decided", async () => {
    const res = await submit(20_000);
    await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    const recall = await post({ ...w.role.EMPLOYEE, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/recall`, { reason: "Too late" });
    expect(recall.status).toBe(422);
    expect(recall.body.code).toBe("NOT_PENDING");
  });

  it("keeps an employee's view to their own requests", async () => {
    const mine = await submit(20_000, "PURCHASE_ORDER", w.role.EMPLOYEE);
    expect((await get(w.role.EMPLOYEE, `/api/v1/approvals/${mine.data.id}`)).status).toBe(200);

    const theirs = await submit(20_000, "PURCHASE_ORDER", w.role.SALES_BD_EXECUTIVE);
    const peek = await get(w.role.EMPLOYEE, `/api/v1/approvals/${theirs.data.id}`);
    expect(peek.status).toBe(403);
  });

  it("never shows an approver their own request in the inbox", async () => {
    const own = await submit(20_000, "PURCHASE_ORDER", w.role.TEAM_LEAD);
    const inbox = await get(w.role.TEAM_LEAD, "/api/v1/approvals/inbox");
    expect(inbox.status).toBe(200);
    expect(inbox.data.some((r: any) => r.id === own.data.id)).toBe(false);
  });

  it("shows an approver a request waiting on them", async () => {
    const res = await submit(20_000, "PURCHASE_ORDER", w.role.EMPLOYEE);
    const inbox = await get(w.role.TEAM_LEAD, "/api/v1/approvals/inbox");
    expect(inbox.data.some((r: any) => r.id === res.data.id)).toBe(true);
  });

  it("does not show a level still blocked behind an earlier one", async () => {
    const res = await submit(600_000, "PURCHASE_ORDER", w.role.EMPLOYEE);
    const inbox = await get(w.role.ADMIN, "/api/v1/approvals/inbox");
    expect(inbox.data.some((r: any) => r.id === res.data.id)).toBe(false);
  });
});

describe("role boundaries", () => {
  it("keeps the Auditor read-only", async () => {
    await ladderPolicy();
    const res = await submit(20_000);
    expect((await get(w.role.AUDITOR, `/api/v1/approvals/${res.data.id}`)).status).toBe(200);
    const decision = await post({ ...w.role.AUDITOR, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decision.status).toBe(403);
  });

  it("does not let an ordinary employee configure the authority matrix", async () => {
    const res = await post(w.role.EMPLOYEE, "/api/v1/approval-policies", {
      document_type: "EXPENSE_CLAIM", name: "Mine now",
      levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_role: "EMPLOYEE" }],
    });
    expect(res.status).toBe(403);
  });

  it("keeps the Client Viewer out entirely", async () => {
    expect((await get(w.role.CLIENT_VIEWER, "/api/v1/approval-policies")).status).toBe(403);
  });
});

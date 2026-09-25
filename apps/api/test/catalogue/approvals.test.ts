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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workDate, buildWorld, idem, uniq, createUser, PASSWORD, type CatalogueWorld, type Headers } from "./fixture.js";
import { seedDatabase } from "../../src/database/seed.js";

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

  describe("refuses a ladder that could never clear (fix round 2, item 2(a))", () => {
    it("refuses the same named approver at two levels", async () => {
      const res = await post(w.admin, "/api/v1/approval-policies", {
        document_type: "EXPENSE_CLAIM", name: `Same approver twice ${uniq()}`,
        levels: [
          { sequence: 1, min_amount: 0, max_amount: 50_000, approver_user_id: w.roleUserId.PROJECT_MANAGER },
          { sequence: 2, min_amount: 50_000, max_amount: null, approver_user_id: w.roleUserId.PROJECT_MANAGER },
        ],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("LADDER_UNRESOLVABLE");
      expect(res.body.message).toContain("levels 1 and 2");
    });

    it("refuses a role at two levels when the organisation has only one holder of it", async () => {
      // This fixture creates exactly one HR_MANAGER-role user. (Not ADMIN:
      // an ADMIN step is also met by the bootstrap SUPER_ADMIN since review
      // A, item 1, so one ADMIN plus the super admin are two people.)
      const res = await post(w.admin, "/api/v1/approval-policies", {
        document_type: "EXPENSE_CLAIM", name: `Only one HR manager ${uniq()}`,
        levels: [
          { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: "HR_MANAGER" },
          { sequence: 2, min_amount: 50_000, max_amount: null, approver_role: "HR_MANAGER" },
        ],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("LADDER_UNRESOLVABLE");
      expect(res.body.message).toContain("levels 1 and 2");
    });

    it("still refuses when the only other holder of the role is disabled (fix round 3)", async () => {
      // A disabled user keeps their user_roles row -- the holder count has
      // to filter auth_status itself, or a role with one active and one
      // disabled holder is wrongly treated as resolvable by two people.
      // Placed before the next test, which adds a second *active* admin:
      // this needs the fixture's original single active admin to still be
      // the only active one.
      const disabledHrId = await createUser(w.pool, w.orgId,
        { username: `cat_disabled_hr_${uniq()}`, roles: ["HR_MANAGER"] });
      await w.pool.query("UPDATE users SET auth_status = 'SUSPENDED' WHERE id = $1", [disabledHrId]);

      const res = await post(w.admin, "/api/v1/approval-policies", {
        document_type: "EXPENSE_CLAIM", name: `One active, one disabled HR manager ${uniq()}`,
        levels: [
          { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: "HR_MANAGER" },
          { sequence: 2, min_amount: 50_000, max_amount: null, approver_role: "HR_MANAGER" },
        ],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("LADDER_UNRESOLVABLE");
    });

    it("allows a role at two levels once a second holder exists", async () => {
      await createUser(w.pool, w.orgId, { username: `cat_second_admin_${uniq()}`, roles: ["ADMIN"] });
      const res = await post(w.admin, "/api/v1/approval-policies", {
        document_type: "EXPENSE_CLAIM", name: `Two admins ${uniq()}`,
        levels: [
          { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: "ADMIN" },
          { sequence: 2, min_amount: 50_000, max_amount: null, approver_role: "ADMIN" },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it("leaves two different named approvers, or two different roles, alone", async () => {
      const res = await post(w.admin, "/api/v1/approval-policies", {
        document_type: "EXPENSE_CLAIM", name: `Different people ${uniq()}`,
        levels: [
          { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: "TEAM_LEAD" },
          { sequence: 2, min_amount: 50_000, max_amount: null, approver_user_id: w.roleUserId.PROJECT_MANAGER },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
  });
});

describe("organisation-wide fallback approval ladders (owner decision 2026-09-24)", () => {
  // Placed before any describe below touches PURCHASE_ORDER or
  // PURCHASE_REQUISITION, so these run against exactly what seedDatabase()
  // left behind: nothing configured through the API, only the org-wide
  // default migration 101 (and seed.ts, for a brand new org) backfills.

  it("a fresh DB has the fallback for both document types, one ADMIN step, no amount band", async () => {
    const rows = await w.pool.query(
      `SELECT p.document_type, l.approver_role, l.min_amount, l.max_amount
         FROM approval_policies p JOIN approval_levels l ON l.policy_id = p.id
        WHERE p.org_id = $1 AND p.active AND p.project_id IS NULL
          AND p.document_type IN ('PURCHASE_REQUISITION', 'PURCHASE_ORDER')
        ORDER BY p.document_type`, [w.orgId]);
    expect(rows.rows.map(r => r.document_type)).toEqual(["PURCHASE_ORDER", "PURCHASE_REQUISITION"]);
    for (const row of rows.rows) {
      expect(row.approver_role, JSON.stringify(row)).toBe("ADMIN");
      expect(Number(row.min_amount)).toBe(0);
      expect(row.max_amount).toBeNull();
    }
  });

  it("routes a project-less requisition to the seeded org-wide ADMIN ladder", async () => {
    const res = await submit(50_000, "PURCHASE_REQUISITION", w.role.EMPLOYEE);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const steps = await w.pool.query(
      "SELECT approver_role FROM approval_steps WHERE instance_id=$1", [res.data.id]);
    expect(steps.rows.map(r => r.approver_role)).toEqual(["ADMIN"]);
  });

  it("a project with its own policy still uses it, not the org-wide fallback", async () => {
    const own = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "PURCHASE_REQUISITION", name: `Project ladder ${uniq()}`,
      project_id: w.activeProject,
      levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_role: "PROJECT_MANAGER" }],
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    const withProject = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_REQUISITION", document_id: randomUUID(), amount: 50_000,
      project_id: w.activeProject,
    });
    expect(withProject.status, JSON.stringify(withProject.body)).toBe(201);
    const projectSteps = await w.pool.query(
      "SELECT approver_role FROM approval_steps WHERE instance_id=$1", [withProject.data.id]);
    expect(projectSteps.rows.map(r => r.approver_role)).toEqual(["PROJECT_MANAGER"]);

    // A different, project-less requisition still falls back to org-wide.
    const orgWide = await submit(50_000, "PURCHASE_REQUISITION", w.role.EMPLOYEE);
    expect(orgWide.status, JSON.stringify(orgWide.body)).toBe(201);
    const orgSteps = await w.pool.query(
      "SELECT approver_role FROM approval_steps WHERE instance_id=$1", [orgWide.data.id]);
    expect(orgSteps.rows.map(r => r.approver_role)).toEqual(["ADMIN"]);
  });

  it("running migration 101 a second time creates no duplicate fallback policies", async () => {
    const count = async () => {
      const r = await w.pool.query(
        `SELECT count(*)::int AS n FROM approval_policies
          WHERE org_id = $1 AND active AND project_id IS NULL
            AND document_type IN ('PURCHASE_REQUISITION', 'PURCHASE_ORDER')`, [w.orgId]);
      return r.rows[0].n as number;
    };
    const before = await count();
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)),
        "../../src/database/migrations/101_org_fallback_approval_policies.sql"),
      "utf8");
    await w.pool.query(sql);
    await w.pool.query(sql);
    expect(await count()).toBe(before);
  });

  it("keeps the fallback scoped to its own organisation (cross-org isolation)", async () => {
    // The catalogue's test database is shared across every suite file in the
    // worker, and `organizations` is never truncated between them, so this
    // cannot assert "the other org has no policy of its own" as a given.
    // Instead it is made certain, deterministically: give the other tenant
    // its own active org-wide PURCHASE_REQUISITION ladder and switch this
    // org's off. If policy lookup ever crossed the org boundary -- the
    // `WHERE org_id = $1` in policyFor()/submitForApproval() -- this org's
    // submission would silently route through the other tenant's ladder
    // instead of refusing.
    await w.pool.query(
      `UPDATE approval_policies SET active = false
        WHERE org_id = $1 AND document_type = 'PURCHASE_REQUISITION' AND active AND project_id IS NULL`,
      [w.otherOrgId]);
    const otherPolicy = await w.pool.query(
      `INSERT INTO approval_policies(org_id, document_type, name, mode, project_id, active)
       VALUES($1, 'PURCHASE_REQUISITION', 'Other org ladder', 'CUMULATIVE', NULL, true) RETURNING id`,
      [w.otherOrgId]);
    await w.pool.query(
      `INSERT INTO approval_levels(org_id, policy_id, sequence, min_amount, max_amount, approver_role)
       VALUES($1, $2, 1, 0, NULL, 'ADMIN')`,
      [w.otherOrgId, otherPolicy.rows[0].id]);

    await w.pool.query(
      `UPDATE approval_policies SET active = false
        WHERE org_id = $1 AND document_type = 'PURCHASE_REQUISITION' AND active AND project_id IS NULL`,
      [w.orgId]);

    const res = await submit(50_000, "PURCHASE_REQUISITION", w.role.EMPLOYEE);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NO_APPROVAL_POLICY");
  });

  it("does not resurrect a fallback an administrator deliberately deactivated (fix round 1, minor)", async () => {
    // The previous test left w.orgId's PURCHASE_REQUISITION org-wide
    // fallback row deactivated but still in the table -- exactly the state
    // "Deactivate" in the web admin screen leaves behind. Re-seeding must
    // see that row and skip, not read "no *active* policy" as "none was
    // ever configured" and insert a fresh one on top of the deliberate
    // deactivation.
    const before = await w.pool.query(
      `SELECT count(*)::int AS n FROM approval_policies
        WHERE org_id = $1 AND document_type = 'PURCHASE_REQUISITION' AND project_id IS NULL`,
      [w.orgId]);
    expect(before.rows[0].n).toBeGreaterThan(0); // the deactivated row from the previous test

    await seedDatabase(w.pool, { bcryptRounds: 4 });

    const after = await w.pool.query(
      `SELECT active FROM approval_policies
        WHERE org_id = $1 AND document_type = 'PURCHASE_REQUISITION' AND project_id IS NULL
        ORDER BY created_at`,
      [w.orgId]);
    expect(after.rows.every(r => r.active === false), JSON.stringify(after.rows)).toBe(true);

    // Still refused -- the deactivation held.
    const res = await submit(50_000, "PURCHASE_REQUISITION", w.role.EMPLOYEE);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NO_APPROVAL_POLICY");

    // PURCHASE_ORDER's own fallback, never touched, is unaffected by the
    // re-seed either way -- this isn't a blanket skip of the whole loop.
    const poFallback = await w.pool.query(
      `SELECT 1 FROM approval_policies
        WHERE org_id = $1 AND document_type = 'PURCHASE_ORDER' AND active AND project_id IS NULL`,
      [w.orgId]);
    expect(poFallback.rowCount).toBeGreaterThan(0);
  });
});

describe("policy deactivation", () => {
  it("turns a policy off without a replacement, and refuses a stale version", async () => {
    const policy = await ladderPolicy("RA_BILL");

    // A version past the real one proves staleness is checked before anything changes.
    const wrong = await post(
      { ...w.admin, "if-match": String(Number(policy.version) + 1) },
      `/api/v1/approval-policies/${policy.id}/deactivate`);
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("VERSION_CONFLICT");

    const res = await post(
      { ...w.admin, "if-match": String(policy.version) },
      `/api/v1/approval-policies/${policy.id}/deactivate`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.active).toBe(false);

    const row = await w.pool.query("SELECT active FROM approval_policies WHERE id = $1", [policy.id]);
    expect(row.rows[0].active).toBe(false);

    // A document type with no active policy left behaves like it was never configured.
    const submitRes = await submit(1000, "RA_BILL");
    expect(submitRes.status).toBe(422);
    expect(submitRes.body.code).toBe("NO_APPROVAL_POLICY");

    // Already inactive: a second deactivation refuses.
    const again = await post(
      { ...w.admin, "if-match": String(Number(policy.version) + 1) },
      `/api/v1/approval-policies/${policy.id}/deactivate`);
    expect(again.status).toBe(422);
  });

  it("is refused to someone who only holds approval.act", async () => {
    const policy = await ladderPolicy("PAYMENT");
    const res = await post(
      { ...w.role.TEAM_LEAD, "if-match": String(policy.version) },
      `/api/v1/approval-policies/${policy.id}/deactivate`);
    expect(res.status).toBe(403);
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
    // A second team lead exists while it is raised: with the requester the
    // only holder, submission itself is refused (NO_ELIGIBLE_APPROVER,
    // review A, item 1) -- this is about the decision-time refusal.
    const otherTl = await createUser(w.pool, w.orgId,
      { username: `cat_other_tl_${uniq()}`, roles: ["TEAM_LEAD"] });
    const res = await submit(20_000, "PURCHASE_ORDER", w.role.TEAM_LEAD);
    await w.pool.query("UPDATE users SET auth_status = 'SUSPENDED' WHERE id = $1", [otherTl]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
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

  it("says whose version If-Match wants when it's missing or wrong — B-015", async () => {
    // A caller deciding a document's approval naturally reaches for the
    // document's own version (the one it already has in hand), but this
    // route wants the approval instance's version instead. Task 2's seed
    // script got this wrong on first try; the message should say so rather
    // than a bare "If-Match must contain the current version".
    const res = await submit(20_000);
    const missing = await post(w.role.TEAM_LEAD,
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("VERSION_REQUIRED");
    expect(missing.body.message).toContain("approval request");

    const wrong = await post({ ...w.role.TEAM_LEAD, "if-match": "999" },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("VERSION_CONFLICT");
    expect(wrong.body.message).toContain("approval request");
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

  it("lets a delegate act on a role-based step, not only one naming them by user id (owner decision 2026-09-24)", async () => {
    // ladderPolicy()'s level 2 is "any PROJECT_MANAGER", not a named user.
    // HR_MANAGER holds no such role directly -- only through the PM's own
    // delegation, the same cover a PM on leave would set up for level 1's
    // named case above. A different physical person from whoever clears
    // level 1 (fix round 1, I3's segregation of duties otherwise refuses
    // the same person a second level of the same instance), and a role not
    // otherwise paired with PROJECT_MANAGER or ADMIN elsewhere in this file
    // (the delegation created here is never revoked, so it outlives the
    // test -- pairing it with either would collide with the cycle checks
    // further down).
    const today = workDate();
    const delegation = await post(w.role.PROJECT_MANAGER, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.HR_MANAGER, valid_from: today, valid_to: today, reason: "Covering for the PM",
    });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);

    const res = await submit(100_000); // level 1: TEAM_LEAD, level 2: PROJECT_MANAGER
    const level1 = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(level1.status, JSON.stringify(level1.body)).toBe(200);

    const level2 = await post({ ...w.role.HR_MANAGER, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(level2.status, JSON.stringify(level2.body)).toBe(200);
    expect(level2.data.status).toBe("APPROVED");

    const steps = await w.pool.query(
      "SELECT sequence, acted_by, acted_on_behalf_of FROM approval_steps WHERE instance_id=$1 ORDER BY sequence",
      [res.data.id]);
    expect(steps.rows[1].acted_by).toBe(w.roleUserId.HR_MANAGER);
    // The audit shows whose role-based authority HR_MANAGER acted under.
    expect(steps.rows[1].acted_on_behalf_of).toBe(w.roleUserId.PROJECT_MANAGER);
  });

  it("still blocks a delegate from approving their own document even on a role-based step", async () => {
    const today = workDate();
    const delegation = await post(w.role.PROJECT_MANAGER, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.TEAM_LEAD, valid_from: today, valid_to: today, reason: "Covering for the PM",
    });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);

    // A single-level, PROJECT_MANAGER-only policy: TEAM_LEAD is eligible
    // here only through the delegation above, never by their own role.
    const policy = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "ADVANCE", name: `Role-only self-approval check ${uniq()}`,
      levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_role: "PROJECT_MANAGER" }],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);

    const res = await submit(5_000, "ADVANCE", w.role.TEAM_LEAD); // TEAM_LEAD raises their own advance
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const decision = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decision.status).toBe(403);
    expect(decision.body.code).toBe("SELF_APPROVAL");
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

describe("segregation of duties (fix round 1, I3)", () => {
  it("a PM at L1 who is also an ADMIN delegate can't approve L2", async () => {
    const policy = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "ADVANCE", name: `PM then ADMIN ${uniq()}`,
      levels: [
        { sequence: 1, min_amount: 0, max_amount: 500_000, approver_role: "PROJECT_MANAGER" },
        { sequence: 2, min_amount: 500_000, max_amount: null, approver_role: "ADMIN" },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);

    const today = workDate();
    const delegation = await post(w.role.ADMIN, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.PROJECT_MANAGER, valid_from: today, valid_to: today, reason: "Covering for admin",
    });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);

    const res = await submit(600_000, "ADVANCE", w.role.EMPLOYEE);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const level1 = await post({ ...w.role.PROJECT_MANAGER, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(level1.status, JSON.stringify(level1.body)).toBe(200);

    // Same physical person, now reaching for L2 only through the ADMIN
    // delegation -- must still be refused.
    const level2 = await post({ ...w.role.PROJECT_MANAGER, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(level2.status, JSON.stringify(level2.body)).toBe(422);
    expect(level2.body.code).toBe("SEGREGATION_OF_DUTIES");
    expect(level2.body.message).toContain("administrator");
    expect(level2.body.message).toContain("PM then ADMIN");
  });

  it("keeps a segregation-blocked item out of the inbox of whoever it would refuse (fix round 2, item 2(c))", async () => {
    const policy = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "ADVANCE", name: `PM then ADMIN ${uniq()}`,
      levels: [
        { sequence: 1, min_amount: 0, max_amount: 500_000, approver_role: "PROJECT_MANAGER" },
        { sequence: 2, min_amount: 500_000, max_amount: null, approver_role: "ADMIN" },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);

    const today = workDate();
    const delegation = await post(w.role.ADMIN, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.PROJECT_MANAGER, valid_from: today, valid_to: today, reason: "Covering for admin",
    });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);

    const res = await submit(600_000, "ADVANCE", w.role.EMPLOYEE);
    const level1 = await post({ ...w.role.PROJECT_MANAGER, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(level1.status, JSON.stringify(level1.body)).toBe(200);

    // PM cleared level 1; level 2 is now pending and PM's ADMIN delegation
    // would otherwise make it look actionable to them -- but canAct() would
    // refuse it (SEGREGATION_OF_DUTIES), so it must not be in their inbox.
    const pmInbox = await get(w.role.PROJECT_MANAGER, "/api/v1/approvals/inbox");
    expect(pmInbox.status, JSON.stringify(pmInbox.body)).toBe(200);
    expect(pmInbox.data.some((r: any) => r.id === res.data.id)).toBe(false);

    // The real ADMIN still sees it.
    const adminInbox = await get(w.role.ADMIN, "/api/v1/approvals/inbox");
    expect(adminInbox.data.some((r: any) => r.id === res.data.id)).toBe(true);
  });

  it("still lets the real ADMIN, or another of its delegates, decide L2", async () => {
    const policy = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "ADVANCE", name: `PM then ADMIN ${uniq()}`,
      levels: [
        { sequence: 1, min_amount: 0, max_amount: 500_000, approver_role: "PROJECT_MANAGER" },
        { sequence: 2, min_amount: 500_000, max_amount: null, approver_role: "ADMIN" },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);

    const res = await submit(600_000, "ADVANCE", w.role.EMPLOYEE);
    const level1 = await post({ ...w.role.PROJECT_MANAGER, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(level1.status, JSON.stringify(level1.body)).toBe(200);

    const level2 = await post({ ...w.role.ADMIN, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(level2.status, JSON.stringify(level2.body)).toBe(200);

    const steps = await w.pool.query(
      "SELECT sequence, acted_by, acted_on_behalf_of FROM approval_steps WHERE instance_id=$1 ORDER BY sequence",
      [res.data.id]);
    expect(steps.rows[0].acted_by).toBe(w.roleUserId.PROJECT_MANAGER);
    expect(steps.rows[1].acted_by).toBe(w.roleUserId.ADMIN);
    expect(steps.rows[1].acted_on_behalf_of).toBeNull();
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

describe("inbox project scope (owner decision 2026-09-24)", () => {
  beforeAll(async () => { await ladderPolicy(); }); // level 1: TEAM_LEAD, level 2: PROJECT_MANAGER

  async function loginAs(username: string, password: string): Promise<Headers> {
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/auth/login", payload: { username, password },
    });
    const body = res.json() as { access_token?: string };
    return { authorization: `Bearer ${body.access_token}` };
  }

  /** A fresh PROJECT_MANAGER whose own scope is one project, not the organisation. */
  async function scopedProjectManager(projectId: string): Promise<Headers & { userId: string }> {
    const username = `cat_scoped_pm_${uniq()}`;
    const userId = await createUser(w.pool, w.orgId, { username, roles: ["PROJECT_MANAGER"] });
    await w.pool.query(
      "UPDATE user_roles SET scope_type = 'project', scope_id = $1 WHERE user_id = $2",
      [projectId, userId]);
    const headers = await loginAs(username, PASSWORD);
    return { ...headers, userId };
  }

  /** Clears level 1 (TEAM_LEAD, global scope) so the instance waits at level 2 (PROJECT_MANAGER). */
  async function toLevel2(instanceId: string) {
    const cleared = await post({ ...w.role.TEAM_LEAD, ...(await instanceVersion(instanceId)) },
      `/api/v1/approvals/${instanceId}/decision`, { decision: "APPROVE" });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  }

  it("shows a project-scoped approver their own project's items and org-wide ones, not another project's", async () => {
    const mine = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.activeProject,
    });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    await toLevel2(mine.data.id);

    const someoneElses = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.inactiveProject,
    });
    expect(someoneElses.status, JSON.stringify(someoneElses.body)).toBe(201);
    await toLevel2(someoneElses.data.id);

    const orgWide = await submit(100_000); // no project_id at all
    await toLevel2(orgWide.data.id);

    const scoped = await scopedProjectManager(w.activeProject);
    const inbox = await get(scoped, "/api/v1/approvals/inbox");
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const ids = inbox.data.map((r: any) => r.id);
    expect(ids).toContain(mine.data.id);
    expect(ids).toContain(orgWide.data.id);
    expect(ids).not.toContain(someoneElses.data.id);
  });

  it("refuses to decide an out-of-scope document by id, matching the inbox (owner decision 2026-09-24, fix round 1, I1)", async () => {
    const mine = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.activeProject,
    });
    await toLevel2(mine.data.id);
    const someoneElses = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.inactiveProject,
    });
    await toLevel2(someoneElses.data.id);

    const scoped = await scopedProjectManager(w.activeProject);
    const blocked = await post({ ...scoped, ...(await instanceVersion(someoneElses.data.id)) },
      `/api/v1/approvals/${someoneElses.data.id}/decision`, { decision: "APPROVE" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(403);
    expect(blocked.body.code).toBe("FORBIDDEN");

    // Still free to decide their own project's item.
    const allowed = await post({ ...scoped, ...(await instanceVersion(mine.data.id)) },
      `/api/v1/approvals/${mine.data.id}/decision`, { decision: "APPROVE" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it("still shows a globally-scoped approver items from every project", async () => {
    const a = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.activeProject,
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    await toLevel2(a.data.id);
    const b = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.inactiveProject,
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    await toLevel2(b.data.id);

    // The seeded per-role fixture users hold a null (global) scope.
    const inbox = await get(w.role.PROJECT_MANAGER, "/api/v1/approvals/inbox");
    const ids = inbox.data.map((r: any) => r.id);
    expect(ids).toContain(a.data.id);
    expect(ids).toContain(b.data.id);
  });

  it("a role-based delegate carries the principal's project scope, not their own (fix round 1, I2)", async () => {
    // ADMIN (globally scoped) holds no PROJECT_MANAGER role of its own, so
    // its only route onto a PROJECT_MANAGER-role step is standing in for
    // the scoped principal below -- and only for a project that principal
    // actually manages.
    const principal = await scopedProjectManager(w.activeProject);
    const today = workDate();
    const delegation = await post(principal, "/api/v1/approval-delegations", {
      to_user_id: w.roleUserId.ADMIN, valid_from: today, valid_to: today, reason: "Covering for the scoped PM",
    });
    expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);

    const inScope = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.activeProject,
    });
    await toLevel2(inScope.data.id);
    const outOfScope = await post(w.role.EMPLOYEE, "/api/v1/approvals", {
      document_type: "PURCHASE_ORDER", document_id: randomUUID(), amount: 100_000, project_id: w.inactiveProject,
    });
    await toLevel2(outOfScope.data.id);

    const allowed = await post({ ...w.role.ADMIN, ...(await instanceVersion(inScope.data.id)) },
      `/api/v1/approvals/${inScope.data.id}/decision`, { decision: "APPROVE" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    // ADMIN itself is globally scoped (fix round 1, I1's own check would let
    // it through); only I2's principal-scope check inside canAct refuses
    // this one, because the *principal* -- not the delegate -- cannot reach
    // w.inactiveProject.
    const blocked = await post({ ...w.role.ADMIN, ...(await instanceVersion(outOfScope.data.id)) },
      `/api/v1/approvals/${outOfScope.data.id}/decision`, { decision: "APPROVE" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);
    expect(blocked.body.code).toBe("NOT_THE_APPROVER");
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

describe("an ADMIN step and nobody left to clear it (review A, item 1)", () => {
  it("lets the bootstrap SUPER_ADMIN clear an ADMIN step, and offers it in their inbox", async () => {
    const roles = await w.pool.query(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [w.adminId]);
    expect(roles.rows.map(r => r.code)).toContain("SUPER_ADMIN");
    const policy = await post(w.admin, "/api/v1/approval-policies", {
      document_type: "RETENTION_RELEASE", name: `Admin only ${uniq()}`,
      levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_role: "ADMIN" }],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);
    const res = await submit(10_000, "RETENTION_RELEASE", w.role.EMPLOYEE);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const inbox = await get(w.admin, "/api/v1/approvals/inbox");
    expect(inbox.status).toBe(200);
    expect((inbox.data as Array<{ id: string }>).map(r => r.id)).toContain(res.data.id);

    const decided = await post({ ...w.admin, ...(await instanceVersion(res.data.id)) },
      `/api/v1/approvals/${res.data.id}/decision`, { decision: "APPROVE" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.data.status).toBe("APPROVED");
  });

  it("refuses the sole administrator's own submission with a clear 422, not an orphaned request", async () => {
    // The second tenant's only account is its SUPER_ADMIN: raising a request
    // on an ADMIN ladder leaves nobody but the requester able to approve it.
    const name = `Other org admin ladder ${uniq()}`;
    const policy = await post(w.other.admin, "/api/v1/approval-policies", {
      document_type: "RETENTION_RELEASE", name,
      levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_role: "ADMIN" }],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);
    const documentId = randomUUID();
    const res = await post(w.other.admin, "/api/v1/approvals", {
      document_type: "RETENTION_RELEASE", document_id: documentId, amount: 10_000,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("NO_ELIGIBLE_APPROVER");
    expect(res.body.message).toContain(name);
    expect(res.body.message).toMatch(/administrator/);
    const left = await w.pool.query(
      "SELECT 1 FROM approval_instances WHERE document_id = $1", [documentId]);
    expect(left.rowCount).toBe(0);
  });
});

describe("empty body never 500s — B-020", () => {
  it("answers an empty JSON body on POST /approvals with 4xx, never a 500", async () => {
    // createApp.ts's content-type parser (B-016) maps an empty body sent
    // with Content-Type: application/json to a value the route can read
    // without throwing. Line 200-201 reads body.document_type/document_id/
    // amount straight off req.body, which used to be `undefined` here and
    // 500 instead of the intended "required" validation error.
    const res = await post(
      { ...w.role.EMPLOYEE, "content-type": "application/json" }, "/api/v1/approvals");
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

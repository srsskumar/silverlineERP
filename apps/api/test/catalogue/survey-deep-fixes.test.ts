/**
 * Bugs found in the survey deep-QA round (lane 1), each pinned by the probe
 * that found it live (scripts/qa/survey/probe-api.mjs):
 *   SV-004 release dates that are not dates were a 500
 *   SV-005 start-gt put an exited employee on a village
 *   SV-006 start-gt did not bring the crew's issued kit, unlike every other crew route
 *   SV-007 completing a stage without resending started_on erased the start date
 *   SV-008 a stage could be completed before it started, or in the future
 *   SV-009 a village's extent could not be cleared although the schema allows null
 *   SV-010 a plan could finish before it starts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeId: string;
let mandalId: string;

const day = (offset: number) => {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function send(method: "POST" | "GET" | "PATCH" | "DELETE", headers: Headers, url: string, payload?: unknown, extra: Headers = {}) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()), ...extra },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);

async function village(name = "Deep village"): Promise<string> {
  const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_name: name, village_code: uniq("DV"), mandal_id: mandalId, total_extent_ac: 100 });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return String(v.data.id);
}
async function employee(status = "ACTIVE"): Promise<string> {
  return String((await w.pool.query(
    `INSERT INTO employees (org_id, emp_no, first_name, last_name, phone, date_of_joining, status)
     VALUES ($1, $2, 'Deep', 'Crew', $3, CURRENT_DATE, $4) RETURNING id`,
    [w.orgId, uniq("DC"), `9${Math.floor(100000000 + Math.random() * 899999999)}`, status])).rows[0].id);
}
const startGt = (v: string, ids: string[], started = day(-5)) =>
  post(w.admin, `/api/v1/survey/villages/${v}/start-gt`, {
    started_on: started, expected_end_on: day(20), employee_ids: ids,
    govt_staff_allocated: 1, crew_allocated: ids.length,
  });

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Deep district') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'Deep mandal',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("DEEP"), name: "Deep programme", create_project: false });
  programmeId = String(p.data.id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("SV-004 release dates", () => {
  it("refuses a crew release date that is not a date, with 422 rather than 500", async () => {
    const v = await village();
    const e = await employee();
    const c = await post(w.admin, `/api/v1/survey/villages/${v}/crew`,
      { employee_id: e, stage_code: "GROUND_TRUTHING", assigned_on: day(-3) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    for (const bad of ["not-a-date", "31/12/2026", "2026-02-30"]) {
      const r = await post(w.admin, `/api/v1/survey/crew/${c.data.id}/release`, { released_on: bad });
      expect(r.status, `${bad}: ${JSON.stringify(r.body)}`).toBe(422);
    }
  });

  it("refuses a rover release date that is not a date, with 422 rather than 500", async () => {
    const v = await village();
    const asset = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,'Deep rover','SURVEY','AVAILABLE','GOOD') RETURNING id`,
      [w.orgId, uniq("DR")])).rows[0].id);
    const a = await post(w.admin, `/api/v1/survey/villages/${v}/rovers`, { asset_id: asset, allocated_on: day(-3) });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    for (const bad of ["not-a-date", "31/12/2026"]) {
      const r = await post(w.admin, `/api/v1/survey/rovers/${a.data.id}/release`, { released_on: bad });
      expect(r.status, `${bad}: ${JSON.stringify(r.body)}`).toBe(422);
    }
  });
});

describe("SV-005 / SV-006 starting ground truthing", () => {
  it("refuses to put an exited employee on the village, and writes nothing", async () => {
    const v = await village();
    const ok = await employee();
    const gone = await employee("EXITED");
    const r = await startGt(v, [ok, gone]);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const crew = await send("GET", w.admin, `/api/v1/survey/villages/${v}/crew`);
    expect(crew.data).toEqual([]);
  });

  it("brings the crew's issued instruments to the village, as the crew routes do", async () => {
    const v = await village();
    const e = await employee();
    const asset = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,'Issued rover','SURVEY','ASSIGNED','GOOD') RETURNING id`,
      [w.orgId, uniq("IR")])).rows[0].id);
    await w.pool.query(
      `INSERT INTO asset_assignments(org_id, asset_id, employee_id, condition, reason)
       VALUES($1,$2,$3,'GOOD','field kit')`, [w.orgId, asset, e]);
    const r = await startGt(v, [e]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rovers = await send("GET", w.admin, `/api/v1/survey/villages/${v}/rovers`);
    expect((rovers.data as any[]).some((x) => x.asset_id === asset && x.out), JSON.stringify(rovers.data)).toBe(true);
  });
});

describe("SV-007 / SV-008 stage dates", () => {
  let v: string;
  beforeAll(async () => {
    v = await village();
    expect((await startGt(v, [await employee()])).status).toBe(201);
  });
  const set = (body: Record<string, unknown>) =>
    post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: "GROUND_TRUTHING", ...body });

  it("keeps the recorded start when a completion does not resend it", async () => {
    const r = await set({ state: "COMPLETED", completed_on: day(-1) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.started_on).toBe(day(-5));
    expect((await set({ state: "IN_PROGRESS" })).data.started_on).toBe(day(-5));
  });

  it("still clears the start when asked to explicitly", async () => {
    const r = await set({ state: "IN_PROGRESS", started_on: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.started_on).toBeNull();
    expect((await set({ state: "IN_PROGRESS", started_on: day(-5) })).status).toBe(200);
  });

  it("refuses a completion dated before the recorded start", async () => {
    const r = await set({ state: "COMPLETED", completed_on: day(-9) });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("refuses a start or a completion dated in the future", async () => {
    const a = await set({ state: "COMPLETED", completed_on: day(3) });
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    const b = await set({ state: "IN_PROGRESS", started_on: day(3) });
    expect(b.status, JSON.stringify(b.body)).toBe(422);
  });
});

describe("SV-009 / SV-010 village edits", () => {
  it("clears the extent when asked to", async () => {
    const v = await village();
    const before = await send("GET", w.admin, `/api/v1/survey/villages/${v}`);
    const r = await send("PATCH", w.admin, `/api/v1/survey/villages/${v}`, { total_extent_ac: null },
      { "if-match": String(before.data.version) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await send("GET", w.admin, `/api/v1/survey/villages/${v}`);
    expect(after.data.total_extent_ac).toBeNull();
  });

  it("refuses a plan that finishes before it starts", async () => {
    const v = await village();
    const before = await send("GET", w.admin, `/api/v1/survey/villages/${v}`);
    const r = await send("PATCH", w.admin, `/api/v1/survey/villages/${v}/plan`,
      { planned_start_on: day(10), expected_completion_on: day(1) },
      { "if-match": String(before.data.version) });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });
});

/*
 * SV-011 a claim's status could move anywhere, a paid claim included
 * SV-012 a decision could be dated before the claim was submitted
 * SV-013 a claim could be deleted when paid, or from under later milestones
 */
describe("SV-011 / SV-012 / SV-013 billing claims", () => {
  let v: string;
  const claims = async () => (await send("GET", w.admin, `/api/v1/survey/villages/${v}/billing`)).data as any[];
  const claim = async (m: number) => (await claims()).find((c) => c.milestone === m);
  const patch = async (m: number, body: Record<string, unknown>) => {
    const c = await claim(m);
    return send("PATCH", w.admin, `/api/v1/survey/billing/${c.id}`, body, { "if-match": String(c.version) });
  };

  beforeAll(async () => {
    v = await village("Billing village");
    expect((await startGt(v, [await employee()], day(-8))).status).toBe(201);
    let n = -7;
    for (const code of ["GROUND_TRUTHING", "GT_QC", "VECTORIZATION", "DATA_SUBMISSION"]) {
      const a = await post(w.admin, `/api/v1/survey/villages/${v}/stage`,
        { stage_code: code, state: "IN_PROGRESS", started_on: day(n) });
      const b = await post(w.admin, `/api/v1/survey/villages/${v}/stage`,
        { stage_code: code, state: "COMPLETED", started_on: day(n), completed_on: day(n + 1) });
      expect([a.status, b.status], JSON.stringify(b.body)).toEqual([200, 200]);
      n += 1;
    }
    expect((await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 1, submitted_on: day(-2) })).status).toBe(201);
    expect((await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 2, submitted_on: day(-2) })).status).toBe(201);
  });

  it("refuses a decision dated before the claim was submitted", async () => {
    const r = await patch(2, { status: "APPROVED", decided_on: day(-5) });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("refuses to delete a claim with a later milestone standing on it", async () => {
    const c = await claim(1);
    const r = await send("DELETE", w.admin, `/api/v1/survey/billing/${c.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  });

  it("walks SUBMITTED -> APPROVED -> PAID, and a paid claim then stays paid", async () => {
    expect((await patch(1, { status: "APPROVED", decided_on: day(-1) })).status).toBe(200);
    expect((await patch(1, { status: "PAID", decided_on: day(0) })).status).toBe(200);
    for (const status of ["SUBMITTED", "REJECTED", "APPROVED"]) {
      const r = await patch(1, { status, decided_on: status === "SUBMITTED" ? null : day(0) });
      expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(409);
      expect(r.body.code).toBe("CLAIM_TRANSITION_REFUSED");
    }
    const pct = await patch(1, { percent: 10 });
    expect(pct.status, JSON.stringify(pct.body)).toBe(409);
    // The paper trail can still be corrected.
    expect((await patch(1, { reference_no: "LTR-42" })).status).toBe(200);
  });

  it("lets a returned claim be resubmitted, which is how rework is billed again", async () => {
    expect((await patch(2, { status: "REJECTED", decided_on: day(0) })).status).toBe(200);
    const r = await patch(2, { status: "SUBMITTED", decided_on: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("refuses to delete a paid claim", async () => {
    // Milestone 2 is removed first so the only reason left is that 1 is paid.
    const two = await claim(2);
    expect((await send("DELETE", w.admin, `/api/v1/survey/billing/${two.id}`)).status).toBe(200);
    const one = await claim(1);
    const r = await send("DELETE", w.admin, `/api/v1/survey/billing/${one.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  });

  it("applies the same transitions to a bulk decision", async () => {
    const r = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "DECIDE", milestone: 1, status: "REJECTED",
      decided_on: day(0), dry_run: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.would_change ?? r.data.changed ?? 0).toBe(0);
    expect(JSON.stringify(r.data.skipped)).toContain("CLAIM_CLOSED");
  });
});

/*
 * Fix round 1, item 1: a paid claim is closed to ordinary edits (SV-011), so
 * a mistaken "paid" needs a way back. An administrator reverses it, with a
 * reason, under If-Match; the claim returns to APPROVED (it was accepted, the
 * payment is what is being withdrawn) and is editable again from there.
 */
describe("SV-019 reversing a paid claim", () => {
  let v: string;
  const claims = async () => (await send("GET", w.admin, `/api/v1/survey/villages/${v}/billing`));
  const claim = async (m: number) => ((await claims()).data as any[]).find((c) => c.milestone === m);
  const reverse = async (h: Headers, m: number, body: Record<string, unknown>, version?: number) => {
    const c = await claim(m);
    return send("POST", h, `/api/v1/survey/billing/${c.id}/reverse`, body,
      { "if-match": String(version ?? c.version) });
  };

  beforeAll(async () => {
    v = await village("Reversal village");
    expect((await startGt(v, [await employee()], day(-8))).status).toBe(201);
    let n = -7;
    for (const code of ["GROUND_TRUTHING", "GT_QC"]) {
      await post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: code, state: "IN_PROGRESS", started_on: day(n) });
      const b = await post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: code, state: "COMPLETED", started_on: day(n), completed_on: day(n + 1) });
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      n += 1;
    }
    expect((await post(w.admin, `/api/v1/survey/villages/${v}/billing`,
      { milestone: 1, percent: 49.99, submitted_on: day(-2), status: "PAID", decided_on: day(-1) })).status).toBe(201);
  });

  it("points the refusal at the reversal rather than at an impossible new claim", async () => {
    const c = await claim(1);
    const r = await send("PATCH", w.admin, `/api/v1/survey/billing/${c.id}`, { percent: 10 },
      { "if-match": String(c.version) });
    expect(r.status).toBe(409);
    expect(r.body.message).not.toMatch(/new claim/i);
    expect(r.body.message).toMatch(/revers/i);
  });

  it("is refused to a project manager", async () => {
    const r = await reverse(w.role.PROJECT_MANAGER, 1, { reason: "Marked paid by mistake" });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
  });

  it("needs a reason", async () => {
    for (const body of [{}, { reason: "" }, { reason: "  " }]) {
      const r = await reverse(w.admin, 1, body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
    }
  });

  it("needs the current version", async () => {
    const c = await claim(1);
    const r = await reverse(w.admin, 1, { reason: "Marked paid by mistake" }, c.version + 5);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  });

  it("returns the claim to approved, audited with before, after and the reason", async () => {
    const r = await reverse(w.admin, 1, { reason: "Marked paid by mistake in the batch" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.status).toBe("APPROVED");
    const audit = (await w.pool.query(
      `SELECT before_state, after_state, reason FROM audit_events
        WHERE action = 'survey.village.billing.reverse' AND entity_id = $1`, [r.data.id])).rows;
    expect(audit.length).toBe(1);
    expect(audit[0].before_state.status).toBe("PAID");
    expect(audit[0].after_state.status).toBe("APPROVED");
    expect(audit[0].reason).toBe("Marked paid by mistake in the batch");
    // Nothing about the money moved.
    const b = await claims();
    expect((b.data as any[])[0].percent).toBe(49.99);
    expect(b.body.meta.claimed_percent).toBe(49.99);
  });

  it("lets the milestone be corrected and paid again, to the paisa", async () => {
    const c = await claim(1);
    const fix = await send("PATCH", w.admin, `/api/v1/survey/billing/${c.id}`,
      { percent: 50, extent_ac: 123.4567 }, { "if-match": String(c.version) });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    const c2 = await claim(1);
    const paid = await send("PATCH", w.admin, `/api/v1/survey/billing/${c2.id}`,
      { status: "PAID", decided_on: day(0) }, { "if-match": String(c2.version) });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const b = await claims();
    expect(b.body.meta.claimed_percent).toBe(50);
    expect((b.data as any[])[0].extent_ac).toBe(123.4567);
  });

  it("reverses in bulk too, admin only, reason required, with a dry run first", async () => {
    const base = { survey_village_ids: [v], action: "REVERSE", milestone: 1 };
    expect((await post(w.admin, "/api/v1/survey/billing/bulk", { ...base, dry_run: true })).status).toBe(422);
    const pm = await post(w.role.PROJECT_MANAGER, "/api/v1/survey/billing/bulk",
      { ...base, reason: "Batch marked paid by mistake", dry_run: false });
    expect(pm.status, JSON.stringify(pm.body)).toBe(403);
    const dry = await post(w.admin, "/api/v1/survey/billing/bulk",
      { ...base, reason: "Batch marked paid by mistake", dry_run: true });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.data.would_change).toBe(1);
    const real = await post(w.admin, "/api/v1/survey/billing/bulk",
      { ...base, reason: "Batch marked paid by mistake", dry_run: false });
    expect(real.status, JSON.stringify(real.body)).toBe(200);
    expect(real.data.updated).toBe(1);
    expect((await claim(1)).status).toBe("APPROVED");
    const again = await post(w.admin, "/api/v1/survey/billing/bulk",
      { ...base, reason: "Batch marked paid by mistake", dry_run: true });
    expect(JSON.stringify(again.data.skipped)).toContain("NOT_PAID");
    const audit = (await w.pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'survey.village.billing.reverse'
         AND entity_id = $1`, [(await claim(1)).id])).rows[0].n;
    expect(audit).toBe(2);
  });
});

/*
 * Round 2, SV-022: a bulk decision dated before a claim was submitted is
 * refused for that village (named, skipped) without failing the batch.
 * Round 2, item 3: a bulk reversal reports the rows it actually reversed.
 */
describe("SV-022 bulk decisions and reversals, row by row", () => {
  let early: string;
  let late: string;
  const ready = async (name: string, submitted: string) => {
    const v = await village(name);
    expect((await startGt(v, [await employee()], day(-12))).status).toBe(201);
    let n = -11;
    for (const code of ["GROUND_TRUTHING", "GT_QC"]) {
      await post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: code, state: "IN_PROGRESS", started_on: day(n) });
      const b = await post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: code, state: "COMPLETED", started_on: day(n), completed_on: day(n + 1) });
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      n += 1;
    }
    expect((await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 1, submitted_on: submitted })).status).toBe(201);
    return v;
  };
  const statusOf = async (v: string) =>
    ((await send("GET", w.admin, `/api/v1/survey/villages/${v}/billing`)).data as any[])[0].status;

  beforeAll(async () => {
    early = await ready("Submitted early", day(-8));
    late = await ready("Submitted late", day(-2));
  });

  it("skips the village whose claim went in after the decision date, and decides the rest", async () => {
    const body = {
      survey_village_ids: [early, late], action: "DECIDE", milestone: 1,
      status: "APPROVED", decided_on: day(-5),
    };
    const dry = await post(w.admin, "/api/v1/survey/billing/bulk", { ...body, dry_run: true });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.data.would_change).toBe(1);
    expect(dry.data.skipped).toEqual([{ village_name: "Submitted late", reason: "DECIDED_BEFORE_SUBMITTED" }]);

    const real = await post(w.admin, "/api/v1/survey/billing/bulk", { ...body, dry_run: false });
    expect(real.status, JSON.stringify(real.body)).toBe(200);
    expect(real.data.updated).toBe(1);
    expect(await statusOf(early)).toBe("APPROVED");
    expect(await statusOf(late)).toBe("SUBMITTED");
  });

  it("reports a bulk reversal's count from the rows actually reversed", async () => {
    const pay = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [early], action: "DECIDE", milestone: 1,
      status: "PAID", decided_on: day(0), dry_run: false,
    });
    expect(pay.data.updated).toBe(1);
    const rev = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [early, late], action: "REVERSE", milestone: 1,
      reason: "Paid in error", dry_run: false,
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.data.updated).toBe(1);
    expect(JSON.stringify(rev.data.skipped)).toContain("NOT_PAID");
    expect(await statusOf(early)).toBe("APPROVED");
  });
});

/*
 * SV-023: SV-011's transition table left out approved -> submitted, which is
 * what the web's "Undo decision" sends when somebody pressed Approved on the
 * wrong row. Undoing a decision is not undoing a payment; only PAID is closed.
 */
describe("SV-023 undoing an approval", () => {
  it("puts an approved claim back to submitted", async () => {
    const v = await village("Undo village");
    expect((await startGt(v, [await employee()], day(-6))).status).toBe(201);
    let n = -5;
    for (const code of ["GROUND_TRUTHING", "GT_QC"]) {
      await post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: code, state: "IN_PROGRESS", started_on: day(n) });
      await post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: code, state: "COMPLETED", started_on: day(n), completed_on: day(n + 1) });
      n += 1;
    }
    const c = await post(w.admin, `/api/v1/survey/villages/${v}/billing`,
      { milestone: 1, submitted_on: day(-2), status: "APPROVED", decided_on: day(-1) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const r = await send("PATCH", w.admin, `/api/v1/survey/billing/${c.data.id}`,
      { status: "SUBMITTED", decided_on: null }, { "if-match": String(c.data.version) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.status).toBe("SUBMITTED");
  });
});

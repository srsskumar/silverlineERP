/**
 * Where the wage bill actually went (§note 10).
 *
 * The cost ledger only ever heard from expense claims and manual adjustments,
 * so in a survey business — where the dominant cost is crew days in the field
 * — every project's margin was revenue against almost nothing.
 *
 * End to end here means the real chain: a crew checks out of a village, the
 * village belongs to a programme, the programme to a project; payroll runs
 * for the month and locks; the wage bill lands on the projects it was earned
 * on, and the project's cost position moves.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, uniquePhone, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let mandalId: string;

async function send(
  method: "POST" | "GET", headers: Headers, url: string, payload?: unknown,
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

/**
 * A month of its own per test.
 *
 * Only one payroll run may exist for a period, org-wide, so tests sharing a
 * month collide on OVERLAPPING_RUN. Every month here is wholly in the past,
 * so no return or run is ever dated in the future.
 */
let monthCursor = 0;
interface Period { start: string; end: string; day: (n: number) => string }
function nextPeriod(): Period {
  const month = monthCursor++;
  const year = 2025 + Math.floor(month / 12);
  const m = month % 12;
  const start = new Date(Date.UTC(year, m, 1));
  const end = new Date(Date.UTC(year, m + 1, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    day: (n: number) => new Date(Date.UTC(year, m, n)).toISOString().slice(0, 10),
  };
}

async function programmeWithProject() {
  const created = await post(w.admin, "/api/v1/survey/projects", {
    code: uniq("COST"), name: "Costed programme", create_project: true,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { programmeId: String(created.data.id), projectId: String(created.data.project_id) };
}

async function village(programmeId: string) {
  const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
    village_name: `Cost ${uniq("V")}`, village_code: uniq("CV"),
    mandal_id: mandalId, total_extent_ac: 200,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return String(v.data.id);
}

/**
 * An employee on a salary, so payroll has something to calculate.
 *
 * Joined well before any period below: payroll leaves out somebody who was
 * not employed yet, and a test whose employee joins after its own month
 * produces an empty run and a confusing failure.
 */
async function crewMember(salary: number) {
  return String((await w.pool.query(
    `INSERT INTO employees(org_id, emp_no, first_name, last_name, phone,
       date_of_joining, status, salary_basic)
     VALUES($1,$2,'Crew','Member',$3,'2024-01-01','ACTIVE',$4) RETURNING id`,
    [w.orgId, uniq("E"), uniquePhone(), salary])).rows[0].id);
}

/**
 * Days present, and the village each day was worked on.
 *
 * Written the way the mobile app writes them — a check-out event carrying the
 * village, and a daily record pointing at it — because the whole attribution
 * hangs off that link and a shortcut here would test nothing.
 */
async function workedDays(
  period: Period, employeeId: string, villageId: string | null,
  fromDay: number, count: number,
) {
  for (let i = 0; i < count; i += 1) {
    const date = period.day(fromDay + i);
    let eventId: string | null = null;
    if (villageId) {
      eventId = String((await w.pool.query(
        `INSERT INTO attendance_events(employee_id, event_type, client_timestamp,
           server_timestamp, survey_village_id, idempotency_key)
         VALUES($1,'CHECK_OUT',$2::timestamptz,$2::timestamptz,$3,$4) RETURNING id`,
        [employeeId, `${date}T12:00:00Z`, villageId, uniq("IDEM")])).rows[0].id);
    }
    await w.pool.query(
      `INSERT INTO attendance_records(employee_id, work_date, status, check_in_at,
         check_out_event_id)
       VALUES($1,$2::date,'COMPLETE',$3::timestamptz,$4)
       ON CONFLICT DO NOTHING`,
      [employeeId, date, `${date}T09:00:00Z`, eventId]);
  }
}

/** A payroll run taken all the way to LOCKED, the way an operator would. */
async function lockedRun(period: Period) {
  const created = await post(w.admin, "/api/v1/payroll/runs", {
    period_start: period.start, period_end: period.end,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const runId = String(created.body.id ?? created.data.id);
  for (const step of ["calculate", "submit-review", "approve", "lock"]) {
    const r = await post(w.admin, `/api/v1/payroll/runs/${runId}/${step}`, {});
    expect(r.status, `${step}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  return runId;
}

const preview = (runId: string, h: Headers = w.admin) =>
  get(h, `/api/v1/payroll-runs/${runId}/labour-cost`);
const postCost = (runId: string, body: unknown = {}, h: Headers = w.admin) =>
  post(h, `/api/v1/payroll-runs/${runId}/labour-cost`, body);
const reverseCost = (runId: string, reason: string, h: Headers = w.admin) =>
  post(h, `/api/v1/payroll-runs/${runId}/labour-cost/reverse`, { reason });

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Cost district') RETURNING id`,
    [w.orgId, uniq("CD")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'Cost mandal',$3) RETURNING id`,
    [w.orgId, uniq("CM"), district])).rows[0].id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the whole chain, end to end", () => {
  it("carries a crew's days from the field to the project's cost position", async () => {
    const period = nextPeriod();
    const { programmeId, projectId } = await programmeWithProject();
    const v = await village(programmeId);
    const employee = await crewMember(30000);
    await workedDays(period, employee, v, 1, 20);

    const runId = await lockedRun(period);

    // What the field says it cost, before anybody commits to it.
    const p = await preview(runId);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.data.postable).toBe(true);
    const line = p.data.lines.find((l: any) => l.projectId === projectId);
    expect(line, JSON.stringify(p.data.lines)).toBeTruthy();
    expect(line.days).toBe(20);
    expect(line.employees).toBe(1);

    // Posting it.
    const posted = await postCost(runId);
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.data.posted).toBeGreaterThan(0);

    // And the project's cost position has moved, which is the point.
    const position = await get(w.admin, `/api/v1/projects/${projectId}/cost-position`);
    expect(position.status).toBe(200);
    expect(position.data.totals.actual).toBeGreaterThan(0);
    expect(position.data.totals.actual).toBeCloseTo(line.amount, 2);

    // Under a labour head, created for the purpose if the org had none.
    const head = position.data.heads.find((h: any) => h.cost_head?.kind === "LABOUR");
    expect(head, JSON.stringify(position.data.heads)).toBeTruthy();
    expect(Number(head.actual)).toBeCloseTo(line.amount, 2);
  });

  it("splits one person's month across the projects they worked on", async () => {
    const period = nextPeriod();
    const a = await programmeWithProject();
    const b = await programmeWithProject();
    const va = await village(a.programmeId);
    const vb = await village(b.programmeId);
    const employee = await crewMember(30000);
    await workedDays(period, employee, va, 1, 12);
    await workedDays(period, employee, vb, 13, 8);

    const runId = await lockedRun(period);
    const p = await preview(runId);
    const lineA = p.data.lines.find((l: any) => l.projectId === a.projectId);
    const lineB = p.data.lines.find((l: any) => l.projectId === b.projectId);
    expect(lineA.days).toBe(12);
    expect(lineB.days).toBe(8);
    // Twelve to eight, and the two together are the attributable whole.
    expect(lineA.amount).toBeGreaterThan(lineB.amount);
    expect(lineA.amount + lineB.amount + p.data.unattributed_amount)
      .toBeCloseTo(Number(p.data.payroll_run.total_gross), 2);
  });

  it("says how much of the run landed nowhere, rather than spreading it", async () => {
    const period = nextPeriod();
    // Office days, training, or a check-out that never named a village.
    // Charging a project for a day nobody worked on it is worse than
    // admitting the day is unaccounted for.
    const { programmeId, projectId } = await programmeWithProject();
    const v = await village(programmeId);
    const employee = await crewMember(30000);
    await workedDays(period, employee, v, 1, 10);
    await workedDays(period, employee, null, 11, 10);

    const runId = await lockedRun(period);
    const p = await preview(runId);
    const line = p.data.lines.find((l: any) => l.projectId === projectId);
    expect(line.days).toBe(10);
    expect(p.data.unattributed_days).toBe(10);
    expect(p.data.unattributed_amount).toBeGreaterThan(0);
  });

  it("counts a day once even when the crew moved between villages", async () => {
    const period = nextPeriod();
    // Two villages on one day is one day of wage. Otherwise moving a crew
    // costs twice what they were paid.
    const { programmeId, projectId } = await programmeWithProject();
    const v1 = await village(programmeId);
    const v2 = await village(programmeId);
    const employee = await crewMember(30000);
    await workedDays(period, employee, v1, 1, 5);
    // A second check-out the same days, at another village on the same
    // programme.
    for (let i = 0; i < 5; i += 1) {
      const date = period.day(1 + i);
      await w.pool.query(
        `INSERT INTO attendance_events(employee_id, event_type, client_timestamp,
           server_timestamp, survey_village_id, idempotency_key)
         VALUES($1,'CHECK_OUT',$2::timestamptz,$2::timestamptz,$3,$4)`,
        [employee, `${date}T17:00:00Z`, v2, uniq("IDEM")]);
    }

    const runId = await lockedRun(period);
    const p = await preview(runId);
    const line = p.data.lines.find((l: any) => l.projectId === projectId);
    expect(line.days).toBe(5);
    expect(line.amount).toBeLessThanOrEqual(Number(p.data.payroll_run.total_gross));
  });
});

describe("one run, several projects", () => {
  it("posts every project the month was worked on, not just the first", async () => {
    const period = nextPeriod();
    /*
     * The case that nearly shipped broken. uk_cost_entry_source made one live
     * entry per source document per head per nature with no project in the
     * key — fine for an expense claim, which belongs to one project, and
     * wrong for a payroll run, whose month is earned across every project the
     * crews worked on. The second project collided with the first.
     *
     * The earlier split test only previewed, so nothing exercised the insert.
     */
    const a = await programmeWithProject();
    const b = await programmeWithProject();
    const employee = await crewMember(30000);
    await workedDays(period, employee, await village(a.programmeId), 1, 12);
    await workedDays(period, employee, await village(b.programmeId), 13, 8);

    const runId = await lockedRun(period);
    const posted = await postCost(runId);
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.data.posted).toBe(2);

    for (const projectId of [a.projectId, b.projectId]) {
      const position = await get(w.admin, `/api/v1/projects/${projectId}/cost-position`);
      expect(position.data.totals.actual, projectId).toBeGreaterThan(0);
    }

    // And the two together are the attributable whole, to the paisa.
    const rows = await w.pool.query(
      `SELECT sum(amount) AS total FROM project_cost_entries
        WHERE source_type = 'PAYROLL' AND source_id = $1 AND reversal_of IS NULL`, [runId]);
    expect(Number(rows.rows[0].total)).toBeCloseTo(posted.data.total, 2);
  });

  it("reverses every project's share, not just one", async () => {
    const period = nextPeriod();
    const a = await programmeWithProject();
    const b = await programmeWithProject();
    const employee = await crewMember(24000);
    await workedDays(period, employee, await village(a.programmeId), 1, 10);
    await workedDays(period, employee, await village(b.programmeId), 11, 10);

    const runId = await lockedRun(period);
    await postCost(runId);
    const rev = await reverseCost(runId, "Attendance corrected across both");
    expect(rev.data.reversed).toBe(2);

    for (const projectId of [a.projectId, b.projectId]) {
      const position = await get(w.admin, `/api/v1/projects/${projectId}/cost-position`);
      expect(position.data.totals.actual, projectId).toBeCloseTo(0, 2);
    }
  });
});

describe("what may be posted, and when", () => {
  it("refuses a run that is not locked yet", async () => {
    const period = nextPeriod();
    // A run that can still be recalculated is not a cost, and posting one
    // means chasing it with reversals when the numbers move.
    const { programmeId } = await programmeWithProject();
    const v = await village(programmeId);
    const employee = await crewMember(20000);
    await workedDays(period, employee, v, 1, 10);

    const created = await post(w.admin, "/api/v1/payroll/runs", {
      period_start: period.start, period_end: period.end,
    });
    const runId = String(created.body.id ?? created.data.id);
    await post(w.admin, `/api/v1/payroll/runs/${runId}/calculate`, {});

    const p = await preview(runId);
    expect(p.data.postable).toBe(false);

    const r = await postCost(runId);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("recalculated");
  });

  it("refuses to post the same run twice", async () => {
    const period = nextPeriod();
    const { programmeId } = await programmeWithProject();
    const v = await village(programmeId);
    await workedDays(period, await crewMember(25000), v, 1, 15);
    const runId = await lockedRun(period);

    expect((await postCost(runId)).status).toBe(201);
    const again = await postCost(runId);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("Reverse it first");
  });

  it("refuses a run whose days name no project at all", async () => {
    const period = nextPeriod();
    await workedDays(period, await crewMember(20000), null, 1, 18);
    const runId = await lockedRun(period);
    const r = await postCost(runId);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("check-out");
  });

  it("is not something a reader can do", async () => {
    const period = nextPeriod();
    const { programmeId } = await programmeWithProject();
    await workedDays(period, await crewMember(20000), await village(programmeId), 1, 10);
    const runId = await lockedRun(period);
    const r = await postCost(runId, {}, w.role.AUDITOR);
    expect([401, 403]).toContain(r.status);
  });
});

describe("taking it back", () => {
  it("reverses rather than deletes, and lets the run be posted again", async () => {
    const period = nextPeriod();
    const { programmeId, projectId } = await programmeWithProject();
    const v = await village(programmeId);
    await workedDays(period, await crewMember(30000), v, 1, 20);
    const runId = await lockedRun(period);

    await postCost(runId);
    const before = await get(w.admin, `/api/v1/projects/${projectId}/cost-position`);
    expect(before.data.totals.actual).toBeGreaterThan(0);

    const rev = await reverseCost(runId, "Run reopened, attendance corrected");
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.data.reversed).toBeGreaterThan(0);

    // The cost is back to nothing, and both entries are still on the ledger.
    const after = await get(w.admin, `/api/v1/projects/${projectId}/cost-position`);
    expect(after.data.totals.actual).toBeCloseTo(0, 2);
    const rows = await w.pool.query(
      `SELECT count(*)::int AS n FROM project_cost_entries
        WHERE project_id = $1 AND source_type = 'PAYROLL'`, [projectId]);
    expect(rows.rows[0].n).toBe(2);

    // And it can be posted again, which is the reason to reverse at all.
    expect((await postCost(runId)).status).toBe(201);
  });

  it("will not reverse what was never posted", async () => {
    const period = nextPeriod();
    const { programmeId } = await programmeWithProject();
    await workedDays(period, await crewMember(20000), await village(programmeId), 1, 10);
    const runId = await lockedRun(period);
    const r = await reverseCost(runId, "nothing there");
    expect(r.status).toBe(422);
  });

  it("insists on a reason", async () => {
    const period = nextPeriod();
    // A reversal without one is a number that moved and nobody can say why.
    const { programmeId } = await programmeWithProject();
    await workedDays(period, await crewMember(20000), await village(programmeId), 1, 10);
    const runId = await lockedRun(period);
    await postCost(runId);
    const r = await post(w.admin, `/api/v1/payroll-runs/${runId}/labour-cost/reverse`, {});
    expect(r.status).toBe(422);
  });
});

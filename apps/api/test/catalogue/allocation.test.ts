/**
 * End-to-end cover for workforce allocation and rostering (§47).
 *
 * Capacity is a question about overlapping date ranges across every project a
 * person is on, so it can only be answered against real rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, createActiveEmployee, idem, uniq, type CatalogueWorld, type Headers,
} from "./fixture.js";

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

/** Allocate as the admin, who holds the override, unless told otherwise. */
async function allocate(over: Record<string, unknown> = {}, who: Headers = w.admin) {
  return post(who, "/api/v1/allocations", {
    employee_id: w.directEmployee, project_id: w.activeProject,
    percentage: 50, starts_on: "2026-10-01", ends_on: "2026-10-31", ...over,
  });
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("allocation capacity", () => {
  it("allows two part allocations that fit inside a person", async () => {
    const a = await allocate({ percentage: 40 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await allocate({ percentage: 60, project_id: w.inactiveProject });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
  });

  it("refuses an over-commitment from somebody without the override", async () => {
    // Checked before the promise is made, not reported afterwards: the point
    // is that the planner can still choose somebody else.
    const res = await allocate(
      { employee_id: w.siteEmployee, percentage: 80 }, w.role.HR_MANAGER);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const over = await allocate(
      { employee_id: w.siteEmployee, percentage: 40, project_id: w.inactiveProject },
      w.role.HR_MANAGER);
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("CAPACITY_EXCEEDED");
    // The message has to carry the number and the date, or it tells the
    // planner nothing they can act on.
    expect(over.body.message).toContain("120%");
  });

  it("demands a reason even from somebody who holds the override", async () => {
    // A fresh active employee with no allocations of their own. This used to
    // borrow the baseline's exited employee, which can no longer be
    // allocated at all (HR-14).
    const employee = await createActiveEmployee(w.app, w.admin);
    await allocate({ employee_id: employee, percentage: 90 });
    const blind = await allocate({ employee_id: employee, percentage: 30, project_id: w.inactiveProject });
    expect(blind.status).toBe(422);
    expect(blind.body.code).toBe("OVERRIDE_REASON_REQUIRED");

    const res = await allocate({
      employee_id: employee, percentage: 30, project_id: w.inactiveProject,
      override_reason: "Short overlap during handover; agreed with both sites",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.override_reason).toContain("handover");
    expect(res.data.override_by).toBe(w.adminId);
  });

  it("ignores an allocation in a different period", async () => {
    const employee = w.suspendedEmployee;
    await allocate({ employee_id: employee, percentage: 100, starts_on: "2026-11-01", ends_on: "2026-11-30" });
    const res = await allocate({
      employee_id: employee, percentage: 100,
      starts_on: "2026-12-01", ends_on: "2026-12-31", project_id: w.inactiveProject,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("frees the capacity when an allocation is cancelled", async () => {
    // A cancelled allocation never happened; counting it would make somebody
    // look permanently full.
    const employee = w.siteEmployee;
    const first = await allocate({
      employee_id: employee, percentage: 100,
      starts_on: "2027-01-01", ends_on: "2027-01-31",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const cancelled = await post(
      { ...w.admin, ...(await ver("resource_allocations", first.data.id)) },
      `/api/v1/allocations/${first.data.id}/status`, { state: "CANCELLED" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const again = await allocate({
      employee_id: employee, percentage: 100,
      starts_on: "2027-01-01", ends_on: "2027-01-31", project_id: w.inactiveProject,
    }, w.role.HR_MANAGER);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("refuses an allocation that ends before it starts", async () => {
    const res = await allocate({ starts_on: "2026-10-31", ends_on: "2026-10-01" });
    expect(res.status).toBe(422);
  });

  it("cannot resurrect a completed allocation", async () => {
    const created = await allocate({
      employee_id: w.directEmployee, percentage: 10,
      starts_on: "2028-01-01", ends_on: "2028-01-31",
    });
    await post({ ...w.admin, ...(await ver("resource_allocations", created.data.id)) },
      `/api/v1/allocations/${created.data.id}/status`, { state: "ACTIVE" });
    await post({ ...w.admin, ...(await ver("resource_allocations", created.data.id)) },
      `/api/v1/allocations/${created.data.id}/status`, { state: "COMPLETED" });
    const res = await post(
      { ...w.admin, ...(await ver("resource_allocations", created.data.id)) },
      `/api/v1/allocations/${created.data.id}/status`, { state: "ACTIVE" });
    expect(res.status).toBe(422);
  });
});

describe("utilisation", () => {
  it("reports who is over-committed and who is idle on a day", async () => {
    const res = await get(w.admin, "/api/v1/allocations/utilisation?on=2026-10-15");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data.on).toBe("2026-10-15");
    const person = res.data.people.find((p: any) => p.employee_id === w.directEmployee);
    expect(person.allocated).toBe(100);
    expect(person.free).toBe(0);
    expect(person.allocations.length).toBeGreaterThan(0);
  });
});

describe("shifts", () => {
  it("computes a night shift as eight hours, not minus sixteen", async () => {
    // Getting this wrong does not look silly — it quietly underpays the
    // people working nights.
    const res = await post(w.role.HR_MANAGER, "/api/v1/shifts", {
      code: uniq("N"), name: "Night", starts_at: "22:00", ends_at: "06:00",
      effective_from: "2026-09-01",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const list = await get(w.admin, "/api/v1/shifts");
    const shift = list.data.find((s: any) => s.id === res.data.id);
    expect(shift.shift_hours).toBe(8);
  });

  it("refuses a shift whose break swallows the whole span", async () => {
    const res = await post(w.role.HR_MANAGER, "/api/v1/shifts", {
      code: uniq("X"), name: "Broken", starts_at: "09:00", ends_at: "10:00",
      break_minutes: 60, effective_from: "2026-09-01",
    });
    expect(res.status).toBe(422);
  });
});

describe("roster", () => {
  let shiftId: string;

  beforeAll(async () => {
    const res = await post(w.role.HR_MANAGER, "/api/v1/shifts", {
      code: uniq("D"), name: "Day", starts_at: "09:00", ends_at: "18:00",
      break_minutes: 60, rest_days: ["SUN"], daily_threshold_hours: 8,
      overtime_multiplier: 1.5, rest_day_multiplier: 2, effective_from: "2026-09-01",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    shiftId = res.data.id;
  });

  it("will not roster the same person twice on one day", async () => {
    // Two shifts on one day makes "which shift were they on" unanswerable and
    // doubles the overtime calculation.
    const first = await post(w.role.HR_MANAGER, "/api/v1/roster", {
      employee_id: w.directEmployee, shift_id: shiftId, roster_date: "2026-09-14",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await post(w.role.HR_MANAGER, "/api/v1/roster", {
      employee_id: w.directEmployee, shift_id: shiftId, roster_date: "2026-09-14",
    });
    expect(again.status).toBe(409);
  });

  it("skips rest days when rostering a window, rather than refusing the lot", async () => {
    // A fortnight for a crew is one action; failing it because it contains a
    // Sunday would make the endpoint useless.
    const res = await post(w.role.HR_MANAGER, "/api/v1/roster/bulk", {
      shift_id: shiftId, starts_on: "2026-09-21", ends_on: "2026-09-27",
      employee_ids: [w.siteEmployee],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 21st is a Monday; the 27th is a Sunday.
    expect(res.data.created).toBe(6);
    expect(res.data.skipped_rest_day).toBe(1);
  });

  it("computes overtime from the shift rule when a day is approved", async () => {
    const entry = await post(w.role.HR_MANAGER, "/api/v1/roster", {
      employee_id: w.suspendedEmployee, shift_id: shiftId, roster_date: "2026-09-15",
    });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    const res = await post(
      { ...w.role.HR_MANAGER, ...(await ver("roster_entries", entry.data.id)) },
      `/api/v1/roster/${entry.data.id}/approve`, { worked_hours: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number(res.data.overtime_hours)).toBe(2);
    // Eight normal plus two at one and a half.
    expect(Number(res.data.payable_hours)).toBe(11);
  });

  it("pays every hour on a rest day at the premium rate", async () => {
    // There is no "normal" portion of a day somebody was not rostered at all.
    // Somebody not otherwise rostered that day; the exited baseline employee
    // this used to borrow can no longer be rostered (HR-14).
    const employeeId = await createActiveEmployee(w.app, w.admin);
    const entry = await post(w.role.HR_MANAGER, "/api/v1/roster", {
      employee_id: employeeId, shift_id: shiftId, roster_date: "2026-09-20",
    });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    const res = await post(
      { ...w.role.HR_MANAGER, ...(await ver("roster_entries", entry.data.id)) },
      `/api/v1/roster/${entry.data.id}/approve`, { worked_hours: 6 });
    expect(Number(res.data.payable_hours)).toBe(12);
  });

  it("will not approve the same day twice", async () => {
    const entry = await post(w.role.HR_MANAGER, "/api/v1/roster", {
      employee_id: w.directEmployee, shift_id: shiftId, roster_date: "2026-09-16",
    });
    await post({ ...w.role.HR_MANAGER, ...(await ver("roster_entries", entry.data.id)) },
      `/api/v1/roster/${entry.data.id}/approve`, { worked_hours: 8 });
    const again = await post(
      { ...w.role.HR_MANAGER, ...(await ver("roster_entries", entry.data.id)) },
      `/api/v1/roster/${entry.data.id}/approve`, { worked_hours: 8 });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe("ALREADY_APPROVED");
  });

  it("demands the hours actually worked", async () => {
    const entry = await post(w.role.HR_MANAGER, "/api/v1/roster", {
      employee_id: w.siteEmployee, shift_id: shiftId, roster_date: "2026-09-17",
    });
    const res = await post(
      { ...w.role.HR_MANAGER, ...(await ver("roster_entries", entry.data.id)) },
      `/api/v1/roster/${entry.data.id}/approve`, {});
    expect(res.status).toBe(422);
  });
});

describe("permissions", () => {
  it("lets payroll read the roster but not write it", async () => {
    // Payroll consumes the approved result; it does not decide the roster.
    expect((await get(w.role.PAYROLL_OFFICER, "/api/v1/roster")).status).toBe(200);
    expect((await post(w.role.PAYROLL_OFFICER, "/api/v1/shifts", {
      code: uniq("P"), name: "X", starts_at: "09:00", ends_at: "18:00",
      effective_from: "2026-09-01",
    })).status).toBe(403);
  });

  it("keeps a team lead to reading allocations", async () => {
    expect((await get(w.role.TEAM_LEAD, "/api/v1/allocations")).status).toBe(200);
    expect((await allocate({}, w.role.TEAM_LEAD)).status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("will not allocate an employee from another organisation", async () => {
    const res = await post(w.admin, "/api/v1/allocations", {
      employee_id: w.other.employee, project_id: w.activeProject,
      percentage: 50, starts_on: "2026-10-01", ends_on: "2026-10-31",
    });
    expect([403, 404]).toContain(res.status);
  });
});

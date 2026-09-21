/**
 * Catalogue: Leave, payroll, holidays and time (UT-LP-01..10).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEffectiveHolidays, type HolidayCandidate } from "@silverline/shared";
import {
  GEO,
  buildWorld,
  createActiveEmployee,
  createChain,
  createFence,
  grantLeaveBalance,
  headersForUserId,
  idem,
  ifMatch,
  leaveTypeIds,
  loginAs,
  createUser,
  uniq,
  workDate,
  type CatalogueWorld,
  type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let types: Record<string, string>;

beforeAll(async () => {
  w = await buildWorld();
  types = await leaveTypeIds(w.app, w.admin);
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

function plusDays(days: number, from = workDate()): string {
  const base = new Date(`${from}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

interface ErrorBody {
  code: string;
  message: string;
  field_errors?: Array<{ field: string; message: string }>;
}

/** An employee with a CL balance and a signed-in login of their own. */
async function worker(openingBalance = 12): Promise<{
  employeeId: string;
  userId: string;
  headers: Headers;
}> {
  const employeeId = await createActiveEmployee(w.app, w.admin, {
    district_id: w.chainA.district,
    salary_basic: 30000,
  });
  await grantLeaveBalance(w.app, w.admin, employeeId, types.CL!, openingBalance);
  const username = `cat_lp_${uniq()}`;
  const userId = await createUser(w.pool, w.orgId, {
    username,
    roles: ["EMPLOYEE"],
    employeeId,
  });
  return { employeeId, userId, headers: await loginAs(w.app, username) };
}

async function fileLeave(
  headers: Headers,
  body: Record<string, unknown>,
) {
  return w.app.inject({
    method: "POST",
    url: "/api/v1/leave/requests",
    headers: { ...headers, ...idem() },
    payload: body,
  });
}

async function balanceOf(employeeId: string, leaveTypeId: string) {
  const res = await w.app.inject({
    method: "GET",
    url: `/api/v1/leave/balances?employee_id=${employeeId}`,
    headers: w.admin,
  });
  const rows = (
    res.json() as {
      data: Array<{
        leave_type_id: string;
        opening_balance: number;
        credits: number;
        consumed: number;
        adjustments: number;
        current_balance: number;
      }>;
    }
  ).data;
  return rows.find((r) => r.leave_type_id === leaveTypeId)!;
}

describe("UT-LP-01 calculate leave ledger", () => {
  it("computes balance as opening + credits − consumed + adjustments", async () => {
    const { employeeId } = await worker(10);
    // Set every term to a distinct value so a wrong sign cannot pass by luck.
    await w.pool.query(
      `UPDATE leave_balances SET credits = 4, consumed = 3, adjustments = 2
        WHERE employee_id = $1 AND leave_type_id = $2`,
      [employeeId, types.CL],
    );

    const balance = await balanceOf(employeeId, types.CL!);
    expect(balance.opening_balance).toBe(10);
    expect(balance.credits).toBe(4);
    expect(balance.consumed).toBe(3);
    expect(balance.adjustments).toBe(2);
    expect(balance.current_balance).toBe(10 + 4 - 3 + 2);
  });

  it("subtracts a negative adjustment rather than adding it", async () => {
    const { employeeId } = await worker(10);
    await w.pool.query(
      "UPDATE leave_balances SET adjustments = -2.5 WHERE employee_id = $1 AND leave_type_id = $2",
      [employeeId, types.CL],
    );
    expect((await balanceOf(employeeId, types.CL!)).current_balance).toBe(7.5);
  });

  it("moves consumed only when a request is approved", async () => {
    const { employeeId, headers } = await worker(10);
    const before = await balanceOf(employeeId, types.CL!);

    const created = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(30),
      to_date: plusDays(31),
      reason: "Ledger probe",
    });
    expect(created.statusCode).toBe(201);
    const request = created.json() as { id: string; current_approver_id: string };

    // Pending leave has not been taken yet.
    expect((await balanceOf(employeeId, types.CL!)).consumed).toBe(before.consumed);

    const approver = await headersForUserId(w, request.current_approver_id);
    const decision = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...approver,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(decision.statusCode).toBe(200);

    const after = await balanceOf(employeeId, types.CL!);
    expect(after.consumed).toBe(before.consumed + 2);
    expect(after.current_balance).toBe(before.current_balance - 2);
  });

  it("refuses a request that exceeds the available balance", async () => {
    const { employeeId, headers } = await worker(1);
    const res = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(40),
      to_date: plusDays(44),
      reason: "More than the balance allows",
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toMatch(/BALANCE/i);
  });

  it("does not require a balance for an unpaid type", async () => {
    const { employeeId, headers } = await worker(0);
    const res = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.LOP,
      from_date: plusDays(50),
      to_date: plusDays(51),
      reason: "Unpaid absence",
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("UT-LP-02 submit overlapping approved leave or attendance", () => {
  async function approveLeave(
    employeeId: string,
    headers: Headers,
    from: string,
    to: string,
  ): Promise<string> {
    const created = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: from,
      to_date: to,
      reason: "Overlap fixture",
    });
    expect(created.statusCode).toBe(201);
    const request = created.json() as { id: string; current_approver_id: string };
    const approver = await headersForUserId(w, request.current_approver_id);
    const decision = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...approver,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(decision.statusCode).toBe(200);
    return request.id;
  }

  it("blocks a request overlapping an already approved one", async () => {
    const { employeeId, headers } = await worker();
    const approvedId = await approveLeave(employeeId, headers, plusDays(60), plusDays(62));

    const overlapping = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(61),
      to_date: plusDays(63),
      reason: "Overlapping request",
    });
    expect(overlapping.statusCode).toBe(422);
    const body = overlapping.json() as ErrorBody & {
      conflicting_request_ids?: string[];
    };
    expect(body.code).toMatch(/OVERLAP/i);
    // The blocker is named, so the user can find and cancel it.
    expect(body.conflicting_request_ids ?? []).toContain(approvedId);
  });

  it("allows an adjacent, non-overlapping request", async () => {
    const { employeeId, headers } = await worker();
    await approveLeave(employeeId, headers, plusDays(70), plusDays(71));

    const adjacent = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(72),
      to_date: plusDays(73),
      reason: "The day after",
    });
    expect(adjacent.statusCode).toBe(201);
  });

  it("routes an overlap with recorded attendance to the correction workflow", async () => {
    // A day with attendance already recorded cannot quietly become leave; the
    // user is told to regularize the attendance first.
    const chain = await createChain(w.app, w.admin, `LP${uniq().slice(-3)}`);
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    await grantLeaveBalance(w.app, w.admin, employeeId, types.CL!);
    await createFence(w.app, w.admin, {
      name: "LP fence",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { ...GEO.circleCentre, radius_m: GEO.circleRadiusM },
    });
    const username = `cat_lp_att_${uniq()}`;
    await createUser(w.pool, w.orgId, {
      username,
      roles: ["EMPLOYEE"],
      employeeId,
    });
    const headers = await loginAs(w.app, username);

    const punch = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employeeId,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
      },
    });
    expect(punch.statusCode).toBe(201);

    const res = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: workDate(),
      to_date: workDate(),
      reason: "Leave on a day already worked",
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody & { conflicting_dates?: string[] };
    expect(body.code).toBe("ATTENDANCE_CONFLICT");
    expect(body.message).toMatch(/regulariz/i);
    expect(body.conflicting_dates ?? []).toContain(workDate());
  });

  it("stops blocking once the conflicting request is cancelled", async () => {
    const { employeeId, headers } = await worker();
    const created = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(80),
      to_date: plusDays(81),
      reason: "To be cancelled",
    });
    const requestId = (created.json() as { id: string }).id;

    const blocked = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(80),
      to_date: plusDays(80),
      reason: "Blocked by the pending one",
    });
    expect(blocked.statusCode).toBe(422);

    const cancelled = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${requestId}/cancel`,
      headers: {
        ...headers,
        ...(await ifMatch(w, "leave_requests", requestId)),
        ...idem(),
      },
      payload: { reason: "Plans changed" },
    });
    expect(cancelled.statusCode).toBe(200);

    const retry = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(80),
      to_date: plusDays(80),
      reason: "Now unblocked",
    });
    expect(retry.statusCode).toBe(201);
  });
});

describe("UT-LP-03 approve and reject through configured chain", () => {
  /** Employee → manager (TEAM_LEAD login) → HR/admin fallback. */
  async function chainFixture() {
    const managerEmployee = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const managerUsername = `cat_tl_${uniq()}`;
    const managerUserId = await createUser(w.pool, w.orgId, {
      username: managerUsername,
      roles: ["TEAM_LEAD"],
      employeeId: managerEmployee,
    });
    const managerHeaders = await loginAs(w.app, managerUsername);

    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      reports_to: managerEmployee,
    });
    await grantLeaveBalance(w.app, w.admin, employeeId, types.CL!);
    const username = `cat_req_${uniq()}`;
    await createUser(w.pool, w.orgId, {
      username,
      roles: ["EMPLOYEE"],
      employeeId,
    });
    const headers = await loginAs(w.app, username);
    return { employeeId, headers, managerUserId, managerHeaders };
  }

  it("lets only the current step's approver decide", async () => {
    const { employeeId, headers, managerUserId, managerHeaders } = await chainFixture();
    const created = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(90),
      to_date: plusDays(90),
      reason: "Chain probe",
    });
    expect(created.statusCode).toBe(201);
    const request = created.json() as { id: string; current_approver_id: string };
    // Step 1 is the reporting manager, not the HR fallback.
    expect(request.current_approver_id).toBe(managerUserId);

    // A later-step approver cannot jump the queue.
    const premature = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...w.admin,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(premature.statusCode).toBe(403);
    expect((premature.json() as ErrorBody).code).toBe("NOT_APPROVER");

    const step1 = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...managerHeaders,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE", note: "Cover arranged" },
    });
    expect(step1.statusCode).toBe(200);

    // After step 1 the request advances rather than completing.
    const detail = await w.app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${request.id}`,
      headers: w.admin,
    });
    const after = detail.json() as {
      status: string;
      current_approver_id: string | null;
      approval_chain: Array<{
        step: number;
        approver_user_id: string;
        status: string;
        decided_at: string | null;
        note: string | null;
      }>;
    };
    expect(after.status).toBe("PENDING");
    expect(after.current_approver_id).not.toBe(managerUserId);

    // Step 1 records who decided, when, and what they said.
    const decided = after.approval_chain.find((s) => s.approver_user_id === managerUserId)!;
    expect(decided.status).toBe("APPROVED");
    expect(decided.decided_at).toBeTruthy();
    expect(decided.note).toBe("Cover arranged");
  });

  it("completes the request once every step has approved", async () => {
    const { employeeId, headers, managerHeaders } = await chainFixture();
    const created = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(95),
      to_date: plusDays(95),
      reason: "Full chain",
    });
    const request = created.json() as { id: string };

    await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...managerHeaders,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });

    const detail = await w.app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${request.id}`,
      headers: w.admin,
    });
    const step2Approver = (detail.json() as { current_approver_id: string })
      .current_approver_id;
    const approver = await headersForUserId(w, step2Approver);
    const final = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...approver,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(final.statusCode).toBe(200);

    const row = await w.pool.query(
      "SELECT status, current_approver_id FROM leave_requests WHERE id = $1",
      [request.id],
    );
    expect(row.rows[0].status).toBe("APPROVED");
    expect(row.rows[0].current_approver_id).toBeNull();
  });

  it("ends the request at the first rejection and requires a note", async () => {
    const { employeeId, headers, managerHeaders } = await chainFixture();
    const created = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(100),
      to_date: plusDays(100),
      reason: "To be rejected",
    });
    const request = created.json() as { id: string };

    // A rejection without a reason tells the employee nothing.
    const noNote = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...managerHeaders,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "REJECT" },
    });
    expect(noNote.statusCode).toBe(422);
    expect((noNote.json() as ErrorBody).code).toBe("NOTE_REQUIRED");

    const rejected = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...managerHeaders,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "REJECT", note: "Site is short-staffed that week" },
    });
    expect(rejected.statusCode).toBe(200);

    const row = await w.pool.query("SELECT status FROM leave_requests WHERE id = $1", [
      request.id,
    ]);
    // A rejection at step 1 ends it; it does not travel on to step 2.
    expect(row.rows[0].status).toBe("REJECTED");
  });

  it("refuses to decide a request that is already closed", async () => {
    const { employeeId, headers, managerHeaders } = await chainFixture();
    const created = await fileLeave(headers, {
      employee_id: employeeId,
      leave_type_id: types.CL,
      from_date: plusDays(105),
      to_date: plusDays(105),
      reason: "Double decision",
    });
    const request = created.json() as { id: string };
    await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...managerHeaders,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "REJECT", note: "No" },
    });

    const again = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...managerHeaders,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("UT-LP-04 resolve holiday precedence", () => {
  const DATE = "2026-10-02";

  function candidate(over: Partial<HolidayCandidate>): HolidayCandidate {
    return {
      id: over.id ?? uniq(),
      date: over.date ?? DATE,
      name: over.name ?? "Holiday",
      type: over.type ?? "national",
      scope_type: over.scope_type ?? null,
      scope_id: over.scope_id ?? null,
      ...over,
    };
  }

  it("prefers an explicitly scoped holiday over the organization-wide default", () => {
    const orgWide = candidate({ id: "org", name: "National holiday" });
    const local = candidate({
      id: "local",
      name: "District bandh",
      type: "local",
      scope_type: "district",
      scope_id: "d1",
    });

    // Insertion order must not decide the answer.
    for (const list of [
      [orgWide, local],
      [local, orgWide],
    ]) {
      const effective = resolveEffectiveHolidays(list, ["d1"]);
      expect(effective).toHaveLength(1);
      expect(effective[0]!.id).toBe("local");
    }
  });

  it("prefers the finest scope in the employee's own chain", () => {
    const list = [
      candidate({ id: "org" }),
      candidate({ id: "district", scope_type: "district", scope_id: "d1" }),
      candidate({ id: "mandal", scope_type: "mandal", scope_id: "m1" }),
      candidate({ id: "village", scope_type: "village", scope_id: "v1" }),
      candidate({ id: "site", scope_type: "site", scope_id: "s1" }),
    ];
    expect(resolveEffectiveHolidays(list, ["s1", "v1", "m1", "d1"])[0]!.id).toBe("site");
    // Remove the site from the chain and the next-finest wins.
    expect(resolveEffectiveHolidays(list, ["v1", "m1", "d1"])[0]!.id).toBe("village");
    expect(resolveEffectiveHolidays(list, ["d1"])[0]!.id).toBe("district");
    expect(resolveEffectiveHolidays(list, [])[0]!.id).toBe("org");
  });

  it("ignores a holiday scoped to somewhere the employee does not work", () => {
    const elsewhere = candidate({
      id: "elsewhere",
      scope_type: "district",
      scope_id: "other-district",
    });
    const orgWide = candidate({ id: "org" });
    const effective = resolveEffectiveHolidays([elsewhere, orgWide], ["d1"]);
    expect(effective).toHaveLength(1);
    expect(effective[0]!.id).toBe("org");
  });

  it("returns nothing when only another place's holiday exists", () => {
    const elsewhere = candidate({
      scope_type: "village",
      scope_id: "somewhere-else",
    });
    expect(resolveEffectiveHolidays([elsewhere], ["v1"])).toEqual([]);
  });

  it("resolves each date independently", () => {
    const list = [
      candidate({ id: "a-org", date: "2026-01-26" }),
      candidate({
        id: "b-local",
        date: "2026-08-15",
        scope_type: "district",
        scope_id: "d1",
      }),
      candidate({ id: "b-org", date: "2026-08-15" }),
    ];
    const effective = resolveEffectiveHolidays(list, ["d1"]);
    expect(effective.map((h) => h.id)).toEqual(["a-org", "b-local"]);
  });

  it("applies the same precedence through the API", async () => {
    const chain = await createChain(w.app, w.admin, `H${uniq().slice(-3)}`);
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });

    const orgWide = await w.app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: { ...w.admin, ...idem() },
      payload: { date: DATE, name: "Gandhi Jayanti", type: "national" },
    });
    expect(orgWide.statusCode).toBe(201);

    const local = await w.app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: { ...w.admin, ...idem() },
      payload: {
        date: DATE,
        name: "Local village festival",
        type: "local",
        scope_type: "village",
        scope_id: chain.village,
      },
    });
    expect(local.statusCode).toBe(201);

    // Unresolved, both rows are visible — that is the raw list, not an answer.
    const raw = await w.app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026",
      headers: w.admin,
    });
    const rawOnDate = (raw.json() as { data: Array<{ date: string }> }).data.filter(
      (h) => h.date === DATE,
    );
    expect(rawOnDate.length).toBeGreaterThanOrEqual(2);

    const resolved = await w.app.inject({
      method: "GET",
      url: `/api/v1/holidays?year=2026&employee_id=${employeeId}`,
      headers: w.admin,
    });
    expect(resolved.statusCode).toBe(200);
    const onDate = (
      resolved.json() as { data: Array<{ date: string; name: string }> }
    ).data.filter((h) => h.date === DATE);
    expect(onDate).toHaveLength(1);
    expect(onDate[0]!.name).toBe("Local village festival");
  });

  it("falls back to the organization-wide holiday for an employee elsewhere", async () => {
    // The employee from the other chain has no village override on that date.
    const resolved = await w.app.inject({
      method: "GET",
      url: `/api/v1/holidays?year=2026&employee_id=${w.directEmployee}`,
      headers: w.admin,
    });
    const onDate = (
      resolved.json() as { data: Array<{ date: string; name: string }> }
    ).data.filter((h) => h.date === DATE);
    expect(onDate).toHaveLength(1);
    expect(onDate[0]!.name).toBe("Gandhi Jayanti");
  });
});

describe("UT-LP-05 advance payroll state machine", () => {
  /** A run with a single attended day, so calculate has data to work with. */
  async function attendedRun(): Promise<{ runId: string; employeeId: string }> {
    const period = `2026-0${1 + (Number(uniq().slice(-1)) % 8)}`;
    void period;
    const chain = await createChain(w.app, w.admin, `PR${uniq().slice(-3)}`);
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      salary_basic: 30000,
    });
    // A distinct historical month per run, so OVERLAPPING_RUN never fires.
    const { start, end } = uniqueMonth();
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [employeeId, start],
    );
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    expect(created.statusCode).toBe(201);
    return { runId: (created.json() as { id: string }).id, employeeId };
  }

  async function advance(runId: string, step: string, payload: unknown = {}) {
    return w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/${step}`,
      headers: { ...w.admin, ...idem() },
      payload: payload as never,
    });
  }

  async function statusOf(runId: string): Promise<string> {
    const row = await w.pool.query("SELECT status FROM payroll_runs WHERE id = $1", [runId]);
    return row.rows[0].status as string;
  }

  it("walks OPEN → CALCULATED → REVIEW → APPROVED → LOCKED", async () => {
    const { runId } = await attendedRun();
    expect(await statusOf(runId)).toBe("OPEN");

    expect((await advance(runId, "calculate")).statusCode).toBe(200);
    expect(await statusOf(runId)).toBe("CALCULATED");

    expect((await advance(runId, "submit-review")).statusCode).toBe(200);
    expect(await statusOf(runId)).toBe("REVIEW");

    expect((await advance(runId, "approve", { note: "Checked" })).statusCode).toBe(200);
    expect(await statusOf(runId)).toBe("APPROVED");

    expect((await advance(runId, "lock")).statusCode).toBe(200);
    expect(await statusOf(runId)).toBe("LOCKED");
  });

  it("refuses every out-of-order transition", async () => {
    const { runId } = await attendedRun();

    // From OPEN, only calculate is legal.
    for (const step of ["submit-review", "approve", "lock", "reopen"]) {
      const res = await advance(runId, step, { reason: "x" });
      expect(res.statusCode, `${step} from OPEN`).toBeGreaterThanOrEqual(400);
      expect(await statusOf(runId)).toBe("OPEN");
    }

    await advance(runId, "calculate");
    // From CALCULATED, only submit-review is legal.
    for (const step of ["approve", "lock", "reopen"]) {
      const res = await advance(runId, step, { reason: "x" });
      expect(res.statusCode, `${step} from CALCULATED`).toBeGreaterThanOrEqual(400);
      expect(await statusOf(runId)).toBe("CALCULATED");
    }

    await advance(runId, "submit-review");
    // From REVIEW, only approve is legal.
    for (const step of ["lock", "reopen", "calculate"]) {
      const res = await advance(runId, step, { reason: "x" });
      expect(res.statusCode, `${step} from REVIEW`).toBeGreaterThanOrEqual(400);
      expect(await statusOf(runId)).toBe("REVIEW");
    }
  });

  it("records who approved and who locked", async () => {
    const { runId } = await attendedRun();
    await advance(runId, "calculate");
    await advance(runId, "submit-review");
    await advance(runId, "approve", { note: "Signed off" });
    await advance(runId, "lock");

    const row = await w.pool.query(
      "SELECT approved_by, approved_at, approve_note, locked_by, locked_at FROM payroll_runs WHERE id = $1",
      [runId],
    );
    expect(row.rows[0].approved_by).toBe(w.adminId);
    expect(row.rows[0].approved_at).toBeTruthy();
    expect(row.rows[0].approve_note).toBe("Signed off");
    expect(row.rows[0].locked_by).toBe(w.adminId);
    expect(row.rows[0].locked_at).toBeTruthy();
  });

  it("refuses a run whose period overlaps an existing one", async () => {
    const { start, end } = uniqueMonth();
    const first = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    expect(first.statusCode).toBe(201);

    const overlapping = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    expect(overlapping.statusCode).toBe(422);
    expect((overlapping.json() as ErrorBody).code).toBe("OVERLAPPING_RUN");
  });
});

/**
 * Joining date for every payroll-test employee.
 *
 * The run periods below are historical (see uniqueMonth), and payroll correctly
 * excludes anyone who had not joined by the end of the period — so a fixture
 * employee has to predate them.
 */
const PAYROLL_DOJ = "2019-01-01";

/** A distinct historical month per call, so payroll runs never overlap. */
let monthCursor = 0;
function uniqueMonth(): { start: string; end: string } {
  monthCursor += 1;
  // Walk backwards from 2020 — comfortably before any fixture attendance.
  const total = 2020 * 12 + monthCursor;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${last}` };
}

describe("UT-LP-06 calculate payroll with missing attendance", () => {
  it("blocks the run when the period has no attendance at all", async () => {
    const { start, end } = uniqueMonth();
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;

    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("NO_ATTENDANCE_DATA");

    // The run returns to OPEN rather than being stranded in VALIDATING.
    const row = await w.pool.query("SELECT status FROM payroll_runs WHERE id = $1", [runId]);
    expect(row.rows[0].status).toBe("OPEN");
  });

  it("lists the employees with missing data instead of paying them silently", async () => {
    const { start, end } = uniqueMonth();
    const withData = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: PAYROLL_DOJ,
    });
    const withoutData = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 24000,
      date_of_joining: PAYROLL_DOJ,
    });
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [withData, start],
    );

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;

    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      warnings: Array<{ type: string; employee_id: string; message: string }>;
    };
    // The employee with no records is named, with an actionable warning type.
    const missing = body.warnings.filter((wn) => wn.employee_id === withoutData);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]!.type).toBe("NO_RECORDS");
    expect(body.warnings.some((wn) => wn.employee_id === withData)).toBe(false);
  });

  it("advances once the missing attendance is supplied", async () => {
    const { start, end } = uniqueMonth();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: PAYROLL_DOJ,
    });
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;

    expect(
      (
        await w.app.inject({
          method: "POST",
          url: `/api/v1/payroll/runs/${runId}/calculate`,
          headers: { ...w.admin, ...idem() },
          payload: {},
        })
      ).statusCode,
    ).toBe(422);

    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [employeeId, start],
    );

    const retry = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(retry.statusCode).toBe(200);
  });
});

describe("UT-LP-07 calculate LOP, earnings, deductions and net", () => {
  it("uses the configured divisor and rounds without binary floating point", async () => {
    const { start, end } = uniqueMonth();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: PAYROLL_DOJ,
    });
    // 10 complete days at the start of the month, then nothing.
    for (let day = 1; day <= 10; day += 1) {
      await w.pool.query(
        `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
         VALUES ($1, ($2::date + ($3 || ' days')::interval)::date, 'COMPLETE', NOW())`,
        [employeeId, start, String(day - 1)],
      );
    }

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;
    await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });

    const slip = await w.pool.query(
      "SELECT earnings, deductions, gross, total_deductions, net_pay FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
      [runId, employeeId],
    );
    expect(slip.rowCount).toBe(1);
    const row = slip.rows[0] as {
      earnings: Record<string, number>;
      deductions: Record<string, number>;
      gross: string;
      total_deductions: string;
      net_pay: string;
    };

    // Policy divisor is 30, so a day of a ₹30,000 basic is ₹1,000.
    expect(row.earnings.per_day).toBe(1000);

    // Sundays are paid days off, not working days, so they are never LOP.
    // Days 1-10 are all paid: the Sundays among them as days off, the rest
    // as attendance. Only the working days after the 10th are unpaid -- for
    // a 30-day month with 3 Sundays in 11-30, that is 20 - 3 = 17.
    const periodDays = daysBetween(start, end);
    const tenth = plusDaysFrom(start, 9);
    const sundaysInFirstTen = sundaysBetween(start, tenth);
    const sundaysAfter = sundaysBetween(plusDaysFrom(start, 10), end);
    const unpaid = periodDays - 10 - sundaysAfter;
    expect(row.earnings.present_days).toBe(10 - sundaysInFirstTen);
    expect(row.earnings.paid_off_days).toBe(sundaysInFirstTen + sundaysAfter);
    expect(row.earnings.payable_days).toBe(periodDays - unpaid);
    expect(row.deductions.lop_days).toBe(unpaid);
    expect(row.deductions.lop_amount).toBe(unpaid * 1000);

    // A whole month earns the basic, and LOP comes off it once
    // (30,000 - 17 x 1,000 = 13,000 in that example). PF is 12% of gross.
    const gross = 30_000 - unpaid * 1000;
    expect(Number(row.gross)).toBe(gross);
    expect(row.deductions.pf).toBe(Math.round(gross * 12) / 100);

    // LOP is already out of gross, so the deductions are PF alone. (It used
    // to come off a second time here, which drove this slip's net to 0.)
    expect(Number(row.total_deductions)).toBe(row.deductions.pf);
    expect(Number(row.net_pay)).toBe(gross - row.deductions.pf);

    // Every money value is a clean 2dp decimal, not a binary artefact.
    for (const value of [row.gross, row.total_deductions, row.net_pay]) {
      expect(String(value)).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it("counts a partial day as half and a paid leave day as payable", async () => {
    const { start, end } = uniqueMonth();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: PAYROLL_DOJ,
    });
    // Monday to Wednesday of the first full week, so none of the three days
    // is a Sunday (which would be paid as a day off whatever was recorded).
    const monday = firstMonday(start);
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW()),
              ($1, ($2::date + INTERVAL '1 day')::date, 'PARTIAL', NOW())`,
      [employeeId, monday],
    );
    // One approved paid-leave day inside the period.
    await w.pool.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days,
          reason, status, approval_chain, current_approver_id)
       VALUES ($1, $2, $3, ($4::date + INTERVAL '2 days')::date,
               ($4::date + INTERVAL '2 days')::date, 1, 'paid leave',
               'APPROVED', '[]'::jsonb, NULL)`,
      [w.orgId, employeeId, types.CL, monday],
    );

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;
    await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });

    const slip = await w.pool.query(
      "SELECT earnings FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
      [runId, employeeId],
    );
    const earnings = slip.rows[0].earnings as Record<string, number>;
    expect(earnings.present_days).toBe(1.5);
    expect(earnings.paid_leave_days).toBe(1);
    // Every Sunday of the month is paid as a day off on top of the 2.5 days.
    const sundays = sundaysBetween(start, end);
    expect(earnings.paid_off_days).toBe(sundays);
    expect(earnings.payable_days).toBe(2.5 + sundays);
  });

  it("warns rather than computing a salary it does not have", async () => {
    const { start, end } = uniqueMonth();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      date_of_joining: PAYROLL_DOJ,
    });
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [employeeId, start],
    );
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    const body = res.json() as {
      warnings: Array<{ type: string; employee_id: string }>;
    };
    expect(
      body.warnings.some((wn) => wn.employee_id === employeeId && wn.type === "NO_SALARY"),
    ).toBe(true);

    const slip = await w.pool.query(
      "SELECT gross, net_pay FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
      [runId, employeeId],
    );
    expect(Number(slip.rows[0].gross)).toBe(0);
    expect(Number(slip.rows[0].net_pay)).toBe(0);
  });

  it("never returns a negative net pay", async () => {
    const { start, end } = uniqueMonth();
    // A single attended day against a month of LOP. LOP comes out of gross,
    // never below zero, and the floor on net keeps the slip from ever owing
    // the employer money.
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: PAYROLL_DOJ,
    });
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [employeeId, start],
    );
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;
    await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    const slip = await w.pool.query(
      "SELECT net_pay FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
      [runId, employeeId],
    );
    expect(Number(slip.rows[0].net_pay)).toBeGreaterThanOrEqual(0);
  });
});

function plusDaysFrom(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function sundaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = plusDaysFrom(d, 1)) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) n += 1;
  }
  return n;
}

/** The first Monday on or after a date. */
function firstMonday(date: string): string {
  let d = date;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = plusDaysFrom(d, 1);
  return d;
}

function daysBetween(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    ) + 1
  );
}

describe("UT-LP-08 mutate finalized payroll", () => {
  /** A locked run with one payslip. */
  async function lockedRun(): Promise<{ runId: string; employeeId: string }> {
    const { start, end } = uniqueMonth();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: PAYROLL_DOJ,
    });
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [employeeId, start],
    );
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;
    for (const step of ["calculate", "submit-review", "approve", "lock"]) {
      const res = await w.app.inject({
        method: "POST",
        url: `/api/v1/payroll/runs/${runId}/${step}`,
        headers: { ...w.admin, ...idem() },
        payload: {},
      });
      expect(res.statusCode, step).toBe(200);
    }
    return { runId, employeeId };
  }

  it("rejects an ordinary recalculation of a locked run", async () => {
    const { runId } = await lockedRun();
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("RUN_SEALED");

    const row = await w.pool.query("SELECT status FROM payroll_runs WHERE id = $1", [runId]);
    expect(row.rows[0].status).toBe("LOCKED");
  });

  it("requires a reason for the controlled reopen", async () => {
    const { runId } = await lockedRun();
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/reopen`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("REASON_REQUIRED");

    const row = await w.pool.query("SELECT status FROM payroll_runs WHERE id = $1", [runId]);
    expect(row.rows[0].status).toBe("LOCKED");
  });

  it("reopens under a reason, audits it, and preserves the prior payslip", async () => {
    const { runId, employeeId } = await lockedRun();
    const before = await w.pool.query(
      "SELECT id, version, gross FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
      [runId, employeeId],
    );
    const priorSlip = before.rows[0] as { id: string; version: number; gross: string };

    const reason = "Attendance correction approved by the site manager";
    const reopened = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/reopen`,
      headers: { ...w.admin, ...idem() },
      payload: { recalculate: true, reason },
    });
    expect(reopened.statusCode).toBe(200);

    const row = await w.pool.query(
      "SELECT status, locked_by, locked_at, approved_by FROM payroll_runs WHERE id = $1",
      [runId],
    );
    expect(row.rows[0].status).toBe("OPEN");
    // The previous seal is cleared, so the run must earn a fresh approval.
    expect(row.rows[0].locked_by).toBeNull();
    expect(row.rows[0].approved_by).toBeNull();

    const audit = await w.pool.query(
      "SELECT actor_id, reason FROM audit_events WHERE action = 'payroll.run.reopen' AND entity_id = $1",
      [runId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].reason).toBe(reason);

    // Recalculating archives the old figures rather than overwriting history.
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       SELECT $1, (period_start + INTERVAL '1 day')::date, 'COMPLETE', NOW()
         FROM payroll_runs WHERE id = $2`,
      [employeeId, runId],
    );
    const recalculated = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(recalculated.statusCode).toBe(200);

    const revisions = await w.pool.query(
      "SELECT version FROM payslip_revisions WHERE payslip_id = $1",
      [priorSlip.id],
    );
    expect(revisions.rowCount).toBeGreaterThan(0);
    expect(revisions.rows.map((r) => r.version)).toContain(priorSlip.version);

    const after = await w.pool.query(
      "SELECT version, gross FROM payslips WHERE id = $1",
      [priorSlip.id],
    );
    expect(after.rows[0].version).toBeGreaterThan(priorSlip.version);
    // Net is floored at zero for a mostly-absent month, so gross is the figure
    // that actually moves when a second attended day is added.
    expect(Number(after.rows[0].gross)).toBeGreaterThan(Number(priorSlip.gross));
  });

  it("can reopen back to APPROVED without a full recalculation", async () => {
    const { runId } = await lockedRun();
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/reopen`,
      headers: { ...w.admin, ...idem() },
      payload: { reason: "Correcting the approval note only" },
    });
    expect(res.statusCode).toBe(200);
    const row = await w.pool.query(
      "SELECT status, approved_by FROM payroll_runs WHERE id = $1",
      [runId],
    );
    // The approval survives; only the lock is lifted.
    expect(row.rows[0].status).toBe("APPROVED");
    expect(row.rows[0].approved_by).toBe(w.adminId);
  });

  it("refuses a reopen from an actor without payroll.lock", async () => {
    const { runId } = await lockedRun();
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/reopen`,
      headers: { ...w.role.HR_MANAGER, ...idem() },
      payload: { reason: "Trying anyway" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("UT-LP-09 generate payslip revision", () => {
  /** Advances a run one step, asserting success. */
  async function advance(runId: string, step: string, payload: unknown = {}) {
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/${step}`,
      headers: { ...w.admin, ...idem() },
      payload: payload as never,
    });
    expect(res.statusCode, step).toBe(200);
    return res;
  }

  /** A run calculated once, with one payslip, for one employee. */
  async function calculatedRun(): Promise<{
    runId: string;
    employeeId: string;
    start: string;
  }> {
    const { start, end } = uniqueMonth();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: PAYROLL_DOJ,
    });
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [employeeId, start],
    );
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    const runId = (created.json() as { id: string }).id;
    await advance(runId, "calculate");
    return { runId, employeeId, start };
  }

  it("archives the prior version and increments the current one", async () => {
    const { runId, employeeId, start } = await calculatedRun();
    const first = await w.pool.query(
      // A run pays every active employee in the org, so the lookup is scoped to
      // the one this test created.
      "SELECT id, version, gross FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
      [runId, employeeId],
    );
    const slip = first.rows[0] as { id: string; version: number; gross: string };
    expect(slip.version).toBe(1);

    // Recalculation is only reachable through the controlled reopen — a sealed
    // run cannot be quietly recomputed.
    await advance(runId, "submit-review");
    await advance(runId, "approve");
    await advance(runId, "lock");
    await advance(runId, "reopen", {
      recalculate: true,
      reason: "A second attended day was confirmed",
    });

    // A Tuesday: a working day whatever the month, so attending it saves a
    // day of LOP. (A Sunday is paid already and would change nothing.)
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, $2::date, 'COMPLETE', NOW())`,
      [employeeId, plusDaysFrom(firstMonday(start), 1)],
    );
    await advance(runId, "calculate");

    const after = await w.pool.query(
      "SELECT version, gross, employee_id FROM payslips WHERE id = $1",
      [slip.id],
    );
    expect(after.rows[0].version).toBe(slip.version + 1);
    expect(after.rows[0].employee_id).toBe(employeeId);
    expect(Number(after.rows[0].gross)).toBeGreaterThan(Number(slip.gross));

    // The prior figures are retained, immutably, under the old version.
    const revision = await w.pool.query(
      "SELECT version, snapshot_encrypted FROM payslip_revisions WHERE payslip_id = $1 AND version = $2",
      [slip.id, slip.version],
    );
    expect(revision.rowCount).toBe(1);
    expect(revision.rows[0].snapshot_encrypted).toMatch(/^gcm1\./);
  });

  it("withholds the PDF until the run is approved", async () => {
    const { runId, employeeId } = await calculatedRun();
    const slipId = (
      await w.pool.query(
        "SELECT id FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
        [runId, employeeId],
      )
    ).rows[0].id as string;

    const early = await w.app.inject({
      method: "GET",
      url: `/api/v1/payroll/payslips/${slipId}/pdf`,
      headers: w.admin,
    });
    // A payslip that has not been signed off is not a document anyone should
    // be handed.
    expect(early.statusCode).toBe(409);
    expect((early.json() as ErrorBody).code).toBe("NOT_READY");
  });

  it("serves the PDF for the correct employee, period and version", async () => {
    const { runId, employeeId } = await calculatedRun();
    await advance(runId, "submit-review");
    await advance(runId, "approve");

    const slip = (
      await w.pool.query(
        "SELECT id, version FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
        [runId, employeeId],
      )
    ).rows[0] as { id: string; version: number };

    const pdf = await w.app.inject({
      method: "GET",
      url: `/api/v1/payroll/payslips/${slip.id}/pdf`,
      headers: w.admin,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    // The filename names the version, so two revisions never collide on disk.
    expect(String(pdf.headers["content-disposition"])).toContain(`-v${slip.version}.pdf`);

    const empNo = (
      await w.pool.query("SELECT emp_no FROM employees WHERE id = $1", [employeeId])
    ).rows[0].emp_no as string;
    const text = pdf.rawPayload.toString("latin1");
    expect(text).toContain(empNo);
  });

  it("keeps an earlier revision's PDF intact after a recalculation", async () => {
    const { runId, employeeId, start } = await calculatedRun();
    await advance(runId, "submit-review");
    await advance(runId, "approve");
    const slipId = (
      await w.pool.query(
        "SELECT id FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
        [runId, employeeId],
      )
    ).rows[0].id as string;

    const firstPdf = await w.app.inject({
      method: "GET",
      url: `/api/v1/payroll/payslips/${slipId}/pdf`,
      headers: w.admin,
    });
    expect(firstPdf.statusCode).toBe(200);
    const storedV1 = await w.pool.query(
      "SELECT content_encrypted FROM payslip_documents WHERE payslip_id = $1 AND version = 1",
      [slipId],
    );
    expect(storedV1.rowCount).toBe(1);

    await advance(runId, "lock");
    await advance(runId, "reopen", { recalculate: true, reason: "Correction" });
    await w.pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
       VALUES ($1, ($2::date + INTERVAL '1 day')::date, 'COMPLETE', NOW())`,
      [employeeId, start],
    );
    await advance(runId, "calculate");

    // Version 1's document is untouched by the recalculation: a payslip that
    // has already been handed to an employee must not change under them.
    const afterV1 = await w.pool.query(
      "SELECT content_encrypted FROM payslip_documents WHERE payslip_id = $1 AND version = 1",
      [slipId],
    );
    expect(afterV1.rows[0].content_encrypted).toBe(storedV1.rows[0].content_encrypted);
  });
});

describe("UT-LP-10 convert client time around midnight and DST-independent IST boundaries", () => {
  /** The organization-local work date the server would assign to an instant. */
  function localWorkDate(at: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  }

  it("assigns the IST calendar day, not the UTC one, either side of midnight", () => {
    // 18:45 UTC is 00:15 IST the next day.
    expect(localWorkDate(new Date("2026-03-14T18:45:00Z"))).toBe("2026-03-15");
    // 18:15 UTC is 23:45 IST the same day.
    expect(localWorkDate(new Date("2026-03-14T18:15:00Z"))).toBe("2026-03-14");
    // Exactly midnight IST belongs to the new day.
    expect(localWorkDate(new Date("2026-03-14T18:30:00Z"))).toBe("2026-03-15");
  });

  it("keeps the same +05:30 offset across the dates other regions shift on", () => {
    // IST observes no daylight saving, so a punch at the same wall-clock time
    // maps to the same UTC instant in March and in November.
    const dates = ["2026-03-08", "2026-03-29", "2026-11-01", "2026-10-25"];
    for (const date of dates) {
      const istNoon = new Date(`${date}T06:30:00Z`);
      const formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(istNoon);
      expect(formatted, date).toBe("12:00");
      expect(localWorkDate(istNoon)).toBe(date);
    }
  });

  it("stores the punch in UTC and the record on the organization's local day", async () => {
    const chain = await createChain(w.app, w.admin, `TZ${uniq().slice(-3)}`);
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    await createFence(w.app, w.admin, {
      name: "TZ fence",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { ...GEO.circleCentre, radius_m: GEO.circleRadiusM },
    });

    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employeeId,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      event: { server_timestamp: string };
      record: { work_date: string };
    };

    // The instant is UTC on the wire...
    expect(body.event.server_timestamp).toMatch(/Z$/);
    // ...and the work date is the organization's local calendar day for it.
    expect(body.record.work_date).toBe(localWorkDate(new Date(body.event.server_timestamp)));
  });

  it("honours a different organization timezone for the same instant", async () => {
    // The work date follows the organization's configured zone, not the
    // server's, so a tenant in another zone is not silently shifted a day.
    await w.pool.query("UPDATE organizations SET timezone = 'Pacific/Kiritimati' WHERE id = $1", [
      w.other.orgId,
    ]);
    try {
      const res = await w.app.inject({
        method: "POST",
        url: "/api/v1/attendance/events",
        headers: { ...w.other.admin, ...idem() },
        payload: {
          employee_id: w.other.employee,
          event_type: "CHECK_IN",
          client_timestamp: new Date().toISOString(),
        },
      });
      expect([201, 202]).toContain(res.statusCode);
      const workDateShown = (res.json() as { record?: { work_date: string } }).record?.work_date;
      if (workDateShown) {
        const expected = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Pacific/Kiritimati",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        expect(workDateShown).toBe(expected);
      }
    } finally {
      await w.pool.query("UPDATE organizations SET timezone = 'Asia/Kolkata' WHERE id = $1", [
        w.other.orgId,
      ]);
    }
  });
});

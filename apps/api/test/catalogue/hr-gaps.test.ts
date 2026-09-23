/**
 * HR, attendance and leave gaps found in the September audit.
 *
 * Each describe block names the audit item it pins. Every one of these
 * passed through the product silently before the fix -- an approval that
 * changed nothing, a punch that should have been questioned and was not --
 * so each test asserts the consequence (a record, a refusal, a disabled
 * login), not just a status code.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GEO,
  buildWorld,
  createActiveEmployee,
  createChain,
  createUser,
  grantLeaveBalance,
  headersForUserId,
  idem,
  ifMatch,
  leaveTypeIds,
  loginAs,
  uniq,
  uniquePhone,
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

interface PunchBody {
  event?: { id: string };
  record?: { id: string; status: string; work_date: string };
  review?: string;
  code?: string;
  exception_id?: string;
}

async function punch(
  payload: Record<string, unknown>,
  headers: Headers = w.admin,
) {
  return w.app.inject({
    method: "POST",
    url: "/api/v1/attendance/events",
    headers: { ...headers, ...idem() },
    payload: {
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      ...payload,
    },
  });
}

async function decide(
  exceptionId: string,
  decision: "APPROVE" | "REJECT",
  headers: Headers = w.role.HR_MANAGER,
) {
  return w.app.inject({
    method: "PATCH",
    url: `/api/v1/attendance/exceptions/${exceptionId}/decision`,
    headers: { ...headers, ...(await ifMatch(w, "attendance_exceptions", exceptionId)), ...idem() },
    payload: { decision, note: "Checked with the site supervisor" },
  });
}

/** An employee on their own chain, so the attendance history is theirs. */
async function siteWorker(): Promise<{ employeeId: string }> {
  const chain = await createChain(w.app, w.admin, `H${uniq().slice(-4)}`);
  const employeeId = await createActiveEmployee(w.app, w.admin, {
    district_id: chain.district,
    mandal_id: chain.mandal,
    village_id: chain.village,
    site_id: chain.site,
  });
  return { employeeId };
}

/**
 * A punch the server holds back for review.
 *
 * Mock location is the hold that survives the removal of the geo-fence: it
 * is an anti-fraud signal, not a boundary, and it never auto-accepts.
 */
function heldPunch(employeeId: string, over: Record<string, unknown> = {}) {
  return {
    employee_id: employeeId,
    latitude: GEO.atSite.lat,
    longitude: GEO.atSite.lng,
    gps_accuracy: 8,
    mock_location: true,
    ...over,
  };
}

/** An employee with no fence, a CL balance and a login of their own. */
async function worker(openingBalance = 12): Promise<{
  employeeId: string;
  userId: string;
  headers: Headers;
}> {
  const employeeId = await createActiveEmployee(w.app, w.admin, {
    district_id: w.chainA.district,
  });
  await grantLeaveBalance(w.app, w.admin, employeeId, types.CL!, openingBalance);
  const username = `cat_hr_${uniq()}`;
  const userId = await createUser(w.pool, w.orgId, {
    username,
    roles: ["EMPLOYEE"],
    employeeId,
  });
  return { employeeId, userId, headers: await loginAs(w.app, username) };
}

async function fileLeave(headers: Headers, body: Record<string, unknown>) {
  const res = await w.app.inject({
    method: "POST",
    url: "/api/v1/leave/requests",
    headers: { ...headers, ...idem() },
    payload: { leave_type_id: types.CL, reason: "HR gaps fixture", ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

/**
 * Approve through every step of the chain, stopping at the first refusal.
 * Returns the last decision response.
 */
async function approveAll(requestId: string) {
  for (let step = 0; step < 5; step += 1) {
    const cur = await w.pool.query(
      "SELECT status, current_approver_id FROM leave_requests WHERE id = $1",
      [requestId],
    );
    const approver = await headersForUserId(w, cur.rows[0].current_approver_id);
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${requestId}/decision`,
      headers: { ...approver, ...(await ifMatch(w, "leave_requests", requestId)), ...idem() },
      payload: { decision: "APPROVE" },
    });
    if (res.statusCode !== 200) return res;
    if ((res.json() as { status: string }).status !== "PENDING") return res;
  }
  throw new Error("leave chain did not finish");
}

async function recordsOf(employeeId: string) {
  return (
    await w.pool.query(
      `SELECT id, work_date, status, check_in_event_id, check_out_event_id,
              check_in_at
         FROM attendance_records WHERE employee_id = $1 ORDER BY work_date`,
      [employeeId],
    )
  ).rows;
}

// ===========================================================================
// HR-1: an approved exception puts the punch onto the day
// ===========================================================================

describe("HR-1 approving a held-back punch records the attendance", () => {
  it("turns an approved held-back check-in into a record, and the check-out then succeeds", async () => {
    const { employeeId } = await siteWorker();
    const held = await punch(heldPunch(employeeId));
    expect(held.statusCode).toBe(202);
    const heldBody = held.json() as PunchBody;
    expect(heldBody.code).toBe("MOCK_LOCATION");
    expect(await recordsOf(employeeId)).toHaveLength(0);

    const approved = await decide(heldBody.exception_id!, "APPROVE");
    expect(approved.statusCode, approved.body).toBe(200);

    const records = await recordsOf(employeeId);
    expect(records).toHaveLength(1);
    expect(records[0].work_date).toBe(workDate());
    expect(records[0].status).toBe("PARTIAL");
    // The very punch that was held back is the day's check-in.
    const event = await w.pool.query(
      "SELECT attendance_event_id FROM attendance_exceptions WHERE id = $1",
      [heldBody.exception_id],
    );
    expect(records[0].check_in_event_id).toBe(event.rows[0].attendance_event_id);
    expect((approved.json() as { attendance_record_id: string }).attendance_record_id).toBe(
      records[0].id,
    );

    // The day's end, hours later.
    await w.pool.query(
      "UPDATE attendance_events SET client_timestamp = client_timestamp - interval '6 hours' WHERE employee_id = $1",
      [employeeId],
    );
    // Before the fix this was CHECKOUT_WITHOUT_CHECKIN: the day had never opened.
    const out = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      gps_accuracy: 8,
    });
    expect(out.statusCode, out.body).toBe(201);
    expect((out.json() as PunchBody).record!.status).toBe("COMPLETE");
  });

  it("leaves the day empty when the exception is rejected", async () => {
    const { employeeId } = await siteWorker();
    const held = await punch(heldPunch(employeeId));
    const rejected = await decide((held.json() as PunchBody).exception_id!, "REJECT");
    expect(rejected.statusCode).toBe(200);
    expect(await recordsOf(employeeId)).toHaveLength(0);
  });

  it("puts an approved offline replay on the day the phone recorded it", async () => {
    // Thirty hours late: the signal came back on a later day than the punch.
    const employeeId = await createActiveEmployee(w.app, w.admin);
    const madeAt = new Date(Date.now() - 30 * 3600_000);
    const held = await punch({ employee_id: employeeId, client_timestamp: madeAt.toISOString() });
    expect(held.statusCode).toBe(202);
    expect((held.json() as PunchBody).code).toBe("TIMESTAMP_SKEW");

    const approved = await decide((held.json() as PunchBody).exception_id!, "APPROVE");
    expect(approved.statusCode, approved.body).toBe(200);

    const records = await recordsOf(employeeId);
    expect(records).toHaveLength(1);
    expect(records[0].work_date).toBe(workDate(madeAt));
    expect(records[0].work_date).not.toBe(workDate());
    expect(new Date(records[0].check_in_at).getTime()).toBe(madeAt.getTime());
  });

  it("applies the times a regularization claims when it is approved", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin);
    const day = workDate(new Date(Date.now() - 3 * 86_400_000));
    const filed = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/regularize",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employeeId,
        work_date: day,
        claimed_check_in: `${day}T03:30:00.000Z`,
        claimed_check_out: `${day}T12:30:00.000Z`,
        reason: "Phone died on site",
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const exception = filed.json() as { id: string; work_date: string; claimed_check_in: string };
    expect(exception.work_date).toBe(day);
    expect(exception.claimed_check_in).toBe(`${day}T03:30:00.000Z`);

    const approved = await decide(exception.id, "APPROVE");
    expect(approved.statusCode, approved.body).toBe(200);
    const records = await recordsOf(employeeId);
    expect(records).toHaveLength(1);
    expect(records[0].work_date).toBe(day);
    expect(records[0].status).toBe("COMPLETE");
  });
});

// ===========================================================================
// HR-7: nobody decides an exception on their own attendance
// ===========================================================================

describe("HR-7 self-decision covers system-raised exceptions", () => {
  it("refuses a manager approving their own flagged punch, and lets another approver", async () => {
    const { employeeId } = await siteWorker();
    const username = `cat_hr_mgr_${uniq()}`;
    await createUser(w.pool, w.orgId, { username, roles: ["HR_MANAGER"], employeeId });
    const manager = await loginAs(w.app, username);

    const held = await punch(heldPunch(employeeId), manager);
    expect(held.statusCode).toBe(202);
    const exceptionId = (held.json() as PunchBody).exception_id!;
    const row = await w.pool.query("SELECT submitted_by FROM attendance_exceptions WHERE id = $1", [
      exceptionId,
    ]);
    // The case the old guard missed: a system exception has no submitter.
    expect(row.rows[0].submitted_by).toBeNull();

    const own = await decide(exceptionId, "APPROVE", manager);
    expect(own.statusCode).toBe(403);
    expect((own.json() as { code: string }).code).toBe("SELF_DECISION");

    const other = await decide(exceptionId, "APPROVE", w.role.HR_MANAGER);
    expect(other.statusCode, other.body).toBe(200);
  });
});

// ===========================================================================
// HR-6: attendance and approved leave on the same day
// ===========================================================================

describe("HR-6 punches and approved leave", () => {
  it("routes a punch on a day of approved leave to review", async () => {
    const { employeeId, headers } = await worker();
    const leave = await fileLeave(headers, {
      employee_id: employeeId,
      from_date: workDate(),
      to_date: workDate(),
    });
    expect((await approveAll(leave.id)).statusCode).toBe(200);

    const res = await punch({ employee_id: employeeId }, headers);
    expect(res.statusCode).toBe(202);
    const body = res.json() as PunchBody;
    expect(body.code).toBe("ON_APPROVED_LEAVE");
    expect(await recordsOf(employeeId)).toHaveLength(0);

    // Approving it while the leave stands would pay the day twice.
    const approved = await decide(body.exception_id!, "APPROVE");
    expect(approved.statusCode).toBe(422);
    expect((approved.json() as { code: string }).code).toBe("LEAVE_CONFLICT");
  });

  it("refuses to approve leave over a day that was attended since it was filed", async () => {
    const { employeeId, headers } = await worker();
    const leave = await fileLeave(headers, {
      employee_id: employeeId,
      from_date: workDate(),
      to_date: workDate(),
    });
    // Pending leave does not stop a punch; the person came in after all.
    const came = await punch({ employee_id: employeeId }, headers);
    expect(came.statusCode, came.body).toBe(201);

    const res = await approveAll(leave.id);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; conflicting_dates: string[] };
    expect(body.code).toBe("ATTENDANCE_CONFLICT");
    expect(body.conflicting_dates).toEqual([workDate()]);
    const row = await w.pool.query("SELECT status FROM leave_requests WHERE id = $1", [leave.id]);
    expect(row.rows[0].status).toBe("PENDING");
  });
});

// ===========================================================================
// HR-8: two pending requests cannot overdraw a balance
// ===========================================================================

describe("HR-8 balance is re-checked at approval", () => {
  it("refuses the second of two requests that together exceed the balance", async () => {
    const { employeeId, headers } = await worker(3);
    // Next year, well inside one calendar year, so both debit the same row.
    const year = Number(workDate().slice(0, 4)) + 1;
    const first = await fileLeave(headers, {
      employee_id: employeeId,
      from_date: `${year}-03-02`,
      to_date: `${year}-03-03`,
    });
    const second = await fileLeave(headers, {
      employee_id: employeeId,
      from_date: `${year}-03-09`,
      to_date: `${year}-03-10`,
    });

    const a = await approveAll(first.id);
    expect(a.statusCode, a.body).toBe(200);
    expect((a.json() as { status: string }).status).toBe("APPROVED");

    const b = await approveAll(second.id);
    expect(b.statusCode).toBe(422);
    expect((b.json() as { code: string }).code).toBe("INSUFFICIENT_BALANCE");

    const balance = await w.pool.query(
      `SELECT opening_balance + credits - consumed + adjustments AS available
         FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND period_year = $3`,
      [employeeId, types.CL, year],
    );
    expect(Number(balance.rows[0].available)).toBe(1);
  });
});

// ===========================================================================
// HR-5: a punch without a position
// ===========================================================================

describe("HR-5 a punch is accepted with or without a position", () => {
  // HR-5 used to pin the opposite: a fenced employee could not get past the
  // fence by switching location off. There is no fence any more (decision
  // 2026-09-22), so the rule it pins now is that the two kinds of punch are
  // treated alike, and a position, when sent, is kept.
  it("accepts a coordinate-less punch and opens the day", async () => {
    const { employeeId } = await siteWorker();
    const res = await punch({ employee_id: employeeId });
    expect(res.statusCode, res.body).toBe(201);
    expect(await recordsOf(employeeId)).toHaveLength(1);
  });

  it("accepts a positioned punch the same way, and stores the position", async () => {
    const { employeeId } = await siteWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      gps_accuracy: 8,
    });
    expect(res.statusCode, res.body).toBe(201);
    const event = await w.pool.query(
      "SELECT lat, lng, gps_accuracy FROM attendance_events WHERE id = $1",
      [(res.json() as PunchBody).event!.id],
    );
    expect(Number(event.rows[0].lat)).toBeCloseTo(GEO.atSite.lat, 5);
    expect(Number(event.rows[0].gps_accuracy)).toBe(8);
  });
});

// ===========================================================================
// HR-14: exiting an employee offboards them
// ===========================================================================

describe("HR-14 exit disables the login, withdraws leave and flags open tasks", () => {
  it("does all of it in the exit itself", async () => {
    const { employeeId, userId, headers } = await worker();
    const leave = await fileLeave(headers, {
      employee_id: employeeId,
      from_date: `${Number(workDate().slice(0, 4)) + 1}-04-06`,
      to_date: `${Number(workDate().slice(0, 4)) + 1}-04-06`,
    });
    const task = await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, assignee_id, created_by)
       VALUES ($1, $2, 'Open task', 'IN_PROGRESS', $3, $4) RETURNING id`,
      [w.orgId, w.activeProject, userId, w.adminId],
    );
    const doneTask = await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, assignee_id, created_by)
       VALUES ($1, $2, 'Finished task', 'DONE', $3, $4) RETURNING id`,
      [w.orgId, w.activeProject, userId, w.adminId],
    );

    const exit = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate(), reason: "Resigned" },
    });
    expect(exit.statusCode, exit.body).toBe(200);

    const user = await w.pool.query("SELECT auth_status FROM users WHERE id = $1", [userId]);
    expect(user.rows[0].auth_status).toBe("DISABLED");
    // A token issued before the exit no longer works.
    const me = await w.app.inject({ method: "GET", url: "/api/v1/employees/me", headers });
    expect(me.statusCode).toBe(401);
    const live = await w.pool.query(
      "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked = false",
      [userId],
    );
    expect(live.rows[0].n).toBe(0);

    const request = await w.pool.query("SELECT status FROM leave_requests WHERE id = $1", [leave.id]);
    expect(request.rows[0].status).toBe("CANCELLED");

    // Open work stays attributable (UT-WORK-06) and is flagged for the
    // project manager on the task's own trail; finished work is left alone.
    const open = await w.pool.query("SELECT assignee_id FROM tasks WHERE id = $1", [task.rows[0].id]);
    expect(open.rows[0].assignee_id).toBe(userId);
    const audit = await w.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'task.assignee_exited' AND entity_id = $1",
      [task.rows[0].id],
    );
    const doneAudit = await w.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'task.assignee_exited' AND entity_id = $1",
      [doneTask.rows[0].id],
    );
    expect(doneAudit.rows[0].n).toBe(0);
    expect(audit.rows[0].n).toBe(1);
  });

  it("refuses to roster or allocate somebody who has exited", async () => {
    const shift = await w.app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { ...w.role.HR_MANAGER, ...idem() },
      payload: {
        code: uniq("HX"), name: "Day", starts_at: "09:00", ends_at: "18:00",
        effective_from: "2026-09-01",
      },
    });
    expect(shift.statusCode, shift.body).toBe(201);
    const shiftId = (shift.json() as { data: { id: string } }).data.id;

    const bulk = await w.app.inject({
      method: "POST",
      url: "/api/v1/roster/bulk",
      headers: { ...w.role.HR_MANAGER, ...idem() },
      payload: {
        shift_id: shiftId, starts_on: "2026-10-05", ends_on: "2026-10-06",
        employee_ids: [w.siteEmployee, w.exitedEmployee],
      },
    });
    expect(bulk.statusCode).toBe(422);
    expect((bulk.json() as { code: string }).code).toBe("EMPLOYEE_EXITED");
    // All or nothing: the active employee was not rostered either.
    const rows = await w.pool.query(
      "SELECT count(*)::int AS n FROM roster_entries WHERE shift_id = $1",
      [shiftId],
    );
    expect(rows.rows[0].n).toBe(0);

    const allocation = await w.app.inject({
      method: "POST",
      url: "/api/v1/allocations",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: w.exitedEmployee, project_id: w.activeProject, percentage: 50,
        starts_on: "2026-10-05", ends_on: "2026-10-30",
      },
    });
    expect(allocation.statusCode).toBe(422);
    expect((allocation.json() as { code: string }).code).toBe("EMPLOYEE_EXITED");
  });
});

// ===========================================================================
// HR-15: the directory never carries full identity numbers
// ===========================================================================

describe("HR-15 PII on the employee list and detail", () => {
  it("masks the list even for pii.read, and audits the unmasked detail", async () => {
    const aadhaar = `9${String(Date.now()).slice(-11)}`;
    const create = await w.app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { ...w.admin, ...idem() },
      payload: {
        emp_no: `E${uniq().toUpperCase().slice(-8)}`,
        first_name: "Masked",
        last_name: "Person",
        phone: uniquePhone(),
        date_of_joining: "2024-01-15",
        aadhaar,
      },
    });
    expect(create.statusCode, create.body).toBe(201);
    const id = (create.json() as { id: string }).id;

    const list = await w.app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100&q=Masked",
      headers: w.role.HR_MANAGER,
    });
    const found = (list.json() as { data: Array<Record<string, unknown>> }).data.find(
      (e) => e.id === id,
    );
    expect(found).toBeTruthy();
    expect(found!.aadhaar).toBeNull();
    expect(String(found!.aadhaar_last4)).toMatch(new RegExp(`${aadhaar.slice(-4)}$`));
    expect(list.body).not.toContain(aadhaar);

    const detail = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${id}`,
      headers: w.role.HR_MANAGER,
    });
    expect((detail.json() as { aadhaar: string }).aadhaar).toBe(aadhaar);
    const audit = await w.pool.query(
      `SELECT after_state FROM audit_events
        WHERE action = 'employee.pii.read' AND entity_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].after_state.fields).toContain("aadhaar");
    expect(JSON.stringify(audit.rows[0].after_state)).not.toContain(aadhaar);
  });
});

// ===========================================================================
// HR-12: a holiday can be corrected or withdrawn
// ===========================================================================

describe("HR-12 holiday correction", () => {
  it("withdraws a holiday with a reason, audits it, and frees its date", async () => {
    const date = `${Number(workDate().slice(0, 4)) + 1}-08-${String(10 + (Date.now() % 15)).padStart(2, "0")}`;
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: { ...w.admin, ...idem() },
      payload: { date, name: "Wrong day", type: "manual" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;

    const noReason = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: { ...w.admin, ...idem() },
      payload: { active: false },
    });
    expect(noReason.statusCode).toBe(422);

    const withdrawn = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: { ...w.admin, ...idem() },
      payload: { active: false, reason: "Entered on the wrong date" },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect((withdrawn.json() as { active: boolean }).active).toBe(false);

    const year = date.slice(0, 4);
    const list = await w.app.inject({
      method: "GET",
      url: `/api/v1/holidays?year=${year}&limit=100`,
      headers: w.admin,
    });
    expect(list.body).not.toContain(id);

    const audit = await w.pool.query(
      "SELECT reason FROM audit_events WHERE action = 'holiday.deactivate' AND entity_id = $1",
      [id],
    );
    expect(audit.rows[0].reason).toBe("Entered on the wrong date");

    // The row stays, and the date is free for the right entry.
    const again = await w.app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: { ...w.admin, ...idem() },
      payload: { date, name: "Right holiday", type: "manual" },
    });
    expect(again.statusCode, again.body).toBe(201);
    const kept = await w.pool.query("SELECT active FROM holidays WHERE id = $1", [id]);
    expect(kept.rows[0].active).toBe(false);
  });
});

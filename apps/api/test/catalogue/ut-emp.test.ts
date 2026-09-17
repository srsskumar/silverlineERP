/**
 * Catalogue: Employee lifecycle (UT-EMP-01..08).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activate,
  buildWorld,
  createActiveEmployee,
  createEmployee,
  idem,
  ifMatch,
  uniq,
  uniquePhone,
  workDate,
  type CatalogueWorld,
  type Headers,
} from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

interface FieldError {
  field: string;
  message: string;
}

interface ErrorBody {
  code: string;
  message: string;
  field_errors?: FieldError[];
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    emp_no: `E${uniq().toUpperCase().slice(-8)}`,
    first_name: "Lifecycle",
    last_name: "Subject",
    phone: uniquePhone(),
    date_of_joining: "2024-01-15",
    ...over,
  };
}

async function createRaw(body: Record<string, unknown>, headers: Headers = w.admin) {
  return w.app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers: { ...headers, ...idem() },
    payload: body,
  });
}

describe("UT-EMP-01 validate duplicate employee number, Aadhaar, phone, PhonePe and account", () => {
  /** Each duplicate is probed against its own freshly created original. */
  const cases: Array<{ field: string; build: () => Record<string, unknown> }> = [
    { field: "emp_no", build: () => ({ emp_no: `DUP${uniq().toUpperCase().slice(-6)}` }) },
    { field: "phone", build: () => ({ phone: uniquePhone() }) },
    { field: "aadhaar", build: () => ({ aadhaar: String(2_000_000_000_00 + Math.floor(Math.random() * 1e9)) }) },
    { field: "pan", build: () => ({ pan: `AAAAA${String(1000 + Math.floor(Math.random() * 8999))}Z` }) },
    { field: "phonepe_number", build: () => ({ phonepe_number: uniquePhone() }) },
    { field: "bank_account", build: () => ({ bank_account: String(Date.now()) + String(Math.floor(Math.random() * 1000)) }) },
  ];

  for (const { field, build } of cases) {
    it(`maps a duplicate ${field} to its own field error`, async () => {
      const shared = build();
      const first = await createRaw(payload(shared));
      expect(first.statusCode, `first ${field} insert`).toBe(201);

      // Everything else about the second row is distinct, so the only possible
      // collision is the field under test.
      const second = await createRaw(payload(shared));
      expect(second.statusCode).toBe(409);
      const body = second.json() as ErrorBody;
      expect(body.code).toBe("CONFLICT");
      expect(body.field_errors?.map((e) => e.field)).toEqual([field]);
      expect(body.field_errors?.[0]?.message).toMatch(/already exists/i);
    });
  }

  it("treats a differently formatted Aadhaar as the same value", async () => {
    const aadhaar = "411122223333";
    expect((await createRaw(payload({ aadhaar }))).statusCode).toBe(201);

    // Spacing is presentation, not identity — a spaced Aadhaar is a duplicate.
    const spaced = await createRaw(payload({ aadhaar: "4111 2222 3333" }));
    expect(spaced.statusCode).toBe(409);
    expect((spaced.json() as ErrorBody).field_errors?.[0]?.field).toBe("aadhaar");
  });

  it("keeps duplicate detection inside the tenant", async () => {
    const aadhaar = "511122223333";
    expect((await createRaw(payload({ aadhaar }))).statusCode).toBe(201);

    // The same Aadhaar in a different organization is a different person's
    // record as far as this tenant is concerned, and must not collide.
    const other = await createRaw(payload({ aadhaar }), w.other.admin);
    expect(other.statusCode).toBe(201);
  });

  it("never returns the offending value in the error", async () => {
    const aadhaar = "611122223333";
    await createRaw(payload({ aadhaar }));
    const second = await createRaw(payload({ aadhaar }));
    expect(second.body).not.toContain(aadhaar);
  });
});

describe("UT-EMP-02 validate reporting manager", () => {
  it("accepts an active manager in the same organization", async () => {
    const manager = await createActiveEmployee(w.app, w.admin);
    const res = await createRaw(payload({ reports_to: manager }));
    expect(res.statusCode).toBe(201);
    expect((res.json() as { reports_to: string }).reports_to).toBe(manager);
  });

  it("rejects a manager who is not active", async () => {
    const draft = await createEmployee(w.app, w.admin); // still DRAFT
    const res = await createRaw(payload({ reports_to: draft }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.[0]?.field).toBe("reports_to");
  });

  it("rejects a manager from another organization", async () => {
    const res = await createRaw(payload({ reports_to: w.other.employee }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.[0]?.field).toBe("reports_to");
  });

  it("rejects an employee reporting to themselves", async () => {
    const employee = await createActiveEmployee(w.app, w.admin);
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee}`,
      headers: {
        ...w.admin,
        ...(await ifMatch(w, "employees", employee)),
        ...idem(),
      },
      payload: { reports_to: employee },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.[0]?.field).toBe("reports_to");
  });

  it("rejects a reporting cycle", async () => {
    // a → b → c, then asking a to report to c would close the loop.
    const a = await createActiveEmployee(w.app, w.admin);
    const b = await createActiveEmployee(w.app, w.admin, { reports_to: a });
    const c = await createActiveEmployee(w.app, w.admin, { reports_to: b });

    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${a}`,
      headers: { ...w.admin, ...(await ifMatch(w, "employees", a)), ...idem() },
      payload: { reports_to: c },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.[0]?.field).toBe("reports_to");

    // The graph is unchanged: a still reports to nobody.
    const after = await w.pool.query("SELECT reports_to FROM employees WHERE id = $1", [a]);
    expect(after.rows[0].reports_to).toBeNull();
  });
});

describe("UT-EMP-03 exit an active employee with and without reason/date", () => {
  it("rejects an exit with no reason", async () => {
    const employee = await createActiveEmployee(w.app, w.admin);
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate() },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.map((e) => e.field)).toContain("reason");
  });

  it("rejects an exit with no date", async () => {
    const employee = await createActiveEmployee(w.app, w.admin);
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { reason: "Resigned" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.map((e) => e.field)).toContain("exit_date");
  });

  it("rejects an exit date before the joining date", async () => {
    const employee = await createActiveEmployee(w.app, w.admin, {
      date_of_joining: "2024-06-01",
    });
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: "2024-05-31", reason: "Resigned" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.[0]?.field).toBe("exit_date");
  });

  it("records the reason and the acting user on a valid exit", async () => {
    const employee = await createActiveEmployee(w.app, w.admin);
    const reason = "Resigned to join another firm";
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate(), reason },
    });
    expect(res.statusCode).toBe(200);

    const row = await w.pool.query(
      "SELECT status, exit_reason, date_of_exit, exit_approved_by FROM employees WHERE id = $1",
      [employee],
    );
    expect(row.rows[0].status).toBe("EXITED");
    expect(row.rows[0].exit_reason).toBe(reason);
    expect(String(row.rows[0].date_of_exit).slice(0, 10)).toBe(workDate());
    expect(row.rows[0].exit_approved_by).toBe(w.adminId);

    const audit = await w.pool.query(
      "SELECT action, actor_id, reason FROM audit_events WHERE entity_id = $1 AND action = 'employee.exit'",
      [employee],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(w.adminId);
    expect(audit.rows[0].reason).toBe(reason);
  });

  it("refuses to exit an already exited employee", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${w.exitedEmployee}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate(), reason: "again" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("UT-EMP-04 check eligibility after exit", () => {
  it("denies attendance, new task assignment and new asset assignment", async () => {
    const employee = w.exitedEmployee;

    // 1. Attendance (BR-01).
    const punch = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employee,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
      },
    });
    expect(punch.statusCode).toBe(422);
    expect((punch.json() as ErrorBody).code).toBe("EMPLOYEE_INACTIVE");

    // 2. Asset assignment (BR-03).
    const asset = await w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${w.assetId}/assign`,
      headers: {
        ...w.role.INVENTORY_MANAGER,
        ...(await ifMatch(w, "assets", w.assetId)),
        ...idem(),
      },
      payload: { employee_id: employee, condition: "GOOD", reason: "field work" },
    });
    expect(asset.statusCode).toBeGreaterThanOrEqual(400);
    const assignments = await w.pool.query(
      "SELECT 1 FROM asset_assignments WHERE employee_id = $1 AND returned_at IS NULL",
      [employee],
    );
    expect(assignments.rowCount).toBe(0);

    // 3. Task assignment (BR-12). Tasks are assigned to *users*, so the check
    //    runs through the exited employee's linked login.
    const exitedUsername = `cat_exited_user_${uniq()}`;
    const exitedUserId = await w.pool.query(
      `INSERT INTO users (org_id, username, password_hash, auth_status, employee_id)
       VALUES ($1, $2, 'x', 'ACTIVE', $3) RETURNING id`,
      [w.orgId, exitedUsername, employee],
    );
    const task = await w.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...w.admin, ...idem() },
      payload: {
        project_id: w.activeProject,
        title: "Task for an exited employee",
        assignee_id: exitedUserId.rows[0].id,
      },
    });
    expect(task.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("leaves the exited employee's history intact", async () => {
    const row = await w.pool.query(
      "SELECT emp_no, date_of_joining, exit_reason FROM employees WHERE id = $1",
      [w.exitedEmployee],
    );
    expect(row.rows[0].emp_no).toBeTruthy();
    expect(row.rows[0].date_of_joining).toBeTruthy();
    expect(row.rows[0].exit_reason).toBeTruthy();
  });
});

describe("UT-EMP-05 reactivate an exited employee", () => {
  it("requires an authorized action and a reason", async () => {
    const employee = await createActiveEmployee(w.app, w.admin);
    await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate(), reason: "Seasonal end" },
    });

    // No reason.
    const noReason = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/reactivate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(noReason.statusCode).toBe(422);
    expect((noReason.json() as ErrorBody).field_errors?.[0]?.field).toBe("reason");

    // No authority: AUDITOR can read employees but not change their status.
    const unauthorized = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/reactivate`,
      headers: { ...w.role.AUDITOR, ...idem() },
      payload: { reason: "Returning for the next season" },
    });
    expect(unauthorized.statusCode).toBe(403);

    const stillExited = await w.pool.query("SELECT status FROM employees WHERE id = $1", [
      employee,
    ]);
    expect(stillExited.rows[0].status).toBe("EXITED");
  });

  it("preserves history and clears the exit fields on success", async () => {
    const employee = await createActiveEmployee(w.app, w.admin);
    await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate(), reason: "Seasonal end" },
    });

    const reason = "Rehired for the new season";
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee}/reactivate`,
      headers: { ...w.admin, ...idem() },
      payload: { reason },
    });
    expect(res.statusCode).toBe(200);

    const row = await w.pool.query(
      "SELECT status, date_of_exit, exit_reason FROM employees WHERE id = $1",
      [employee],
    );
    expect(row.rows[0].status).toBe("ACTIVE");
    expect(row.rows[0].date_of_exit).toBeNull();
    expect(row.rows[0].exit_reason).toBeNull();

    // The exit itself is still in the audit trail — clearing the columns must
    // not erase the fact that it happened.
    const audit = await w.pool.query(
      "SELECT action, reason FROM audit_events WHERE entity_id = $1 ORDER BY created_at",
      [employee],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain("employee.exit");
    expect(actions).toContain("employee.reactivate");
    expect(audit.rows.map((r) => r.reason)).toContain(reason);
  });

  it("refuses to reactivate an employee who is already active", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${w.directEmployee}/reactivate`,
      headers: { ...w.admin, ...idem() },
      payload: { reason: "no-op" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("UT-EMP-06 import mixed valid and invalid employee rows", () => {
  function importRows(rows: Array<Record<string, unknown>>, dryRun = false) {
    return w.app.inject({
      method: "POST",
      url: "/api/v1/employees/bulk-import",
      headers: { ...w.admin, ...idem() },
      payload: { rows, dry_run: dryRun },
    });
  }

  it("commits only the valid rows and reports stable per-row errors", async () => {
    const good = payload();
    const bad = payload({ phone: "not-a-phone" });
    const alsoGood = payload();

    const res = await importRows([good, bad, alsoGood]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      imported: number;
      rows: Array<{ index: number; status: string; errors: FieldError[] }>;
    };
    expect(body.imported).toBe(2);
    expect(body.rows[0]!.status).toBe("IMPORTED");
    expect(body.rows[1]!.status).toBe("REJECTED");
    expect(body.rows[1]!.errors.map((e) => e.field)).toContain("phone");
    expect(body.rows[2]!.status).toBe("IMPORTED");

    // Exactly the two valid rows landed.
    const rows = await w.pool.query(
      "SELECT emp_no FROM employees WHERE emp_no = ANY($1::text[])",
      [[good.emp_no, bad.emp_no, alsoGood.emp_no]],
    );
    expect(rows.rows.map((r) => r.emp_no).sort()).toEqual(
      [good.emp_no, alsoGood.emp_no].sort(),
    );
  });

  it("classifies a duplicate row as DUPLICATE and names the colliding field", async () => {
    const existing = payload({ aadhaar: "711122223333" });
    expect((await createRaw(existing)).statusCode).toBe(201);

    const res = await importRows([payload({ aadhaar: "711122223333" })]);
    const body = res.json() as {
      imported: number;
      rows: Array<{ status: string; errors: FieldError[] }>;
    };
    expect(body.imported).toBe(0);
    expect(body.rows[0]!.status).toBe("DUPLICATE");
    expect(body.rows[0]!.errors[0]!.field).toBe("aadhaar");
  });

  it("commits nothing in dry-run mode while still reporting every row", async () => {
    const good = payload();
    const bad = payload({ date_of_joining: "not-a-date" });

    const res = await importRows([good, bad], true);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dry_run: boolean;
      imported: number;
      rows: Array<{ status: string }>;
    };
    expect(body.dry_run).toBe(true);
    expect(body.imported).toBe(0);
    expect(body.rows[0]!.status).toBe("VALIDATED");
    expect(body.rows[1]!.status).toBe("REJECTED");

    const rows = await w.pool.query("SELECT 1 FROM employees WHERE emp_no = $1", [
      good.emp_no,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("UT-EMP-07 update sensitive fields", () => {
  it("changes the ciphertext, keeps output masked and protects the audit values", async () => {
    const employee = await createActiveEmployee(w.app, w.admin, {
      aadhaar: "811122223333",
      bank_account: "1111222233",
    });
    const before = await w.pool.query(
      "SELECT aadhaar_encrypted, aadhaar_hash FROM employees WHERE id = $1",
      [employee],
    );

    const newAadhaar = "811144445555";
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee}`,
      headers: { ...w.admin, ...(await ifMatch(w, "employees", employee)), ...idem() },
      payload: { aadhaar: newAadhaar },
    });
    expect(res.statusCode).toBe(200);

    const after = await w.pool.query(
      "SELECT aadhaar_encrypted, aadhaar_hash FROM employees WHERE id = $1",
      [employee],
    );
    expect(after.rows[0].aadhaar_encrypted).not.toBe(before.rows[0].aadhaar_encrypted);
    expect(after.rows[0].aadhaar_encrypted).toMatch(/^gcm1\./);
    expect(after.rows[0].aadhaar_encrypted).not.toContain(newAadhaar);
    // The blind index moves with the value, or the old value would keep
    // reserving uniqueness while the new one went undetected.
    expect(after.rows[0].aadhaar_hash).not.toBe(before.rows[0].aadhaar_hash);

    // Output to a non-PII reader stays masked, and shows the *new* last four.
    const masked = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${employee}`,
      headers: w.role.AUDITOR,
    });
    const body = masked.json() as Record<string, unknown>;
    expect(body.aadhaar).toBeNull();
    expect(body.aadhaar_last4).toBe("••••5555");

    const audit = await w.pool.query(
      "SELECT before_state, after_state FROM audit_events WHERE entity_id = $1 AND action = 'employee.update'",
      [employee],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain(newAadhaar);
    expect(serialized).not.toContain("811122223333");
    expect(serialized).toContain("[REDACTED]");
  });

  it("still rejects a sensitive update that would duplicate another employee", async () => {
    const first = await createActiveEmployee(w.app, w.admin, { aadhaar: "911122223333" });
    const second = await createActiveEmployee(w.app, w.admin, { aadhaar: "911144445555" });
    void first;

    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${second}`,
      headers: { ...w.admin, ...(await ifMatch(w, "employees", second)), ...idem() },
      payload: { aadhaar: "911122223333" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // The row is untouched: its own Aadhaar still resolves to its own last four.
    const check = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${second}`,
      headers: w.admin,
    });
    expect((check.json() as { aadhaar: string }).aadhaar).toBe("911144445555");
  });
});

describe("UT-EMP-08 assign site references from another organization or wrong unit type", () => {
  it("rejects a site reference belonging to another organization", async () => {
    const res = await createRaw(payload({ site_id: w.other.site }));
    expect(res.statusCode).toBe(422);
    const fields = (res.json() as ErrorBody).field_errors?.map((e) => e.field);
    expect(fields).toContain("site_id");
  });

  it("rejects a district reference belonging to another organization", async () => {
    const res = await createRaw(payload({ district_id: w.other.district }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.map((e) => e.field)).toContain(
      "district_id",
    );
  });

  it("rejects a unit of the wrong type in each slot", async () => {
    // A village id in the site slot, and a site id in the district slot.
    const res = await createRaw(
      payload({ site_id: w.chainA.village, district_id: w.chainA.site }),
    );
    expect(res.statusCode).toBe(422);
    const errors = (res.json() as ErrorBody).field_errors ?? [];
    const byField = new Map(errors.map((e) => [e.field, e.message]));
    expect(byField.get("site_id")).toMatch(/site/i);
    expect(byField.get("district_id")).toMatch(/district/i);
  });

  it("rejects the same cross-tenant reference on update, not only on create", async () => {
    const employee = await createActiveEmployee(w.app, w.admin);
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee}`,
      headers: { ...w.admin, ...(await ifMatch(w, "employees", employee)), ...idem() },
      payload: { site_id: w.other.site },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).field_errors?.map((e) => e.field)).toContain("site_id");
  });

  it("accepts a correctly typed reference from the caller's own organization", async () => {
    const res = await createRaw(
      payload({
        district_id: w.chainA.district,
        mandal_id: w.chainA.mandal,
        village_id: w.chainA.village,
        site_id: w.chainA.site,
      }),
    );
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    await activate(w.app, w.admin, id);
  });
});

/**
 * The employee number the server allocates (enhancement note 3).
 *
 * Nobody filling in two hundred rows should be inventing unique identifiers,
 * and the ones people invent collide.
 */
describe("allocating employee numbers", () => {
  it("issues the next number when the caller leaves it out", async () => {
    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM employees WHERE org_id = $1", [w.orgId]);
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/employees",
      headers: { ...w.admin, ...idem() },
      payload: {
        first_name: "Unnumbered", phone: uniquePhone(),
        date_of_joining: "2026-01-01",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().emp_no, "a number was allocated").toBeTruthy();
    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM employees WHERE org_id = $1", [w.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it("counts upward rather than reusing a number", async () => {
    const make = async () => {
      const r = await w.app.inject({
        method: "POST", url: "/api/v1/employees",
        headers: { ...w.admin, ...idem() },
        payload: {
          first_name: "Sequential", phone: uniquePhone(),
          date_of_joining: "2026-01-01",
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      return String(r.json().emp_no);
    };
    const first = await make();
    const second = await make();
    expect(second).not.toBe(first);
    const digits = (s: string) => Number(s.replace(/^[A-Za-z]*/, ""));
    expect(digits(second)).toBe(digits(first) + 1);
    // And it keeps the shape the organisation already uses.
    expect(second.replace(/[0-9]+$/, "")).toBe(first.replace(/[0-9]+$/, ""));
  });

  it("still accepts a number that is given", async () => {
    // An organisation migrating from another system has numbers printed on
    // ID cards, and renumbering everybody to suit us is not a migration
    // anybody would agree to.
    const mine = `MIG${Date.now().toString().slice(-7)}`;
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/employees",
      headers: { ...w.admin, ...idem() },
      payload: {
        emp_no: mine, first_name: "Migrated", phone: uniquePhone(),
        date_of_joining: "2026-01-01",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().emp_no).toBe(mine);
  });

  it("allocates a number for every row of an import that omits one", async () => {
    const rows = [1, 2, 3].map((n) => ({
      first_name: `Bulk ${n}`, phone: uniquePhone(), date_of_joining: "2026-01-01",
    }));
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/employees/bulk-import",
      headers: { ...w.admin, ...idem() },
      payload: { rows, dry_run: false },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().imported, "all three rows written").toBe(3);

    const numbers = await w.pool.query(
      "SELECT emp_no FROM employees WHERE first_name LIKE 'Bulk %' AND org_id = $1", [w.orgId]);
    expect(numbers.rowCount).toBe(3);
    // Three rows, three distinct numbers — the collision this replaces.
    expect(new Set(numbers.rows.map((x) => x.emp_no)).size).toBe(3);
  });
});

/** A phone nobody else in the fixture is using. */
function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0");
  return `+919${n}`;
}

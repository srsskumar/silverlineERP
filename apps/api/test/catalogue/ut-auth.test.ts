/**
 * Catalogue: Authentication, authorization and privacy (UT-AUTH-01..08).
 *
 * Each `describe` is named for its catalogue row so the traceability report
 * (scripts/catalogue-coverage.mjs) can match tests to the specification.
 */

import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "../../src/database/seed.js";
import { JWT_SECRET } from "./fixture.js";
import { encryptPii } from "../../src/common/crypto.js";
import { resolveScopes } from "../../src/common/scopes.js";
import {
  buildWorld,
  createActiveEmployee,
  createUser,
  grantLeaveBalance,
  headersForUserId,
  idem,
  ifMatch,
  loginAs,
  uniq,
  workDate,
  type CatalogueWorld,
} from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

async function login(payload: Record<string, unknown>) {
  return w.app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
}

describe("UT-AUTH-01 validate login input with blank username or password", () => {
  it("returns field-level validation errors for both blanks", async () => {
    const res = await login({ username: "", password: "" });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      code: string;
      field_errors: Array<{ field: string; message: string }>;
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    const fields = body.field_errors.map((e) => e.field).sort();
    expect(fields).toEqual(["password", "username"]);
  });

  it("does not attempt authentication — no failed-attempt is recorded", async () => {
    const username = `cat_blankpw_${uniq()}`;
    const userId = await createUser(w.pool, w.orgId, { username });

    const res = await login({ username, password: "" });
    expect(res.statusCode).toBe(422);

    // A validation rejection must not count against the lockout counter, or a
    // malformed client could lock a real account out.
    const row = await w.pool.query(
      "SELECT failed_login_attempts, last_login_at FROM users WHERE id = $1",
      [userId],
    );
    expect(row.rows[0].failed_login_attempts).toBe(0);
    expect(row.rows[0].last_login_at).toBeNull();
  });
});

describe("UT-AUTH-02 verify a correct and incorrect password", () => {
  it("accepts the correct password", async () => {
    const res = await login({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { access_token: string }).access_token).toBeTruthy();
  });

  it("reveals no account detail on an incorrect password", async () => {
    const username = `cat_badpw_${uniq()}`;
    await createUser(w.pool, w.orgId, { username });

    const wrong = await login({ username, password: "NotThePassword!" });
    const missing = await login({ username: `cat_ghost_${uniq()}`, password: "NotThePassword!" });

    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    // A known-but-wrong password and an unknown account must be
    // indistinguishable, otherwise login doubles as a username oracle.
    const wrongBody = wrong.json() as { code: string; message: string };
    const missingBody = missing.json() as { code: string; message: string };
    expect(wrongBody.code).toBe("INVALID_CREDENTIALS");
    expect(wrongBody.code).toBe(missingBody.code);
    expect(wrongBody.message).toBe(missingBody.message);
    expect(wrongBody.message).not.toMatch(new RegExp(username, "i"));
  });

  it("gives a suspended account the same answer as a wrong password", async () => {
    const username = `cat_suspended_${uniq()}`;
    await createUser(w.pool, w.orgId, { username });
    await w.pool.query("UPDATE users SET auth_status = 'SUSPENDED' WHERE username = $1", [
      username,
    ]);

    const res = await login({ username, password: "Pass1234!" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe("INVALID_CREDENTIALS");
  });
});

describe("UT-AUTH-03 verify TOTP at current, previous and next allowed window", () => {
  /** Enrols MFA directly so the test owns the secret. */
  async function enrol(): Promise<{ username: string; secret: string }> {
    const username = `cat_mfa_${uniq()}`;
    await createUser(w.pool, w.orgId, { username });
    const secret = authenticator.generateSecret();
    await w.pool.query(
      "UPDATE users SET mfa_enabled = true, mfa_secret = $2, mfa_last_counter = NULL WHERE username = $1",
      [username, encryptPii(secret)],
    );
    return { username, secret };
  }

  it("asks for a code before granting a session", async () => {
    const { username } = await enrol();
    const res = await login({ username, password: "Pass1234!" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mfa_required: boolean; access_token?: string };
    expect(body.mfa_required).toBe(true);
    expect(body.access_token).toBeUndefined();
  });

  it("accepts the current window only, rejecting previous and next", async () => {
    const { username, secret } = await enrol();
    const step = 30_000;
    const now = Date.now();

    const current = authenticator.generate(secret);
    const previous = generateAt(secret, now - step);
    const next = generateAt(secret, now + step);

    // The configured skew window is zero steps: only the code minted for the
    // current step is accepted. Both neighbours are rejected, and (because a
    // neighbouring code is indistinguishable from a guess) with the same code.
    for (const [label, code] of [
      ["previous", previous],
      ["next", next],
    ] as const) {
      if (code === current) continue; // step boundary raced us; nothing to assert
      const res = await login({ username, password: "Pass1234!", totp_code: code });
      expect(res.statusCode, `${label} window should be rejected`).toBe(401);
      expect((res.json() as { code: string }).code).toBe("INVALID_MFA_CODE");
    }

    const accepted = await login({ username, password: "Pass1234!", totp_code: current });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { access_token: string }).access_token).toBeTruthy();
  });

  it("enforces the replay policy — a spent code cannot be presented twice", async () => {
    const { username, secret } = await enrol();
    const code = authenticator.generate(secret);

    const first = await login({ username, password: "Pass1234!", totp_code: code });
    expect(first.statusCode).toBe(200);

    // Same code, same 30-second step. Without a spent-counter this would
    // succeed, which is exactly the replay §14.1 forbids.
    const replay = await login({ username, password: "Pass1234!", totp_code: code });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { code: string }).code).toBe("INVALID_MFA_CODE");
  });

  it("records the spent counter so replay survives a restart", async () => {
    const { username, secret } = await enrol();
    await login({ username, password: "Pass1234!", totp_code: authenticator.generate(secret) });
    const row = await w.pool.query(
      "SELECT mfa_last_counter FROM users WHERE username = $1",
      [username],
    );
    // Durable state, not in-process memory: a second API instance rejects the
    // replay too.
    expect(Number(row.rows[0].mfa_last_counter)).toBe(
      Math.floor(Date.now() / 1000 / 30),
    );
  });
});

/** Mints the code for the step containing `at`, without disturbing global options. */
function generateAt(secret: string, at: number): string {
  return authenticator.clone({ epoch: at }).generate(secret);
}

describe("UT-AUTH-04 apply repeated-login lock or challenge policy", () => {
  it("locks deterministically on the fifth consecutive failure", async () => {
    const username = `cat_lock_${uniq()}`;
    await createUser(w.pool, w.orgId, { username });

    const codes: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await login({ username, password: "wrong-password" });
      codes.push(res.statusCode);
    }
    // Four rejections, then the threshold trips on the fifth.
    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes[4]).toBe(423);

    // And the correct password no longer helps while the lock stands.
    const locked = await login({ username, password: "Pass1234!" });
    expect(locked.statusCode).toBe(423);
    expect((locked.json() as { code: string }).code).toBe("ACCOUNT_LOCKED");
  });

  it("restores eligibility when the lock expires", async () => {
    const username = `cat_lockexpiry_${uniq()}`;
    await createUser(w.pool, w.orgId, { username });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login({ username, password: "wrong-password" });
    }
    expect((await login({ username, password: "Pass1234!" })).statusCode).toBe(423);

    // Expiry is the only thing that clears it — no separate unlock step.
    await w.pool.query(
      "UPDATE users SET locked_until = NOW() - INTERVAL '1 second' WHERE username = $1",
      [username],
    );
    const after = await login({ username, password: "Pass1234!" });
    expect(after.statusCode).toBe(200);

    const row = await w.pool.query(
      "SELECT failed_login_attempts, locked_until FROM users WHERE username = $1",
      [username],
    );
    expect(row.rows[0].failed_login_attempts).toBe(0);
    expect(row.rows[0].locked_until).toBeNull();
  });

  it("resets the counter after a successful login", async () => {
    const username = `cat_lockreset_${uniq()}`;
    await createUser(w.pool, w.orgId, { username });
    await login({ username, password: "wrong-password" });
    await login({ username, password: "wrong-password" });
    expect((await login({ username, password: "Pass1234!" })).statusCode).toBe(200);

    const row = await w.pool.query(
      "SELECT failed_login_attempts FROM users WHERE username = $1",
      [username],
    );
    expect(row.rows[0].failed_login_attempts).toBe(0);
  });
});

describe("UT-AUTH-05 resolve role permissions with global and scoped grants", () => {
  it("denies by default — a user with no roles holds no permissions", async () => {
    const username = `cat_noroles_${uniq()}`;
    await createUser(w.pool, w.orgId, { username });
    const session = await login({ username, password: "Pass1234!" });
    const headers = {
      authorization: `Bearer ${(session.json() as { access_token: string }).access_token}`,
    };

    const res = await w.app.inject({ method: "GET", url: "/api/v1/employees", headers });
    expect(res.statusCode).toBe(403);
  });

  it("unions grants across roles without inventing any", async () => {
    const username = `cat_union_${uniq()}`;
    const userId = await createUser(w.pool, w.orgId, {
      username,
      roles: ["AUDITOR", "INVENTORY_MANAGER"],
    });
    const session = await login({ username, password: "Pass1234!" });
    const token = (session.json() as { access_token: string }).access_token;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { permissions: string[] };

    const expected = await w.pool.query(
      `SELECT DISTINCT rp.permission_code FROM role_permissions rp
         JOIN user_roles ur ON ur.role_id = rp.role_id
        WHERE ur.user_id = $1`,
      [userId],
    );
    expect([...claims.permissions].sort()).toEqual(
      expected.rows.map((r) => r.permission_code).sort(),
    );
    // Both roles contributed; neither contributed the other's codes by accident.
    expect(claims.permissions).toContain("audit.read");
    expect(claims.permissions).toContain("inventory.manage");
    expect(claims.permissions).not.toContain("payroll.manage");
  });

  it("retains the record scope attached to a grant", () => {
    // resolveScopes is the pure half of §4.1: it decides which records a grant
    // reaches, independently of which permission codes it carries.
    const scoped = resolveScopes([
      { scope_type: "district", scope_id: "11111111-1111-1111-1111-111111111111" },
      { scope_type: "project", scope_id: "22222222-2222-2222-2222-222222222222" },
    ]);
    expect(scoped.global).toBe(false);
    expect(scoped.districts).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(scoped.projects).toEqual(["22222222-2222-2222-2222-222222222222"]);

    // A null-scoped assignment is the org-wide grant.
    expect(resolveScopes([{ scope_type: null, scope_id: null }]).global).toBe(true);
  });

  it("applies the record scope to a scoped read", async () => {
    const username = `cat_scoped_${uniq()}`;
    const userId = await createUser(w.pool, w.orgId, { username, roles: ["HR_MANAGER"] });
    // Restrict the HR grant to district A only.
    await w.pool.query(
      `UPDATE user_roles SET scope_type = 'district', scope_id = $2
        WHERE user_id = $1`,
      [userId, w.chainA.district],
    );
    const session = await login({ username, password: "Pass1234!" });
    const headers = {
      authorization: `Bearer ${(session.json() as { access_token: string }).access_token}`,
    };

    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map((e) => e.id);
    expect(ids).toContain(w.directEmployee);
    // chainB's employee is outside the granted district.
    expect(ids).not.toContain(w.siteEmployee);
  });
});

describe("UT-AUTH-06 evaluate self-approval", () => {
  async function casualLeaveTypeId(): Promise<string> {
    const types = await w.app.inject({
      method: "GET",
      url: "/api/v1/leave/types",
      headers: w.admin,
    });
    return (types.json() as { data: Array<{ id: string; code: string }> }).data.find(
      (t) => t.code === "CL",
    )!.id;
  }

  it("never routes a request to its own requester", async () => {
    // A user who holds the approval grant *and* is the subject of the request.
    const username = `cat_selfapprove_${uniq()}`;
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    await grantLeaveBalance(w.app, w.admin, employeeId, await casualLeaveTypeId());
    const userId = await createUser(w.pool, w.orgId, {
      username,
      roles: ["HR_MANAGER"],
      employeeId,
    });
    const headers = await loginAs(w.app, username);

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...headers, ...idem() },
      payload: {
        employee_id: employeeId,
        leave_type_id: await casualLeaveTypeId(),
        from_date: futureDate(10),
        to_date: futureDate(10),
        reason: "Catalogue self-approval probe",
      },
    });
    expect(created.statusCode).toBe(201);
    const requestId = (created.json() as { id: string }).id;
    // The create response carries the bare shape; the chain lives on the detail.
    const detail = await w.app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${requestId}`,
      headers: w.admin,
    });
    const request = detail.json() as {
      current_approver_id: string | null;
      approval_chain: Array<{ approver_user_id: string }>;
    };

    // BR-11 is enforced where the chain is assembled: the requester is never
    // placed on their own approval path, so there is no step they could decide.
    expect(request.approval_chain.length).toBeGreaterThan(0);
    expect(request.current_approver_id).not.toBe(userId);
    expect(request.approval_chain.map((s) => s.approver_user_id)).not.toContain(userId);
  });

  it("denies the requester's own approval attempt even with the decide grant", async () => {
    const username = `cat_selfdecide_${uniq()}`;
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    await grantLeaveBalance(w.app, w.admin, employeeId, await casualLeaveTypeId());
    await createUser(w.pool, w.orgId, {
      username,
      roles: ["HR_MANAGER"],
      employeeId,
    });
    const headers = await loginAs(w.app, username);

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...headers, ...idem() },
      payload: {
        employee_id: employeeId,
        leave_type_id: await casualLeaveTypeId(),
        from_date: futureDate(11),
        to_date: futureDate(11),
        reason: "Catalogue self-decision probe",
      },
    });
    expect(created.statusCode).toBe(201);
    const requestId = (created.json() as { id: string }).id;

    const decision = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${requestId}/decision`,
      headers: {
        ...headers,
        ...(await ifMatch(w, "leave_requests", requestId)),
        ...idem(),
      },
      payload: { decision: "APPROVE", note: "approving my own" },
    });
    // Holding leave.decide is not enough: the actor must be the step's approver,
    // and the requester never is.
    expect(decision.statusCode).toBe(403);
    expect((decision.json() as { code: string }).code).toBe("NOT_APPROVER");

    const after = await w.pool.query("SELECT status FROM leave_requests WHERE id = $1", [
      requestId,
    ]);
    expect(after.rows[0].status).toBe("PENDING");
  });

  it("allows the authorized approver the chain actually named", async () => {
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...w.siteUser, ...idem() },
      payload: {
        employee_id: w.siteEmployee,
        leave_type_id: await casualLeaveTypeId(),
        from_date: futureDate(20),
        to_date: futureDate(20),
        reason: "Catalogue approver probe",
      },
    });
    expect(created.statusCode).toBe(201);
    const request = created.json() as { id: string; current_approver_id: string };
    expect(request.current_approver_id).not.toBe(w.siteUserId);

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
  });

  it("denies an out-of-scope user who merely holds the decide grant", async () => {
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...w.directUser, ...idem() },
      payload: {
        employee_id: w.directEmployee,
        leave_type_id: await casualLeaveTypeId(),
        from_date: futureDate(21),
        to_date: futureDate(21),
        reason: "Catalogue out-of-scope approver probe",
      },
    });
    expect(created.statusCode).toBe(201);
    const request = created.json() as { id: string; current_approver_id: string };

    // HR_MANAGER holds leave.decide but is not this request's named approver.
    const bystander = w.role.HR_MANAGER;
    const decision = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${request.id}/decision`,
      headers: {
        ...bystander,
        ...(await ifMatch(w, "leave_requests", request.id)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(decision.statusCode).toBe(403);
    expect((decision.json() as { code: string }).code).toBe("NOT_APPROVER");
  });
});

function futureDate(daysAhead: number): string {
  const base = new Date(`${workDate()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + daysAhead);
  return base.toISOString().slice(0, 10);
}

describe("UT-AUTH-07 mask Aadhaar PAN bank and phone data", () => {
  const AADHAAR = "123456789012";
  const PAN = "ABCDE1234F";
  const BANK = "9876543210";
  const PHONEPE = "+919812345678";
  let employeeId: string;

  beforeAll(async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { ...w.admin, ...idem() },
      payload: {
        emp_no: `PII${uniq().toUpperCase().slice(-6)}`,
        first_name: "Pii",
        last_name: "Subject",
        phone: "+919700000111",
        date_of_joining: "2024-02-01",
        aadhaar: AADHAAR,
        pan: PAN,
        bank_account: BANK,
        bank_name: "Test Bank",
        phonepe_number: PHONEPE,
        salary_basic: 42000,
      },
    });
    expect(res.statusCode).toBe(201);
    employeeId = (res.json() as { id: string }).id;
  });

  it("returns only the approved masked form to a reader without employee.pii.read", async () => {
    // AUDITOR holds employee.read but not employee.pii.read.
    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${employeeId}`,
      headers: w.role.AUDITOR,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body.aadhaar).toBeNull();
    expect(body.pan).toBeNull();
    expect(body.bank_account).toBeNull();
    expect(body.phonepe_number).toBeNull();
    expect(body.salary_basic).toBeNull();

    expect(body.aadhaar_last4).toBe("••••9012");
    expect(body.pan_last4).toBe("••••1234");
    expect(body.bank_account_last4).toBe("••••3210");
    expect(body.phonepe_number_last4).toBe("••••5678");

    // Nothing anywhere in the payload carries a full value.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(AADHAAR);
    expect(serialized).not.toContain(PAN);
    expect(serialized).not.toContain(BANK);
  });

  it("returns full values to a reader holding employee.pii.read", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${employeeId}`,
      headers: w.admin,
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.aadhaar).toBe(AADHAAR);
    expect(body.pan).toBe(PAN);
    expect(body.bank_account).toBe(BANK);
  });

  it("stores the sensitive columns as ciphertext, never plaintext", async () => {
    const row = await w.pool.query(
      "SELECT aadhaar_encrypted, pan_encrypted, bank_account_encrypted FROM employees WHERE id = $1",
      [employeeId],
    );
    for (const column of Object.values(row.rows[0] as Record<string, string>)) {
      expect(column).toMatch(/^gcm1\./);
      expect(column).not.toContain(AADHAAR);
      expect(column).not.toContain(PAN);
      expect(column).not.toContain(BANK);
    }
  });

  it("keeps the audit trail free of sensitive values", async () => {
    const events = await w.pool.query(
      `SELECT before_state, after_state FROM audit_events
        WHERE entity_type = 'employee' AND entity_id = $1`,
      [employeeId],
    );
    expect(events.rowCount).toBeGreaterThan(0);
    const serialized = JSON.stringify(events.rows);
    expect(serialized).not.toContain(AADHAAR);
    expect(serialized).not.toContain(PAN);
    expect(serialized).not.toContain(BANK);
    expect(serialized).toContain("[REDACTED]");
  });
});

describe("UT-AUTH-08 sanitize structured logs", () => {
  const AADHAAR = "555566667777";
  const PAN = "ZZZZZ9999Z";
  const BANK = "4444333322221111";
  const PASSWORD = "Sup3rSecret!Log";

  /**
   * Rebuilds the API with logging switched on and piped into memory. The
   * catalogue's suites run with NODE_ENV=test, where the logger is off, so the
   * only honest way to assert on log output is to turn it back on here.
   */
  async function captureLogs(
    exercise: (app: Awaited<ReturnType<typeof buildLoggingApp>>["app"]) => Promise<void>,
  ): Promise<string> {
    const { app, lines } = await buildLoggingApp();
    try {
      await exercise(app);
    } finally {
      await app.close();
    }
    return lines.join("\n");
  }

  async function buildLoggingApp() {
    const lines: string[] = [];
    // buildApp silences logging under NODE_ENV=test by design, so the probe
    // constructs the app itself with logging on and then redirects every log
    // call into `lines`. The original logger is deliberately NOT also called:
    // this suite would otherwise dump a full request log to the test output.
    const { buildApp } = await import("../../src/createApp.js");
    const app = await buildApp({
      pool: w.pool,
      jwtSecret: JWT_SECRET,
      nodeEnv: "development",
      logLevel: "trace",
      loginRateLimitMax: 100_000,
      punchRateLimitMax: 100_000,
    });
    const capture =
      (level: string) =>
      (...args: unknown[]) => {
        lines.push(JSON.stringify({ level, args }));
      };
    for (const level of ["info", "warn", "error", "debug", "trace", "fatal"]) {
      (app.log as unknown as Record<string, unknown>)[level] = capture(level);
    }
    // Per-request child loggers inherit from the root logger, not from the
    // instance we just patched, so redirect the factory as well.
    const rootLogger = app.log as unknown as {
      child?: (...args: unknown[]) => unknown;
    };
    if (typeof rootLogger.child === "function") {
      rootLogger.child = () => app.log;
    }
    await app.ready();
    return { app, lines };
  }

  it("never writes a password or token into the log stream", async () => {
    const username = `cat_logpw_${uniq()}`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    await w.pool.query(
      `INSERT INTO users (org_id, username, password_hash, auth_status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [w.orgId, username, hash],
    );

    let issuedToken = "";
    const logs = await captureLogs(async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password: PASSWORD },
      });
      issuedToken = (res.json() as { access_token: string }).access_token;
      // An authenticated call, so the Authorization header passes through too.
      await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${issuedToken}` },
      });
    });

    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(issuedToken);
  });

  it("never writes Aadhaar, PAN or bank values into the log stream", async () => {
    const logs = await captureLogs(async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { ...w.admin, ...idem() },
        payload: {
          emp_no: `LOG${uniq().toUpperCase().slice(-6)}`,
          first_name: "Log",
          last_name: "Probe",
          phone: "+919700000222",
          date_of_joining: "2024-03-01",
          aadhaar: AADHAAR,
          pan: PAN,
          bank_account: BANK,
        },
      });
      expect(res.statusCode).toBe(201);

      // A rejected write logs too, and a validation failure is exactly where a
      // naive implementation echoes the offending body back into the log.
      await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { ...w.admin, ...idem() },
        payload: {
          emp_no: "",
          first_name: "Log",
          phone: "not-a-phone",
          date_of_joining: "2024-03-01",
          aadhaar: AADHAAR,
          pan: PAN,
          bank_account: BANK,
        },
      });
    });

    expect(logs).not.toContain(AADHAAR);
    expect(logs).not.toContain(PAN);
    expect(logs).not.toContain(BANK);
  });

  it("redacts the configured sensitive headers", async () => {
    // The redaction list is part of the logger construction in createApp; this
    // asserts the contract that authorization and cookies never reach a log.
    const logs = await captureLogs(async (app) => {
      await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { ...w.admin, cookie: "session=super-secret-cookie-value" },
      });
    });
    expect(logs).not.toContain("super-secret-cookie-value");
    expect(logs).not.toContain(w.admin.authorization.replace("Bearer ", ""));
  });
});

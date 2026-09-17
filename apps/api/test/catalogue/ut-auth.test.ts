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
import { MFA_DEFAULT_REQUIRED_ROLES } from "@silverline/shared";
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

/**
 * Signing in the way a field crew actually can (§34).
 *
 * A crew member knows their own mobile number. They do not know
 * "user_slv001_19" and will not keep it, so without this somebody else logs
 * in for them and the attendance and progress records stop meaning what they
 * say.
 */
describe("signing in with a mobile number", () => {
  const password = "Fieldwork@2026";
  let mobileUser: string;

  beforeAll(async () => {
    mobileUser = uniq("mob");
    await createUser(w.pool, w.orgId, {
      username: mobileUser, password, phone: "+919100077001",
    });
  });

  it("takes the number in whatever form it is typed", async () => {
    // What a crew member types is not the form an administrator saved.
    for (const typed of [
      "9100077001", "+919100077001", "+91 91000 77001", "091-9100077001",
      " 9100077001 ",
    ]) {
      const r = await login({ username: typed, password });
      expect(r.statusCode, typed).toBe(200);
      expect(r.json().access_token, typed).toBeTruthy();
    }
  });

  it("still takes the username, which is what existing clients send", async () => {
    const r = await login({ username: mobileUser, password });
    expect(r.statusCode).toBe(200);
  });

  it("refuses a number no account uses, without saying so", async () => {
    // Same generic answer as a bad password: whether a number is registered
    // is itself worth knowing to somebody enumerating accounts.
    const r = await login({ username: "9100099999", password });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("does not let a landline or a typo half-match an account", async () => {
    // A wrong match here signs somebody into another person's account.
    for (const notMobile of ["040 2345 6789", "910007700", "5100077001"]) {
      const r = await login({ username: notMobile, password });
      expect(r.statusCode, notMobile).toBe(401);
    }
  });

  it("will not sign in with the right number and the wrong password", async () => {
    const r = await login({ username: "9100077001", password: "wrong-password" });
    expect(r.statusCode).toBe(401);
  });

  it("prefers an exact username over a number", async () => {
    // An account whose username happens to be a number authenticates as
    // itself, not as whoever holds that mobile.
    const numeric = "9100077002";
    await createUser(w.pool, w.orgId, {
      username: numeric, password: "Numeric@2026x", phone: null as unknown as undefined,
    });
    const other = uniq("other");
    await createUser(w.pool, w.orgId, {
      username: other, password: "Other@2026xxx", phone: "+919100077002",
    });

    // The username's own password works...
    expect((await login({ username: numeric, password: "Numeric@2026x" })).statusCode).toBe(200);
    // ...and the other account's does not, even though it holds that number.
    expect((await login({ username: numeric, password: "Other@2026xxx" })).statusCode).toBe(401);
  });

  it("refuses two accounts sharing one number outright", async () => {
    // An ambiguous login cannot be resolved safely, so the duplicate is
    // refused where it is created rather than at the login form.
    await expect(createUser(w.pool, w.orgId, {
      username: uniq("dup"), phone: "+919100077001",
    })).rejects.toThrow();
  });
});

describe("setting your own password", () => {
  const original = "Original@2026a";
  let userId: string;
  let username: string;

  beforeAll(async () => {
    username = uniq("pwd");
    userId = await createUser(w.pool, w.orgId, { username, password: original });
  });

  async function change(headers: Record<string, string>, payload: Record<string, unknown>) {
    return w.app.inject({
      method: "POST", url: "/api/v1/auth/password", headers, payload,
    });
  }

  it("changes it and signs every other session out", async () => {
    // If the reason for changing it is that somebody else knows it, leaving
    // their session alive defeats the change.
    const first = await login({ username, password: original });
    const second = await login({ username, password: original });
    const token = second.json().access_token as string;

    const r = await change({ authorization: `Bearer ${token}` }, {
      current_password: original, new_password: "BrandNew@2026xy",
    });
    expect(r.statusCode, r.body).toBe(200);

    // The old password is gone and the new one works.
    expect((await login({ username, password: original })).statusCode).toBe(401);
    expect((await login({ username, password: "BrandNew@2026xy" })).statusCode).toBe(200);

    // And the other session cannot be refreshed.
    const refreshed = await w.app.inject({
      method: "POST", url: "/api/v1/auth/refresh",
      payload: { refresh_token: first.json().refresh_token },
    });
    expect(refreshed.statusCode).not.toBe(200);
  });

  it("will not take the current password on trust", async () => {
    // A token is far easier to come by than a password -- an unlocked shared
    // phone is enough -- so holding one must not be enough to lock the owner
    // out of their own account.
    const token = (await login({ username, password: "BrandNew@2026xy" })).json()
      .access_token as string;
    const r = await change({ authorization: `Bearer ${token}` }, {
      current_password: "not-it", new_password: "Another@2026xyz",
    });
    expect(r.statusCode).toBe(401);
  });

  it("refuses to set it back to what it already is", async () => {
    const token = (await login({ username, password: "BrandNew@2026xy" })).json()
      .access_token as string;
    const r = await change({ authorization: `Bearer ${token}` }, {
      current_password: "BrandNew@2026xy", new_password: "BrandNew@2026xy",
    });
    expect(r.statusCode).toBe(422);
  });

  it("will not accept a password shorter than one an administrator must set", async () => {
    // Otherwise the self-service route weakens the account below what it was
    // issued with.
    const token = (await login({ username, password: "BrandNew@2026xy" })).json()
      .access_token as string;
    const r = await change({ authorization: `Bearer ${token}` }, {
      current_password: "BrandNew@2026xy", new_password: "short",
    });
    expect(r.statusCode).toBe(422);
  });

  it("stands the account down until the password somebody else chose is replaced", async () => {
    // A password an administrator set is a password the administrator knows.
    await w.pool.query(
      "UPDATE users SET must_change_password = true WHERE id = $1", [userId]);

    const signIn = await login({ username, password: "BrandNew@2026xy" });
    expect(signIn.statusCode).toBe(200);
    // Signed in — it has to be, or the password could never be changed.
    expect(signIn.json().must_change_password).toBe(true);
    const token = signIn.json().access_token as string;

    // And can do nothing else.
    const blocked = await w.app.inject({
      method: "GET", url: "/api/v1/employees",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("PASSWORD_CHANGE_REQUIRED");

    // Changing it lifts the block.
    const changed = await change({ authorization: `Bearer ${token}` }, {
      current_password: "BrandNew@2026xy", new_password: "TheirOwn@2026ab",
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const after = await login({ username, password: "TheirOwn@2026ab" });
    expect(after.json().must_change_password).toBe(false);
    const ok = await w.app.inject({
      method: "GET", url: "/api/v1/employees",
      headers: { authorization: `Bearer ${after.json().access_token}` },
    });
    // This account holds no roles, so a plain permission denial is the
    // correct answer. What must be gone is the password block.
    expect(ok.json().code).not.toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

/**
 * Deciding who needs two-factor authentication (§34).
 *
 * It used to be a list of role codes compiled into the API, which put a
 * policy question somewhere only a deploy could answer — and it was wrong for
 * the field, where a rover operator reading a six-digit code off a second
 * device before every shift pays that cost every morning.
 */
describe("asking somebody to replace a password that was set for them", () => {
  /*
   * Offered, not imposed. A password an administrator sets is one the
   * administrator knows, so asking the person to replace it is worth having —
   * but a crew member handed a phone at the start of a shift should not be
   * stopped at a password screen by a policy nobody chose.
   */
  it("does not ask by default when an account is created", async () => {
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/admin/users",
      headers: { ...w.admin, ...idem() },
      payload: { username: uniq("opt"), password: "Initial@2026xyz" },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().must_change_password).toBe(false);
  });

  it("asks when it is asked for", async () => {
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/admin/users",
      headers: { ...w.admin, ...idem() },
      payload: {
        username: uniq("opt"), password: "Initial@2026xyz",
        must_change_password: true,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().must_change_password).toBe(true);
  });

  it("does not impose it when an administrator resets a password", async () => {
    // Resetting a password just resets it.
    const id = await createUser(w.pool, w.orgId, { username: uniq("reset") });
    const r = await w.app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${id}`,
      headers: { ...w.admin, ...idem() },
      payload: { password: "Replaced@2026abc" },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await w.pool.query(
      "SELECT must_change_password FROM users WHERE id = $1", [id]))
      .rows[0].must_change_password).toBe(false);
  });

  it("can be turned on for an account, and off again", async () => {
    const id = await createUser(w.pool, w.orgId, { username: uniq("toggle") });
    const patch = (v: boolean) => w.app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${id}`,
      headers: { ...w.admin, ...idem() },
      payload: { must_change_password: v },
    });
    const read = async () => (await w.pool.query(
      "SELECT must_change_password FROM users WHERE id = $1", [id]))
      .rows[0].must_change_password;

    expect((await patch(true)).statusCode).toBe(200);
    expect(await read()).toBe(true);
    expect((await patch(false)).statusCode).toBe(200);
    expect(await read()).toBe(false);
  });
});

describe("choosing which roles need an authenticator", () => {
  async function roleId(code: string): Promise<string> {
    return String((await w.pool.query(
      "SELECT id FROM roles WHERE code = $1", [code])).rows[0].id);
  }

  async function setRoleMfa(code: string, required: boolean) {
    return w.app.inject({
      method: "PATCH", url: `/api/v1/admin/roles/${await roleId(code)}/mfa`,
      headers: { ...w.admin, ...idem() }, payload: { mfa_required: required },
    });
  }

  it("starts where the hardcoded list left off, so nothing changes on the day", async () => {
    const rows = await w.pool.query(
      "SELECT code, mfa_required FROM roles WHERE mfa_required ORDER BY code");
    expect(rows.rows.map(r => r.code)).toEqual(
      [...MFA_DEFAULT_REQUIRED_ROLES].sort());
  });

  it("lets an organisation excuse a field role", async () => {
    // The whole point of the setting.
    const r = await setRoleMfa("TEAM_LEAD", false);
    expect(r.statusCode, r.body).toBe(200);
    expect((await w.pool.query(
      "SELECT mfa_required FROM roles WHERE code = 'TEAM_LEAD'")).rows[0].mfa_required)
      .toBe(false);

    // And put it back.
    expect((await setRoleMfa("TEAM_LEAD", true)).statusCode).toBe(200);
  });

  it("will not let a super administrator be excused", async () => {
    // That role can grant itself the permission to change this setting, so
    // the opting out would itself be the attack.
    const r = await setRoleMfa("SUPER_ADMIN", false);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("MFA_REQUIRED");
    expect((await w.pool.query(
      "SELECT mfa_required FROM roles WHERE code = 'SUPER_ADMIN'")).rows[0].mfa_required)
      .toBe(true);
  });

  it("refuses it at the table too, not only at the API", async () => {
    // A policy that holds only while the application is the only writer is
    // not a policy.
    await expect(w.pool.query(
      "UPDATE roles SET mfa_required = false WHERE code = 'SUPER_ADMIN'"))
      .rejects.toThrow();
  });

  it("does not take somebody's authenticator away when the role stops requiring it", async () => {
    // The setting decides who must have one, not who may.
    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM users WHERE mfa_enabled");
    await setRoleMfa("AUDITOR", false);
    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM users WHERE mfa_enabled");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    await setRoleMfa("AUDITOR", true);
  });

  it("is not something an ordinary account can change", async () => {
    const r = await w.app.inject({
      method: "PATCH", url: `/api/v1/admin/roles/${await roleId("TEAM_LEAD")}/mfa`,
      headers: { ...w.directUser, ...idem() }, payload: { mfa_required: false },
    });
    expect([401, 403]).toContain(r.statusCode);
  });
});

describe("excusing or requiring one account", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await createUser(w.pool, w.orgId, { username: uniq("policy") });
  });

  async function setPolicy(id: string, mfa_policy: string) {
    return w.app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${id}`,
      headers: { ...w.admin, ...idem() }, payload: { mfa_policy },
    });
  }

  it("records an exemption for one person without changing their role", async () => {
    const r = await setPolicy(userId, "EXEMPT");
    expect(r.statusCode, r.body).toBe(200);
    expect((await w.pool.query(
      "SELECT mfa_policy FROM users WHERE id = $1", [userId])).rows[0].mfa_policy)
      .toBe("EXEMPT");
  });

  it("holds one person to it without holding their role to it", async () => {
    expect((await setPolicy(userId, "REQUIRED")).statusCode).toBe(200);
    expect((await w.pool.query(
      "SELECT mfa_policy FROM users WHERE id = $1", [userId])).rows[0].mfa_policy)
      .toBe("REQUIRED");
  });

  it("keeps \"no override\" apart from \"deliberately exempt\"", async () => {
    // Collapsing them into a boolean would silently re-require somebody the
    // moment their role's default changed.
    expect((await setPolicy(userId, "INHERIT")).statusCode).toBe(200);
    expect((await w.pool.query(
      "SELECT mfa_policy FROM users WHERE id = $1", [userId])).rows[0].mfa_policy)
      .toBe("INHERIT");
  });

  it("will not exempt an account that holds a super administrator role", async () => {
    const root = await createUser(w.pool, w.orgId, {
      username: uniq("root"), roles: ["SUPER_ADMIN"],
    });
    const r = await setPolicy(root, "EXEMPT");
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("MFA_REQUIRED");
  });

  it("refuses a policy that is not one of the three", async () => {
    expect((await setPolicy(userId, "SOMETIMES")).statusCode).toBe(422);
  });
});

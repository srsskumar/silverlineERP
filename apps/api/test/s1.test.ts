import { randomUUID } from "node:crypto";
import { VOLATILE_TABLES } from "./tables.js";
import {testDatabaseUrl} from "./database.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  seedDatabase,
} from "../src/database/seed.js";

process.env["UPLOADS_DIR"] = join(tmpdir(), `sl-s1-test-${process.pid}`);

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";
let seq = 0;

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${VOLATILE_TABLES}`,
  );
}

async function createUser(opts: {
  username: string;
  password: string;
  roles?: string[];
}): Promise<string> {
  const hash = await bcrypt.hash(opts.password, 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, opts.username, hash],
  );
  const id = (res.rows[0] as { id: string }).id;
  for (const code of opts.roles ?? []) {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [code]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      id,
      (role.rows[0] as { id: string }).id,
    ]);
  }
  return id;
}

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const body = res.json() as { access_token: string };
  return { authorization: `Bearer ${body.access_token}` };
}

async function adminHeaders() {
  return headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
}

async function roleHeaders(role: string) {
  const u = `u_${role.toLowerCase()}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await createUser({ username: u, password: "Pass1234!", roles: [role] });
  return headersFor(u, "Pass1234!");
}

function empPayload(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    emp_no: `E${String(seq).padStart(4, "0")}`,
    first_name: "Test",
    last_name: "User",
    phone: `+9190000${String(10000 + seq)}`,
    date_of_joining: "2024-01-15",
    ...over,
  };
}

async function createUnit(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  idemKey?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/org/units",
    headers: { ...headers, ...(idemKey ? { "Idempotency-Key": idemKey } : {}) },
    payload: body,
  });
}

async function createEmployee(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  idemKey?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers: { ...headers, ...(idemKey ? { "Idempotency-Key": idemKey } : {}) },
    payload: body,
  });
}

/** Creates a district→mandal→village chain; returns the ids. */
async function unitChain(headers: Record<string, string>) {
  const d = await createUnit(headers, { type: "district", code: "DCH", name: "Chain District" });
  const district = d.json() as { id: string };
  const m = await createUnit(headers, {
    type: "mandal",
    code: "MCH",
    name: "Chain Mandal",
    parent_id: district.id,
  });
  const mandal = m.json() as { id: string };
  const v = await createUnit(headers, {
    type: "village",
    code: "VCH",
    name: "Chain Village",
    parent_id: mandal.id,
  });
  const village = v.json() as { id: string };
  return { district: district.id, mandal: mandal.id, village: village.id };
}

/** Creates an employee and walks it to ACTIVE (exit + reactivate). */
async function activeEmployee(
  headers: Record<string, string>,
  over: Record<string, unknown> = {},
) {
  const res = await createEmployee(headers, empPayload(over));
  expect(res.statusCode).toBe(201);
  const emp = res.json() as { id: string };
  const exit = await app.inject({
    method: "POST",
    url: `/api/v1/employees/${emp.id}/exit`,
    headers,
    payload: { exit_date: "2024-06-01", reason: "activate-helper" },
  });
  expect(exit.statusCode).toBe(200);
  const re = await app.inject({
    method: "POST",
    url: `/api/v1/employees/${emp.id}/reactivate`,
    headers,
    payload: { reason: "activate-helper" },
  });
  expect(re.statusCode).toBe(200);
  return (re.json() as { id: string; status: string }).id;
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({
    databaseUrl: TEST_DB,
    jwtSecret: JWT_SECRET,
    loginRateLimitMax: 1000,
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  seq = 0;
});

// ---------------------------------------------------------------- org units

describe("org units", () => {
  it("creates a district with parent null (201 + shape)", async () => {
    const h = await adminHeaders();
    const res = await createUnit(h, { type: "district", code: "D01", name: "Krishna" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body["type"]).toBe("district");
    expect(body["parent_id"]).toBeNull();
    expect(body["status"]).toBe("ACTIVE");
    expect(body["version"]).toBe(1);
    expect(typeof body["id"]).toBe("string");
  });

  it("replays an Idempotency-Key without duplicating", async () => {
    const h = await adminHeaders();
    const key = `idem-${Date.now()}`;
    const first = await createUnit(h, { type: "district", code: "DID", name: "Idem" }, key);
    const second = await createUnit(h, { type: "district", code: "DID", name: "Idem" }, key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.json() as { id: string }).id).toBe(
      (first.json() as { id: string }).id,
    );
    const count = await pool.query(
      "SELECT COUNT(*)::int AS n FROM org_units WHERE code = 'DID'",
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("rejects mandal without parent and district with parent (422)", async () => {
    const h = await adminHeaders();
    const noParent = await createUnit(h, { type: "mandal", code: "M9", name: "No parent" });
    expect(noParent.statusCode).toBe(422);
    expect(
      ((noParent.json() as { field_errors: Array<{ field: string }> }).field_errors ?? []).map(
        (f) => f.field,
      ),
    ).toContain("parent_id");

    const d = await createUnit(h, { type: "district", code: "DP", name: "P" });
    const withParent = await createUnit(h, {
      type: "district",
      code: "DP2",
      name: "Bad",
      parent_id: (d.json() as { id: string }).id,
    });
    expect(withParent.statusCode).toBe(422);
  });

  it("creates the mandal→village→site chain and rejects wrong parent type", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h);
    expect(ids.district).toBeTruthy();
    const site = await createUnit(h, {
      type: "site",
      code: "SCH",
      name: "Site",
      parent_id: ids.village,
    });
    expect(site.statusCode).toBe(201);

    const wrong = await createUnit(h, {
      type: "mandal",
      code: "MWRONG",
      name: "Wrong",
      parent_id: ids.village,
    });
    expect(wrong.statusCode).toBe(422);
  });

  it("enforces code uniqueness per (org,type) with 409", async () => {
    const h = await adminHeaders();
    const first = await createUnit(h, { type: "district", code: "DUP", name: "One" });
    expect(first.statusCode).toBe(201);
    const dup = await createUnit(h, { type: "district", code: "DUP", name: "Two" });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { code: string }).code).toBe("CONFLICT");
    const otherType = await createUnit(h, {
      type: "mandal",
      code: "DUP",
      name: "Same code other type",
      parent_id: (first.json() as { id: string }).id,
    });
    expect(otherType.statusCode).toBe(201);
  });

  it("lists with the pagination envelope + type/q filters", async () => {
    const h = await adminHeaders();
    await unitChain(h);
    const list = await app.inject({ method: "GET", url: "/api/v1/org/units", headers: h });
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      data: Array<{ type: string }>;
      next_cursor: unknown;
      has_more: boolean;
    };
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();

    const filtered = await app.inject({
      method: "GET",
      url: "/api/v1/org/units?type=village&q=Chain",
      headers: h,
    });
    const fpage = filtered.json() as { data: Array<{ type: string; name: string }> };
    expect(fpage.data.length).toBe(1);
    expect(fpage.data[0]?.type).toBe("village");
  });

  it("gets by id and 404s unknown ids", async () => {
    const h = await adminHeaders();
    const created = await createUnit(h, { type: "district", code: "DG", name: "Get" });
    const id = (created.json() as { id: string }).id;
    const got = await app.inject({ method: "GET", url: `/api/v1/org/units/${id}`, headers: h });
    expect(got.statusCode).toBe(200);
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/org/units/00000000-0000-0000-0000-000000000000",
      headers: h,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("patches name with If-Match and bumps version", async () => {
    const h = await adminHeaders();
    const created = await createUnit(h, { type: "district", code: "DPN", name: "Old" });
    const id = (created.json() as { id: string }).id;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/org/units/${id}`,
      headers: { ...h, "If-Match": "1" },
      payload: { name: "New" },
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { name: string; version: number };
    expect(body.name).toBe("New");
    expect(body.version).toBe(2);
  });

  it("returns 409 with the current version on If-Match mismatch", async () => {
    const h = await adminHeaders();
    const created = await createUnit(h, { type: "district", code: "DVM", name: "V" });
    const id = (created.json() as { id: string }).id;
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/org/units/${id}`,
      headers: { ...h, "If-Match": "99" },
      payload: { name: "Nope" },
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json() as { message: string; code: string };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.message).toContain("1");
  });

  it("blocks deactivation with active children (422), allows after child off", async () => {
    const h = await adminHeaders();
    const d = await createUnit(h, { type: "district", code: "DDC", name: "D" });
    const did = (d.json() as { id: string }).id;
    const m = await createUnit(h, {
      type: "mandal",
      code: "MDC",
      name: "M",
      parent_id: did,
    });
    const mid = (m.json() as { id: string }).id;

    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/org/units/${did}`,
      headers: { ...h, "If-Match": "1" },
      payload: { status: "INACTIVE" },
    });
    expect(blocked.statusCode).toBe(422);

    const childOff = await app.inject({
      method: "PATCH",
      url: `/api/v1/org/units/${mid}`,
      headers: { ...h, "If-Match": "1" },
      payload: { status: "INACTIVE" },
    });
    expect(childOff.statusCode).toBe(200);
    const parentOff = await app.inject({
      method: "PATCH",
      url: `/api/v1/org/units/${did}`,
      headers: { ...h, "If-Match": "1" },
      payload: { status: "INACTIVE" },
    });
    expect(parentOff.statusCode).toBe(200);
    expect((parentOff.json() as { status: string }).status).toBe("INACTIVE");
  });

  it("blocks deactivation when an ACTIVE employee references the unit", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h);
    const empId = await activeEmployee(h, { village_id: ids.village });
    expect(empId).toBeTruthy();
    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/org/units/${ids.village}`,
      headers: { ...h, "If-Match": "1" },
      payload: { status: "INACTIVE" },
    });
    expect(blocked.statusCode).toBe(422);
  });

  it("forbids EMPLOYEE-role callers on org units (403)", async () => {
    const eh = await roleHeaders("EMPLOYEE");
    const list = await app.inject({ method: "GET", url: "/api/v1/org/units", headers: eh });
    expect(list.statusCode).toBe(403);
    const post = await createUnit(eh, { type: "district", code: "DX", name: "X" });
    expect(post.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------- employees

describe("employees", () => {
  it("persists an assigned site and validates that it is a site unit", async () => {
    const admin = await adminHeaders();
    const ids = await unitChain(admin);
    const siteRes = await createUnit(admin, {
      type: "site",
      code: "SITE-EMP",
      name: "Employee Site",
      parent_id: ids.village,
    });
    const siteId = (siteRes.json() as { id: string }).id;
    const created = await createEmployee(admin, { ...empPayload(), site_id: siteId });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { site_id: string }).site_id).toBe(siteId);

    const wrongType = await createEmployee(admin, {
      ...empPayload(),
      site_id: ids.village,
    });
    expect(wrongType.statusCode).toBe(422);
    expect(
      (wrongType.json() as { field_errors: Array<{ field: string }> }).field_errors.map(
        (error) => error.field,
      ),
    ).toContain("site_id");
  });

  it("creates with status DRAFT and masks PII without pii.read", async () => {
    const admin = await adminHeaders();
    const auditor = await roleHeaders("AUDITOR");
    const created = await createEmployee(admin, {
      ...empPayload(),
      aadhaar: "123456789012",
      pan: "ABCDE1234F",
      bank_account: "501002003003",
      phonepe_number: "+919876543210",
      salary_basic: 25000,
    });
    expect(created.statusCode).toBe(201);
    const owned = created.json() as { id: string; status: string };
    expect(owned.status).toBe("DRAFT");

    const got = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${owned.id}`,
      headers: auditor,
    });
    expect(got.statusCode).toBe(200);
    const body = got.json() as Record<string, unknown>;
    expect(body["aadhaar"]).toBeNull();
    expect(body["pan"]).toBeNull();
    expect(body["bank_account"]).toBeNull();
    expect(body["phonepe_number"]).toBeNull();
    expect(body["salary_basic"]).toBeNull();
    expect(body["aadhaar_last4"]).toBe("••••9012");
    expect(body["pan_last4"]).toBe("••••1234");
    expect(body["bank_account_last4"]).toBe("••••3003");
    expect(body["phonepe_number_last4"]).toBe("••••3210");
  });

  it("lets AUDITOR read org units, like every other role that reads employees (P-002)", async () => {
    // Post-deploy QA browser walk: /employees as qa-admin-auditor threw a
    // console 403 on load -- the district filter fetches GET /org/units,
    // gated on org.units.read. HR_MANAGER, PROJECT_MANAGER and TEAM_LEAD all
    // pair EMPLOYEE_READ with ORG_UNITS_READ in S1_ROLE_GRANTS; AUDITOR only
    // had EMPLOYEE_READ.
    const auditor = await roleHeaders("AUDITOR");
    const res = await app.inject({ method: "GET", url: "/api/v1/org/units?type=district&limit=100", headers: auditor });
    expect(res.statusCode).toBe(200);
  });

  it("returns full decrypted PII with pii.read on the detail only (HR-15)", async () => {
    const admin = await adminHeaders();
    const hr = await roleHeaders("HR_MANAGER");
    const created = await createEmployee(admin, {
      ...empPayload(),
      aadhaar: "999988887777",
      salary_basic: 42000,
    });
    const id = (created.json() as { id: string }).id;

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${id}`,
      headers: hr,
    });
    const d = detail.json() as Record<string, unknown>;
    expect(d["aadhaar"]).toBe("999988887777");
    expect(d["salary_basic"]).toBe(42000);

    const list = await app.inject({ method: "GET", url: "/api/v1/employees", headers: hr });
    const page = list.json() as { data: Array<Record<string, unknown>> };
    const found = page.data.find((e) => e["id"] === id);
    // The list is masked for everybody: a directory page is not the place
    // to hand out every identity number at once.
    expect(found?.["aadhaar"]).toBeNull();
    expect(String(found?.["aadhaar_last4"])).toMatch(/7777$/);
  });

  it("encrypts PII at rest and redacts audit payloads", async () => {
    const admin = await adminHeaders();
    const created = await createEmployee(admin, { ...empPayload(), aadhaar: "111122223333" });
    const id = (created.json() as { id: string }).id;
    const db = await pool.query("SELECT aadhaar_encrypted FROM employees WHERE id = $1", [id]);
    const blob = (db.rows[0] as { aadhaar_encrypted: string }).aadhaar_encrypted;
    expect(blob).not.toContain("111122223333");
    expect(blob.startsWith("gcm1.")).toBe(true);

    const audit = await pool.query(
      "SELECT after_state FROM audit_events WHERE action = 'employee.create' AND entity_id = $1::uuid",
      [id],
    );
    const after = audit.rows[0].after_state as Record<string, unknown>;
    expect(after["aadhaar"]).toBe("[REDACTED]");
  });

  it("records the actor's IP and user agent on a mutate()-routed action", async () => {
    // employee.create runs through the shared mutate() helper in
    // common/domain.ts, used by nearly every module's writes -- so this one
    // route stands in for all of them.
    const admin = await adminHeaders();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { ...admin, "user-agent": "sl-test-agent/1.0" },
      payload: empPayload(),
      remoteAddress: "203.0.113.7",
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const audit = await pool.query(
      "SELECT actor_ip, actor_user_agent FROM audit_events WHERE action = 'employee.create' AND entity_id = $1::uuid",
      [id],
    );
    expect(audit.rows[0].actor_ip).toBe("203.0.113.7");
    expect(audit.rows[0].actor_user_agent).toBe("sl-test-agent/1.0");
  });

  it("rejects duplicate emp_no and phone with 409 + field_errors", async () => {
    const admin = await adminHeaders();
    const first = empPayload();
    const ok = await createEmployee(admin, first);
    expect(ok.statusCode).toBe(201);

    const dupNo = await createEmployee(admin, { ...empPayload(), emp_no: first.emp_no });
    expect(dupNo.statusCode).toBe(409);
    expect(
      ((dupNo.json() as { field_errors: Array<{ field: string }> }).field_errors ?? []).map(
        (f) => f.field,
      ),
    ).toContain("emp_no");

    const dupPhone = await createEmployee(admin, { ...empPayload(), phone: first.phone });
    expect(dupPhone.statusCode).toBe(409);
    expect(
      ((dupPhone.json() as { field_errors: Array<{ field: string }> }).field_errors ?? []).map(
        (f) => f.field,
      ),
    ).toContain("phone");
  });

  it("validates reports_to: missing, inactive and self/cycles → 422", async () => {
    const admin = await adminHeaders();
    const missing = await createEmployee(admin, {
      ...empPayload(),
      reports_to: "00000000-0000-0000-0000-000000000000",
    });
    expect(missing.statusCode).toBe(422);

    const draft = await createEmployee(admin, empPayload());
    const draftId = (draft.json() as { id: string }).id;
    const toDraft = await createEmployee(admin, { ...empPayload(), reports_to: draftId });
    expect(toDraft.statusCode).toBe(422);

    // Self-report via PATCH.
    const self = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${draftId}`,
      headers: { ...admin, "If-Match": "1" },
      payload: { reports_to: draftId },
    });
    expect(self.statusCode).toBe(422);

    // Cycle: mgr(ACTIVE) ← a(ACTIVE) ← b(ACTIVE); then a reports to b → 422.
    const mgrId = await activeEmployee(admin);
    const aRes = await createEmployee(admin, empPayload({ reports_to: mgrId }));
    const aId = (aRes.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/v1/employees/${aId}/exit`,
      headers: admin,
      payload: { exit_date: "2024-06-01", reason: "cycle setup" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/employees/${aId}/reactivate`,
      headers: admin,
      payload: { reason: "cycle setup" },
    });
    const bRes = await createEmployee(admin, empPayload({ reports_to: aId }));
    const bId = (bRes.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/v1/employees/${bId}/exit`,
      headers: admin,
      payload: { exit_date: "2024-06-01", reason: "cycle setup" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/employees/${bId}/reactivate`,
      headers: admin,
      payload: { reason: "cycle setup" },
    });

    const aGet = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${aId}`,
      headers: admin,
    });
    const aVersion = (aGet.json() as { version: number }).version;
    const reverse = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${aId}`,
      headers: { ...admin, "If-Match": String(aVersion) },
      payload: { reports_to: bId },
    });
    expect(reverse.statusCode).toBe(422);

    // Sanity: re-pointing b at the top-level manager is legal (200).
    const bGet = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${bId}`,
      headers: admin,
    });
    const bVersion = (bGet.json() as { version: number }).version;
    const legal = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${bId}`,
      headers: { ...admin, "If-Match": String(bVersion) },
      payload: { reports_to: mgrId },
    });
    expect(legal.statusCode).toBe(200);
  });

  it("supports /me: own record, 404 when unlinked, 401 anon", async () => {
    const admin = await adminHeaders();
    const created = await createEmployee(admin, empPayload());
    const empId = (created.json() as { id: string }).id;

    const uname = `meuser_${Date.now()}`;
    const uid = await createUser({ username: uname, password: "Pass1234!", roles: ["EMPLOYEE"] });
    await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [empId, uid]);
    const mine = await headersFor(uname, "Pass1234!");
    const me = await app.inject({ method: "GET", url: "/api/v1/employees/me", headers: mine });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { id: string }).id).toBe(empId);

    const unlinked = await app.inject({
      method: "GET",
      url: "/api/v1/employees/me",
      headers: admin,
    });
    expect(unlinked.statusCode).toBe(404);
    const anon = await app.inject({ method: "GET", url: "/api/v1/employees/me" });
    expect(anon.statusCode).toBe(401);
  });

  it("patches fields, rejects direct status patch (422) and stale versions (409)", async () => {
    const admin = await adminHeaders();
    const created = await createEmployee(admin, empPayload());
    const id = (created.json() as { id: string }).id;

    const statusPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${id}`,
      headers: { ...admin, "If-Match": "1" },
      payload: { status: "ACTIVE" },
    });
    expect(statusPatch.statusCode).toBe(422);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${id}`,
      headers: { ...admin, "If-Match": "1" },
      payload: { designation: "Mason" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { designation: string }).designation).toBe("Mason");

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${id}`,
      headers: { ...admin, "If-Match": "1" },
      payload: { designation: "Stale" },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("exits: happy path + audit, re-exit 422, bad date 422, self-exit 403", async () => {
    const admin = await adminHeaders();
    const created = await createEmployee(admin, empPayload());
    const id = (created.json() as { id: string }).id;

    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/exit`,
      headers: admin,
      payload: { exit_date: "2024-06-01" },
    });
    expect(noReason.statusCode).toBe(422);

    const badDate = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/exit`,
      headers: admin,
      payload: { exit_date: "2020-01-01", reason: "too early" },
    });
    expect(badDate.statusCode).toBe(422);

    const done = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/exit`,
      headers: admin,
      payload: { exit_date: "2024-06-01", reason: "resigned" },
    });
    expect(done.statusCode).toBe(200);
    expect((done.json() as { status: string }).status).toBe("EXITED");

    const audit = await pool.query(
      "SELECT reason, action FROM audit_events WHERE action = 'employee.exit' AND entity_id = $1::uuid",
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0] as { reason: string }).reason).toBe("resigned");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/exit`,
      headers: admin,
      payload: { exit_date: "2024-07-01", reason: "again" },
    });
    expect(again.statusCode).toBe(422);

    // Self-exit is forbidden even with the permission.
    const hrName = `hrself_${Date.now()}`;
    const hrId = await createUser({ username: hrName, password: "Pass1234!", roles: ["HR_MANAGER"] });
    const mine = await createEmployee(admin, empPayload());
    const mineId = (mine.json() as { id: string }).id;
    await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [mineId, hrId]);
    const hrHeaders = await headersFor(hrName, "Pass1234!");
    const selfExit = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${mineId}/exit`,
      headers: hrHeaders,
      payload: { exit_date: "2024-06-01", reason: "self" },
    });
    expect(selfExit.statusCode).toBe(403);
  });

  it("reactivates from EXITED, rejects from ACTIVE (422)", async () => {
    const admin = await adminHeaders();
    const created = await createEmployee(admin, empPayload());
    const id = (created.json() as { id: string }).id;

    const fromDraft = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/reactivate`,
      headers: admin,
      payload: { reason: "nope" },
    });
    expect(fromDraft.statusCode).toBe(422);

    await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/exit`,
      headers: admin,
      payload: { exit_date: "2024-06-01", reason: "bye" },
    });
    const re = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/reactivate`,
      headers: admin,
      payload: { reason: "rehired" },
    });
    expect(re.statusCode).toBe(200);
    expect((re.json() as { status: string }).status).toBe("ACTIVE");

    const fromActive = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/reactivate`,
      headers: admin,
      payload: { reason: "again" },
    });
    expect(fromActive.statusCode).toBe(422);
  });

  it("enforces RBAC: EMPLOYEE create 403, TL exit 403, CLIENT_VIEWER list 403", async () => {
    const admin = await adminHeaders();
    const empH = await roleHeaders("EMPLOYEE");
    const tlH = await roleHeaders("TEAM_LEAD");
    const viewerH = await roleHeaders("CLIENT_VIEWER");

    const blocked = await createEmployee(empH, empPayload());
    expect(blocked.statusCode).toBe(403);

    const created = await createEmployee(admin, empPayload());
    const id = (created.json() as { id: string }).id;
    const tlExit = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/exit`,
      headers: tlH,
      payload: { exit_date: "2024-06-01", reason: "tl" },
    });
    expect(tlExit.statusCode).toBe(403);

    const viewerList = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: viewerH,
    });
    expect(viewerList.statusCode).toBe(403);

    // TL *can* list (masked, no PII).
    const tlList = await app.inject({ method: "GET", url: "/api/v1/employees", headers: tlH });
    expect(tlList.statusCode).toBe(200);
    const page = tlList.json() as { data: Array<Record<string, unknown>> };
    expect(page.data[0]?.["aadhaar"]).toBeNull();
  });

  it("bulk-imports with an exact per-row report (1 good, 1 dup, 1 bad phone)", async () => {
    const admin = await adminHeaders();
    const good = empPayload({ emp_no: "BULK1" });
    const dup = empPayload({ emp_no: "BULK1", phone: "+919999900001" });
    const bad = empPayload({ emp_no: "BULK3", phone: "not-a-phone" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees/bulk-import",
      headers: admin,
      payload: { rows: [good, dup, bad] },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as {
      imported: number;
      failed: number;
      errors: Array<{
        index: number;
        emp_no?: string;
        errors: Array<{ field: string; message: string }>;
      }>;
    };
    expect(report.imported).toBe(1);
    expect(report.failed).toBe(2);
    expect(report.errors.length).toBe(2);
    expect(report.errors[0]?.index).toBe(1);
    expect(report.errors[0]?.emp_no).toBe("BULK1");
    expect(report.errors[0]?.errors.map((e) => e.field)).toContain("emp_no");
    expect(report.errors[1]?.index).toBe(2);
    expect(report.errors[1]?.errors.map((e) => e.field)).toContain("phone");

    const count = await pool.query(
      "SELECT COUNT(*)::int AS n FROM employees WHERE emp_no LIKE 'BULK%'",
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);

    const audit = await pool.query(
      "SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'employee.import'",
    );
    expect((audit.rows[0] as { n: number }).n).toBe(1);
  });

  it("echoes calendar dates verbatim (no TZ shift)", async () => {
    const admin = await adminHeaders();
    const created = await createEmployee(admin, {
      ...empPayload(),
      date_of_joining: "2024-02-01",
      date_of_birth: "1990-12-31",
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { date_of_joining: string; date_of_birth: string };
    expect(body.date_of_joining).toBe("2024-02-01");
    expect(body.date_of_birth).toBe("1990-12-31");
  });

  it("filters employees by status/district_id/q", async () => {
    const admin = await adminHeaders();
    const ids = await unitChain(admin);
    await createEmployee(admin, empPayload({ first_name: "Zara", district_id: ids.district }));
    const q = await app.inject({
      method: "GET",
      url: "/api/v1/employees?q=Zara",
      headers: admin,
    });
    const page = q.json() as { data: Array<{ first_name: string }> };
    expect(page.data.length).toBe(1);

    const byStatus = await app.inject({
      method: "GET",
      url: "/api/v1/employees?status=DRAFT",
      headers: admin,
    });
    expect(
      ((byStatus.json() as { data: Array<{ status: string }> }).data ?? []).every(
        (e) => e.status === "DRAFT",
      ),
    ).toBe(true);

    const byDistrict = await app.inject({
      method: "GET",
      url: `/api/v1/employees?district_id=${ids.district}`,
      headers: admin,
    });
    expect(((byDistrict.json() as { data: unknown[] }).data ?? []).length).toBe(1);
  });
});

// ------------------------------------------------------------- documents

describe("documents", () => {
  it("uploads, checksums, lists; rejects bad type and oversize", async () => {
    const admin = await adminHeaders();
    const created = await createEmployee(admin, empPayload());
    const id = (created.json() as { id: string }).id;

    const binary = Buffer.from("%PDF-1.4 hello world", "utf8");
    const expected = createHash("sha256").update(binary).digest("hex");
    const up = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/documents`,
      headers: admin,
      payload: {
        doc_type: "id_proof",
        file_name: "aadhaar.pdf",
        content_base64: binary.toString("base64"),
      },
    });
    expect(up.statusCode).toBe(201);
    const meta = up.json() as {
      id: string;
      doc_type: string;
      file_name: string;
      file_size: number;
      checksum: string;
    };
    expect(meta.checksum).toBe(expected);
    expect(meta.file_size).toBe(binary.length);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${id}/documents`,
      headers: admin,
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as { data: Array<{ id: string; checksum: string }> };
    expect(page.data.length).toBe(1);
    expect(page.data[0]?.checksum).toBe(expected);

    const exe = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/documents`,
      headers: admin,
      payload: {
        doc_type: "id_proof",
        file_name: "evil.exe",
        content_base64: binary.toString("base64"),
      },
    });
    expect(exe.statusCode).toBe(422);

    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const over = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${id}/documents`,
      headers: admin,
      payload: {
        doc_type: "id_proof",
        file_name: "big.pdf",
        content_base64: big.toString("base64"),
      },
    });
    expect(over.statusCode).toBe(422);
  });
});

// ------------------------------------------------------------- holidays

describe("holidays", () => {
  it("creates, rejects duplicates (409), filters by year", async () => {
    const admin = await adminHeaders();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-01-26", name: "Republic Day", type: "national" },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-01-26", name: "Again", type: "national" },
    });
    expect(dup.statusCode).toBe(409);

    // Same date, different scope is a distinct holiday.
    const d = await createUnit(admin, { type: "district", code: "HD", name: "H" });
    const did = (d.json() as { id: string }).id;
    const scoped = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: {
        date: "2026-01-26",
        name: "Local",
        type: "local",
        scope_type: "district",
        scope_id: did,
      },
    });
    expect(scoped.statusCode).toBe(201);
    const scopedDup = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: {
        date: "2026-01-26",
        name: "Local dup",
        type: "local",
        scope_type: "district",
        scope_id: did,
      },
    });
    expect(scopedDup.statusCode).toBe(409);

    // A scope that names nothing, or names a unit of another type, is refused
    // rather than stored as a holiday that applies to nobody.
    const ghost = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-01-27", name: "Ghost", type: "local", scope_type: "district", scope_id: randomUUID() },
    });
    expect(ghost.statusCode).toBe(422);
    expect((ghost.json() as { field_errors: Array<{ field: string }> }).field_errors[0]?.field).toBe("scope_id");
    const wrongType = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-01-27", name: "Wrong", type: "local", scope_type: "mandal", scope_id: did },
    });
    expect(wrongType.statusCode).toBe(422);
    expect((wrongType.json() as { field_errors: Array<{ field: string }> }).field_errors[0]?.field).toBe("scope_type");
    const half = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-01-27", name: "Half", type: "local", scope_id: did },
    });
    expect(half.statusCode).toBe(422);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026",
      headers: admin,
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as { data: Array<{ name: string; scope_type: string | null; scope_name: string | null }> };
    expect(page.data.length).toBe(2);
    // A scoped holiday says which unit, by name, not only by id.
    expect(page.data.find((h) => h.scope_type === "district")?.scope_name).toBe("H");
    expect(page.data.find((h) => h.scope_type === null)?.scope_name).toBeNull();

    const empty = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2030",
      headers: admin,
    });
    expect(((empty.json() as { data: unknown[] }).data ?? []).length).toBe(0);
  });

  it("rejects bad type (422) and requires holiday.manage to create", async () => {
    const admin = await adminHeaders();
    const tlH = await roleHeaders("TEAM_LEAD");
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-08-15", name: "X", type: "sick" },
    });
    expect(bad.statusCode).toBe(422);
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: tlH,
      payload: { date: "2026-08-15", name: "X", type: "national" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  // A-012: PATCH date/name/type/active always existed; nothing on web ever
  // called it. include_inactive is new here -- without it, a deactivated
  // holiday could never be found again to reactivate.
  it("corrects a holiday, deactivates it, and finds it again to reactivate", async () => {
    const admin = await adminHeaders();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-05-01", name: "Labour Day", type: "national" },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const noReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: admin,
      payload: { name: "Labor Day" },
    });
    expect(noReason.statusCode).toBe(422);

    const corrected = await app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: admin,
      payload: { name: "Labor Day", reason: "Fixed the spelling" },
    });
    expect(corrected.statusCode, JSON.stringify(corrected.json())).toBe(200);
    const correctedBody = corrected.json() as { name: string; date: string; active: boolean };
    expect(correctedBody.name).toBe("Labor Day");
    expect(correctedBody.date).toBe("2026-05-01");
    expect(correctedBody.active).toBe(true);

    const deactivated = await app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: admin,
      payload: { active: false, reason: "Observed on a different date this year" },
    });
    expect(deactivated.statusCode).toBe(200);
    expect((deactivated.json() as { active: boolean }).active).toBe(false);

    // Gone from the default (active-only) list...
    const defaultList = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026",
      headers: admin,
    });
    expect((defaultList.json() as { data: Array<{ id: string }> }).data.some((h) => h.id === id)).toBe(false);

    // ...but findable with include_inactive, and marked as such.
    const allList = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026&include_inactive=true",
      headers: admin,
    });
    const found = (allList.json() as { data: Array<{ id: string; active: boolean }> }).data.find((h) => h.id === id);
    expect(found?.active).toBe(false);

    const reactivated = await app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: admin,
      payload: { active: true, reason: "Restored — was withdrawn in error" },
    });
    expect(reactivated.statusCode).toBe(200);
    const backInList = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026",
      headers: admin,
    });
    expect((backInList.json() as { data: Array<{ id: string }> }).data.some((h) => h.id === id)).toBe(true);
  });

  it("requires holiday.manage to PATCH", async () => {
    const admin = await adminHeaders();
    const tlH = await roleHeaders("TEAM_LEAD");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-06-01", name: "Founders Day", type: "manual" },
    });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: tlH,
      payload: { name: "X", reason: "Trying anyway" },
    });
    expect(res.statusCode).toBe(403);
  });

  // Review finding, Task 5e fix round 1: include_inactive was honoured for
  // any holiday.read holder, so a plain reader could see retired holidays
  // by calling the API directly even though only the web UI's "Show
  // retired holidays" toggle checked holiday.manage. No built-in role
  // splits holiday.read from holiday.manage (only SUPER_ADMIN/ADMIN/
  // HR_MANAGER hold either, and HR_MANAGER holds both), so this needs a
  // custom role -- exactly the case RBAC exists to allow, and the one the
  // server, not the UI, has to defend.
  it("keeps include_inactive to holiday.manage holders, even with only holiday.read", async () => {
    const admin = await adminHeaders();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/holidays",
      headers: admin,
      payload: { date: "2026-07-01", name: "Reader Test Day", type: "manual" },
    });
    const id = (created.json() as { id: string }).id;
    const withdrawn = await app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${id}`,
      headers: admin,
      payload: { active: false, reason: "Withdrawn for the read-only filter test" },
    });
    expect(withdrawn.statusCode).toBe(200);

    const roleCode = `HOLREADER${Date.now()}`;
    const role = await pool.query(
      "INSERT INTO roles (org_id, code, name, is_system_role) VALUES ($1,$2,$3,false) RETURNING id",
      [orgId, roleCode, "Holiday Reader"],
    );
    const roleId = (role.rows[0] as { id: string }).id;
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,'holiday.read')",
      [roleId],
    );
    const readerUsername = `u_holreader_${Date.now()}`;
    const hash = await bcrypt.hash("Pass1234!", 4);
    const userRes = await pool.query(
      "INSERT INTO users (org_id, username, password_hash, auth_status) VALUES ($1,$2,$3,'ACTIVE') RETURNING id",
      [orgId, readerUsername, hash],
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)", [
      (userRes.rows[0] as { id: string }).id,
      roleId,
    ]);
    const reader = await headersFor(readerUsername, "Pass1234!");

    const asReader = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026&include_inactive=true",
      headers: reader,
    });
    expect(asReader.statusCode).toBe(403);
    expect((asReader.json() as { code: string }).code).toBe("FORBIDDEN");

    // Plain read (no include_inactive) still works for a mere reader.
    const plain = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026",
      headers: reader,
    });
    expect(plain.statusCode).toBe(200);

    // A manager still gets the inactive rows.
    const asManager = await app.inject({
      method: "GET",
      url: "/api/v1/holidays?year=2026&include_inactive=true",
      headers: admin,
    });
    expect(asManager.statusCode).toBe(200);
    expect(
      (asManager.json() as { data: Array<{ id: string }> }).data.some((h) => h.id === id),
    ).toBe(true);
  });
});

/**
 * AP demo-data seeder for Silverline ERP (SEED BUILDER).
 *
 * Populates EVERY existing table with realistic Andhra Pradesh demo data.
 * Idempotent: looks up by unique code/username first, skips existing.
 * NEVER truncates. Talks to the API over HTTP, plus direct `pg` inserts
 * ONLY for `users` / `user_roles` (no user-create endpoint exists).
 *
 * Env:
 *   DEMO_API_URL    default http://localhost:3101
 *   DEMO_ADMIN_USER default admin
 *   DEMO_ADMIN_PASS default ChangeMe123!
 *   DATABASE_URL    default postgresql://localhost:5432/silverline_dev
 *                   (verification runs use silverline_test)
 *
 * Run (from apps/api/):
 *   DEMO_API_URL=http://localhost:3101 DATABASE_URL=postgresql://localhost:5432/silverline_test \
 *     npx tsx src/scripts/seed-demo-ap.ts
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool } from "pg";

const API = process.env["DEMO_API_URL"] ?? "http://localhost:3101";
const ADMIN_USER = process.env["DEMO_ADMIN_USER"] ?? "admin";
const ADMIN_PASS = process.env["DEMO_ADMIN_PASS"] ?? "ChangeMe123!";
const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev";
const USER_PASSWORD = "Test@123";
const YEAR = new Date().getFullYear(); // leave balances / current-year data

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const counts: Record<string, number> = {};
function bump(k: string, n = 1): void {
  counts[k] = (counts[k] ?? 0) + n;
}
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
interface LoginResp {
  access_token: string;
  user: { id: string; org_id: string; username: string };
}

async function login(username: string, password: string): Promise<LoginResp> {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) {
    throw new Error(
      `login failed for ${username}: ${res.status} ${JSON.stringify(body)}`,
    );
  }
  return body as unknown as LoginResp;
}

let lastLoginAt = 0;
/** Login throttled to stay under the 10/min/IP login rate limiter. */
async function throttledLogin(username: string, password: string): Promise<LoginResp> {
  for (let attempt = 0; ; attempt += 1) {
    const gap = 7000 - (Date.now() - lastLoginAt);
    if (gap > 0) await sleep(gap);
    lastLoginAt = Date.now();
    try {
      return await login(username, password);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes(" 429") || attempt >= 5) throw err;
      await sleep(20000);
    }
  }
}

let adminToken = "";
let adminId = "";
let orgId = "";
const tokenCache = new Map<string, string>();

async function tokenFor(username: string): Promise<string> {
  if (username === ADMIN_USER) return adminToken;
  const hit = tokenCache.get(username);
  if (hit) return hit;
  const s = await throttledLogin(username, USER_PASSWORD);
  tokenCache.set(username, s.access_token);
  return s.access_token;
}

interface ApiOpts {
  idem?: boolean;
  ifMatch?: number;
  /** username whose token to use (default: admin) */
  as?: string;
}

/** Raw request; throws on unexpected status. Returns {status, body}. */
async function api(
  method: string,
  path: string,
  body: unknown,
  opts: ApiOpts = {},
  // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
): Promise<{ status: number; body: any }> {
  const idemKey = opts.idem === false ? undefined : randomUUID();
  const attempt = async (
    token: string,
    // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
  ): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (idemKey && (method === "POST" || method === "PUT")) {
      headers["Idempotency-Key"] = idemKey;
    }
    if (opts.ifMatch !== undefined) headers["If-Match"] = String(opts.ifMatch);
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  };

  const user = opts.as ?? ADMIN_USER;
  let token = user === ADMIN_USER ? adminToken : await tokenFor(user);
  let out = await attempt(token);
  if (out.status === 401 && user !== ADMIN_USER) {
    tokenCache.delete(user);
    token = await tokenFor(user);
    out = await attempt(token);
  } else if (out.status === 401 && user === ADMIN_USER) {
    const s = await throttledLogin(ADMIN_USER, ADMIN_PASS);
    adminToken = s.access_token;
    out = await attempt(adminToken);
  }
  return out;
}

function fail(
  what: string,
  status: number,
  // biome-ignore lint/suspicious/noExplicitAny: error payloads vary
  body: any,
): never {
  throw new Error(`${what}: HTTP ${status} ${JSON.stringify(body)}`);
}

/** GET a cursor-paginated list, following next_cursor. */
async function listAll(
  path: string,
  // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
): Promise<any[]> {
  const out: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const sep = path.includes("?") ? "&" : "?";
    const r = await api("GET", `${path}${sep}${qs}`, undefined, {
      idem: false,
    });
    if (r.status !== 200) fail(`GET ${path}`, r.status, r.body);
    const data = (r.body?.data ?? []) as unknown[];
    out.push(...data);
    cursor = (r.body?.next_cursor as string | null) ?? null;
    if (!r.body?.has_more || !cursor) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static demo data
// ---------------------------------------------------------------------------
const DISTRICTS = [
  { code: "AP-VSKP", name: "Visakhapatnam" },
  { code: "AP-KRI", name: "Krishna" },
  { code: "AP-GNT", name: "Guntur" },
];
const MANDALS = [
  { code: "AP-GAJ", name: "Gajuwaka", parent: "AP-VSKP" },
  { code: "AP-ANP", name: "Anakapalli", parent: "AP-VSKP" },
  { code: "AP-VJU", name: "Vijayawada Urban", parent: "AP-KRI" },
  { code: "AP-MPM", name: "Machilipatnam", parent: "AP-KRI" },
  { code: "AP-GNE", name: "Guntur East", parent: "AP-GNT" },
  { code: "AP-TEN", name: "Tenali", parent: "AP-GNT" },
];
// NOTE deviation: the brief names 10 villages but requires 12 (2 per mandal);
// AP-VJT (Vijayawada Urban) and AP-CHL (Machilipatnam) are added to reach 12.
const VILLAGES = [
  { code: "AP-PED", name: "Pedagantyada", parent: "AP-GAJ" },
  { code: "AP-GJT", name: "Gajuwaka Town", parent: "AP-GAJ" },
  { code: "AP-KSK", name: "Kasimkota", parent: "AP-ANP" },
  { code: "AP-ANT", name: "Anakapalli Town", parent: "AP-ANP" },
  { code: "AP-GUN", name: "Gunadala", parent: "AP-VJU" },
  { code: "AP-VJT", name: "Vijayawada Town", parent: "AP-VJU" },
  { code: "AP-MPT", name: "Machilipatnam Town", parent: "AP-MPM" },
  { code: "AP-CHL", name: "Chilakalapudi", parent: "AP-MPM" },
  { code: "AP-NAL", name: "Nallapadu", parent: "AP-GNE" },
  { code: "AP-GNW", name: "Guntur Town", parent: "AP-GNE" },
  { code: "AP-DUG", name: "Duggirala", parent: "AP-TEN" },
  { code: "AP-TET", name: "Tenali Town", parent: "AP-TEN" },
];
const SITES = [
  { code: "AP-SITE-01", name: "Gajuwaka Steel Gate Works", village: "AP-GJT", lat: 17.68, lng: 83.02 },
  { code: "AP-SITE-02", name: "Anakapalli Road Survey", village: "AP-ANT", lat: 17.69, lng: 83.0 },
  { code: "AP-SITE-03", name: "Vijayawada Ring Road Camp", village: "AP-GUN", lat: 16.52, lng: 80.63 },
  { code: "AP-SITE-04", name: "Machilipatnam Port Approach", village: "AP-MPT", lat: 16.19, lng: 81.14 },
  { code: "AP-SITE-05", name: "Guntur Market Yard Site", village: "AP-NAL", lat: 16.3, lng: 80.43 },
  { code: "AP-SITE-06", name: "Tenali Drain Works", village: "AP-TET", lat: 16.24, lng: 80.64 },
  { code: "AP-SITE-07", name: "Kasimkota Pipeline Camp", village: "AP-KSK", lat: 17.68, lng: 82.95 },
  { code: "AP-SITE-08", name: "Duggirala Field Survey", village: "AP-DUG", lat: 16.27, lng: 80.6 },
];

const FIRST = [
  "Srinivas", "Venkatesh", "Ravi", "Krishna", "Prasad", "Ramesh", "Suresh",
  "Anil", "Kishore", "Naveen", "Satish", "Mohan", "Hari", "Gopi", "Mahesh",
  "Rajesh", "Kiran", "Praveen", "Sudheer", "Nagaraju", "Venu", "Balaji",
  "Chaitanya", "Divya", "Lakshmi", "Padma", "Anitha", "Sunitha", "Kavya",
  "Priya", "Deepika", "Swathi", "Madhavi", "Jahnavi", "Ramana", "Koteswara",
];
const LAST = [
  "Rao", "Reddy", "Naidu", "Chowdary", "Varma", "Raju", "Kumar", "Murthy",
  "Babu", "Goud", "Patnaik", "Das", "Yadav", "Achari", "Gupta", "Ali",
];
const SITE_ROLES: Array<{ desig: string; salary: number }> = [
  { desig: "Supervisor", salary: 35000 },
  { desig: "Site Engineer", salary: 45000 },
  { desig: "Surveyor", salary: 30000 },
  { desig: "Mason", salary: 18000 },
  { desig: "Electrician", salary: 25000 },
  { desig: "Driver", salary: 20000 },
  { desig: "Helper", salary: 15000 },
];

const PROJECTS = [
  { code: "AP-PRJ-01", name: "Vijayawada Ring Road Phase 2", ptype: "fieldwork", site: 0 },
  { code: "AP-PRJ-02", name: "Gajuwaka Water Pipeline", ptype: "fieldwork", site: 1 },
  { code: "AP-PRJ-03", name: "Machilipatnam Port Approach Road", ptype: "general", site: 2 },
  { code: "AP-PRJ-04", name: "Guntur Drainage Modernization", ptype: "general", site: 3 },
  { code: "AP-PRJ-05", name: "Tenali Household Survey 2026", ptype: "fieldwork", site: 4 },
];
const LABEL_SET = ["Urgent", "Rework", "Client-facing", "Survey", "Monsoon"];

const HOLIDAYS = [
  { date: `${YEAR}-01-14`, name: "Sankranti", type: "regional" },
  { date: `${YEAR}-01-26`, name: "Republic Day", type: "national" },
  { date: `${YEAR}-03-19`, name: "Ugadi", type: "regional" },
  { date: `${YEAR}-05-01`, name: "May Day", type: "national" },
  { date: `${YEAR}-08-15`, name: "Independence Day", type: "national" },
  { date: `${YEAR}-10-20`, name: "Dasara", type: "regional" },
  { date: `${YEAR}-11-08`, name: "Diwali", type: "national" },
  { date: `${YEAR}-12-25`, name: "Christmas", type: "national" },
];

// ---------------------------------------------------------------------------
// Lookups (idempotency: find-before-create)
// ---------------------------------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: API shapes vary
async function findUnit(type: string, code: string): Promise<any | null> {
  const rows = await listAll(
    `/api/v1/org/units?type=${type}&q=${encodeURIComponent(code)}`,
  );
  return rows.find((r) => r.code === code) ?? null;
}

// biome-ignore lint/suspicious/noExplicitAny: API shapes vary
async function ensureUnit(type: string, code: string, name: string, parentId?: string): Promise<any> {
  const hit = await findUnit(type, code);
  if (hit) return hit;
  const body: Record<string, unknown> = { type, code, name };
  if (parentId) body["parent_id"] = parentId;
  const r = await api("POST", "/api/v1/org/units", body);
  if (r.status === 201) {
    bump("org_units");
    return r.body;
  }
  if (r.status === 409 || r.status === 422) {
    const retry = await findUnit(type, code);
    if (retry) return retry;
  }
  return fail(`POST org unit ${code}`, r.status, r.body);
}

// biome-ignore lint/suspicious/noExplicitAny: API shapes vary
async function findEmployee(empNo: string): Promise<any | null> {
  const rows = await listAll(`/api/v1/employees?q=${encodeURIComponent(empNo)}`);
  return rows.find((r) => r.emp_no === empNo) ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const t0 = Date.now();
  const boot = await login(ADMIN_USER, ADMIN_PASS);
  lastLoginAt = Date.now();
  adminToken = boot.access_token;
  adminId = boot.user.id;
  orgId = boot.user.org_id;
  console.log(`seed-demo-ap: api=${API} org=${orgId} admin=${ADMIN_USER}`);

  const pool = new Pool({ connectionString: DATABASE_URL });

  // ---- 1. Geography -------------------------------------------------------
  const unitByCode = new Map<string, { id: string; type: string }>();
  for (const d of DISTRICTS) {
    const u = await ensureUnit("district", d.code, d.name);
    unitByCode.set(d.code, u);
  }
  for (const m of MANDALS) {
    const u = await ensureUnit(
      "mandal",
      m.code,
      m.name,
      unitByCode.get(m.parent)?.id,
    );
    unitByCode.set(m.code, u);
  }
  for (const v of VILLAGES) {
    const u = await ensureUnit(
      "village",
      v.code,
      v.name,
      unitByCode.get(v.parent)?.id,
    );
    unitByCode.set(v.code, u);
  }
  for (const s of SITES) {
    const u = await ensureUnit(
      "site",
      s.code,
      s.name,
      unitByCode.get(s.village)?.id,
    );
    unitByCode.set(s.code, u);
  }
  const idOf = (code: string): string => {
    const u = unitByCode.get(code);
    if (!u) throw new Error(`unit not found: ${code}`);
    return u.id;
  };
  // village -> {district, mandal} ancestry for employee geo refs
  const villageGeo = new Map<string, { d: string; m: string; v: string }>();
  for (const v of VILLAGES) {
    const mandal = MANDALS.find((m) => m.code === v.parent);
    const district = DISTRICTS.find((d) => d.code === mandal?.parent);
    villageGeo.set(v.code, {
      d: idOf(district?.code ?? ""),
      m: idOf(v.parent),
      v: idOf(v.code),
    });
  }
  console.log(`units: ${JSON.stringify(counts)}`);

  // ---- 2. Employees (DRAFT -> exit -> reactivate => ACTIVE) ---------------
  interface EmpSeed {
    empNo: string;
    first: string;
    last: string;
    desig: string;
    salary: number;
    dept: string;
    siteIdx: number; // -1 = functional
    village: string;
    supervisorEmpNo: string | null;
    exp: number;
  }
  const empSeeds: EmpSeed[] = [];
  let n = 1;
  const pad = (i: number): string => `AP-${String(i).padStart(4, "0")}`;
  for (let s = 0; s < SITES.length; s += 1) {
    const site = SITES[s] as (typeof SITES)[number];
    const supNo = pad(n);
    for (let k = 0; k < SITE_ROLES.length; k += 1) {
      const role = SITE_ROLES[k] as (typeof SITE_ROLES)[number];
      const fi = (s * 7 + k * 3) % FIRST.length;
      const li = (s * 5 + k * 2 + 1) % LAST.length;
      empSeeds.push({
        empNo: pad(n),
        first: FIRST[fi] as string,
        last: LAST[li] as string,
        desig: role.desig,
        salary: role.salary,
        dept: "Field Operations",
        siteIdx: s,
        village: site.village,
        supervisorEmpNo: k === 0 ? null : supNo,
        exp: role.desig === "Site Engineer" ? 6 + (s % 4) : (s + k) % 8,
      });
      n += 1;
    }
  }
  // Functional employees (HR lead at Guntur Town; payroll; inventory)
  empSeeds.push(
    { empNo: pad(n++), first: "Hema", last: "Hrlead", desig: "HR Manager", salary: 50000, dept: "Human Resources", siteIdx: -1, village: "AP-GNW", supervisorEmpNo: null, exp: 9 },
    { empNo: pad(n++), first: "Vijay", last: "Payroll", desig: "Payroll Officer", salary: 40000, dept: "Finance", siteIdx: -1, village: "AP-GUN", supervisorEmpNo: null, exp: 7 },
    { empNo: pad(n++), first: "Kiran", last: "Stores", desig: "Inventory Manager", salary: 40000, dept: "Stores", siteIdx: -1, village: "AP-PED", supervisorEmpNo: null, exp: 8 },
  );

  // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
  const empByNo = new Map<string, any>();
  // Create supervisors/functional (no reports_to) first, then the rest.
  const ordered = [...empSeeds].sort((a, b) =>
    a.supervisorEmpNo === null && b.supervisorEmpNo !== null
      ? -1
      : a.supervisorEmpNo !== null && b.supervisorEmpNo === null
        ? 1
        : 0,
  );
  for (const e of ordered) {
    let row = await findEmployee(e.empNo);
    if (!row) {
      const idx = empSeeds.indexOf(e);
      const dojY = 2022 + (idx % 2);
      const dojM = String(1 + ((idx * 3) % 4)).padStart(2, "0"); // Jan-Apr
      const dojD = String(1 + ((idx * 7) % 27)).padStart(2, "0");
      const geo = villageGeo.get(e.village);
      const body: Record<string, unknown> = {
        emp_no: e.empNo,
        first_name: e.first,
        last_name: e.last,
        phone: `+91900${String(10000 + idx).slice(-5)}`,
        email: `${e.empNo.toLowerCase().replace("-", "")}@ap-demo.local`,
        district_id: geo?.d,
        mandal_id: geo?.m,
        village_id: geo?.v,
        designation: e.desig,
        department: e.dept,
        date_of_joining: `${dojY}-${dojM}-${dojD}`,
        salary_basic: e.salary,
        bank_name: "AP Demo Bank",
        bank_account: `APBANK${String(100000 + idx)}`,
        bank_ifsc: "APDB0001234",
        aadhaar: `9999${String(10000000 + idx).slice(-8)}`,
        pan: `APSPX${String(1000 + (idx % 9000))}${String.fromCharCode(65 + (idx % 26))}`,
        education: e.desig === "Helper" ? "10th Pass" : "ITI",
        skills: ["fieldwork", "safety"],
        experience_years: e.exp,
      };
      const sup = e.supervisorEmpNo ? empByNo.get(e.supervisorEmpNo) : null;
      // NOTE: reports_to is patched AFTER the exit->reactivate lifecycle —
      // the API requires the manager to already be ACTIVE at create time.
      void sup;
      const r = await api("POST", "/api/v1/employees", body);
      if (r.status === 201) {
        row = r.body;
        bump("employees");
      } else if (r.status === 409 || r.status === 422) {
        row = await findEmployee(e.empNo);
        if (!row) fail(`POST employee ${e.empNo}`, r.status, r.body);
      } else {
        fail(`POST employee ${e.empNo}`, r.status, r.body);
      }
    }
    empByNo.set(e.empNo, row);
  }
  // Lifecycle: DRAFT -> EXITED (2024-06-01, "demo activation") -> ACTIVE.
  for (const e of empSeeds) {
    const row = empByNo.get(e.empNo) as { id: string; status: string };
    if (row.status !== "EXITED" && row.status !== "ACTIVE") {
      const r = await api("POST", `/api/v1/employees/${row.id}/exit`, {
        exit_date: "2024-06-01",
        reason: "demo activation",
      });
      if (r.status !== 200 && r.status !== 422) {
        fail(`exit ${e.empNo}`, r.status, r.body);
      } else {
        bump("employee_exits");
      }
    }
    const cur = (await findEmployee(e.empNo)) as {
      id: string;
      status: string;
    };
    if (cur.status !== "ACTIVE") {
      const r = await api(
        "POST",
        `/api/v1/employees/${cur.id}/reactivate`,
        { reason: "demo activation" },
      );
      if (r.status !== 200) fail(`reactivate ${e.empNo}`, r.status, r.body);
      bump("employee_reactivations");
      empByNo.set(e.empNo, await findEmployee(e.empNo));
    }
  }
  console.log(`employees: ${JSON.stringify(counts)}`);

  // Wire reports_to now that every manager is ACTIVE (PATCH + If-Match).
  for (const e of empSeeds) {
    if (!e.supervisorEmpNo) continue;
    const row = (await findEmployee(e.empNo)) as {
      id: string;
      version: number;
      reports_to: string | null;
    };
    if (row.reports_to) continue;
    const sup = (await findEmployee(e.supervisorEmpNo)) as { id: string };
    const r = await api(
      "PATCH",
      `/api/v1/employees/${row.id}`,
      { reports_to: sup.id },
      { ifMatch: row.version, idem: false },
    );
    if (r.status === 200) bump("employee_reports_to");
    else if (r.status !== 422 && r.status !== 409) {
      fail(`reports_to ${e.empNo}`, r.status, r.body);
    }
  }

  // ---- 3. Users + roles (direct SQL — no endpoint exists) -----------------
  const usedNames = new Set<string>();
  const usernameFor = (first: string, last: string): string => {
    const base = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
    let u = base;
    let i = 2;
    while (usedNames.has(u)) {
      u = `${base}${i}`;
      i += 1;
    }
    usedNames.add(u);
    return u;
  };
  interface UserRec {
    username: string;
    id: string;
    empNo: string | null;
    roles: string[];
  }
  const usersByEmp = new Map<string, UserRec>();
  const usersByName = new Map<string, UserRec>();
  const hash = await bcrypt.hash(USER_PASSWORD, 4);
  async function ensureUser(
    username: string,
    employeeId: string | null,
    roleCodes: string[],
  ): Promise<UserRec> {
    const existing = await pool.query(
      "SELECT id, username, employee_id FROM users WHERE org_id = $1 AND username = $2",
      [orgId, username],
    );
    let id: string;
    if ((existing.rowCount ?? 0) === 0) {
      const ins = await pool.query(
        `INSERT INTO users (org_id, username, email, password_hash, employee_id)
         VALUES ($1, $2, $3, $4, $5::uuid) RETURNING id`,
        [orgId, username, `${username}@ap-demo.local`, hash, employeeId],
      );
      id = (ins.rows[0] as { id: string }).id;
      bump("users");
    } else {
      id = (existing.rows[0] as { id: string }).id;
      if (employeeId) {
        await pool.query(
          "UPDATE users SET employee_id = $2::uuid WHERE id = $1::uuid AND employee_id IS NULL",
          [id, employeeId],
        );
      }
    }
    for (const code of roleCodes) {
      const role = await pool.query("SELECT id FROM roles WHERE code = $1", [
        code,
      ]);
      if ((role.rowCount ?? 0) === 0) {
        throw new Error(`role not found: ${code}`);
      }
      const roleId = (role.rows[0] as { id: string }).id;
      const up = await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING",
        [id, roleId],
      );
      if ((up.rowCount ?? 0) > 0) bump("user_roles");
    }
    const rec: UserRec = {
      username,
      id,
      empNo: null,
      roles: roleCodes,
    };
    usersByName.set(username, rec);
    return rec;
  }

  // NOTE deviation: user_roles has no scope_type/scope_id columns and auth
  // carries no scope — roles are granted unscoped; intended scope is recorded
  // in the final USERNAMES table only.
  const pmEmpNos = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const p = PROJECTS[i] as (typeof PROJECTS)[number];
    const siteEmps = empSeeds.filter((e) => e.siteIdx === p.site);
    const eng = siteEmps.find((e) => e.desig === "Site Engineer");
    if (eng) pmEmpNos.add(eng.empNo);
  }
  const supervisorNos = new Set(
    empSeeds.filter((e) => e.desig === "Supervisor").map((e) => e.empNo),
  );
  // Two-pass: create all linked users as EMPLOYEE (+TEAM_LEAD for
  // supervisors); upgrade the 5 PMs after projects exist.
  for (const e of empSeeds) {
    const uname = usernameFor(e.first, e.last);
    const roles = ["EMPLOYEE"];
    if (supervisorNos.has(e.empNo)) roles.push("TEAM_LEAD");
    if (e.desig === "HR Manager") roles.push("HR_MANAGER");
    if (e.desig === "Payroll Officer") roles.push("PAYROLL_OFFICER");
    if (e.desig === "Inventory Manager") roles.push("INVENTORY_MANAGER");
    const empRow = empByNo.get(e.empNo) as { id: string };
    const rec = await ensureUser(uname, empRow.id, roles);
    rec.empNo = e.empNo;
    usersByEmp.set(e.empNo, rec);
  }
  const auditor = await ensureUser("ap.auditor", null, ["AUDITOR"]);
  const client = await ensureUser("ap.client", null, ["CLIENT_VIEWER"]);
  console.log(`users: ${JSON.stringify(counts)}`);

  // ---- 4. Leave balances (CL 12 / SL 12 / EL 15, current year) ------------
  const typeRows = (
    await api("GET", "/api/v1/leave/types", undefined, { idem: false })
  ).body as { data: Array<{ id: string; code: string }> };
  const typeByCode = new Map(
    (typeRows.data ?? []).map((t) => [t.code, t.id]),
  );
  for (const e of empSeeds) {
    const empRow = empByNo.get(e.empNo) as { id: string };
    for (const [code, opening] of [["CL", 12], ["SL", 12], ["EL", 15]] as const) {
      const r = await api("POST", "/api/v1/leave/balances", {
        employee_id: empRow.id,
        leave_type_id: typeByCode.get(code),
        period_year: YEAR,
        opening_balance: opening,
      });
      if (r.status !== 201 && r.status !== 200) {
        fail(`balance ${e.empNo}/${code}`, r.status, r.body);
      }
      bump("leave_balances");
    }
  }
  console.log(`balances: ${JSON.stringify(counts)}`);

  // ---- 5. Leave requests (8 approved past + 4 pending future) -------------
  // Non-supervisor requesters so the chain is [supervisor-TL, admin].
  const nonSup = empSeeds.filter(
    (e) => e.desig !== "Supervisor" && e.siteIdx >= 0,
  );
  const approvedDates = [
    [`${YEAR}-01-12`, `${YEAR}-01-13`],
    [`${YEAR}-02-09`, `${YEAR}-02-10`],
    [`${YEAR}-03-09`, `${YEAR}-03-10`],
    [`${YEAR}-04-13`, `${YEAR}-04-14`],
    [`${YEAR}-05-11`, `${YEAR}-05-12`],
    [`${YEAR}-06-08`, `${YEAR}-06-09`],
    [`${YEAR}-07-13`, `${YEAR}-07-14`],
    [`${YEAR}-08-10`, `${YEAR}-08-11`],
  ] as const;
  const pendingDates = [
    [`${YEAR}-10-05`, `${YEAR}-10-07`],
    [`${YEAR}-10-12`, `${YEAR}-10-13`],
    [`${YEAR}-11-02`, `${YEAR}-11-03`],
    [`${YEAR}-11-16`, `${YEAR}-11-17`],
  ] as const;
  const clId = typeByCode.get("CL");
  async function fileLeave(
    empNo: string,
    from: string,
    to: string,
    reason: string,
    // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
  ): Promise<any> {
    const empRow = empByNo.get(empNo) as { id: string };
    const existing = await listAll(
      `/api/v1/leave/requests?employee_id=${empRow.id}&status=PENDING`,
    );
    const dupP = existing.find(
      (r) => r.from_date === from && r.to_date === to,
    );
    const existingA = await listAll(
      `/api/v1/leave/requests?employee_id=${empRow.id}&status=APPROVED`,
    );
    const dupA = existingA.find(
      (r) => r.from_date === from && r.to_date === to,
    );
    if (dupP ?? dupA) return (dupP ?? dupA) as unknown;
    const r = await api("POST", "/api/v1/leave/requests", {
      leave_type_id: clId,
      from_date: from,
      to_date: to,
      reason,
      employee_id: empRow.id,
    });
    if (r.status === 201) {
      bump("leave_requests");
      return r.body;
    }
    if (r.status === 200 && r.body?.request) return r.body.request; // idempotent replay
    if (r.status === 422 || r.status === 409) {
      const retry =
        (await listAll(`/api/v1/leave/requests?employee_id=${empRow.id}`)).find(
          (x) => x.from_date === from && x.to_date === to,
        ) ?? null;
      if (retry) return retry;
    }
    return fail(`leave ${empNo} ${from}`, r.status, r.body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
  async function approveChain(req: any): Promise<void> {
    for (let step = 0; step < 2; step += 1) {
      const detail = (
        await api("GET", `/api/v1/leave/requests/${req.id}`, undefined, {
          idem: false,
        })
      ).body as {
        status: string;
        version: number;
        current_approver_id: string | null;
      };
      if (detail.status !== "PENDING" || !detail.current_approver_id) return;
      const approver = [...usersByName.values()].find(
        (u) => u.id === detail.current_approver_id,
      );
      const asUser = approver ? approver.username : ADMIN_USER;
      const d = await api(
        "POST",
        `/api/v1/leave/requests/${req.id}/decision`,
        { decision: "APPROVE", note: "AP demo approval" },
        { ifMatch: detail.version, as: asUser, idem: false },
      );
      if (d.status !== 200) fail(`decide ${req.id}`, d.status, d.body);
      bump("leave_decisions");
    }
  }
  for (let i = 0; i < approvedDates.length; i += 1) {
    const e = nonSup[(i * 5 + 1) % nonSup.length] as (typeof nonSup)[number];
    const [from, to] = approvedDates[i] as (typeof approvedDates)[number];
    const req = await fileLeave(e.empNo, from, to, "AP demo approved leave");
    if (req.status === "PENDING") await approveChain(req);
  }
  for (let i = 0; i < pendingDates.length; i += 1) {
    const e = nonSup[(i * 7 + 3) % nonSup.length] as (typeof nonSup)[number];
    const [from, to] = pendingDates[i] as (typeof pendingDates)[number];
    await fileLeave(e.empNo, from, to, "AP demo pending leave");
  }
  console.log(`leave: ${JSON.stringify(counts)}`);

  // ---- 6. Attendance punches (admin token, <=25/min => 2.5 s pacing) -------
  const nowIso = (): string => new Date().toISOString();
  async function punch(empNo: string, event: "CHECK_IN" | "CHECK_OUT"): Promise<void> {
    const empRow = empByNo.get(empNo) as { id: string };
    const r = await api("POST", "/api/v1/attendance/events", {
      employee_id: empRow.id,
      event_type: event,
      client_timestamp: nowIso(),
    });
    if (r.status === 201 || r.status === 200) {
      bump(event === "CHECK_IN" ? "punches_in" : "punches_out");
    } else if (r.status === 422 || r.status === 429) {
      // DUPLICATE_CHECKIN / RECORD_CLOSED / replay => treat as exists.
      bump(event === "CHECK_IN" ? "punches_in" : "punches_out");
    } else {
      fail(`punch ${event} ${empNo}`, r.status, r.body);
    }
    await sleep(2500);
  }
  for (const e of empSeeds) {
    await punch(e.empNo, "CHECK_IN");
  }
  for (let i = 0; i < empSeeds.length && i < 15; i += 1) {
    const e = empSeeds[i] as (typeof empSeeds)[number];
    await punch(e.empNo, "CHECK_OUT");
  }
  console.log(`punches: ${JSON.stringify(counts)}`);

  // ---- 8. Holidays (8 org-wide + 1 local village) --------------------------
  for (const h of HOLIDAYS) {
    const rows = await listAll(`/api/v1/holidays?year=${YEAR}`);
    if (!rows.some((x) => x.date?.slice(0, 10) === h.date && x.name === h.name)) {
      const r = await api("POST", "/api/v1/holidays", {
        date: h.date,
        name: h.name,
        type: h.type,
      });
      if (r.status === 201) bump("holidays");
      else if (r.status !== 409 && r.status !== 422) {
        fail(`holiday ${h.name}`, r.status, r.body);
      }
    }
  }
  {
    const rows = await listAll(`/api/v1/holidays?year=${YEAR}`);
    if (!rows.some((x) => x.name === "AP Gajuwaka Town Festival")) {
      const r = await api("POST", "/api/v1/holidays", {
        date: `${YEAR}-09-21`,
        name: "AP Gajuwaka Town Festival",
        type: "local",
        scope_type: "village",
        scope_id: idOf("AP-GJT"),
      });
      if (r.status === 201) bump("holidays");
      else if (r.status !== 409 && r.status !== 422) {
        fail("local holiday", r.status, r.body);
      }
    }
  }
  console.log(`holidays: ${JSON.stringify(counts)}`);

  // ---- 9. Workspace + projects --------------------------------------------
  const wsList = await listAll("/api/v1/workspaces");
  let workspace = wsList.find((w) => w.name === "AP Demo Workspace") ?? null;
  if (!workspace) {
    const r = await api("POST", "/api/v1/workspaces", {
      name: "AP Demo Workspace",
      description: "Andhra Pradesh demo workspace",
    });
    if (r.status !== 201) fail("workspace", r.status, r.body);
    workspace = r.body;
    bump("workspaces");
  }
  const ptypeRows = (
    await api("GET", "/api/v1/project-types", undefined, { idem: false })
  ).body as { data: Array<{ id: string; code: string }> };
  const ptypeByCode = new Map(
    (ptypeRows.data ?? []).map((t) => [t.code, t.id]),
  );
  // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
  const projByCode = new Map<string, any>();
  for (const p of PROJECTS) {
    const rows = await listAll(
      `/api/v1/projects?q=${encodeURIComponent(p.code)}`,
    );
    let proj = rows.find((x) => x.code === p.code) ?? null;
    if (!proj) {
      const siteEmps = empSeeds.filter((e) => e.siteIdx === p.site);
      const eng = siteEmps.find((e) => e.desig === "Site Engineer");
      const pmUser = eng ? usersByEmp.get(eng.empNo) : undefined;
      const r = await api("POST", "/api/v1/projects", {
        workspace_id: workspace.id,
        code: p.code,
        name: p.name,
        description: `AP demo project: ${p.name}`,
        project_type_id: ptypeByCode.get(p.ptype),
        project_manager_id: pmUser?.id,
        planned_start_date: `${YEAR}-01-05`,
        planned_end_date: `${YEAR}-12-20`,
        priority: "HIGH",
      });
      if (r.status === 201) {
        proj = r.body;
        bump("projects");
      } else if (r.status === 409 || r.status === 422) {
        proj =
          (await listAll(`/api/v1/projects?q=${encodeURIComponent(p.code)}`)).find(
            (x) => x.code === p.code,
          ) ?? null;
        if (!proj) fail(`project ${p.code}`, r.status, r.body);
      } else {
        fail(`project ${p.code}`, r.status, r.body);
      }
    }
    if (proj.status === "DRAFT") {
      const r = await api(
        "PATCH",
        `/api/v1/projects/${proj.id}`,
        { status: "ACTIVE" },
        { ifMatch: proj.version, idem: false },
      );
      if (r.status === 200) {
        proj = r.body;
        bump("project_activations");
      } else if (r.status !== 409 && r.status !== 422) {
        fail(`activate ${p.code}`, r.status, r.body);
      }
    }
    projByCode.set(p.code, proj);
  }
  // Second pass: upgrade the 5 engineers to PROJECT_MANAGER (project scope
  // recorded in the USERNAMES table; user_roles carries no scope columns).
  for (const empNo of pmEmpNos) {
    const u = usersByEmp.get(empNo);
    if (!u) continue;
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [
      "PROJECT_MANAGER",
    ]);
    const up = await pool.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING",
      [u.id, (role.rows[0] as { id: string }).id],
    );
    if ((up.rowCount ?? 0) > 0) {
      bump("user_roles");
      u.roles.push("PROJECT_MANAGER");
    }
  }
  console.log(`projects: ${JSON.stringify(counts)}`);

  // ---- 10. Tasks + subtasks + deps + transitions + comments + evidence ----
  const TASK_DEFS = [
    { title: "Site mobilization and setup", target: "DONE" },
    { title: "Baseline survey round 1", target: "DONE" },
    { title: "Chainage marking", target: "IN_PROGRESS", depOn: 0 },
    { title: "Quality check and review", target: "IN_REVIEW", depOn: 1 },
    { title: "Material reconciliation", target: "TO_DO" },
    { title: "Monsoon contingency planning", target: "BLOCKED" },
    { title: "Client review meeting prep", target: "TO_DO" },
  ] as const;
  const PATHS: Record<string, string[]> = {
    DONE: ["IN_PROGRESS", "IN_REVIEW", "DONE"],
    IN_PROGRESS: ["IN_PROGRESS"],
    IN_REVIEW: ["IN_PROGRESS", "IN_REVIEW"],
    BLOCKED: ["IN_PROGRESS", "BLOCKED"],
    TO_DO: [],
  };
  for (const p of PROJECTS) {
    const proj = projByCode.get(p.code) as {
      id: string;
      project_manager_id: string | null;
    };
    const siteEmps = empSeeds.filter((e) => e.siteIdx === p.site);
    const assigneePool = siteEmps
      .map((e) => usersByEmp.get(e.empNo)?.id)
      .filter((x): x is string => !!x);
    const pmUid: string =
      proj.project_manager_id ?? assigneePool[1] ?? assigneePool[0] ?? adminId;
    const pmName =
      [...usersByName.values()].find((u) => u.id === pmUid)?.username ??
      ADMIN_USER;
    const existing = await listAll(
      `/api/v1/tasks?project_id=${proj.id}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: API shapes vary
    const tasks: any[] = [];
    for (let i = 0; i < TASK_DEFS.length; i += 1) {
      const def = TASK_DEFS[i] as (typeof TASK_DEFS)[number];
      const title = `AP ${p.code} — ${def.title}`;
      let t = existing.find((x) => x.title === title) ?? null;
      if (!t) {
        const r = await api("POST", "/api/v1/tasks", {
          project_id: proj.id,
          title,
          description: `AP demo task: ${def.title} (${p.name})`,
          assignee_id: assigneePool[i % assigneePool.length],
          priority: i % 3 === 0 ? "HIGH" : "MEDIUM",
          planned_start_date: `${YEAR}-02-01`,
          planned_end_date: `${YEAR}-11-30`,
          estimated_hours: 8 + i * 4,
        });
        if (r.status === 201) {
          t = r.body;
          bump("tasks");
        } else if (r.status === 409 || r.status === 422) {
          t =
            (await listAll(`/api/v1/tasks?project_id=${proj.id}`)).find(
              (x) => x.title === title,
            ) ?? null;
          if (!t) fail(`task ${title}`, r.status, r.body);
        } else {
          fail(`task ${title}`, r.status, r.body);
        }
      }
      tasks.push(t);
    }
    // 2 subtasks under T1 (must be terminal before T1 -> DONE).
    for (const st of ["Subtask: gate material unloading", "Subtask: camp power setup"]) {
      const title = `AP ${p.code} — ${st}`;
      if (!existing.some((x) => x.title === title)) {
        const r = await api("POST", "/api/v1/tasks", {
          project_id: proj.id,
          title,
          parent_task_id: (tasks[0] as { id: string }).id,
          assignee_id: assigneePool[0],
          priority: "MEDIUM",
        });
        if (r.status === 201) {
          bump("tasks");
          bump("subtasks");
          // drive subtask straight to DONE
          let cur = r.body as { id: string; version: number };
          for (const s of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
            const tr = await api(
              "PATCH",
              `/api/v1/tasks/${cur.id}/status`,
              { status: s },
              { ifMatch: cur.version, idem: false },
            );
            if (tr.status !== 200) fail(`subtask ${s}`, tr.status, tr.body);
            cur = tr.body as { id: string; version: number };
          }
        } else if (r.status !== 409 && r.status !== 422) {
          fail(`subtask ${title}`, r.status, r.body);
        }
      }
    }
    // Dependencies (acyclic, same project): T3<-T1, T4<-T2.
    for (const [succ, pred] of [[2, 0], [3, 1]] as const) {
      const s = tasks[succ] as { id: string };
      const pr = tasks[pred] as { id: string };
      const r = await api("POST", `/api/v1/tasks/${s.id}/dependencies`, {
        predecessor_id: pr.id,
      });
      if (r.status === 201) bump("task_dependencies");
      else if (r.status !== 409 && r.status !== 422) {
        fail(`dep ${p.code}`, r.status, r.body);
      }
    }
    // Transitions along legal paths (predecessors first: IN_* / DONE gated).
    const order = [0, 1, 2, 3, 5, 4, 6];
    for (const i of order) {
      const def = TASK_DEFS[i] as (typeof TASK_DEFS)[number];
      const path = PATHS[def.target] as string[];
      if (path.length === 0) continue;
      let cur = (
        await api("GET", `/api/v1/tasks/${(tasks[i] as { id: string }).id}`, undefined, {
          idem: false,
        })
      ).body as { status: string; version: number };
      if (cur.status === def.target || cur.status === "DONE") continue;
      for (const s of path) {
        if (cur.status === s) continue;
        const tr = await api(
          "PATCH",
          `/api/v1/tasks/${(tasks[i] as { id: string }).id}/status`,
          { status: s },
          { ifMatch: cur.version, idem: false },
        );
        if (tr.status === 200) {
          cur = tr.body as { status: string; version: number };
          bump("task_transitions");
        } else if (tr.status === 422 || tr.status === 409) {
          cur = (
            await api(
              "GET",
              `/api/v1/tasks/${(tasks[i] as { id: string }).id}`,
              undefined,
              { idem: false },
            )
          ).body as { status: string; version: number };
          break;
        } else {
          fail(`transition ${p.code}/${i} -> ${s}`, tr.status, tr.body);
        }
      }
    }
    // 2 comments on T1 (one with a real @mention -> notification).
    const t1 = tasks[0] as { id: string };
    const comments = await listAll(`/api/v1/tasks/${t1.id}/comments`);
    if (comments.length === 0) {
      const c1 = await api("POST", `/api/v1/tasks/${t1.id}/comments`, {
        body: `@${pmName} please review the mobilization photos for ${p.code}`,
      });
      if (c1.status === 201) bump("task_comments");
      else if (c1.status !== 422 && c1.status !== 409) {
        fail(`comment ${p.code}`, c1.status, c1.body);
      }
      const c2 = await api("POST", `/api/v1/tasks/${t1.id}/comments`, {
        body: `Mobilization complete as per plan for ${p.name} (AP demo).`,
      });
      if (c2.status === 201) bump("task_comments");
      else if (c2.status !== 422 && c2.status !== 409) {
        fail(`comment2 ${p.code}`, c2.status, c2.body);
      }
    }
    // 1 evidence upload on T1.
    {
      const ev = await listAll(`/api/v1/tasks/${t1.id}/evidence`);
      if (ev.length === 0) {
        const r = await api("POST", `/api/v1/tasks/${t1.id}/evidence`, {
          evidence_type: "PHOTO",
          file_name: "ap-site-photo.png",
          content_base64: PNG_1PX,
        });
        if (r.status === 201) bump("task_evidence");
        else if (r.status !== 422 && r.status !== 409) {
          fail(`evidence ${p.code}`, r.status, r.body);
        }
      }
    }
    // Labels: 3 per project + attach.
    const labelNames = [0, 1, 2].map(
      (_, k) => `AP-${LABEL_SET[(PROJECTS.indexOf(p) * 2 + k) % LABEL_SET.length]}`,
    );
    const labelIds: string[] = [];
    for (const name of labelNames) {
      const rows = await listAll(
        `/api/v1/labels?project_id=${proj.id}`,
      );
      let lab = rows.find((x) => x.name === name) ?? null;
      if (!lab) {
        const r = await api("POST", "/api/v1/labels", {
          project_id: proj.id,
          name,
          color: "#2563eb",
        });
        if (r.status === 201) {
          lab = r.body;
          bump("labels");
        } else if (r.status === 409) {
          lab =
            (await listAll(`/api/v1/labels?project_id=${proj.id}`)).find(
              (x) => x.name === name,
            ) ?? null;
          if (!lab) fail(`label ${name}`, r.status, r.body);
        } else {
          fail(`label ${name}`, r.status, r.body);
        }
      }
      labelIds.push(lab.id as string);
    }
    for (const lid of labelIds) {
      const r = await api("POST", `/api/v1/tasks/${t1.id}/labels`, {
        label_id: lid,
      });
      if (r.status === 201 || r.status === 200) bump("task_labels");
      else if (r.status !== 409 && r.status !== 422) {
        fail(`attach label ${p.code}`, r.status, r.body);
      }
    }
    // 1 KANBAN board (auto-columns) + 1 saved filter.
    {
      const boards = await listAll(`/api/v1/boards?project_id=${proj.id}`);
      if (!boards.some((b) => b.name === `AP ${p.code} Board`)) {
        const r = await api("POST", "/api/v1/boards", {
          project_id: proj.id,
          name: `AP ${p.code} Board`,
          view_type: "KANBAN",
        });
        if (r.status === 201) bump("boards");
        else if (r.status !== 409 && r.status !== 422) {
          fail(`board ${p.code}`, r.status, r.body);
        }
      }
    }
    {
      const filters = await listAll(
        `/api/v1/saved-filters?project_id=${proj.id}`,
      );
      if (!filters.some((f) => f.name === `AP ${p.code} Open Work`)) {
        const r = await api("POST", "/api/v1/saved-filters", {
          project_id: proj.id,
          name: `AP ${p.code} Open Work`,
          query_definition: { statuses: ["TO_DO", "IN_PROGRESS", "BLOCKED"] },
          shared: false,
        });
        if (r.status === 201) bump("saved_filters");
        else if (r.status !== 409 && r.status !== 422) {
          fail(`filter ${p.code}`, r.status, r.body);
        }
      }
    }
  }
  console.log(`work: ${JSON.stringify(counts)}`);

  // ---- 11. Employee documents (3 samples) ----------------------------------
  const docTargets = [empSeeds[1], empSeeds[8], empSeeds[15]] as const;
  for (const e of docTargets) {
    const empRow = empByNo.get(e.empNo) as { id: string };
    const docs = await listAll(`/api/v1/employees/${empRow.id}/documents`);
    if (!docs.some((d) => d.file_name === "ap-id-proof.png")) {
      const r = await api("POST", `/api/v1/employees/${empRow.id}/documents`, {
        doc_type: "ID_PROOF",
        file_name: "ap-id-proof.png",
        content_base64: PNG_1PX,
      });
      if (r.status === 201) bump("employee_documents");
      else if (r.status !== 422 && r.status !== 409) {
        fail(`doc ${e.empNo}`, r.status, r.body);
      }
    }
  }

  // ---- 12. Payroll run (current month -> CALCULATED, stays unlocked) -------
  const now = new Date();
  const mStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const mEndStr = `${mEnd.getFullYear()}-${String(mEnd.getMonth() + 1).padStart(2, "0")}-${String(mEnd.getDate()).padStart(2, "0")}`;
  let runId: string | null = null;
  {
    const r = await api("POST", "/api/v1/payroll/runs", {
      period_start: mStart,
      period_end: mEndStr,
    });
    if (r.status === 201) {
      runId = (r.body as { id: string }).id;
      bump("payroll_runs");
    } else if (r.status === 422 || r.status === 409) {
      const runs = await listAll("/api/v1/payroll/runs");
      const hit = runs.find(
        (x) => x.period_start?.slice(0, 10) <= mEndStr && x.period_end?.slice(0, 10) >= mStart,
      );
      if (hit) runId = hit.id as string;
      else fail("payroll run lookup", r.status, r.body);
    } else {
      fail("payroll run", r.status, r.body);
    }
  }
  if (runId) {
    const detail = (
      await api("GET", `/api/v1/payroll/runs/${runId}`, undefined, {
        idem: false,
      })
    ).body as { status: string };
    if (detail.status === "OPEN") {
      const r = await api(
        "POST",
        `/api/v1/payroll/runs/${runId}/calculate`,
        {},
        { idem: false },
      );
      if (r.status === 200 || r.status === 201) bump("payroll_calculations");
      else fail("payroll calculate", r.status, r.body);
    }
  }
  console.log(`payroll/docs: ${JSON.stringify(counts)}`);

  await pool.end();

  // ---- USERNAMES table ------------------------------------------------------
  const villageName = (code: string): string =>
    (VILLAGES.find((v) => v.code === code)?.name ?? code);
  const projOfPm = new Map<string, string>();
  for (const p of PROJECTS) {
    const siteEmps = empSeeds.filter((e) => e.siteIdx === p.site);
    const eng = siteEmps.find((e) => e.desig === "Site Engineer");
    if (eng) {
      const u = usersByEmp.get(eng.empNo);
      if (u) projOfPm.set(u.username, p.code);
    }
  }
  const table = [...usersByName.values()].map((u) => {
    let scope: Record<string, string> | null = null;
    if (u.roles.includes("TEAM_LEAD") && u.empNo) {
      const seed = empSeeds.find((e) => e.empNo === u.empNo);
      const supSeed = seed?.supervisorEmpNo
        ? null
        : empSeeds.find((e) => e.supervisorEmpNo === u.empNo);
      const vcode = supSeed?.village ?? seed?.village ?? "";
      scope = { scope_type: "village", scope_id: vcode, village: villageName(vcode) };
    }
    if (u.roles.includes("PROJECT_MANAGER")) {
      scope = {
        scope_type: "project",
        scope_id: projOfPm.get(u.username) ?? "",
      };
    }
    return {
      username: u.username,
      roles: u.roles,
      scope,
      employee: u.empNo,
    };
  });
  table.push(
    { username: auditor.username, roles: ["AUDITOR"], scope: null, employee: null },
    { username: client.username, roles: ["CLIENT_VIEWER"], scope: null, employee: null },
  );
  console.log("USERNAMES_TABLE_BEGIN");
  console.log(JSON.stringify(table, null, 2));
  console.log("USERNAMES_TABLE_END");
  console.log(`COUNTS ${JSON.stringify(counts)}`);
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`seed-demo-ap done in ${secs}s`);
}

main().catch((err) => {
  console.error(`seed-demo-ap FAILED: ${(err as Error).message}`);
  process.exit(1);
});

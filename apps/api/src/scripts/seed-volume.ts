/**
 * Volume seeder: fills every business table with demo data.
 *
 * Where `seed.ts` establishes the canonical rows a deployment cannot work
 * without (permissions, system roles, leave types, project types, the admin
 * user), this script fills the database out to a usable demo: `TARGET` rows in
 * every table, every column populated, and the whole graph internally
 * consistent so the UI has something real to render.
 *
 * The data is Andhra Pradesh / Telangana field operations — districts, mandals,
 * villages and sites with names an operator there would recognise — because
 * demo data that reads as placeholder text makes a demo look unfinished.
 *
 * Idempotent by construction: every unique business key carries a run-scoped
 * suffix, so a second run adds another batch rather than colliding. It never
 * truncates and never touches rows it did not create.
 *
 *   DATABASE_URL=<session pooler url> npx tsx src/scripts/seed-volume.ts
 */

import "../common/env.js";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool, type PoolClient } from "pg";
import { encryptPii, piiIndex } from "../common/crypto.js";
import { defaultTaskWorkflow } from "@silverline/shared";

/** Rows to create per table. */
const TARGET = Number(process.env["SEED_VOLUME"] ?? 50);

// ---------------------------------------------------------------------------
// Deterministic pseudo-random data, so a run is reproducible when SEED_TAG is
// pinned and varied when it is not.
// ---------------------------------------------------------------------------

const TAG = (process.env["SEED_TAG"] ?? Date.now().toString(36)).slice(-6).toUpperCase();
let counter = 0;
const next = (): number => (counter += 1);

function pick<T>(list: readonly T[], index: number): T {
  return list[index % list.length] as T;
}

const DISTRICTS = [
  "Anantapur", "Chittoor", "East Godavari", "Guntur", "Krishna", "Kurnool",
  "Nellore", "Prakasam", "Srikakulam", "Visakhapatnam", "Vizianagaram",
  "West Godavari", "YSR Kadapa", "Rangareddy", "Medak",
] as const;
const MANDALS = [
  "Kadiri", "Puttur", "Amalapuram", "Tenali", "Gudivada", "Adoni", "Kavali",
  "Ongole", "Palasa", "Bheemunipatnam", "Salur", "Tadepalligudem", "Pulivendula",
  "Shamshabad", "Sangareddy",
] as const;
const VILLAGES = [
  "Kondapur", "Peddapuram", "Nandivelugu", "Chinaganjam", "Rajupalem",
  "Vemulapadu", "Kothapeta", "Gollapalli", "Mylavaram", "Bhogapuram",
] as const;
const SITES = [
  "Canal Head Works", "Substation Yard", "Warehouse 3", "Pump House",
  "Bridge Deck", "Transmission Tower 44", "Water Treatment Plant",
  "Depot Annexe", "Cold Storage", "Feeder Road Package 2",
] as const;
const FIRST_NAMES = [
  "Asha", "Ravi", "Lakshmi", "Venkat", "Sunitha", "Prasad", "Padma", "Naveen",
  "Sridevi", "Ramesh", "Kavitha", "Srinivas", "Anitha", "Mohan", "Divya",
  "Kiran", "Swapna", "Rajesh", "Madhavi", "Suresh",
] as const;
const LAST_NAMES = [
  "Verma", "Reddy", "Naidu", "Rao", "Sharma", "Chowdary", "Prasad", "Kumar",
  "Devi", "Babu", "Murthy", "Lakshmi", "Sastry", "Varma",
] as const;
const DESIGNATIONS = [
  "Site Supervisor", "Field Engineer", "Foreman", "Surveyor", "Electrician",
  "Crane Operator", "Safety Officer", "Storekeeper", "Quality Inspector",
  "Junior Engineer",
] as const;
const DEPARTMENTS = ["Civil", "Electrical", "Mechanical", "Stores", "Quality", "Safety"] as const;
const SKILLS = [
  ["surveying", "total-station"], ["welding", "fabrication"], ["rigging"],
  ["ht-lines", "cable-jointing"], ["shuttering", "concreting"], ["first-aid"],
] as const;

/** A date `days` before today, as YYYY-MM-DD. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function daysAhead(days: number): string {
  return daysAgo(-days);
}
/** A timestamp `hours` before now. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** A distinct, schema-valid Indian mobile number per call. */
function phone(): string {
  return `+919${String(100000000 + next()).slice(0, 9)}`;
}
/** A distinct 12-digit Aadhaar per call. */
function aadhaar(): string {
  return String(200000000000 + next() * 7919).slice(0, 12);
}
function pan(): string {
  const n = next();
  return `AB${String.fromCharCode(67 + (n % 20))}DE${String(1000 + (n % 9000))}Z`;
}
function bankAccount(): string {
  return String(50100000000000 + next() * 131).slice(0, 14);
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Progress {
  [table: string]: number;
}
const made: Progress = {};
function count(table: string, n = 1): void {
  made[table] = (made[table] ?? 0) + n;
}

// ---------------------------------------------------------------------------

export async function seedVolume(pool: Pool): Promise<Progress> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await run(db);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  return made;
}

async function run(db: PoolClient): Promise<void> {
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
    (await db.query(sql, params)).rows[0] as T;
  const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await db.query(sql, params)).rows as T[];

  // ---------------------------------------------------------------- org ---
  // The primary tenant holds the rich, interconnected data; the rest exist to
  // make tenant isolation real at demo scale.
  const primary = await one<{ id: string }>(
    "SELECT id FROM organizations ORDER BY created_at LIMIT 1",
  );
  const orgId = primary.id;

  const orgIds: string[] = [orgId];
  const orgShort = await all<{ n: number }>("SELECT count(*)::int AS n FROM organizations");
  for (let i = (orgShort[0]?.n ?? 1); i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO organizations (name, status, timezone, locale, settings)
       VALUES ($1,$2,'Asia/Kolkata','en',$3::jsonb) RETURNING id`,
      [
        `${pick(DISTRICTS, i)} Infra Works ${TAG}-${i}`,
        i % 11 === 0 ? "SUSPENDED" : "ACTIVE",
        JSON.stringify({
          timezone: "Asia/Kolkata",
          attendance_duplicate_minutes: 5,
          session_timeout_minutes: 10080,
          retention_days: 2555,
        }),
      ],
    );
    orgIds.push(row.id);
    count("organizations");
  }
  // Every tenant needs its payroll policy (UNIQUE per org).
  for (const id of orgIds) {
    const r = await db.query(
      `INSERT INTO payroll_policies (org_id, per_day_divisor, pf_pct)
       VALUES ($1,30,12) ON CONFLICT (org_id) DO NOTHING`,
      [id],
    );
    count("payroll_policies", r.rowCount ?? 0);
  }

  // ------------------------------------------------------- permissions ----
  // Top up to TARGET without inventing codes the RBAC map would not recognise:
  // these are documented as reserved for future modules.
  const permCount = (await one<{ n: number }>("SELECT count(*)::int AS n FROM permissions")).n;
  for (let i = permCount; i < TARGET; i += 1) {
    await db.query(
      `INSERT INTO permissions (code, description, module) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO NOTHING`,
      [`reserved.slot_${i}`, `Reserved for a future module (slot ${i})`, "reserved"],
    );
    count("permissions");
  }

  // ------------------------------------------------------------- roles ----
  const roleRows = await all<{ id: string; code: string }>("SELECT id, code FROM roles");
  const systemRoles = new Map(roleRows.map((r) => [r.code, r.id]));
  for (let i = roleRows.length; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO roles (org_id, code, name, is_system_role, description)
       VALUES ($1,$2,$3,false,$4) RETURNING id`,
      [
        orgId,
        `${TAG}_CREW_${i}`,
        `Crew role ${i}`,
        `Site-scoped crew role for ${pick(SITES, i)}`,
      ],
    );
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       VALUES ($1,'auth.login'),($1,'task.read') ON CONFLICT DO NOTHING`,
      [row.id],
    );
    count("roles");
    count("role_permissions", 2);
  }

  // --------------------------------------------------------- org_units ----
  // A real District → Mandal → Village → Site chain, so scoped reads have a
  // tree to walk.
  const districts: string[] = [];
  const mandals: string[] = [];
  const villages: string[] = [];
  const sites: string[] = [];
  const unitTarget = Math.ceil(TARGET / 4);
  for (let i = 0; i < unitTarget; i += 1) {
    const d = await one<{ id: string }>(
      `INSERT INTO org_units (org_id,type,code,name,parent_id,status,created_by,updated_by,version)
       VALUES ($1,'district',$2,$3,NULL,'ACTIVE',NULL,NULL,1) RETURNING id`,
      [orgId, `D${TAG}${i}`, pick(DISTRICTS, i)],
    );
    districts.push(d.id);
    const m = await one<{ id: string }>(
      `INSERT INTO org_units (org_id,type,code,name,parent_id,status,created_by,updated_by,version)
       VALUES ($1,'mandal',$2,$3,$4,'ACTIVE',NULL,NULL,1) RETURNING id`,
      [orgId, `M${TAG}${i}`, pick(MANDALS, i), d.id],
    );
    mandals.push(m.id);
    const v = await one<{ id: string }>(
      `INSERT INTO org_units (org_id,type,code,name,parent_id,status,created_by,updated_by,version)
       VALUES ($1,'village',$2,$3,$4,'ACTIVE',NULL,NULL,1) RETURNING id`,
      [orgId, `V${TAG}${i}`, pick(VILLAGES, i), m.id],
    );
    villages.push(v.id);
    const s = await one<{ id: string }>(
      `INSERT INTO org_units (org_id,type,code,name,parent_id,status,created_by,updated_by,version)
       VALUES ($1,'site',$2,$3,$4,$5,NULL,NULL,1) RETURNING id`,
      [orgId, `S${TAG}${i}`, pick(SITES, i), v.id, i % 13 === 0 ? "INACTIVE" : "ACTIVE"],
    );
    sites.push(s.id);
    count("org_units", 4);
  }

  // --------------------------------------------------------- employees ----
  const employees: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const first = pick(FIRST_NAMES, i);
    const last = pick(LAST_NAMES, i * 3);
    const aad = aadhaar();
    const p = pan();
    const acct = bankAccount();
    const ppe = phone();
    // A spread of lifecycle states, so every status has rows to look at.
    const status =
      i % 17 === 0 ? "EXITED" : i % 11 === 0 ? "SUSPENDED" : i % 23 === 0 ? "DRAFT" : "ACTIVE";
    const exited = status === "EXITED";
    const row = await one<{ id: string }>(
      `INSERT INTO employees (
         org_id, emp_no, first_name, last_name, father_name, date_of_birth, gender,
         phone, phone_secondary, email, aadhaar_encrypted, pan_encrypted, address,
         district_id, mandal_id, village_id, site_id, designation, department,
         date_of_joining, date_of_exit, exit_reason, exit_approved_by, reports_to,
         salary_basic, bank_name, bank_account_encrypted, bank_ifsc, phonepe_number,
         education, skills, experience_years, status, status_changed_at,
         created_by, updated_by, version, aadhaar_hash, pan_hash, bank_account_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15::uuid,$16::uuid,
               $17::uuid,$18,$19,$20,$21,$22,NULL,$23::uuid,$24,$25,$26,$27,$28,$29,
               $30::jsonb,$31,$32,$33,NULL,NULL,1,$34,$35,$36)
       RETURNING id`,
      [
        orgId,
        `EMP${TAG}${String(i).padStart(3, "0")}`,
        first,
        last,
        `${pick(FIRST_NAMES, i + 5)} ${last}`,
        daysAgo(9000 + i * 37),
        i % 3 === 0 ? "FEMALE" : "MALE",
        phone(),
        phone(),
        `${first.toLowerCase()}.${last.toLowerCase()}${i}@silverline.example`,
        encryptPii(aad),
        encryptPii(p),
        `${pick(VILLAGES, i)}, ${pick(MANDALS, i)} Mandal, ${pick(DISTRICTS, i)}`,
        pick(districts, i),
        pick(mandals, i),
        pick(villages, i),
        pick(sites, i),
        pick(DESIGNATIONS, i),
        pick(DEPARTMENTS, i),
        daysAgo(400 + i * 11),
        exited ? daysAgo(15) : null,
        exited ? "Contract completed at the end of the season" : null,
        // reports_to is filled in a second pass, once ids exist.
        null,
        18000 + (i % 25) * 1500,
        pick(["State Bank of India", "Union Bank", "Andhra Bank", "HDFC Bank"], i),
        encryptPii(acct),
        `SBIN000${String(1000 + i).slice(0, 4)}`,
        ppe,
        pick(["Diploma (Civil)", "ITI Electrician", "B.Tech (Mechanical)", "Class 12"], i),
        JSON.stringify(pick(SKILLS, i)),
        1 + (i % 20),
        status,
        hoursAgo(24 * (i % 60)),
        piiIndex(aad),
        piiIndex(p),
        piiIndex(acct),
      ],
    );
    employees.push(row.id);
    count("employees");
  }
  // Reporting lines: everyone after the first five reports to one of them, so
  // the tree has depth without a cycle.
  for (let i = 5; i < employees.length; i += 1) {
    await db.query("UPDATE employees SET reports_to=$2 WHERE id=$1", [
      employees[i],
      employees[i % 5],
    ]);
  }

  // ------------------------------------------------------------- users ----
  const passwordHash = await bcrypt.hash("Test@1234", 10);
  const users: string[] = [];
  const adminRow = await one<{ id: string }>(
    "SELECT id FROM users ORDER BY created_at LIMIT 1",
  );
  users.push(adminRow.id);
  const roleCycle = [
    "HR_MANAGER", "PROJECT_MANAGER", "TEAM_LEAD", "EMPLOYEE", "PAYROLL_OFFICER",
    "INVENTORY_MANAGER", "AUDITOR", "CLIENT_VIEWER", "ADMIN",
  ];
  for (let i = users.length; i < TARGET; i += 1) {
    const employeeId = employees[i % employees.length]!;
    const user = await one<{ id: string }>(
      `INSERT INTO users (
         org_id, username, phone, email, auth_status, mfa_enabled, mfa_secret,
         last_login_at, failed_login_attempts, locked_until, password_hash,
         employee_id, notification_preferences, mfa_last_counter)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11::uuid,$12::jsonb,$13)
       RETURNING id`,
      [
        orgId,
        `user_${TAG.toLowerCase()}_${i}`,
        phone(),
        `user${i}.${TAG.toLowerCase()}@silverline.example`,
        i % 19 === 0 ? "DISABLED" : "ACTIVE",
        i % 7 === 0,
        i % 7 === 0 ? encryptPii("JBSWY3DPEHPK3PXP") : null,
        hoursAgo(i * 3),
        0,
        passwordHash,
        employeeId,
        JSON.stringify({ push: i % 2 === 0, sms: i % 3 === 0, whatsapp: false }),
        i % 7 === 0 ? Math.floor(Date.now() / 1000 / 30) - 10 : null,
      ],
    );
    users.push(user.id);
    count("users");

    const roleId = systemRoles.get(pick(roleCycle, i));
    if (roleId) {
      // Half the grants are org-wide, half scoped to a district, so scoped
      // reads have something to narrow.
      const scoped = i % 2 === 0;
      await db.query(
        `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
         VALUES ($1,$2,$3,$4::uuid) ON CONFLICT DO NOTHING`,
        [user.id, roleId, scoped ? "district" : null, scoped ? pick(districts, i) : null],
      );
      count("user_roles");
    }
  }

  // ---------------------------------------------------------- sessions ----
  for (let i = 0; i < TARGET; i += 1) {
    await db.query(
      `INSERT INTO sessions (user_id, refresh_hash, family, device, ip, revoked,
         expires_at, last_used_at, revoked_at, device_id)
       VALUES ($1::uuid,$2,$3::uuid,$4,$5::inet,$6,now()+interval '7 days',$7,$8,$9)`,
      [
        pick(users, i),
        sha(`refresh-${TAG}-${i}`),
        randomUUID(),
        pick(["Silverline Android 1.4.0", "Chrome 131 on Windows", "Safari on iOS 18"], i),
        `10.${i % 250}.${(i * 3) % 250}.${(i * 7) % 250}`,
        i % 9 === 0,
        hoursAgo(i),
        i % 9 === 0 ? hoursAgo(i - 1) : null,
        `device-${TAG}-${i}`,
      ],
    );
    count("sessions");
  }

  // ----------------------------------------------- device registrations ---
  const devices: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO device_registrations (org_id,user_id,device_id,push_token,
         revoked_at,wipe_requested_at,last_seen_at)
       VALUES ($1,$2::uuid,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at
       RETURNING id`,
      [
        orgId,
        pick(users, i),
        `handset-${TAG}-${i}`,
        `ExponentPushToken[${TAG}${i}xxxxxxxxxxxxxx]`,
        i % 21 === 0 ? hoursAgo(5) : null,
        i % 21 === 0 ? hoursAgo(5) : null,
        hoursAgo(i % 72),
      ],
    );
    devices.push(row.id);
    count("device_registrations");
  }

  // -------------------------------------------------------- attendance ----
  // No geo-fences (decision 2026-09-22): punches carry a position but are not
  // judged against a boundary, so the fence columns are left at their defaults.
  const activeEmployees = await all<{ id: string }>(
    "SELECT id FROM employees WHERE org_id=$1 AND status='ACTIVE' ORDER BY emp_no",
    [orgId],
  );
  const records: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const employeeId = pick(activeEmployees, i).id;
    const workDate = daysAgo(1 + (i % 45));
    const inEvent = await one<{ id: string }>(
      `INSERT INTO attendance_events (employee_id,event_type,client_timestamp,server_timestamp,
         lat,lng,gps_accuracy,mock_location,device_id,app_version,
         idempotency_key,device_signals)
       VALUES ($1::uuid,'CHECK_IN',$2,$2,$3,$4,$5,$6,$7,'1.4.0',$8,$9::jsonb)
       RETURNING id`,
      [
        employeeId,
        `${workDate}T03:30:00.000Z`,
        17.2 + (i % 40) * 0.02,
        78.2 + (i % 30) * 0.02,
        4 + (i % 20),
        i % 29 === 0,
        `handset-${TAG}-${i}`,
        `seed-${TAG}-in-${i}`,
        JSON.stringify({
          device: {
            is_physical_device: true, device_type: "1", os_name: "Android",
            os_version: "14", manufacturer: "Xiaomi", model_name: "Redmi Note 12",
            os_build_id: `UP1A.${i}`, suspected_emulator: false,
          },
          client_movement: null,
          server_movement: null,
          flagged: false,
        }),
      ],
    );
    const outEvent = await one<{ id: string }>(
      `INSERT INTO attendance_events (employee_id,event_type,client_timestamp,server_timestamp,
         lat,lng,gps_accuracy,mock_location,device_id,app_version,
         idempotency_key,device_signals)
       VALUES ($1::uuid,'CHECK_OUT',$2,$2,$3,$4,$5,false,$6,'1.4.0',$7,NULL)
       RETURNING id`,
      [
        employeeId,
        `${workDate}T12:30:00.000Z`,
        17.2 + (i % 40) * 0.02,
        78.2 + (i % 30) * 0.02,
        4 + (i % 15),
        `handset-${TAG}-${i}`,
        `seed-${TAG}-out-${i}`,
      ],
    );
    count("attendance_events", 2);

    const rec = await db.query(
      `INSERT INTO attendance_records (employee_id,work_date,check_in_event_id,check_out_event_id,
         check_in_at,check_out_at,total_hours,status)
       VALUES ($1::uuid,$2::date,$3::uuid,$4::uuid,$5,$6,9.00,'COMPLETE')
       ON CONFLICT (employee_id, work_date) DO NOTHING RETURNING id`,
      [
        employeeId, workDate, inEvent.id, outEvent.id,
        `${workDate}T03:30:00.000Z`, `${workDate}T12:30:00.000Z`,
      ],
    );
    if (rec.rowCount) {
      records.push(rec.rows[0].id as string);
      count("attendance_records");
    }
  }

  for (let i = 0; i < TARGET; i += 1) {
    const decided = i % 3 === 0;
    await db.query(
      `INSERT INTO attendance_exceptions (employee_id,attendance_record_id,exception_type,reason,
         document_id,source,status,version,submitted_by,reviewed_by,reviewed_at,review_note)
       VALUES ($1::uuid,$2::uuid,$3,$4,NULL,$5,$6,1,$7::uuid,$8::uuid,$9,$10)`,
      [
        pick(activeEmployees, i).id,
        records.length ? pick(records, i) : null,
        pick(["SYSTEM_FLAG", "SYSTEM_FLAG", "REGULARIZATION"] as const, i),
        pick([
          "Mock location detected; manual review required",
          "Punch came from a device that appears to be an emulator; queued for review",
          "Network was down at the site all morning",
        ], i),
        i % 2 === 0 ? "SYSTEM" : "USER",
        decided ? (i % 6 === 0 ? "REJECTED" : "APPROVED") : "PENDING",
        i % 2 === 0 ? null : pick(users, i),
        decided ? pick(users, i + 1) : null,
        decided ? hoursAgo(i) : null,
        decided ? "Verified with the site supervisor" : null,
      ],
    );
    count("attendance_exceptions");
  }

  // ------------------------------------------------------------ leave -----
  const leaveTypes = await all<{ id: string; code: string }>(
    "SELECT id, code FROM leave_types WHERE org_id=$1 ORDER BY code",
    [orgId],
  );
  for (let i = leaveTypes.length; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO leave_types (org_id,code,name,is_paid,annual_entitlement,requires_balance,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        orgId, `${TAG}L${i}`, `Special leave ${i}`,
        i % 3 !== 0, 5 + (i % 10), i % 3 !== 0, i % 17 !== 0,
      ],
    );
    leaveTypes.push({ id: row.id, code: `${TAG}L${i}` });
    count("leave_types");
  }

  const year = new Date().getUTCFullYear();
  for (let i = 0; i < TARGET; i += 1) {
    const r = await db.query(
      `INSERT INTO leave_balances (employee_id,leave_type_id,period_year,opening_balance,credits,consumed,adjustments)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)
       ON CONFLICT (employee_id, leave_type_id, period_year) DO NOTHING`,
      [pick(employees, i), pick(leaveTypes, i).id, year, 12, i % 4, i % 6, (i % 3) - 1],
    );
    count("leave_balances", r.rowCount ?? 0);
  }

  for (let i = 0; i < TARGET; i += 1) {
    const status = pick(["PENDING", "APPROVED", "APPROVED", "REJECTED", "CANCELLED"] as const, i);
    const approver = pick(users, i + 2);
    await db.query(
      `INSERT INTO leave_requests (org_id,employee_id,leave_type_id,from_date,to_date,total_days,
         reason,status,approval_chain,current_approver_id,version)
       VALUES ($1,$2::uuid,$3::uuid,$4::date,$5::date,$6,$7,$8,$9::jsonb,$10::uuid,1)`,
      [
        orgId, pick(employees, i), pick(leaveTypes, i).id,
        daysAhead(10 + i), daysAhead(11 + i), 2,
        pick(["Family function", "Medical appointment", "Personal work", "Village festival"], i),
        status,
        JSON.stringify([
          {
            step: 1, approver_user_id: approver,
            status: status === "PENDING" ? "PENDING" : status === "REJECTED" ? "REJECTED" : "APPROVED",
            decided_at: status === "PENDING" ? null : hoursAgo(i),
            note: status === "REJECTED" ? "Site is short-staffed that week" : null,
          },
        ]),
        status === "PENDING" ? approver : null,
      ],
    );
    count("leave_requests");
  }

  for (let i = 0; i < TARGET; i += 1) {
    const scoped = i % 3 === 0;
    const r = await db.query(
      `INSERT INTO holidays (org_id,date,name,type,scope_type,scope_id,source,active,created_by)
       VALUES ($1,$2::date,$3,$4,$5,$6::uuid,$7,$8,$9::uuid)
       ON CONFLICT DO NOTHING`,
      [
        orgId, daysAhead(5 + i * 6),
        pick(["Sankranti", "Ugadi", "Dussehra", "Deepavali", "Bathukamma", "Bonalu"], i),
        pick(["national", "regional", "local", "manual"] as const, i),
        scoped ? "district" : null,
        scoped ? pick(districts, i) : null,
        i % 2 === 0 ? "MANUAL" : "IMPORT",
        i % 19 !== 0,
        pick(users, i),
      ],
    );
    count("holidays", r.rowCount ?? 0);
  }

  // ----------------------------------------------- employee documents ---
  const PNG_DOC = Buffer.from("89504e470d0a1a0a", "hex");
  for (let i = 0; i < TARGET; i += 1) {
    const bytes = Buffer.concat([PNG_DOC, Buffer.from(`document-${TAG}-${i}`)]);
    await db.query(
      `INSERT INTO employee_documents (org_id,employee_id,doc_type,file_name,file_path,file_size,
         mime_type,checksum,created_by,content_encrypted)
       VALUES ($1,$2::uuid,$3,$4,NULL,$5,$6,$7,$8::uuid,$9)`,
      [
        orgId,
        pick(employees, i),
        pick(["ID_PROOF", "ADDRESS_PROOF", "QUALIFICATION", "BANK_PASSBOOK", "MEDICAL"], i),
        `${pick(["aadhaar", "pan", "diploma", "passbook", "medical"], i)}-${i}.png`,
        bytes.length,
        "image/png",
        createHash("sha256").update(bytes).digest("hex"),
        pick(users, i),
        encryptPii(bytes.toString("base64")),
      ],
    );
    count("employee_documents");
  }

  await seedWork(db, { orgId, users, employees, villages, districts, sites });
  await seedOperations(db, { orgId, users, employees });
  await seedPayroll(db, { orgId, users, employees });
  await seedPlatform(db, { orgId, users, devices });
}

// ---------------------------------------------------------------------------
// Projects, tasks, boards, cycles
// ---------------------------------------------------------------------------

interface Ctx {
  orgId: string;
  users: string[];
  employees?: string[];
  villages?: string[];
  districts?: string[];
  sites?: string[];
  devices?: string[];
}

async function seedWork(db: PoolClient, ctx: Ctx): Promise<void> {
  const { orgId, users } = ctx;
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> =>
    (await db.query(sql, p)).rows[0] as T;
  const all = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    (await db.query(sql, p)).rows as T[];

  const workspaces: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO workspaces (org_id,name,description,status,version,created_by,updated_by)
       VALUES ($1,$2,$3,$4,1,$5::uuid,$5::uuid) RETURNING id`,
      [
        orgId, `${pick(DISTRICTS, i)} Division ${TAG}-${i}`,
        `Field delivery workspace for the ${pick(DISTRICTS, i)} division`,
        i % 14 === 0 ? "INACTIVE" : "ACTIVE", pick(users, i),
      ],
    );
    workspaces.push(row.id);
    count("workspaces");
  }

  const workflow = defaultTaskWorkflow();
  const projectTypes = await all<{ id: string }>(
    "SELECT id FROM project_types WHERE org_id=$1", [orgId],
  );
  for (let i = projectTypes.length; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO project_types (org_id,code,name,sla_policy)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
      [
        orgId, `${TAG}PT${i}`, `Project type ${i}`,
        JSON.stringify({
          at_risk_days: 2, team_lead_after_days: 0,
          project_manager_after_days: 1, super_admin_after_days: 3,
        }),
      ],
    );
    await db.query(
      `INSERT INTO project_workflows (project_type_id,statuses,allowed_transitions,version)
       VALUES ($1::uuid,$2::jsonb,$3::jsonb,1) ON CONFLICT (project_type_id) DO NOTHING`,
      [row.id, JSON.stringify(workflow.statuses), JSON.stringify(workflow.allowed_transitions)],
    );
    projectTypes.push({ id: row.id });
    count("project_types");
    count("project_workflows");
  }

  const projects: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO projects (org_id,workspace_id,code,name,description,project_type_id,
         project_manager_id,planned_start_date,planned_end_date,priority,status,version,
         created_by,updated_by,sla_policy)
       VALUES ($1,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8::date,$9::date,$10,$11,1,
               $12::uuid,$12::uuid,$13::jsonb) RETURNING id`,
      [
        orgId, pick(workspaces, i), `PRJ${TAG}${String(i).padStart(3, "0")}`,
        `${pick(SITES, i)} — ${pick(MANDALS, i)}`,
        `Execution package covering ${pick(SITES, i)} in ${pick(MANDALS, i)} mandal.`,
        pick(projectTypes, i).id, pick(users, i),
        daysAgo(120 - i), daysAhead(60 + i),
        pick(["LOW", "MEDIUM", "HIGH", "URGENT"] as const, i),
        pick(["ACTIVE", "ACTIVE", "ACTIVE", "DRAFT", "ON_HOLD", "CLOSED"] as const, i),
        pick(users, i),
        i % 4 === 0
          ? JSON.stringify({
              at_risk_days: 3, team_lead_after_days: 1,
              project_manager_after_days: 2, super_admin_after_days: 5,
            })
          : null,
      ],
    );
    projects.push(row.id);
    count("projects");

    await db.query(
      `INSERT INTO project_workflow_overrides (project_id,statuses,allowed_transitions,version,updated_by)
       VALUES ($1::uuid,$2::jsonb,$3::jsonb,1,$4::uuid) ON CONFLICT (project_id) DO NOTHING`,
      [row.id, JSON.stringify(workflow.statuses), JSON.stringify(workflow.allowed_transitions), pick(users, i)],
    );
    count("project_workflow_overrides");
  }

  const cycles: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const closed = i % 4 === 0;
    const row = await one<{ id: string }>(
      `INSERT INTO cycles (org_id,project_id,name,start_date,end_date,goal,rollover,status,
         closed_at,metrics,version,created_by)
       VALUES ($1,$2::uuid,$3,$4::date,$5::date,$6,$7,$8,$9,$10::jsonb,1,$11::uuid) RETURNING id`,
      [
        orgId, projects[i]!, `Sprint ${i + 1}`,
        daysAgo(28 - (i % 3) * 14), daysAgo(14 - (i % 3) * 14),
        `Close out ${pick(SITES, i)} snag list`,
        pick(["NEXT", "BACKLOG"] as const, i),
        closed ? "CLOSED" : pick(["PLANNED", "ACTIVE"] as const, i),
        closed ? hoursAgo(i * 6) : null,
        closed ? JSON.stringify({ planned: 8, completed: 6, remaining: 2, next_cycle_id: null }) : null,
        pick(users, i),
      ],
    );
    cycles.push(row.id);
    count("cycles");
  }

  const labels: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO labels (org_id,project_id,name,color,created_by)
       VALUES ($1,$2::uuid,$3,$4,$5::uuid) RETURNING id`,
      [
        orgId, i % 2 === 0 ? pick(projects, i) : null,
        `${pick(["safety", "rework", "client-hold", "monsoon", "urgent", "inspection"], i)}-${i}`,
        pick(["#B4321E", "#0E6E7A", "#2C7A4B", "#9A5B10", "#3E5C87"], i),
        pick(users, i),
      ],
    );
    labels.push(row.id);
    count("labels");
  }

  const tasks: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const status = pick(
      ["TO_DO", "IN_PROGRESS", "IN_REVIEW", "DONE", "BLOCKED", "CANCELLED"] as const, i,
    );
    const done = status === "DONE";
    const row = await one<{ id: string }>(
      `INSERT INTO tasks (org_id,project_id,title,description,status,assignee_id,parent_task_id,
         village_id,planned_start_date,planned_end_date,priority,estimated_hours,board_position,
         version,created_by,updated_by,cycle_id,custom_fields,checklist,actual_start_at,actual_end_at)
       VALUES ($1,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::date,$10::date,$11,$12,$13,1,
               $14::uuid,$14::uuid,$15::uuid,$16::jsonb,$17::jsonb,$18,$19) RETURNING id`,
      [
        orgId, pick(projects, i),
        `${pick(["Excavate", "Pour", "Inspect", "Commission", "Survey", "Backfill"], i)} ${pick(SITES, i)}`,
        `Field task raised for ${pick(VILLAGES, i)}; coordinate with the mandal office before starting.`,
        status, pick(users, i),
        // Every fifth task hangs off an earlier one, giving the tree depth.
        i > 5 && i % 5 === 0 ? tasks[i - 5]! : null,
        ctx.villages ? pick(ctx.villages, i) : null,
        daysAgo(30 - (i % 20)), daysAhead((i % 25) - 5),
        pick(["LOW", "MEDIUM", "HIGH", "URGENT"] as const, i),
        4 + (i % 30), i,
        pick(users, i), pick(cycles, i),
        JSON.stringify({ site_zone: pick(["North", "South", "East", "West"], i), crew_size: 4 + (i % 8) }),
        JSON.stringify([
          { id: randomUUID(), title: "Toolbox talk complete", done: true },
          { id: randomUUID(), title: "Permit to work signed", done: done },
        ]),
        hoursAgo(100 - i), done ? hoursAgo(40 - (i % 30)) : null,
      ],
    );
    tasks.push(row.id);
    count("tasks");

    await db.query(
      `INSERT INTO task_labels (task_id,label_id,created_by) VALUES ($1::uuid,$2::uuid,$3::uuid)
       ON CONFLICT DO NOTHING`,
      [row.id, pick(labels, i), pick(users, i)],
    );
    count("task_labels");
  }

  // Dependencies form a simple chain, which is acyclic by construction. The
  // chain yields TARGET-1 edges, so one extra forward edge (skipping a link)
  // brings the table to TARGET without ever creating a cycle.
  if (tasks.length > 2) {
    const extra = await db.query(
      `INSERT INTO task_dependencies (predecessor_id,successor_id,dependency_type,created_by)
       VALUES ($1::uuid,$2::uuid,'FINISH_TO_START',$3::uuid) ON CONFLICT DO NOTHING`,
      [tasks[0]!, tasks[2]!, pick(users, 0)],
    );
    count("task_dependencies", extra.rowCount ?? 0);
  }
  for (let i = 1; i < TARGET; i += 1) {
    const r = await db.query(
      `INSERT INTO task_dependencies (predecessor_id,successor_id,dependency_type,created_by)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid) ON CONFLICT DO NOTHING`,
      [tasks[i - 1]!, tasks[i]!, "FINISH_TO_START", pick(users, i)],
    );
    count("task_dependencies", r.rowCount ?? 0);
  }

  const PNG = Buffer.from("89504e470d0a1a0a", "hex");
  for (let i = 0; i < TARGET; i += 1) {
    const bytes = Buffer.concat([PNG, Buffer.from(`evidence-${TAG}-${i}`)]);
    const evidence = await one<{ id: string }>(
      `INSERT INTO task_evidence (org_id,task_id,evidence_type,file_name,file_path,file_size,
         mime_type,checksum,created_by,content_encrypted)
       VALUES ($1,$2::uuid,$3,$4,NULL,$5,$6,$7,$8::uuid,$9) RETURNING id`,
      [
        orgId, pick(tasks, i), pick(["PHOTO", "DOCUMENT", "SIGNATURE"] as const, i),
        `evidence-${i}.png`, bytes.length, "image/png",
        createHash("sha256").update(bytes).digest("hex"),
        pick(users, i), encryptPii(bytes.toString("base64")),
      ],
    );
    ctxEvidence.push(evidence.id);
    count("task_evidence");

    const comment = await one<{ id: string }>(
      `INSERT INTO comments (org_id,task_id,author_user_id,body)
       VALUES ($1,$2::uuid,$3::uuid,$4) RETURNING id`,
      [
        orgId, pick(tasks, i), pick(users, i),
        pick([
          "Material arrived on site this morning.",
          "Held up waiting on the mandal clearance.",
          "Rework needed on the north face; photos attached.",
          "Crew reassigned from the pump house today.",
        ], i),
      ],
    );
    count("comments");

    await db.query(
      `INSERT INTO mentions (comment_id,mentioned_user_id,read_at)
       VALUES ($1::uuid,$2::uuid,$3) ON CONFLICT DO NOTHING`,
      [comment.id, pick(users, i + 1), i % 3 === 0 ? hoursAgo(i) : null],
    );
    count("mentions");
  }

  const boards: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO boards (org_id,project_id,name,view_type,filter_config,shared,version,
         created_by,updated_by)
       VALUES ($1,$2::uuid,$3,$4,$5::jsonb,$6,1,$7::uuid,$7::uuid) RETURNING id`,
      [
        orgId, pick(projects, i), `${pick(SITES, i)} board`,
        i % 3 === 0 ? "LIST" : "KANBAN",
        JSON.stringify({ priority: pick(["HIGH", "MEDIUM"], i) }),
        i % 2 === 0, pick(users, i),
      ],
    );
    boards.push(row.id);
    count("boards");
  }
  for (let i = 0; i < TARGET; i += 1) {
    await db.query(
      `INSERT INTO board_columns (board_id,status_code,name,position,wip_limit,color)
       VALUES ($1::uuid,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        pick(boards, i), pick(workflow.statuses, i), pick(workflow.statuses, i),
        (i % 6) + 1, i % 4 === 0 ? 5 : null,
        pick(["#0E6E7A", "#2C7A4B", "#9A5B10", "#B4321E"], i),
      ],
    );
    count("board_columns");
  }

  for (let i = 0; i < TARGET; i += 1) {
    await db.query(
      `INSERT INTO saved_filters (org_id,owner_id,project_id,name,query_definition,shared)
       VALUES ($1,$2::uuid,$3::uuid,$4,$5::jsonb,$6)`,
      [
        orgId, pick(users, i), i % 2 === 0 ? pick(projects, i) : null,
        `${pick(["My overdue", "Blocked work", "This sprint", "Safety items"], i)} ${i}`,
        JSON.stringify({ status: ["IN_PROGRESS"], priority: ["HIGH"], sla: "overdue" }),
        i % 3 === 0,
      ],
    );
    count("saved_filters");
  }

  for (let i = 0; i < TARGET; i += 1) {
    await db.query(
      `INSERT INTO custom_field_definitions (org_id,project_id,field_key,name,field_type,options,
         required,active,version,created_by,project_type_id)
       VALUES ($1,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8,1,$9::uuid,NULL)
       ON CONFLICT (project_id, field_key) DO NOTHING`,
      [
        orgId, pick(projects, i), `field_${TAG.toLowerCase()}_${i}`,
        pick(["Site zone", "Crew size", "Permit number", "Inspection date", "Shift"], i),
        pick(["text", "number", "date", "select", "boolean"] as const, i),
        JSON.stringify(i % 5 === 3 ? ["DAY", "NIGHT"] : []),
        i % 4 === 0, i % 16 !== 0, pick(users, i),
      ],
    );
    count("custom_field_definitions");
  }

  // Store for the modules that follow.
  ctxProjects = projects;
  ctxTasks = tasks;
}

let ctxProjects: string[] = [];
let ctxTasks: string[] = [];
let ctxEvidence: string[] = [];

// ---------------------------------------------------------------------------
// Vendors, inventory, assets
// ---------------------------------------------------------------------------

async function seedOperations(db: PoolClient, ctx: Ctx): Promise<void> {
  const { orgId, users } = ctx;
  const employees = ctx.employees ?? [];
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> =>
    (await db.query(sql, p)).rows[0] as T;

  const vendors: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO vendors (org_id,code,name,contact,tax_id,status,version,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7::uuid) RETURNING id`,
      [
        orgId, `VEN${TAG}${String(i).padStart(3, "0")}`,
        `${pick(["Sri", "Sai", "Lakshmi", "Vijaya", "Anand"], i)} ${pick(["Traders", "Enterprises", "Suppliers", "Agencies"], i)}`,
        `${phone()} · ${pick(MANDALS, i)}`,
        `36AA${TAG}${String(1000 + i)}Z${i % 10}`,
        i % 12 === 0 ? "INACTIVE" : "ACTIVE", pick(users, i),
      ],
    );
    vendors.push(row.id);
    count("vendors");
  }

  const invoices: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const subtotal = 5000 + i * 250;
    const gstEnabled = i % 4 !== 0;
    const rate = gstEnabled ? 18 : 0;
    const tax = Math.round(((subtotal * rate) / 100) * 100) / 100;
    const row = await one<{ id: string }>(
      `INSERT INTO invoices (org_id,serial_number,vendor_id,hsn,gst_enabled,gst_rate,subtotal,tax,
         total,payment_mode,reference,created_by)
       VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid) RETURNING id`,
      [
        orgId, `INV/${TAG}/${String(i).padStart(4, "0")}`, pick(vendors, i),
        `${3800 + (i % 90)}`, gstEnabled, rate, subtotal, tax, subtotal + tax,
        pick(["NEFT", "UPI", "CHEQUE", "CASH"] as const, i),
        `PO-${TAG}-${i}`, pick(users, i),
      ],
    );
    invoices.push(row.id);
    count("invoices");
  }

  const items: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO inventory_items (org_id,code,name,unit,low_stock_threshold,unit_cost,vendor_id,
         status,version,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8,1,$9::uuid) RETURNING id`,
      [
        orgId, `ITM${TAG}${String(i).padStart(3, "0")}`,
        pick(["Cement (OPC 53)", "TMT bar 12mm", "Binding wire", "HT cable", "Scaffold clamp", "Safety helmet", "Shuttering ply"], i),
        pick(["BAG", "KG", "METRE", "PIECE", "ROLL"] as const, i),
        10 + (i % 20), 120 + i * 13, pick(vendors, i),
        i % 13 === 0 ? "INACTIVE" : "ACTIVE", pick(users, i),
      ],
    );
    items.push(row.id);
    count("inventory_items");
  }

  for (let i = 0; i < TARGET; i += 1) {
    // Stock in first, then a smaller issue, so no ledger goes negative.
    await db.query(
      `INSERT INTO stock_transactions (org_id,item_id,direction,quantity,reference,project_id,
         invoice_id,reason,created_by)
       VALUES ($1,$2::uuid,'IN',$3,$4,$5::uuid,$6::uuid,$7,$8::uuid)`,
      [
        orgId, items[i]!, 100 + (i % 50), `GRN-${TAG}-${i}`,
        ctxProjects.length ? pick(ctxProjects, i) : null, pick(invoices, i),
        "Opening stock received at the depot", pick(users, i),
      ],
    );
    await db.query(
      `INSERT INTO stock_transactions (org_id,item_id,direction,quantity,reference,project_id,
         invoice_id,reason,created_by)
       VALUES ($1,$2::uuid,'OUT',$3,$4,$5::uuid,NULL,$6,$7::uuid)`,
      [
        orgId, items[i]!, 10 + (i % 20), `ISSUE-${TAG}-${i}`,
        ctxProjects.length ? pick(ctxProjects, i) : null,
        "Issued to the site crew", pick(users, i),
      ],
    );
    count("stock_transactions", 2);
  }

  const assets: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO assets (org_id,asset_code,serial_number,name,category,vendor_id,condition,
         status,version,created_by)
       VALUES ($1,$2,$3,$4,$5,$6::uuid,$7,$8,1,$9::uuid) RETURNING id`,
      [
        orgId, `AST${TAG}${String(i).padStart(3, "0")}`, `SN-${TAG}-${i}`,
        pick(["Cordless drill", "Total station", "Vibrator needle", "Welding set", "Laptop", "Multimeter"], i),
        pick(["TOOLS", "IT", "SURVEY", "SAFETY"] as const, i),
        pick(vendors, i),
        pick(["GOOD", "GOOD", "FAIR", "WORN"] as const, i),
        // Kept consistent with the assignment created below.
        i % 3 === 0 ? "ASSIGNED" : pick(["AVAILABLE", "RETURNED", "DAMAGED"] as const, i),
        pick(users, i),
      ],
    );
    assets.push(row.id);
    count("assets");
  }

  for (let i = 0; i < TARGET; i += 1) {
    // At most one open assignment per asset (partial unique index), so only the
    // ASSIGNED third stay open; the rest are returned history.
    const open = i % 3 === 0;
    await db.query(
      `INSERT INTO asset_assignments (org_id,asset_id,employee_id,project_id,due_date,issued_at,
         returned_at,condition,reason,created_by)
       VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5::date,$6,$7,$8,$9,$10::uuid)`,
      [
        orgId, assets[i]!, pick(employees, i),
        ctxProjects.length ? pick(ctxProjects, i) : null,
        daysAhead(30 + i), hoursAgo(200 + i),
        open ? null : hoursAgo(20 + i),
        pick(["GOOD", "FAIR", "WORN"] as const, i),
        "Issued for the season's work at " + pick(SITES, i),
        pick(users, i),
      ],
    );
    count("asset_assignments");
  }

  for (let i = 0; i < TARGET; i += 1) {
    await db.query(
      `INSERT INTO asset_audits (org_id,name,results,created_by)
       VALUES ($1,$2,$3::jsonb,$4::uuid)`,
      [
        orgId, `Quarterly count ${TAG}-${i}`,
        JSON.stringify([
          {
            asset_id: assets[i]!, asset_code: `AST${TAG}${String(i).padStart(3, "0")}`,
            result: pick(["FOUND", "MISSING", "UNEXPECTED", "CONDITION_CHANGED"] as const, i),
            expected_condition: "GOOD",
            observed_condition: i % 4 === 1 ? null : "WORN",
          },
        ]),
        pick(users, i),
      ],
    );
    count("asset_audits");
  }
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

async function seedPayroll(db: PoolClient, ctx: Ctx): Promise<void> {
  const { orgId, users } = ctx;
  const employees = ctx.employees ?? [];
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> =>
    (await db.query(sql, p)).rows[0] as T;

  const runs: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    // Historical months, one per run, so periods never overlap.
    const total = 2019 * 12 + i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, "0");
    const status = pick(["OPEN", "CALCULATED", "REVIEW", "APPROVED", "LOCKED"] as const, i);
    const sealed = status === "APPROVED" || status === "LOCKED";
    const row = await one<{ id: string }>(
      `INSERT INTO payroll_runs (org_id,period_start,period_end,status,version,employee_count,
         total_gross,total_deductions,total_net,warnings,approved_by,approved_at,approve_note,
         locked_by,locked_at,created_by)
       VALUES ($1,$2::date,$3::date,$4,1,$5,$6,$7,$8,$9::jsonb,$10::uuid,$11,$12,$13::uuid,$14,$15::uuid)
       RETURNING id`,
      [
        orgId, `${y}-${mm}-01`, `${y}-${mm}-${last}`, status,
        10 + (i % 30), 450000 + i * 1000, 68000 + i * 150, 382000 + i * 850,
        JSON.stringify(
          i % 5 === 0
            ? [{ type: "NO_RECORDS", employee_id: pick(employees, i), message: "No attendance recorded in the period" }]
            : [],
        ),
        sealed ? pick(users, i) : null, sealed ? hoursAgo(500 - i) : null,
        sealed ? "Checked against the muster roll" : null,
        status === "LOCKED" ? pick(users, i) : null,
        status === "LOCKED" ? hoursAgo(480 - i) : null,
        pick(users, i),
      ],
    );
    runs.push(row.id);
    count("payroll_runs");
  }

  for (let i = 0; i < TARGET; i += 1) {
    const gross = 24000 + (i % 20) * 800;
    const ded = Math.round(gross * 0.14);
    const slip = await one<{ id: string }>(
      `INSERT INTO payslips (org_id,payroll_run_id,employee_id,earnings,deductions,gross,
         total_deductions,net_pay,version,is_current)
       VALUES ($1,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,$6,$7,$8,2,true)
       ON CONFLICT (payroll_run_id, employee_id) DO UPDATE SET version=payslips.version
       RETURNING id`,
      [
        orgId, runs[i]!, pick(employees, i),
        JSON.stringify({
          basic: gross, per_day: Math.round(gross / 30), payable_days: 26 - (i % 4),
          present_days: 24 - (i % 4), paid_leave_days: 2, lop_leave_days: i % 3,
        }),
        JSON.stringify({ lop_days: i % 3, lop_amount: (i % 3) * Math.round(gross / 30), pf: Math.round(gross * 0.12) }),
        gross, ded, gross - ded,
      ],
    );
    count("payslips");

    const pdf = Buffer.from(`%PDF-1.4 payslip ${TAG}-${i}`);
    await db.query(
      `INSERT INTO payslip_documents (org_id,payslip_id,version,content_encrypted)
       VALUES ($1,$2::uuid,2,$3) ON CONFLICT (payslip_id, version) DO NOTHING`,
      [orgId, slip.id, encryptPii(pdf.toString("base64"))],
    );
    count("payslip_documents");

    await db.query(
      `INSERT INTO payslip_revisions (payslip_id,version,snapshot_encrypted,archived_by)
       VALUES ($1::uuid,1,$2,$3::uuid) ON CONFLICT DO NOTHING`,
      [
        slip.id,
        encryptPii(JSON.stringify({ gross: gross - 500, net_pay: gross - ded - 500, version: 1 })),
        pick(users, i),
      ],
    );
    count("payslip_revisions");
  }
}

// ---------------------------------------------------------------------------
// Automation, webhooks, notifications, audit, reports
// ---------------------------------------------------------------------------

async function seedPlatform(db: PoolClient, ctx: Ctx): Promise<void> {
  const { orgId, users, devices = [] } = ctx;
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> =>
    (await db.query(sql, p)).rows[0] as T;

  const rules: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO automation_rules (org_id,project_id,name,trigger,conditions,actions,active,
         version,last_run_at,created_by,acting_user_id)
       VALUES ($1,$2::uuid,$3,$4,$5::jsonb,$6::jsonb,$7,1,$8,$9::uuid,$9::uuid) RETURNING id`,
      [
        orgId, ctxProjects.length ? pick(ctxProjects, i) : null,
        `Auto ${pick(["assign", "notify", "label", "escalate"], i)} ${i}`,
        pick(["task.create", "task.status", "task.assign", "sla.at_risk", "sla.breached", "task.due", "cycle.close"] as const, i),
        JSON.stringify(i % 3 === 0 ? [{ field: "priority", value: "HIGH" }] : []),
        JSON.stringify([{ type: pick(["comment", "label", "notify"] as const, i), value: pick(users, i) }]),
        i % 11 !== 0, hoursAgo(i * 4), pick(users, i),
      ],
    );
    rules.push(row.id);
    count("automation_rules");
  }

  const events: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const processed = i % 3 !== 0;
    const row = await one<{ id: string }>(
      `INSERT INTO domain_events (org_id,actor_id,type,entity_type,entity_id,payload,depth,
         processed_at,attempts,next_attempt_at,error,event_key)
       VALUES ($1,$2::uuid,$3,$4,$5::uuid,$6::jsonb,0,$7,$8,now(),$9,$10) RETURNING id`,
      [
        orgId, pick(users, i),
        pick(["task.create", "task.status", "task.assign", "cycle.close"] as const, i),
        "task", ctxTasks.length ? pick(ctxTasks, i) : null,
        JSON.stringify({ project_id: ctxProjects.length ? pick(ctxProjects, i) : null }),
        processed ? hoursAgo(i) : null,
        processed ? 0 : i % 4,
        processed ? null : "Processing failed",
        `seed-${TAG}-event-${i}`,
      ],
    );
    events.push(row.id);
    count("domain_events");
  }

  for (let i = 0; i < TARGET; i += 1) {
    const r = await db.query(
      `INSERT INTO automation_executions (org_id,rule_id,event_id,status,results)
       VALUES ($1,$2::uuid,$3::uuid,$4,$5::jsonb) ON CONFLICT (rule_id, event_id) DO NOTHING`,
      [
        orgId, rules[i]!, events[i]!,
        i % 5 === 0 ? "FAILED" : "SUCCEEDED",
        JSON.stringify([
          i % 5 === 0
            ? { action: "status", status: 422, code: "INVALID_TRANSITION" }
            : { action: "comment", status: 201 },
        ]),
      ],
    );
    count("automation_executions", r.rowCount ?? 0);
  }

  const subs: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO webhook_subscriptions (org_id,name,url,secret_encrypted,events,active,version,created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,1,$7::uuid) RETURNING id`,
      [
        orgId, `Partner hook ${i}`, `https://hooks.example.com/silverline/${TAG}/${i}`,
        encryptPii(`whsec_${TAG}_${i}_${randomUUID()}`),
        JSON.stringify(["task.create", "task.status"]),
        i % 9 !== 0, pick(users, i),
      ],
    );
    subs.push(row.id);
    count("webhook_subscriptions");
  }
  for (let i = 0; i < TARGET; i += 1) {
    const delivered = i % 4 !== 0;
    const r = await db.query(
      `INSERT INTO webhook_deliveries (org_id,subscription_id,event_id,status,attempts,
         next_attempt_at,response_status,error)
       VALUES ($1,$2::uuid,$3::uuid,$4,$5,now(),$6,$7)
       ON CONFLICT (subscription_id, event_id) DO NOTHING`,
      [
        orgId, subs[i]!, events[i]!,
        delivered ? "DELIVERED" : i % 8 === 0 ? "FAILED" : "PENDING",
        delivered ? 1 : (i % 7) + 1,
        delivered ? 200 : i % 8 === 0 ? 500 : null,
        delivered ? null : "Delivery unsuccessful",
      ],
    );
    count("webhook_deliveries", r.rowCount ?? 0);
  }

  const notifications: string[] = [];
  for (let i = 0; i < TARGET; i += 1) {
    const row = await one<{ id: string }>(
      `INSERT INTO notifications (org_id,recipient_id,type,title,body,entity_type,entity_id,
         read_at,event_key)
       VALUES ($1,$2::uuid,$3,$4,$5,$6,$7::uuid,$8,$9) RETURNING id`,
      [
        orgId, pick(users, i),
        pick(["MENTION", "ASSIGNMENT", "APPROVAL", "LOW_STOCK", "AUTOMATION", "SLA"] as const, i),
        pick(["You were mentioned in a task comment", "A task was assigned to you", "An approval is waiting", "Stock needs replenishment"], i),
        "Open Silverline to review this update",
        "task", ctxTasks.length ? pick(ctxTasks, i) : null,
        i % 3 === 0 ? hoursAgo(i) : null,
        `seed-${TAG}-notif-${i}`,
      ],
    );
    notifications.push(row.id);
    count("notifications");
  }

  if (devices.length) {
    for (let i = 0; i < TARGET; i += 1) {
      const ok = i % 4 !== 0;
      const r = await db.query(
        `INSERT INTO notification_deliveries (notification_id,device_id,status,attempts,
           next_attempt_at,provider_id,error)
         VALUES ($1::uuid,$2::uuid,$3,$4,now(),$5,$6)
         ON CONFLICT (notification_id, device_id) DO NOTHING`,
        [
          notifications[i]!, pick(devices, i),
          ok ? "DELIVERED" : i % 8 === 0 ? "FAILED" : "PENDING",
          ok ? 1 : (i % 5) + 1,
          ok ? `expo-${TAG}-${i}` : null,
          ok ? null : "Push provider rejected the token",
        ],
      );
      count("notification_deliveries", r.rowCount ?? 0);
    }
  }

  for (let i = 0; i < TARGET; i += 1) {
    await db.query(
      `INSERT INTO audit_events (org_id,actor_id,actor_ip,actor_user_agent,action,entity_type,
         entity_id,before_state,after_state,reason,request_id,idempotency_key)
       VALUES ($1,$2::uuid,$3::inet,$4,$5,$6,$7::uuid,$8::jsonb,$9::jsonb,$10,$11,$12)`,
      [
        orgId, pick(users, i), `10.${i % 250}.0.${(i * 5) % 250}`,
        "Mozilla/5.0 (Linux; Android 14) Silverline/1.4.0",
        pick(["auth.login", "employee.create", "task.status.change", "payroll.run.lock", "leave.decide"], i),
        pick(["user", "employee", "task", "payroll_run", "leave_request"], i),
        ctxTasks.length ? pick(ctxTasks, i) : null,
        JSON.stringify({ status: "TO_DO" }),
        JSON.stringify({ status: "IN_PROGRESS" }),
        "Routine field update",
        randomUUID(), `seed-${TAG}-audit-${i}`,
      ],
    );
    count("audit_events");

    await db.query(
      `INSERT INTO idempotency_keys (key,user_id,method,path,status_code,response_body,
         expires_at,request_hash)
       VALUES ($1,$2::uuid,'POST',$3,201,$4::jsonb,now()+interval '24 hours',$5)
       ON CONFLICT DO NOTHING`,
      [
        `seed-${TAG}-idem-${i}`, pick(users, i), "/api/v1/tasks",
        JSON.stringify({ id: randomUUID(), applied: true }),
        sha(`seed-${TAG}-${i}`),
      ],
    );
    count("idempotency_keys");

    await db.query(
      `INSERT INTO v2_operations (key,user_id,path,request_hash,response)
       VALUES ($1,$2::uuid,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [
        `seed-${TAG}-op-${i}`, pick(users, i), "/api/v1/assets",
        sha(`op-${TAG}-${i}`), JSON.stringify({ id: randomUUID(), status: "ASSIGNED" }),
      ],
    );
    count("v2_operations");
  }

  for (let i = 0; i < TARGET; i += 1) {
    if (!ctxProjects.length) break;
    await db.query(
      `INSERT INTO insight_feedback (org_id,project_id,model_version,rating,reason,created_by)
       VALUES ($1,$2::uuid,'statistical-baseline-v1',$3,$4,$5::uuid)`,
      [
        orgId, pick(ctxProjects, i),
        pick(["CORRECT", "INCORRECT", "USEFUL", "NOT_USEFUL"] as const, i),
        pick(["Matched what the site reported", "Underestimated the monsoon delay", "Helpful for the weekly review"], i),
        pick(users, i),
      ],
    );
    count("insight_feedback");

    await db.query(
      `INSERT INTO advisory_cases (org_id,project_id,task_id,evidence_id,kind,status,model_version,
         factors,version,reviewed_at,reviewed_by,reason)
       VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,'statistical-baseline-v1',$7::jsonb,1,$8,$9::uuid,$10)`,
      [
        orgId, pick(ctxProjects, i), pick(ctxTasks, i), pick(ctxEvidence, i),
        pick(["DUPLICATE_EVIDENCE", "DELAY_RISK"] as const, i),
        i % 3 === 0 ? (i % 6 === 0 ? "DISMISSED" : "CONFIRMED") : "OPEN",
        JSON.stringify([{ name: "Similarity", value: 0.91 }]),
        i % 3 === 0 ? hoursAgo(i) : null,
        i % 3 === 0 ? pick(users, i) : null,
        i % 3 === 0 ? "Reviewed against the site photo log" : null,
      ],
    );
    count("advisory_cases");
  }

  for (let i = 0; i < TARGET; i += 1) {
    const csv = Buffer.from(`# Report: tasks\nid,title\n${randomUUID()},Seed row ${i}\n`);
    const id = randomUUID();
    await db.query(
      `INSERT INTO report_registry (id,org_id,created_by,entry,content_encrypted)
       VALUES ($1::uuid,$2,$3::uuid,$4::jsonb,$5)`,
      [
        id, orgId, pick(users, i),
        JSON.stringify({
          id, type: pick(["tasks", "employees", "attendance", "leave", "projects"], i),
          format: "csv", status: "READY", rows: 10 + i,
          orgId, createdBy: pick(users, i),
          downloadUrl: `/api/v1/reports/${id}/download`, encrypted: true, scopes: "global",
        }),
        encryptPii(csv.toString("base64")),
      ],
    );
    count("report_registry");

    await db.query(
      `INSERT INTO report_schedules (org_id,name,report_type,filters,frequency,active,next_run_at,
         last_run_at,error,created_by,format,failures,version)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,now()+interval '1 day',$7,$8,$9::uuid,$10,$11,1)`,
      [
        orgId, `${pick(["Weekly attendance", "Monthly payroll", "Open tasks"], i)} ${i}`,
        pick(["attendance", "tasks", "leave", "projects"] as const, i),
        JSON.stringify({ from: daysAgo(30), to: daysAgo(0) }),
        pick(["DAILY", "WEEKLY", "MONTHLY"] as const, i),
        i % 10 !== 0, hoursAgo(24 * (i % 7)),
        i % 10 === 0 ? "Last run failed: source unavailable" : null,
        pick(users, i), pick(["csv", "xlsx", "pdf"] as const, i), i % 10 === 0 ? 2 : 0,
      ],
    );
    count("report_schedules");

    await db.query(
      `INSERT INTO provider_jobs (org_id,provider,created_by,notification_id,payload_encrypted,
         status,attempts,next_attempt_at,provider_id,error)
       VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7,now(),$8,$9)`,
      [
        orgId, pick(["SMS", "WHATSAPP", "ACCOUNTING"] as const, i),
        pick(users, i), notifications[i] ?? null,
        encryptPii(JSON.stringify({ to: phone(), template: "attendance_reminder" })),
        pick(["PENDING", "ACCEPTED", "DELIVERED", "FAILED", "CANCELLED"] as const, i),
        i % 3, i % 4 === 0 ? null : `prov-${TAG}-${i}`,
        i % 9 === 0 ? "Provider rejected the request" : null,
      ],
    );
    count("provider_jobs");
  }
}

// ---------------------------------------------------------------------------

const invokedAsScript =
  process.argv[1]?.endsWith("seed-volume.ts") === true ||
  process.argv[1]?.endsWith("seed-volume.js") === true;

if (invokedAsScript) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 4,
  });
  try {
    const report = await seedVolume(pool);
    const rows = Object.entries(report).sort(([a], [b]) => a.localeCompare(b));
    console.log(`seed-volume: target ${TARGET} rows/table, tag ${TAG}\n`);
    for (const [table, n] of rows) console.log(`  ${String(n).padStart(4)}  ${table}`);
    console.log(`\n  ${rows.reduce((sum, [, n]) => sum + n, 0)} rows inserted`);
  } finally {
    await pool.end();
  }
}

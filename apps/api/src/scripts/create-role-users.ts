import "../common/env.js";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

/**
 * Create one test user (and a backing employee record) per non-admin
 * system role, in every organisation that still has an ADMIN/SUPER_ADMIN
 * user -- meant to run right after reset-for-e2e.ts, so each role has
 * something to log in as for end-to-end testing.
 *
 * Idempotent: re-running updates the password and re-attaches the role
 * rather than failing on an existing row.
 *
 *   DATABASE_URL=... PASSWORD='...' npm run create-role-users --workspace=api
 *   DATABASE_URL=... PASSWORD='...' npm run create-role-users --workspace=api -- --org-id=<uuid>
 */

const TARGET_ROLES = [
  "PROJECT_MANAGER", "TEAM_LEAD", "EMPLOYEE", "HR_MANAGER", "PAYROLL_OFFICER",
  "INVENTORY_MANAGER", "AUDITOR", "SALES_BD_EXECUTIVE", "BID_TENDER_MANAGER",
  "GOVT_OBSERVER", "CLIENT_VIEWER",
] as const;

function usernameFor(role: string): string {
  return `qa-${role.toLowerCase().replace(/_/g, "-")}`;
}

async function main(): Promise<void> {
  const onlyOrgArg = process.argv.find(a => a.startsWith("--org-id="));
  const onlyOrgId = onlyOrgArg ? onlyOrgArg.slice("--org-id=".length) : null;
  const password = process.env["PASSWORD"];
  if (!password) {
    console.error("Set PASSWORD in the environment -- the same password is used for every role user this creates.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev",
  });
  try {
    const orgs = await pool.query(
      onlyOrgId
        ? "SELECT DISTINCT o.id, o.name FROM organizations o WHERE o.id = $1"
        : `SELECT DISTINCT o.id, o.name
             FROM organizations o
             JOIN users u ON u.org_id = o.id
             JOIN user_roles ur ON ur.user_id = u.id
             JOIN roles r ON r.id = ur.role_id
            WHERE r.code IN ('ADMIN', 'SUPER_ADMIN') AND r.org_id IS NULL
            ORDER BY o.name`,
      onlyOrgId ? [onlyOrgId] : [],
    );
    if (orgs.rowCount === 0) {
      console.error(onlyOrgId ? `No organisation ${onlyOrgId}.` : "No organisation has an ADMIN/SUPER_ADMIN user -- run reset-for-e2e.ts first, or create-super-admin.ts for at least one org.");
      process.exitCode = 1;
      return;
    }

    const roleIds = new Map<string, string>();
    for (const code of TARGET_ROLES) {
      const row = await pool.query("SELECT id FROM roles WHERE code = $1 AND org_id IS NULL", [code]);
      if (row.rowCount === 0) {
        console.error(`No system role ${code} -- has the database been migrated and seeded?`);
        process.exitCode = 1;
        return;
      }
      roleIds.set(code, String(row.rows[0].id));
    }

    const passwordHash = await bcrypt.hash(password, Number(process.env["BCRYPT_ROUNDS"] ?? 10));
    let created = 0, updated = 0;

    for (const org of orgs.rows as Array<{ id: string; name: string }>) {
      for (const [i, role] of TARGET_ROLES.entries()) {
        const username = usernameFor(role);
        const empNo = `QA-${role}`;
        // Globally unique across orgs/roles, stable across re-runs: ten
        // digits so it always matches the phone column's VARCHAR(20) and
        // typical Indian mobile format checks elsewhere.
        const phoneSuffix = String(1000000000 + (i * 97 + Number(BigInt(`0x${org.id.replace(/-/g, "").slice(0, 6)}`) % 900n))).slice(-9);
        const phone = `9${phoneSuffix}`;

        const employee = await pool.query(
          `INSERT INTO employees (org_id, emp_no, first_name, last_name, phone, date_of_joining, status)
           VALUES ($1, $2, $3, 'QA', $4, CURRENT_DATE, 'ACTIVE')
           ON CONFLICT (org_id, emp_no) DO UPDATE SET status = 'ACTIVE'
           RETURNING id`,
          [org.id, empNo, role, phone],
        );
        const employeeId = String(employee.rows[0].id);

        const user = await pool.query(
          `INSERT INTO users (org_id, username, email, employee_id, password_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (org_id, username) DO UPDATE SET
             password_hash = EXCLUDED.password_hash,
             employee_id = EXCLUDED.employee_id,
             updated_at = now()
           RETURNING id, (xmax = 0) AS inserted`,
          [org.id, username, `${username}@qa.local`, employeeId, passwordHash],
        );
        const userId = String(user.rows[0].id);
        if (user.rows[0].inserted) created++; else updated++;

        await pool.query(
          "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [userId, roleIds.get(role)],
        );
      }
      console.log(`${org.name}: ${TARGET_ROLES.length} role user(s) ready.`);
    }
    console.log(`\nDone. ${created} created, ${updated} updated, across ${orgs.rowCount} organisation(s). Username pattern: qa-<role>, e.g. ${usernameFor("PROJECT_MANAGER")}.`);
  } finally {
    await pool.end();
  }
}

await main();

import "../common/env.js";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import {
  ALL_PERMISSIONS,
  V2_PERMISSIONS, V2_ROLE_GRANTS,
  CRM_PERMISSIONS,
  CRM_ROLE_GRANTS,
  BILLING_PERMISSIONS,
  BILLING_ROLE_GRANTS,
  APPROVAL_PERMISSIONS,
  APPROVAL_ROLE_GRANTS,
  ROLE_CODES,
  ROLE_PERMISSIONS,
  S1_ALL_PERMISSIONS,
  S1_ROLE_GRANTS,
  S2_ALL_PERMISSIONS,
  S2_ROLE_GRANTS,
  S3_ALL_PERMISSIONS,
  S3_ROLE_GRANTS,
  S4_ALL_PERMISSIONS,
  S4_ROLE_GRANTS,
  S5_ALL_PERMISSIONS,
  S5_ROLE_GRANTS,
  S6_ALL_PERMISSIONS,
  S6_ROLE_GRANTS,
  P1_ALL_PERMISSIONS,
  P1_ROLE_GRANTS,
  PROJECT_TYPE_SEEDS,
  defaultTaskWorkflow,
  type RoleCode,
} from "@silverline/shared";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "ChangeMe123!";
export const DEMO_ORG_NAME = "Demo Org";

export interface SeedOptions {
  bcryptRounds?: number;
}

const PERMISSION_MODULES: Record<string, string> = {
  auth: "auth",
  users: "users",
  roles: "roles",
  audit: "audit",
  employees: "employees",
  employee: "employees",
  attendance: "attendance",
  leave: "leave",
  projects: "projects",
  tasks: "tasks",
  inventory: "inventory",
  payroll: "payroll",
  payslip: "payroll",
  org: "org",
  workspace: "workspaces",
  project: "projects",
  task: "tasks",
  document: "documents",
  holiday: "holidays",
  board: "boards",
  filter: "filters",
  label: "labels",
  notification: "notifications",
  dashboard: "dashboards",
  report: "reports",
  geo: "geo",
};

function moduleFor(permission: string): string {
  const prefix = permission.split(".")[0] ?? "misc";
  return PERMISSION_MODULES[prefix] ?? prefix;
}

  /**
  * Idempotent seed: demo org, full permission catalog (S0 + S1 + S2 + S3 + S4 + S5 + S6 + P1),
  * the 10 system roles (SUPER_ADMIN/ADMIN get every permission), the admin
  * user, the 4 S3 leave types, and the 2 S4 project types + workflows.
  * Re-running converges role grants to the canonical map
  * (S0 + S1 + S2 + S3 + S4 + S5 + S6 + P1 union), leave types and project types + workflows
  * to the canonical definitions. Also ensures one default payroll policy row
  * per org (never overwriting customized rows).
  */
export async function seedDatabase(
  pool: Pool,
  opts: SeedOptions = {},
): Promise<{ orgId: string; adminId: string }> {
  const rounds = opts.bcryptRounds ?? 10;

  let orgId: string | undefined;
  const existingOrg = await pool.query(
    "SELECT id FROM organizations WHERE name = $1",
    [DEMO_ORG_NAME],
  );
  if ((existingOrg.rowCount ?? 0) > 0) {
    orgId = (existingOrg.rows[0] as { id: string }).id;
  } else {
    const org = await pool.query(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
      [DEMO_ORG_NAME],
    );
    orgId = (org.rows[0] as { id: string }).id;
  }

  for (const code of [...ALL_PERMISSIONS, ...S1_ALL_PERMISSIONS, ...S2_ALL_PERMISSIONS, ...S3_ALL_PERMISSIONS, ...S4_ALL_PERMISSIONS, ...S5_ALL_PERMISSIONS, ...S6_ALL_PERMISSIONS, ...P1_ALL_PERMISSIONS, ...V2_PERMISSIONS, ...CRM_PERMISSIONS, ...BILLING_PERMISSIONS, ...APPROVAL_PERMISSIONS]) {
    await pool.query(
      `INSERT INTO permissions (code, description, module)
       VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
      [code, `Permission ${code}`, moduleFor(code)],
    );
  }

  for (const code of ROLE_CODES) {
    await pool.query(
      `INSERT INTO roles (org_id, code, name, is_system_role, description)
       VALUES (NULL, $1, $1, true, $2)
       ON CONFLICT (code) DO NOTHING`,
      [code, `System role ${code}`],
    );
  }

  for (const code of ROLE_CODES) {
    const roleRow = await pool.query("SELECT id FROM roles WHERE code = $1", [
      code,
    ]);
    const roleId = roleRow.rows[0].id as string;
    // Reset to the canonical map so re-seeds converge (no duplicates via ON CONFLICT).
    await pool.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    const grants = new Set<string>([
      ...(ROLE_PERMISSIONS[code as RoleCode] ?? []),
      ...(S1_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(S2_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(S3_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(S4_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(S5_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(S6_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(P1_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(V2_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(CRM_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(BILLING_ROLE_GRANTS[code as RoleCode] ?? []),
      ...(APPROVAL_ROLE_GRANTS[code as RoleCode] ?? []),
    ]);
    for (const perm of grants) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_code)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleId, perm],
      );
    }
  }

  if (process.env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD) throw new Error('SEED_ADMIN_PASSWORD is required for production initialization');
  const passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD ?? ADMIN_PASSWORD, rounds);
  await pool.query(
    `INSERT INTO users (org_id, username, phone, email, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, username) DO NOTHING`,
    [orgId, ADMIN_USERNAME, "+910000000000", "admin@silverline.local", passwordHash],
  );
  const adminRow = await pool.query(
    "SELECT id FROM users WHERE org_id = $1 AND username = $2",
    [orgId, ADMIN_USERNAME],
  );
  const adminId = adminRow.rows[0].id as string;

  const superRole = await pool.query(
    "SELECT id FROM roles WHERE code = 'SUPER_ADMIN'",
  );
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [adminId, (superRole.rows[0] as { id: string }).id],
  );

  // S3 leave types (re-runnable: converge to the canonical definitions).
  const leaveTypeSeeds = [
    { code: "CL", name: "Casual Leave", isPaid: true, entitlement: 12, requiresBalance: true },
    { code: "SL", name: "Sick Leave", isPaid: true, entitlement: 12, requiresBalance: true },
    { code: "EL", name: "Earned Leave", isPaid: true, entitlement: 15, requiresBalance: true },
    { code: "LOP", name: "Loss of Pay", isPaid: false, entitlement: 0, requiresBalance: false },
  ];
  for (const t of leaveTypeSeeds) {
    await pool.query(
      `INSERT INTO leave_types (org_id, code, name, is_paid, annual_entitlement, requires_balance, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (org_id, code) DO UPDATE SET
         name = EXCLUDED.name,
         is_paid = EXCLUDED.is_paid,
         annual_entitlement = EXCLUDED.annual_entitlement,
         requires_balance = EXCLUDED.requires_balance,
         active = true,
         updated_at = NOW()`,
      [orgId, t.code, t.name, t.isPaid, t.entitlement, t.requiresBalance],
    );
  }

  // S4 project types + default workflows (re-runnable: converge to the
  // canonical definitions; both seeded types share the frozen workflow).
  const workflow = defaultTaskWorkflow();
  for (const t of PROJECT_TYPE_SEEDS) {
    const typeRow = await pool.query(
      `INSERT INTO project_types (org_id, code, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, code) DO UPDATE SET
         name = EXCLUDED.name,
         updated_at = NOW()
       RETURNING id`,
      [orgId, t.code, t.name],
    );
    let typeId = (typeRow.rows[0] as { id: string } | undefined)?.id;
    if (!typeId) {
      const existing = await pool.query(
        "SELECT id FROM project_types WHERE org_id = $1 AND code = $2",
        [orgId, t.code],
      );
      typeId = (existing.rows[0] as { id: string }).id;
    }
    await pool.query(
      `INSERT INTO project_workflows (project_type_id, statuses, allowed_transitions)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (project_type_id) DO UPDATE SET
         statuses = EXCLUDED.statuses,
         allowed_transitions = EXCLUDED.allowed_transitions,
         updated_at = NOW()`,
      [typeId, JSON.stringify(workflow.statuses), JSON.stringify(workflow.allowed_transitions)],
    );
  }

  // P1 default payroll policy per org (re-runnable: never overwrites a
  // customized row — ON CONFLICT DO NOTHING).
  const allOrgs = await pool.query("SELECT id FROM organizations");
  for (const o of allOrgs.rows as Array<{ id: string }>) {
    await pool.query(
      `INSERT INTO payroll_policies (org_id, per_day_divisor, pf_pct)
       VALUES ($1, 30, 12) ON CONFLICT (org_id) DO NOTHING`,
      [o.id],
    );
  }

  return { orgId, adminId };
}

const invokedAsScript =
  process.argv[1]?.endsWith("seed.ts") === true ||
  process.argv[1]?.endsWith("seed.js") === true;

if (invokedAsScript) {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev";
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { orgId, adminId } = await seedDatabase(pool);
    console.log(`seeded org=${orgId} admin=${adminId} username=${ADMIN_USERNAME}`);
  } finally {
    await pool.end();
  }
}

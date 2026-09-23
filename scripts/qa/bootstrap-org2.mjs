// One-off, idempotent bootstrap: creates a second organization ("QA-Org Two")
// so Task 2's seed script has a tenant to prove isolation against, plus one
// ADMIN-role user in it. No API route creates organizations (checked:
// apps/api/src/modules/admin, org — none), so this goes straight to the
// tables the same way apps/api/src/database/seed.ts bootstraps the primary
// org's admin. Everything else (org units, employee, project) is created
// through the normal API by scripts/qa/seed-qa.mjs, logged in as this user.
//
// Run once, from inside /opt/silverline (so `pg`/`bcryptjs` resolve), with
// DATABASE_URL (and optionally DATABASE_CA_CERT_FILE) exported:
//   sudo bash -c 'set -a; source /etc/silverline/api.env; set +a; node /opt/silverline/tmp-qa-bootstrap-org2.mjs'
// Delete the copy under /opt/silverline afterwards; it is not part of the deployment.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const ORG_NAME = "QA-Org Two";
const USERNAME = "qa-admin-org2";
const OUT = "/home/dev-thor/sl-e2e/admin/.qa-org2.json";

const caFile = process.env.DATABASE_CA_CERT_FILE;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: caFile && existsSync(caFile) ? { ca: readFileSync(caFile, "utf8") } : { rejectUnauthorized: false },
});

const existingState = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;

let orgRow = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
let orgId;
if (orgRow.rowCount > 0) {
  orgId = orgRow.rows[0].id;
  console.log("org exists:", orgId);
} else {
  const r = await pool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [ORG_NAME]);
  orgId = r.rows[0].id;
  console.log("org created:", orgId);
}

let userRow = await pool.query("SELECT id FROM users WHERE org_id = $1 AND username = $2", [orgId, USERNAME]);
let userId, password;
if (userRow.rowCount > 0) {
  userId = userRow.rows[0].id;
  password = existingState?.password ?? null;
  console.log("user exists:", userId, password ? "(password on file)" : "(password NOT on file - cannot recover; rotate manually if needed)");
} else {
  password = "QA-" + randomBytes(9).toString("base64url") + "x1";
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (org_id, username, email, password_hash, auth_status)
     VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
    [orgId, USERNAME, "qa-admin-org2@example.invalid", hash],
  );
  userId = r.rows[0].id;
  console.log("user created:", userId);
}

const roleRow = await pool.query("SELECT id FROM roles WHERE code = 'ADMIN'");
const roleId = roleRow.rows[0].id;
const already = await pool.query(
  "SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type IS NULL",
  [userId, roleId],
);
if (already.rowCount === 0) {
  await pool.query(
    "INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, NULL, NULL)",
    [userId, roleId],
  );
  console.log("role granted: ADMIN (org-wide)");
} else {
  console.log("role already granted: ADMIN (org-wide)");
}

mkdirSync("/home/dev-thor/sl-e2e/admin", { recursive: true });
const state = { org_id: orgId, org_name: ORG_NAME, user_id: userId, username: USERNAME, password, mfa_secret: existingState?.mfa_secret ?? null };
writeFileSync(OUT, JSON.stringify(state, null, 1));
chmodSync(OUT, 0o600);
console.log("state written to", OUT, "(password:", password ? "present" : "absent", ")");

await pool.end();

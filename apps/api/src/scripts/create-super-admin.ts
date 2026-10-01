import "../common/env.js";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

/**
 * Create, or reset, a SUPER_ADMIN user for one organisation.
 *
 * A one-off, run by hand against whatever DATABASE_URL points at (a local
 * dev database, or Supabase directly now there is no VM to seed from) --
 * never by a migration, since who gets this account is an operator's
 * decision each time, not a deploy step.
 *
 * Idempotent: re-running with the same --org and --username updates the
 * password and makes sure the SUPER_ADMIN role is attached, rather than
 * failing on an existing row.
 *
 *   DATABASE_URL=... npm run create-super-admin --workspace=api -- \
 *     --username=admin --password='…' [--org-id=<uuid> | --org-name=<name>] \
 *     [--email=admin@example.com] [--phone=+910000000000]
 *
 * With neither --org-id nor --org-name, and exactly one organisation in
 * the database, that one is used; otherwise every organisation is listed
 * and nothing is written.
 */

interface Args {
  username?: string;
  password?: string;
  email?: string;
  phone?: string;
  orgId?: string;
  orgName?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "username") out.username = value;
    else if (key === "password") out.password = value;
    else if (key === "email") out.email = value;
    else if (key === "phone") out.phone = value;
    else if (key === "org-id") out.orgId = value;
    else if (key === "org-name") out.orgName = value;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.username || !args.password) {
    console.error("Usage: --username=<name> --password=<password> [--org-id=<uuid> | --org-name=<name>] [--email=] [--phone=]");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev",
  });
  try {
    let orgId = args.orgId ?? null;
    if (!orgId && args.orgName) {
      const found = await pool.query("SELECT id FROM organizations WHERE name = $1", [args.orgName]);
      if (found.rowCount === 0) {
        console.error(`No organisation named "${args.orgName}".`);
        process.exitCode = 1;
        return;
      }
      orgId = String(found.rows[0].id);
    }
    if (!orgId) {
      const orgs = await pool.query("SELECT id, name FROM organizations ORDER BY name");
      if (orgs.rowCount === 1) {
        orgId = String(orgs.rows[0].id);
      } else {
        console.error("Pass --org-id or --org-name. Organisations in this database:");
        for (const r of orgs.rows) console.error(`  ${r.id}  ${r.name}`);
        process.exitCode = 1;
        return;
      }
    }

    const superRole = await pool.query("SELECT id FROM roles WHERE code = 'SUPER_ADMIN'");
    if (superRole.rowCount === 0) {
      console.error("No SUPER_ADMIN role found -- has the database been migrated and seeded?");
      process.exitCode = 1;
      return;
    }
    const roleId = String(superRole.rows[0].id);

    const rounds = Number(process.env["BCRYPT_ROUNDS"] ?? 10);
    const passwordHash = await bcrypt.hash(args.password, rounds);

    const user = await pool.query(
      `INSERT INTO users (org_id, username, phone, email, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         email = COALESCE(EXCLUDED.email, users.email),
         phone = COALESCE(EXCLUDED.phone, users.phone),
         updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [orgId, args.username, args.phone ?? null, args.email ?? null, passwordHash],
    );
    const userId = String(user.rows[0].id);
    const created = Boolean(user.rows[0].inserted);

    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, roleId],
    );

    console.log(`${created ? "Created" : "Updated"} SUPER_ADMIN user "${args.username}" (${userId}) in org ${orgId}.`);
  } finally {
    await pool.end();
  }
}

await main();

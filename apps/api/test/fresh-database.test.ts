/**
 * A new environment can be built from nothing.
 *
 * This did not work, and nothing said so. Migration 048 granted
 * `document.read` to ten roles, and `document.read` was defined by the seed
 * script rather than by a migration — so on a genuinely empty database the
 * chain died on its own foreign key. Every database anybody had ever looked
 * at was seeded first and carried the permission already.
 *
 * It surfaced by accident: building per-worker test databases from scratch
 * failed, and the workaround was to copy an existing one. A disaster-recovery
 * rebuild, a second region or a new developer's laptop would have found it
 * the hard way.
 *
 * So the build runs here, against a database made and dropped for the
 * purpose. Slow, and worth it: this is the one test that fails when the
 * schema can no longer be created.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "../src/database/migrate.js";
import { seedDatabase } from "../src/database/seed.js";
import { testDatabaseUrl } from "./database.js";
import { ROLE_CODES, SURVEY_PERMISSIONS } from "@silverline/shared";

/** Its own database, named so the guard in testDatabaseUrl would accept it. */
const NAME = `silverline_fresh_${process.pid}_test`;

function urlFor(db: string): string {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${db}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: urlFor("postgres") });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let pool: Pool;

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${NAME}"`);
    await c.query(`CREATE DATABASE "${NAME}"`);
  });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin((c) => c.query(`DROP DATABASE IF EXISTS "${NAME}"`));
}, 120_000);

describe("building a database from nothing", () => {
  it("applies every migration to an empty database", async () => {
    // No seed first, no template, no existing rows: exactly what a new
    // environment starts with.
    await expect(migrate(urlFor(NAME))).resolves.not.toThrow();
    pool = new Pool({ connectionString: urlFor(NAME) });

    const applied = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(applied.rows[0].n).toBeGreaterThan(70);
  }, 180_000);

  it("defines AUDITOR's base-read permission codes from the migration alone (P-002)", async () => {
    // 097_auditor_base_reads.sql. Its role_permissions grant is joined
    // against `roles WHERE code = 'AUDITOR'` -- on a genuinely empty
    // database the ten base system roles (AUDITOR among them) do not exist
    // yet, since only seedDatabase() creates them (migration 031 is the
    // exception, for the two tender-domain roles it adds directly), so that
    // half of 097 is a no-op here and the seed's canonical map is what
    // actually grants AUDITOR the two codes (checked below). What the
    // migration alone is responsible for on a fresh database, and what this
    // asserts, is the permissions-catalog half: the codes must exist before
    // any role can hold them.
    const defined = await pool.query(
      `SELECT code FROM permissions WHERE code IN ('expense.read', 'org.units.read') ORDER BY code`,
    );
    expect(defined.rows.map((r) => r.code)).toEqual(["expense.read", "org.units.read"]);
  });

  it("grants GOVT_OBSERVER notification.read from the migration alone (098)", async () => {
    // Unlike AUDITOR, GOVT_OBSERVER is created by a migration (071, the same
    // way 031 creates the two tender-domain roles) rather than only by the
    // seed -- so 098's role_permissions grant is not a no-op here, and can be
    // checked directly after migrate(), with no seedDatabase() call yet.
    const granted = await pool.query(
      `SELECT rp.permission_code
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'GOVT_OBSERVER' AND r.org_id IS NULL
          AND rp.permission_code = 'notification.read'`,
    );
    expect(granted.rows).toHaveLength(1);
  });

  it("grants nothing it has not defined", async () => {
    /*
     * The failure itself, asserted directly. Every permission any migration
     * hands to a role has to exist as a permission, or the foreign key
     * refuses it — which is what happened, only nobody ran it anywhere the
     * seed had not already been.
     */
    const orphans = await pool.query(
      `SELECT rp.permission_code
         FROM role_permissions rp
         LEFT JOIN permissions p ON p.code = rp.permission_code
        WHERE p.code IS NULL`);
    expect(orphans.rows).toEqual([]);
  });

  it("seeds on top of it", async () => {
    const { orgId } = await seedDatabase(pool, { bcryptRounds: 4 });
    expect(orgId).toBeTruthy();

    const roles = await pool.query("SELECT code FROM roles");
    for (const code of ROLE_CODES) {
      expect(roles.rows.map(r => r.code), code).toContain(code);
    }

    // P-002: AUDITOR holds expense.read_all and employee.read but routes in
    // both modules gate on the base permission first. A fresh build (seed
    // running straight after migrate, same as this describe block) must
    // converge on the fixed grants without needing 097's role_permissions
    // half, since the seed's own canonical map already pairs them.
    const auditorPerms = await pool.query(
      `SELECT rp.permission_code
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'AUDITOR' AND r.org_id IS NULL
          AND rp.permission_code IN ('expense.read', 'org.units.read')
        ORDER BY rp.permission_code`,
    );
    expect(auditorPerms.rows.map((r) => r.permission_code)).toEqual([
      "expense.read",
      "org.units.read",
    ]);
  }, 180_000);

  it("ends with a survey module that can be used", async () => {
    // The six stages of the pipeline and the permissions that drive them:
    // a schema that builds but cannot run the module is not a build.
    // NOTIFICATION (§086) sits after FINAL_DELIVERABLES.
    const stages = await pool.query(
      "SELECT code FROM survey_stages WHERE active ORDER BY display_order");
    expect(stages.rows.map(r => r.code)).toEqual([
      "GROUND_TRUTHING", "GT_QC", "VECTORIZATION",
      "DATA_SUBMISSION", "FINAL_DELIVERABLES", "NOTIFICATION", "REWORK",
    ]);

    const perms = await pool.query(
      "SELECT code FROM permissions WHERE code LIKE 'survey.%'");
    for (const code of SURVEY_PERMISSIONS) {
      expect(perms.rows.map(r => r.code), code).toContain(code);
    }
  });
});

describe("097 on an already-deployed database (P-002)", () => {
  // The scenario the migration actually exists for: a database seeded long
  // ago, before 167ffea's packages/shared fix, carrying AUDITOR's old,
  // narrower grant. A redeploy ships the new source, but nothing re-runs
  // seedDatabase() against a live environment -- migrate() is the only thing
  // that touches its role_permissions. Simulated here by building fully
  // (migrate + seed, so AUDITOR and the two permission codes already exist,
  // same as any real deployment), stripping the two grants back to the
  // pre-097 state, then re-running 097's own SQL directly -- the same
  // statement migrate() would run were it pending.
  const NAME = `silverline_upgrade_${process.pid}_test`;

  function urlFor(db: string): string {
    const u = new URL(testDatabaseUrl());
    u.pathname = `/${db}`;
    return u.toString();
  }

  async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: urlFor("postgres") });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  }

  let pool: Pool;

  beforeAll(async () => {
    await admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${NAME}"`);
      await c.query(`CREATE DATABASE "${NAME}"`);
    });
    await migrate(urlFor(NAME));
    pool = new Pool({ connectionString: urlFor(NAME) });
    await seedDatabase(pool, { bcryptRounds: 4 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${NAME}"`));
  }, 120_000);

  it("re-grants expense.read and org.units.read to AUDITOR when they are missing", async () => {
    await pool.query(
      `DELETE FROM role_permissions
        WHERE permission_code IN ('expense.read', 'org.units.read')
          AND role_id = (SELECT id FROM roles WHERE code = 'AUDITOR' AND org_id IS NULL)`,
    );
    const before = await pool.query(
      `SELECT permission_code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'AUDITOR' AND r.org_id IS NULL
          AND permission_code IN ('expense.read', 'org.units.read')`,
    );
    expect(before.rows).toEqual([]);

    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)),
        "../src/database/migrations/097_auditor_base_reads.sql"),
      "utf8",
    );
    await pool.query(sql);

    const after = await pool.query(
      `SELECT permission_code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'AUDITOR' AND r.org_id IS NULL
          AND permission_code IN ('expense.read', 'org.units.read')
        ORDER BY permission_code`,
    );
    expect(after.rows.map((r) => r.permission_code)).toEqual([
      "expense.read",
      "org.units.read",
    ]);
  });
});

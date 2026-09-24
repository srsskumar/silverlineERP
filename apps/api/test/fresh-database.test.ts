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

  it("grants SALES_BD_EXECUTIVE and BID_TENDER_MANAGER notification.read from the migration alone (100)", async () => {
    // Both roles are created by 031_commercial_permissions.sql, not only by
    // the seed, so 100's role_permissions grant is not a no-op here and can
    // be checked directly after migrate(), with no seedDatabase() call yet —
    // the same shape as 098's GOVT_OBSERVER check (fd4a046).
    const granted = await pool.query(
      `SELECT r.code AS role_code
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code IN ('SALES_BD_EXECUTIVE', 'BID_TENDER_MANAGER') AND r.org_id IS NULL
          AND rp.permission_code = 'notification.read'
        ORDER BY r.code`,
    );
    expect(granted.rows.map((r) => r.role_code)).toEqual(['BID_TENDER_MANAGER', 'SALES_BD_EXECUTIVE']);
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

    // Owner decision 2026-09-24 #4 / 112_auditor_legalhold_release.sql:
    // AUDITOR may place a legal hold but not release one. 112's own DELETE
    // is a no-op on a genuinely empty database -- AUDITOR does not exist
    // until seedDatabase() creates it -- so what a fresh build actually
    // rests on is the seed's canonical grant map (packages/shared's
    // DOCUMENT_ROLE_GRANTS.AUDITOR) already excluding the release grant.
    const auditorHold = await pool.query(
      `SELECT rp.permission_code
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'AUDITOR' AND r.org_id IS NULL
          AND rp.permission_code IN ('document.legalhold', 'document.legalhold.release')
        ORDER BY rp.permission_code`,
    );
    expect(auditorHold.rows.map((r) => r.permission_code)).toEqual(["document.legalhold"]);
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

describe("112 on an already-deployed database (owner decision 2026-09-24 #4)", () => {
  // The scenario 112 exists for: a database seeded before this decision,
  // carrying AUDITOR's old grant -- document.legalhold *and*
  // document.legalhold.release, seeded together by 082 back when the two
  // were not yet distinguished. A redeploy ships the new packages/shared
  // source, but nothing re-runs seedDatabase() against a live environment --
  // migrate() is the only thing that touches its role_permissions. Simulated
  // here the same way 097's own already-deployed test is: build fully
  // (migrate + seed), put AUDITOR back in the pre-112 state, then re-run
  // 112's own SQL directly -- the same statement migrate() would run were it
  // pending.
  const NAME = `silverline_auditor_hold_${process.pid}_test`;

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

  it("revokes AUDITOR's document.legalhold.release while leaving document.legalhold alone", async () => {
    // Put AUDITOR back in the pre-decision state: both grants present, as
    // 082 would have left any deployment seeded before this decision.
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       SELECT id, 'document.legalhold.release' FROM roles WHERE code = 'AUDITOR' AND org_id IS NULL
       ON CONFLICT (role_id, permission_code) DO NOTHING`,
    );
    const before = await pool.query(
      `SELECT rp.permission_code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'AUDITOR' AND r.org_id IS NULL
          AND rp.permission_code IN ('document.legalhold', 'document.legalhold.release')
        ORDER BY rp.permission_code`,
    );
    expect(before.rows.map((r) => r.permission_code)).toEqual([
      "document.legalhold",
      "document.legalhold.release",
    ]);

    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)),
        "../src/database/migrations/112_auditor_legalhold_release.sql"),
      "utf8",
    );
    await pool.query(sql);

    const after = await pool.query(
      `SELECT rp.permission_code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'AUDITOR' AND r.org_id IS NULL
          AND rp.permission_code IN ('document.legalhold', 'document.legalhold.release')
        ORDER BY rp.permission_code`,
    );
    expect(after.rows.map((r) => r.permission_code)).toEqual(["document.legalhold"]);

    // Idempotent: running it again changes nothing and errors on nothing.
    await expect(pool.query(sql)).resolves.not.toThrow();
  });
});

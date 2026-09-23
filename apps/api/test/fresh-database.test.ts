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

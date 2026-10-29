/**
 * `seedDatabase()` reuses one canonical organization (named `DEMO_ORG_NAME`)
 * across every caller, rather than creating a fresh one each time -- see
 * its own "existingOrg" lookup. Every file in this suite that doesn't build
 * its own isolated world (test/catalogue/fixture.ts's `buildWorld`) goes
 * through that same reuse, and test/s2.test.ts calls it fresh in its own
 * `beforeEach` -- forty times in one file, back to back, truncating `users`
 * (but not `organizations`) ahead of each call.
 *
 * That exposed a real race: the admin user was written with
 * `INSERT ... ON CONFLICT (org_id, username) DO NOTHING` and then looked up
 * with a separate `SELECT`, and on a rare pass the SELECT came back empty --
 * `adminRow.rows[0]` undefined, crashing whichever test's `beforeEach` was
 * running (caught live while chasing this suite's flakiness: `requires
 * Idempotency-Key` in test/s2.test.ts failed on exactly this at
 * src/database/seed.ts:256). Fixed by folding the insert and the lookup
 * into one statement (`... DO UPDATE ... RETURNING id`), so there is no
 * window between "the row exists" and "read the row" for the next truncate
 * to land in.
 *
 * This reproduces the shape of that gap directly -- the same reseed-the-
 * same-org cycle test/s2.test.ts runs in its `beforeEach`, repeated enough
 * times in a tight loop to have reliably hit the old race -- rather than
 * relying on test/s2.test.ts's own flakiness (roughly 1 in 50 runs) to
 * prove it's gone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { testDatabaseUrl } from "./database.js";
import { VOLATILE_TABLES } from "./tables.js";
import { migrate } from "../src/database/migrate.js";
import { seedDatabase } from "../src/database/seed.js";

const TEST_DB = testDatabaseUrl();
let pool: Pool;

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe("seedDatabase() reseeding the same reused organization", () => {
  it("never loses the admin row it just wrote, across many back-to-back reseeds", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      await pool.query(`TRUNCATE TABLE ${VOLATILE_TABLES}`);
      const { orgId, adminId } = await seedDatabase(pool, { bcryptRounds: 4 });
      expect(orgId, `iteration ${i}`).toBeTruthy();
      expect(adminId, `iteration ${i}`).toBeTruthy();
      ids.add(orgId);
      // The row seedDatabase() just reported really exists -- the same
      // guarantee the old INSERT + separate SELECT was supposed to give,
      // checked independently of whatever connection seedDatabase() used.
      const row = await pool.query("SELECT id FROM users WHERE id = $1::uuid", [adminId]);
      expect(row.rowCount, `iteration ${i}`).toBe(1);
    }
    // Every iteration reused the one canonical org (by design -- see the
    // file comment); this is the fact that makes the race above possible
    // in the first place, asserted so a future change that makes
    // seedDatabase() create a fresh org per call doesn't make this test
    // pass for a different reason without anyone noticing the shape of
    // what it was proving changed too.
    expect(ids.size).toBe(1);
    // ~10 s alone; CI runs four shards on two cores and has hit 60 s.
  }, 180_000);
});

/**
 * Creates the per-worker databases before any test runs.
 *
 * One database per worker, so the fifty-nine files that each truncate and
 * reseed can run alongside each other instead of queueing. Created from the
 * plain test database as a template where one exists, which skips the
 * migration run in every worker but the first.
 */
import { Client } from "pg";
import { TEST_SHARDS, shardDatabaseUrl, testDatabaseUrl } from "./database.js";
import { VOLATILE_TABLES } from "./tables.js";

function nameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** The same server, pointed at `postgres` so CREATE DATABASE is allowed. */
function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

export async function setup(): Promise<void> {
  const base = testDatabaseUrl();
  const template = nameOf(base);
  const admin = new Client({ connectionString: adminUrl(base) });
  await admin.connect();
  try {
    /*
     * Don't wait for the disk on every commit.
     *
     * This suite spends its time writing rows it is about to throw away —
     * fifty-nine files that truncate and reseed the world before they start.
     * `synchronous_commit` buys durability across a power cut, which is worth
     * nothing at all to a database whose entire contents are rebuilt by the
     * next run. Set on the database rather than the session so it applies to
     * every connection any of this opens, and only ever to a name that has
     * already been refused unless it says `_test`.
     */
    await admin.query(
      `ALTER DATABASE "${template.replace(/"/g, '""')}" SET synchronous_commit = off`);

    // Only built when the suite is actually spread across workers.
    for (let shard = 1; shard < TEST_SHARDS && process.env.TEST_SHARDS; shard += 1) {
      const name = nameOf(shardDatabaseUrl(base, shard));
      const exists = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount) continue;
      /*
       * Quoted by hand because CREATE DATABASE takes no parameters. The name
       * is built from a URL this process already refused unless it ended in
       * `_test`, and the quotes stop anything odd in it being read as SQL.
       */
      /*
       * Copied from the base test database rather than built from nothing.
       *
       * Two reasons. It is far quicker — a template copy is a file copy,
       * where a from-scratch run is seventy-odd migrations — and it means the
       * shards are the same schema the suite has always run against rather
       * than a second, subtly different one.
       */
      await admin.query(
        `CREATE DATABASE "${name.replace(/"/g, '""')}" TEMPLATE "${
          template.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  /*
   * `organizations` is deliberately left out of every file's own TRUNCATE
   * -- see test/catalogue/fixture.ts -- so that per-worker shards can reuse
   * seeded reference data instead of rebuilding it fifty-nine times over.
   * That is only safe when each worker's database is thrown away between
   * runs, which was the point of sharding in the first place. It never
   * shards in this configuration: `poolOptions.forks.singleFork` means
   * there is exactly one worker for the whole suite, so
   * `testDatabaseUrl()`'s shard formula resolves to shard 0 on every call,
   * and every file -- across every invocation of this test command,
   * forever, since nothing ever drops this database -- writes into the one
   * base database. Organizations that `seedDatabase()` has created across
   * literal years of test runs were still sitting in this table (471 of
   * them, found while chasing a flaky suite). That matters beyond tidiness:
   * `seedDatabase()` backfills a default payroll policy for every
   * organization that has ever existed (src/database/seed.ts, by design --
   * a real install only ever seeds once, and the backfill is for a
   * migration-like upgrade of an existing one), so its cost grows with the
   * lifetime total, not with this run's size, and that cost is paid on
   * every file's `beforeAll` and, in files that reseed per test
   * (test/s2.test.ts), on every single test. The result is real, growing,
   * run-to-run-varying latency with no bound, which is exactly the kind of
   * hidden timing difference that turns into "a different file fails every
   * time" once enough of the suite's date/window logic is sensitive to it.
   *
   * Truncated here, once, before any test file runs, rather than added to
   * every file's own list: the fix is for the cross-run accumulation this
   * configuration allows, not for what any one file does during its own
   * run. `roles` stays out of it deliberately -- some of its rows (the
   * system roles 031/071/098/100 insert directly, GOVT_OBSERVER among them,
   * per fresh-database.test.ts) are written once by a migration that
   * `migrate()` will not run again, so truncating the table would lose them
   * for the rest of this run with nothing left to put them back. Only the
   * org-scoped rows a test created on top of them -- the ones that would
   * block truncating `organizations` on the foreign key -- are cleared.
   */
  const baseClient = new Client({ connectionString: base });
  await baseClient.connect();
  try {
    await baseClient.query("DELETE FROM roles WHERE org_id IS NOT NULL");
    await baseClient.query(`TRUNCATE TABLE ${VOLATILE_TABLES}`);
    // Not folded into the TRUNCATE above: `roles` carries a (now all-null)
    // foreign key to `organizations`, and Postgres refuses to truncate a
    // table some other table references unless that other table is
    // truncated in the same statement too -- which `roles` cannot be (see
    // the comment above). DELETE has no such restriction; it only checks
    // the rows actually being removed, and the DELETE just above already
    // cleared every row that pointed at an organization.
    await baseClient.query("DELETE FROM organizations");
  } finally {
    await baseClient.end();
  }
}

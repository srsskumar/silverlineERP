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
}

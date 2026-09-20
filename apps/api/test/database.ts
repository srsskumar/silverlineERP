/** Test suites truncate tables. Refuse any database not explicitly named as a test database. */

/**
 * How many databases the suite is willing to spread itself across.
 *
 * Matched to `maxForks` in vitest.config.ts. The two have to agree: a worker
 * that computes a name outside the set globalSetup created would find no
 * database at all.
 */
export const TEST_SHARDS = Number(process.env.TEST_SHARDS ?? 4);

/**
 * The database for this worker.
 *
 * The suite spent most of its wall time building the same world fifty-nine
 * times over, once per file, one after another — eleven tests in a file, and
 * three of the four seconds they took were the setup in front of them. The
 * files cannot share a database because each truncates and reseeds, so the
 * way to overlap them is to give each worker its own.
 *
 * Shard 0 keeps the plain name, so a developer running one file by hand, or
 * anything outside vitest, lands on `silverline_test` exactly as before.
 */
export function shardDatabaseUrl(base: string, shard: number): string {
  if (!shard) return base;
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.slice(1));
  // The suffix goes before `_test`, not after it: the guard below insists the
  // name still says out loud that it is a test database.
  url.pathname = `/${name.replace(/_test$/, '')}_w${shard}_test`;
  return url.toString();
}

export function testDatabaseUrl():string {
 const value=process.env.TEST_DATABASE_URL??'postgresql://localhost:5432/silverline_test';
 const name=decodeURIComponent(new URL(value).pathname.slice(1));
 if(!/(^test_|_test$)/.test(name))throw new Error('TEST_DATABASE_URL must point to a dedicated database named test_* or *_test');
 // VITEST_POOL_ID is 1-based and set per worker; anything else is shard 0.
 const pool = Number(process.env.VITEST_POOL_ID ?? 0);
 const shard = Number.isFinite(pool) && pool > 1 ? (pool - 1) % TEST_SHARDS : 0;
 return shardDatabaseUrl(value, shard);
}

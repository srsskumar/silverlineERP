import { Pool, types } from "pg";

// Return Postgres DATE columns as 'YYYY-MM-DD' strings instead of Date.
// A Date at local midnight serializes to the previous day via toISOString()
// on negative-offset hosts, silently shifting every date in API responses.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

/** Where the suite's setup time actually goes. Run: npx tsx test/profile-setup.ts */
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { migrate } from "../src/database/migrate.js";
import { seedDatabase } from "../src/database/seed.js";
import { VOLATILE_TABLES } from "./tables.js";
import { testDatabaseUrl } from "./database.js";

async function main(): Promise<void> {
  const url = testDatabaseUrl();
  const marks: Array<[string, number]> = [];
  let s = performance.now();
  await migrate(url);
  marks.push(["migrate", performance.now() - s]);

  const pool = new Pool({ connectionString: url });
  s = performance.now();
  await pool.query(`TRUNCATE TABLE ${VOLATILE_TABLES}`);
  marks.push(["truncate", performance.now() - s]);

  s = performance.now();
  await seedDatabase(pool, { bcryptRounds: 4 });
  marks.push(["seed", performance.now() - s]);
  await pool.end();

  for (const [l, ms] of marks) console.log("%s\t%d ms", l.padEnd(10), Math.round(ms));
}
main().catch(e => { console.error(e); process.exit(1); });

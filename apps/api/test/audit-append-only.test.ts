import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { testDatabaseUrl } from "./database.js";
import { migrate } from "../src/database/migrate.js";

/**
 * AUTH-7 (§077) -- the audit trail cannot be edited after the fact.
 *
 * It was append-only by convention. Now the database refuses an UPDATE or a
 * DELETE on any row, whoever sends it; only TRUNCATE, which the suites use
 * to reset, still works.
 */

const TEST_DB = testDatabaseUrl();
let pool: Pool;

async function oneEvent(): Promise<string> {
  return (await pool.query(
    `INSERT INTO audit_events (action, entity_type, reason)
     VALUES ('test.append_only', 'test', 'original') RETURNING id`,
  )).rows[0].id as string;
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
});

afterAll(async () => {
  await pool.end();
});

describe("audit_events is append-only", () => {
  it("still takes new rows", async () => {
    const id = await oneEvent();
    expect((await pool.query("SELECT 1 FROM audit_events WHERE id = $1", [id])).rowCount).toBe(1);
  });

  it("refuses an UPDATE", async () => {
    const id = await oneEvent();
    await expect(
      pool.query("UPDATE audit_events SET reason = 'rewritten' WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
    const row = await pool.query("SELECT reason FROM audit_events WHERE id = $1", [id]);
    expect(row.rows[0].reason).toBe("original");
  });

  it("refuses a DELETE", async () => {
    const id = await oneEvent();
    await expect(pool.query("DELETE FROM audit_events WHERE id = $1", [id])).rejects.toThrow(/append-only/);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE id = $1", [id])).rowCount).toBe(1);
  });
});

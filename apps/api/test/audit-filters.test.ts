import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { VOLATILE_TABLES } from "./tables.js";
import { testDatabaseUrl } from "./database.js";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, seedDatabase } from "../src/database/seed.js";

/**
 * AUTH-12 -- asking the audit trail about one person, one record, or a
 * span of days.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";
let adminId = "";
let headers: Record<string, string> = {};

async function event(opts: { actor?: string | null; entity?: string; at: string }): Promise<string> {
  return (await pool.query(
    `INSERT INTO audit_events (org_id, actor_id, action, entity_type, entity_id, created_at)
     VALUES ($1, $2, 'test.filter', 'probe', $3, $4) RETURNING id`,
    [orgId, opts.actor ?? null, opts.entity ?? randomUUID(), opts.at],
  )).rows[0].id as string;
}

async function ids(query: string): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: `/api/v1/audit?action=test.filter&limit=100&${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { data: Array<{ id: string }> }).data.map((r) => r.id);
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({ databaseUrl: TEST_DB, jwtSecret: JWT_SECRET, loginRateLimitMax: 1000 });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${VOLATILE_TABLES}`);
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  adminId = seed.adminId;
  // organizations survives between suites, so say which timezone we mean.
  await pool.query(
    `UPDATE organizations SET settings = settings || '{"timezone":"Asia/Kolkata"}'::jsonb WHERE id = $1`,
    [orgId],
  );
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  headers = { authorization: `Bearer ${(res.json() as { access_token: string }).access_token}` };
});

describe("filtering the audit trail", () => {
  it("by who did it", async () => {
    const mine = await event({ actor: adminId, at: "2026-03-03T06:00:00Z" });
    const anon = await event({ actor: null, at: "2026-03-03T06:00:00Z" });
    const got = await ids(`actor_id=${adminId}`);
    expect(got).toContain(mine);
    expect(got).not.toContain(anon);
  });

  it("by the record it happened to", async () => {
    const record = randomUUID();
    const hit = await event({ entity: record, at: "2026-03-03T06:00:00Z" });
    const miss = await event({ at: "2026-03-03T06:00:00Z" });
    expect(await ids(`entity_id=${record}`)).toEqual([hit]);
    expect(await ids(`entity_id=${record}`)).not.toContain(miss);
  });

  it("by day, in the organisation's timezone and inclusive at both ends", async () => {
    // 01:30 on the 3rd in Kolkata, though still the 2nd in UTC.
    const earlyThird = await event({ at: "2026-03-02T20:00:00Z" });
    const lateThird = await event({ at: "2026-03-03T18:00:00Z" });
    // 00:30 on the 4th in Kolkata, though still the 3rd in UTC.
    const fourth = await event({ at: "2026-03-03T19:00:00Z" });
    const second = await event({ at: "2026-03-02T12:00:00Z" });

    const third = await ids("from=2026-03-03&to=2026-03-03");
    expect(third.sort()).toEqual([earlyThird, lateThird].sort());

    expect(await ids("from=2026-03-04")).toContain(fourth);
    expect(await ids("from=2026-03-04")).not.toContain(lateThird);
    expect(await ids("to=2026-03-02")).toEqual([second]);
  });

  it("refuses a malformed filter rather than ignoring it", async () => {
    for (const q of ["actor_id=not-a-uuid", "entity_id=42", "from=03/03/2026", "to=2026-02-30"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/audit?${q}`, headers });
      expect(res.statusCode, q).toBe(422);
    }
  });
});

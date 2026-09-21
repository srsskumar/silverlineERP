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
 * §077 -- the catalogue and a project's agreed supply schedule.
 *
 * The arithmetic is unit-tested in shared. What is tested here is the part
 * a database can get wrong: that a line keeps its own copy of the price
 * when the standard rate moves, that a measured contract is refused one of
 * these, and that the tax heads are left unsaid rather than guessed.
 */

const TEST_DB = testDatabaseUrl();
let app: FastifyInstance;
let pool: Pool;
let orgId = "";

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login", payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return { authorization: `Bearer ${(res.json() as { access_token: string }).access_token}` };
}

async function mkProject(headers: Record<string, string>, typeCode: string) {
  const ws = await app.inject({
    method: "POST", url: "/api/v1/workspaces", headers,
    payload: { name: `WS${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const type = await pool.query("SELECT id FROM project_types WHERE code=$1 AND org_id=$2",
    [typeCode, orgId]);
  const res = await app.inject({
    method: "POST", url: "/api/v1/projects", headers,
    payload: {
      workspace_id: (ws.json() as { id: string }).id,
      code: `P${Date.now()}${Math.floor(Math.random() * 10000)}`.slice(0, 16),
      name: "Supply project",
      project_type_id: type.rows[0]?.id,
    },
  });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  return (res.json() as { id: string }).id;
}

async function mkItem(headers: Record<string, string>, over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/catalogue-items", headers,
    payload: {
      code: `CAT${Date.now()}${Math.floor(Math.random() * 10000)}`.slice(0, 20),
      name: "GNSS rover", kind: "GOOD", uom: "nos", hsn_sac: "90158030",
      standard_rate: 250000, gst_rate: 18, ...over,
    },
  });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  return (res.json() as { data: { id: string } }).data;
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({
    databaseUrl: TEST_DB, jwtSecret: "test-secret-change-me", loginRateLimitMax: 1000,
  });
});
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${VOLATILE_TABLES}`);
  orgId = (await seedDatabase(pool, { bcryptRounds: 4 })).orgId;
});

describe("the catalogue", () => {
  it("holds what we sell and what we normally charge", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const item = await mkItem(admin);
    expect(item.id).toBeTruthy();
    const list = await app.inject({
      method: "GET", url: "/api/v1/catalogue-items", headers: admin,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { data: unknown[] }).data.length).toBe(1);
  });

  it("refuses a second live item with the same code", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const item = await mkItem(admin);
    const again = await app.inject({
      method: "POST", url: "/api/v1/catalogue-items", headers: admin,
      payload: {
        code: (await pool.query("SELECT code FROM catalogue_items WHERE id=$1", [item.id])).rows[0].code,
        name: "Another", kind: "GOOD", uom: "nos", standard_rate: 1, gst_rate: 18,
      },
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses a GST rate that is not a slab", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await app.inject({
      method: "POST", url: "/api/v1/catalogue-items", headers: admin,
      payload: { code: `X${Date.now()}`, name: "Typo", kind: "GOOD", uom: "nos",
        standard_rate: 100, gst_rate: 1.8 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("archives rather than deletes, so a contract can still say where a line came from", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const item = await mkItem(admin);
    const res = await app.inject({
      method: "PATCH", url: `/api/v1/catalogue-items/${item.id}`, headers: admin,
      payload: { status: "ARCHIVED" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { status: string } }).data.status).toBe("ARCHIVED");
    const live = await app.inject({ method: "GET", url: "/api/v1/catalogue-items", headers: admin });
    expect((live.json() as { data: unknown[] }).data.length).toBe(0);
  });
});

describe("a project's schedule", () => {
  it("totals the money, splits nothing it cannot know, and says it in words", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "goods");
    const item = await mkItem(admin);

    const put = await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: [
        { catalogue_item_id: item.id, description: "GNSS rover", uom: "nos",
          quantity: 10, unit_price: 250000, gst_rate: 18, hsn_sac: "90158030" },
        { description: "Training, on site", uom: "day", quantity: 2,
          unit_price: 11800, gst_rate: 18, price_includes_gst: true },
      ] },
    });
    expect(put.statusCode, JSON.stringify(put.json())).toBe(200);

    const got = await app.inject({
      method: "GET", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
    });
    expect(got.statusCode).toBe(200);
    const body = (got.json() as { data: Record<string, unknown> }).data;
    const totals = body.totals as Record<string, unknown>;
    expect(totals.taxable).toBe(2500000 + 20000);
    expect(totals.gst).toBe(450000 + 3600);
    expect(totals.gross).toBe(2973600);
    expect(String(totals.in_words)).toContain('Twenty Nine Lakh Seventy Three Thousand Six Hundred');
    // No GST state on either side, so the heads are left unsaid.
    expect(totals.treatment).toBeNull();
    expect((body.split_blocked_by as string[]).length).toBeGreaterThan(0);
  });

  it("names the tax heads once both states are known", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "goods");
    await pool.query(
      `UPDATE organizations SET settings = COALESCE(settings,'{}'::jsonb)
         || jsonb_build_object('gst_state_code','37') WHERE id=$1`, [orgId]);
    const client = await pool.query(
      `INSERT INTO clients (org_id, code, name, state)
       VALUES ($1,$2,$3,'Andhra Pradesh') RETURNING id`,
      [orgId, `CL${randomUUID().slice(0, 6)}`, `Client ${randomUUID().slice(0, 6)}`]);
    await pool.query("UPDATE projects SET client_id=$1 WHERE id=$2", [client.rows[0].id, projectId]);

    await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: [{ description: "Rover", uom: "nos", quantity: 1,
        unit_price: 100000, gst_rate: 18 }] },
    });
    const got = await app.inject({
      method: "GET", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
    });
    const totals = (got.json() as { data: { totals: Record<string, unknown> } }).data.totals;
    expect(totals.treatment).toBe("INTRA_STATE");
    expect(totals.cgst).toBe(9000);
    expect(totals.sgst).toBe(9000);
    expect(totals.igst).toBe(0);
  });

  it("keeps the agreed price when the standard rate moves", async () => {
    /*
     * The whole reason the line carries its own copy. A price rise next
     * quarter must not restate a contract signed last quarter.
     */
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "goods");
    const item = await mkItem(admin, { standard_rate: 250000 });

    await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: [{ catalogue_item_id: item.id, description: "Rover",
        uom: "nos", quantity: 1, unit_price: 225000, gst_rate: 18 }] },
    });
    await app.inject({
      method: "PATCH", url: `/api/v1/catalogue-items/${item.id}`, headers: admin,
      payload: { standard_rate: 300000 },
    });

    const got = await app.inject({
      method: "GET", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
    });
    const lines = (got.json() as { data: { lines: Array<Record<string, unknown>> } }).data.lines;
    expect(lines[0].unit_price).toBe(225000);
    // ...and the current standard rate rides along, so the screen can show the gap.
    expect(lines[0].standard_rate).toBe(300000);
  });

  it("survives the catalogue item being archived, and remembers the line anyway", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "amc");
    const item = await mkItem(admin, { kind: "AMC" });
    await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: [{ catalogue_item_id: item.id, description: "Annual maintenance",
        uom: "year", quantity: 1, unit_price: 120000, gst_rate: 18 }] },
    });
    await app.inject({
      method: "PATCH", url: `/api/v1/catalogue-items/${item.id}`, headers: admin,
      payload: { status: "ARCHIVED" },
    });
    const got = await app.inject({
      method: "GET", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
    });
    const lines = (got.json() as { data: { lines: Array<Record<string, unknown>> } }).data.lines;
    expect(lines.length).toBe(1);
    expect(lines[0].description).toBe("Annual maintenance");
  });

  it("refuses a schedule on a measured contract, and says why", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "fieldwork");
    const res = await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: [{ description: "X", uom: "nos", quantity: 1, unit_price: 1, gst_rate: 18 }] },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain("bill of quantities");
  });

  it("says a measured contract does not get one, rather than showing an empty table", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "fieldwork");
    const got = await app.inject({
      method: "GET", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
    });
    expect((got.json() as { data: { applies: boolean } }).data.applies).toBe(false);
  });

  it("replaces the list wholesale, because the client agreed to a list", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "goods_and_services");
    const three = [1, 2, 3].map((n) => ({
      description: `Item ${n}`, uom: "nos", quantity: n, unit_price: 1000, gst_rate: 18,
    }));
    await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: three },
    });
    await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: [three[1]] },
    });
    const got = await app.inject({
      method: "GET", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
    });
    const lines = (got.json() as { data: { lines: Array<{ description: string; line_no: number }> } }).data.lines;
    expect(lines.map((l) => l.description)).toEqual(["Item 2"]);
    // Renumbered from one, so the document reads as a document.
    expect(lines[0].line_no).toBe(1);
  });

  it("refuses a catalogue item from another organisation", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const projectId = await mkProject(admin, "goods");
    const res = await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/supply`, headers: admin,
      payload: { lines: [{ catalogue_item_id: randomUUID(), description: "X",
        uom: "nos", quantity: 1, unit_price: 1, gst_rate: 18 }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("404s on a project that is not ours", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await app.inject({
      method: "GET", url: `/api/v1/projects/${randomUUID()}/supply`, headers: admin,
    });
    expect(res.statusCode).toBe(404);
  });
});

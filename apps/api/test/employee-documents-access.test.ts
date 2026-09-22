import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { VOLATILE_TABLES } from "./tables.js";
import { testDatabaseUrl } from "./database.js";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, seedDatabase } from "../src/database/seed.js";

/**
 * Who may open somebody's personal file.
 *
 * The employee document routes were gated on document.read alone. That was
 * the employee-file permission when they were written; the company document
 * register later reused the code and handed it to inventory managers,
 * payroll officers and bid managers, none of whom may open the directory.
 * On the production system an inventory manager could list and download
 * another employee's diploma while GET /employees/:id refused them.
 *
 * The rule now: reading or adding to an employee's file needs employee.read
 * for that employee as well, under whatever scope the caller holds it.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";
const PASSWORD = "Pass1234!";
const PDF = Buffer.from("%PDF-1.4 hello world", "utf8").toString("base64");

let app: FastifyInstance;
let pool: Pool;
let orgId = "";

async function createUser(prefix: string, roles: string[]): Promise<{ id: string; username: string }> {
  const username = `${prefix}_${randomUUID().slice(0, 8)}`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const id = (await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, username, hash],
  )).rows[0].id as string;
  for (const code of roles) {
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2",
      [id, code],
    );
  }
  return { id, username };
}

async function headersFor(username: string, password = PASSWORD) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login", payload: { username, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${(res.json() as { access_token: string }).access_token}` };
}

let seq = 0;
async function createEmployeeWithDocument(admin: Record<string, string>) {
  seq += 1;
  const created = await app.inject({
    method: "POST", url: "/api/v1/employees",
    headers: { ...admin, "idempotency-key": randomUUID() },
    payload: {
      emp_no: `DOC${String(seq).padStart(3, "0")}`, first_name: "Docs", last_name: "Holder",
      phone: `+9198000${String(10000 + seq)}`, date_of_joining: "2024-01-15",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const employeeId = (created.json() as { id: string }).id;
  const up = await app.inject({
    method: "POST", url: `/api/v1/employees/${employeeId}/documents`,
    headers: { ...admin, "idempotency-key": randomUUID() },
    payload: { doc_type: "id_proof", file_name: "aadhaar.pdf", content_base64: PDF },
  });
  expect(up.statusCode, up.body).toBe(201);
  return { employeeId, documentId: (up.json() as { id: string }).id };
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
});

describe("an employee's personal file", () => {
  it("is closed to a role that reads documents but may not read the person", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId, documentId } = await createEmployeeWithDocument(admin);
    const inventory = await headersFor((await createUser("inv", ["INVENTORY_MANAGER"])).username);

    // The premise: they hold document.read (the register is open to them)
    // and not employee.read (the directory is not).
    expect((await app.inject({ method: "GET", url: "/api/v1/documents", headers: inventory })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/employees/${employeeId}`, headers: inventory })).statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: `/api/v1/employees/${employeeId}/documents`, headers: inventory });
    expect(list.statusCode, list.body).toBe(403);
    expect((list.json() as { message: string }).message).toMatch(/employee\.read/);

    const download = await app.inject({
      method: "GET", url: `/api/v1/employees/${employeeId}/documents/${documentId}/download`, headers: inventory,
    });
    expect(download.statusCode).toBe(403);

    const upload = await app.inject({
      method: "POST", url: `/api/v1/employees/${employeeId}/documents`,
      headers: { ...inventory, "idempotency-key": randomUUID() },
      payload: { doc_type: "id_proof", file_name: "planted.pdf", content_base64: PDF },
    });
    expect(upload.statusCode).toBe(403);
    expect((await pool.query("SELECT count(*)::int AS n FROM employee_documents WHERE employee_id = $1", [employeeId])).rows[0].n).toBe(1);
  });

  it("stays open to somebody who may read the person", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId, documentId } = await createEmployeeWithDocument(admin);
    const hr = await headersFor((await createUser("hr", ["HR_MANAGER"])).username);

    const list = await app.inject({ method: "GET", url: `/api/v1/employees/${employeeId}/documents`, headers: hr });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { data: unknown[] }).data).toHaveLength(1);
    const download = await app.inject({
      method: "GET", url: `/api/v1/employees/${employeeId}/documents/${documentId}/download`, headers: hr,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toMatch(/aadhaar\.pdf/);
  });

  it("is closed to a team lead whose directory does not reach that employee", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId } = await createEmployeeWithDocument(admin);
    // A team lead holds document.read and employee.read, but on a project
    // scope that this employee is not on: the second permission's scope is
    // the one the record check runs under.
    const lead = await createUser("tl", []);
    const workspace = (await pool.query(
      "INSERT INTO workspaces (org_id, name) VALUES ($1, 'Docs scope') RETURNING id", [orgId],
    )).rows[0].id;
    const project = (await pool.query(
      "INSERT INTO projects (org_id, workspace_id, code, name) VALUES ($1, $2, 'TLDOCS', 'Team lead scope') RETURNING id",
      [orgId, workspace],
    )).rows[0].id;
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) SELECT $1, id, 'project', $2 FROM roles WHERE code = 'TEAM_LEAD'",
      [lead.id, project],
    );
    const headers = await headersFor(lead.username);
    const list = await app.inject({ method: "GET", url: `/api/v1/employees/${employeeId}/documents`, headers });
    expect(list.statusCode, list.body).toBe(403);
  });
});

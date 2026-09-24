import { VOLATILE_TABLES } from "./tables.js";
import {testDatabaseUrl} from "./database.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { computeSlaStatus } from "@silverline/shared";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  seedDatabase,
} from "../src/database/seed.js";

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";
let seq = 0;

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${VOLATILE_TABLES}`,
  );
}

async function createUser(opts: {
  username: string;
  password: string;
  roles?: string[];
}): Promise<string> {
  const hash = await bcrypt.hash(opts.password, 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, opts.username, hash],
  );
  const id = (res.rows[0] as { id: string }).id;
  for (const code of opts.roles ?? []) {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [code]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      id,
      (role.rows[0] as { id: string }).id,
    ]);
  }
  return id;
}

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const body = res.json() as { access_token: string };
  return { authorization: `Bearer ${body.access_token}` };
}

async function adminHeaders() {
  return headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
}

async function mkUser(
  roles: string[],
  tag: string,
): Promise<{ id: string; username: string; headers: Record<string, string> }> {
  const username = `s5_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const id = await createUser({ username, password: "Pass1234!", roles });
  return { id, username, headers: await headersFor(username, "Pass1234!") };
}

async function mkWorkspace(
  headers: Record<string, string>,
  name?: string,
): Promise<{ id: string }> {
  seq += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers,
    payload: { name: name ?? `S5WS-${seq}` },
  });
  expect(res.statusCode).toBe(201);
  return { id: (res.json() as { id: string }).id };
}

async function mkProject(
  headers: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const ws = await mkWorkspace(await adminHeaders());
  seq += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: {
      workspace_id: ws.id,
      code: `S5P${String(seq).padStart(5, "0")}`,
      name: `S5 Project ${seq}`,
      ...over,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; version: number };
  return { id: body.id, version: body.version };
}

async function mkTask(
  headers: Record<string, string>,
  projectId: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers,
    payload: { project_id: projectId, title: `S5 task ${randomUUID().slice(0, 8)}`, ...over },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; version: number };
  return { id: body.id, version: body.version };
}

interface BoardDetail {
  board: {
    id: string;
    project_id: string;
    name: string;
    view_type: string;
    filter_config: Record<string, unknown>;
    shared: boolean;
    version: number;
  };
  columns: Array<{
    id: string;
    status_code: string;
    name: string;
    position: number;
    wip_limit: number | null;
    color: string | null;
  }>;
}

async function mkBoard(
  headers: Record<string, string>,
  projectId: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  seq += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/boards",
    headers,
    payload: {
      project_id: projectId,
      name: `S5 Board ${seq}`,
      view_type: "KANBAN",
      ...over,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; version: number };
  return { id: body.id, version: body.version };
}

async function getBoard(
  headers: Record<string, string>,
  id: string,
): Promise<BoardDetail> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/boards/${id}`,
    headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as BoardDetail;
}

function empPayload(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    emp_no: `S5E${String(seq).padStart(5, "0")}`,
    first_name: "S5",
    last_name: "User",
    phone: `+9183000${String(10000 + seq)}`,
    date_of_joining: "2024-01-15",
    ...over,
  };
}

async function mkEmployee(
  headers: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers,
    payload: empPayload(over),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function linkUser(userId: string, employeeId: string): Promise<void> {
  await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [
    employeeId,
    userId,
  ]);
}

/** IST day helpers (keep SLA tests deterministic across timezones). */
function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function istPlusDays(n: number): string {
  const ms = Date.parse(`${istToday()}T00:00:00Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function inbox(headers: Record<string, string>, qs = "") {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/notifications${qs}`,
    headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    data: Array<{
      id: string;
      type: string;
      title: string;
      body: string;
      entity_type: string | null;
      entity_id: string | null;
      read_at: string | null;
      created_at: string;
    }>;
    next_cursor: string | null;
    has_more: boolean;
  };
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({
    databaseUrl: TEST_DB,
    jwtSecret: JWT_SECRET,
    loginRateLimitMax: 1000,
  });
});

afterAll(async () => {
  await pool.query(
    `TRUNCATE TABLE ${VOLATILE_TABLES}`,
  );
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  seq = 0;
});

// ------------------------------------------------------------------ boards

describe("boards", () => {
  it("auto-seeds KANBAN columns from the project workflow when omitted", async () => {
    const h = await adminHeaders();
    const pm = await mkUser(["PROJECT_MANAGER"], "pm");
    const p = await mkProject(h);
    const b = await mkBoard(pm.headers, p.id, { view_type: "KANBAN" });
    const detail = await getBoard(pm.headers, b.id);
    expect(detail.board.view_type).toBe("KANBAN");
    expect(detail.board.version).toBe(1);
    expect(detail.columns.map((c) => c.status_code)).toEqual([
      "TO_DO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "DONE",
      "BLOCKED",
      "CANCELLED",
    ]);
    expect(detail.columns.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(detail.columns.map((c) => c.name)).toEqual([
      "TO_DO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "DONE",
      "BLOCKED",
      "CANCELLED",
    ]);
  });

  it("creates a LIST board with zero columns when column_config is omitted", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const b = await mkBoard(h, p.id, { view_type: "LIST" });
    const detail = await getBoard(h, b.id);
    expect(detail.columns).toEqual([]);
  });

  it("honours explicit column_config (names, positions, wip limits, colors)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const b = await mkBoard(h, p.id, {
      view_type: "KANBAN",
      column_config: [
        { status_code: "TO_DO", name: "Backlog", position: 3, wip_limit: 5, color: "blue" },
        { status_code: "DONE" },
      ],
      filter_config: { assignee_me: true },
    });
    const detail = await getBoard(h, b.id);
    expect(detail.board.filter_config).toEqual({ assignee_me: true });
    expect(detail.columns.map((c) => c.status_code)).toEqual(["DONE", "TO_DO"]);
    const todo = detail.columns.find((c) => c.status_code === "TO_DO");
    expect(todo).toMatchObject({
      name: "Backlog",
      position: 3,
      wip_limit: 5,
      color: "blue",
    });
  });

  it("rejects an unknown status in column_config (422 UNKNOWN_STATUS)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/boards",
      headers: h,
      payload: {
        project_id: p.id,
        name: "Bad board",
        view_type: "KANBAN",
        column_config: [{ status_code: "NOPE" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("UNKNOWN_STATUS");
  });

  it("lists boards by project with the frozen item shape", async () => {
    const h = await adminHeaders();
    const pa = await mkProject(h);
    const pb = await mkProject(h);
    const b = await mkBoard(h, pa.id, { name: "Alpha board" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/boards?project_id=${pa.id}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBe(3);
    expect(body.data.find(row=>row.id===b.id)).toMatchObject({
      id: b.id,
      project_id: pa.id,
      name: "Alpha board",
      view_type: "KANBAN",
      shared: false,
      version: 1,
    });
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual(
      ["id", "project_id", "name", "view_type", "shared", "version"].sort(),
    );
    const other = await app.inject({
      method: "GET",
      url: `/api/v1/boards?project_id=${pb.id}`,
      headers: h,
    });
    expect(((other.json() as { data: unknown[] }).data).length).toBe(2);
  });

  it("PATCH updates config only and never mutates tasks", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id, { title: "Untouched" });
    const before = (
      await app.inject({ method: "GET", url: `/api/v1/tasks/${t.id}`, headers: h })
    ).json() as Record<string, unknown>;
    const b = await mkBoard(h, p.id, {});
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/boards/${b.id}`,
      headers: { ...h, "If-Match": "1" },
      payload: { name: "Renamed", shared: true, filter_config: { q: "x" } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: "Renamed",
      shared: true,
      filter_config: { q: "x" },
      version: 2,
    });
    const after = (
      await app.inject({ method: "GET", url: `/api/v1/tasks/${t.id}`, headers: h })
    ).json() as Record<string, unknown>;
    expect(after["version"]).toBe(before["version"]);
    expect(after["updated_at"]).toBe(before["updated_at"]);
    expect(after["title"]).toBe("Untouched");
    expect(after["status"]).toBe(before["status"]);
  });

  it("PUT replaces the column set and audits board.columns.update", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const b = await mkBoard(h, p.id, {});
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/boards/${b.id}/columns`,
      headers: { ...h, "If-Match": "1" },
      payload: { columns: [{ status_code: "DONE", name: "Shipped" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BoardDetail;
    expect(body.board.version).toBe(2);
    expect(body.columns.map((c) => c.status_code)).toEqual(["DONE"]);
    expect(body.columns[0]).toMatchObject({ name: "Shipped" });
    const audit = await pool.query(
      `SELECT id FROM audit_events WHERE action = 'board.columns.update' AND entity_id = $1::uuid`,
      [b.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("PUT rejects unknown statuses (422) and stale versions (409)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const b = await mkBoard(h, p.id, {});
    const bad = await app.inject({
      method: "PUT",
      url: `/api/v1/boards/${b.id}/columns`,
      headers: { ...h, "If-Match": "1" },
      payload: { columns: [{ status_code: "GHOST" }] },
    });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { code: string }).code).toBe("UNKNOWN_STATUS");
    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/boards/${b.id}/columns`,
      headers: { ...h, "If-Match": "999" },
      payload: { columns: [{ status_code: "DONE" }] },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("DELETE removes config but leaves tasks alone", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id, {});
    const b = await mkBoard(h, p.id, {});
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/boards/${b.id}`,
      headers: h,
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/boards/${b.id}`,
      headers: h,
    });
    expect(gone.statusCode).toBe(404);
    const task = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${t.id}`,
      headers: h,
    });
    expect(task.statusCode).toBe(200);
  });

  it("replays an Idempotency-Key without creating a second board", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const key = `board-${randomUUID()}`;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/boards",
      headers: { ...h, "Idempotency-Key": key },
      payload: { project_id: p.id, name: "First", view_type: "LIST" },
    });
    expect(first.statusCode).toBe(201);
    // A replay is the *same* request repeated, not a second, different one --
    // see the next test for what a genuinely different body now gets
    // (C-009: this route used to replay the first response regardless of the
    // second body, silently dropping the write it claimed to have made).
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/boards",
      headers: { ...h, "Idempotency-Key": key },
      payload: { project_id: p.id, name: "First", view_type: "LIST" },
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { id: string }).id).toBe(
      (first.json() as { id: string }).id,
    );
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/boards?project_id=${p.id}`,
      headers: h,
    });
    expect(((list.json() as { data: unknown[] }).data).length).toBe(3);
  });

  it("rejects an Idempotency-Key reused with a different body (C-009)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const key = `board-${randomUUID()}`;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/boards",
      headers: { ...h, "Idempotency-Key": key },
      payload: { project_id: p.id, name: "First", view_type: "LIST" },
    });
    expect(first.statusCode).toBe(201);
    // Same key, genuinely different body: must be refused, not silently
    // replayed as though it were the first request -- the same contract
    // every other Idempotency-Key-covered create route already has.
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/boards",
      headers: { ...h, "Idempotency-Key": key },
      payload: { project_id: p.id, name: "Second", view_type: "LIST" },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe(
      "IDEMPOTENCY_MISMATCH",
    );
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/boards?project_id=${p.id}`,
      headers: h,
    });
    // Only "First" exists -- the rejected retry created nothing.
    expect(((list.json() as { data: unknown[] }).data).length).toBe(3);
  });

  it("forbids board management for EMPLOYEE (403) but allows reads", async () => {
    const h = await adminHeaders();
    const emp = await mkUser(["EMPLOYEE"], "emp");
    const p = await mkProject(h);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/boards",
      headers: emp.headers,
      payload: { project_id: p.id, name: "Nope", view_type: "LIST" },
    });
    expect(denied.statusCode).toBe(403);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/boards?project_id=${p.id}`,
      headers: emp.headers,
    });
    expect(list.statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------ saved filters

describe("saved filters", () => {
  it("creates an owner-private filter and lists it for the owner", async () => {
    const a = await mkUser(["EMPLOYEE"], "ownerA");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/saved-filters",
      headers: a.headers,
      payload: { name: "My todos", query_definition: { status: "TO_DO" } },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      id: string;
      owner_id: string;
      project_id: string | null;
      shared: boolean;
    };
    expect(body.owner_id).toBe(a.id);
    expect(body.project_id).toBeNull();
    expect(body.shared).toBe(false);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/saved-filters",
      headers: a.headers,
    });
    expect(
      ((list.json() as { data: Array<{ id: string }> }).data).some(
        (f) => f.id === body.id,
      ),
    ).toBe(true);
  });

  it("isolates private filters: B cannot see A's private filter", async () => {
    const a = await mkUser(["EMPLOYEE"], "ownerB");
    const b = await mkUser(["EMPLOYEE"], "otherB");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/saved-filters",
      headers: a.headers,
      payload: { name: "Secret", query_definition: { q: "secret" } },
    });
    const id = (created.json() as { id: string }).id;
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/saved-filters",
      headers: b.headers,
    });
    expect(
      ((list.json() as { data: Array<{ id: string }> }).data).some(
        (f) => f.id === id,
      ),
    ).toBe(false);
  });

  it("unions shared project filters into another user's list", async () => {
    const h = await adminHeaders();
    const a = await mkUser(["TEAM_LEAD"], "sharer");
    const b = await mkUser(["EMPLOYEE"], "seer");
    const p = await mkProject(h);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/saved-filters",
      headers: a.headers,
      payload: {
        project_id: p.id,
        name: "Shared view",
        query_definition: { status: "DONE" },
        shared: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/saved-filters?project_id=${p.id}`,
      headers: b.headers,
    });
    expect(
      ((list.json() as { data: Array<{ id: string }> }).data).some(
        (f) => f.id === id,
      ),
    ).toBe(true);
  });

  it("PATCH is owner-only with a SUPER_ADMIN/ADMIN override", async () => {
    const h = await adminHeaders();
    const a = await mkUser(["EMPLOYEE"], "patchOwner");
    const b = await mkUser(["EMPLOYEE"], "patchStranger");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/saved-filters",
      headers: a.headers,
      payload: { name: "V1", query_definition: { a: 1 } },
    });
    const id = (created.json() as { id: string }).id;
    const mine = await app.inject({
      method: "PATCH",
      url: `/api/v1/saved-filters/${id}`,
      headers: a.headers,
      payload: { name: "V2" },
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { name: string }).name).toBe("V2");
    const stranger = await app.inject({
      method: "PATCH",
      url: `/api/v1/saved-filters/${id}`,
      headers: b.headers,
      payload: { name: "Hijack" },
    });
    expect(stranger.statusCode).toBe(404);
    const admin = await app.inject({
      method: "PATCH",
      url: `/api/v1/saved-filters/${id}`,
      headers: h,
      payload: { query_definition: { a: 2 } },
    });
    expect(admin.statusCode).toBe(200);
    expect((admin.json() as { query_definition: unknown }).query_definition).toEqual({
      a: 2,
    });
  });

  it("DELETE removes an owned filter (204)", async () => {
    const a = await mkUser(["EMPLOYEE"], "deleter");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/saved-filters",
      headers: a.headers,
      payload: { name: "Temp", query_definition: {} },
    });
    const id = (created.json() as { id: string }).id;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/saved-filters/${id}`,
      headers: a.headers,
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/saved-filters",
      headers: a.headers,
    });
    expect(
      ((list.json() as { data: Array<{ id: string }> }).data).some(
        (f) => f.id === id,
      ),
    ).toBe(false);
  });

  it("requires filter permission (403 CLIENT_VIEWER)", async () => {
    const viewer = await mkUser(["CLIENT_VIEWER"], "viewer");
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/saved-filters",
      headers: viewer.headers,
    });
    expect(list.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------ labels

describe("labels", () => {
  it("creates a label and rejects duplicates in the same scope (409 LABEL_EXISTS)", async () => {
    const h = await adminHeaders();
    const pm = await mkUser(["PROJECT_MANAGER"], "pm");
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: pm.headers,
      payload: { name: "urgent", color: "red" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ name: "urgent", color: "red" });
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: pm.headers,
      payload: { name: "urgent" },
    });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { code: string }).code).toBe("LABEL_EXISTS");
    void h;
  });

  it("allows the same name in a different project scope", async () => {
    const h = await adminHeaders();
    const pa = await mkProject(h);
    const pb = await mkProject(h);
    const a = await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: h,
      payload: { project_id: pa.id, name: "site-work" },
    });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: h,
      payload: { project_id: pb.id, name: "site-work" },
    });
    expect(b.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: h,
      payload: { project_id: pa.id, name: "site-work" },
    });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { code: string }).code).toBe("LABEL_EXISTS");
  });

  it("attaches labels and rejects cross-project scope (422 LABEL_SCOPE)", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "tl");
    const pa = await mkProject(h, { project_manager_id: tl.id });
    const pb = await mkProject(h, { project_manager_id: tl.id });
    const scoped = (
      await app.inject({
        method: "POST",
        url: "/api/v1/labels",
        headers: h,
        payload: { project_id: pa.id, name: "only-a" },
      })
    ).json() as { id: string };
    const taskB = await mkTask(h, pb.id, {});
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskB.id}/labels`,
      headers: tl.headers,
      payload: { label_id: scoped.id },
    });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { code: string }).code).toBe("LABEL_SCOPE");
    const global = (
      await app.inject({
        method: "POST",
        url: "/api/v1/labels",
        headers: h,
        payload: { name: "everywhere" },
      })
    ).json() as { id: string };
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskB.id}/labels`,
      headers: tl.headers,
      payload: { label_id: global.id },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ task_id: taskB.id, label_id: global.id });
  });

  it("roundtrips attach/detach and surfaces labels[] on task shapes", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "tl2");
    const p = await mkProject(h, { project_manager_id: tl.id });
    const label = (
      await app.inject({
        method: "POST",
        url: "/api/v1/labels",
        headers: h,
        payload: { project_id: p.id, name: "field", color: "green" },
      })
    ).json() as { id: string };
    const t = await mkTask(h, p.id, {});
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/labels`,
      headers: tl.headers,
      payload: { label_id: label.id },
    });
    const detail = (
      await app.inject({ method: "GET", url: `/api/v1/tasks/${t.id}`, headers: h })
    ).json() as { labels: Array<{ id: string; name: string; color: string }> };
    expect(detail.labels).toEqual([{ id: label.id, name: "field", color: "green" }]);
    const list = (
      await app.inject({
        method: "GET",
        url: `/api/v1/tasks?project_id=${p.id}`,
        headers: h,
      })
    ).json() as { data: Array<{ id: string; labels: unknown[] }> };
    expect(list.data.find((r) => r.id === t.id)?.labels).toEqual([
      { id: label.id, name: "field", color: "green" },
    ]);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${t.id}/labels/${label.id}`,
      headers: tl.headers,
    });
    expect(del.statusCode).toBe(204);
    const after = (
      await app.inject({ method: "GET", url: `/api/v1/tasks/${t.id}`, headers: h })
    ).json() as { labels: unknown[] };
    expect(after.labels).toEqual([]);
  });

  it("lists global + project labels for a project scope", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const other = await mkProject(h);
    await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: h,
      payload: { name: "glob-all" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: h,
      payload: { project_id: p.id, name: "proj-only" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: h,
      payload: { project_id: other.id, name: "other-only" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/labels?project_id=${p.id}`,
      headers: h,
    });
    const names = (
      res.json() as { data: Array<{ name: string }> }
    ).data.map((l) => l.name);
    expect(names).toContain("glob-all");
    expect(names).toContain("proj-only");
    expect(names).not.toContain("other-only");
  });

  it("forbids label management for EMPLOYEE (403)", async () => {
    const emp = await mkUser(["EMPLOYEE"], "empLabel");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: emp.headers,
      payload: { name: "nope" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------ notifications

describe("notifications inbox", () => {
  it("emits TASK_ASSIGNED to the new assignee", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "assigner");
    const worker = await mkUser(["EMPLOYEE"], "assignee");
    const p = await mkProject(h, { project_manager_id: tl.id });
    const t = await mkTask(h, p.id, { title: "Inbox task alpha" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/assign`,
      headers: tl.headers,
      payload: { assignee_id: worker.id, reason: "best fit" },
    });
    expect(res.statusCode).toBe(200);
    const box = await inbox(worker.headers);
    const found = box.data.find((n) => n.type === "TASK_ASSIGNED");
    expect(found).toBeDefined();
    expect(found?.entity_id).toBe(t.id);
    expect(found?.title).toBe("You were assigned a task");
    expect(`${found?.title} ${found?.body}`).not.toMatch(
      /aadhaar|bank|salary|phonepe|ifsc|pan\b/i,
    );
  });

  it("emits MENTION to each mentioned user", async () => {
    const h = await adminHeaders();
    const author = await mkUser(["TEAM_LEAD"], "commenter");
    const target = await mkUser(["EMPLOYEE"], "mentioned");
    const p = await mkProject(h, { project_manager_id: author.id });
    const t = await mkTask(h, p.id, { title: "Inbox task beta" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/comments`,
      headers: author.headers,
      payload: { body: `hey @${target.username} please review` },
    });
    expect(res.statusCode).toBe(201);
    const box = await inbox(target.headers);
    const found = box.data.find((n) => n.type === "MENTION");
    expect(found).toBeDefined();
    expect(found?.body).toContain(author.username);
  });

  it("emits LEAVE_DECIDED to the requester's linked user", async () => {
    const h = await adminHeaders();
    const types = (
      await app.inject({ method: "GET", url: "/api/v1/leave/types", headers: h })
    ).json() as { data: Array<{ id: string; code: string }> };
    const lop = types.data.find((t) => t.code === "LOP");
    expect(lop).toBeDefined();
    const requester = await mkUser(["EMPLOYEE"], "leaver");
    const empId = await mkEmployee(h);
    // Leave is filed for somebody employed; a freshly created record is DRAFT.
    await pool.query("UPDATE employees SET status = 'ACTIVE' WHERE id = $1::uuid", [empId]);
    await linkUser(requester.id, empId);
    const from = istPlusDays(10);
    const to = istPlusDays(11);
    const filed = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...requester.headers, "Idempotency-Key": randomUUID() },
      payload: {
        leave_type_id: lop?.id,
        from_date: from,
        to_date: to,
        reason: "family trip",
      },
    });
    expect(filed.statusCode).toBe(201);
    const reqId = (filed.json() as { id: string }).id;
    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...h, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(decided.statusCode).toBe(200);
    const box = await inbox(requester.headers);
    const found = box.data.find((n) => n.type === "LEAVE_DECIDED");
    expect(found).toBeDefined();
    expect(found?.entity_id).toBe(reqId);
    expect(found?.body).toContain("approved");
    expect(`${found?.title} ${found?.body}`).not.toMatch(
      /aadhaar|bank|salary|phonepe|ifsc/i,
    );
  });

  it("emits ATTENDANCE_DECIDED to the exception submitter", async () => {
    const h = await adminHeaders();
    const empUser = await mkUser(["EMPLOYEE"], "attSubmitter");
    const empId = await mkEmployee(h);
    await linkUser(empUser.id, empId);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/exceptions",
      headers: empUser.headers,
      payload: {
        employee_id: empId,
        exception_type: "MISSED_PUNCH",
        reason: "forgot to punch",
      },
    });
    expect(created.statusCode).toBe(201);
    const exc = created.json() as { id: string };
    const decided = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${exc.id}/decision`,
      headers: { ...h, "If-Match": "1" },
      payload: { decision: "APPROVE", note: "verified" },
    });
    expect(decided.statusCode).toBe(200);
    const box = await inbox(empUser.headers);
    const found = box.data.find((n) => n.type === "ATTENDANCE_DECIDED");
    expect(found).toBeDefined();
    expect(found?.entity_id).toBe(exc.id);
  });

  it("supports unread filter, idempotent read, and read-all counts", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "multiAssigner");
    const w = await mkUser(["EMPLOYEE"], "multiInbox");
    const p = await mkProject(h);
    const t1 = await mkTask(h, p.id, { title: "Inbox task gamma" });
    const t2 = await mkTask(h, p.id, { title: "Inbox task delta" });
    for (const t of [t1, t2]) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${t.id}/assign`,
        headers: tl.headers,
        payload: { assignee_id: w.id, reason: "round robin" },
      });
      expect(r.statusCode).toBe(200);
    }
    expect((await inbox(w.headers, "?unread=true")).data.length).toBe(2);
    const first = (await inbox(w.headers)).data[0];
    expect(first).toBeDefined();
    const read1 = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${first?.id}/read`,
      headers: w.headers,
    });
    expect(read1.statusCode).toBe(200);
    const readAt = (read1.json() as { read_at: string }).read_at;
    expect(typeof readAt).toBe("string");
    const read2 = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${first?.id}/read`,
      headers: w.headers,
    });
    expect(read2.statusCode).toBe(200);
    expect((read2.json() as { read_at: string }).read_at).toBe(readAt);
    expect((await inbox(w.headers, "?unread=true")).data.length).toBe(1);
    const all = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: w.headers,
    });
    expect(all.statusCode).toBe(200);
    expect((all.json() as { marked: number }).marked).toBe(1);
    expect((await inbox(w.headers, "?unread=true")).data.length).toBe(0);
  });

  it("blocks cross-user reads (404) and anon access (401)", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "xAssigner");
    const w = await mkUser(["EMPLOYEE"], "xInbox");
    const stranger = await mkUser(["EMPLOYEE"], "xStranger");
    const p = await mkProject(h);
    const t = await mkTask(h, p.id, { title: "Inbox task epsilon" });
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/assign`,
      headers: tl.headers,
      payload: { assignee_id: w.id, reason: "you" },
    });
    const mine = (await inbox(w.headers)).data[0];
    const cross = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${mine?.id}/read`,
      headers: stranger.headers,
    });
    expect(cross.statusCode).toBe(404);
    const anon = await app.inject({ method: "GET", url: "/api/v1/notifications" });
    expect(anon.statusCode).toBe(401);
  });

  it("lets GOVT_OBSERVER open its own inbox, like every other role (round-2 deep walk)", async () => {
    // Every role in S5_ROLE_GRANTS holds notification.read except
    // SALES_BD_EXECUTIVE and BID_TENDER_MANAGER (empty grants generally) --
    // GOVT_OBSERVER was the one role with survey.dashboard and nothing else,
    // so opening the Inbox tab every signed-in user sees 403'd. Found live
    // during the round-2 govt crawl.
    const observer = await mkUser(["GOVT_OBSERVER"], "govt");
    const res = await inbox(observer.headers);
    expect(res).toEqual(expect.objectContaining({ data: expect.any(Array) }));
  });

  it("lets SALES_BD_EXECUTIVE and BID_TENDER_MANAGER open their own inbox, like every other role (Task 5f)", async () => {
    // S5_ROLE_GRANTS gave every system role notification.read except these
    // two (empty grants generally, from before S5 existed) — the Inbox nav
    // item is shown to every signed-in user regardless of role, so either
    // role opening the tab every other role has got a 403. Same bug shape
    // GOVT_OBSERVER had (098, fd4a046).
    const bd = await mkUser(["SALES_BD_EXECUTIVE"], "bd");
    const tender = await mkUser(["BID_TENDER_MANAGER"], "tender");
    expect(await inbox(bd.headers)).toEqual(expect.objectContaining({ data: expect.any(Array) }));
    expect(await inbox(tender.headers)).toEqual(expect.objectContaining({ data: expect.any(Array) }));
  });

  it("stores no PII beyond visible names in any notification", async () => {
    const rows = await pool.query("SELECT title, body FROM notifications");
    expect(rows.rowCount).toBeGreaterThanOrEqual(0);
    for (const r of rows.rows as Array<{ title: string; body: string }>) {
      expect(`${r.title} ${r.body}`).not.toMatch(
        /aadhaar|bank_account|phonepe|ifsc|salary_basic|pan_encrypted/i,
      );
    }
  });
});

// ------------------------------------------------------------------ SLA

describe("sla read-model", () => {
  it("computes every branch of the SLA rule (pure unit)", () => {
    const today = "2026-09-06";
    expect(
      computeSlaStatus({ status: "DONE", planned_end_date: "2026-01-01" }, today),
    ).toBe("ON_SCHEDULE");
    expect(
      computeSlaStatus({ status: "CANCELLED", planned_end_date: "2026-01-01" }, today),
    ).toBe("ON_SCHEDULE");
    expect(computeSlaStatus({ status: "TO_DO", planned_end_date: null }, today)).toBe(
      "ON_SCHEDULE",
    );
    expect(
      computeSlaStatus({ status: "IN_PROGRESS", planned_end_date: "2026-09-05" }, today),
    ).toBe("OVERDUE");
    expect(
      computeSlaStatus({ status: "TO_DO", planned_end_date: "2026-09-06" }, today),
    ).toBe("AT_RISK");
    expect(
      computeSlaStatus({ status: "TO_DO", planned_end_date: "2026-09-07" }, today),
    ).toBe("AT_RISK");
    expect(
      computeSlaStatus({ status: "BLOCKED", planned_end_date: "2026-09-08" }, today),
    ).toBe("AT_RISK");
    expect(
      computeSlaStatus({ status: "TO_DO", planned_end_date: "2026-09-09" }, today),
    ).toBe("ON_SCHEDULE");
    expect(
      computeSlaStatus({ status: "IN_REVIEW", planned_end_date: "2027-01-01" }, today),
    ).toBe("ON_SCHEDULE");
  });

  it("exposes sla_status on task list and detail items", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id, { planned_end_date: istPlusDays(-3) });
    const detail = (
      await app.inject({ method: "GET", url: `/api/v1/tasks/${t.id}`, headers: h })
    ).json() as { sla_status: string; labels: unknown[] };
    expect(detail.sla_status).toBe("OVERDUE");
    expect(detail.labels).toEqual([]);
    const list = (
      await app.inject({
        method: "GET",
        url: `/api/v1/tasks?project_id=${p.id}`,
        headers: h,
      })
    ).json() as { data: Array<{ id: string; sla_status: string }> };
    expect(list.data.find((r) => r.id === t.id)?.sla_status).toBe("OVERDUE");
  });

  it("filters the task list by sla=overdue|at_risk|on_schedule", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const overdue = await mkTask(h, p.id, { planned_end_date: istPlusDays(-1) });
    const atRisk = await mkTask(h, p.id, { planned_end_date: istPlusDays(1) });
    const fine = await mkTask(h, p.id, { planned_end_date: istPlusDays(10) });
    // Terminal tasks are ON_SCHEDULE even with a past due date.
    const done = await mkTask(h, p.id, { planned_end_date: istPlusDays(-5) });
    let v = done.version;
    for (const s of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
      const r = await app.inject({
        method: "PATCH",
        url: `/api/v1/tasks/${done.id}/status`,
        headers: { ...h, "If-Match": String(v) },
        payload: { status: s },
      });
      expect(r.statusCode).toBe(200);
      v = (r.json() as { version: number }).version;
    }
    const ids = async (sla: string) => {
      const r = await app.inject({
        method: "GET",
        url: `/api/v1/tasks?project_id=${p.id}&sla=${sla}`,
        headers: h,
      });
      expect(r.statusCode).toBe(200);
      return ((r.json() as { data: Array<{ id: string }> }).data).map((t) => t.id);
    };
    expect(await ids("overdue")).toEqual([overdue.id]);
    expect(await ids("at_risk")).toEqual([atRisk.id]);
    const onSchedule = await ids("on_schedule");
    expect(onSchedule.sort()).toEqual([done.id, fine.id].sort());
  });
});

// ------------------------------------------------------------------ archive, not delete

describe("boards and saved views are archived, not deleted (BR-13)", () => {
  it("keeps an archived board's row and columns, out of every list", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const b = await mkBoard(h, p.id, {});
    const del = await app.inject({ method: "DELETE", url: `/api/v1/boards/${b.id}`, headers: h });
    expect(del.statusCode).toBe(204);

    const row = await pool.query(
      "SELECT archived_at, archived_by FROM boards WHERE id = $1", [b.id]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].archived_at).not.toBeNull();
    expect(row.rows[0].archived_by).not.toBeNull();
    const cols = await pool.query("SELECT count(*)::int AS n FROM board_columns WHERE board_id = $1", [b.id]);
    expect(cols.rows[0].n).toBeGreaterThan(0);

    const list = await app.inject({ method: "GET", url: `/api/v1/boards?project_id=${p.id}`, headers: h });
    expect((list.json() as { data: Array<{ id: string }> }).data.some(x => x.id === b.id)).toBe(false);
    const again = await app.inject({ method: "DELETE", url: `/api/v1/boards/${b.id}`, headers: h });
    expect(again.statusCode).toBe(404);
  });

  it("keeps an archived saved view's row, out of the list", async () => {
    const a = await mkUser(["EMPLOYEE"], "archiver");
    const created = await app.inject({
      method: "POST", url: "/api/v1/saved-filters", headers: a.headers,
      payload: { name: "Kept", query_definition: { status: "TO_DO" } },
    });
    const id = (created.json() as { id: string }).id;
    const del = await app.inject({ method: "DELETE", url: `/api/v1/saved-filters/${id}`, headers: a.headers });
    expect(del.statusCode).toBe(204);
    const row = await pool.query("SELECT archived_at, archived_by FROM saved_filters WHERE id = $1", [id]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].archived_by).toBe(a.id);
    const patch = await app.inject({
      method: "PATCH", url: `/api/v1/saved-filters/${id}`, headers: a.headers, payload: { name: "Back" },
    });
    expect(patch.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------ boards in scope

describe("listing boards without a project (WORK-21)", () => {
  it("returns only boards on projects the reader may see", async () => {
    // It returned every board in the organisation, which names every project.
    const h = await adminHeaders();
    const mine = await mkProject(h);
    const theirs = await mkProject(h);
    const bMine = await mkBoard(h, mine.id, {});
    const bTheirs = await mkBoard(h, theirs.id, {});
    const emp = await mkUser(["EMPLOYEE"], "boardscope");
    await mkTask(h, mine.id, { assignee_id: emp.id });

    const all = await app.inject({ method: "GET", url: "/api/v1/boards", headers: emp.headers });
    expect(all.statusCode).toBe(200);
    const ids = (all.json() as { data: Array<{ id: string }> }).data.map(x => x.id);
    expect(ids).toContain(bMine.id);
    expect(ids).not.toContain(bTheirs.id);

    const named = await app.inject({
      method: "GET", url: `/api/v1/boards?project_id=${theirs.id}`, headers: emp.headers,
    });
    expect((named.json() as { data: unknown[] }).data).toEqual([]);

    const admin = await app.inject({ method: "GET", url: "/api/v1/boards", headers: h });
    const adminIds = (admin.json() as { data: Array<{ id: string }> }).data.map(x => x.id);
    expect(adminIds).toContain(bTheirs.id);
  });
});

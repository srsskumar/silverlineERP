import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { VOLATILE_TABLES } from "./tables.js";
import { testDatabaseUrl } from "./database.js";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import { seedDatabase } from "../src/database/seed.js";

/**
 * AUTH-10 -- signing out, and switching MFA off, end the sessions they
 * should.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";
const PASSWORD = "Pass1234!";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";

async function createUser(): Promise<{ id: string; username: string }> {
  const username = `sess_${randomUUID().slice(0, 8)}`;
  const id = (await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, username, await bcrypt.hash(PASSWORD, 4)],
  )).rows[0].id as string;
  await pool.query(
    "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'EMPLOYEE'",
    [id],
  );
  return { id, username };
}

async function signIn(username: string) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { access_token: string; refresh_token: string };
}

const refresh = (refresh_token: string) =>
  app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refresh_token } });
const me = (access_token: string) =>
  app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${access_token}` } });

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
  orgId = (await seedDatabase(pool, { bcryptRounds: 4 })).orgId;
});

describe("signing out with only the access token", () => {
  it("ends that session, refresh token and all", async () => {
    const who = await createUser();
    const session = await signIn(who.username);
    const other = await signIn(who.username);

    const out = await app.inject({
      method: "POST", url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${session.access_token}` }, payload: {},
    });
    expect(out.statusCode).toBe(200);

    expect((await me(session.access_token)).statusCode).toBe(401);
    expect((await refresh(session.refresh_token)).statusCode).toBe(401);
    // Only that session: signing out on one device is not signing out everywhere.
    expect((await me(other.access_token)).statusCode).toBe(200);
  });

  it("stays a quiet success without any token at all", async () => {
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: {} });
    expect(out.statusCode).toBe(200);
  });
});

describe("switching two-factor off", () => {
  it("ends every session the account had open", async () => {
    const who = await createUser();
    const secret = authenticator.generateSecret();
    // Signed in twice before enrolment finishes, so neither sign-in needs a code.
    const phone = await signIn(who.username);
    const laptop = await signIn(who.username);
    await pool.query(
      "UPDATE users SET mfa_secret = $2, mfa_enabled = true, mfa_last_counter = NULL WHERE id = $1",
      [who.id, secret],
    );

    const off = await app.inject({
      method: "POST", url: "/api/v1/auth/mfa/disable",
      headers: { authorization: `Bearer ${laptop.access_token}` },
      payload: { code: authenticator.generate(secret) },
    });
    expect(off.statusCode, off.body).toBe(200);

    expect((await refresh(phone.refresh_token)).statusCode).toBe(401);
    expect((await me(phone.access_token)).statusCode).toBe(401);
    const live = await pool.query(
      "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked = false", [who.id]);
    expect(live.rows[0].n).toBe(0);
  });
});

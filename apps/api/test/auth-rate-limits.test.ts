import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { VOLATILE_TABLES } from "./tables.js";
import { testDatabaseUrl } from "./database.js";
import { buildApp } from "../src/createApp.js";
import { parseTrustProxy } from "../src/config.js";
import { migrate } from "../src/database/migrate.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, seedDatabase } from "../src/database/seed.js";

/**
 * AUTH-3 -- authentication limits that count the right thing.
 *
 * Behind nginx every request reached the API from 127.0.0.1, so the login
 * limit was one bucket of ten a minute for the whole organisation, and it
 * counted nothing an attacker could not sidestep by spreading guesses at
 * one account across addresses. These tests build their own app with a
 * limit of three so they can reach it.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";
const MAX = 3;

let app: FastifyInstance;
let pool: Pool;

function login(username: string, opts: { ip?: string; remote?: string } = {}) {
  return app.inject({
    method: "POST", url: "/api/v1/auth/login",
    remoteAddress: opts.remote,
    headers: opts.ip ? { "x-forwarded-for": opts.ip } : {},
    payload: { username, password: "not-the-password" },
  });
}

const nobody = () => `nobody_${randomUUID().slice(0, 8)}`;

async function adminHeaders(ip: string) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login",
    headers: { "x-forwarded-for": ip },
    payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return {
    authorization: `Bearer ${(res.json() as { access_token: string }).access_token}`,
    "x-forwarded-for": ip,
  };
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({ databaseUrl: TEST_DB, jwtSecret: JWT_SECRET, loginRateLimitMax: MAX });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${VOLATILE_TABLES}`);
  await seedDatabase(pool, { bcryptRounds: 4 });
});

describe("the client address behind nginx", () => {
  it("gives each forwarded address its own sign-in bucket", async () => {
    for (let i = 0; i < MAX; i++) expect((await login(nobody(), { ip: "198.51.100.1" })).statusCode).toBe(401);
    expect((await login(nobody(), { ip: "198.51.100.1" })).statusCode).toBe(429);
    // Somebody else in the organisation is not locked out by that.
    expect((await login(nobody(), { ip: "198.51.100.2" })).statusCode).toBe(401);
  });

  it("ignores X-Forwarded-For from a peer that is not the proxy", async () => {
    const remote = "203.0.113.9";
    for (let i = 0; i < MAX; i++) {
      expect((await login(nobody(), { remote, ip: `192.0.2.${i}` })).statusCode).toBe(401);
    }
    // A fresh forged address each time buys nothing.
    expect((await login(nobody(), { remote, ip: "192.0.2.99" })).statusCode).toBe(429);
  });

  it("defaults to trusting loopback only", () => {
    expect(parseTrustProxy(undefined)).toBe("127.0.0.1,::1");
    expect(parseTrustProxy("")).toBe("127.0.0.1,::1");
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
  });
});

describe("sign-in limits", () => {
  it("counts guesses at one account across addresses", async () => {
    const victim = nobody();
    for (let i = 0; i < MAX; i++) expect((await login(victim, { ip: `198.51.100.${10 + i}` })).statusCode).toBe(401);
    const res = await login(victim, { ip: "198.51.100.50" });
    expect(res.statusCode).toBe(429);
    // Folded, so changing the case is not a new bucket.
    expect((await login(victim.toUpperCase(), { ip: "198.51.100.51" })).statusCode).toBe(429);
  });

  it("says when to come back", async () => {
    for (let i = 0; i < MAX; i++) await login(nobody(), { ip: "198.51.100.60" });
    const res = await login(nobody(), { ip: "198.51.100.60" });
    expect(res.statusCode).toBe(429);
    const after = Number(res.headers["retry-after"]);
    expect(Number.isInteger(after)).toBe(true);
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(60);
    expect((res.json() as { code: string }).code).toBe("RATE_LIMITED");
  });

  it("does not spend sign-in attempts on refreshes", async () => {
    for (let i = 0; i < MAX; i++) {
      await app.inject({
        method: "POST", url: "/api/v1/auth/refresh",
        headers: { "x-forwarded-for": "198.51.100.70" },
        payload: { refresh_token: "x".repeat(64) },
      });
    }
    expect((await login(nobody(), { ip: "198.51.100.70" })).statusCode).toBe(401);
  });
});

describe("the endpoints that had no limit", () => {
  it("limits refresh by address", async () => {
    const refresh = () => app.inject({
      method: "POST", url: "/api/v1/auth/refresh",
      headers: { "x-forwarded-for": "198.51.100.80" },
      payload: { refresh_token: "x".repeat(64) },
    });
    for (let i = 0; i < MAX * 6; i++) expect((await refresh()).statusCode).toBe(401);
    const res = await refresh();
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("limits authenticator setup per account", async () => {
    const headers = await adminHeaders("198.51.100.90");
    const setup = () => app.inject({ method: "POST", url: "/api/v1/auth/mfa/setup", headers });
    for (let i = 0; i < MAX; i++) expect((await setup()).statusCode).toBe(200);
    expect((await setup()).statusCode).toBe(429);
  });

  it("limits starting a view-as session per account", async () => {
    const headers = await adminHeaders("198.51.100.91");
    const start = () => app.inject({
      method: "POST", url: "/api/v1/auth/impersonate", headers,
      payload: { user_id: randomUUID(), reason: "Checking the rate limit on this" },
    });
    for (let i = 0; i < MAX; i++) expect((await start()).statusCode).toBe(404);
    expect((await start()).statusCode).toBe(429);
  });
});

/**
 * A way back in for somebody locked out (§note 16).
 *
 * Changing a password needs you to be signed in, which is exactly what a
 * person who has forgotten theirs cannot do. A crew member three hours from
 * the office had no route back except telephoning whoever happened to know
 * where the admin screen was.
 *
 * Most of what matters here is what it refuses to say. An endpoint that
 * answers differently for a real account than an invented one is a way to
 * find out who works here, and it is reachable without signing in.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, uniquePhone, type CatalogueWorld } from "./fixture.js";

let w: CatalogueWorld;

async function ask(username: unknown) {
  const res = await w.app.inject({
    method: "POST", url: "/api/v1/auth/password-reset-request",
    headers: { ...idem() }, payload: { username },
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}

const requestsFor = async (userId: string) => Number((await w.pool.query(
  "SELECT count(*)::int AS n FROM password_reset_requests WHERE user_id = $1",
  [userId])).rows[0].n);

const alertsRaised = async () => Number((await w.pool.query(
  "SELECT count(*)::int AS n FROM notifications WHERE type = 'PASSWORD_RESET_REQUEST'"
)).rows[0].n);

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("what it will not tell you", () => {
  it("answers an invented account exactly as it answers a real one", async () => {
    const real = await ask("admin");
    const invented = await ask(`nobody-${uniq("X")}`);
    expect(real.status).toBe(invented.status);
    expect(real.body.message).toBe(invented.body.message);
  });

  it("raises nothing for an account nobody has", async () => {
    const before = await alertsRaised();
    await ask(`ghost-${uniq("X")}`);
    expect(await alertsRaised()).toBe(before);
  });

  it("takes an empty or absurd name without falling over", async () => {
    for (const bad of ["", "   ", "x".repeat(5000), null, 12345, { sql: "1=1" }]) {
      const r = await ask(bad);
      expect([200, 202, 400, 422], JSON.stringify(bad)).toContain(r.status);
    }
  });

  it("needs no sign-in, which is the whole point", async () => {
    const r = await ask("admin");
    expect(r.status).toBe(202);
  });
});

describe("telling the people who can act", () => {
  it("records the request and alerts somebody", async () => {
    // Its own account: the throttle is per person, and an earlier test in
    // this file has already asked about admin within the window.
    const name = uniq("asks").toLowerCase();
    const user = (await w.pool.query(
      `INSERT INTO users(org_id, username, password_hash, auth_status)
       VALUES($1,$2,'x','ACTIVE') RETURNING id`, [w.orgId, name])).rows[0];
    const alertsBefore = await alertsRaised();

    const r = await ask(name);
    expect(r.status).toBe(202);
    expect(await requestsFor(String(user.id))).toBe(1);
    expect(await alertsRaised()).toBeGreaterThan(alertsBefore);
  });

  it("never tells the person who is locked out about their own request", async () => {
    /*
     * Their inbox is behind the sign-in they cannot get through, so it would
     * be the one message they could never read. An administrator still hears
     * about everybody else's, which is why this asks about the subject of
     * each request rather than about one person's inbox.
     */
    const own = await w.pool.query(
      `SELECT count(*)::int AS n
         FROM notifications n
         JOIN password_reset_requests r ON r.id = n.entity_id
        WHERE n.type = 'PASSWORD_RESET_REQUEST' AND n.recipient_id = r.user_id`);
    expect(own.rows[0].n).toBe(0);
  });

  it("tells each person once, however many hats they wear", async () => {
    const dupes = await w.pool.query(
      `SELECT recipient_id, entity_id, count(*) AS n FROM notifications
        WHERE type = 'PASSWORD_RESET_REQUEST'
        GROUP BY recipient_id, entity_id HAVING count(*) > 1`);
    expect(dupes.rows).toHaveLength(0);
  });

  it("finds somebody by the mobile they sign in with", async () => {
    // Half the field staff sign in with their phone and would not know their
    // username.
    const phone = uniquePhone();
    const emp = (await w.pool.query(
      `INSERT INTO employees(org_id, emp_no, first_name, phone, date_of_joining, status)
       VALUES($1,$2,'Locked',$3,'2024-01-01','ACTIVE') RETURNING id`,
      [w.orgId, uniq("E"), phone])).rows[0].id;
    const u = (await w.pool.query(
      `INSERT INTO users(org_id, username, password_hash, auth_status, employee_id, phone)
       VALUES($1,$2,'x','ACTIVE',$3,$4) RETURNING id`,
      [w.orgId, uniq("locked").toLowerCase(), emp, phone])).rows[0].id;

    const r = await ask(phone);
    expect(r.status).toBe(202);
    expect(await requestsFor(String(u))).toBe(1);
  });
});

describe("not a way to flood an inbox", () => {
  it("raises one request per person per ten minutes", async () => {
    // Typing one username repeatedly would otherwise fill every manager's
    // inbox, and the alert stops meaning anything the first time it arrives
    // twenty times.
    const phone = uniquePhone();
    const emp = (await w.pool.query(
      `INSERT INTO employees(org_id, emp_no, first_name, phone, date_of_joining, status)
       VALUES($1,$2,'Spammed',$3,'2024-01-01','ACTIVE') RETURNING id`,
      [w.orgId, uniq("E"), phone])).rows[0].id;
    const name = uniq("spam").toLowerCase();
    const u = (await w.pool.query(
      `INSERT INTO users(org_id, username, password_hash, auth_status, employee_id, phone)
       VALUES($1,$2,'x','ACTIVE',$3,$4) RETURNING id`,
      [w.orgId, name, emp, phone])).rows[0].id;

    for (let i = 0; i < 5; i += 1) await ask(name);
    expect(await requestsFor(String(u))).toBe(1);
  });

  it("says the same thing to the person it quietly ignored", async () => {
    // They must not be able to tell a throttled ask from a heard one.
    const first = await ask("admin");
    const second = await ask("admin");
    expect(second.body.message).toBe(first.body.message);
  });
});

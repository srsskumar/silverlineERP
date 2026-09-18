/**
 * Changing the same thing about several people at once (§note 12).
 *
 * A crew of thirty moving to a new mandal is one decision, not thirty, and
 * doing it one record at a time is how twenty-eight get moved and two are
 * forgotten until somebody's attendance stops matching their site.
 *
 * It is also the one screen where somebody discovers they had the wrong
 * filter applied after it has already touched two hundred records, so most of
 * what is tested here is the refusing and the showing-before-doing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activate, buildWorld, idem, uniq, uniquePhone, workDate,
  type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;

async function send(method: "PATCH" | "POST" | "GET", h: Headers, url: string, payload?: unknown) {
  const res = await w.app.inject({
    method, url,
    headers: { ...h, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}

const bulk = (payload: unknown, h: Headers = w.admin) =>
  send("PATCH", h, "/api/v1/employees/bulk", payload);

async function employee(over: Record<string, unknown> = {}) {
  const r = await send("POST", w.admin, "/api/v1/employees", {
    first_name: "Bulk", last_name: "Subject", phone: uniquePhone(),
    date_of_joining: workDate(), ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.data;
}

const read = async (id: string) =>
  (await w.pool.query("SELECT * FROM employees WHERE id = $1", [id])).rows[0];

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("showing the work before doing it", () => {
  it("changes nothing on a dry run", async () => {
    const a = await employee({ department: "Old" });
    const b = await employee({ department: "Old" });
    const r = await bulk({
      employee_ids: [a.id, b.id], changes: { department: "New" }, dry_run: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.dry_run).toBe(true);
    expect(r.data.would_change).toBe(2);
    expect((await read(a.id)).department).toBe("Old");
  });

  it("dry runs by default, so a caller who forgets the flag writes nothing", async () => {
    const a = await employee({ department: "Untouched" });
    const r = await bulk({ employee_ids: [a.id], changes: { department: "Changed" } });
    expect(r.data.dry_run).toBe(true);
    expect((await read(a.id)).department).toBe("Untouched");
  });

  it("does not count people who already hold the value", async () => {
    // "200 updated" when 180 already held it teaches people to ignore the
    // number.
    const same = await employee({ department: "Projects" });
    const different = await employee({ department: "Stores" });
    const r = await bulk({
      employee_ids: [same.id, different.id], changes: { department: "Projects" },
      dry_run: true,
    });
    expect(r.data.would_change).toBe(1);
    expect(r.data.unchanged).toBe(1);
  });

  it("names the people it could not find", async () => {
    const a = await employee();
    const ghost = "00000000-0000-4000-8000-000000000000";
    const r = await bulk({
      employee_ids: [a.id, ghost], changes: { department: "X" }, dry_run: true,
    });
    expect(r.data.not_found).toEqual([ghost]);
  });
});

describe("applying it", () => {
  it("changes every record it said it would", async () => {
    const a = await employee({ department: "Before" });
    const b = await employee({ department: "Before" });
    const r = await bulk({
      employee_ids: [a.id, b.id], changes: { department: "After" }, dry_run: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.updated).toBe(2);
    expect((await read(a.id)).department).toBe("After");
    expect((await read(b.id)).department).toBe("After");
  });

  it("moves a whole crew to a new posting in one go", async () => {
    const district = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Bulk district')
       RETURNING id`, [w.orgId, uniq("BD")])).rows[0].id);
    const people = [await employee(), await employee(), await employee()];
    const r = await bulk({
      employee_ids: people.map((p) => p.id),
      changes: { district_id: district }, dry_run: false,
    });
    expect(r.data.updated).toBe(3);
    for (const p of people) {
      expect(String((await read(p.id)).district_id)).toBe(district);
    }
  });

  it("sets the designation from the list, label and all", async () => {
    const d = await send("POST", w.admin, "/api/v1/designations",
      { label: `Bulk ${uniq("Title")}` });
    const a = await employee();
    await bulk({
      employee_ids: [a.id], changes: { designation_id: d.data.id }, dry_run: false,
    });
    const after = await read(a.id);
    expect(String(after.designation_id)).toBe(String(d.data.id));
    expect(after.designation).toBe(d.data.label);
  });

  it("writes a trail entry per record, not one for the batch", async () => {
    // Somebody asking why this person's department changed should find the
    // answer on this person.
    const a = await employee();
    await bulk({ employee_ids: [a.id], changes: { department: "Audited" }, dry_run: false });
    const trail = await w.pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_id = $1 AND action = 'employee.bulk_update'`, [a.id]);
    expect(trail.rows[0].n).toBe(1);
  });

  it("bumps the version, so an open edit elsewhere is refused rather than lost", async () => {
    const a = await employee();
    const before = Number((await read(a.id)).version);
    await bulk({ employee_ids: [a.id], changes: { department: "Versioned" }, dry_run: false });
    expect(Number((await read(a.id)).version)).toBe(before + 1);
  });
});

describe("what it refuses", () => {
  it("refuses a change that names no field", async () => {
    const a = await employee();
    const r = await bulk({ employee_ids: [a.id], changes: {}, dry_run: false });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("at least one field");
  });

  it("refuses an empty list of people", async () => {
    expect((await bulk({ employee_ids: [], changes: { department: "X" } })).status).toBe(422);
  });

  it("refuses more people than anybody meant to select", async () => {
    const many = Array.from({ length: 501 }, () => "00000000-0000-4000-8000-000000000000");
    expect((await bulk({ employee_ids: many, changes: { department: "X" } })).status).toBe(422);
  });

  it("refuses a reporting line that does not exist", async () => {
    const a = await employee();
    const r = await bulk({
      employee_ids: [a.id],
      changes: { reports_to: "00000000-0000-4000-8000-000000000000" }, dry_run: true,
    });
    expect([200, 422]).toContain(r.status);
    if (r.status === 200) expect(r.data.refused.length).toBe(1);
  });

  it("refuses to make somebody their own manager, and says which one", async () => {
    /*
     * A cycle depends on which record is moving, so it is asked per person —
     * and the rest of the batch is not punished for it.
     *
     * The manager has to be activated first: a reporting line into a record
     * that is still a draft is a line into somebody who has not started, and
     * validateReportsTo refuses it for everybody in the batch rather than
     * just the self-reference.
     */
    const boss = await employee();
    await activate(w.app, w.admin, String(boss.id));
    const other = await employee();
    const r = await bulk({
      employee_ids: [boss.id, other.id],
      changes: { reports_to: boss.id }, dry_run: true,
    });
    expect(r.status).toBe(200);
    expect(r.data.refused).toHaveLength(1);
    expect(r.data.refused[0].emp_no).toBe(boss.emp_no);
    expect(r.data.would_change).toBe(1);
  });

  it("refuses a designation nobody defined", async () => {
    const a = await employee();
    const r = await bulk({
      employee_ids: [a.id],
      changes: { designation_id: "00000000-0000-4000-8000-000000000000" }, dry_run: true,
    });
    expect(r.status).toBe(422);
  });

  it("refuses a posting that is not a real place", async () => {
    const a = await employee();
    const r = await bulk({
      employee_ids: [a.id],
      changes: { site_id: "00000000-0000-4000-8000-000000000000" }, dry_run: true,
    });
    expect(r.status).toBe(422);
  });

  it("is not something a reader can do", async () => {
    const a = await employee();
    const r = await bulk(
      { employee_ids: [a.id], changes: { department: "X" }, dry_run: false }, w.role.AUDITOR);
    expect([401, 403]).toContain(r.status);
    expect((await read(a.id)).department).not.toBe("X");
  });

  it("will not touch salary, names or identifiers in bulk", async () => {
    // They identify one person and can never be right for a group; salary in
    // bulk is a payroll incident waiting to happen.
    const a = await employee();
    const r = await bulk({
      employee_ids: [a.id],
      changes: { salary_basic: 99999, first_name: "Renamed", aadhaar: "999999999999" },
      dry_run: false,
    });
    // Unknown keys are stripped, so this asks to change nothing at all.
    expect(r.status).toBe(422);
    const after = await read(a.id);
    expect(after.first_name).toBe("Bulk");
    expect(Number(after.salary_basic ?? 0)).not.toBe(99999);
  });
});

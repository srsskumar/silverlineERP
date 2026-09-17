/**
 * Job titles, chosen rather than typed.
 *
 * Designation was a free-text box, so "Site Engineer", "site engineer" and
 * "Sr Engineer" were three different designations to every report that
 * counted them. The list fixes that where it has to be fixed — at the point
 * somebody enters it — and the import has to land on the same list, because
 * most employees arrive through a spreadsheet rather than the form.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, ifMatch, uniq, uniquePhone, workDate,
  type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => { w = await buildWorld(); }, 120_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

async function call(method: "GET" | "POST", h: Headers, url: string, payload?: unknown) {
  const res = await w.app.inject({
    method, url, headers: { ...h, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}

const employee = (over: Record<string, unknown> = {}) => ({
  first_name: "Desig", last_name: "Test", phone: uniquePhone(),
  date_of_joining: workDate(), ...over,
});

describe("the list", () => {
  it("is seeded from the titles already in the directory", async () => {
    const r = await call("GET", w.admin, "/api/v1/designations");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it("is readable by anybody who can read the directory", async () => {
    // A dropdown whose options need their own permission renders empty for
    // half the people who have to use it.
    const r = await call("GET", w.role.HR_MANAGER, "/api/v1/designations");
    expect(r.status).toBe(200);
  });
});

describe("adding one", () => {
  it("works out the code from the label", async () => {
    const label = `Chief ${uniq("Rover")} Operator`;
    const r = await call("POST", w.admin, "/api/v1/designations", { label });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.label).toBe(label);
    expect(r.data.code).toMatch(/^[A-Z0-9_]+$/);
    expect(r.data.role_id).toBeNull();
  });

  it("returns the existing one rather than refusing a repeat", async () => {
    // Somebody adding a designation that is already there means the same
    // thing as picking it.
    const label = `Repeat ${uniq("Title")}`;
    const first = await call("POST", w.admin, "/api/v1/designations", { label });
    const again = await call("POST", w.admin, "/api/v1/designations", { label });
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(first.data.id);
  });

  it("matches an existing title however it was capitalised", async () => {
    const label = `Case ${uniq("Test")}`;
    const first = await call("POST", w.admin, "/api/v1/designations", { label });
    const shouting = await call("POST", w.admin, "/api/v1/designations",
      { label: label.toUpperCase() });
    expect(shouting.data.id).toBe(first.data.id);
  });

  it("creates the role alongside it when asked, with no permissions on it", async () => {
    // A job title that granted access by existing would make hiring an
    // access-control decision taken by whoever fills in the form.
    const label = `Roled ${uniq("Title")}`;
    const r = await call("POST", w.admin, "/api/v1/designations",
      { label, create_role: true });
    expect(r.status).toBe(201);
    expect(r.data.role_id).toBeTruthy();
    const perms = await w.pool.query(
      "SELECT count(*)::int AS n FROM role_permissions WHERE role_id = $1", [r.data.role_id]);
    expect(perms.rows[0].n).toBe(0);
    const role = await w.pool.query("SELECT name, is_system_role FROM roles WHERE id = $1",
      [r.data.role_id]);
    expect(role.rows[0].name).toBe(label);
    expect(role.rows[0].is_system_role).toBe(false);
  });

  it("refuses a label with nothing in it", async () => {
    for (const bad of ["", "   ", "!!!"]) {
      const r = await call("POST", w.admin, "/api/v1/designations", { label: bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it("is not something a reader can do", async () => {
    const r = await call("POST", w.role.AUDITOR, "/api/v1/designations",
      { label: `Sneaky ${uniq("T")}` });
    expect([401, 403]).toContain(r.status);
  });
});

describe("an employee's designation", () => {
  it("takes the label from the list when the id is given", async () => {
    const d = await call("POST", w.admin, "/api/v1/designations",
      { label: `Picked ${uniq("T")}` });
    const e = await call("POST", w.admin, "/api/v1/employees",
      employee({ designation_id: d.data.id, designation: "something else entirely" }));
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    // The id wins: the label beside it is what the list says, not what was
    // typed next to it.
    expect(e.data.designation).toBe(d.data.label);
    expect(e.data.designation_id).toBe(d.data.id);
  });

  it("refuses an id that is not on the list", async () => {
    const e = await call("POST", w.admin, "/api/v1/employees",
      employee({ designation_id: "00000000-0000-4000-8000-000000000000" }));
    expect(e.status).toBe(422);
  });

  it("finds the designation from a label typed in a spreadsheet", async () => {
    const d = await call("POST", w.admin, "/api/v1/designations",
      { label: `Sheet ${uniq("T")}` });
    const e = await call("POST", w.admin, "/api/v1/employees",
      employee({ designation: d.data.label.toLowerCase() }));
    expect(e.status).toBe(201);
    // Matched despite the capitalisation, which is the whole point of having
    // a list rather than a text box.
    expect(e.data.designation_id).toBe(d.data.id);
    expect(e.data.designation).toBe(d.data.label);
  });

  it("keeps a title nobody has added yet as the text it is", async () => {
    // Refusing an import over a job title nobody has got round to adding
    // helps nobody; the row still lands, unlinked.
    const e = await call("POST", w.admin, "/api/v1/employees",
      employee({ designation: "Underwater Basket Weaver" }));
    expect(e.status).toBe(201);
    expect(e.data.designation).toBe("Underwater Basket Weaver");
    expect(e.data.designation_id).toBeNull();
  });

  it("is left alone by an edit that does not mention it", async () => {
    const d = await call("POST", w.admin, "/api/v1/designations",
      { label: `Kept ${uniq("T")}` });
    const e = await call("POST", w.admin, "/api/v1/employees",
      employee({ designation_id: d.data.id }));
    const res = await w.app.inject({
      method: "PATCH", url: `/api/v1/employees/${e.data.id}`,
      headers: { ...w.admin, ...idem(), ...(await ifMatch(w, "employees", e.data.id)) },
      payload: { last_name: "Renamed" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json().data ?? res.json();
    expect(after.designation_id).toBe(d.data.id);
    expect(after.designation).toBe(d.data.label);
  });
});

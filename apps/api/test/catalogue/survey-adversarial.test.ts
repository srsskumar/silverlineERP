/**
 * The land survey module, pushed at deliberately.
 *
 * Every screen here takes numbers from a field crew on a phone and text from
 * a spreadsheet nobody wrote carefully. These are the inputs that arrive in
 * practice — a negative acreage, a date in the next century, a name with a
 * quote in it, somebody else's village id — and each one is either handled
 * or is a defect worth knowing about before a crew finds it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, joinProgramme, NOW, uniq, workDate,
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
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Adv district') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'Adv mandal',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);

  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("ADV"), name: "Adversarial programme", create_project: false });
  programmeId = String(p.data.id);

  const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
    village_name: "Adversarial village", village_code: uniq("AV"),
    mandal_id: mandalId, total_extent_ac: 100,
  });
  villageId = String(v.data.id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("numbers a crew can actually type", () => {
  const entry = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageId, entry_date: workDate(),
      teams_deployed: 1, values, ...extra,
    });

  it("refuses a negative quantity", async () => {
    // Negative progress is not progress, and a cumulative that can go
    // backwards is a cumulative nobody can reconcile.
    const r = await entry({ GOVT_LAND_EXTENT_AC: -50 });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("refuses a quantity that is not a number at all", async () => {
    const r = await entry({ GOVT_LAND_EXTENT_AC: "not a number" });
    expect(r.status).toBe(422);
  });

  it("refuses infinity and NaN, which JSON can smuggle in as strings", async () => {
    for (const bad of ["Infinity", "-Infinity", "NaN", "1e999"]) {
      const r = await entry({ GOVT_LAND_EXTENT_AC: bad });
      expect([422, 400], `value ${bad}`).toContain(r.status);
    }
  });

  it("refuses a negative team count", async () => {
    const r = await entry({ GOVT_LAND_EXTENT_AC: 1 }, { teams_deployed: -3 });
    expect(r.status).toBe(422);
  });

  it("refuses a village extent of zero or below", async () => {
    // Zero extent makes every percentage a division by nothing.
    for (const bad of [0, -1]) {
      const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
        village_name: "Bad extent", village_code: uniq("BE"),
        mandal_id: mandalId, total_extent_ac: bad,
      });
      expect(r.status, `extent ${bad}`).toBe(422);
    }
  });
});

describe("dates a crew can actually type", () => {
  it("refuses a return dated in the future", async () => {
    // Recording work that has not happened yet makes the pace figure a
    // forecast pretending to be a measurement.
    const future = new Date();
    future.setDate(future.getDate() + 3);
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageId, entry_date: future.toISOString().slice(0, 10),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 5 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("refuses a malformed date rather than guessing at it", async () => {
    for (const bad of ["31/12/2026", "2026-13-01", "2026-02-30", "yesterday", ""]) {
      const r = await post(w.admin, "/api/v1/survey/entries", {
        survey_village_id: villageId, entry_date: bad,
        teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 5 },
      });
      expect(r.status, `date ${bad}`).toBe(422);
    }
  });
});

describe("text from a spreadsheet nobody wrote carefully", () => {
  it("keeps a quote in a village name without breaking anything", async () => {
    const name = `O'Brien's "Village" -- DROP`;
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: name, village_code: uniq("QT"), mandal_id: mandalId,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const unit = await w.pool.query(
      "SELECT name FROM org_units WHERE id = (SELECT village_id FROM survey_villages WHERE id=$1)",
      [r.data.id]);
    // Stored exactly as given: escaping is the driver's job, not the name's.
    expect(unit.rows[0].name).toBe(name);
  });

  it("refuses a name longer than the column can hold", async () => {
    // Silently truncating somebody's data is worse than refusing it.
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "x".repeat(5000), village_code: uniq("LN"), mandal_id: mandalId,
    });
    expect(r.status).toBe(422);
  });

  it("refuses an empty or whitespace-only name", async () => {
    for (const bad of ["", "   ", "\t"]) {
      const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
        village_name: bad, village_code: uniq("EM"), mandal_id: mandalId,
      });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it("keeps Telugu script intact", async () => {
    // The villages are in Andhra Pradesh; a register that mangles the local
    // script is a register nobody trusts.
    const name = "అడకుల గ్రామం";
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: name, village_code: uniq("TE"), mandal_id: mandalId,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const unit = await w.pool.query(
      "SELECT name FROM org_units WHERE id = (SELECT village_id FROM survey_villages WHERE id=$1)",
      [r.data.id]);
    expect(unit.rows[0].name).toBe(name);
  });
});

describe("identifiers somebody else owns, or made up", () => {
  it("refuses a village id that is not a uuid", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: "'; DROP TABLE survey_villages; --",
      entry_date: workDate(), teams_deployed: 1, values: {},
    });
    expect(r.status).toBe(422);
    // And the table is still there.
    const alive = await w.pool.query("SELECT count(*)::int AS n FROM survey_villages");
    expect(alive.rows[0].n).toBeGreaterThan(0);
  });

  it("refuses a well-formed uuid that belongs to nothing", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: "00000000-0000-4000-8000-000000000000",
      entry_date: workDate(), teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 1 },
    });
    expect([404, 422]).toContain(r.status);
  });

  it("refuses a measure code nobody defined", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageId, entry_date: workDate(),
      teams_deployed: 1, values: { NOT_A_MEASURE: 5 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("refuses a stage code nobody defined", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageId}/stage`, {
      stage_code: "MADE_UP_STAGE", state: "IN_PROGRESS",
    });
    expect(r.status).toBe(422);
  });

  it("refuses a stage state that is not one of the three", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageId}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "NEARLY_DONE",
    });
    expect(r.status).toBe(422);
  });
});

describe("the same thing submitted twice", () => {
  it("refuses a second return for the same village on the same day", async () => {
    // Two returns for one day would double that day's work in every total.
    const day = workDate();
    const first = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageId, entry_date: day,
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 7 },
    });
    expect([201, 409]).toContain(first.status);
    const second = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageId, entry_date: day,
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 9 },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
  });

  it("refuses a programme code that is already in use", async () => {
    const code = uniq("DUP");
    await post(w.admin, "/api/v1/survey/projects", { code, name: "First", create_project: false });
    const again = await post(w.admin, "/api/v1/survey/projects",
      { code, name: "Second", create_project: false });
    expect(again.status).toBe(409);
  });
});

describe("reports asked for impossible things", () => {
  it("refuses a range that ends before it starts", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?from=2026-12-31&to=2026-01-01`);
    // Either refused, or answered with nothing — never with somebody else's
    // numbers.
    expect([200, 422]).toContain(r.status);
    if (r.status === 200) expect(r.data.total.doneAc ?? 0).toBe(0);
  });

  it("refuses a page size beyond the server maximum", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages?limit=100000`);
    // Clamped rather than obeyed: an unbounded page is a denial of service
    // anybody can trigger from the address bar.
    expect(r.status).toBe(200);
    expect((r.data as unknown[]).length).toBeLessThanOrEqual(100);
  });

  it("does not fall over on a grain it has never heard of", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/timeline?grain=FORTNIGHT`);
    expect(r.status).toBe(200);
  });

  it("refuses a range so wide it would answer with thousands of periods", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/timeline?grain=DAY&from=1900-01-01&to=2099-12-31`);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });
});

describe("a crew member reaching past their own programme", () => {
  it("cannot record progress against a village they are not on", async () => {
    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("OTH"), name: "Somebody else's", create_project: false });
    const theirVillage = await post(w.admin,
      `/api/v1/survey/projects/${other.data.id}/villages`,
      { village_name: "Theirs", village_code: uniq("TH"), mandal_id: mandalId });

    const r = await post(w.directUser, "/api/v1/survey/entries", {
      survey_village_id: theirVillage.data.id, entry_date: workDate(),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 5 },
    });
    expect([403, 404]).toContain(r.status);
  });

  it("cannot change the village list", async () => {
    // The list is what their own progress is measured against.
    const r = await post(w.directUser, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Not theirs to add", village_code: uniq("NT"), mandal_id: mandalId,
    });
    expect([401, 403, 404]).toContain(r.status);
  });
});

describe("reaching another programme through a child row's own id", () => {
  // GCP PATCH/DELETE were fixed to check the village's programme rather than
  // stopping at "is this row in my organisation" (inOrg). Two more routes had
  // the identical gap: they fetch the row by its own id, check inOrg, and
  // never ask whether the caller may touch the programme it actually belongs
  // to. Both are reached through permissions (survey.enter, survey.answer)
  // that ordinary staff -- not just survey.manage -- hold, and staff are
  // scoped to the programmes they are actually enrolled on.
  let theirProgramme: string;
  let theirEntryId: string;
  let theirQueryId: string;

  beforeAll(async () => {
    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("XPR"), name: "Somebody else's programme entirely", create_project: false });
    theirProgramme = String(other.data.id);
    const v = await post(w.admin, `/api/v1/survey/projects/${theirProgramme}/villages`,
      { village_name: "Not directUser's programme", village_code: uniq("XV"), mandal_id: mandalId });

    const entry = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: v.data.id, entry_date: workDate(),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 3 },
    });
    theirEntryId = String(entry.data.id);

    const query = await post(w.admin, `/api/v1/survey/projects/${theirProgramme}/queries`,
      { kind: "QUESTION", subject: "Why is this behind schedule",
        body: "Asking on behalf of the department, for the record." });
    theirQueryId = String(query.data.id);
  });

  it("cannot amend a daily return filed on a programme it is not on", async () => {
    // Before the fix this was a plain 200: directUser holds survey.enter
    // organisation-wide and inOrg alone does not ask which programme.
    const r = await patch(w.directUser, `/api/v1/survey/entries/${theirEntryId}`,
      { notes: "tampered from outside the programme" });
    expect([403, 404]).toContain(r.status);
  });

  it("cannot answer a question raised on a programme it is not on", async () => {
    // A team lead -- not just survey.manage -- holds survey.answer, and is
    // scoped like any other crew member. Enrolled here on the file's own
    // programme, deliberately not on theirProgramme.
    await joinProgramme(w.pool, w.orgId, w.roleUserId.TEAM_LEAD, programmeId);
    const r = await post(w.role.TEAM_LEAD, `/api/v1/survey/queries/${theirQueryId}/answer`,
      { answer: "tampered from outside the programme" });
    expect([403, 404]).toContain(r.status);
  });
});

describe("a crew member reaching past their own village", () => {
  // Being on the programme is not the same fact as being posted to a
  // particular village on it. `directEmployee` is put on `villageId`'s crew
  // below; `siteEmployee` (the other seeded active employee) never is, but
  // both end up "on the programme" once either one is crewed anywhere on
  // it — visibleProgrammes() answers at the programme level. A ground
  // control point is planted by whoever is standing on it, so it needs the
  // stronger, village-level check.
  let ownVillage: string;
  let otherVillage: string;

  beforeAll(async () => {
    const started = await post(w.admin, `/api/v1/survey/villages/${villageId}/start-gt`, {
      started_on: workDate(), expected_end_on: workDate(),
      employee_ids: [w.directEmployee],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    ownVillage = villageId;

    const v2 = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Not their crew's village", village_code: uniq("NC"),
      mandal_id: mandalId, total_extent_ac: 50,
    });
    otherVillage = String(v2.data.id);
    // siteEmployee is crewed on this one instead, so siteUser reads as "on
    // the programme" without being on ownVillage's crew.
    const started2 = await post(w.admin, `/api/v1/survey/villages/${otherVillage}/start-gt`, {
      started_on: workDate(), expected_end_on: workDate(),
      employee_ids: [w.siteEmployee],
    });
    expect(started2.status, JSON.stringify(started2.body)).toBe(201);
  });

  it("may plant a point on the village it is actually crewed to", async () => {
    const r = await post(w.directUser, `/api/v1/survey/villages/${ownVillage}/gcps`, {
      point_code: uniq("OWN"), latitude: 16.5, longitude: 80.6,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("is refused a point on a village elsewhere on the same programme", async () => {
    // Before the fix this returned 201: directUser is "on the programme"
    // (crewed on ownVillage) but never on otherVillage's crew.
    const r = await post(w.directUser, `/api/v1/survey/villages/${otherVillage}/gcps`, {
      point_code: uniq("OTH"), latitude: 16.5, longitude: 80.6,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_YOUR_VILLAGE");
  });

  it("a supervisor (survey.manage) is not held to the crew list", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${otherVillage}/gcps`, {
      point_code: uniq("SUP"), latitude: 16.5, longitude: 80.6,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe("a day filed before the crew was ever on the ground", () => {
  it("accepts a return dated before ground truthing started, flagged rather than silent", async () => {
    // Not refused: `started_on` is itself something somebody typed, and a
    // hard refusal would block backfilling the first few days once the
    // paperwork catches up. It must not be silent, though — before the fix
    // this entry carried no sign anything was odd about its date.
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Backdate village", village_code: uniq("BD"),
      mandal_id: mandalId, total_extent_ac: 40,
    });
    const bdVillage = String(v.data.id);
    const started = await post(w.admin, `/api/v1/survey/villages/${bdVillage}/start-gt`, {
      started_on: workDate(), expected_end_on: workDate(), employee_ids: [w.directEmployee],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);

    const before = new Date(NOW);
    before.setDate(before.getDate() - 30);
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: bdVillage, entry_date: before.toISOString().slice(0, 10),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 5 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.warnings?.length, JSON.stringify(r.data)).toBeGreaterThan(0);
    expect(r.data.warnings[0]).toContain("starting on");
  });

  it("carries no warning for a day on or after the start date", async () => {
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Ordinary village", village_code: uniq("OR"),
      mandal_id: mandalId, total_extent_ac: 40,
    });
    const village = String(v.data.id);
    await post(w.admin, `/api/v1/survey/villages/${village}/start-gt`, {
      started_on: workDate(), expected_end_on: workDate(), employee_ids: [w.directEmployee],
    });
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: village, entry_date: workDate(),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 5 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.warnings ?? []).toEqual([]);
  });
});

describe("what an observer is shown of a contact", () => {
  it("drops phone and email from the government observer's copy", async () => {
    const c = await post(w.admin, `/api/v1/survey/projects/${programmeId}/contacts`, {
      side: "GOVT", name: "Test Tahsildar", designation: "Tahsildar", phone: "9100000000",
      email: "tahsildar@example.invalid",
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);

    const asObserver = await get(w.role.GOVT_OBSERVER, `/api/v1/survey/projects/${programmeId}/contacts`);
    expect(asObserver.status, JSON.stringify(asObserver.body)).toBe(200);
    const row = (asObserver.data as Array<Record<string, unknown>>)
      .find((x) => x.id === c.data.id);
    expect(row, JSON.stringify(asObserver.data)).toBeTruthy();
    expect(row).not.toHaveProperty("phone");
    expect(row).not.toHaveProperty("email");
    expect(row!.name).toBe("Test Tahsildar");

    const asStaff = await get(w.admin, `/api/v1/survey/projects/${programmeId}/contacts`);
    const staffRow = (asStaff.data as Array<Record<string, unknown>>)
      .find((x) => x.id === c.data.id);
    expect(staffRow!.phone).toBe("9100000000");
  });
});

describe("the billing register's programme filter", () => {
  it("accepts survey_project_id as well as project_id", async () => {
    const byProjectId = await get(w.admin, `/api/v1/survey/billing?project_id=${programmeId}`);
    expect(byProjectId.status, JSON.stringify(byProjectId.body)).toBe(200);
    const bySurveyProjectId = await get(
      w.admin, `/api/v1/survey/billing?survey_project_id=${programmeId}`);
    expect(bySurveyProjectId.status, JSON.stringify(bySurveyProjectId.body)).toBe(200);
    expect(bySurveyProjectId.data.length).toBe(byProjectId.data.length);
  });
});

describe("the progress screen's district filter, given a dashboard's district id", () => {
  it("narrows the same way whether it is handed a name or the dashboard's id", async () => {
    const dash = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard?level=district`);
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    const district = (dash.data.options?.districts ?? [])[0];
    if (!district) return; // nothing districted on this programme in this run
    const byName = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?district=${encodeURIComponent(district.name)}`);
    const byId = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?district=${encodeURIComponent(district.id)}`);
    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    expect(byId.data.filter.villages).toBe(byName.data.filter.villages);
    expect(byId.data.filter.villages).toBeGreaterThan(0);
  });
});

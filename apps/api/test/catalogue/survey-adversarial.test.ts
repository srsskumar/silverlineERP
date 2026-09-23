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
import { buildWorld, idem, NOW, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

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

describe("concurrent stage-set calls on the same village", () => {
  it("keeps the audit trail honest when two calls race", async () => {
    // Regression: `villageOr404` was called here without a row lock, so two
    // concurrent stage-set calls each read "what it was" before either had
    // written "what it is now". The upsert itself is atomic — the state a
    // screen reads afterwards was never wrong — but the decision of whether
    // to write a `survey_stage_history` row, and what `from_state` to write
    // on it, was made from that stale read. Fired at real concurrency
    // (before the fix) that produced fewer history rows than calls, some
    // carrying a `from_state` the row had already moved past — a stage
    // history a variance review or a billing dispute cannot trust.
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Race village", village_code: uniq("RV"),
      mandal_id: mandalId, total_extent_ac: 50,
    });
    const raceVillageId = String(v.data.id);

    const calls = Array.from({ length: 8 }, (_, i) => post(
      w.admin, `/api/v1/survey/villages/${raceVillageId}/stage`,
      i % 2 === 0
        ? {
          stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", remarks: `race-${i}`,
          gt_govt_staff_allocated: 2, gt_crew_allocated: 2,
        }
        : {
          stage_code: "GROUND_TRUTHING", state: "COMPLETED",
          completed_on: workDate(), remarks: `race-${i}`,
        },
    ));
    const results = await Promise.all(calls);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);

    // Ordered by physical insertion order, not `changed_at`: `now()` is the
    // *transaction's* start time, not the moment the row was actually
    // written, so two calls queued behind the same lock can carry
    // `changed_at` values in the opposite order to the writes they describe.
    // Each row here is inserted exactly once, by a transaction that only
    // reaches its INSERT after the previous holder of the lock has
    // committed, so heap order is the true, causal order of the race.
    const history = (await w.pool.query(
      `SELECT from_state, to_state, remarks, changed_at
         FROM survey_stage_history
        WHERE survey_village_id = $1
        ORDER BY ctid`,
      [raceVillageId])).rows;

    // Eight calls alternate IN_PROGRESS/COMPLETED, but concurrent calls have
    // no guaranteed order of execution -- the lock says who goes next only
    // once the others are queued, not which of the eight goes first. Two
    // calls asking for the same state can legitimately land back to back
    // (one is then a real no-op, and rightly writes nothing), so the count
    // of history rows is not fixed at eight. What is fixed, win or lose the
    // race for a turn, is that every row that IS written tells the truth.
    expect(history.length, JSON.stringify(history)).toBeGreaterThan(0);

    // The chain has to be honest: each row's "from" is the row before it's
    // "to" (null for the very first), never a state some other, interleaved
    // call had already overtaken by the time this one wrote. This is
    // exactly what broke before the village row was locked: a stale read let
    // two calls each believe they were moving from the same "previous"
    // state, so the row written after the first transition already carried
    // a from_state the table had moved past.
    let expectedFrom: string | null = null;
    for (const row of history) {
      expect(row.from_state, JSON.stringify(history)).toBe(expectedFrom);
      expectedFrom = row.to_state;
    }

    // And the row itself agrees with its own history: whatever state the
    // stage actually holds now is the "to" of the last transition on record.
    const stored = (await w.pool.query(
      `SELECT vs.state FROM survey_village_stages vs
         JOIN survey_stages s ON s.id = vs.stage_id
        WHERE vs.survey_village_id = $1 AND s.code = 'GROUND_TRUTHING'`,
      [raceVillageId])).rows[0];
    expect(stored.state).toBe(expectedFrom);
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

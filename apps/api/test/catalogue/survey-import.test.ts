/**
 * Importing the village work list (§59.3.3).
 *
 * The rows are the ones from the source document, because the import exists
 * to swallow that file exactly as the revenue department issues it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let projectId: string;

async function send(method: "POST" | "GET", headers: Headers, url: string, payload?: unknown) {
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

/** The three rows the source document gives, verbatim. */
const SOURCE_ROWS = [
  {
    district_code: "15", district_name: "Alluri Sitharama Raju",
    division_code: "1", division_name: "Paderu",
    mandal_code: "5", mandal_name: "HUKUMPETA",
    village_code: "1505008", village_name: "AAMOORU", vill_code_old: "303007",
  },
  {
    district_code: "15", district_name: "Alluri Sitharama Raju",
    division_code: "1", division_name: "Paderu",
    mandal_code: "10", mandal_name: "GUDEM KOTHAVEEDHI",
    village_code: "1510101", village_name: "Adagarapalle", vill_code_old: "313103",
  },
  {
    district_code: "15", district_name: "Alluri Sitharama Raju",
    division_code: "1", division_name: "Paderu",
    mandal_code: "11", mandal_name: "KOYYURU",
    village_code: "1511077", village_name: "ADAKULA", vill_code_old: "314077",
  },
];

async function importRows(rows: unknown[], dryRun = false) {
  return post(w.admin, `/api/v1/survey/projects/${projectId}/villages/import`,
    { rows, dry_run: dryRun });
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "AP resurvey import" });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  projectId = String(p.data.id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("§59.3.3 importing the work list", () => {
  it("previews without writing anything, by default", async () => {
    // An import that creates several thousand rows of geography on a typo is
    // not one anybody runs twice.
    const r = await post(w.admin, `/api/v1/survey/projects/${projectId}/villages/import`,
      { rows: SOURCE_ROWS });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.dry_run).toBe(true);
    expect(r.data.validated).toBe(3);

    const after = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    expect(after.data).toHaveLength(0);
  });

  it("builds the geography and lists the villages in one pass", async () => {
    const r = await importRows(SOURCE_ROWS);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.imported).toBe(3);
    // One district, one division, three mandals, three villages.
    expect(r.data.geography_created).toMatchObject({
      districts: 1, divisions: 1, mandals: 3, villages: 3,
    });

    const villages = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    expect(villages.data).toHaveLength(3);
    const adakula = villages.data.find((v: any) => v.village_name === "ADAKULA");
    expect(adakula.mandal_name).toBe("KOYYURU");
    expect(adakula.division_name).toBe("Paderu");
    expect(adakula.vill_code_old).toBe("314077");
  });

  it("reuses the geography on a second import rather than duplicating it", async () => {
    // Re-running after fixing a few rows is the normal way this gets used.
    const r = await importRows(SOURCE_ROWS);
    expect(r.data.already_listed).toBe(3);
    expect(r.data.geography_created).toMatchObject({ districts: 0, mandals: 0, villages: 0 });

    const districts = await w.pool.query(
      "SELECT count(*)::int AS n FROM org_units WHERE org_id = $1 AND type = 'district' AND source_code = '15'",
      [w.orgId]);
    expect(districts.rows[0].n).toBe(1);
  });

  it("matches on the source code, not the name", async () => {
    // Two villages called Ramapuram in one district is ordinary; the code is
    // what the revenue department reconciles against.
    const renamed = [{ ...SOURCE_ROWS[0], village_name: "AAMOORU (renamed)" }];
    await importRows(renamed);
    const rows = await w.pool.query(
      "SELECT name FROM org_units WHERE org_id = $1 AND type='village' AND source_code = '1505008'",
      [w.orgId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].name).toBe("AAMOORU (renamed)");
  });

  it("puts a mandal straight under the district when no division is given", async () => {
    const r = await importRows([{
      district_code: "16", district_name: "Anakapalli",
      division_code: "", division_name: "",
      mandal_code: "16-1", mandal_name: "NARSIPATNAM",
      village_code: "1601001", village_name: "Direct village",
    }]);
    expect(r.data.imported).toBe(1);
    expect(r.data.geography_created.divisions).toBe(0);

    const chain = await w.pool.query(
      `SELECT d.type AS parent_type FROM org_units v
       JOIN org_units m ON m.id = v.parent_id
       JOIN org_units d ON d.id = m.parent_id
       WHERE v.org_id = $1 AND v.source_code = '1601001'`, [w.orgId]);
    expect(chain.rows[0].parent_type).toBe("district");
  });

  it("carries the extent and the equipment allotment through", async () => {
    const r = await importRows([{
      district_code: "15", district_name: "Alluri Sitharama Raju",
      division_code: "1", division_name: "Paderu",
      mandal_code: "11", mandal_name: "KOYYURU",
      village_code: "1511078", village_name: "Annavaram",
      total_extent_ac: "16.82", dgps_base: "1", dgps_rovers: "3", teams: "2",
    }]);
    expect(r.data.imported).toBe(1);

    const villages = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const v = villages.data.find((x: any) => x.village_name === "Annavaram");
    expect(Number(v.total_extent_ac)).toBe(16.82);
    // Square kilometres are derived, and match the worked example in the sheet.
    expect(v.total_extent_sq_km).toBeCloseTo(0.068, 3);
    expect(v.dgps_rovers).toBe(3);
  });

  it("accepts a village with no extent rather than refusing the row", async () => {
    // A village without a recorded extent still has to be surveyed. It is
    // reported as unweighted, not rejected.
    const r = await importRows([{
      district_code: "15", district_name: "Alluri Sitharama Raju",
      mandal_code: "11", mandal_name: "KOYYURU",
      village_code: "1511079", village_name: "No extent village",
    }]);
    expect(r.data.imported).toBe(1);

    const progress = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=mandal`);
    expect(progress.data.total.unweighted).toBeGreaterThan(0);
  });

  it("rejects a bad row and imports the rest of the file", async () => {
    // One typo in a five-thousand-row spreadsheet must not cost the whole
    // import.
    const r = await importRows([
      { district_code: "17", district_name: "Vizianagaram",
        mandal_code: "17-1", mandal_name: "Good mandal",
        village_code: "1701001", village_name: "Good village" },
      { district_code: "", district_name: "", mandal_code: "", mandal_name: "",
        village_code: "", village_name: "" },
    ]);
    expect(r.data.imported).toBe(1);
    expect(r.data.rejected).toBe(1);
    // The village code is the one field the row cannot do without: the
    // district and mandal are optional now, because the source file arrives
    // with gaps and losing the village is worse than losing its district.
    expect(r.data.results[1].message).toContain("village_code");
  });

  it("refuses a negative extent", async () => {
    const r = await importRows([{
      district_code: "15", district_name: "Alluri Sitharama Raju",
      mandal_code: "11", mandal_name: "KOYYURU",
      village_code: "1511080", village_name: "Negative extent",
      total_extent_ac: "-5",
    }]);
    expect(r.data.rejected).toBe(1);
  });

  it("writes nothing at all when the preview is rolled back", async () => {
    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM org_units WHERE org_id = $1", [w.orgId]);
    await post(w.admin, `/api/v1/survey/projects/${projectId}/villages/import`, {
      rows: [{
        district_code: "99", district_name: "Never created",
        mandal_code: "99-1", mandal_name: "Never",
        village_code: "9901001", village_name: "Never",
      }],
      dry_run: true,
    });
    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM org_units WHERE org_id = $1", [w.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("is refused to a crew that may record progress but not shape the work list", async () => {
    const r = await post(w.role.TEAM_LEAD,
      `/api/v1/survey/projects/${projectId}/villages/import`,
      { rows: SOURCE_ROWS, dry_run: true });
    expect(r.status).toBe(403);
  });

  it("feeds straight into the progress report", async () => {
    // The point of the import: from a spreadsheet to a rolled-up report with
    // nothing typed in between.
    const progress = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=division`);
    expect(progress.status).toBe(200);
    expect(progress.data.rows.some((r: any) => r.name === "Paderu")).toBe(true);
    expect(progress.data.total.villages).toBeGreaterThanOrEqual(5);
  });
});

describe("§48 a list with empty columns", () => {
  it("imports a village whose district and mandal are blank", async () => {
    // The file arrives from the revenue department with gaps, and refusing
    // the row means the village never gets surveyed in the system at all.
    const r = await importRows([{
      district_code: "", district_name: "", division_code: "", division_name: "",
      mandal_code: "", mandal_name: "",
      village_code: "9900001", village_name: "Gap village",
    }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.imported).toBe(1);
    expect(r.data.rejected).toBe(0);
  });

  it("says what the row was missing rather than staying silent", async () => {
    const r = await importRows([{
      village_code: "9900002", village_name: "Another gap",
    }]);
    expect(r.data.results[0].message).toContain("Imported without");
    expect(r.data.results[0].message).toContain("district");
  });

  it("files it under a placeholder so the hierarchy still resolves", async () => {
    // A visible gap somebody can fill in, rather than a silent absence.
    const chain = await w.pool.query(
      `SELECT d.name AS district, m.name AS mandal
       FROM org_units v JOIN org_units m ON m.id = v.parent_id
       JOIN org_units d ON d.id = m.parent_id
       WHERE v.org_id = $1 AND v.source_code = '9900001'`, [w.orgId]);
    expect(chain.rows[0]).toMatchObject({
      district: "Not attributed", mandal: "Not attributed",
    });
  });

  it("still refuses a row with no village at all", async () => {
    // A village code is the one thing the row cannot do without: there is
    // nothing to survey and nothing to reconcile against.
    const r = await importRows([{ district_code: "15", district_name: "Alluri" }]);
    expect(r.data.rejected).toBe(1);
    expect(r.data.results[0].message).toContain("village_code");
  });

  it("counts the placeholder villages in the programme", async () => {
    const villages = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    expect(villages.data.some((v: any) => v.village_name === "Gap village")).toBe(true);
  });
});

describe("a village list with cells left blank", () => {
  /*
   * The importer says a village with no extent "is still a village that has
   * to be surveyed — it is reported as unweighted rather than refused", and
   * the code did the opposite: z.coerce.number()('') is 0, and 0 then failed
   * the positive check. A blank allotment quietly became an allotment of
   * none.
   */
  it("loads a village whose extent was never recorded", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${projectId}/villages/import`, {
      rows: [{
        district_code: "D1", district_name: "A district",
        mandal_code: "M1", mandal_name: "A mandal",
        village_code: uniq("NX"), village_name: "No extent recorded",
        total_extent_ac: "",
      }],
      dry_run: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.imported, JSON.stringify(r.data.results)).toBe(1);
    expect(r.data.rejected).toBe(0);
  });

  it("does not turn a blank allotment into an allotment of none", async () => {
    // "Not given" and "zero" are different facts, and the second is a claim
    // nobody made.
    const code = uniq("NB");
    await post(w.admin, `/api/v1/survey/projects/${projectId}/villages/import`, {
      rows: [{
        district_code: "D1", district_name: "A district",
        mandal_code: "M1", mandal_name: "A mandal",
        village_code: code, village_name: "No allotment given",
        total_extent_ac: "40", dgps_base: "", dgps_rovers: "", teams: "",
      }],
      dry_run: false,
    });
    const row = await w.pool.query(
      `SELECT sv.dgps_base, sv.dgps_rovers, sv.teams, sv.total_extent_ac
         FROM survey_villages sv JOIN org_units ou ON ou.id = sv.village_id
        WHERE ou.source_code = $1`, [code]);
    expect(row.rowCount, "the row loaded").toBe(1);
    expect(Number(row.rows[0].total_extent_ac)).toBe(40);
  });

  it("still refuses an extent nobody could read", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${projectId}/villages/import`, {
      rows: [{
        district_code: "D1", district_name: "A district",
        mandal_code: "M1", mandal_name: "A mandal",
        village_code: uniq("BAD"), village_name: "Unreadable extent",
        total_extent_ac: "about forty acres",
      }],
      dry_run: true,
    });
    expect(r.data.rejected).toBe(1);
  });
});

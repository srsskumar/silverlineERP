/**
 * D-013: calendar days stamped by the database must be the organisation's
 * day, not whatever day the database session is in.
 *
 * The live session runs in UTC, so for 00:00-05:30 IST CURRENT_DATE is
 * yesterday. That window cannot be waited for in a test, so the test DB's
 * default timezone is moved to whichever of UTC-12 and UTC+14 is on a
 * different date from India right now; any CURRENT_DATE left in the code
 * then stamps the wrong day, deterministically.
 */

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, TEST_DB, workDate, type CatalogueWorld } from "./fixture.js";

let w: CatalogueWorld;
let dbName = "";

function dateIn(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

beforeAll(async () => {
  const zone = dateIn("Etc/GMT+12") !== workDate() ? "Etc/GMT+12" : "Etc/GMT-14";
  const admin = new Pool({ connectionString: TEST_DB });
  dbName = (await admin.query("SELECT current_database() AS d")).rows[0].d;
  await admin.query(`ALTER DATABASE "${dbName}" SET timezone TO '${zone}'`);
  await admin.end();
  w = await buildWorld();
  const tz = (await w.pool.query("SELECT current_setting('TimeZone') AS tz, CURRENT_DATE::text AS d")).rows[0];
  expect(tz.tz).toBe(zone);
  expect(tz.d).not.toBe(workDate());
}, 180_000);

afterAll(async () => {
  await w?.app.close(); await w?.pool.end();
  const admin = new Pool({ connectionString: TEST_DB });
  await admin.query(`ALTER DATABASE "${dbName}" RESET timezone`);
  await admin.end();
});

describe("D-013 survey crew enrolment dates", () => {
  it("stamps assigned_on and released_on with the organisation's day", async () => {
    const programme = (await w.pool.query(
      "INSERT INTO survey_projects (org_id, code, name) VALUES ($1,$2,'TZ programme') RETURNING id",
      [w.orgId, `SPTZ${Date.now()}`])).rows[0].id as string;
    const put = (programmes: unknown[]) => w.app.inject({
      method: "PUT", url: `/api/v1/employees/${w.siteEmployee}/assignments`, headers: w.admin,
      payload: { project_access: "ORGANISATION", programmes },
    });
    const on = await put([{ survey_project_id: programme, project_role: "GT_USER" }]);
    expect(on.statusCode, on.body).toBe(200);
    const off = await put([]);
    expect(off.statusCode, off.body).toBe(200);
    const row = (await w.pool.query(
      "SELECT assigned_on::text AS a, released_on::text AS r FROM survey_project_employees WHERE employee_id=$1 AND survey_project_id=$2",
      [w.siteEmployee, programme])).rows[0];
    expect(row).toEqual({ a: workDate(), r: workDate() });
  });
});

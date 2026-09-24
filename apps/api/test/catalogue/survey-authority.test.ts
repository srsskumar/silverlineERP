/**
 * Who may complete a stage, and who may record a control point
 * (owner decision, 2026-09-24; SV-001 / SV-002 in
 * docs/qa/2026-09-24/findings-survey-deep.md).
 *
 * The same five people for both, through one helper:
 *   - the crew member assigned to the village (for a stage: to that stage),
 *   - that crew member's reporting manager (employees.reports_to),
 *   - a team leader (TEAM_LEAD; already confined to the programmes they are
 *     on by the village lookup),
 *   - the project manager of the survey's project (PROJECT_MANAGER whose
 *     role scope covers the paired project, or who is its project manager),
 *   - an administrator.
 * Anybody else holding survey.enter is refused with a stable code, and
 * another organisation never learns the village exists.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, createUser, idem, joinProgramme, loginAs, uniq, workDate,
  type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let programmeId: string;
let pairedProjectId: string;
let villageA: string;
let villageB: string;
let mandalId: string;

async function send(method: "POST" | "GET" | "PATCH" | "DELETE", headers: Headers, url: string, payload?: unknown) {
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

/** An employee record and a signed-in user for it, with the given roles. */
async function person(roles: string[], reportsTo: string | null = null) {
  const employeeId = String((await w.pool.query(
    `INSERT INTO employees (org_id, emp_no, first_name, last_name, phone, date_of_joining, reports_to)
     VALUES ($1, $2, 'Auth', 'Person', $3, CURRENT_DATE, $4) RETURNING id`,
    [w.orgId, uniq("AUTH"), `9${Math.floor(100000000 + Math.random() * 899999999)}`, reportsTo],
  )).rows[0].id);
  const username = uniq("auth").toLowerCase();
  const userId = await createUser(w.pool, w.orgId, { username, roles: roles as never, employeeId });
  return { employeeId, userId, headers: await loginAs(w.app, username) };
}

const complete = (h: Headers, village: string, code = "GROUND_TRUTHING") =>
  post(h, `/api/v1/survey/villages/${village}/stage`,
    { stage_code: code, state: "COMPLETED", started_on: workDate(), completed_on: workDate() });
const reopen = (village: string) =>
  post(w.admin, `/api/v1/survey/villages/${village}/stage`,
    { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: workDate() });
const gcp = (h: Headers, village: string) =>
  post(h, `/api/v1/survey/villages/${village}/gcps`,
    { point_code: uniq("GCP"), latitude: 16.5, longitude: 80.6 });

let crew: Awaited<ReturnType<typeof person>>;
let manager: Awaited<ReturnType<typeof person>>;
let bystander: Awaited<ReturnType<typeof person>>;
let otherCrew: Awaited<ReturnType<typeof person>>;
let vecCrew: Awaited<ReturnType<typeof person>>;
let teamLead: Awaited<ReturnType<typeof person>>;
let ownPm: Awaited<ReturnType<typeof person>>;
let scopedPm: Awaited<ReturnType<typeof person>>;
let elsewherePm: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Auth district') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'Auth mandal',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);

  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("AUTH"), name: "Authority programme", workspace_id: w.workspaceId });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  programmeId = String(p.data.id);
  pairedProjectId = String(p.data.project_id);

  const village = async (name: string) => String((await post(w.admin,
    `/api/v1/survey/projects/${programmeId}/villages`,
    { village_name: name, village_code: uniq("AV"), mandal_id: mandalId, total_extent_ac: 100 })).data.id);
  villageA = await village("Authority A");
  villageB = await village("Authority B");

  manager = await person(["EMPLOYEE"]);
  crew = await person(["EMPLOYEE"], manager.employeeId);
  bystander = await person(["EMPLOYEE"]);
  otherCrew = await person(["EMPLOYEE"]);
  vecCrew = await person(["EMPLOYEE"]);
  teamLead = await person(["TEAM_LEAD"]);
  ownPm = await person(["PROJECT_MANAGER"]);
  scopedPm = await person(["PROJECT_MANAGER"]);
  elsewherePm = await person(["PROJECT_MANAGER"]);

  // The paired project's own manager.
  await w.pool.query("UPDATE projects SET project_manager_id = $2 WHERE id = $1",
    [pairedProjectId, ownPm.userId]);
  // A PM whose role is scoped to this project, and one scoped to another.
  await w.pool.query(
    `UPDATE user_roles SET scope_type = 'project', scope_id = $2 WHERE user_id = $1`,
    [scopedPm.userId, pairedProjectId]);
  await w.pool.query(
    `UPDATE user_roles SET scope_type = 'project', scope_id = $2 WHERE user_id = $1`,
    [ownPm.userId, w.activeProject]);
  await w.pool.query(
    `UPDATE user_roles SET scope_type = 'project', scope_id = $2 WHERE user_id = $1`,
    [elsewherePm.userId, w.activeProject]);
  // Re-sign-in so the tokens carry the scopes as they now are.
  for (const pm of [ownPm, scopedPm, elsewherePm]) {
    const name = (await w.pool.query("SELECT username FROM users WHERE id = $1", [pm.userId])).rows[0].username;
    pm.headers = await loginAs(w.app, name);
  }

  const started = await post(w.admin, `/api/v1/survey/villages/${villageA}/start-gt`, {
    started_on: workDate(), expected_end_on: workDate(), employee_ids: [crew.employeeId], govt_staff_allocated: 1, crew_allocated: 1,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const startedB = await post(w.admin, `/api/v1/survey/villages/${villageB}/start-gt`, {
    started_on: workDate(), expected_end_on: workDate(), employee_ids: [otherCrew.employeeId], govt_staff_allocated: 1, crew_allocated: 1,
  });
  expect(startedB.status, JSON.stringify(startedB.body)).toBe(201);
  // On village A, but on a different stage.
  const vec = await post(w.admin, `/api/v1/survey/villages/${villageA}/crew`,
    { employee_id: vecCrew.employeeId, stage_code: "VECTORIZATION" });
  expect(vec.status, JSON.stringify(vec.body)).toBe(201);

  // Everyone who is not crew has to be on the programme to reach it at all.
  for (const who of [manager, bystander, teamLead]) {
    await joinProgramme(w.pool, w.orgId, who.userId, programmeId, "GT_USER");
  }
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

// SV-001: the stage-completion half of the owner decision is NOT implemented
// on this branch -- the edit to the stage route was refused by the session's
// permission classifier and is waiting on the user's own approval. These
// tests describe the rule as decided and stay skipped until then.
describe.skip("completing a stage", () => {
  const allowed: Array<[string, () => Headers]> = [
    ["the crew member assigned to the stage", () => crew.headers],
    ["that crew member's reporting manager", () => manager.headers],
    ["a team leader on the programme", () => teamLead.headers],
    ["the project manager of the survey's project", () => ownPm.headers],
    ["a project manager scoped to the survey's project", () => scopedPm.headers],
    ["an administrator", () => w.admin],
  ];
  for (const [who, h] of allowed) {
    it(`is allowed for ${who}`, async () => {
      const r = await complete(h(), villageA);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.data.state).toBe("COMPLETED");
      const back = await reopen(villageA);
      expect(back.status, JSON.stringify(back.body)).toBe(200);
    });
  }

  it("is refused for a surveyor on the programme who is not on the crew", async () => {
    const r = await complete(bystander.headers, villageA);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("STAGE_NOT_ASSIGNED");
  });

  it("is refused for another crew's member", async () => {
    const r = await complete(otherCrew.headers, villageA);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("STAGE_NOT_ASSIGNED");
  });

  it("is refused for a crew member of the same village on a different stage", async () => {
    const r = await complete(vecCrew.headers, villageA);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("STAGE_NOT_ASSIGNED");
  });

  it("is refused for a project manager of some other project", async () => {
    const r = await complete(elsewherePm.headers, villageA);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("STAGE_NOT_ASSIGNED");
  });

  it("is refused for another organisation without saying the village exists", async () => {
    const r = await complete(w.other.admin, villageA);
    expect(r.status).toBe(404);
  });

  it("does not stop the crew moving a stage that is not a completion", async () => {
    const r = await post(bystander.headers, `/api/v1/survey/villages/${villageA}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: workDate() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("tells the screen whether this reader may complete each stage", async () => {
    const crewView = await send("GET", crew.headers, `/api/v1/survey/villages/${villageA}`);
    expect(crewView.status, JSON.stringify(crewView.body)).toBe(200);
    const gtCrew = crewView.data.stage_authority?.GROUND_TRUTHING;
    expect(gtCrew?.may_complete).toBe(true);

    const byView = await send("GET", bystander.headers, `/api/v1/survey/villages/${villageA}`);
    const gtBy = byView.data.stage_authority?.GROUND_TRUTHING;
    expect(gtBy?.may_complete).toBe(false);
    expect(String(gtBy?.reason ?? "")).toMatch(/crew|assigned/i);
  });
});

describe("recording a control point", () => {
  it("is allowed for the assigned crew member", async () => {
    expect((await gcp(crew.headers, villageA)).status).toBe(201);
  });
  it("is allowed for a crew member on any stage of that village", async () => {
    expect((await gcp(vecCrew.headers, villageA)).status).toBe(201);
  });
  it("is allowed for the crew member's reporting manager", async () => {
    const r = await gcp(manager.headers, villageA);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
  it("is allowed for a team leader, the project's PM and an admin", async () => {
    for (const h of [teamLead.headers, ownPm.headers, scopedPm.headers, w.admin]) {
      const r = await gcp(h, villageA);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });
  it("is refused for anybody else holding survey.enter", async () => {
    for (const h of [bystander.headers, otherCrew.headers, elsewherePm.headers]) {
      const r = await gcp(h, villageA);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe("NOT_YOUR_VILLAGE");
    }
  });
  it("applies the same rule to correcting a point", async () => {
    const made = await gcp(w.admin, villageA);
    const id = made.data.id;
    const edit = (h: Headers) => w.app.inject({
      method: "PATCH", url: `/api/v1/survey/gcps/${id}`,
      headers: { ...h, ...idem(), "if-match": "1" }, payload: { remarks: "moved" },
    });
    expect((await edit(bystander.headers)).statusCode).toBe(403);
    expect((await edit(elsewherePm.headers)).statusCode).toBe(403);
    const ok = await edit(manager.headers);
    expect(ok.statusCode, ok.body).toBe(200);
  });
  it("applies the same rule to deleting a point, on top of survey.manage", async () => {
    const made = await gcp(w.admin, villageA);
    const del = (h: Headers) => send("DELETE", h, `/api/v1/survey/gcps/${made.data.id}`);
    expect((await del(elsewherePm.headers)).status).toBe(403);
    expect((await del(crew.headers)).status).toBe(403); // survey.enter cannot delete
    expect((await del(ownPm.headers)).status).toBe(200);
  });
  it("is a 404 for another organisation", async () => {
    expect((await gcp(w.other.admin, villageA)).status).toBe(404);
  });
});

/*
 * Observers never see a contact's phone number (owner decision 2026-09-24,
 * SV-003). Contacts are returned by GET /survey/projects/:id/contacts and by
 * nothing else in the module; every observer shape is asked.
 */
describe("what an observer is shown of a contact", () => {
  let contactId: string;
  const PHONE = "+91 98480 55555";

  beforeAll(async () => {
    const c = await post(w.admin, `/api/v1/survey/projects/${programmeId}/contacts`, {
      side: "GOVT", name: "Observer Test Tahsildar", designation: "Tahsildar", phone: PHONE,
      email: "tahsildar.auth@example.invalid", notes: `Ring after 10 on ${PHONE}`,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    contactId = String(c.data.id);
  });

  async function rowFor(h: Headers) {
    const r = await send("GET", h, `/api/v1/survey/projects/${programmeId}/contacts`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (r.data as Array<Record<string, unknown>>).find((x) => x.id === contactId);
    expect(row, JSON.stringify(r.data)).toBeTruthy();
    return row!;
  }
  function expectMasked(row: Record<string, unknown>) {
    expect(row).not.toHaveProperty("phone");
    expect(row).not.toHaveProperty("email");
    expect(JSON.stringify(row)).not.toContain("98480");
    expect(row.name).toBe("Observer Test Tahsildar");
  }

  it("masks them for the government observer", async () => {
    expectMasked(await rowFor(w.role.GOVT_OBSERVER));
  });

  it("masks them for a client viewer scoped to the programme's project", async () => {
    const client = await person(["CLIENT_VIEWER"]);
    await w.pool.query(
      `UPDATE user_roles SET scope_type = 'project', scope_id = $2 WHERE user_id = $1`,
      [client.userId, pairedProjectId]);
    const name = (await w.pool.query("SELECT username FROM users WHERE id = $1", [client.userId])).rows[0].username;
    expectMasked(await rowFor(await loginAs(w.app, name)));
  });

  it("masks them for an observer who also holds a staff role", async () => {
    const mixed = await person(["GOVT_OBSERVER", "EMPLOYEE"]);
    await joinProgramme(w.pool, w.orgId, mixed.userId, programmeId, "GT_USER");
    expectMasked(await rowFor(mixed.headers));
  });

  it("still shows them to staff", async () => {
    const row = await rowFor(w.admin);
    expect(row.phone).toBe(PHONE);
  });
});

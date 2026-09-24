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
    `INSERT INTO employees (org_id, emp_no, first_name, last_name, phone, date_of_joining, reports_to, status)
     VALUES ($1, $2, 'Auth', 'Person', $3, CURRENT_DATE, $4, 'ACTIVE') RETURNING id`,
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
  it("applies the same rule to deleting a point (fix round 1: crew included)", async () => {
    const del = async (h: Headers) => {
      const made = await gcp(w.admin, villageA);
      return send("DELETE", h, `/api/v1/survey/gcps/${made.data.id}`);
    };
    for (const h of [bystander.headers, otherCrew.headers, elsewherePm.headers]) {
      const r = await del(h);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe("NOT_YOUR_VILLAGE");
    }
    for (const h of [crew.headers, vecCrew.headers, manager.headers, teamLead.headers, ownPm.headers, w.admin]) {
      const r = await del(h);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
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

/*
 * Fix round 1, item 2: an employee's phone number on the crew-assets and
 * programme-people lists is masked for anybody holding an observer role,
 * even alongside a staff role (the same rule as SV-003).
 */
describe("what an observer is shown of the crew's phone numbers", () => {
  let govtStaff: Awaited<ReturnType<typeof person>>;
  let clientStaff: Awaited<ReturnType<typeof person>>;

  beforeAll(async () => {
    const asset = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,'Phone test rover','SURVEY','ASSIGNED','GOOD') RETURNING id`,
      [w.orgId, uniq("PR")])).rows[0].id);
    await w.pool.query(
      `INSERT INTO asset_assignments(org_id, asset_id, employee_id, condition, reason)
       VALUES($1,$2,$3,'GOOD','field kit')`, [w.orgId, asset, crew.employeeId]);
    await joinProgramme(w.pool, w.orgId, crew.userId, programmeId, "GT_USER");
    govtStaff = await person(["GOVT_OBSERVER", "EMPLOYEE"]);
    clientStaff = await person(["CLIENT_VIEWER", "EMPLOYEE"]);
    for (const who of [govtStaff, clientStaff]) {
      await joinProgramme(w.pool, w.orgId, who.userId, programmeId, "GT_USER");
    }
  });

  const urls = () => [
    `/api/v1/survey/villages/${villageA}/crew-assets`,
    `/api/v1/survey/projects/${programmeId}/employees`,
  ];

  it("shows staff the phone numbers", async () => {
    for (const url of urls()) {
      const r = await send("GET", w.admin, url);
      expect(r.status, `${url} ${JSON.stringify(r.body)}`).toBe(200);
      expect((r.data as any[]).length, url).toBeGreaterThan(0);
      expect((r.data as any[]).some((x) => typeof x.phone === "string" && x.phone.length > 5), url).toBe(true);
    }
  });

  for (const [label, who] of [["a government observer with a staff role", () => govtStaff],
    ["a client viewer with a staff role", () => clientStaff]] as const) {
    it(`masks them for ${label}`, async () => {
      for (const url of urls()) {
        const r = await send("GET", who().headers, url);
        if (r.status !== 200) { expect([403, 404], url).toContain(r.status); continue; }
        for (const row of r.data as any[]) expect(row, url).not.toHaveProperty("phone");
      }
    });
  }
});

/*
 * SV-018: putting somebody on a programme (and on a village's crew) is
 * governed by the survey authority rule, not by the employee directory's
 * record scope. A PM of the survey's project could start ground truthing with
 * anybody (start-gt takes an array the directory check never looked at) yet
 * was refused 403 enrolling the same person one at a time.
 */
describe("SV-018 enrolling people on the programme", () => {
  const enrol = (h: Headers, employee: string) =>
    post(h, `/api/v1/survey/projects/${programmeId}/employees`,
      { employee_id: employee, project_role: "GT_USER" });

  it("lets the survey project's PM enrol anybody in the organisation", async () => {
    const r = await enrol(ownPm.headers, w.siteEmployee);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("lets a PM scoped to the survey's project enrol, and assign crew", async () => {
    expect((await enrol(scopedPm.headers, w.directEmployee)).status).toBe(201);
    const c = await post(scopedPm.headers, `/api/v1/survey/villages/${villageB}/crew`,
      { employee_id: w.directEmployee, stage_code: "GT_QC" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
  });

  it("lets a team leader on the programme and an admin enrol", async () => {
    expect((await enrol(teamLead.headers, w.siteEmployee)).status).toBe(201);
    expect((await enrol(w.admin, w.siteEmployee)).status).toBe(201);
  });

  it("refuses a PM of some other project", async () => {
    const r = await enrol(elsewherePm.headers, w.siteEmployee);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_ON_THIS_PROGRAMME");
    const c = await post(elsewherePm.headers, `/api/v1/survey/villages/${villageB}/crew`,
      { employee_id: w.siteEmployee, stage_code: "GT_QC" });
    expect(c.status, JSON.stringify(c.body)).toBe(403);
  });

  it("refuses an employee who has left", async () => {
    const r = await enrol(w.admin, w.exitedEmployee);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("is a 404 for another organisation", async () => {
    expect((await enrol(w.other.admin, w.other.employee)).status).toBe(404);
  });
});

/*
 * SV-025 (round 4): the owner's staffing rule on the two bulk ways onto a
 * crew. start-gt and crew/bulk never asked mayStaffProgramme, so a PM of
 * another project holding org-wide survey.manage was refused on the single
 * crew route and let through on these. And a team leader staffs only the
 * programmes they are on (SV-026), not every one.
 */
describe("SV-025 / SV-026 staffing through the bulk routes", () => {
  let fresh: string;
  let otherProgramme: string;
  let otherVillage: string;
  let freeEmployee: string;
  const newVillage = async (programme: string) => String((await post(w.admin,
    `/api/v1/survey/projects/${programme}/villages`,
    { village_name: uniq("Staff"), village_code: uniq("SF"), mandal_id: mandalId, total_extent_ac: 5 })).data.id);

  beforeAll(async () => {
    fresh = await newVillage(programmeId);
    freeEmployee = (await person(["EMPLOYEE"])).employeeId;
    const p = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("OTH"), name: "Somebody else's programme", create_project: false });
    otherProgramme = String(p.data.id);
    otherVillage = await newVillage(otherProgramme);
  });

  const startGt = (h: Headers, village: string) => post(h, `/api/v1/survey/villages/${village}/start-gt`, {
    started_on: workDate(), expected_end_on: workDate(), employee_ids: [freeEmployee],
    govt_staff_allocated: 1, crew_allocated: 1,
  });
  const bulk = (h: Headers, village: string) => post(h, `/api/v1/survey/villages/${village}/crew/bulk`,
    { employee_ids: [freeEmployee], stage_code: "GT_QC" });

  it("refuses another project's PM on start-gt and crew/bulk", async () => {
    for (const r of [await startGt(elsewherePm.headers, fresh), await bulk(elsewherePm.headers, fresh)]) {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe("NOT_ON_THIS_PROGRAMME");
    }
    const crew = await send("GET", w.admin, `/api/v1/survey/villages/${fresh}/crew`);
    expect(crew.data).toEqual([]);
  });

  it("lets the project's own PM do both", async () => {
    expect((await bulk(ownPm.headers, fresh)).status).toBe(201);
    const r = await startGt(ownPm.headers, fresh);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("confines a team leader with oversight to the programmes they are on", async () => {
    // TEAM_LEAD + AUDITOR: survey.forecast makes every programme visible,
    // which is exactly how a TL used to staff programmes they are not on.
    const tlAuditor = await person(["TEAM_LEAD", "AUDITOR"]);
    await joinProgramme(w.pool, w.orgId, tlAuditor.userId, programmeId, "TEAM_LEAD");
    const own = await post(tlAuditor.headers, `/api/v1/survey/projects/${programmeId}/employees`,
      { employee_id: freeEmployee, project_role: "GT_USER" });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const theirs = await post(tlAuditor.headers, `/api/v1/survey/projects/${otherProgramme}/employees`,
      { employee_id: freeEmployee, project_role: "GT_USER" });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(403);
    expect(theirs.body.code).toBe("NOT_ON_THIS_PROGRAMME");
    const crew = await post(tlAuditor.headers, `/api/v1/survey/villages/${otherVillage}/crew`,
      { employee_id: freeEmployee, stage_code: "GT_QC" });
    expect([403, 404]).toContain(crew.status);
  });
});

/*
 * SV-027 (round 5): every write that changes who, or what kit, is on a
 * programme applies the owner's staffing rule -- releasing a crew member,
 * allocating, correcting, releasing or claiming a rover, and moving villages
 * between programmes. Each was guarded by survey.manage alone, which another
 * project's PM holds organisation-wide.
 */
describe("SV-027 the staffing rule on releases, rovers and moves", () => {
  let village: string;
  let crewRowId: string;
  let asset: string;
  let allocationId: string;
  let target: string;

  beforeAll(async () => {
    village = String((await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
      { village_name: uniq("Rel"), village_code: uniq("RL"), mandal_id: mandalId, total_extent_ac: 5 })).data.id);
    const who = await person(["EMPLOYEE"]);
    const c = await post(w.admin, `/api/v1/survey/villages/${village}/crew`,
      { employee_id: who.employeeId, stage_code: "GROUND_TRUTHING" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    crewRowId = String(c.data.id);
    asset = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,'Rule rover','SURVEY','AVAILABLE','GOOD') RETURNING id`,
      [w.orgId, uniq("RR")])).rows[0].id);
    const a = await post(w.admin, `/api/v1/survey/villages/${village}/rovers`,
      { asset_id: asset, allocated_on: workDate() });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    allocationId = String(a.data.id);
    target = String((await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("TGT"), name: "Move target", create_project: false })).data.id);
  });

  const crewRow = async () => (await w.pool.query(
    "SELECT released_on FROM survey_crew WHERE id = $1", [crewRowId])).rows[0];
  const allocation = async () => (await w.pool.query(
    "SELECT allocated_on::text, released_on::text FROM survey_rover_allocations WHERE id = $1", [allocationId])).rows[0];

  it("refuses another project's PM releasing a crew member, and changes nothing", async () => {
    const r = await post(elsewherePm.headers, `/api/v1/survey/crew/${crewRowId}/release`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_ON_THIS_PROGRAMME");
    expect((await crewRow()).released_on).toBeNull();
  });

  it("refuses another project's PM on every rover write", async () => {
    const before = await allocation();
    const h = elsewherePm.headers;
    const other = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,'Other rover','SURVEY','AVAILABLE','GOOD') RETURNING id`,
      [w.orgId, uniq("OR")])).rows[0].id);
    const tries = [
      await post(h, `/api/v1/survey/villages/${village}/rovers`, { asset_id: other, allocated_on: workDate() }),
      await post(h, `/api/v1/survey/villages/${village}/rovers/bulk`, { asset_ids: [other], allocated_on: workDate() }),
      await post(h, `/api/v1/survey/villages/${village}/rovers/claim`, { asset_ids: [asset] }),
      await send("PATCH", h, `/api/v1/survey/rovers/${allocationId}`, { released_on: workDate() }),
      await post(h, `/api/v1/survey/rovers/${allocationId}/release`, {}),
    ];
    for (const r of tries) {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe("NOT_ON_THIS_PROGRAMME");
    }
    expect(await allocation()).toEqual(before);
  });

  it("refuses another project's PM moving villages out of the programme", async () => {
    const r = await post(elsewherePm.headers, `/api/v1/survey/projects/${programmeId}/villages/move`,
      { village_ids: [village], to_project_id: target });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_ON_THIS_PROGRAMME");
  });

  it("lets the project's own PM release the crew member and the rover", async () => {
    const rel = await post(ownPm.headers, `/api/v1/survey/crew/${crewRowId}/release`, {});
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect((await crewRow()).released_on).not.toBeNull();
    const rov = await post(ownPm.headers, `/api/v1/survey/rovers/${allocationId}/release`, {});
    expect(rov.status, JSON.stringify(rov.body)).toBe(200);
  });

  it("is a 404 for another organisation", async () => {
    expect((await post(w.other.admin, `/api/v1/survey/crew/${crewRowId}/release`, {})).status).toBe(404);
    expect((await post(w.other.admin, `/api/v1/survey/rovers/${allocationId}/release`, {})).status).toBe(404);
  });
});

// Build the survey deep-QA fixture on live (idempotent: looks everything up
// by its QA-SVD- code before creating it). Writes ~/sl-e2e/qa-survey.json
// with ids only, no secrets.
//
//   cd ~/sl-e2e/svd && node fixture.mjs
//
// Shape:
//   programme QA-SVD (PM-created, paired project)
//   V1 QA-SVD-V1  512.5 ac  mandal 1  crew A: qa-mob-employee + qa-survey-surveyor (GT)  2 rovers + mob's issued kit, 2 GCPs, targets
//   V2 QA-SVD-V2 1200 ac    mandal 1  crew B: qa-survey-surveyor2 + QA-EMP-BRAVO (GT)    1 rover
//   V3 QA-SVD-V3  88.25 ac  mandal 2  not started
import { readFileSync } from "node:fs";
import { as, data, today, fixture, saveFixture, dataset, employeeIdOf } from "./lib.mjs";

const F = fixture();
const D = dataset();
const S = JSON.parse(readFileSync(`${process.env.HOME}/sl-e2e/survey/.qa-data.json`, "utf8"));
const PM = "qa-admin-pm", INV = "qa-admin-inventory";
const must = (r, ok, label) => {
  if (!ok.includes(r.status)) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  return data(r);
};
const find = async (who, path, pred) => (data(await as(who, "GET", path)) ?? []).find(pred);

// Programme
let prog = await find(PM, "/survey/projects?limit=100", (p) => p.code === "QA-SVD");
if (!prog) {
  prog = must(await as(PM, "POST", "/survey/projects", {
    code: "QA-SVD", name: "QA-SVD Survey deep-QA programme", started_on: today(-30),
    target_completion_on: "2027-06-30", notes: "QA-SVD fixture (survey deep QA). Safe to delete.",
    workspace_id: D.workspaceId,
  }), [201], "programme");
}
F.programmeId = prog.id;
F.pairedProjectId = prog.project_id ?? null;

// Villages
F.villages = F.villages ?? {};
const spec = [
  ["V1", "QA-SVD Alpha-pur", 512.5, "QA-MANDAL-1"],
  ["V2", "QA-SVD Bravo-palem", 1200, "QA-MANDAL-1"],
  ["V3", "QA-SVD Charlie-nagar", 88.25, "QA-MANDAL-2"],
];
const vlist = data(await as(PM, "GET", `/survey/projects/${prog.id}/villages?limit=200`)) ?? [];
for (const [k, name, ac, mandal] of spec) {
  const code = `QA-SVD-${k}`;
  let v = vlist.find((x) => x.village_code === code || x.source_code === code);
  if (!v) {
    v = must(await as(PM, "POST", `/survey/projects/${prog.id}/villages`, {
      village_name: name, village_code: code, mandal_id: D.orgUnits[mandal], total_extent_ac: ac,
      dgps_base: 1, dgps_rovers: 2, teams: 1,
    }), [201], `village ${k}`);
  }
  F.villages[k] = v.id;
}

// People
const mobEmp = employeeIdOf("qa-mob-employee");
F.employees = {
  mob: mobEmp, surveyor: S.employees.surveyor, surveyor2: S.employees.surveyor2,
  bravo: D.employees["QA-EMP-BRAVO"], alpha: D.employees["QA-EMP-ALPHA"],
};
for (const [role, id] of [["GT_USER", mobEmp], ["GT_USER", S.employees.surveyor], ["GT_USER", S.employees.surveyor2]]) {
  const r = await as("qa-admin-admin", "POST", `/survey/projects/${prog.id}/employees`, { employee_id: id, project_role: role });
  if (![200, 201, 409].includes(r.status)) console.log("enrol", id, r.status, JSON.stringify(r.body).slice(0, 200));
}

// Rovers (assets)
F.assets = F.assets ?? {};
const cat = D.assets?.categoryId ? (await find(INV, "/asset-categories?limit=100", (c) => c.id === D.assets.categoryId)) : null;
for (const n of [1, 2, 3, 4]) {
  const code = `QA-SVD-ROVER-${n}`;
  let a = await find(INV, `/assets?limit=100&search=${code}`, (x) => x.asset_code === code)
    ?? await find(INV, "/assets?limit=200", (x) => x.asset_code === code);
  if (!a) {
    a = must(await as(INV, "POST", "/assets", {
      asset_code: code, serial_number: `QA-SVD-SN-${n}`, name: `QA-SVD GNSS rover ${n}`,
      category: cat?.code, asset_type_id: D.assets?.typeId, make: "Trimble", model: "R12i", condition: "GOOD",
    }), [201], `asset ${code}`);
  }
  F.assets[`R${n}`] = a.id;
}
// Rover 4 is issued to qa-mob-employee so it travels with them (carry-kit path).
{
  const a = data(await as(INV, "GET", `/assets/${F.assets.R4}`));
  if (a && ["AVAILABLE", "RETURNED"].includes(a.status)) {
    const r = await as(INV, "POST", `/assets/${F.assets.R4}/assign`,
      { employee_id: mobEmp, reason: "QA-SVD fixture: field kit" }, { "if-match": String(a.version) });
    if (r.status !== 200) console.log("assign R4", r.status, JSON.stringify(r.body).slice(0, 200));
  }
}

// Start GT on V1 and V2 (one action each: crew + dates + staffing)
for (const [k, crew] of [["V1", [mobEmp, S.employees.surveyor]], ["V2", [S.employees.surveyor2, D.employees["QA-EMP-BRAVO"]]]]) {
  const r = await as(PM, "POST", `/survey/villages/${F.villages[k]}/start-gt`, {
    started_on: today(-5), expected_end_on: today(25), employee_ids: crew,
    govt_staff_allocated: 2, crew_allocated: crew.length, remarks: "QA-SVD fixture start",
  });
  if (![201, 409].includes(r.status)) console.log("start-gt", k, r.status, JSON.stringify(r.body).slice(0, 300));
}

// Rover allocations
for (const [k, ids] of [["V1", [F.assets.R1, F.assets.R2]], ["V2", [F.assets.R3]]]) {
  const have = (data(await as(PM, "GET", `/survey/villages/${F.villages[k]}/rovers`)) ?? []).filter((x) => x.out).map((x) => x.asset_id);
  const need = ids.filter((i) => !have.includes(i));
  if (need.length) must(await as(PM, "POST", `/survey/villages/${F.villages[k]}/rovers/bulk`, { asset_ids: need, allocated_on: today(-5) }), [201], `rovers ${k}`);
}

// Targets on V1
for (const [m, q] of [["VILLAGE_BOUNDARY_POINTS", 400], ["GOVT_LAND_PARCELS", 60], ["PRIVATE_LAND_PARCELS", 900], ["RECORDS_PREPARED", 950]]) {
  must(await as(PM, "POST", `/survey/villages/${F.villages.V1}/targets`, { measure_code: m, target_quantity: q }), [200, 201], `target ${m}`);
}

// GCPs on V1
const gcps = data(await as(PM, "GET", `/survey/villages/${F.villages.V1}/gcps`)) ?? [];
F.gcps = {};
for (const [code, lat, lng, el] of [["QA-SVD-GCP-1", 16.523456, 80.612345, 18.4], ["QA-SVD-GCP-2", 16.531111, 80.621111, 21.9]]) {
  let g = gcps.find((x) => x.point_code === code);
  if (!g) g = must(await as(PM, "POST", `/survey/villages/${F.villages.V1}/gcps`, { point_code: code, latitude: lat, longitude: lng, elevation_m: el, landmark: "QA-SVD panchayat office" }), [201], `gcp ${code}`);
  F.gcps[code] = g.id;
}

F.users = {
  crewA: ["qa-mob-employee", "qa-survey-surveyor"], crewB: ["qa-survey-surveyor2"],
  supervisor: "qa-admin-pm", teamLead: "qa-survey-tl", admin: "qa-admin-admin",
  client: "qa-admin-client", govt: "qa-admin-govt",
  note: "Log in with the credential files under ~/sl-e2e; this file carries ids only.",
};
F.builtAt = new Date().toISOString();
saveFixture(F);
console.log(JSON.stringify(F, null, 1));

// Survey deep QA, API probes (lane 1). Run: cd ~/sl-e2e/svd && node probe-api.mjs
// Every line is `ok|BUG|INFO`. Writes nothing outside QA-SVD records.
import { as, data, today, fixture, saveFixture, check, note, brief, dataset } from "./lib.mjs";

const F = fixture();
const D = dataset();
const PM = "qa-admin-pm", ADM = "qa-admin-admin";
const V1 = F.villages.V1, V2 = F.villages.V2, V3 = F.villages.V3;

// ---- 1. Cross-org asset in rovers/bulk (single route checks inOrg, bulk does not)
{
  let a2 = F.org2AssetId;
  if (!a2) {
    let cat = (data(await as("org2", "GET", "/asset-categories?limit=100")) ?? []).find((c) => c.label === "QA-SVD org2 equipment");
    if (!cat) cat = data(await as("org2", "POST", "/asset-categories", { label: "QA-SVD org2 equipment" }));
    const r = await as("org2", "POST", "/assets", { asset_code: "QA-SVD-ORG2-ROVER", serial_number: "QA-SVD-ORG2-SN", name: "QA-SVD org2 rover", condition: "GOOD", category: cat?.code });
    a2 = data(r)?.id;
    note("org2 asset create", brief(r));
    F.org2AssetId = a2; saveFixture(F);
  }
  if (a2) {
    const single = await as(PM, "POST", `/survey/villages/${V3}/rovers`, { asset_id: a2, allocated_on: today(-1) });
    check("single rover allocate refuses another org's asset", [404, 422].includes(single.status), brief(single));
    const bulk = await as(PM, "POST", `/survey/villages/${V3}/rovers/bulk`, { asset_ids: [a2], allocated_on: today(-1) });
    check("bulk rover allocate refuses another org's asset", bulk.status >= 400 || data(bulk)?.allocated === 0, brief(bulk));
    if (bulk.status === 201 && data(bulk)?.allocated) F.leakedAllocation = true;
  }
}

if (!process.env.ONLY_LATE) {
// ---- 2. Release dates that are not dates
{
  const crew = data(await as(PM, "GET", `/survey/villages/${V2}/crew`)) ?? [];
  const bravo = crew.find((c) => c.employee_id === F.employees.bravo && c.active);
  if (bravo) {
    const r = await as(PM, "POST", `/survey/crew/${bravo.id}/release`, { released_on: "not-a-date" });
    check("crew release refuses a non-date with 422, not 500", r.status === 422, brief(r));
    const r2 = await as(PM, "POST", `/survey/crew/${bravo.id}/release`, { released_on: "2001-01-01" });
    check("crew release refuses a date before the assignment", r2.status === 422, brief(r2));
    if (r2.status === 200) {
      // put them back so the fixture stays whole
      await as(PM, "POST", `/survey/villages/${V2}/crew`, { employee_id: F.employees.bravo, stage_code: "GROUND_TRUTHING", assigned_on: today(-5) });
    }
  } else note("crew release probe skipped", "no active bravo crew row");
  const rov = (data(await as(PM, "GET", `/survey/villages/${V2}/rovers`)) ?? []).find((x) => x.out);
  if (rov) {
    const r = await as(PM, "POST", `/survey/rovers/${rov.id}/release`, { released_on: "31/12/2026" });
    check("rover release refuses a non-date with 422, not 500", r.status === 422, brief(r));
    const r2 = await as(PM, "POST", `/survey/rovers/${rov.id}/release`, { released_on: "2001-01-01" });
    check("rover release refuses a date before allocation (not 500)", r2.status === 422 || r2.status === 409, brief(r2));
  }
}

// ---- 3. start-gt: exited employee, kit carry
{
  const exited = D.employees["QA-EMP-EXITED"];
  const r = await as(PM, "POST", `/survey/villages/${V3}/start-gt`, {
    started_on: today(-1), expected_end_on: today(10), employee_ids: [exited], govt_staff_allocated: 1, crew_allocated: 1,
  });
  check("start-gt refuses an EXITED employee", r.status === 422 || r.status === 409, brief(r));
  if (r.status === 201) F.v3StartedWithExited = true;
  const rovers = data(await as(PM, "GET", `/survey/villages/${V1}/rovers`)) ?? [];
  check("start-gt brought the crew's issued kit (R4 issued to qa-mob-employee) to V1",
    rovers.some((x) => x.asset_id === F.assets.R4 && x.out), rovers.map((x) => x.asset_code).join(","));
  const single = await as(PM, "POST", `/survey/villages/${V3}/crew`, { employee_id: exited, stage_code: "GT_QC" });
  check("single crew assign refuses an EXITED employee", single.status >= 400, brief(single));
  if (single.status === 201) await as(PM, "POST", `/survey/crew/${data(single).id}/release`, {});
}
saveFixture(F);

// ---- 4. Stage dates
{
  // V2: GT in progress with started_on today-5. Try completing in the future.
  const fut = await as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: today(30), started_on: today(-5) });
  check("stage completion refuses a completed_on in the future", fut.status === 422, brief(fut));
  if (fut.status === 200) {
    await as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: today(-5) });
  }
  // Completing without resending started_on: does the start date survive?
  const done = await as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: today() });
  const st = data(done);
  check("completing a stage without resending started_on keeps the recorded start", done.status === 200 && st?.started_on === today(-5), `${done.status} started_on=${st?.started_on}`);
  // Completion dated before the recorded start
  const early = await as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: today(-20) });
  check("stage completion dated before the recorded start is refused", early.status === 422, `${brief(early)} started=${data(early)?.started_on}`);
  // restore V2 to GT in progress with its start
  await as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: today(-5) });
  // Skip a stage: GT_QC without GT complete
  const skip = await as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: "VECTORIZATION", state: "IN_PROGRESS", started_on: today() });
  check("skipping ahead (VECTORIZATION while GT open) is STAGE_BLOCKED", skip.status === 422 && skip.body?.code === "STAGE_BLOCKED", brief(skip));
  const bogus = await as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: "<script>alert(1)</script>", state: "IN_PROGRESS" });
  check("unknown stage code 422", bogus.status === 422, brief(bogus));
}

// ---- 5. Village edits
{
  const v = data(await as(PM, "GET", `/survey/villages/${V3}`));
  const clear = await as(PM, "PATCH", `/survey/villages/${V3}`, { total_extent_ac: null }, { "if-match": String(v.version) });
  const after = data(await as(PM, "GET", `/survey/villages/${V3}`));
  check("PATCH village total_extent_ac:null clears it (schema allows null)", after.total_extent_ac === null, `${clear.status} now=${after.total_extent_ac}`);
  if (after.total_extent_ac === null) {
    await as(PM, "PATCH", `/survey/villages/${V3}`, { total_extent_ac: 88.25 }, { "if-match": String(after.version) });
  }
  const big = await as(PM, "PATCH", `/survey/villages/${V3}`, { village_name: "x".repeat(10000) }, { "if-match": String(after.version) });
  check("10k-char village name is 422", big.status === 422, brief(big));
  const rtl = await as(PM, "POST", `/survey/projects/${F.programmeId}/villages`, { village_name: "QA-SVD ‏مرحبا 🚜 <script>x</script>", village_code: "QA-SVD-RTL", mandal_id: D.orgUnits["QA-MANDAL-2"], total_extent_ac: 10 });
  note("village with RTL/emoji/script name", brief(rtl));
  if (data(rtl)?.id) { F.villages.RTL = data(rtl).id; saveFixture(F); }
  const neg = await as(PM, "PATCH", `/survey/villages/${V3}/plan`, { planned_start_on: "2027-01-10", expected_completion_on: "2026-01-01" }, { "if-match": String(after.version) });
  check("plan with expected completion before planned start is refused", neg.status === 422, brief(neg));
}

}
// ---- 6. Programme code clash, twice
{
  const pr = await as(ADM, "GET", `/projects?limit=200`);
  const codes = (Array.isArray(data(pr)) ? data(pr) : []).map((p) => p.code);
  if (!codes.includes("QA-SVD-CLASH")) await as(ADM, "POST", "/projects", { workspace_id: D.workspaceId, code: "QA-SVD-CLASH", name: "QA-SVD clash project" });
  if (!codes.includes("QA-SVD-CLASH-SV")) await as(ADM, "POST", "/projects", { workspace_id: D.workspaceId, code: "QA-SVD-CLASH-SV", name: "QA-SVD clash project SV" });
  const existing = (data(await as(ADM, "GET", "/survey/projects?limit=200")) ?? []).find((p) => p.code === "QA-SVD-CLASH");
  if (!existing) {
    const r = await as(ADM, "POST", "/survey/projects", { code: "QA-SVD-CLASH", name: "QA-SVD clash programme", workspace_id: D.workspaceId });
    check("programme whose code and code-SV are both taken in Projects is created or refused cleanly (not 500)", r.status === 201 || r.status === 409 || r.status === 422, brief(r));
  } else note("clash programme already exists", existing.id);
}

// ---- 7. Cross-crew and cross-org reads
{
  for (const path of [`/survey/villages/${V1}`, `/survey/villages/${V1}/crew`, `/survey/villages/${V1}/daily`, `/survey/villages/${V1}/gcps`, `/survey/villages/${V1}/billing`]) {
    const r = await as("org2", "GET", path);
    check(`org2 admin GET ${path.replace(V1, "V1")} is 404`, r.status === 404, brief(r));
  }
  // qa-survey-surveyor2 is on another programme's village and V2's crew? (fixture puts them on V2)
  const other = await as("qa-survey-surveyor2", "GET", `/survey/villages/${V1}/crew`);
  note("crew B member reads V1 crew list (same programme)", `${other.status} rows=${(data(other) ?? []).length}`);
  const otherEntry = await as("qa-survey-surveyor2", "POST", "/survey/entries", { survey_village_id: V1, entry_date: today(-2), teams_deployed: 1, values: { VILLAGE_BOUNDARY_POINTS: 3 } });
  check("crew B member cannot file a return for crew A's village", otherEntry.status === 403 || otherEntry.status === 404, brief(otherEntry));
  if (otherEntry.status === 201) F.crewBEntryOnV1 = data(otherEntry).id;
  const unk = await as("qa-mob-employee", "POST", "/survey/entries", { survey_village_id: V1, entry_date: today(-3), teams_deployed: 1, values: { NOT_A_MEASURE: 3 } });
  check("M-014 follow-up: crewed user with unknown measure gets 422 UNKNOWN_MEASURE", unk.status === 422 && unk.body?.code === "UNKNOWN_MEASURE", brief(unk));
}
saveFixture(F);

// ---- 8. Billing state machine
{
  const claims = data(await as(PM, "GET", `/survey/billing?project_id=${F.programmeId}`)) ?? [];
  note("QA-SVD claims standing", String(claims.length));
}
console.log("\nSUMMARY", results());
function results() { return ""; }

// Survey deep QA, ladder + billing + finals + observer views (lane 1).
// Walks QA-SVD-V2 up the whole ladder as the PM, claims every milestone, and
// attacks each step. Run: cd ~/sl-e2e/svd && node probe-ladder-billing.mjs
import { as, data, today, fixture, check, note, brief, once, token } from "./lib.mjs";

const F = fixture();
const PM = "qa-admin-pm";
const V2 = F.villages.V2, P = F.programmeId;
const stage = (code, state, extra = {}) => as(PM, "POST", `/survey/villages/${V2}/stage`, { stage_code: code, state, ...extra });
const ladder = async () => data(await as(PM, "GET", `/survey/villages/${V2}`));

// Walk the ladder.
const walk = [["GROUND_TRUTHING", -5, -4], ["GT_QC", -4, -3], ["VECTORIZATION", -3, -2], ["DATA_SUBMISSION", -2, -1], ["FINAL_DELIVERABLES", -1, 0], ["NOTIFICATION", 0, 0]];
// Complete out of order first: NOTIFICATION before FINAL_DELIVERABLES
const early = await stage("NOTIFICATION", "COMPLETED", { started_on: today(), completed_on: today() });
check("completing NOTIFICATION before its prerequisites is refused", early.status === 422, brief(early));
// Milestone 1 before GT_QC is signed off
const m1early = await as(PM, "POST", `/survey/villages/${V2}/billing`, { milestone: 1 });
check("milestone 1 before GT QC is refused MILESTONE_NOT_EARNED", m1early.status === 422 && m1early.body?.code === "MILESTONE_NOT_EARNED", brief(m1early));

for (const [code, s, c] of walk) {
  const a = await stage(code, "IN_PROGRESS", { started_on: today(s) });
  const b = await stage(code, "COMPLETED", { started_on: today(s), completed_on: today(c) });
  check(`walk ${code}: in progress then completed`, a.status === 200 && b.status === 200, `${brief(a)} | ${brief(b)}`);
}
const top = await ladder();
note("V2 after walk", `status=${top.status} state=${top.state}`);

// Going backwards: reopen GT after the top. Position must stay at the front of the work.
const back = await stage("GROUND_TRUTHING", "IN_PROGRESS", { started_on: today(-5) });
const dash = data(await as(PM, "GET", `/survey/projects/${P}/dashboard`));
note("reopen GT after notification", `${back.status} dashboard keys=${Object.keys(dash ?? {}).join(",").slice(0, 200)}`);
await stage("GROUND_TRUTHING", "COMPLETED", { started_on: today(-5), completed_on: today(-4) });

// Milestones: claim 1,2,3 then attack.
const m2first = await as(PM, "POST", `/survey/villages/${V2}/billing`, { milestone: 2 });
check("milestone 2 before milestone 1 is MILESTONE_OUT_OF_ORDER", m2first.status === 422 && m2first.body?.code === "MILESTONE_OUT_OF_ORDER", brief(m2first));
// Concurrent double claim of milestone 1
const [c1, c2] = await Promise.all([1, 2].map(() => as(PM, "POST", `/survey/villages/${V2}/billing`, { milestone: 1, reference_no: "QA-SVD-M1", extent_ac: 1200 })));
check("two concurrent milestone-1 claims: exactly one 201", [c1.status, c2.status].filter((s) => s === 201).length === 1, `${c1.status} ${c2.status} ${brief(c1.status === 201 ? c2 : c1)}`);
const over = await as(PM, "POST", `/survey/villages/${V2}/billing`, { milestone: 2, percent: 60 });
check("claim taking the village past 100% is refused", over.status === 422 && over.body?.code === "CLAIMED_OVER_100", brief(over));
const m2 = await as(PM, "POST", `/survey/villages/${V2}/billing`, { milestone: 2, submitted_on: today(), extent_ac: 1200 });
const m3 = await as(PM, "POST", `/survey/villages/${V2}/billing`, { milestone: 3, submitted_on: today() });
check("milestones 2 and 3 claimable after the full ladder", m2.status === 201 && m3.status === 201, `${brief(m2)} | ${brief(m3)}`);
const fut = await as(PM, "POST", `/survey/villages/${V2}/billing`, { milestone: 4, percent: 0.01, submitted_on: today(3) });
check("a forward-dated claim is refused", fut.status === 422, brief(fut));
const bill = data(await as(PM, "GET", `/survey/villages/${V2}/billing`));
const b = await as(PM, "GET", `/survey/villages/${V2}/billing`);
check("claimed_percent is exactly 100 after 50+30+20", b.body?.meta?.claimed_percent === 100, JSON.stringify(b.body?.meta));
const m1 = bill.find((x) => x.milestone === 1);
// Decide M1 PAID, then try to walk it back to SUBMITTED.
const paid = await as(PM, "PATCH", `/survey/billing/${m1.id}`, { status: "PAID", decided_on: today() }, { "if-match": String(m1.version) });
check("M1 SUBMITTED -> PAID", paid.status === 200, brief(paid));
const undo = await as(PM, "PATCH", `/survey/billing/${m1.id}`, { status: "SUBMITTED", decided_on: null }, { "if-match": String(data(paid)?.version) });
check("a PAID claim cannot be put back to SUBMITTED", undo.status >= 400, brief(undo));
const cur = (data(await as(PM, "GET", `/survey/villages/${V2}/billing`))).find((x) => x.milestone === 1);
const rej = await as(PM, "PATCH", `/survey/billing/${cur.id}`, { status: "REJECTED", decided_on: today() }, { "if-match": String(cur.version) });
check("a PAID claim cannot be marked returned", rej.status >= 400, brief(rej));
const cur2 = (data(await as(PM, "GET", `/survey/villages/${V2}/billing`))).find((x) => x.milestone === 1);
const early2 = await as(PM, "PATCH", `/survey/billing/${cur2.id}`, { decided_on: "2020-01-01" }, { "if-match": String(cur2.version) });
check("a decision dated before the claim was submitted is refused", early2.status === 422, brief(early2));
const cur3 = (data(await as(PM, "GET", `/survey/villages/${V2}/billing`))).find((x) => x.milestone === 1);
const del1 = await as(PM, "DELETE", `/survey/billing/${cur3.id}`);
check("deleting milestone 1 while 2 and 3 stand is refused", del1.status >= 400, brief(del1));
const bulk = await as(PM, "POST", `/survey/billing/bulk`, { survey_village_ids: [V2, F.villages.V1], action: "SUBMIT", milestone: 1, dry_run: true });
note("bulk dry-run M1 on V2+V1", JSON.stringify(data(bulk)).slice(0, 300));

// Certified totals
const fin0 = await as(PM, "PUT", `/survey/villages/${F.villages.V3}/finals`, { finals: [{ measure_code: "VILLAGE_BOUNDARY_POINTS", quantity: 10, reason: "recount" }] });
check("certifying a village with nothing finished is refused", fin0.status === 422, brief(fin0));
const [f1, f2] = await Promise.all([11, 12].map((q) => as(PM, "PUT", `/survey/villages/${V2}/finals`, { finals: [{ measure_code: "PRIVATE_LAND_EXTENT_AC", quantity: q + 0.005, reason: "QA-SVD recount at handover" }] })));
const fins = data(await as(PM, "GET", `/survey/villages/${V2}/finals`));
const pe = fins.find((x) => x.code === "PRIVATE_LAND_EXTENT_AC");
note("concurrent certification", `${f1.status} ${f2.status} -> certified=${pe?.certified} version=${pe?.version} diff=${pe?.difference}`);
const fneg = await as(PM, "PUT", `/survey/villages/${V2}/finals`, { finals: [{ measure_code: "PRIVATE_LAND_EXTENT_AC", quantity: -5, reason: "neg" }] });
check("negative certified figure is refused", fneg.status === 422, brief(fneg));
const fbad = await as(PM, "PUT", `/survey/villages/${V2}/finals`, { finals: [{ measure_code: "NOPE", quantity: 1, reason: "bad code" }] });
check("unknown measure on finals is 422", fbad.status === 422, brief(fbad));

// Observer views
for (const who of ["qa-admin-govt", "qa-admin-client", "qa-survey-govt", "qa-survey-client"]) {
  let t; try { t = await token(who); } catch (e) { note(`${who} login`, String(e).slice(0, 120)); continue; }
  const list = await once("GET", "/survey/dashboard/projects", undefined, t);
  const ids = (data(list) ?? []).map((p) => p.id);
  note(`${who} dashboard programmes`, `${list.status} n=${ids.length} QA-SVD=${ids.includes(P)}`);
  const d = await once("GET", `/survey/projects/${P}/dashboard`, undefined, t);
  const txt = JSON.stringify(d.body);
  const bad = ["holders", "earned_milestones", "claimed_percent", "claimed_milestones", "percent\"", "employee", "rover", "asset", "Alpha-pur\",\"holder"].filter((k) => txt.includes(k));
  check(`${who} project dashboard has no crew/money/equipment keys`, d.status !== 200 || bad.length === 0, `${d.status} leaked=${bad.join(",")}`);
  for (const path of [`/survey/villages/${V2}`, `/survey/villages/${V2}/crew`, `/survey/villages/${V2}/billing`, `/survey/billing?project_id=${P}`, `/survey/projects/${P}/report`, `/survey/projects/${P}/progress`, `/survey/entries?survey_project_id=${P}`]) {
    const r = await once("GET", path, undefined, t);
    const leaked = r.status === 200 && JSON.stringify(r.body).length > 30 && !/"data":\[\]/.test(JSON.stringify(r.body));
    check(`${who} GET ${path.replace(V2, "V2").replace(P, "P")} returns no staff data`, !leaked, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  const q = await once("POST", `/survey/projects/${P}/queries`, { kind: "QUESTION", subject: "QA-SVD <script>alert(1)</script> 🚜 مرحبا", body: "x".repeat(5000), survey_village_id: V2 }, t, { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" });
  note(`${who} raise query (5k body, script, emoji, RTL)`, brief(q));
}

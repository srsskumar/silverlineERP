// Survey deep QA, daily returns (lane 1): double submit, offline replay by
// idempotency key, amendments across crews, rover ownership.
//   cd ~/sl-e2e/svd && node probe-entries.mjs
import { randomUUID } from "node:crypto";
import { as, data, today, fixture, check, note, brief } from "./lib.mjs";
const F = fixture();
const V1 = F.villages.V1, V3 = F.villages.V3;
const body = (d, extra = {}) => ({ survey_village_id: V1, entry_date: d, teams_deployed: 1, crew_present: 2, govt_staff_present: 1, values: { VILLAGE_BOUNDARY_POINTS: 12, PRIVATE_LAND_EXTENT_AC: 40.1234 }, low_progress_reason: null, ...extra });

// Find a free past date on V1.
const daily = data(await as("qa-admin-pm", "GET", `/survey/villages/${V1}/daily?limit=200`));
const taken = new Set((daily?.days ?? daily?.rows ?? daily ?? []).map?.((r) => r.entry_date) ?? []);
let d = null; for (let i = 1; i < 60 && !d; i++) if (!taken.has(today(-i))) d = today(-i);
note("free date on V1", `${d} (taken=${taken.size})`);

// Double submit in parallel with different keys: exactly one lands.
const [a, b] = await Promise.all([1, 2].map(() => as("qa-mob-employee", "POST", "/survey/entries", body(d))));
check("two parallel returns for one village-day: exactly one 201", [a.status, b.status].filter((s) => s === 201).length === 1, `${a.status} ${b.status} ${brief(a.status === 201 ? b : a)}`);

// Offline replay: the same idempotency key twice returns the same entry, not a 409.
let d2 = null; for (let i = 1; i < 60 && !d2; i++) if (!taken.has(today(-i)) && today(-i) !== d) d2 = today(-i);
const key = randomUUID();
const r1 = await as("qa-mob-employee", "POST", "/survey/entries", body(d2), { "idempotency-key": key });
const r2 = await as("qa-mob-employee", "POST", "/survey/entries", body(d2), { "idempotency-key": key });
check("offline replay with the same idempotency key is answered, not refused", r1.status === 201 && [200, 201].includes(r2.status) && data(r2)?.id === data(r1)?.id, `${r1.status} ${r2.status} ${brief(r2)}`);
const r3 = await as("qa-mob-employee", "POST", "/survey/entries", body(d2, { teams_deployed: 3 }), { "idempotency-key": key });
note("same key, different body", brief(r3));

// Paisa-level: quantity round trip
const back = data(await as("qa-admin-pm", "GET", `/survey/entries?survey_project_id=${F.programmeId}&limit=200`)) ?? [];
const e1 = back.find((x) => x.id === data(r1)?.id);
note("entry read back", JSON.stringify(e1 ?? {}).slice(0, 300));

// Another crew amends crew A's past entry / today's entry
const ent = data(r1);
if (ent) {
  const p = await as("qa-survey-surveyor2", "PATCH", `/survey/entries/${ent.id}`, { notes: "tampered" }, { "if-match": String(ent.version) });
  check("crew B cannot amend crew A's return", [403, 404].includes(p.status), brief(p));
  const p2 = await as("qa-survey-surveyor", "PATCH", `/survey/entries/${ent.id}`, { notes: "past day" }, { "if-match": String(ent.version) });
  check("crew A colleague cannot amend a past day (PAST_DAY_AMENDMENT)", p2.status === 403, brief(p2));
}
// Rover not yours
const rov = await as("qa-mob-employee", "POST", "/survey/entries", body(today(-59), { rovers: [{ asset_id: F.assets.R1, status: "UTILIZED" }] }));
check("reporting a rover that is not issued to you is ROVER_NOT_YOURS", rov.status === 403, brief(rov));
// A village the crew is not on (V3) by the mobile user
const v3 = await as("qa-mob-employee", "POST", "/survey/entries", { ...body(today(-58)), survey_village_id: V3 });
note("mob user files V3 (same programme, not crewed)", brief(v3));

// Task 5d item 6: the adversarial sweep the prior mobile-deep pass left
// undone -- attendance punch payloads, task evidence upload attacks, and
// survey entry payloads -- against the live dev-thor API. Never prints
// passwords/tokens (only status/code/field_errors/ids), same discipline as
// probe-reads.mjs/probe-writes.mjs.
import { readFileSync } from "node:fs";
import { authenticator } from "otplib";

const API = process.env.API ?? "http://127.0.0.1/api/v1";
const HOME = process.env.HOME;
const mob = JSON.parse(readFileSync(`${HOME}/sl-e2e/mobile/.qa-users.json`, "utf8"));
const dataset = JSON.parse(readFileSync(`${HOME}/sl-e2e/qa-dataset.json`, "utf8"));
const org2 = JSON.parse(readFileSync(`${HOME}/sl-e2e/admin/.qa-org2.json`, "utf8"));

async function login(username, password, secret) {
  let r = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  let j = await r.json();
  if (r.status === 200 && j.mfa_required) {
    if (!secret) throw new Error(`${username}: MFA required, no secret provided`);
    r = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password, totp_code: authenticator.generate(secret) }),
    });
    j = await r.json();
  }
  if (r.status !== 200 || !j.access_token) throw new Error(`${username} login failed: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

async function call(method, token, path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  // Some routes (POST /tasks) return the created row bare, others wrap it in
  // {data: ...} -- tolerate both rather than assuming one envelope.
  const item = j && typeof j === "object" && "data" in j ? j.data : j;
  return { status: r.status, code: j?.code, message: j?.message, field_errors: j?.field_errors, id: item?.id };
}
const post = (token, path, body, headers) => call("POST", token, path, body, headers);

function log(label, result) {
  console.log(label, JSON.stringify(result));
}

const empToken = await login("qa-mob-employee", mob["qa-mob-employee"].password);
const employeeId = mob["qa-mob-employee"].employee_id;
const projectId = dataset.projects["QA-SEED-ACTIVE"];

console.log("\n=== A. Attendance punch payload sweep (POST /attendance/events) ===");

const base = (overrides = {}) => ({
  employee_id: employeeId,
  event_type: "CHECK_IN",
  client_timestamp: new Date().toISOString(),
  device_id: "qa-adversarial-probe",
  app_version: "mobile/1.0.0-qa",
  ...overrides,
});

// A1. Out-of-range latitude/longitude.
log("A1 latitude=999 (out of range)", await post(empToken, "/attendance/events", base({ latitude: 999, longitude: 10, mock_location: false })));
log("A1 longitude=-999 (out of range)", await post(empToken, "/attendance/events", base({ latitude: 10, longitude: -999, mock_location: false })));

// A2. Wrong type (string instead of number) -- must not 500.
log("A2 latitude as string", await post(empToken, "/attendance/events", { ...base({ mock_location: false }), latitude: "not-a-number", longitude: 10 }));

// A3. Huge/NaN-shaped values that survive JSON (Infinity is not valid JSON, so this probes a huge finite number).
log("A3 latitude=1e308 (huge finite)", await post(empToken, "/attendance/events", base({ latitude: 1e308, longitude: 10, mock_location: false })));

// A4. latitude given without longitude (refine: must be provided together).
log("A4 latitude only, no longitude", await post(empToken, "/attendance/events", { ...base({ mock_location: false }), latitude: 16.5 }));

const idem = () => ({ "idempotency-key": crypto.randomUUID() });

// A5. Future timestamp beyond the 5-minute tolerance -> 422 FUTURE_PUNCH.
const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
log("A5 client_timestamp 30 min in the future", await post(empToken, "/attendance/events", base({ client_timestamp: future, event_type: "CHECK_OUT", mock_location: false }), idem()));

// A6. Past timestamp beyond the 15-minute skew window -> 202 REQUIRES_REVIEW TIMESTAMP_SKEW.
const past = new Date(Date.now() - 45 * 60 * 1000).toISOString();
log("A6 client_timestamp 45 min in the past", await post(empToken, "/attendance/events", base({ client_timestamp: past, event_type: "CHECK_OUT", mock_location: false }), idem()));

// A7. mock_location: true -> 202 REQUIRES_REVIEW MOCK_LOCATION.
log("A7 mock_location=true", await post(empToken, "/attendance/events", base({ latitude: 16.5, longitude: 80.6, mock_location: true, event_type: "CHECK_OUT" }), idem()));

// A8. Replay: identical (employee_id, event_type) inside the 5-minute dedup
// window, with a FRESH Idempotency-Key each time -- the server's own
// suppression is by (employee, event_type, time), not the idempotency key.
const dupTs = new Date().toISOString();
const dupBody = base({ client_timestamp: dupTs, event_type: "CHECK_IN", latitude: 16.5, longitude: 80.6, mock_location: false });
log("A8a replay first", await post(empToken, "/attendance/events", dupBody, { "idempotency-key": crypto.randomUUID() }));
log("A8b replay second (same employee+event_type, fresh key)", await post(empToken, "/attendance/events", { ...dupBody, client_timestamp: new Date().toISOString() }, { "idempotency-key": crypto.randomUUID() }));

console.log("\n=== B. Task evidence upload attacks (POST /tasks/:id/evidence) ===");

// self-assign: a task created with no assignee is one an EMPLOYEE without
// task.assign then cannot act on at all (PRD §4 self-service rule) -- found
// live during this sweep and fixed in app/(tabs)/tasks.tsx's quickAdd().
// Mirrored here so B1-B6 attack the evidence route itself, not that gate.
const ownTask = await post(empToken, "/tasks", { project_id: projectId, title: "QA- adversarial evidence probe", assignee_id: mob["qa-mob-employee"].user_id });
log("B0 create own-org task (self-assigned)", { status: ownTask.status, id: ownTask.id });
const taskId = ownTask.id;

const smallPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
).toString("base64");

if (taskId) {
  // B1. Disallowed extension (.exe).
  log("B1 file_name=evil.exe", await post(empToken, `/tasks/${taskId}/evidence`, { evidence_type: "SITE_PHOTO", file_name: "evil.exe", content_base64: smallPng }));

  // B2. Double-extension trick -- last extension still governs.
  log("B2 file_name=photo.jpg.exe", await post(empToken, `/tasks/${taskId}/evidence`, { evidence_type: "SITE_PHOTO", file_name: "photo.jpg.exe", content_base64: smallPng }));

  // B3. No extension at all.
  log("B3 file_name=noextension", await post(empToken, `/tasks/${taskId}/evidence`, { evidence_type: "SITE_PHOTO", file_name: "noextension", content_base64: smallPng }));

  // B4. Oversized payload (>5MB decoded).
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1024, 1).toString("base64");
  log("B4 content_base64 > 5MB", await post(empToken, `/tasks/${taskId}/evidence`, { evidence_type: "SITE_PHOTO", file_name: "big.jpg", content_base64: oversized }));

  // B5. Malformed base64 -- must not 500.
  log("B5 malformed base64", await post(empToken, `/tasks/${taskId}/evidence`, { evidence_type: "SITE_PHOTO", file_name: "bad.jpg", content_base64: "***not-base64***" }));

  // B6. Valid upload -- confirms the happy path still works alongside the attacks.
  log("B6 valid jpg upload", await post(empToken, `/tasks/${taskId}/evidence`, { evidence_type: "SITE_PHOTO", file_name: "ok.png", content_base64: smallPng }));
}

// B7. Cross-org task id: create a task in org2 as its admin, then attack it
// with org1's qa-mob-employee token.
try {
  const org2Token = await login(org2.username, org2.password, org2.mfa_secret);
  const org2Task = await post(org2Token, "/tasks", { project_id: dataset.org2.projectId, title: "QA-ORG2 cross-org probe task" });
  log("B7a create org2 task (as org2 admin)", { status: org2Task.status, id: org2Task.id });
  const org2TaskId = org2Task.id;
  if (org2TaskId) {
    log("B7b org1 employee token uploads evidence to org2's task", await post(empToken, `/tasks/${org2TaskId}/evidence`, { evidence_type: "SITE_PHOTO", file_name: "cross-org.png", content_base64: smallPng }));
  }
} catch (e) {
  console.log("B7 org2 setup failed:", e.message);
}

// B8. Well-formed but nonexistent task id (never seeded, syntactically valid).
log("B8 nonexistent task id", await post(empToken, "/tasks/00000000-0000-4000-8000-000000000000/evidence", { evidence_type: "SITE_PHOTO", file_name: "ghost.png", content_base64: smallPng }));

console.log("\n=== C. Survey daily-entry attacks (POST /survey/entries) ===");

const villageId = dataset.surveyVillageId;

// C1. Future entry_date (pastDate schema: must not be after today, Asia/Kolkata).
const futureDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
log("C1 entry_date in the future", await post(empToken, "/survey/entries", { survey_village_id: villageId, entry_date: futureDate, values: {} }));

// C2. Negative headcount.
log("C2 crew_present negative", await post(empToken, "/survey/entries", { survey_village_id: villageId, entry_date: "2026-01-05", crew_present: -3, values: {} }));

// C3. Unknown measure code.
log("C3 unknown measure code", await post(empToken, "/survey/entries", { survey_village_id: villageId, entry_date: "2026-01-06", values: { NOT_A_REAL_MEASURE: 5 } }));

// C4. Oversized quantity value (finite but absurd).
log("C4 absurdly large quantity", await post(empToken, "/survey/entries", { survey_village_id: villageId, entry_date: "2026-01-07", values: { AREA_COVERED: 99999999999999 } }));

// C5. Invalid low_progress_reason enum value.
log("C5 invalid low_progress_reason", await post(empToken, "/survey/entries", { survey_village_id: villageId, entry_date: "2026-01-08", low_progress_reason: "BECAUSE_I_SAID_SO", values: {} }));

// C6. Nonexistent survey_village_id (well-formed UUID, never seeded).
log("C6 nonexistent survey_village_id", await post(empToken, "/survey/entries", { survey_village_id: "00000000-0000-4000-8000-000000000001", entry_date: "2026-01-09", values: {} }));

console.log("\nDone.");

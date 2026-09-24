// Live write-path attack probes for mobile-reachable endpoints. Companion to
// probe-reads.mjs. Never prints passwords/tokens (only status/code/ids).
import { readFileSync } from "node:fs";
import { authenticator } from "otplib";

const API = process.env.API ?? "http://127.0.0.1/api/v1";
const admins = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/admin/.qa-users.json", "utf8"));
const mob = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/mobile/.qa-users.json", "utf8"));

async function login(username, password, secret) {
  let r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  let j = await r.json();
  if (r.status === 200 && j.mfa_required) {
    if (!secret) throw new Error(`${username}: MFA required, no secret`);
    r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, totp_code: authenticator.generate(secret) }) });
    j = await r.json();
  }
  if (r.status !== 200) throw new Error(`${username} login failed: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

async function post(token, path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, code: j?.code, message: j?.message, field_errors: j?.field_errors };
}
async function patch(token, path, body) {
  const r = await fetch(`${API}${path}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, code: j?.code, message: j?.message, field_errors: j?.field_errors };
}

const empToken = await login("qa-mob-employee", mob["qa-mob-employee"].password);

// M-001: multi-field validation error shape — top-level `message` is a fixed
// generic string; the real reason lives in field_errors (mobile screens must
// read fieldErrors, not just message — see src/errorFormat.ts).
console.log("multi-field 422", JSON.stringify(await post(empToken, "/tasks", { project_id: "not-a-uuid", title: "" })));

// M-007: idempotency-key dedup vs a genuine second attempt.
const typesR = await fetch(`${API}/leave/types`, { headers: { authorization: `Bearer ${empToken}` } });
const types = (await typesR.json()).data;
const typeId = types.find((x) => x.is_paid === false)?.id ?? types[0].id;
const key = crypto.randomUUID();
const body = { leave_type_id: typeId, from_date: "2026-12-01", to_date: "2026-12-01", reason: "QA double-tap probe" };
console.log("leave create (key A)", JSON.stringify(await post(empToken, "/leave/requests", body, { "idempotency-key": key })));
console.log("leave replay (same key A)", JSON.stringify(await post(empToken, "/leave/requests", body, { "idempotency-key": key })));
console.log("leave same body (new key)", JSON.stringify(await post(empToken, "/leave/requests", body, { "idempotency-key": crypto.randomUUID() })));

// M-008: preferences schema attacks.
console.log("prefs unrecognised key", JSON.stringify(await patch(empToken, "/auth/preferences", { not_a_real_channel: true })));
console.log("prefs wrong type", JSON.stringify(await patch(empToken, "/auth/preferences", { push: "yes" })));

// M-002 evidence: CLIENT_VIEWER has no employee link / attendance permission.
const client = admins.users["qa-admin-client"];
const clientToken = await login(client.username, client.password, client.mfa_secret);
const r1 = await fetch(`${API}/attendance/me?limit=5`, { headers: { authorization: `Bearer ${clientToken}` } });
console.log("CLIENT_VIEWER GET /attendance/me", r1.status, JSON.stringify(await r1.json().catch(() => null)));

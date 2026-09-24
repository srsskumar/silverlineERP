// Shared helpers for the survey deep-QA probes (docs/qa/2026-09-24/findings-survey-deep.md).
//
// Run from ~/sl-e2e/svd on the VM. Credentials are read from the JSON files
// under ~/sl-e2e and are never printed:
//   admin/.qa-users.json   qa-admin-<role> users (TOTP where enrolled)
//   survey/.qa-users.json  qa-survey-* users from the earlier survey round
//   mobile/.qa-users.json  qa-mob-employee
//   admin/.qa-org2.json    org-2 admin (tenant isolation)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { authenticator } from "otplib";

export const API = process.env.API ?? "http://127.0.0.1/api/v1";
const HOME = process.env.HOME;
const J = (p) => JSON.parse(readFileSync(`${HOME}/sl-e2e/${p}`, "utf8"));
const ADMIN = J("admin/.qa-users.json").users;
const SURVEY = J("survey/.qa-users.json");
const MOBILE = J("mobile/.qa-users.json");
const ORG2 = existsSync(`${HOME}/sl-e2e/admin/.qa-org2.json`) ? J("admin/.qa-org2.json") : null;

export const FIXTURE_PATH = `${HOME}/sl-e2e/qa-survey.json`;
export const fixture = () => (existsSync(FIXTURE_PATH) ? JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) : {});
export const saveFixture = (f) => writeFileSync(FIXTURE_PATH, JSON.stringify(f, null, 1));
export const dataset = () => J("qa-dataset.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function creds(name) {
  if (ADMIN[name]) return { username: ADMIN[name].username, password: ADMIN[name].password, secret: ADMIN[name].mfa_secret };
  if (SURVEY[name]) return { username: name, password: SURVEY[name].password, secret: SURVEY[name].totp_secret };
  if (MOBILE[name]) return { username: name, password: MOBILE[name].password, secret: MOBILE[name].totp_secret };
  if (name === "org2" && ORG2) return { username: ORG2.username, password: ORG2.password, secret: ORG2.mfa_secret };
  throw new Error(`no credentials on file for ${name}`);
}
export const employeeIdOf = (name) => SURVEY[name]?.employee_id ?? MOBILE[name]?.employee_id ?? null;

export async function once(method, path, body, token, extra = {}) {
  const headers = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof FormData)) headers["content-type"] = "application/json";
  if (method !== "GET" && !headers["idempotency-key"]) headers["idempotency-key"] = randomUUID();
  const r = await fetch(API + path, {
    method, headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}

export async function raw(method, path, body, token, extra) {
  for (;;) {
    const r = await once(method, path, body, token, extra);
    if (r.status === 429) { await sleep(Number(r.headers.get("retry-after") || 3) * 1000 + 300); continue; }
    return r;
  }
}

const tokens = new Map();
export async function token(name) {
  if (tokens.has(name)) return tokens.get(name);
  const c = creds(name);
  let r = await raw("POST", "/auth/login", { username: c.username, password: c.password });
  if (r.status === 200 && r.body.mfa_required) {
    if (!c.secret) throw new Error(`${name}: MFA required, no secret on file`);
    r = await raw("POST", "/auth/login", { username: c.username, password: c.password, totp_code: authenticator.generate(c.secret) });
  }
  if (r.status !== 200) throw new Error(`login ${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  tokens.set(name, r.body.access_token);
  return r.body.access_token;
}

export async function as(name, method, path, body, extra) {
  return raw(method, path, body, await token(name), extra);
}

export const data = (r) => r.body?.data ?? r.body;
export const today = (offsetDays = 0) => {
  const d = new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
};

// Result log: each probe line is `ok|BUG|INFO label -> status detail`.
export const results = [];
export function check(label, cond, detail = "") {
  const line = `${cond ? "ok  " : "BUG "} ${label}${detail ? " -> " + detail : ""}`;
  results.push(line);
  console.log(line);
  return cond;
}
export function note(label, detail = "") {
  const line = `INFO ${label}${detail ? " -> " + detail : ""}`;
  results.push(line);
  console.log(line);
}
export const brief = (r) => `${r.status} ${JSON.stringify(r.body?.error ?? r.body?.code ?? r.body).slice(0, 220)}`;

// Shared helpers for Task 6 integration probes.
// Never logs passwords or tokens; only status/body summaries.
import { readFileSync } from "node:fs";
import { authenticator } from "otplib";

export const BASE = "http://127.0.0.1";
export const API = `${BASE}/api/v1`;
const DIR = "/home/dev-thor/sl-e2e";

export function loadDataset() {
  return JSON.parse(readFileSync(`${DIR}/qa-dataset.json`, "utf8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Log in as a named qa-admin-* user (admin/.qa-users.json), handling MFA + 429 backoff. */
export async function loginAs(username) {
  const qa = JSON.parse(readFileSync(`${DIR}/admin/.qa-users.json`, "utf8"));
  const u = qa.users[username];
  if (!u) throw new Error(`unknown qa user ${username}`);
  for (;;) {
    const post = (body) =>
      fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let r = await post({ username: u.username, password: u.password });
    if (r.status === 429) {
      const w = Number(r.headers.get("retry-after") || 5);
      await sleep(w * 1000 + 500);
      continue;
    }
    let j = await r.json();
    if (r.status === 200 && j.mfa_required) {
      r = await post({
        username: u.username,
        password: u.password,
        totp_code: authenticator.generate(u.mfa_secret),
      });
      if (r.status === 429) {
        await sleep(6000);
        continue;
      }
      j = await r.json();
      if (r.status === 401 && j.code === "INVALID_MFA_CODE") {
        await sleep(((30 - (Math.floor(Date.now() / 1000) % 30)) * 1000) + 1000);
        continue;
      }
    }
    if (r.status !== 200) throw new Error(`login ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
}

export async function call(tok, method, path, body, extra = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      "idempotency-key": crypto.randomUUID(),
      ...extra,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, headers: r.headers, body: json };
}

export const show = (label, r, n = 900) =>
  console.log(`\n### ${label} -> ${r.status}\n${JSON.stringify(r.body).slice(0, n)}`);

// Mint a fresh access/refresh token pair for each of the given qa-admin-*
// role accounts and write it to .<username>.json (matching crawl.mjs's
// --as convention), all in ~/sl-e2e/post on the VM.
//
// Access tokens expire in 900s (15 min). Mint sessions immediately before
// the crawl/probe that uses them, not all at once up front for a long
// sequential run — a session generated first and used last (e.g. running
// six ~3-minute crawls back to back) will be stale by the time it's used,
// producing a wall of misleading 401s that look like a permission bug but
// are really just an expired token (this happened once during the
// 2026-09-24 post-deploy sweep with qa-admin-auditor — see findings-post.md).
//
//   node gen-role-sessions.mjs qa-admin-hr qa-admin-pm ...
import { readFileSync, writeFileSync } from "node:fs";
import { authenticator } from "otplib";

const BASE = process.env.BASE ?? "http://127.0.0.1";
const qa = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/admin/.qa-users.json", "utf8"));
const roles = process.argv.slice(2);
if (!roles.length) {
  console.error("usage: node gen-role-sessions.mjs <qa-admin-role> [...]");
  process.exit(2);
}

for (const name of roles) {
  const u = qa.users[name];
  if (!u) { console.error(name, "-> unknown qa user"); continue; }
  let r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u.username, password: u.password }),
  });
  let j = await r.json();
  if (r.status === 200 && j.mfa_required) {
    r = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: u.username, password: u.password, totp_code: authenticator.generate(u.mfa_secret) }),
    });
    j = await r.json();
  }
  if (r.status !== 200) { console.error(name, "FAILED", r.status, JSON.stringify(j)); continue; }
  writeFileSync(`.${name}.json`, JSON.stringify(j));
  console.log(name, "ok");
}

// Live GET-shape probe for mobile screens. Reads creds from local files on
// the VM (never prints passwords/tokens). Logs in as several roles and hits
// the endpoints apps/mobile/src/api/endpoints.ts calls, printing status +
// top-level (and one level of nested) keys so a human can diff against the
// TS interfaces in that file.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { authenticator } from "otplib";

const API = process.env.API ?? "http://127.0.0.1/api/v1";
const admins = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/admin/.qa-users.json", "utf8"));
const mob = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/mobile/.qa-users.json", "utf8"));
const ds = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/qa-dataset.json", "utf8"));

async function login(username, password, secret) {
  const body = { username, password };
  let r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = await r.json();
  if (r.status === 200 && j.mfa_required) {
    if (!secret) throw new Error(`${username}: MFA required, no secret`);
    r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, totp_code: authenticator.generate(secret) }) });
    j = await r.json();
  }
  if (r.status !== 200) throw new Error(`${username} login failed: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

const tokens = {};
async function tok(role) {
  if (tokens[role]) return tokens[role];
  if (role === "mob-employee") {
    tokens[role] = await login("qa-mob-employee", mob["qa-mob-employee"].password);
  } else {
    const u = admins.users[role];
    tokens[role] = await login(u.username, u.password, u.mfa_secret);
  }
  return tokens[role];
}

async function get(role, path) {
  const t = await tok(role);
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${t}` } });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

function shape(j, depth = 1) {
  if (j === null || j === undefined) return String(j);
  if (Array.isArray(j)) return `[array len=${j.length}]` + (j[0] ? ` first-keys=${Object.keys(j[0]).slice(0,12).join(",")}` : "");
  if (typeof j === "object") {
    const keys = Object.keys(j);
    let out = `{${keys.join(",")}}`;
    if (depth > 0) {
      for (const k of keys) {
        const v = j[k];
        if (Array.isArray(v)) out += `\n    .${k}=[len=${v.length}]` + (v[0] && typeof v[0]==="object" ? ` item-keys=${Object.keys(v[0]).join(",")}` : "");
      }
    }
    return out;
  }
  return JSON.stringify(j);
}

const checks = [
  ["mob-employee", "/attendance/me?from=2026-09-01&to=2026-09-24&limit=5"],
  ["mob-employee", "/tasks?assignee_me=true&limit=20"],
  ["mob-employee", "/leave/balances"],
  ["mob-employee", "/leave/types"],
  ["mob-employee", "/leave/requests"],
  ["mob-employee", "/notifications?limit=30"],
  ["mob-employee", "/auth/preferences"],
  ["mob-employee", "/employees/me"],
  ["mob-employee", "/projects?limit=100"],
  ["qa-admin-pm", `/projects/${ds.projects["QA-SEED-ACTIVE"]}`],
  ["qa-admin-hr", "/documents?limit=100"],
  ["qa-admin-hr", "/documents/renewals?within_days=60"],
  ["qa-admin-hr", "/employees?limit=50"],
  ["qa-admin-hr", `/employees/${ds.employees["QA-EMP-ALPHA"]}`],
  ["qa-admin-hr", "/holidays?limit=100"],
  ["qa-admin-admin", "/approvals/inbox"],
  ["qa-admin-admin", "/approvals?limit=100&mine=true"],
  ["qa-admin-inventory", "/inventory/items?limit=100"],
  ["qa-admin-inventory", "/inventory/transactions?limit=50"],
  ["qa-admin-inventory", `/assets/movements?limit=50&offset=0`],
  ["qa-admin-pm", "/clients?limit=50"],
  ["qa-admin-pm", `/clients/${ds.crm.clientId}`],
  ["qa-admin-pm", "/leads?limit=50"],
  ["qa-admin-pm", "/leads/pipeline"],
  ["qa-admin-pm", `/leads/${ds.crm.leadId}`],
  ["qa-admin-pm", "/tenders?limit=50&sort=closing"],
  ["qa-admin-pm", `/tenders/${ds.crm.tenderId}`],
  ["qa-admin-pm", `/projects/${ds.projects["QA-SEED-ACTIVE"]}/ra-bills`],
  ["qa-admin-pm", `/ra-bills/${ds.raBillId}`],
  ["qa-admin-payroll", "/ar/ageing"],
  ["qa-admin-payroll", "/ap/ageing"],
  ["qa-admin-pm", "/requisitions?limit=50"],
  ["qa-admin-pm", `/requisitions/${ds.procurement.prId}`],
  ["qa-admin-pm", "/purchase-orders?limit=50"],
  ["qa-admin-pm", `/purchase-orders/${ds.procurement.poId}`],
  ["qa-admin-payroll", "/payroll/runs?limit=20"],
  ["qa-admin-payroll", `/payroll/runs/${ds.payrollRunId}`],
  ["qa-admin-payroll", `/payroll/runs/${ds.payrollRunId}/payslips?limit=50`],
  ["qa-admin-pm", `/cycles?project_id=${ds.projects["QA-SEED-ACTIVE"]}&limit=100`],
  ["qa-admin-admin", "/reports?limit=20"],
  ["qa-admin-inventory", `/assets/movements?limit=50`],
  ["qa-admin-pm", `/analytics/projects/${ds.projects["QA-SEED-ACTIVE"]}`],
  ["qa-admin-pm", `/insights/projects/${ds.projects["QA-SEED-ACTIVE"]}`],
  ["qa-admin-pm", `/automation-rules?project_id=${ds.projects["QA-SEED-ACTIVE"]}`],
  ["qa-admin-hr", `/employees/${ds.employees["QA-EMP-ALPHA"]}`],
];

for (const [role, path] of checks) {
  try {
    const { status, body } = await get(role, path);
    console.log(`\n== ${role} GET ${path}\nstatus=${status} shape=${shape(body)}`);
  } catch (e) {
    console.log(`\n== ${role} GET ${path}\nERROR ${e.message}`);
  }
}

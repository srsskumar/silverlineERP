// Deterministic QA data seed — Task 2 of the full QA sweep.
//
// Idempotent by construction: every section looks its record(s) up by a
// stable QA- code/name/period before creating anything. Run twice; the
// second run must create nothing (see the `created` counter in the summary).
//
// Run from ~/sl-e2e on the VM (reuses admin/.qa-users.json and
// admin/.qa-org2.json for credentials, and otplib for MFA-required roles):
//   node seed-qa.mjs
//
// Writes ~/sl-e2e/qa-dataset.json: every seeded entity's id, keyed by name.
// No secrets are read from or written to that file.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { authenticator } from "otplib";

const API = "http://127.0.0.1/api/v1";
const USERS = JSON.parse(readFileSync("admin/.qa-users.json", "utf8"));
const ORG2_PATH = "admin/.qa-org2.json";
const ORG2 = existsSync(ORG2_PATH) ? JSON.parse(readFileSync(ORG2_PATH, "utf8")) : null;
const DATASET_PATH = "qa-dataset.json";
const state = existsSync(DATASET_PATH) ? JSON.parse(readFileSync(DATASET_PATH, "utf8")) : {};
const findings = [];

let created = 0;
let skipped = 0;
const save = () => writeFileSync(DATASET_PATH, JSON.stringify(state, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (r) => r.body?.data ?? r.body; // POST responses are bare in S1/S4, {data} elsewhere
const list = (r) => r.body?.data ?? []; // GET list responses are always {data:[...]}

async function once(method, path, body, token, extra = {}) {
  const headers = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && !headers["idempotency-key"]) headers["idempotency-key"] = randomUUID();
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}

async function raw(method, path, body, token, extra = {}) {
  for (;;) {
    const r = await once(method, path, body, token, extra);
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after") || 3);
      console.log(`  429 on ${method} ${path}, waiting ${wait}s`);
      await sleep(wait * 1000 + 300);
      continue;
    }
    return r;
  }
}

const sessions = new Map();
async function loginAs(username, password, secret) {
  if (sessions.has(username)) return sessions.get(username);
  let r = await raw("POST", "/auth/login", { username, password });
  if (r.status === 200 && r.body.mfa_required) {
    if (!secret) throw new Error(`${username}: MFA required but no secret on file`);
    // A TOTP code is only valid for ~30s: regenerate it fresh on every retry
    // rather than resending a stale one after a 429 wait.
    for (;;) {
      r = await once("POST", "/auth/login", { username, password, totp_code: authenticator.generate(secret) });
      if (r.status === 429) {
        const wait = Number(r.headers.get("retry-after") || 3);
        console.log(`  429 on POST /auth/login (mfa), waiting ${wait}s`);
        await sleep(wait * 1000 + 300);
        continue;
      }
      break;
    }
  }
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  sessions.set(username, r.body.access_token);
  return r.body.access_token;
}

async function tokenFor(role) {
  const u = USERS.users[role];
  if (!u) throw new Error(`no such qa-admin user in admin/.qa-users.json: ${role}`);
  return loginAs(u.username, u.password, u.mfa_secret);
}

async function call(role, method, path, body, extra) {
  return raw(method, path, body, await tokenFor(role), extra);
}

async function org2Token() {
  if (!ORG2) throw new Error("admin/.qa-org2.json missing — run scripts/qa/bootstrap-org2.mjs first");
  let tok = await loginAs(ORG2.username, ORG2.password, ORG2.mfa_secret);
  if (!ORG2.mfa_secret) {
    const setup = await raw("POST", "/auth/mfa/setup", {}, tok);
    if (setup.status === 200) {
      const verify = await raw("POST", "/auth/mfa/verify", { code: authenticator.generate(setup.body.secret) }, tok);
      if (verify.status === 200) {
        ORG2.mfa_secret = setup.body.secret;
        writeFileSync(ORG2_PATH, JSON.stringify(ORG2, null, 1));
        // Enabling MFA revokes the pre-MFA session; re-login (now with TOTP)
        // to get a token that still works.
        sessions.delete(ORG2.username);
        tok = await loginAs(ORG2.username, ORG2.password, ORG2.mfa_secret);
        console.log("  org2 admin: MFA enrolled, re-authenticated");
      } else {
        findings.push(`org2 admin MFA verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
      }
    } else {
      findings.push(`org2 admin MFA setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
    }
  }
  return tok;
}
async function org2Call(method, path, body, extra) {
  return raw(method, path, body, await org2Token(), extra);
}

function ensure(status, ok, label, r) {
  if (!ok.includes(status)) {
    throw new Error(`${label}: expected ${ok.join("/")}, got ${status} ${JSON.stringify(r).slice(0, 400)}`);
  }
}

async function findOne(role, path, predicate) {
  const r = await call(role, "GET", path);
  return list(r).find(predicate);
}

// ---------------------------------------------------------------------------
// Org units: two full District -> Mandal -> Village -> Site chains
// ---------------------------------------------------------------------------
async function ensureOrgUnit(role, type, code, name, parentId, cache) {
  if (cache[code]) return cache[code];
  const existing = await findOne(role, `/org/units?type=${type}&limit=100`, (u) => u.code === code);
  if (existing) { cache[code] = existing.id; skipped++; return existing.id; }
  const r = await call(role, "POST", "/org/units", { type, code, name, ...(parentId ? { parent_id: parentId } : {}) });
  ensure(r.status, [201], `org unit ${code}`, r.body);
  cache[code] = row(r).id;
  created++;
  return cache[code];
}

async function seedOrgChains() {
  console.log("== org units: two district->mandal->village->site chains ==");
  state.orgUnits = state.orgUnits || {};
  const cache = state.orgUnits;
  const chains = [
    { d: ["QA-DIST-1", "QA-District One"], m: ["QA-MANDAL-1", "QA-Mandal One"], v: ["QA-VILLAGE-1", "QA-Village One"], s: ["QA-SITE-1", "QA-Site One"] },
    { d: ["QA-DIST-2", "QA-District Two"], m: ["QA-MANDAL-2", "QA-Mandal Two"], v: ["QA-VILLAGE-2", "QA-Village Two"], s: ["QA-SITE-2", "QA-Site Two"] },
  ];
  for (const c of chains) {
    const dId = await ensureOrgUnit("qa-admin-admin", "district", c.d[0], c.d[1], undefined, cache);
    const mId = await ensureOrgUnit("qa-admin-admin", "mandal", c.m[0], c.m[1], dId, cache);
    const vId = await ensureOrgUnit("qa-admin-admin", "village", c.v[0], c.v[1], mId, cache);
    await ensureOrgUnit("qa-admin-admin", "site", c.s[0], c.s[1], vId, cache);
  }
  save();
}

// ---------------------------------------------------------------------------
// Employees: two active (one per chain's site), one suspended, one exited
// ---------------------------------------------------------------------------
async function ensureEmployee(empNo, fields) {
  state.employees = state.employees || {};
  if (state.employees[empNo]) return state.employees[empNo];
  const existing = await findOne("qa-admin-hr", `/employees?q=${encodeURIComponent(empNo)}&limit=20`, (e) => e.emp_no === empNo);
  if (existing) { state.employees[empNo] = existing.id; skipped++; save(); return existing.id; }
  const r = await call("qa-admin-hr", "POST", "/employees", { emp_no: empNo, ...fields });
  ensure(r.status, [201], `employee ${empNo}`, r.body);
  const id = row(r).id;
  state.employees[empNo] = id;
  created++;
  save();
  return id;
}

async function activateEmployee(empNo, id) {
  const e = await call("qa-admin-hr", "GET", `/employees/${id}`);
  if (row(e).status === "DRAFT") {
    const r = await call("qa-admin-hr", "POST", `/employees/${id}/activate`, { reason: "QA seed: put on the roster" });
    ensure(r.status, [200], `activate ${empNo}`, r.body);
    created++;
  } else skipped++;
}

async function seedEmployees() {
  console.log("== employees: two active, one suspended, one exited ==");
  const u = state.orgUnits;
  const alpha = await ensureEmployee("QA-EMP-ALPHA", { first_name: "QA-Alpha", last_name: "Active", phone: "+919812340001", date_of_joining: "2026-01-01", designation: "QA Field Engineer", department: "QA", site_id: u["QA-SITE-1"] });
  await activateEmployee("QA-EMP-ALPHA", alpha);
  const bravo = await ensureEmployee("QA-EMP-BRAVO", { first_name: "QA-Bravo", last_name: "Active", phone: "+919812340002", date_of_joining: "2026-01-01", designation: "QA Field Engineer", department: "QA", site_id: u["QA-SITE-2"] });
  await activateEmployee("QA-EMP-BRAVO", bravo);

  const susp = await ensureEmployee("QA-EMP-SUSPENDED", { first_name: "QA-Charlie", last_name: "Suspended", phone: "+919812340003", date_of_joining: "2026-01-01", designation: "QA Field Engineer", department: "QA" });
  await activateEmployee("QA-EMP-SUSPENDED", susp);
  {
    const e = await call("qa-admin-hr", "GET", `/employees/${susp}`);
    if (row(e).status !== "SUSPENDED") {
      const r = await call("qa-admin-hr", "POST", `/employees/${susp}/suspend`, { reason: "QA seed: baseline suspended employee" });
      ensure(r.status, [200], "suspend QA-EMP-SUSPENDED", r.body);
      created++;
    } else skipped++;
  }

  const exited = await ensureEmployee("QA-EMP-EXITED", { first_name: "QA-Delta", last_name: "Exited", phone: "+919812340004", date_of_joining: "2026-01-01", designation: "QA Field Engineer", department: "QA" });
  await activateEmployee("QA-EMP-EXITED", exited);
  {
    const e = await call("qa-admin-hr", "GET", `/employees/${exited}`);
    if (row(e).status !== "EXITED") {
      const r = await call("qa-admin-hr", "POST", `/employees/${exited}/exit`, { exit_date: "2026-09-01", reason: "QA seed: baseline exited employee" });
      ensure(r.status, [200], "exit QA-EMP-EXITED", r.body);
      created++;
    } else skipped++;
  }
  save();
}

// ---------------------------------------------------------------------------
// Leave balances for the two active employees
// ---------------------------------------------------------------------------
async function seedLeaveBalances() {
  console.log("== leave balances ==");
  const types = list(await call("qa-admin-hr", "GET", "/leave/types"));
  const cl = types.find((t) => t.code === "CL");
  if (!cl) { findings.push("GET /leave/types returned no CL leave type — cannot seed leave balances"); return; }
  for (const empNo of ["QA-EMP-ALPHA", "QA-EMP-BRAVO"]) {
    const employee_id = state.employees[empNo];
    const existing = list(await call("qa-admin-hr", "GET", `/leave/balances?employee_id=${employee_id}&period_year=2026`))
      .find((b) => b.leave_type_id === cl.id);
    if (existing && Number(existing.opening_balance) === 12) { skipped++; continue; }
    // POST /leave/balances is an upsert; only called when the balance is missing or differs.
    const r = await call("qa-admin-hr", "POST", "/leave/balances", { employee_id, leave_type_id: cl.id, period_year: 2026, opening_balance: 12 });
    ensure(r.status, [200, 201], `leave balance ${empNo}`, r.body);
    created++;
  }
}

// ---------------------------------------------------------------------------
// Workspace, active project (with a configurable workflow) + inactive project
// ---------------------------------------------------------------------------
async function ensureWorkspace() {
  if (state.workspaceId) return state.workspaceId;
  const found = await findOne("qa-admin-admin", "/workspaces?limit=100", (w) => w.name === "QA-Seed Workspace");
  if (found) { state.workspaceId = found.id; skipped++; save(); return found.id; }
  const r = await call("qa-admin-admin", "POST", "/workspaces", { name: "QA-Seed Workspace", description: "QA-Seed: Task 2 deterministic data. Safe to archive." });
  ensure(r.status, [201], "workspace QA-Seed Workspace", r.body);
  state.workspaceId = row(r).id;
  created++;
  save();
  return state.workspaceId;
}

async function ensureProject(code, name, extra = {}) {
  if (state.projects?.[code]) return state.projects[code];
  state.projects = state.projects || {};
  const found = await findOne("qa-admin-admin", "/projects?limit=100", (p) => p.code === code);
  if (found) { state.projects[code] = found.id; skipped++; save(); return found.id; }
  const workspace_id = await ensureWorkspace();
  const r = await call("qa-admin-admin", "POST", "/projects", { workspace_id, code, name, ...extra });
  ensure(r.status, [201], `project ${code}`, r.body);
  state.projects[code] = row(r).id;
  created++;
  save();
  return state.projects[code];
}

async function seedProjects() {
  console.log("== projects: one active (configurable workflow), one inactive ==");
  // A project type carries a project_workflows row (the "configurable
  // workflow"): reuse one already seeded for this org if present, else fall
  // back to the frozen default workflow (still configurable per-org).
  const types = list(await call("qa-admin-admin", "GET", "/project-types?limit=50"));
  const projectType = types[0];
  const activeId = await ensureProject("QA-SEED-ACTIVE", "QA-Seed Active project", {
    description: "QA-Seed: baseline active project with a configurable workflow. Safe to archive.",
    ...(projectType ? { project_type_id: projectType.id } : {}),
  });
  {
    const p = row(await call("qa-admin-admin", "GET", `/projects/${activeId}`));
    if (p.status === "DRAFT") {
      const r = await call("qa-admin-admin", "PATCH", `/projects/${activeId}`, { status: "ACTIVE" }, { "x-record-version": String(p.version) });
      ensure(r.status, [200], "activate QA-SEED-ACTIVE", r.body);
      created++;
    } else skipped++;
  }
  await ensureProject("QA-SEED-INACTIVE", "QA-Seed Inactive project", {
    description: "QA-Seed: baseline project left DRAFT (not active). Safe to archive.",
  });
}

// ---------------------------------------------------------------------------
// BOQ + billing policy + RA bill certified -> a receivable
// ---------------------------------------------------------------------------
async function seedReceivable() {
  console.log("== BOQ + RA bill (certified) -> a receivable ==");
  const projectId = state.projects["QA-SEED-ACTIVE"];
  state.boq = state.boq || {};
  const boqList = list(await call("qa-admin-admin", "GET", `/projects/${projectId}/boq`));
  let item = boqList.find((b) => b.item_code === "QA-SEED-1.1");
  if (!item) {
    const r = await call("qa-admin-admin", "POST", `/projects/${projectId}/boq`, { item_code: "QA-SEED-1.1", description: "QA-Seed Earthwork excavation", unit: "cum", quantity: 1000, rate: 450.55 });
    ensure(r.status, [201], "boq QA-SEED-1.1", r.body);
    item = row(r);
    created++;
  } else skipped++;
  state.boq.itemId = item.id;
  save();

  const bills = list(await call("qa-admin-admin", "GET", `/projects/${projectId}/ra-bills?limit=100`));
  let bill = bills.find((b) => b.project_id === projectId);
  if (!bill) {
    const r = await call("qa-admin-admin", "POST", "/ra-bills", {
      project_id: projectId, period_from: "2026-09-01", period_to: "2026-09-30",
      measurement_book_ref: "QA-SEED-MB-1",
      lines: [{ boq_item_id: item.id, cumulative_quantity: 300 }],
    });
    ensure(r.status, [201], "ra-bill create", r.body);
    bill = row(r);
    created++;
  } else skipped++;
  state.raBillId = bill.id;
  save();

  const bget = async () => row(await call("qa-admin-admin", "GET", `/ra-bills/${state.raBillId}`));
  let b = await bget();
  if (b.status === "DRAFT") {
    const r = await call("qa-admin-admin", "POST", `/ra-bills/${state.raBillId}/status`, { status: "SUBMITTED" }, { "x-record-version": String(b.version) });
    ensure(r.status, [200], "ra-bill submit", r.body);
    created++;
    b = await bget();
  } else skipped++;
  if (b.status === "SUBMITTED") {
    const r = await call("qa-admin-admin", "POST", `/ra-bills/${state.raBillId}/status`, { status: "CERTIFIED" }, { "x-record-version": String(b.version) });
    ensure(r.status, [200], "ra-bill certify (-> receivable)", r.body);
    created++;
  } else skipped++;
}

// ---------------------------------------------------------------------------
// Open payroll period (payroll run in OPEN status)
// ---------------------------------------------------------------------------
async function seedPayrollRun() {
  console.log("== open payroll period (payroll run) ==");
  const PERIOD = { period_start: "2026-09-01", period_end: "2026-09-30" };
  const runs = list(await call("qa-admin-payroll", "GET", "/payroll/runs?limit=100"));
  let run = runs.find((r) => r.period_start === PERIOD.period_start && r.period_end === PERIOD.period_end);
  if (!run) {
    const r = await call("qa-admin-payroll", "POST", "/payroll/runs", PERIOD);
    if (r.status === 422 && r.body.code === "OVERLAPPING_RUN") {
      // Some other QA fixture already owns this period. Reuse whatever
      // overlaps it rather than failing the whole seed.
      const again = list(await call("qa-admin-payroll", "GET", "/payroll/runs?limit=100"));
      run = again.find((x) => x.period_start <= PERIOD.period_end && x.period_end >= PERIOD.period_start);
      if (!run) throw new Error("OVERLAPPING_RUN but no overlapping run found on relist");
      skipped++;
    } else {
      ensure(r.status, [201], "payroll run create", r.body);
      run = row(r);
      created++;
    }
  } else skipped++;
  state.payrollRunId = run.id;
  save();
}

// ---------------------------------------------------------------------------
// Assets, and stock with quantity 1
// ---------------------------------------------------------------------------
async function seedAssetsAndStock() {
  console.log("== assets + stock (quantity 1) ==");
  state.assets = state.assets || {};
  let cat = await findOne("qa-admin-inventory", "/asset-categories?limit=100", (c) => c.label === "QA-Seed Survey Equipment");
  if (!cat) { const r = await call("qa-admin-inventory", "POST", "/asset-categories", { label: "QA-Seed Survey Equipment" }); ensure(r.status, [201], "asset category", r.body); cat = row(r); created++; } else skipped++;
  let type = await findOne("qa-admin-inventory", "/asset-types?limit=100", (t) => t.label === "QA-Seed GNSS Rover");
  if (!type) { const r = await call("qa-admin-inventory", "POST", "/asset-types", { label: "QA-Seed GNSS Rover" }); ensure(r.status, [201], "asset type", r.body); type = row(r); created++; } else skipped++;
  state.assets.categoryId = cat.id; state.assets.typeId = type.id;

  let asset = await findOne("qa-admin-inventory", "/assets?limit=100", (a) => a.asset_code === "QA-SEED-AST-1");
  if (!asset) {
    const r = await call("qa-admin-inventory", "POST", "/assets", { asset_code: "QA-SEED-AST-1", serial_number: "QA-SEED-SN-1", name: "QA-Seed GNSS rover", category: cat.code, asset_type_id: type.id, make: "Trimble", model: "R12", condition: "GOOD" });
    ensure(r.status, [201], "asset QA-SEED-AST-1", r.body);
    asset = row(r);
    created++;
  } else skipped++;
  state.assets.assetId = asset.id;
  save();

  let stockItem = await findOne("qa-admin-inventory", "/inventory/items?limit=100", (i) => i.code === "QA-SEED-ITEM-1");
  if (!stockItem) {
    const r = await call("qa-admin-inventory", "POST", "/inventory/items", { code: "QA-SEED-ITEM-1", name: "QA-Seed Total Station", unit: "unit", low_stock_threshold: "1", unit_cost: "250000.00" });
    ensure(r.status, [201], "inventory item QA-SEED-ITEM-1", r.body);
    stockItem = row(r);
    created++;
  } else skipped++;
  state.stockItemId = stockItem.id;
  save();

  const txns = list(await call("qa-admin-inventory", "GET", `/inventory/transactions?item_id=${stockItem.id}&limit=50`));
  const already = txns.some((t) => t.reference === "QA-SEED-STOCK-IN-1");
  if (!already) {
    const r = await call("qa-admin-inventory", "POST", "/inventory/transactions", { item_id: stockItem.id, direction: "IN", quantity: "1", reference: "QA-SEED-STOCK-IN-1" });
    ensure(r.status, [201], "stock IN quantity 1", r.body);
    created++;
  } else skipped++;
}

// ---------------------------------------------------------------------------
// CRM: lead / client / tender
// ---------------------------------------------------------------------------
async function seedCrm() {
  console.log("== CRM: client / lead / tender ==");
  state.crm = state.crm || {};
  let client = await findOne("qa-admin-admin", "/clients?limit=100", (c) => c.name === "QA-Seed Client");
  if (!client) {
    const r = await call("qa-admin-admin", "POST", "/clients", { name: "QA-Seed Client", client_type: "PRIVATE", state: "Telangana" });
    ensure(r.status, [201], "client", r.body);
    client = row(r);
    created++;
  } else skipped++;
  state.crm.clientId = client.id;

  let lead = await findOne("qa-admin-admin", "/leads?limit=100", (l) => l.lead_no === "QA-SEED-L-1");
  if (!lead) {
    const r = await call("qa-admin-admin", "POST", "/leads", { lead_no: "QA-SEED-L-1", source: "REFERRAL", organization_name: client.name, client_id: client.id, lead_type: "PRIVATE", estimated_value: "500000" });
    ensure(r.status, [201], "lead", r.body);
    lead = row(r);
    created++;
  } else skipped++;
  state.crm.leadId = lead.id;

  let tender = await findOne("qa-admin-admin", "/tenders?limit=100", (t) => t.tender_no === "QA-SEED-T-1");
  if (!tender) {
    const r = await call("qa-admin-admin", "POST", "/tenders", { tender_no: "QA-SEED-T-1", tender_type: "OPEN", client_id: client.id, estimated_value: "500000" });
    ensure(r.status, [201], "tender", r.body);
    tender = row(r);
    created++;
  } else skipped++;
  state.crm.tenderId = tender.id;
  save();
}

// ---------------------------------------------------------------------------
// Procurement: vendor, PR -> PO -> GRN, and a matched vendor invoice
// ---------------------------------------------------------------------------
async function ensureApprovalPolicy(documentType, projectId) {
  const existing = await findOne("qa-admin-admin", `/approval-policies?document_type=${documentType}&limit=100`, (p) => p.project_id === projectId);
  if (existing) { skipped++; return existing; }
  const r = await call("qa-admin-admin", "POST", "/approval-policies", {
    document_type: documentType, name: `QA-Seed ${documentType} ladder`, project_id: projectId, mode: "CUMULATIVE",
    levels: [{ sequence: 1, min_amount: 0, max_amount: 500000, approver_role: "PROJECT_MANAGER" }, { sequence: 2, min_amount: 500000, max_amount: null, approver_role: "ADMIN" }],
  });
  ensure(r.status, [201], `approval policy ${documentType}`, r.body);
  created++;
  return row(r);
}

async function approveFully(getFn) {
  let d = await getFn();
  if (d.status !== "SUBMITTED" && d.status !== "PENDING_APPROVAL") return d;
  for (const role of ["qa-admin-pm", "qa-admin-admin"]) {
    d = await getFn();
    if (d.status === "APPROVED" || !d.approval_id) break;
    const approval = row(await call(role, "GET", `/approvals/${d.approval_id}`));
    if (approval.status === "APPROVED") break; // CUMULATIVE mode: a low-value ladder may have only one level
    // /approvals/:id/decision needs the approval instance's own version, not the document's.
    const r = await call(role, "POST", `/approvals/${d.approval_id}/decision`, { decision: "APPROVE" }, { "x-record-version": String(approval.version) });
    if (r.status === 200) created++; else skipped++;
  }
  return getFn();
}

async function seedProcurement() {
  console.log("== procurement: vendor, PR -> PO -> GRN, matched vendor invoice ==");
  const projectId = state.projects["QA-SEED-ACTIVE"];
  state.procurement = state.procurement || {};

  let vendor = await findOne("qa-admin-inventory", "/vendors?limit=100", (v) => v.code === "QA-SEED-V-1");
  if (!vendor) {
    const r = await call("qa-admin-inventory", "POST", "/vendors", { code: "QA-SEED-V-1", name: "QA-Seed Vendor", tax_id: "36QASEED123R1Z5" });
    ensure(r.status, [201], "vendor", r.body);
    vendor = row(r);
    created++;
  } else skipped++;
  state.procurement.vendorId = vendor.id;

  const item = { id: state.stockItemId };
  await ensureApprovalPolicy("PURCHASE_REQUISITION", projectId);
  await ensureApprovalPolicy("PURCHASE_ORDER", projectId);
  await ensureApprovalPolicy("EXPENSE_CLAIM", projectId);

  let pr = await findOne("qa-admin-admin", "/requisitions?limit=100", (p) => p.requisition_no === "QA-SEED-PR-1");
  if (!pr) {
    const r = await call("qa-admin-admin", "POST", "/requisitions", { requisition_no: "QA-SEED-PR-1", project_id: projectId, justification: "QA-Seed procurement chain", lines: [{ item_id: item.id, description: "QA-Seed Total Station", unit: "unit", quantity: 1, estimated_rate: 250000 }] });
    ensure(r.status, [201], "requisition", r.body);
    pr = row(r);
    created++;
  } else skipped++;
  state.procurement.prId = pr.id;

  const prGet = async () => row(await call("qa-admin-admin", "GET", `/requisitions/${pr.id}`));
  let prNow = await prGet();
  if (prNow.status === "DRAFT") {
    const r = await call("qa-admin-admin", "POST", `/requisitions/${pr.id}/submit`, {}, { "x-record-version": String(prNow.version) });
    ensure(r.status, [200], "requisition submit", r.body);
    created++;
  } else skipped++;
  prNow = await approveFully(prGet);

  let po = await findOne("qa-admin-inventory", "/purchase-orders?limit=100", (p) => p.po_number === "QA-SEED-PO-1");
  if (!po) {
    const link = prNow.status === "APPROVED" ? { requisition_id: pr.id } : {};
    const lineLink = prNow.status === "APPROVED" ? { requisition_line_id: prNow.lines[0].id } : {};
    const r = await call("qa-admin-admin", "POST", "/purchase-orders", { po_number: "QA-SEED-PO-1", vendor_id: vendor.id, ...link, project_id: projectId, po_date: "2026-09-01", place_of_supply: "36", lines: [{ item_id: item.id, ...lineLink, description: "QA-Seed Total Station", hsn_sac: "90158010", unit: "unit", quantity: 1, unit_rate: 250000, gst_rate_pct: 18 }] });
    ensure(r.status, [201], "purchase order", r.body);
    po = row(r);
    created++;
  } else skipped++;
  state.procurement.poId = po.id;
  save();

  const poGet = async () => row(await call("qa-admin-admin", "GET", `/purchase-orders/${po.id}`));
  let poNow = await poGet();
  if (poNow.status === "DRAFT") {
    const r = await call("qa-admin-admin", "POST", `/purchase-orders/${po.id}/submit`, {}, { "x-record-version": String(poNow.version) });
    ensure(r.status, [200], "PO submit", r.body);
    created++;
    poNow = await poGet();
  } else skipped++;
  poNow = await approveFully(poGet);
  // Bug (see report Findings): reflectOnDocument() in modules/approvals/routes.ts
  // only auto-syncs PURCHASE_REQUISITION on final approval; a fully-APPROVED
  // PURCHASE_ORDER ladder never updates purchase_orders.status. Set it by hand.
  if (poNow.status === "PENDING_APPROVAL" && poNow.approval_id) {
    const approval = row(await call("qa-admin-admin", "GET", `/approvals/${poNow.approval_id}`));
    if (approval.status === "APPROVED") {
      const r = await call("qa-admin-admin", "POST", `/purchase-orders/${po.id}/status`, { status: "APPROVED" }, { "x-record-version": String(poNow.version) });
      ensure(r.status, [200], "PO -> APPROVED (manual sync; see Findings)", r.body);
      created++;
      poNow = await poGet();
    }
  }
  if (poNow.status === "APPROVED") {
    const r = await call("qa-admin-admin", "POST", `/purchase-orders/${po.id}/status`, { status: "SENT" }, { "x-record-version": String(poNow.version) });
    ensure(r.status, [200], "PO -> SENT", r.body);
    created++;
    poNow = await poGet();
  } else skipped++;

  const grns = list(await call("qa-admin-inventory", "GET", "/grns?limit=100"));
  let grn = grns.find((g) => g.grn_no === "QA-SEED-GRN-1");
  if (!grn && (poNow.status === "SENT" || poNow.status === "APPROVED")) {
    const r = await call("qa-admin-inventory", "POST", "/grns", { grn_no: "QA-SEED-GRN-1", purchase_order_id: po.id, received_date: "2026-09-05", lines: [{ po_line_id: poNow.lines[0].id, received_quantity: 1, accepted_quantity: 1 }] });
    ensure(r.status, [201], "GRN", r.body);
    grn = row(r);
    created++;
  } else skipped++;
  if (grn) state.procurement.grnId = grn.id;

  let invoice = await findOne("qa-admin-inventory", "/invoices?limit=100", (i) => i.serial_number === "QA-SEED-INV-1");
  if (!invoice) {
    const r = await call("qa-admin-inventory", "POST", "/invoices", { serial_number: "QA-SEED-INV-1", vendor_id: vendor.id, hsn: "90158010", gst_enabled: true, gst_rate: "18", subtotal: "250000", payment_mode: "BANK", reference: `QA-Seed for PO ${po.po_number}` });
    ensure(r.status, [201], "vendor invoice", r.body);
    invoice = row(r);
    created++;
    const m = await call("qa-admin-admin", "POST", `/invoices/${invoice.id}/match`, {});
    if (m.status === 200) created++; else findings.push(`invoice match returned ${m.status}: ${JSON.stringify(m.body).slice(0, 200)}`);
  } else skipped++;
  state.procurement.invoiceId = invoice.id;
  save();
}

// ---------------------------------------------------------------------------
// Expense claim
// ---------------------------------------------------------------------------
async function seedExpense() {
  console.log("== expense claim ==");
  const projectId = state.projects["QA-SEED-ACTIVE"];
  let policy = await findOne("qa-admin-admin", "/expense-policies?limit=100", (p) => p.category === "TRAVEL");
  if (!policy) {
    const r = await call("qa-admin-admin", "POST", "/expense-policies", { category: "TRAVEL", effective_from: "2026-01-01", per_line_limit: 2000, per_claim_limit: 10000, requires_receipt_above: 500 });
    ensure(r.status, [201], "expense policy", r.body);
    policy = row(r);
    created++;
  } else skipped++;

  let claim = await findOne("qa-admin-employee", "/expense-claims?limit=100", (c) => c.claim_no === "QA-SEED-EXP-1");
  if (!claim) {
    const r = await call("qa-admin-employee", "POST", "/expense-claims", { claim_no: "QA-SEED-EXP-1", project_id: projectId, claim_date: "2026-09-10", purpose: "QA-Seed site visit", lines: [{ category: "TRAVEL", expense_date: "2026-09-10", description: "QA-Seed taxi", amount: 400 }] });
    ensure(r.status, [201], "expense claim", r.body);
    claim = row(r);
    created++;
  } else skipped++;
  state.expenseClaimId = claim.id;
  save();

  const cget = async () => row(await call("qa-admin-employee", "GET", `/expense-claims/${claim.id}`));
  let c = await cget();
  if (c.status === "DRAFT") {
    const r = await call("qa-admin-employee", "POST", `/expense-claims/${claim.id}/submit`, {}, { "x-record-version": String(c.version) });
    ensure(r.status, [200], "expense submit", r.body);
    created++;
    c = await cget();
  } else skipped++;
  if (c.status === "SUBMITTED" || c.status === "PENDING_APPROVAL") {
    // The claim's own /decision only finalizes it once its approval ladder
    // (claim.approval_id, from the EXPENSE_CLAIM policy) is fully APPROVED —
    // walk that ladder first (PM, then admin), same as PR/PO.
    await approveFully(cget);
    c = await cget();
    const r = await call("qa-admin-admin", "POST", `/expense-claims/${claim.id}/decision`, { status: "APPROVED" }, { "x-record-version": String(c.version) });
    if (r.status === 200) { created++; c = await cget(); } else findings.push(`expense claim decision returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  } else skipped++;
  if (c.status === "APPROVED") {
    const r = await call("qa-admin-payroll", "POST", `/expense-claims/${claim.id}/reimburse`, { amount: c.total_allowed ?? 400, paid_on: "2026-09-11", mode: "NEFT", reference: "QA-SEED-NEFT-1" });
    if (r.status === 200 || r.status === 201) created++; else findings.push(`expense reimburse returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  } else skipped++;
}

// ---------------------------------------------------------------------------
// A document
// ---------------------------------------------------------------------------
async function seedDocument() {
  console.log("== document ==");
  const projectId = state.projects["QA-SEED-ACTIVE"];
  let doc = await findOne("qa-admin-admin", "/documents?limit=100", (d) => d.title === "QA-Seed Drawing");
  if (!doc) {
    const r = await call("qa-admin-admin", "POST", "/documents", { type_code: "DRAWING", owner_type: "project", owner_id: projectId, title: "QA-Seed Drawing", revision: "R0" });
    ensure(r.status, [201], "document", r.body);
    doc = row(r);
    created++;
  } else skipped++;
  state.documentId = doc.id;
  save();
}

// ---------------------------------------------------------------------------
// Survey village with GCPs
// ---------------------------------------------------------------------------
async function seedSurvey() {
  console.log("== survey village with GCPs ==");
  const workspace_id = await ensureWorkspace();
  let programme = await findOne("qa-admin-admin", "/survey/projects?limit=100", (p) => p.code === "QA-SEED-SURVEY");
  if (!programme) {
    const r = await call("qa-admin-admin", "POST", "/survey/projects", { code: "QA-SEED-SURVEY", name: "QA-Seed Survey programme", started_on: "2026-08-01", target_completion_on: "2027-03-31", notes: "QA-Seed data. Safe to delete.", workspace_id });
    ensure(r.status, [201], "survey programme", r.body);
    programme = row(r);
    created++;
  } else skipped++;
  state.surveyProgrammeId = programme.id;
  save();

  const mandalId = state.orgUnits["QA-MANDAL-1"];
  let village = await findOne("qa-admin-admin", `/survey/projects/${programme.id}/villages?limit=100`, (v) => v.village_code === "QA-SEED-VILLAGE-1");
  if (!village) {
    const r = await call("qa-admin-admin", "POST", `/survey/projects/${programme.id}/villages`, { village_name: "QA-Seed Village", village_code: "QA-SEED-VILLAGE-1", mandal_id: mandalId });
    ensure(r.status, [201], "survey village", r.body);
    village = row(r);
    created++;
  } else skipped++;
  state.surveyVillageId = village.id;
  save();

  const gcps = list(await call("qa-admin-admin", "GET", `/survey/villages/${village.id}/gcps`));
  if (!gcps.some((g) => g.point_code === "QA-SEED-GCP-1")) {
    const r = await call("qa-admin-admin", "POST", `/survey/villages/${village.id}/gcps`, { point_code: "QA-SEED-GCP-1", latitude: 16.5, longitude: 80.6, elevation_m: 12 });
    ensure(r.status, [201], "gcp 1", r.body);
    created++;
  } else skipped++;
  if (!gcps.some((g) => g.point_code === "QA-SEED-GCP-2")) {
    const r = await call("qa-admin-admin", "POST", `/survey/villages/${village.id}/gcps`, { point_code: "QA-SEED-GCP-2", latitude: 16.51, longitude: 80.61, elevation_m: 14 });
    ensure(r.status, [201], "gcp 2", r.body);
    created++;
  } else skipped++;
}

// ---------------------------------------------------------------------------
// Org 2: minimal footprint to prove tenant isolation
// ---------------------------------------------------------------------------
async function ensureOrgUnitOrg2(type, code, name, parentId, cache) {
  if (cache[code]) return cache[code];
  const r0 = await org2Call("GET", `/org/units?type=${type}&limit=100`);
  const existing = list(r0).find((u) => u.code === code);
  if (existing) { cache[code] = existing.id; skipped++; return existing.id; }
  const r = await org2Call("POST", "/org/units", { type, code, name, ...(parentId ? { parent_id: parentId } : {}) });
  ensure(r.status, [201], `org2 unit ${code}`, r.body);
  cache[code] = row(r).id;
  created++;
  return cache[code];
}

async function seedOrg2() {
  if (!ORG2) { findings.push("admin/.qa-org2.json missing — org2 (tenant isolation) not seeded. Run scripts/qa/bootstrap-org2.mjs first (needs raw SQL: no API creates organizations)."); return; }
  console.log("== org2: minimal chain + employee + project, to prove tenant isolation ==");
  state.org2 = state.org2 || { orgUnits: {} };
  const cache = state.org2.orgUnits;
  const dId = await ensureOrgUnitOrg2("district", "QA-ORG2-DIST-1", "QA-Org2 District", undefined, cache);
  const mId = await ensureOrgUnitOrg2("mandal", "QA-ORG2-MANDAL-1", "QA-Org2 Mandal", dId, cache);
  const vId = await ensureOrgUnitOrg2("village", "QA-ORG2-VILLAGE-1", "QA-Org2 Village", mId, cache);
  await ensureOrgUnitOrg2("site", "QA-ORG2-SITE-1", "QA-Org2 Site", vId, cache);
  save();

  let emp = list(await org2Call("GET", "/employees?q=QA-ORG2-EMP-1&limit=20")).find((e) => e.emp_no === "QA-ORG2-EMP-1");
  if (!emp) {
    const r = await org2Call("POST", "/employees", { emp_no: "QA-ORG2-EMP-1", first_name: "QA-Org2", last_name: "Employee", phone: "+919812350001", date_of_joining: "2026-01-01", designation: "QA Field Engineer", site_id: cache["QA-ORG2-SITE-1"] });
    ensure(r.status, [201], "org2 employee", r.body);
    emp = row(r);
    created++;
    const a = await org2Call("POST", `/employees/${emp.id}/activate`, { reason: "QA seed org2" });
    if (a.status === 200) created++;
  } else skipped++;
  state.org2.employeeId = emp.id;

  let ws = list(await org2Call("GET", "/workspaces?limit=100")).find((w) => w.name === "QA-Org2 Workspace");
  if (!ws) {
    const r = await org2Call("POST", "/workspaces", { name: "QA-Org2 Workspace", description: "QA-Seed: tenant-isolation fixture. Safe to archive." });
    ensure(r.status, [201], "org2 workspace", r.body);
    ws = row(r);
    created++;
  } else skipped++;
  state.org2.workspaceId = ws.id;

  let proj = list(await org2Call("GET", "/projects?limit=100")).find((p) => p.code === "QA-ORG2-PROJECT");
  if (!proj) {
    const r = await org2Call("POST", "/projects", { workspace_id: ws.id, code: "QA-ORG2-PROJECT", name: "QA-Org2 Project", description: "QA-Seed: tenant-isolation fixture. Safe to archive." });
    ensure(r.status, [201], "org2 project", r.body);
    proj = row(r);
    created++;
  } else skipped++;
  state.org2.projectId = proj.id;
  save();
}

// ---------------------------------------------------------------------------
async function main() {
  const sections = [
    ["org units", seedOrgChains],
    ["employees", seedEmployees],
    ["leave balances", seedLeaveBalances],
    ["projects", seedProjects],
    ["receivable (RA bill)", seedReceivable],
    ["payroll run", seedPayrollRun],
    ["assets + stock", seedAssetsAndStock],
    ["CRM", seedCrm],
    ["procurement", seedProcurement],
    ["expense", seedExpense],
    ["document", seedDocument],
    ["survey", seedSurvey],
    ["org2 (tenant isolation)", seedOrg2],
  ];
  for (const [name, fn] of sections) {
    try {
      await fn();
    } catch (err) {
      findings.push(`section "${name}" failed: ${err.message}`);
      console.log(`  !! ${name} FAILED: ${err.message}`);
    }
  }
  save();
  console.log(`\n== summary == created=${created} skipped(existing)=${skipped}`);
  if (findings.length) {
    console.log("== findings ==");
    for (const f of findings) console.log("- " + f);
  }
}

await main();

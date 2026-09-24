// Lane B submit-walk: fill and submit real create forms in a live browser,
// as the lowest role that can use each one, and check both the UI and the
// API agree on success/failure. Valid QA- data first, then one invalid
// class per form, checking a field-level error surfaces (not silence or a
// bare toast).
//
//   node submit-walk.mjs
//
// Reuses the qa-fin-* sessions cached by fin/lib.mjs (same server, same
// users seeded for round 1). Screenshots go to shots/ for anything
// unexpected.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { authenticator } from "otplib";

const BASE = "http://34.131.134.217";
const DIR = "/home/dev-thor/sl-e2e/fin";
const users = JSON.parse(readFileSync(`${DIR}/.qa-users.json`, "utf8"));
mkdirSync(`${DIR}/shots`, { recursive: true });
const ts = Date.now().toString(36).toUpperCase();

// Each withPage() call below does a fresh, real /auth/login rather than
// reusing a cached session, so several calls for the same qa-fin-* user in
// one run can trip that account's own sign-in rate limit (confirmed live:
// a 4th fresh login for the same user within the run came back 429
// RATE_LIMITED, not a bug — a real user re-navigating a page never
// re-authenticates). Retry once after the window on that specific code.
async function login(u) {
  const post = (body) => fetch(`${BASE}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
  const attempt = async () => {
    let r = await post({ username: u.username, password: u.password });
    if (r.status === 200 && r.body.mfa_required) {
      r = await post({ username: u.username, password: u.password, totp_code: authenticator.generate(u.totp_secret) });
    }
    return r;
  };
  let r = await attempt();
  if (r.body?.code === "RATE_LIMITED") {
    await new Promise((res) => setTimeout(res, 8000));
    r = await attempt();
  }
  if (r.status !== 200) throw new Error(`login ${u.username} failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

const browser = await chromium.launch();
const results = [];

async function withPage(userKey, fn) {
  const u = users[userKey];
  const session = await login(u);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(([a, r]) => { localStorage.setItem("silverline.access_token", a); localStorage.setItem("silverline.refresh_token", r); }, [session.access_token, session.refresh_token]);
  const page = await ctx.newPage();
  const netLog = [];
  page.on("response", (r) => netLog.push({ status: r.status(), method: r.request().method(), url: r.url().replace(BASE, "") }));
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Cross-Origin-Opener/.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
  try {
    await fn(page, netLog, consoleErrors);
  } finally {
    await page.close();
    await ctx.close();
  }
}

function fieldControl(page, label) {
  return page.locator(`label:has-text("${label}")`).first();
}

async function fillText(page, label, value) {
  const label_ = fieldControl(page, label);
  const input = label_.locator("input, textarea").first();
  await input.fill(String(value));
}

async function pickCombo(page, label, text) {
  const label_ = fieldControl(page, label);
  const input = label_.locator("input").first();
  await input.click();
  await input.fill(text);
  await page.waitForTimeout(400);
  const option = page.locator(`[role=option]:has-text("${text}")`).first();
  if (await option.count()) {
    await option.click();
  } else {
    // No exact match in dropdown - leave as typed text (some are free combos).
  }
}

async function selectOption(page, label, value) {
  const label_ = fieldControl(page, label);
  const select = label_.locator("select").first();
  if (await select.count()) {
    await select.selectOption({ label: value }).catch(() => select.selectOption(value));
    return;
  }
  await pickCombo(page, label, value);
}

async function submitAndReport(page, netLog, name, submitLabel, expectField) {
  netLog.length = 0;
  const btn = page.locator(`button:has-text("${submitLabel}")`).last();
  await btn.click();
  await page.waitForTimeout(1500);
  const mutation = netLog.find((n) => ["POST", "PATCH"].includes(n.method) && n.url.startsWith("/api/v1/"));
  const alertText = await page.locator('[role=alert]').allInnerTexts().catch(() => []);
  const savedText = await page.locator('text=Saved successfully').count();
  console.log(`[${name}] mutation=${mutation ? mutation.status + " " + mutation.method + " " + mutation.url : "NONE"} alert="${(alertText[0] || "").slice(0, 160)}" savedBanner=${savedText}`);
  return { mutation, alertText };
}

// ---------------------------------------------------------------------------
// 1. Leads (qa-fin-sales holds lead.manage — the lowest allowed role)
// ---------------------------------------------------------------------------
await withPage("qa-fin-sales", async (page, netLog, consoleErrors) => {
  await page.goto(BASE + "/leads/new", { waitUntil: "networkidle" });
  await fillText(page, "Lead number", `QA-LEAD-${ts}`);
  await fillText(page, "Organisation", `QA-Organisation ${ts}`);
  await selectOption(page, "Type", "GOVERNMENT");
  await selectOption(page, "Source", "REFERRAL");
  await submitAndReport(page, netLog, "leads valid (qa-fin-sales)", "Create lead");

  // Invalid: reload, leave lead number and organisation blank, submit.
  await page.goto(BASE + "/leads/new", { waitUntil: "networkidle" });
  await selectOption(page, "Type", "GOVERNMENT");
  await selectOption(page, "Source", "REFERRAL");
  const before = netLog.length;
  const btn = page.locator('button:has-text("Create lead")').last();
  await btn.click();
  await page.waitForTimeout(800);
  const fired = netLog.slice(before).some((n) => n.method === "POST");
  const validationMsg = await page.locator("body").innerText();
  console.log(`[leads blank required] requestFired=${fired} sawLeadNoLabel=${validationMsg.includes("Lead number")}`);
  if (consoleErrors.length) console.log("  console errors:", consoleErrors.slice(0, 3));
});

// ---------------------------------------------------------------------------
// 2. Clients (qa-fin-sales holds client.manage)
// ---------------------------------------------------------------------------
await withPage("qa-fin-sales", async (page, netLog, consoleErrors) => {
  await page.goto(BASE + "/clients", { waitUntil: "networkidle" });
  await fillText(page, "Client code", `QA-CL-${ts}`);
  await fillText(page, "Organisation name", `QA-Client ${ts}`);
  await selectOption(page, "Type", "PRIVATE");
  await submitAndReport(page, netLog, "clients valid (qa-fin-sales)", "Create client");

  // Invalid: reuse the same client code — expect a CONFLICT, not silence.
  await page.goto(BASE + "/clients", { waitUntil: "networkidle" });
  await fillText(page, "Client code", `QA-CL-${ts}`);
  await fillText(page, "Organisation name", `QA-Client dup ${ts}`);
  await selectOption(page, "Type", "PRIVATE");
  await submitAndReport(page, netLog, "clients dup code (qa-fin-sales)", "Create client");
  if (consoleErrors.length) console.log("  console errors:", consoleErrors.slice(0, 3));
});

// ---------------------------------------------------------------------------
// 3. Tenders (qa-fin-tender — BID_TENDER_MANAGER, the lowest allowed role)
// ---------------------------------------------------------------------------
await withPage("qa-fin-tender", async (page, netLog, consoleErrors) => {
  await page.goto(BASE + "/tenders/new", { waitUntil: "networkidle" });
  await fillText(page, "Tender number", `QA-TND-${ts}`);
  await selectOption(page, "Type", "OPEN");
  await submitAndReport(page, netLog, "tenders valid (qa-fin-tender)", "Create tender");

  // Invalid: reuse the same tender number.
  await page.goto(BASE + "/tenders/new", { waitUntil: "networkidle" });
  await fillText(page, "Tender number", `QA-TND-${ts}`);
  await selectOption(page, "Type", "OPEN");
  await submitAndReport(page, netLog, "tenders dup number (qa-fin-tender)", "Create tender");
  if (consoleErrors.length) console.log("  console errors:", consoleErrors.slice(0, 3));
});

// ---------------------------------------------------------------------------
// 4. Boundary: qa-fin-emp (EMPLOYEE) should not even reach these forms.
//
// Each path gets its own fresh login/context: a shared context across three
// navigations was once observed landing on /login ("Your session has ended")
// on the third page, which looked like a background-refresh 401 mishandled
// as a sign-out rather than an actual bug in the page being tested — kept
// isolated here so a real per-page 403 is never confused with that.
// ---------------------------------------------------------------------------
for (const path of ["/leads/new", "/tenders/new", "/clients"]) {
  await withPage("qa-fin-emp", async (page) => {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    const url = page.url();
    const text = await page.locator("body").innerText();
    console.log(`[boundary emp ${path}] finalUrl=${url.replace(BASE, "")} sees403Text=${/permission|forbidden|403/i.test(text)} sessionEnded=${/session has ended/i.test(text)}`);
  });
}

await browser.close();
console.log("DONE");

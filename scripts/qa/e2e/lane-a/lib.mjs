// Shared helpers for the Lane A submit-walk scripts.
// Run from ~/sl-e2e/lane-a on the VM (qa-users.json lives in ~/sl-e2e/admin).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';

export const BASE = process.env.QA_BASE ?? 'http://34.131.134.217';
const ADMIN_DIR = '/home/dev-thor/sl-e2e/admin';
const qa = JSON.parse(readFileSync(`${ADMIN_DIR}/.qa-users.json`, 'utf8'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function userInfo(name) {
  const u = qa.users[name];
  if (!u) throw new Error('unknown qa user ' + name);
  return u;
}

export async function login(name) {
  const u = userInfo(name);
  for (;;) {
    const post = (body) =>
      fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    let r = await post({ username: u.username, password: u.password });
    if (r.status === 429) {
      const w = Number(r.headers.get('retry-after') || 5);
      await sleep(w * 1000 + 500);
      continue;
    }
    let j = await r.json();
    if (r.status === 200 && j.mfa_required) {
      r = await post({ username: u.username, password: u.password, totp_code: authenticator.generate(u.mfa_secret) });
      if (r.status === 429) {
        await sleep(6000);
        continue;
      }
      j = await r.json();
      if (r.status === 401 && j.code === 'INVALID_MFA_CODE') {
        await sleep((30 - (Math.floor(Date.now() / 1000) % 30)) * 1000 + 1000);
        continue;
      }
    }
    if (r.status !== 200) throw new Error('login ' + r.status + ' ' + JSON.stringify(j));
    return j;
  }
}

export async function newContext(browser, session, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(
    ([a, r]) => {
      localStorage.setItem('silverline.access_token', a);
      localStorage.setItem('silverline.refresh_token', r);
    },
    [session.access_token, session.refresh_token],
  );
  return ctx;
}

export async function openPage(ctx, path, opts = {}) {
  const page = await ctx.newPage();
  const rec = { path, console: [], pageErrors: [], failedRequests: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') rec.console.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e).slice(0, 200)));
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 400 && !r.url().includes('/auth/me')) rec.failedRequests.push(`${s} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });
  await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(600);
  page._rec = rec;
  return page;
}

// Track pass/fail results across a run so a single script can cover many cases.
export class Results {
  constructor(name) {
    this.name = name;
    this.items = [];
  }
  pass(area, detail) {
    this.items.push({ area, ok: true, detail });
    console.log(`PASS  ${area} :: ${detail ?? ''}`);
  }
  fail(area, detail) {
    this.items.push({ area, ok: false, detail });
    console.log(`FAIL  ${area} :: ${detail ?? ''}`);
  }
  note(area, detail) {
    this.items.push({ area, ok: null, detail });
    console.log(`NOTE  ${area} :: ${detail ?? ''}`);
  }
  summary() {
    const pass = this.items.filter((i) => i.ok === true).length;
    const fail = this.items.filter((i) => i.ok === false).length;
    const note = this.items.filter((i) => i.ok === null).length;
    console.log(`\n=== ${this.name}: ${pass} pass, ${fail} fail, ${note} note (of ${this.items.length}) ===`);
    return { pass, fail, note };
  }
}

export async function toastText(page, timeout = 6000) {
  try {
    const el = page.locator('[role="status"], [role="alert"]').first();
    await el.waitFor({ state: 'visible', timeout });
    return (await el.textContent())?.trim() ?? '';
  } catch {
    return null;
  }
}

export async function fieldError(page, htmlFor) {
  const el = page.locator(`#${htmlFor}-error`);
  if ((await el.count()) === 0) return null;
  return (await el.textContent())?.trim() ?? '';
}

// A throwaway password for a QA- account this script creates and disables
// again before exiting. Generated at runtime, never logged, never
// hard-coded in source — the API only requires 12-128 chars, no complexity
// rule, so a random base64url string with the QA- prefix (for at-a-glance
// identification in any incident review) is enough.
export function randomPassword() {
  return `QA-${randomBytes(18).toString('base64url')}`;
}

// Find a user's id by username via GET /admin/users, paging through
// results (server caps limit at 100) until found or exhausted.
export async function findUserIdByUsername(accessToken, username) {
  let offset = 0;
  for (;;) {
    const r = await fetch(`${BASE}/api/v1/admin/users?limit=100&offset=${offset}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = Array.isArray(j.data) ? j.data : [];
    const hit = rows.find((u) => u.username === username);
    if (hit) return hit.id;
    if (!j.has_more || rows.length === 0) return null;
    offset += rows.length;
  }
}

// Disable a throwaway account this script created, so a QA- test login
// left over from a submit-walk can never be signed into again. Returns the
// response status (200 on success) without throwing, so cleanup never
// masks the actual test result.
export async function disableUser(accessToken, userId) {
  const r = await fetch(`${BASE}/api/v1/admin/users/${userId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ auth_status: 'DISABLED' }),
  });
  return r.status;
}

// Type into a Combobox/EmployeePicker/UserPicker and click the first matching option.
export async function pickCombobox(page, inputLocator, query, optionTextContains) {
  await inputLocator.click();
  await inputLocator.fill(query);
  await page.waitForTimeout(500);
  const opt = page.locator('[role="option"]', { hasText: optionTextContains ?? query }).first();
  await opt.waitFor({ state: 'visible', timeout: 5000 });
  await opt.click();
}

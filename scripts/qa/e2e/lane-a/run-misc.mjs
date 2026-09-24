// MFA enroll, payroll run lifecycle, audit filters+export, inbox mark-read.
import { chromium } from 'playwright';
import { authenticator } from 'otplib';
import { login, newContext, openPage, Results } from './lib.mjs';

const results = new Results('misc');
const browser = await chromium.launch();

async function mfaEnroll() {
  // Use a disposable throwaway account for this, not a shared qa-admin-*
  // login: enrolling MFA has no web disable path (the security page has no
  // disable button at all — see the mfa/no-disable-control note below), so
  // reusing a shared account would permanently break every other script
  // that logs in as it (login() has no stored TOTP secret for them).
  const adminSession = await login('qa-admin-admin');
  const adminCtx = await newContext(browser, adminSession);
  const adminPage = await openPage(adminCtx, '/admin');
  const rand = Math.random().toString(36).slice(2, 8);
  const throwawayUser = `qa-lanea-mfa-${rand}`;
  const throwawayPass = 'QA-lanea-Mfa-Passw0rd!';
  const usernameInput = adminPage.locator('label', { hasText: 'Username *' }).locator('input');
  const passwordInput = adminPage.locator('label', { hasText: 'Initial password' }).locator('input[type="password"]');
  await usernameInput.fill(throwawayUser);
  await passwordInput.fill(throwawayPass);
  await adminPage.getByRole('button', { name: 'Save' }).first().click();
  await adminPage.locator('p[role="status"]', { hasText: 'Saved successfully' }).first().waitFor({ state: 'visible', timeout: 8000 });
  await adminCtx.close();

  const post = (body) =>
    fetch(`${process.env.QA_BASE ?? 'http://34.131.134.217'}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  const loginRes = await post({ username: throwawayUser, password: throwawayPass });
  const session = await loginRes.json();
  if (loginRes.status !== 200) {
    results.fail('mfa/enroll', 'could not log in as the throwaway account: ' + JSON.stringify(session));
    return;
  }
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/security');

  const setupBtn = page.getByRole('button', { name: 'Set up authenticator' });
  if ((await setupBtn.count()) === 0) {
    results.note('mfa/enroll', 'no "Set up authenticator" button — account may already be enrolled');
    await ctx.close();
    return;
  }
  await setupBtn.click();
  await page.waitForTimeout(800);
  const secretEl = page.locator('code').first();
  if ((await secretEl.count()) === 0) {
    results.fail('mfa/enroll', 'clicked Set up authenticator but no secret <code> block appeared');
    await ctx.close();
    return;
  }
  const secret = (await secretEl.textContent())?.trim() ?? '';

  // Invalid: wrong code.
  const codeInput = page.locator('label', { hasText: 'Authentication code' }).locator('input');
  await codeInput.fill('000000');
  await page.getByRole('button', { name: 'Verify and enable' }).click();
  await page.waitForTimeout(800);
  const err = await page.locator('[role="alert"]').first().textContent().catch(() => null);
  if (err) results.pass('mfa/enroll-wrong-code', 'wrong code correctly rejected: ' + err);
  else results.fail('mfa/enroll-wrong-code', 'no error shown for a wrong TOTP code');

  // Valid: real code from the secret just issued.
  const code = authenticator.generate(secret);
  await codeInput.fill(code);
  await page.getByRole('button', { name: 'Verify and enable' }).click();
  await page.waitForTimeout(1500);
  // signOutMessage path signs the user out to /login with a notice.
  await page.waitForURL(/\/login/i, { timeout: 8000 }).catch(() => {});
  const onLogin = /\/login/i.test(page.url());
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (onLogin && /two-factor|sign in again/i.test(bodyText)) {
    results.pass('mfa/enroll-valid', 'enrolled, signed out with notice: ' + bodyText.slice(0, 120));
  } else {
    results.fail('mfa/enroll-valid', `expected sign-out to /login with a notice; url=${page.url()} body=${bodyText.slice(0, 150)}`);
  }
  await ctx.close();
  results.note('mfa/no-disable-control', 'apps/web/app/security/page.tsx has no MFA-disable button at all (only "Set up authenticator" when not yet enabled) — once enrolled via web, an account can never turn MFA off again through the UI (API-only, see A-005)');
}

async function payrollRunLifecycle() {
  const session = await login('qa-admin-payroll');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/payroll/new');

  // Invalid: end before start.
  await page.fill('#pay-period-start', '2026-11-30');
  await page.fill('#pay-period-end', '2026-11-01');
  await page.getByRole('button', { name: 'Create run' }).click();
  await page.waitForTimeout(800);
  const err = await page.locator('[role="alert"]').first().textContent().catch(() => null);
  const errField = await page.locator('#pay-period-end-error, #pay-period-start-error').first().textContent().catch(() => null);
  if (err || errField) results.pass('payroll/reversed-period', `refused: alert=${JSON.stringify(err)} field=${JSON.stringify(errField)}`);
  else results.fail('payroll/reversed-period', 'no error shown for end-before-start period');

  // Valid: a fresh, unique period far in the future (avoids clashing with
  // any existing run for the same period).
  const year = 2030 + Math.floor(Math.random() * 20);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const start = `${year}-${month}-01`;
  const end = `${year}-${month}-28`;
  await page.fill('#pay-period-start', start);
  await page.fill('#pay-period-end', end);
  await page.getByRole('button', { name: 'Create run' }).click();
  try {
    await page.waitForURL(/type=payroll&id=|\/payroll\/[0-9a-f-]+/i, { timeout: 8000 });
    results.pass('payroll/create-valid', 'navigated to ' + page.url());
  } catch {
    const alert = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    const body = await page.locator('body').innerText();
    results.fail('payroll/create-valid', `did not navigate; url=${page.url()} alert=${JSON.stringify(alert)} bodySnippet=${JSON.stringify(body.slice(0, 200))}`);
    await ctx.close();
    return;
  }

  // Try to advance the run (compute/submit/approve) — whatever action is
  // available on the detail page for PAYROLL_OFFICER.
  await page.waitForTimeout(500);
  const actionBtn = page.getByRole('button', { name: /compute|validate|submit|calculate/i }).first();
  if ((await actionBtn.count()) > 0) {
    const label = (await actionBtn.textContent())?.trim();
    await actionBtn.click();
    await page.waitForTimeout(1500);
    const alert = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    // A future period with no attendance seeded correctly refuses
    // (NO_ATTENDANCE_DATA) rather than calculating garbage — that is a pass
    // for clean error handling, not a failure of the click itself.
    if (!alert || /NO_ATTENDANCE_DATA|no attendance/i.test(alert)) {
      results.pass('payroll/advance', `clicked "${label}": ${alert ? 'correctly refused (' + alert.slice(0, 80) + ')' : 'no error shown'}`);
    } else {
      results.fail('payroll/advance', `clicked "${label}", got an unexpected error: ${alert}`);
    }
  } else {
    const buttons = await page.locator('button').allTextContents();
    results.note('payroll/advance', 'no compute/validate/submit button found; buttons on page: ' + JSON.stringify(buttons.slice(0, 15)));
  }
  await ctx.close();
}

async function payrollWrongRoleDenied() {
  const session = await login('qa-admin-employee');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/payroll/new');
  const body = await page.locator('body').innerText();
  const denied = /access denied|do not include permission|needs the .* permission|not have access/i.test(body);
  const hasForm = (await page.locator('#pay-period-start').count()) > 0;
  if (denied || !hasForm) results.pass('payroll/wrong-role-hidden', `EMPLOYEE cannot create a payroll run (denied=${denied}, hasForm=${hasForm})`);
  else results.fail('payroll/wrong-role-hidden', 'EMPLOYEE unexpectedly sees the payroll run create form');
  await ctx.close();
}

async function auditFiltersAndExport() {
  const session = await login('qa-admin-auditor');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/audit');

  const beforeReqs = page._rec.failedRequests.length;
  await page.getByRole('button', { name: 'Export the trail' }).click();
  await page.waitForTimeout(1500);
  const newFails = page._rec.failedRequests.slice(beforeReqs);
  if (newFails.length === 0) results.pass('audit/export', 'Export the trail triggered no failed requests');
  else results.fail('audit/export', 'Export the trail caused: ' + JSON.stringify(newFails));

  // Attack: huge/garbage date filter.
  await page.fill('input[type="date"]', '9999-99-99').catch(() => {});
  await page.waitForTimeout(600);
  const afterInvalidDate = page._rec.failedRequests.slice(beforeReqs + newFails.length);
  results.note('audit/invalid-date-filter', 'failedReqs after garbage date: ' + JSON.stringify(afterInvalidDate));

  await ctx.close();
}

async function inboxMarkRead() {
  const session = await login('qa-admin-employee');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/inbox');

  const markAllBtn = page.getByRole('button', { name: 'Mark all read' });
  if ((await markAllBtn.count()) === 0) {
    results.note('inbox/mark-all-read', 'no "Mark all read" button found');
    await ctx.close();
    return;
  }
  await markAllBtn.click();
  await page.waitForTimeout(1000);
  const failed = page._rec.failedRequests;
  if (failed.length === 0) results.pass('inbox/mark-all-read', 'no failed requests after Mark all read');
  else results.fail('inbox/mark-all-read', 'Mark all read caused: ' + JSON.stringify(failed));

  const unreadOnly = page.locator('label', { hasText: 'Unread only' }).locator('input[type="checkbox"]');
  if ((await unreadOnly.count()) > 0) {
    await unreadOnly.check();
    await page.waitForTimeout(800);
    const rows = await page.locator('table tbody tr, li').count().catch(() => 0);
    results.note('inbox/unread-filter', `after marking all read + filtering to unread-only: ${rows} row(s) shown`);
  }
  await ctx.close();
}

try {
  await mfaEnroll();
  await payrollRunLifecycle();
  await payrollWrongRoleDenied();
  await auditFiltersAndExport();
  await inboxMarkRead();
} finally {
  await browser.close();
}
results.summary();

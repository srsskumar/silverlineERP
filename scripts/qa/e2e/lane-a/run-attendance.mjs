// Attendance exceptions: regularization request + decide submit-walk.
import { chromium } from 'playwright';
import { login, newContext, openPage, Results, fieldError } from './lib.mjs';

const results = new Results('attendance');
const browser = await chromium.launch();

async function regularizeInvalid() {
  const session = await login('qa-admin-hr');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/attendance/exceptions');

  // Invalid: blank required fields (employee, date, reason)
  await page.getByRole('button', { name: 'Submit regularization' }).click();
  const empErr = await fieldError(page, 'reg-employee');
  const dateErr = await fieldError(page, 'reg-date');
  const reasonErr = await fieldError(page, 'reg-reason');
  if (empErr && dateErr && reasonErr) results.pass('regularize/blank-required', `employee=${empErr} date=${dateErr} reason=${reasonErr}`);
  else results.fail('regularize/blank-required', `expected 3 field errors, got employee=${JSON.stringify(empErr)} date=${JSON.stringify(dateErr)} reason=${JSON.stringify(reasonErr)}`);

  // Invalid: bad date format (not YYYY-MM-DD)
  await page.locator('#reg-employee').click();
  await page.locator('#reg-employee').fill('QA-EMP');
  await page.waitForTimeout(600);
  const opt = page.locator('[role="option"]').first();
  if ((await opt.count()) > 0) await opt.click();
  await page.fill('#reg-date', '01-09-2026');
  await page.fill('#reg-reason', 'QA- lane-a bad-date-format attack');
  await page.getByRole('button', { name: 'Submit regularization' }).click();
  const badDateErr = await fieldError(page, 'reg-date');
  if (badDateErr) results.pass('regularize/bad-date-format', badDateErr);
  else results.fail('regularize/bad-date-format', 'expected a work_date format error, got none');

  await ctx.close();
}

async function regularizeValidAndDecide() {
  // HR_MANAGER is the only qa-admin-* account with unscoped employee
  // visibility that also holds attendance.decide (TEAM_LEAD/PROJECT_MANAGER
  // are scoped to one project and cannot see the QA-EMP-* seed employees at
  // all in EmployeePicker, so they cannot file for them). HR_MANAGER also
  // holds users.manage, so deciding its own submission below exercises the
  // documented emergency override (SELF_DECISION's users.manage bypass,
  // apps/api/src/modules/attendance/routes.ts:1602-1612) rather than the
  // plain-block path — that plain-block path was reviewed statically in
  // round 2 and not re-verified live here (no available QA credential has
  // attendance.decide + unscoped visibility without also having
  // users.manage).
  const filer = await login('qa-admin-hr');
  const filerCtx = await newContext(browser, filer);
  const page = await openPage(filerCtx, '/attendance/exceptions');

  await page.locator('#reg-employee').click();
  await page.locator('#reg-employee').fill('QA-EMP-BRAVO');
  await page.waitForTimeout(600);
  const opt = page.locator('[role="option"]').first();
  if ((await opt.count()) === 0) {
    results.note('regularize/valid', 'QA-EMP-BRAVO not found in EmployeePicker — cannot exercise valid regularize');
    await filerCtx.close();
    return;
  }
  await opt.click();
  const workDate = new Date();
  workDate.setDate(workDate.getDate() - (10 + Math.floor(Math.random() * 300)));
  const ds = workDate.toISOString().slice(0, 10);
  await page.fill('#reg-date', ds);
  await page.fill('#reg-in', `${ds}T09:05:00Z`);
  await page.fill('#reg-out', `${ds}T18:10:00Z`);
  await page.fill('#reg-reason', 'QA- lane-a submit-walk valid regularization request');
  await page.getByRole('button', { name: 'Submit regularization' }).click();

  let exceptionId = null, version = null;
  try {
    const status = page.locator('text=/filed as/i').first();
    await status.waitFor({ state: 'visible', timeout: 8000 });
    const text = (await status.textContent()) ?? '';
    const m = text.match(/filed as ([0-9a-f-]+) \(v(\d+)\)/i);
    if (m) {
      exceptionId = m[1];
      version = m[2];
      results.pass('regularize/valid', `filed ${exceptionId} v${version}`);
    } else {
      results.fail('regularize/valid', 'no id/version parsed from success text: ' + text);
    }
  } catch {
    const err = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    const failedReqs = page._rec.failedRequests;
    results.fail('regularize/valid', `no success status shown; alert=${JSON.stringify(err)} failedReqs=${JSON.stringify(failedReqs)}`);
  }
  await filerCtx.close();
  if (!exceptionId) return;

  // HR (the filer) decides its own filed exception. HR_MANAGER holds
  // users.manage, so this exercises the documented emergency override
  // (SELF_DECISION bypass) — it is EXPECTED to succeed, not be blocked.
  try {
    const filer2 = await login('qa-admin-hr');
    const ctx2 = await newContext(browser, filer2);
    const page2 = await openPage(ctx2, '/attendance/exceptions');
    await page2.fill('#exc-manual-id', exceptionId);
    await page2.fill('#exc-manual-ver', version);
    await page2.getByRole('button', { name: 'Track ID' }).click();
    await page2.waitForTimeout(500);
    const decideBtn = page2.getByRole('button', { name: 'Decide…' }).first();
    if ((await decideBtn.count()) > 0) {
      await decideBtn.click();
      await page2.waitForTimeout(500);
      // DecisionDialog defaults its <select> to APPROVE; "Submit decision" is
      // the actual submit button (there is no literal "Approve" button).
      await page2.getByRole('button', { name: 'Submit decision' }).click();
      await page2.waitForTimeout(1000);
      const dialogGone = (await page2.locator('[role="dialog"][aria-label="Decide exception"]').count()) === 0;
      const alertText = await page2.locator('[role="alert"]').first().textContent().catch(() => null);
      if (dialogGone && !alertText) {
        results.pass('regularize/self-decide-override', 'HR (users.manage) self-decided its own submission via the documented emergency override');
      } else {
        results.fail('regularize/self-decide-override', `expected the override to succeed; dialogClosed=${dialogGone} alert=${JSON.stringify(alertText)}`);
      }
    } else {
      results.note('regularize/self-decide-override', 'no Decide button available (missing attendance.decide?) — cannot exercise');
    }
    await ctx2.close();
  } catch (e) {
    results.fail('regularize/self-decide-override', 'threw: ' + String(e.message).slice(0, 300));
  }

  // State-machine jump: SUPER_ADMIN tries to decide it again, now that HR
  // already approved it above (single-transition-only: PENDING -> decided,
  // never re-decided).
  const decider = await login('qa-admin-superadmin');
  const ctx3 = await newContext(browser, decider);
  const page3 = await openPage(ctx3, '/attendance/exceptions');
  await page3.fill('#exc-manual-id', exceptionId);
  await page3.fill('#exc-manual-ver', version);
  await page3.getByRole('button', { name: 'Track ID' }).click();
  await page3.waitForTimeout(400);
  const decideBtn3 = page3.getByRole('button', { name: 'Decide…' }).first();
  if ((await decideBtn3.count()) > 0) {
    await decideBtn3.click();
    await page3.waitForTimeout(500);
    await page3.getByRole('button', { name: 'Submit decision' }).click();
    await page3.waitForTimeout(1200);
    const bannerErr = await page3.locator('[role="alert"]').first().textContent().catch(() => null);
    // Version conflicts open ConflictDialog (role="alertdialog",
    // aria-label="Version conflict"), not the plain ErrorCard/[role=alert].
    const conflictDialog = page3.locator('[role="alertdialog"][aria-label="Version conflict"]');
    const conflictShown = (await conflictDialog.count()) > 0;
    if (bannerErr || conflictShown) {
      const conflictText = conflictShown ? await conflictDialog.textContent() : null;
      results.pass('regularize/redecide-blocked', `re-deciding an already-decided exception was refused: alert=${JSON.stringify(bannerErr)} conflictDialog=${JSON.stringify(conflictText)}`);
    } else {
      const dialogGone = (await page3.locator('[role="dialog"][aria-label="Decide exception"]').count()) === 0;
      results.fail('regularize/redecide-blocked', `expected a refusal; dialogClosed=${dialogGone} failedReqs=${JSON.stringify(page3._rec.failedRequests)}`);
    }
  } else {
    results.note('regularize/redecide-blocked', 'no Decide button for SUPER_ADMIN — cannot exercise (unexpected, SUPER_ADMIN holds attendance.decide)');
  }
  await ctx3.close();
}

async function wrongRoleDenied() {
  const session = await login('qa-admin-client');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/attendance/exceptions');
  const body = await page.locator('body').innerText();
  const denied = /access denied|do not include permission|needs the .* permission|not have access/i.test(body);
  const hasForm = (await page.locator('#reg-employee').count()) > 0;
  if (denied && !hasForm) results.pass('exceptions/wrong-role-hidden', 'CLIENT_VIEWER sees an access-denied gate, not the form');
  else results.fail('exceptions/wrong-role-hidden', `CLIENT_VIEWER page denied=${denied} hasForm=${hasForm}`);
  await ctx.close();
}

try {
  await regularizeInvalid();
  await regularizeValidAndDecide();
  await wrongRoleDenied();
} finally {
  await browser.close();
}
results.summary();

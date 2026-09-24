// Leave apply / decide submit-walk.
//   node run-leave.mjs
import { chromium } from 'playwright';
import { login, newContext, openPage, Results, toastText, fieldError, pickCombobox } from './lib.mjs';

const results = new Results('leave');
const browser = await chromium.launch();

async function asEmployee() {
  const session = await login('qa-admin-employee');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/leave/new');

  const noEmp = await page.locator('text=not linked to an employee record').count();
  if (noEmp) {
    results.note('apply/employee-record', 'qa-admin-employee has no linked employee record — cannot file; skipping apply cases');
    await ctx.close();
    return;
  }

  // --- Invalid: reversed dates ---
  await page.selectOption('#leave-type', { index: 1 }).catch(() => {});
  const typeVal = await page.locator('#leave-type').inputValue();
  if (!typeVal) {
    results.note('apply/leave-types', 'no leave types available to select — cannot exercise the form');
  } else {
    await page.fill('#leave-from', '2026-10-10');
    await page.fill('#leave-to', '2026-10-05');
    await page.getByRole('button', { name: 'File leave request' }).click();
    const err = await fieldError(page, 'leave-to');
    if (err && /on or after/i.test(err)) results.pass('apply/reversed-dates', err);
    else results.fail('apply/reversed-dates', `expected a to_date field error, got: ${JSON.stringify(err)}`);

    // --- Invalid: blank leave type ---
    await page.selectOption('#leave-type', { index: 0 });
    await page.fill('#leave-from', '2026-10-05');
    await page.fill('#leave-to', '2026-10-10');
    await page.getByRole('button', { name: 'File leave request' }).click();
    const err2 = await fieldError(page, 'leave-type');
    if (err2) results.pass('apply/blank-type', err2);
    else results.fail('apply/blank-type', 'expected a leave_type_id field error, got none');

    // --- Valid submission --- (LOP: unpaid, no balance required, so this
    // never depends on the seeded balance rows being non-zero)
    await page.selectOption('#leave-type', { label: 'LOP — Loss of Pay (unpaid)' });
    const future = new Date();
    future.setDate(future.getDate() + 30 + Math.floor(Math.random() * 300));
    const from = future.toISOString().slice(0, 10);
    future.setDate(future.getDate() + 1);
    const to = future.toISOString().slice(0, 10);
    await page.fill('#leave-from', from);
    await page.fill('#leave-to', to);
    await page.fill('#leave-reason', 'QA- lane-a submit-walk valid leave application');
    await page.getByRole('button', { name: 'File leave request' }).click();
    try {
      await page.waitForURL(/type=leave&id=[0-9a-f-]+/i, { timeout: 8000 });
      results.pass('apply/valid', 'navigated to ' + page.url());
    } catch {
      const banner = await page.locator('[role="alert"]').first().textContent().catch(() => null);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      results.fail(
        'apply/valid',
        `did not navigate; url=${page.url()} banner=${JSON.stringify(banner)} failedReqs=${JSON.stringify(page._rec.failedRequests)} bodySnippet=${JSON.stringify(bodyText.slice(0, 300))}`,
      );
    }
  }

  // --- Wrong role: AUDITOR should not see the form at all ---
  await ctx.close();
}

async function asAuditorDenied() {
  const session = await login('qa-admin-auditor');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/leave/new');
  const body = await page.locator('body').innerText();
  const denied = /access denied|do not include permission|needs the .* permission|not have access/i.test(body);
  const hasForm = (await page.locator('#leave-type').count()) > 0;
  if (denied && !hasForm) results.pass('apply/wrong-role-hidden', 'AUDITOR sees an access-denied gate, not the form');
  else results.fail('apply/wrong-role-hidden', `AUDITOR page body denied=${denied} hasForm=${hasForm}`);
  await ctx.close();
}

async function decideFlow(roleUser) {
  const session = await login(roleUser);
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/leave');
  await page.getByRole('button', { name: 'Approvals' }).click().catch(() => {});
  await page.waitForTimeout(800);
  const rows = await page.locator('table tbody tr').count().catch(() => 0);
  results.note(`decide/approvals-queue/${roleUser}`, `Approvals tab shows ${rows} row(s)`);
  if (rows > 0) {
    const openBtn = page.locator('table tbody tr').first().getByRole('button', { name: 'Open' });
    if ((await openBtn.count()) > 0) {
      await openBtn.click();
      await page.waitForTimeout(600);
      const approveBtn = page.getByRole('button', { name: /approve/i }).first();
      if ((await approveBtn.count()) > 0) {
        await approveBtn.click();
        await page.waitForTimeout(1000);
        const status = await page.locator('body').innerText();
        if (/APPROVED/i.test(status)) results.pass(`decide/approve/${roleUser}`, 'request now shows APPROVED');
        else results.fail(`decide/approve/${roleUser}`, 'no APPROVED status found after clicking approve');
      } else {
        results.note(`decide/approve/${roleUser}`, 'no Approve button on the opened request detail');
      }
    }
  }
  await ctx.close();
}

try {
  await asEmployee();
  await asAuditorDenied();
  await decideFlow('qa-admin-tl');
  await decideFlow('qa-admin-admin');
  // Not walked live: the approval chain's step-2 fallback (step2Approver,
  // apps/api/src/modules/leave/routes.ts:366) always resolves to the
  // earliest-created HR_MANAGER/ADMIN/SUPER_ADMIN account -- in this seed
  // data that is the original seed "admin" account, confirmed via
  // GET /leave/requests (current_approver_id matches that user's id), not
  // any qa-admin-* account. Deciding live as that account would need its
  // credentials, which this walk intentionally does not read. Verified
  // instead by direct API inspection: the approval-chain/current_approver_id
  // resolution matches the documented design (not a bug), and the
  // permission+identity guard on decide (`current_approver_id !== user.id`)
  // was already live-verified in round 1/2 (A-004).
  results.note('decide/approver-identity', 'current_approver_id resolves to the seed "admin" account (earliest HR/ADMIN/SUPER_ADMIN) for this seed data, not a qa-admin-* user; live click-through of Approve as that account not attempted (would require its credentials)');
} finally {
  await browser.close();
}
results.summary();

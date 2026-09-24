// Admin: create user, create role, module-visibility toggle, role-assign.
import { chromium } from 'playwright';
import { login, newContext, openPage, Results, randomPassword, findUserIdByUsername, disableUser } from './lib.mjs';

const results = new Results('admin');
const browser = await chromium.launch();
const rand = Math.random().toString(36).slice(2, 8);

async function createUserValidAndInvalid() {
  const session = await login('qa-admin-admin');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/admin');

  // Invalid: blank required username/password -> native HTML5 required
  // validation (MutationForm has no noValidate), so the browser blocks
  // submission client-side with no network call at all.
  const usernameInput = page.locator('label', { hasText: 'Username *' }).locator('input');
  const passwordInput = page.locator('label', { hasText: 'Initial password' }).locator('input[type="password"]');
  const before = page._rec.failedRequests.length;
  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.waitForTimeout(400);
  const usernameValid = await usernameInput.evaluate((el) => el.checkValidity());
  if (!usernameValid && page._rec.failedRequests.length === before) {
    results.pass('create-user/blank-required', 'native required validation blocked submission (no network call)');
  } else {
    results.fail('create-user/blank-required', `usernameValid=${usernameValid} newFailedReqs=${page._rec.failedRequests.length - before}`);
  }

  // Valid: fill a unique QA- user and submit. The password is generated at
  // runtime and never logged — this account is disabled again below before
  // the script exits, so nothing durable depends on the password anyway.
  const uname = `qa-lanea-${rand}`;
  await usernameInput.fill(uname);
  await passwordInput.fill(randomPassword());
  await page.getByRole('button', { name: 'Save' }).first().click();
  try {
    const status = page.locator('p[role="status"]', { hasText: 'Saved successfully' }).first();
    await status.waitFor({ state: 'visible', timeout: 8000 });
    results.pass('create-user/valid', `created ${uname}`);
  } catch {
    const alert = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    results.fail('create-user/valid', 'no success message; alert=' + JSON.stringify(alert));
    // Best effort: the UI's success detection can false-negative even when
    // the account was actually created, so still try to disable it.
    const maybeId = await findUserIdByUsername(session.access_token, uname).catch(() => null);
    if (maybeId) await disableUser(session.access_token, maybeId).catch(() => {});
    await ctx.close();
    return uname;
  }

  // Disable the throwaway account immediately — this walk only needed to
  // prove the create form works, not to leave a live login behind.
  const userId = await findUserIdByUsername(session.access_token, uname);
  if (userId) {
    const status = await disableUser(session.access_token, userId);
    if (status === 200) results.pass('create-user/cleanup-disabled', `disabled ${uname}`);
    else results.fail('create-user/cleanup-disabled', `PATCH auth_status=DISABLED for ${uname} returned ${status}`);
  } else {
    results.fail('create-user/cleanup-disabled', `could not find ${uname} in GET /admin/users to disable it`);
  }
  await ctx.close();
  return uname;
}

async function createRoleXssAttack() {
  const session = await login('qa-admin-admin');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/admin');

  const codeInput = page.locator('label', { hasText: /^Code \(uppercase\) \*/ }).locator('input');
  const nameInput = page.locator('label', { hasText: 'Display name *' }).locator('input');
  const permsInput = page.locator('label', { hasText: 'Permission codes' }).locator('textarea');

  const code = `QA_LANEA_${rand.toUpperCase()}`;
  const xssName = '<script>alert(1)</script> QA- role';
  await codeInput.fill(code);
  await nameInput.fill(xssName);
  await permsInput.fill('leave.request');
  const saveButtons = page.getByRole('button', { name: 'Save' });
  // The "Create custom role" panel's Save is the 2nd on the page (Create
  // user's Save is 1st); locate it by proximity to the role fields instead.
  await nameInput.locator('xpath=ancestor::form').getByRole('button', { name: 'Save' }).click();
  try {
    const status = page.locator('p[role="status"]', { hasText: 'Saved successfully' }).first();
    await status.waitFor({ state: 'visible', timeout: 8000 });
    results.pass('create-role/xss-valid', `role ${code} created with an XSS-payload name`);
  } catch {
    const alert = await nameInput.locator('xpath=ancestor::form').locator('[role="alert"]').first().textContent().catch(() => null);
    results.fail('create-role/xss-valid', 'could not create role; alert=' + JSON.stringify(alert));
    await ctx.close();
    return;
  }

  // Now confirm the stored name renders escaped (as text), not executed, in
  // the Roles collection table below.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const dialogFired = await page.evaluate(() => (window).__qaXssFired ?? false);
  const cellText = await page.locator('td', { hasText: code }).first().locator('xpath=..').textContent().catch(() => '');
  const scriptTagInDom = await page.locator(`td:has-text("${xssName}")`).count().catch(() => 0);
  results.note('create-role/xss-render', `dialogFired=${dialogFired} rowText=${JSON.stringify(cellText?.slice(0, 150))}`);
  if (!dialogFired) results.pass('create-role/xss-not-executed', 'no alert() fired — React text interpolation escaped it');
  else results.fail('create-role/xss-not-executed', 'XSS payload executed!');
  await ctx.close();
}

async function moduleVisibilityToggle() {
  const session = await login('qa-admin-admin');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/admin');

  const select = page.locator('#module-visibility-role');
  if ((await select.count()) === 0) {
    results.note('module-visibility/toggle', 'no #module-visibility-role select found');
    await ctx.close();
    return;
  }
  await select.selectOption('EMPLOYEE');
  await page.waitForTimeout(600);
  // Scope to the ModuleVisibility panel specifically (RoleVisibility, a
  // separate panel higher on the page, has its own unrelated buttons like
  // "Let them see everything").
  const panel = page.locator('ul.divide-y', { has: page.locator('button', { hasText: /^(Hide|Show)$/ }) }).first();
  const toggleBtn = panel.getByRole('button', { name: /^(Hide|Show)$/ }).first();
  if ((await toggleBtn.count()) === 0) {
    results.note('module-visibility/toggle', 'no Hide/Show toggle button found for EMPLOYEE role');
    await ctx.close();
    return;
  }
  const row = toggleBtn.locator('xpath=ancestor::li');
  const beforeLabel = (await toggleBtn.textContent())?.trim();
  const beforeBadge = (await row.locator('span,div').filter({ hasText: /^(Visible|Hidden)$/ }).first().textContent().catch(() => null))?.trim();
  await toggleBtn.click();
  await page.waitForTimeout(1000);
  const afterLabel = (await row.getByRole('button', { name: /^(Hide|Show)$/ }).first().textContent())?.trim();
  const afterBadge = (await row.locator('span,div').filter({ hasText: /^(Visible|Hidden)$/ }).first().textContent().catch(() => null))?.trim();
  if (afterLabel && afterLabel !== beforeLabel && afterBadge !== beforeBadge) {
    results.pass('module-visibility/toggle', `toggled "${beforeLabel}"/${beforeBadge} -> "${afterLabel}"/${afterBadge}`);
    // Toggle back to restore state for other QA runs.
    await row.getByRole('button', { name: afterLabel }).click();
    await page.waitForTimeout(800);
  } else {
    results.fail('module-visibility/toggle', `label/badge did not change: before=${beforeLabel}/${beforeBadge} after=${afterLabel}/${afterBadge}`);
  }
  await ctx.close();
}

async function wrongRoleDenied() {
  const session = await login('qa-admin-employee');
  const ctx = await newContext(browser, session);
  const page = await openPage(ctx, '/admin');
  const body = await page.locator('body').innerText();
  const denied = /access denied|do not include permission|needs the .* permission|not have access/i.test(body);
  const hasCreateUser = (await page.locator('label', { hasText: 'Username *' }).count()) > 0;
  if (denied || !hasCreateUser) results.pass('admin/wrong-role-hidden', `EMPLOYEE cannot manage users (denied=${denied}, hasCreateUserForm=${hasCreateUser})`);
  else results.fail('admin/wrong-role-hidden', 'EMPLOYEE unexpectedly sees the Create user form');
  await ctx.close();
}

try {
  await createUserValidAndInvalid();
  await createRoleXssAttack();
  await moduleVisibilityToggle();
  await wrongRoleDenied();
} finally {
  await browser.close();
}
results.summary();

// Open a page, optionally click a button, dump the resulting form's
// labelled fields, buttons and `title` tooltips -- for finding real
// selectors before writing a targeted interaction script, and for
// spot-checking a tooltip's text by eye.
//
//   node dialog-recon.mjs --path /projects --click "+ New project" [--as qa-admin-superadmin]
import { openBrowser, BASE } from "./deeplib.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const path = arg("--path", "/projects");
const clickText = arg("--click", "+ New project");
const session = arg("--as", "qa-admin-superadmin");

const { browser, ctx } = await openBrowser(session);
const page = await ctx.newPage();
await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1000);
if (clickText) {
  await page.getByRole("button", { name: clickText, exact: true }).first().click();
  await page.waitForTimeout(800);
}
const dump = await page.evaluate(() => {
  const dlg = document.querySelector('[role=dialog]') || document.body;
  const fields = [...dlg.querySelectorAll('input,select,textarea')].map(el => {
    const id = el.id;
    const label = (id && document.querySelector(`label[for="${id}"]`)?.textContent) ||
      el.closest('label')?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return { tag: el.tagName, type: el.type, name: el.name, label: (label || '').trim(), required: el.required };
  });
  const buttons = [...dlg.querySelectorAll('button,[role=button]')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean);
  const titles = [...document.querySelectorAll('[title]')].map(e => e.getAttribute('title')).filter(Boolean).slice(0, 30);
  return { fields, buttons, titles, dialogFound: !!document.querySelector('[role=dialog]') };
});
console.log(JSON.stringify(dump, null, 2));
await browser.close();

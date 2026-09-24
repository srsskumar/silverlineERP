// Post-deploy QA (2026-09-24): 375px viewport horizontal-overflow sweep.
//
// Loads each given path at a 375x812 viewport (using a session token
// written by gen-role-sessions.mjs / crawl.mjs's own convention) and flags
// any page whose document is wider than the viewport, with a few offending
// elements sampled for a quick lead on where the overflow comes from.
//
//   node mobile-viewport-check.mjs --as .qa-admin-superadmin.json --paths "/dashboard /employees"
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.BASE ?? "http://127.0.0.1";
const session = JSON.parse(readFileSync(arg("--as", ".admin.json"), "utf8"));
const paths = arg(
  "--paths",
  "/dashboard /employees /projects /procurement /billing /payables /receivables /expenses /leave /attendance /admin /tenders /leads /clients /inventory /payroll /assets /survey /approvals /reports",
).split(/\s+/).filter(Boolean);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
await ctx.addInitScript(([a, r]) => {
  localStorage.setItem("silverline.access_token", a);
  localStorage.setItem("silverline.refresh_token", r);
}, [session.access_token, session.refresh_token]);

for (const path of paths) {
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => {
      const docWidth = document.documentElement.scrollWidth;
      const winWidth = window.innerWidth;
      const overflowers = [];
      if (docWidth > winWidth + 2) {
        document.querySelectorAll("body *").forEach((el) => {
          if (el.scrollWidth > winWidth + 5 && el.children.length < 3) {
            const r = el.getBoundingClientRect();
            if (r.width > winWidth + 5) {
              overflowers.push(`${el.tagName}.${(el.className + "").slice(0, 40)} w=${Math.round(r.width)}`);
            }
          }
        });
      }
      return { docWidth, winWidth, overflowing: docWidth > winWidth + 2, sample: overflowers.slice(0, 3) };
    });
    console.log(
      path,
      overflow.overflowing
        ? `OVERFLOW doc=${overflow.docWidth} win=${overflow.winWidth} ${JSON.stringify(overflow.sample)}`
        : "ok",
    );
  } catch (e) {
    console.log(path, "ERROR", String(e.message).slice(0, 150));
  }
  await page.close();
}
await browser.close();

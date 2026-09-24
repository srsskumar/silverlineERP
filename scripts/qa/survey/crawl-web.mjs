// Survey deep QA, browser crawl (lane 1). Every survey page and tab, as each
// role, clicking every non-destructive button and opening every dialog.
//   cd ~/sl-e2e/svd && node crawl-web.mjs [user ...]
// Records console/page errors, 4xx/5xx responses, rendering junk (NaN,
// undefined, Invalid Date, [object Object]) and, for observers, anything
// that looks like a crew name, money or equipment.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { session, fixture } from "./lib.mjs";

const BASE = "http://127.0.0.1";
const F = fixture();
const P = F.programmeId;
const users = process.argv.slice(2).length ? process.argv.slice(2)
  : ["qa-admin-admin", "qa-admin-pm", "qa-survey-tl", "qa-survey-surveyor", "qa-admin-client", "qa-admin-govt", "qa-survey-client"];
const observers = new Set(["qa-admin-client", "qa-admin-govt", "qa-survey-client", "qa-survey-govt"]);
const TABS = ["dashboard", "progress", "villages", "report", "people", "deployment", "bottlenecks", "timeline", "summary", "control"];
const pages = [
  ...TABS.map((t) => `/survey?project=${P}&tab=${t}`),
  `/survey?project=${P}&village=${F.villages.V1}`,
  `/survey?project=${P}&village=${F.villages.V2}`,
  "/survey/entry", `/survey/entry?village=${F.villages.V1}`, "/survey/setup",
];
const DESTRUCTIVE = /delete|remove|release|submit|save|claim|start|complete|certify|import|disable|move|answer|close|sign out|log ?out|apply|record|add|create|raise|send|confirm|yes|approve|reject|return|clear|reset|upload/i;
const JUNK = /\bNaN\b|\bundefined\b|Invalid Date|\[object Object\]|\bnull\b/;
const report = [];

const browser = await chromium.launch();
for (const user of users) {
  let s;
  try { s = await session(user); } catch (e) { console.log(user, "LOGIN FAIL", String(e).slice(0, 100)); continue; }
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(([a, r]) => { localStorage.setItem("silverline.access_token", a); localStorage.setItem("silverline.refresh_token", r); }, [s.access_token, s.refresh_token]);
  for (const path of pages) {
    const page = await ctx.newPage();
    const rec = { user, path, console: [], errors: [], bad: [], junk: [], leaks: [], clicked: 0, dialogs: 0 };
    page.on("console", (m) => { if (m.type() === "error") rec.console.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => rec.errors.push(String(e).slice(0, 160)));
    page.on("response", (r) => { const st = r.status(); if (st >= 400 && r.url().includes("/api/")) rec.bad.push(`${st} ${r.request().method()} ${r.url().replace(BASE, "").slice(0, 110)}`); });
    try {
      await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(800);
      const buttons = await page.locator("button:visible, [role=tab]:visible").all();
      for (const b of buttons.slice(0, 60)) {
        const label = ((await b.innerText().catch(() => "")) || (await b.getAttribute("aria-label").catch(() => "")) || "").trim();
        if (!label || DESTRUCTIVE.test(label)) continue;
        try {
          await b.click({ timeout: 2500 });
          rec.clicked++;
          await page.waitForTimeout(350);
          if (await page.locator("[role=dialog]:visible").count()) { rec.dialogs++; await page.keyboard.press("Escape"); await page.waitForTimeout(200); }
        } catch { /* covered or detached */ }
      }
      const text = await page.locator("body").innerText();
      for (const line of text.split("\n")) if (JUNK.test(line)) rec.junk.push(line.trim().slice(0, 100));
      if (observers.has(user)) {
        for (const re of [/₹/, /Rover|rover|QA-SVD-ROVER/, /Crew Member|Auth Person|surveyor/i, /claimed|milestone/i, /\b9\d{9}\b|98480/]) {
          const m = text.match(re); if (m) rec.leaks.push(`${re}: ${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\n/g, " ")}`);
        }
      }
    } catch (e) { rec.errors.push("NAV " + String(e.message).slice(0, 120)); }
    rec.junk = [...new Set(rec.junk)].slice(0, 6);
    await page.close();
    report.push(rec);
    const n = rec.console.length + rec.errors.length + rec.bad.length + rec.junk.length + rec.leaks.length;
    console.log(`${user.padEnd(19)} ${path.replace(P, "P").replace(F.villages.V1, "V1").replace(F.villages.V2, "V2").padEnd(44)} clicks=${rec.clicked} dialogs=${rec.dialogs} ${n ? "!! " + JSON.stringify({ c: rec.console.slice(0, 2), e: rec.errors.slice(0, 2), b: rec.bad.slice(0, 3), j: rec.junk.slice(0, 3), l: rec.leaks.slice(0, 3) }) : "ok"}`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync(`${process.env.HOME}/sl-e2e/svd/crawl-web.json`, JSON.stringify(report, null, 1));

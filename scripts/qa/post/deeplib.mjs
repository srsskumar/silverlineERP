// Shared helpers for the round-2 deep interaction walk.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

export const BASE = process.env.BASE ?? "http://34.131.134.217";

export function loadSession(name) {
  return JSON.parse(readFileSync(`.${name}.json`, "utf8"));
}

export async function openBrowser(sessionName) {
  const session = loadSession(sessionName);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem("silverline.access_token", a);
    localStorage.setItem("silverline.refresh_token", r);
  }, [session.access_token, session.refresh_token]);
  return { browser, ctx, session };
}

export function capture(page, rec) {
  page.on("console", m => { if (m.type() === "error") rec.console.push(m.text().slice(0, 400)); });
  page.on("pageerror", e => rec.pageErrors.push(String(e).slice(0, 400)));
  page.on("response", r => {
    const s = r.status();
    if (s >= 500) rec.serverErrors.push(`${s} ${r.request().method()} ${r.url().replace(BASE, "")}`);
  });
}

export function newRec() { return { console: [], pageErrors: [], serverErrors: [], notes: [] }; }

export const XSS_TEXT = `<script>window.__xssMark=(window.__xssMark||0)+1</script><img src=x onerror="window.__xssMark=(window.__xssMark||0)+2">`;
export const LONG_10K = "A".repeat(10000);
export const EMOJI_RTL = "🔥🚀 مرحبا بالعالم שלום עולם 测试";

export function summarize(name, rec) {
  const flags = rec.console.length + rec.pageErrors.length + rec.serverErrors.length;
  console.log(`\n== ${name} == ${flags ? "!! " + flags + " issue(s)" : "clean"}`);
  if (rec.console.length) console.log("  console:", rec.console.slice(0, 5));
  if (rec.pageErrors.length) console.log("  pageErrors:", rec.pageErrors.slice(0, 5));
  if (rec.serverErrors.length) console.log("  serverErrors:", rec.serverErrors.slice(0, 5));
  if (rec.notes.length) console.log("  notes:", rec.notes);
}

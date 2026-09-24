/**
 * D-014: the phone shows the same rupee figure the web shows, paise and all.
 *
 * Eight screens formatted money with maximumFractionDigits: 0, so an approver
 * on the phone saw Rs 1,500 for a claim of Rs 1,499.60 that the web showed to
 * the paisa; three more dropped a trailing zero (Rs 1,499.6). One formatter
 * now serves every screen, and a sweep keeps new screens from growing their
 * own.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMoney, formatMoneyOrNull } from "../src/money";

describe("formatMoney", () => {
  it("prints paise always, with Indian grouping, like the web money()", () => {
    assert.equal(formatMoney(1499.6), "₹1,499.60");
    assert.equal(formatMoney("123456.5"), "₹1,23,456.50");
    assert.equal(formatMoney(0), "₹0.00");
    assert.equal(formatMoney(12345678.9), "₹1,23,45,678.90");
    assert.equal(formatMoney(-2500.05), "-₹2,500.05");
    assert.equal(formatMoney(2.675), "₹2.68");
  });

  it("prints a dash for a value that is not there, not a made-up zero", () => {
    assert.equal(formatMoney(null), "—");
    assert.equal(formatMoney(undefined), "—");
    assert.equal(formatMoney(""), "—");
    assert.equal(formatMoney("abc"), "—");
  });

  it("formatMoneyOrNull hides an absent or zero figure", () => {
    assert.equal(formatMoneyOrNull(0), null);
    assert.equal(formatMoneyOrNull(null), null);
    assert.equal(formatMoneyOrNull(1499.6), "₹1,499.60");
  });
});

describe("no screen rounds money on its own", () => {
  it("has no local rupee formatter left in app/", () => {
    const dir = join(import.meta.dirname, "..", "app");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/\.tsx?$/.test(e.name)) files.push(join(d, e.name));
      }
    };
    walk(dir);
    const offenders = files.filter((f) => /₹\$\{[^}]*toLocaleString/.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders.map((f) => f.slice(dir.length + 1)), []);
  });
});

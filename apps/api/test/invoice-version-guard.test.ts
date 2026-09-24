/**
 * Every UPDATE invoices statement bumps version (task 5c fix round 2).
 *
 * invoices.version (migration 096) exists to guard PATCH /invoices/:id/lines
 * with If-Match — but a version column only guards anything while every
 * writer of the row keeps it honest. A route that changes on_hold,
 * disputed, lifecycle_status or match_status without bumping version leaves
 * a stale If-Match on the lines route passing against a read that is, in
 * every field but the lines themselves, already out of date.
 *
 * The first round of this fix bumped every UPDATE invoices statement that
 * existed at the time by hand, one at a time. That does nothing for the
 * next one somebody adds — which is exactly the failure mode the
 * coordinator's review caught (four pre-existing writers, none of them
 * bumping it, found only by grepping). This scans every route file instead
 * of trusting each future writer to remember, so a sixth UPDATE invoices
 * statement that forgets fails a test immediately rather than shipping a
 * silently-broken concurrency guard.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every `UPDATE invoices SET <clause> WHERE id` this codebase writes, found
 * by anchoring on the SQL keywords rather than the surrounding JS string
 * delimiter (single-quoted, double-quoted and template-literal SQL strings
 * are all used across these routes, and at least one clause itself
 * contains a single-quoted SQL literal — `match_status='UNMATCHED'` — which
 * would break a naive "capture up to the next quote" approach).
 */
function findInvoiceUpdates(text: string): { clause: string; index: number }[] {
  const re = /UPDATE\s+invoices\s+SET\s+([\s\S]*?)WHERE\s+id\s*=\s*\$1/gi;
  const matches: { clause: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) matches.push({ clause: m[1], index: m.index });
  return matches;
}

describe("invoices.version stays a real optimistic-concurrency guard", () => {
  it("has every UPDATE invoices statement in apps/api/src bump version", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const { clause, index } of findInvoiceUpdates(text)) {
        if (/version\s*=\s*version\s*\+\s*1/i.test(clause)) continue;
        const line = text.slice(0, index).split("\n").length;
        offenders.push(`${file.replace(srcDir, "src")}:${line}`);
      }
    }
    expect(offenders, `UPDATE invoices without version=version+1:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("actually finds statements to check (a change to how routes write SQL should not silently make this vacuous)", () => {
    let total = 0;
    for (const file of collectTsFiles(srcDir)) {
      total += findInvoiceUpdates(readFileSync(file, "utf8")).length;
    }
    // finance (cancel, dispute), inventory (lines PATCH), ledgers (hold),
    // procurement (match) -- five today. A lower count means the regex
    // stopped matching something it used to, which is as much a false
    // negative as a route that forgets the bump.
    expect(total).toBeGreaterThanOrEqual(5);
  });
});

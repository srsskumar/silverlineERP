/// <reference types="node" />
/**
 * validateExpenseClaim (src/validators.ts) — the cheap client-side pre-check
 * mirroring shared expenseClaimSchema's single-line-claim shape mobile submits.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateExpenseClaim } from "../src/validators";

function valid(overrides: Partial<Parameters<typeof validateExpenseClaim>[0]> = {}) {
  return validateExpenseClaim({
    claim_no: "EXP-001",
    claim_date: "2026-09-24",
    purpose: "Site visit",
    category: "TRAVEL",
    expense_date: "2026-09-24",
    description: "Cab fare",
    amount: 450,
    ...overrides,
  });
}

describe("validateExpenseClaim", () => {
  it("accepts a well-formed single-line claim", () => {
    assert.equal(valid().ok, true);
  });

  it("rejects a missing claim number", () => {
    const r = valid({ claim_no: "" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === "claim_no"));
  });

  it("rejects a claim number over 50 characters", () => {
    const r = valid({ claim_no: "x".repeat(51) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === "claim_no"));
  });

  it("rejects a malformed date", () => {
    assert.equal(valid({ claim_date: "24-09-2026" }).ok, false);
    assert.equal(valid({ expense_date: "not-a-date" }).ok, false);
  });

  it("rejects an unknown category", () => {
    const r = valid({ category: "MYSTERY" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === "category"));
  });

  it("rejects a zero or negative amount", () => {
    assert.equal(valid({ amount: 0 }).ok, false);
    assert.equal(valid({ amount: -5 }).ok, false);
    assert.equal(valid({ amount: "not-a-number" }).ok, false);
  });

  it("rejects an empty purpose or description", () => {
    assert.equal(valid({ purpose: "" }).ok, false);
    assert.equal(valid({ description: "" }).ok, false);
  });
});

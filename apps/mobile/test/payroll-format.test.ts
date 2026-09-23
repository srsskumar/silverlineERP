/// <reference types="node" />
/**
 * Pure display rules behind the Payroll (runs) screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { payrollPeriodLabel, payrollRunStatusTone } from "../src/payrollFormat";

describe("payrollRunStatusTone", () => {
  it("colours every PAYROLL_RUN_STATUSES value", () => {
    assert.equal(payrollRunStatusTone("OPEN"), "neutral");
    assert.equal(payrollRunStatusTone("VALIDATING"), "info");
    assert.equal(payrollRunStatusTone("CALCULATED"), "info");
    assert.equal(payrollRunStatusTone("REVIEW"), "warning");
    assert.equal(payrollRunStatusTone("APPROVED"), "warning");
    assert.equal(payrollRunStatusTone("LOCKED"), "success");
  });
});

describe("payrollPeriodLabel", () => {
  it("collapses a same-month period to one month/year", () => {
    assert.equal(payrollPeriodLabel("2026-09-01", "2026-09-30"), "1–30 Sep 2026");
  });

  it("names both months when a period spans two", () => {
    assert.equal(payrollPeriodLabel("2026-09-25", "2026-10-05"), "25 Sep–5 Oct 2026");
  });

  it("falls back to the raw strings on an unparseable date", () => {
    assert.equal(payrollPeriodLabel("not-a-date", "2026-09-30"), "not-a-date – 2026-09-30");
  });
});

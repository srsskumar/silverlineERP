/// <reference types="node" />
/**
 * Pure logic behind the My payslip screen (A-002,
 * docs/qa/2026-09-24/findings-a.md): month→period mapping, the two
 * documented "no slip" error codes GET /api/v1/payslips/me can 404 with,
 * and the slip's breakdown rows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isNoEmployeeLink,
  isNoPayslip,
  monthToPeriod,
  myPayslipSections,
} from "../src/myPayslip";

describe("monthToPeriod", () => {
  it("maps a YYYY-MM month to its first and last calendar day", () => {
    assert.deepEqual(monthToPeriod("2026-09"), {
      period_start: "2026-09-01",
      period_end: "2026-09-30",
    });
  });

  it("handles a 31-day month and February", () => {
    assert.deepEqual(monthToPeriod("2026-01"), {
      period_start: "2026-01-01",
      period_end: "2026-01-31",
    });
    assert.deepEqual(monthToPeriod("2026-02"), {
      period_start: "2026-02-01",
      period_end: "2026-02-28",
    });
  });

  it("is null for anything that isn't a valid YYYY-MM", () => {
    assert.equal(monthToPeriod(""), null);
    assert.equal(monthToPeriod("2026-13"), null);
    assert.equal(monthToPeriod("2026-9"), null);
    assert.equal(monthToPeriod("not-a-month"), null);
  });
});

describe("isNoPayslip / isNoEmployeeLink", () => {
  it("reads the server's error code, not the HTTP status alone", () => {
    assert.equal(isNoPayslip({ code: "NO_PAYSLIP", status: 404 }), true);
    assert.equal(isNoEmployeeLink({ code: "NO_EMPLOYEE_LINK", status: 404 }), true);
    assert.equal(isNoPayslip({ code: "NO_EMPLOYEE_LINK", status: 404 }), false);
    assert.equal(isNoEmployeeLink({ code: "NO_PAYSLIP", status: 404 }), false);
  });

  it("is false for an unrelated error, a plain Error, or no error at all", () => {
    assert.equal(isNoPayslip({ code: "REQUEST_FAILED", status: 500 }), false);
    assert.equal(isNoPayslip(new Error("network down")), false);
    assert.equal(isNoPayslip(null), false);
    assert.equal(isNoEmployeeLink(undefined), false);
  });
});

describe("myPayslipSections", () => {
  const slip = {
    earnings: { basic: 30000, per_day: 1000, payable_days: 30, present_days: 22, paid_off_days: 4 },
    deductions: { pf: 1800 },
    gross: 28000,
    total_deductions: 1800,
    net_pay: 26200,
  };

  it("formats money through formatMoney (two decimals, Indian grouping)", () => {
    const earnings = myPayslipSections(slip).find((s) => s.title === "Earnings")!;
    const byKey = Object.fromEntries(earnings.rows.map((r) => [r.key, r]));
    assert.equal(byKey.basic.value, "₹30,000.00");
    assert.equal(byKey.per_day.value, "₹1,000.00");
  });

  it("formats day counts as days, not money", () => {
    const days = myPayslipSections(slip).find((s) => s.title === "Days")!;
    const byKey = Object.fromEntries(days.rows.map((r) => [r.key, r]));
    assert.equal(byKey.payable_days.value, "30 days");
    assert.equal(byKey.present_days.value, "22 days");
  });

  it("includes a total-deductions row only when there are deductions", () => {
    const deductions = myPayslipSections(slip).find((s) => s.title === "Deductions")!;
    assert.deepEqual(deductions.rows.map((r) => r.key), ["pf", "total_deductions"]);
    assert.equal(deductions.rows[1].value, "₹1,800.00");

    const noDeductions = myPayslipSections({ ...slip, deductions: {} });
    assert.equal(noDeductions.find((s) => s.title === "Deductions"), undefined);
  });

  it("leaves out sections with nothing in them, including on an empty slip", () => {
    assert.deepEqual(myPayslipSections({ earnings: {}, deductions: {} }), []);
    assert.deepEqual(myPayslipSections({}), []);
  });

  it("puts loss of pay under information, not deductions, on a slip calculated after the LOP fix", () => {
    const withLop = {
      ...slip,
      deductions: { pf: 1800, lop_days: 2, lop_amount: 2000 },
    };
    const sections = myPayslipSections(withLop);
    const notes = sections.find((s) => s.title === "For information");
    const deductions = sections.find((s) => s.title === "Deductions")!;
    assert.ok(notes);
    assert.deepEqual(notes.rows.map((r) => r.value), ["₹2,000.00"]);
    assert.equal(deductions.rows.some((r) => r.key === "lop_amount"), false);
  });
});

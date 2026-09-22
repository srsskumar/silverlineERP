/**
 * The payslip card prints the slip, not only its last line.
 *
 * The payroll fix put Sundays and holidays on the slip as paid days
 * (paid_off_days) and moved loss of pay out of the deductions -- gross is
 * already the pay for the paid days, so the figure is information. The phone
 * printed net pay alone and none of that reached the person paid. The rows
 * come from the same grouping the web slip and the PDF use.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRupees, payslipSections } from "../src/ui/payslipRows";

const slip = {
  earnings: { basic: 30000, per_day: 1000, payable_days: 30, present_days: 22, paid_leave_days: 2, paid_off_days: 4 },
  deductions: { pf: 1800, lop_days: 2, lop_amount: 2000 },
  gross: 28000,
  total_deductions: 1800,
  net_pay: 26200,
};

describe("payslip sections", () => {
  it("shows the day counts as days, Sundays and holidays among them", () => {
    const days = payslipSections(slip).find((s) => s.title === "Days");
    assert.ok(days);
    const byKey = Object.fromEntries(days.rows.map((r) => [r.key, r]));
    assert.equal(byKey.paid_off_days.label, "Sundays and holidays (paid)");
    assert.equal(byKey.paid_off_days.value, "4 days");
    assert.equal(byKey.lop_days.label, "Loss-of-pay days");
    assert.equal(byKey.lop_days.value, "2 days");
    assert.equal(byKey.present_days.value, "22 days");
  });

  it("keeps loss of pay out of the deductions and under information on a corrected slip", () => {
    const sections = payslipSections(slip);
    const deductions = sections.find((s) => s.title === "Deductions");
    const notes = sections.find((s) => s.title === "For information");
    assert.ok(deductions && notes);
    assert.deepEqual(deductions.rows.map((r) => r.key), ["pf", "total_deductions"]);
    assert.equal(deductions.rows[1].value, "₹1,800.00");
    assert.deepEqual(notes.rows.map((r) => [r.label, r.value]), [
      ["Loss of pay (already excluded from gross)", "₹2,000.00"],
    ]);
  });

  it("shows a slip locked before the correction as it was paid, with loss of pay deducted", () => {
    const legacy = { ...slip, total_deductions: 3800, net_pay: 24200 };
    const sections = payslipSections(legacy);
    const deductions = sections.find((s) => s.title === "Deductions");
    assert.ok(deductions);
    assert.deepEqual(deductions.rows.map((r) => r.label), ["Provident fund", "Loss of pay", "Total deductions"]);
    assert.equal(sections.find((s) => s.title === "For information"), undefined);
  });

  it("prints rupees the way the slip does, and a dash for nothing", () => {
    assert.equal(formatRupees(123456.5), "₹1,23,456.50");
    assert.equal(formatRupees("26200"), "₹26,200.00");
    assert.equal(formatRupees(null), "—");
    assert.equal(formatRupees("x"), "—");
  });

  it("leaves out sections with nothing in them", () => {
    assert.deepEqual(payslipSections({ earnings: {}, deductions: {} }), []);
    assert.deepEqual(payslipSections({}).map((s) => s.title), []);
  });
});

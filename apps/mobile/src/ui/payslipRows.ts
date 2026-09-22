/**
 * What the payslip card prints, worked out from /payslips/me.
 *
 * The server stores earnings and deductions as flat bags in which day counts
 * sit beside rupee amounts, and lop_amount sits under deductions although it
 * is not deducted -- gross is already the pay for the paid days, so the
 * figure is information. The web slip and the PDF read those bags through
 * payslipView in @silverline/shared; the phone used to print the net figure
 * alone, so the day counts the payroll fix introduced (paid_off_days for
 * Sundays and holidays) and the loss-of-pay note never reached the person
 * they were about. Same function here, so the three cannot disagree.
 *
 * Dependency-free apart from the shared package, so the node test runner can
 * check it without React Native.
 */
import {
  formatPayslipDays,
  payslipView,
  type PayslipLine,
} from "@silverline/shared";

export interface PayslipRow {
  key: string;
  label: string;
  value: string;
}

export interface PayslipSection {
  title: string;
  rows: PayslipRow[];
}

/** The response shape of GET /api/v1/payslips/me, as far as the card reads it. */
export interface PayslipSummary {
  earnings?: Record<string, unknown> | null;
  deductions?: Record<string, unknown> | null;
  gross?: number | string | null;
  total_deductions?: number | string | null;
  net_pay?: number | string | null;
}

/** Rupees with the Indian grouping the slip itself uses: 1,23,456.00 */
export function formatRupees(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function row(line: PayslipLine): PayslipRow {
  return {
    key: line.key,
    label: line.label,
    value: line.kind === "days" ? formatPayslipDays(line.value) : formatRupees(line.value),
  };
}

/**
 * Sections in reading order; an empty section is left out so a slip without
 * a loss-of-pay note shows no "Notes" heading over nothing.
 */
export function payslipSections(slip: PayslipSummary): PayslipSection[] {
  const view = payslipView(slip.earnings, slip.deductions, slip.total_deductions);
  const sections: PayslipSection[] = [
    { title: "Days", rows: view.days.map(row) },
    { title: "Earnings", rows: view.rates.map(row) },
    {
      title: "Deductions",
      rows: [
        ...view.deductions.map(row),
        ...(view.deductions.length
          ? [{ key: "total_deductions", label: "Total deductions", value: formatRupees(slip.total_deductions) }]
          : []),
      ],
    },
    { title: "For information", rows: view.notes.map(row) },
  ];
  return sections.filter((s) => s.rows.length > 0);
}

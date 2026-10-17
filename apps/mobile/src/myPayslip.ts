/**
 * Pure logic behind the My payslip screen (A-002, docs/qa/2026-09-24/
 * findings-a.md): the month-to-period mapping for the picker, which of the
 * server's two documented "no slip" error codes a failed load actually is
 * (GET /api/v1/payslips/me?period_start=&period_end= — 404 NO_PAYSLIP /
 * NO_EMPLOYEE_LINK, apps/api/src/modules/payroll/routes.ts:1101-1183), and
 * the slip's breakdown rows.
 *
 * Grouping mirrors src/ui/payslipRows.ts (the More-tab card this screen
 * sits alongside) but formats money through `formatMoney` (D-014) rather
 * than that file's own `formatRupees` — this is new code, so it uses the
 * one money formatter every mobile screen is supposed to use rather than
 * adding a third reimplementation.
 *
 * Dependency-free apart from the shared package and money.ts, so the node
 * test runner can check it without a React Native runtime.
 */
import {
  payslipView,
  formatPayslipDays,
  type PayslipLine,
} from "@silverline/shared";
import { formatMoney } from "./money";

export interface MyPayslipPeriod {
  period_start: string;
  period_end: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-09" -> that calendar month's first/last day. Null for anything else. */
export function monthToPeriod(month: string): MyPayslipPeriod | null {
  if (!MONTH_RE.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    period_start: `${month}-01`,
    period_end: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

interface ApiErrorLike {
  code?: string | null;
}

function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? ((error as ApiErrorLike).code ?? null)
    : null;
}

/** 404 NO_PAYSLIP — nothing was calculated for this period. Expected, not a failure. */
export function isNoPayslip(error: unknown): boolean {
  return codeOf(error) === "NO_PAYSLIP";
}

/** 404 NO_EMPLOYEE_LINK — this account isn't linked to an employee record. */
export function isNoEmployeeLink(error: unknown): boolean {
  return codeOf(error) === "NO_EMPLOYEE_LINK";
}

export interface MyPayslipRow {
  key: string;
  label: string;
  value: string;
}

export interface MyPayslipSection {
  title: string;
  rows: MyPayslipRow[];
}

/** The response shape of GET /api/v1/payslips/me, as far as this screen reads it. */
export interface MyPayslipSummary {
  earnings?: Record<string, unknown> | null;
  deductions?: Record<string, unknown> | null;
  gross?: number | string | null;
  total_deductions?: number | string | null;
  net_pay?: number | string | null;
}

function row(line: PayslipLine): MyPayslipRow {
  return {
    key: line.key,
    label: line.label,
    value: line.kind === "days" ? formatPayslipDays(line.value) : formatMoney(line.value),
  };
}

/**
 * Sections in reading order; an empty section is left out so a slip with no
 * loss-of-pay note shows no "For information" heading over nothing.
 */
export function myPayslipSections(slip: MyPayslipSummary): MyPayslipSection[] {
  const view = payslipView(slip.earnings, slip.deductions, slip.total_deductions);
  const sections: MyPayslipSection[] = [
    { title: "Days", rows: view.days.map(row) },
    { title: "Earnings", rows: view.rates.map(row) },
    {
      title: "Deductions",
      rows: [
        ...view.deductions.map(row),
        ...(view.deductions.length
          ? [{ key: "total_deductions", label: "Total deductions", value: formatMoney(slip.total_deductions) }]
          : []),
      ],
    },
    { title: "For information", rows: view.notes.map(row) },
  ];
  return sections.filter((s) => s.rows.length > 0);
}

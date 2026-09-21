'use client';
import {DownloadButton} from './DownloadButton';

import { formatPayslipDays, payslipView, type PayslipLine } from '@silverline/shared';
import { inr, type MyPayslip } from '@/lib/payroll';
import { Button } from './ui/Button';

function MoneyRow({ label, value, bold }: { label: string; value: unknown; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <dt className={`text-sm ${bold ? 'font-semibold text-text' : 'text-text-muted'}`}>{label}</dt>
      <dd className={`font-mono text-sm ${bold ? 'font-semibold text-text' : 'text-text'}`}>
        {inr(value)}
      </dd>
    </div>
  );
}

/** A day count is a count, not an amount: "4.5 days", never "₹4.50". */
function LineRow({ line }: { line: PayslipLine }) {
  if (line.kind === 'money') return <MoneyRow label={line.label} value={line.value} />;
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <dt className="text-sm text-text-muted">{line.label}</dt>
      <dd className="font-mono text-sm text-text">{formatPayslipDays(line.value)}</dd>
    </div>
  );
}

function Section({ title, lines }: { title: string; lines: PayslipLine[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <dl className="mt-2 divide-y divide-border">
        {lines.length === 0 && <p className="py-1 text-sm text-text-muted">—</p>}
        {lines.map((line) => (
          <LineRow key={line.key} line={line} />
        ))}
      </dl>
    </div>
  );
}

/**
 * Full own-slip printable layout. P1 has no PDF export — the Print button
 * calls `window.print()` (hidden in print output via `print:` classes) and
 * the note tells the user to use the browser print-to-PDF instead.
 */
export function PayslipPrint({ slip }: { slip: MyPayslip }) {
  // Grouped by what each figure is; see payslipView for why lop_amount is a
  // note and not a deduction.
  const view = payslipView(slip.earnings, slip.deductions, slip.total_deductions);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Button onClick={() => window.print()}>Print</Button>
        <DownloadButton path={`/api/v1/payroll/payslips/${slip.id}/pdf`} name={`payslip-${slip.id}.pdf`} label="Download PDF" />
      </div>

      <div className="rounded-lg border border-border bg-surface p-4 sm:p-6 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="text-lg font-bold text-text">Payslip</h2>
            <p className="mt-0.5 font-mono text-xs text-text-muted">
              {slip.period?.start} → {slip.period?.end}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm font-semibold text-text">{slip.employee?.name}</p>
            <p className="font-mono text-xs text-text-muted">
              {slip.employee?.emp_no}
              {slip.employee?.designation ? ` · ${slip.employee.designation}` : ''}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Run: {slip.run_status} · v{slip.version}
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-6 sm:grid-cols-3">
          <Section title="Earnings" lines={view.rates} />
          <Section title="Days" lines={view.days} />
          <Section title="Deductions" lines={view.deductions} />
        </div>

        <dl className="mt-4 border-t border-border pt-3">
          <MoneyRow label="Gross" value={slip.gross} />
          <MoneyRow label="Total deductions" value={slip.total_deductions} />
          <MoneyRow label="Net pay" value={slip.net_pay} bold />
        </dl>

        {view.notes.length > 0 && (
          <dl className="mt-3 border-t border-border pt-3" data-testid="payslip-notes">
            {view.notes.map((line) => (
              <LineRow key={line.key} line={line} />
            ))}
            <p className="mt-1 text-xs text-text-subtle">
              Shown for information. Gross already covers only the paid days, so this is not
              deducted again.
            </p>
          </dl>
        )}

        <p className="mt-3 font-mono text-xs text-text-subtle">Slip ID: {slip.id}</p>
      </div>
    </div>
  );
}

'use client';
import {DownloadButton} from './DownloadButton';

import { inr, type MyPayslip } from '@/lib/payroll';
import { Button } from './ui/Button';

function MoneyRow({ label, value, bold }: { label: string; value: unknown; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <dt className={`text-sm ${bold ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>{label}</dt>
      <dd className={`font-mono text-sm ${bold ? 'font-semibold text-slate-900' : 'text-slate-800'}`}>
        {inr(value)}
      </dd>
    </div>
  );
}

function entriesOf(bucket: Record<string, number> | null | undefined): Array<[string, number]> {
  if (!bucket || typeof bucket !== 'object') return [];
  return Object.entries(bucket);
}

/**
 * Full own-slip printable layout. P1 has no PDF export — the Print button
 * calls `window.print()` (hidden in print output via `print:` classes) and
 * the note tells the user to use the browser print-to-PDF instead.
 */
export function PayslipPrint({ slip }: { slip: MyPayslip }) {
  const earnings = entriesOf(slip.earnings);
  const deductions = entriesOf(slip.deductions);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Button onClick={() => window.print()}>Print</Button>
        <DownloadButton path={`/api/v1/payroll/payslips/${slip.id}/pdf`} name={`payslip-${slip.id}.pdf`} label="Download PDF" />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Payslip</h2>
            <p className="mt-0.5 font-mono text-xs text-slate-600">
              {slip.period?.start} → {slip.period?.end}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm font-semibold text-slate-900">{slip.employee?.name}</p>
            <p className="font-mono text-xs text-slate-600">
              {slip.employee?.emp_no}
              {slip.employee?.designation ? ` · ${slip.employee.designation}` : ''}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Run: {slip.run_status} · v{slip.version}
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Earnings</h3>
            <dl className="mt-2 divide-y divide-slate-100">
              {earnings.length === 0 && <p className="py-1 text-sm text-slate-500">—</p>}
              {earnings.map(([k, v]) => (
                <MoneyRow key={k} label={k} value={v} />
              ))}
            </dl>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Deductions</h3>
            <dl className="mt-2 divide-y divide-slate-100">
              {deductions.length === 0 && <p className="py-1 text-sm text-slate-500">—</p>}
              {deductions.map(([k, v]) => (
                <MoneyRow key={k} label={k} value={v} />
              ))}
            </dl>
          </div>
        </div>

        <dl className="mt-4 border-t border-slate-200 pt-3">
          <MoneyRow label="Gross" value={slip.gross} />
          <MoneyRow label="Total deductions" value={slip.total_deductions} />
          <MoneyRow label="Net pay" value={slip.net_pay} bold />
        </dl>

        <p className="mt-3 font-mono text-xs text-slate-400">Slip ID: {slip.id}</p>
      </div>
    </div>
  );
}

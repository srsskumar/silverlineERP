import Link from '@/components/AppLink';
import { inr, type PayslipRow } from '@/lib/payroll';
import { EmptyState } from './ui/EmptyState';

/**
 * Run payslip summary table (gross / deductions / net per employee).
 * P1 has no admin full-slip endpoint, so rows show summary columns only —
 * the employee cell links to the employee directory entry, not a slip
 * detail page (see README P1 gap note).
 */
export function PayslipTable({ rows }: { rows: PayslipRow[] }) {
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        title="No payslips yet"
        description="Payslip rows appear after the run is calculated. Full-slip detail is available to each employee on their own /my-payslip page."
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-slate-600">Employee</th>
            <th className="px-3 py-2 text-right font-medium text-slate-600">Gross</th>
            <th className="px-3 py-2 text-right font-medium text-slate-600">Deductions</th>
            <th className="px-3 py-2 text-right font-medium text-slate-600">Net pay</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2">
                {r.employee_id ? (
                  <Link
                    href={`/employees/${r.employee_id}`}
                    className="font-mono text-xs text-brand-600 hover:underline"
                    title={`${r.employee_name} (${r.emp_no})`}
                  >
                    {r.emp_no} · {r.employee_name}
                  </Link>
                ) : (
                  <span className="font-mono text-xs text-slate-800">
                    {r.emp_no} · {r.employee_name}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-slate-800">{inr(r.gross)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs text-slate-800">{inr(r.total_deductions)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-900">
                {inr(r.net_pay)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

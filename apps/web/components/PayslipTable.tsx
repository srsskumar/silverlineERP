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
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full divide-y divide-border bg-surface text-sm">
        <thead className="bg-surface-sunken">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-text-muted">Employee</th>
            <th className="px-3 py-2 text-right font-medium text-text-muted">Gross</th>
            <th className="px-3 py-2 text-right font-medium text-text-muted">Deductions</th>
            <th className="px-3 py-2 text-right font-medium text-text-muted">Net pay</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2">
                {r.employee_id ? (
                  <Link
                    href={`/employees/${r.employee_id}`}
                    className="font-mono text-xs text-primary hover:underline"
                    title={`${r.employee_name} (${r.emp_no})`}
                  >
                    {r.emp_no} · {r.employee_name}
                  </Link>
                ) : (
                  <span className="font-mono text-xs text-text">
                    {r.emp_no} · {r.employee_name}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-text">{inr(r.gross)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs text-text">{inr(r.total_deductions)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-text">
                {inr(r.net_pay)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

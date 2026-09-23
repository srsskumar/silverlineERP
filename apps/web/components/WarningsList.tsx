import { warningTone, type PayrollWarning } from '@/lib/payroll';
import { PersonName } from './PersonName';
import { Badge } from './ui/Badge';

/**
 * Calculation warnings (e.g. NO_RECORDS — employee had no attendance rows;
 * NO_SALARY — employee has no salary on file). Empty lists render a quiet
 * all-clear line rather than nothing.
 *
 * The person is named where the run recorded a name; a run calculated
 * before warnings carried one still shows the id, shortened, with the whole
 * of it on hover.
 */
export function WarningsList({ warnings }: { warnings: PayrollWarning[] }) {
  if (!warnings || warnings.length === 0) {
    return <p className="text-sm text-text-muted">No warnings — every employee had attendance and salary data.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {warnings.map((w, i) => (
        <li
          // Warnings carry no stable id — code + employee + index is the best key.
          key={`${w.code}-${w.employee_id ?? 'run'}-${i}`}
          className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2"
        >
          <Badge tone={warningTone(String(w.code))}>{String(w.code)}</Badge>
          <span className="min-w-0 flex-1 text-sm text-text">{String(w.message || '—')}</span>
          {w.employee_id ? (
            <PersonName
              id={String(w.employee_id)}
              name={w.employee_name ?? null}
              empNo={w.emp_no ?? null}
              className="text-xs text-text-muted"
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

'use client';

import { RUN_STATUS_FLOW, runStatusIndex } from '@/lib/payroll';

/**
 * Run state-machine stepper: OPEN → VALIDATING → CALCULATED → REVIEW →
 * APPROVED → LOCKED. Steps before the current one render done, the current
 * one renders highlighted, later ones render pending. Unknown statuses render
 * all-pending with a fallback note.
 */
export function RunTimeline({ status }: { status: string }) {
  const current = runStatusIndex(status);
  return (
    <div>
      <ol aria-label="Payroll run progress" className="flex flex-wrap items-center gap-1">
        {RUN_STATUS_FLOW.map((step, i) => {
          const done = current >= 0 && i < current;
          const isCurrent = i === current;
          return (
            <li key={step} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true" className="mx-1 text-slate-300">→</span>}
              <span
                aria-current={isCurrent ? 'step' : undefined}
                title={isCurrent ? `Current state: ${step}` : step}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
                  isCurrent
                    ? 'bg-slate-900 text-white ring-slate-900'
                    : done
                      ? 'bg-green-100 text-green-800 ring-green-200'
                      : 'bg-slate-50 text-slate-500 ring-slate-200'
                }`}
              >
                {done && <span aria-hidden="true">✓</span>}
                {step}
              </span>
            </li>
          );
        })}
      </ol>
      {current < 0 && (
        <p role="note" className="mt-2 text-xs text-slate-500">
          Unknown status “{status}” — the server owns the state machine; this run predates the known flow.
        </p>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Reopening requires a reason. Choose recalculation to return to OPEN and repeat approval; otherwise the run returns to APPROVED. Previous payslip versions remain in history.
      </p>
    </div>
  );
}

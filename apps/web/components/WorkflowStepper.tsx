import { TaskStatusBadge } from './TaskStatusBadge';

const STEPS = ['TO_DO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const;

function stepLabel(step: string): string {
  switch (step) {
    case 'TO_DO':
      return 'To do';
    case 'IN_PROGRESS':
      return 'In progress';
    case 'IN_REVIEW':
      return 'In review';
    case 'DONE':
      return 'Done';
    default:
      return step;
  }
}

/**
 * Visual task workflow: TO_DO → IN_PROGRESS → IN_REVIEW → DONE with the
 * current step highlighted. BLOCKED/CANCELLED are side states — the linear
 * track renders dimmed with the side state called out beside it.
 */
export function WorkflowStepper({ status }: { status: string }) {
  const idx = STEPS.indexOf(status as (typeof STEPS)[number]);
  const onTrack = idx >= 0;
  const sideState = !onTrack ? status : null;

  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Task workflow" className="flex flex-wrap items-center gap-1 sm:gap-2">
        {STEPS.map((step, i) => {
          const done = onTrack && i < idx;
          const current = onTrack && i === idx;
          return (
            <li key={step} className="flex items-center gap-1 sm:gap-2">
              <span
                aria-current={current ? 'step' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
                  current
                    ? 'bg-slate-900 text-white ring-slate-900'
                    : done
                      ? 'bg-green-50 text-green-800 ring-green-300'
                      : 'bg-white text-slate-500 ring-slate-300'
                } ${!onTrack ? 'opacity-60' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                    current ? 'bg-white text-slate-900' : done ? 'bg-green-600 text-white' : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                {stepLabel(step)}
              </span>
              {i < STEPS.length - 1 && (
                <span aria-hidden="true" className="text-slate-300">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {sideState ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-slate-500">Side state:</span>
          <TaskStatusBadge status={sideState} />
          {sideState === 'BLOCKED' && (
            <span className="text-xs text-amber-800">Resolve the blockers below, then move the task forward.</span>
          )}
          {sideState === 'CANCELLED' && (
            <span className="text-xs text-slate-500">Cancelled is terminal — no further transitions.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

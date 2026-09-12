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
                    ? 'bg-primary text-primary-fg ring-primary'
                    : done
                      ? 'bg-success-subtle text-success ring-success/40'
                      : 'bg-surface text-text-muted ring-border'
                } ${!onTrack ? 'opacity-60' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                    current ? 'bg-surface text-text' : done ? 'bg-success text-white' : 'bg-border text-text-subtle'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                {stepLabel(step)}
              </span>
              {i < STEPS.length - 1 && (
                <span aria-hidden="true" className="text-text-subtle">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {sideState ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-text-muted">Side state:</span>
          <TaskStatusBadge status={sideState} />
          {sideState === 'BLOCKED' && (
            <span className="text-xs text-warning">Resolve the blockers below, then move the task forward.</span>
          )}
          {sideState === 'CANCELLED' && (
            <span className="text-xs text-text-muted">Cancelled is terminal — no further transitions.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

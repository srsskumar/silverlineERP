import { Badge } from './ui/Badge';
import { isTerminalTaskStatus, toneForTaskStatus } from '@/lib/tasks';

/**
 * Task status badge (TO_DO/IN_PROGRESS/IN_REVIEW/DONE/BLOCKED/CANCELLED;
 * neutral fallback). Terminal states (DONE/CANCELLED) render emphasized
 * (semibold + tooltip).
 */
export function TaskStatusBadge({ status }: { status: string }) {
  const terminal = isTerminalTaskStatus(status);
  return (
    <span
      className={terminal ? 'inline-flex font-semibold' : 'inline-flex'}
      title={terminal ? `${status} — terminal state` : undefined}
    >
      <Badge tone={toneForTaskStatus(status)}>{status}</Badge>
    </span>
  );
}

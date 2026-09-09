import { Badge } from './ui/Badge';
import { isTerminalProjectStatus, toneForProjectStatus } from '@/lib/projects';

/**
 * Project status badge (DRAFT/ACTIVE/ON_HOLD/COMPLETED_PENDING_CLOSE/
 * CLOSED/CANCELLED; neutral fallback). Terminal states (CLOSED/CANCELLED)
 * render emphasized (semibold + tooltip).
 */
export function ProjectStatusBadge({ status }: { status: string }) {
  const terminal = isTerminalProjectStatus(status);
  return (
    <span
      className={terminal ? 'inline-flex font-semibold' : 'inline-flex'}
      title={terminal ? `${status} — terminal state` : undefined}
    >
      <Badge tone={toneForProjectStatus(status)}>{status}</Badge>
    </span>
  );
}

import { Badge } from './ui/Badge';
import { toneForRunStatus } from '@/lib/payroll';

/** Payroll run status badge (OPEN/VALIDATING/CALCULATED/REVIEW/APPROVED/LOCKED; neutral fallback). */
export function RunStatusBadge({ status }: { status: string }) {
  return <Badge tone={toneForRunStatus(status)}>{status}</Badge>;
}

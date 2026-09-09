import { Badge } from './ui/Badge';
import { toneForLeaveStatus } from '@/lib/leave';

/** Leave request status badge (PENDING/APPROVED/REJECTED/CANCELLED; neutral fallback). */
export function LeaveStatusBadge({ status }: { status: string }) {
  return <Badge tone={toneForLeaveStatus(status)}>{status}</Badge>;
}

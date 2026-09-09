import { Badge } from './ui/Badge';
import type { PunchResult } from '@/lib/attendance';

/**
 * Punch-outcome badge: ACCEPTED (201) / APPLIED replay (200) /
 * REQUIRES_REVIEW (202, with routing code).
 */
export function DecisionBadge({ result }: { result: PunchResult }) {
  if (result.kind === 'accepted') return <Badge tone="success">ACCEPTED</Badge>;
  if (result.kind === 'applied') return <Badge tone="info">APPLIED (replay)</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="warning">REQUIRES_REVIEW</Badge>
      <span className="font-mono text-xs text-slate-600">{result.code}</span>
    </span>
  );
}

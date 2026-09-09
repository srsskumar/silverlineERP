import { Badge } from './ui/Badge';
import { isAttention, slaLabel, toneForSla } from '@/lib/sla';

/**
 * SLA badge (ON_SCHEDULE/AT_RISK/OVERDUE; neutral fallback). Renders nothing
 * when the task carries no sla_status (pre-S5 rows). Attention states
 * (AT_RISK/OVERDUE) render with a title hint.
 */
export function SlaBadge({ status }: { status: unknown }) {
  if (status == null || status === '') return null;
  const s = String(status);
  const attention = isAttention(s);
  return (
    <span
      className={attention ? 'inline-flex font-semibold' : 'inline-flex'}
      title={attention ? `${s} — needs attention` : undefined}
    >
      <Badge tone={toneForSla(s)}>{slaLabel(s)}</Badge>
    </span>
  );
}

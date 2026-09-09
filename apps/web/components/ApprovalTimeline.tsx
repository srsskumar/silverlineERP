'use client';

import { Badge } from './ui/Badge';
import type { ApprovalStep } from '@/lib/leave';

function toneForStep(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'APPROVED') return 'success';
  if (status === 'REJECTED') return 'danger';
  if (status === 'PENDING') return 'warning';
  return 'neutral';
}

/** Shorten a user id for display (full id kept in the title tooltip). */
export function shortUserId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Approval chain timeline. The contract returns approver *user ids* only
 * (no names — there is no users endpoint), so steps show short ids.
 */
export function ApprovalTimeline({ chain }: { chain: ApprovalStep[] }) {
  if (chain.length === 0) {
    return <p className="text-sm text-slate-500">No approval steps recorded yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-0">
      {chain.map((s, i) => (
        <li
          key={`${s.step}-${s.approver_user_id}-${i}`}
          className="flex gap-3 border-l-2 border-slate-200 pb-4 pl-4 last:pb-0"
        >
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-500">Step {s.step}</span>
              <Badge tone={toneForStep(String(s.status))}>{String(s.status)}</Badge>
              <span className="font-mono text-xs text-slate-700" title={s.approver_user_id}>
                {shortUserId(s.approver_user_id)}
              </span>
              {s.decided_at ? (
                <span className="text-xs text-slate-500">{String(s.decided_at)}</span>
              ) : null}
            </div>
            {s.note ? <p className="text-sm text-slate-700">{String(s.note)}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

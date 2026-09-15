'use client';

import { Badge } from './ui/Badge';
import type { ApprovalStep } from '@/lib/leave';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { listPeople, peopleIndex, personLabel } from '@/lib/people';

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
 * Approval chain timeline.
 *
 * The contract returns approver user ids; the names come from the employee
 * directory. A step that says "3f9a2b1c…" tells a reader nothing about who is
 * holding up their request.
 */
export function ApprovalTimeline({ chain }: { chain: ApprovalStep[] }) {
  const people = useQuery({ queryKey: ['people'], queryFn: listPeople, staleTime: 300_000 });
  const index = React.useMemo(() => peopleIndex(people.data ?? []), [people.data]);
  if (chain.length === 0) {
    return <p className="text-sm text-text-muted">No approval steps recorded yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-0">
      {chain.map((s, i) => (
        <li
          key={`${s.step}-${s.approver_user_id}-${i}`}
          className="flex gap-3 border-l-2 border-border pb-4 pl-4 last:pb-0"
        >
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-text-muted">Step {s.step}</span>
              <Badge tone={toneForStep(String(s.status))}>{String(s.status)}</Badge>
              <span className="text-xs font-medium text-text" title={s.approver_user_id}>
                {personLabel(index, s.approver_user_id)}
              </span>
              {s.decided_at ? (
                <span className="text-xs text-text-muted">{String(s.decided_at)}</span>
              ) : null}
            </div>
            {s.note ? <p className="text-sm text-text-muted">{String(s.note)}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

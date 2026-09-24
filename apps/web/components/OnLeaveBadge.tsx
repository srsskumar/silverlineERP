import * as React from 'react';
import { Badge } from '@/components/ui/Badge';

/**
 * "On leave today", as a badge — not a status (owner decision 2026-09-24 #2).
 *
 * The employee's `status` field stays ACTIVE/SUSPENDED/EXITED/DRAFT; whether
 * they are on leave today is derived instead, on the server, from approved
 * leave covering the organisation's current day (`on_leave_today` on the
 * list/detail response). Rendered as nothing at all when false, so an
 * ordinary working day adds no visual noise to the directory.
 */
export function OnLeaveBadge({ onLeaveToday }: { onLeaveToday?: boolean | null }) {
  if (!onLeaveToday) return null;
  return (
    <Badge tone="info" size="sm" data-testid="on-leave-today-badge">
      On leave today
    </Badge>
  );
}

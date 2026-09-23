import * as React from 'react';
import { Badge } from './ui/Badge';

/**
 * Record status badge. Unknown statuses fall back to a neutral badge
 * (contract tolerates server-side vocabulary drift).
 */
export function AttendanceStatusBadge({ status }: { status: string }) {
  let tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' = 'neutral';
  switch (status) {
    case 'PRESENT':
      tone = 'success';
      break;
    case 'PARTIAL':
      tone = 'warning';
      break;
    case 'ABSENT':
      tone = 'danger';
      break;
    default:
      tone = 'neutral';
  }
  return <Badge tone={tone}>{status}</Badge>;
}

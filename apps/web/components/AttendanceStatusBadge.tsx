import * as React from 'react';
import { Badge } from './ui/Badge';

/**
 * Record status badge. Unknown statuses fall back to a neutral badge
 * (contract tolerates server-side vocabulary drift).
 */
export function AttendanceStatusBadge({
  status,
  violation,
}: {
  status: string;
  violation?: boolean | null;
}) {
  let tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' = 'neutral';
  switch (status) {
    case 'PRESENT':
      tone = 'success';
      break;
    case 'PARTIAL':
      tone = 'warning';
      break;
    case 'ABSENT':
    case 'VIOLATION':
      tone = 'danger';
      break;
    default:
      tone = 'neutral';
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tone}>{status}</Badge>
      {violation ? (
        <Badge tone="warning" >
          <span title="Geofence violation flagged on this record">⚠ geofence</span>
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * S5 SLA helpers (frozen contract).
 *
 * Task list/detail items gain `sla_status: ON_SCHEDULE|AT_RISK|OVERDUE`.
 * GET /tasks gains `sla=overdue|at_risk|on_schedule` (lowercase filter value;
 * the stored status stays UPPER_SNAKE). This module is pure (unit-tested).
 */

export type SlaStatus = 'ON_SCHEDULE' | 'AT_RISK' | 'OVERDUE';

/** Canonical SLA vocabulary (upper-snake as stored on the task). */
export const SLA_VALUES = ['ON_SCHEDULE', 'AT_RISK', 'OVERDUE'] as const;

/** Lowercase filter values accepted by GET /tasks?sla=. */
export const SLA_FILTER_VALUES = ['on_schedule', 'at_risk', 'overdue'] as const;
export type SlaFilter = (typeof SLA_FILTER_VALUES)[number];

export const slaBadgeTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ON_SCHEDULE: 'success',
  AT_RISK: 'warning',
  OVERDUE: 'danger',
};

export function toneForSla(status: unknown): 'success' | 'warning' | 'danger' | 'neutral' {
  if (typeof status !== 'string') return 'neutral';
  return slaBadgeTone[status] ?? 'neutral';
}

/** Human-readable badge text for an sla_status value. */
export const SLA_BADGE_LABEL: Record<string, string> = {
  ON_SCHEDULE: 'On schedule',
  AT_RISK: 'At risk',
  OVERDUE: 'Overdue',
};

export function slaLabel(status: unknown): string {
  if (typeof status !== 'string' || status.length === 0) return '—';
  return SLA_BADGE_LABEL[status] ?? String(status);
}

/** True when the SLA needs attention (at risk or overdue). */
export function isAttention(sla: unknown): boolean {
  return sla === 'AT_RISK' || sla === 'OVERDUE';
}

/** True only for overdue tasks (my-work "Overdue mine" section). */
export function isOverdue(sla: unknown): boolean {
  return sla === 'OVERDUE';
}

/** Map a stored UPPER_SNAKE status to its lowercase `sla=` filter value. */
export function slaToFilter(status: string): SlaFilter | undefined {
  if (status === 'ON_SCHEDULE') return 'on_schedule';
  if (status === 'AT_RISK') return 'at_risk';
  if (status === 'OVERDUE') return 'overdue';
  return undefined;
}

/** Map a lowercase `sla=` filter value back to the stored status. */
export function slaFilterToStatus(filter: string): SlaStatus | undefined {
  if (filter === 'on_schedule') return 'ON_SCHEDULE';
  if (filter === 'at_risk') return 'AT_RISK';
  if (filter === 'overdue') return 'OVERDUE';
  return undefined;
}

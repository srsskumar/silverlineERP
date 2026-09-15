/**
 * Presentation for land survey progress (§59).
 *
 * The rule running through all of it: a percentage that has no denominator is
 * shown as unknown, never as a number. The screens this replaces show 0% for
 * "no target recorded", and somebody acts on that.
 */

export const REPORT_LEVELS = ['village', 'mandal', 'division', 'district', 'programme'] as const;
export type ReportLevel = (typeof REPORT_LEVELS)[number];

export const LEVEL_LABELS: Record<ReportLevel, string> = {
  village: 'Village',
  mandal: 'Mandal',
  division: 'Division',
  district: 'District',
  programme: 'Whole programme',
};

export const VILLAGE_STATE_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
};

export const STAGE_STATE_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  ON_HOLD: 'On hold',
};

export function stateTone(state: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (state === 'COMPLETED') return 'success';
  if (state === 'IN_PROGRESS') return 'warning';
  if (state === 'ON_HOLD') return 'danger';
  return 'neutral';
}

/**
 * A percentage, or a statement that there is nothing to divide by.
 *
 * Returning the string rather than a number forces every caller to render the
 * unknown case, which is the whole point: `0%` and "we never set a target"
 * look identical once a number is formatted.
 */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'No target set';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

/** Whether a percentage is real enough to draw a bar for. */
export function hasPct(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

/** How far a completion bar is filled, capped only for drawing. */
export function barWidth(value: number | null | undefined): number {
  if (!hasPct(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * The tone of a completion figure.
 *
 * Over 100 is its own case rather than "green, only greener". An overshoot
 * means the estimate was wrong, and that is worth seeing rather than
 * celebrating.
 */
export function pctTone(value: number | null | undefined): 'default' | 'success' | 'warning' | 'danger' {
  if (!hasPct(value)) return 'default';
  if (value > 100) return 'warning';
  if (value >= 100) return 'success';
  if (value >= 50) return 'default';
  return 'warning';
}

/** Acres, with the unit, or an em dash where none is recorded. */
export function acres(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Ac`;
}

export function sqKm(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 3 })} km²`;
}

/** A plain count, grouped the Indian way. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Math.round(value).toLocaleString('en-IN');
}

/**
 * Measures grouped under the headings the entry sheet uses.
 *
 * The workbook this replaces has merged header cells — "Government lands"
 * spanning parcels, points and extent. Keeping that grouping is what makes
 * the form recognisable to somebody who has filled the sheet in for a year.
 */
export function groupMeasures<T extends { code: string; group_label?: string | null; label: string }>(
  measures: T[],
): Array<{ group: string; items: T[] }> {
  const groups: Array<{ group: string; items: T[] }> = [];
  for (const m of measures) {
    const group = m.group_label || 'Other';
    const existing = groups.find(g => g.group === group);
    if (existing) existing.items.push(m);
    else groups.push({ group, items: [m] });
  }
  return groups;
}

/**
 * What the headline figure means, in a sentence.
 *
 * Counts of villages not started are stated separately from the percentage,
 * because a programme at 60% with a third of its villages never visited is a
 * different situation from one at 60% with work under way everywhere.
 */
export function progressHeadline(total: {
  villages: number; notStarted: number; inProgress: number; completed: number;
  overallPct: number | null; unweighted: number;
} | undefined): string {
  if (!total || total.villages === 0) return 'No villages are listed in this programme yet.';
  const parts: string[] = [];
  parts.push(total.overallPct === null
    ? `${total.villages} villages listed. No extent is recorded, so there is nothing to measure completion against.`
    : `${pct(total.overallPct)} of the extent surveyed across ${total.villages} villages.`);
  if (total.completed > 0) parts.push(`${total.completed} finished.`);
  if (total.notStarted > 0) {
    parts.push(`${total.notStarted} not started — nobody has visited ${total.notStarted === 1 ? 'it' : 'them'} yet.`);
  }
  if (total.unweighted > 0) {
    parts.push(`${total.unweighted} ${total.unweighted === 1 ? 'village has' : 'villages have'} no extent recorded and ${total.unweighted === 1 ? 'is' : 'are'} left out of the percentage.`);
  }
  return parts.join(' ');
}

/** The default reporting window: the current Indian financial year to date. */
export function financialYearToDate(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return { from: `${start}-04-01`, to: today };
}

export const GRAINS = [
  { value: 'DAY', label: 'Daily' },
  { value: 'WEEK', label: 'Weekly' },
  { value: 'MONTH', label: 'Monthly' },
  { value: 'YEAR', label: 'Yearly' },
] as const;

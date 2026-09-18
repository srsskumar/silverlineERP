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
  // Two decimals: a hundredth of a square kilometre is two and a half acres,
  // which is finer than any village extent is actually known to.
  return `${value.toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })} km²`;
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

/**
 * The reasons a rover sat idle or a day produced little.
 *
 * Mirrors the server's list. Kept here as a constant rather than fetched
 * because the form has to render before any request completes, and a
 * dropdown that fills in late is one people click through empty.
 */
export const DELAY_REASON_OPTIONS = [
  { code: 'WEATHER', label: 'Weather' },
  { code: 'ACCESS', label: 'Local or access issue' },
  { code: 'EQUIPMENT', label: 'Equipment problem' },
  { code: 'ROVER', label: 'Rover issue' },
  { code: 'DATA_TECHNICAL', label: 'Data or technical issue' },
  { code: 'EMPLOYEE', label: 'Employee issue' },
  { code: 'FIELD_CONDITIONS', label: 'Field conditions' },
  { code: 'DEPENDENCY', label: 'Dependency on another team' },
  { code: 'NO_DEPT_STAFF', label: 'No departmental staff' },
  { code: 'OTHER', label: 'Other' },
] as const;

/**
 * Reasons the server records itself, which nobody picks from a form.
 *
 * A punch replayed from the offline queue with no return filed is accepted
 * and stamped with this, so the day appears on the chase list rather than
 * vanishing. It reads as an explanation, because that is what it is.
 */
const SYSTEM_REASONS: Record<string, string> = {
  UNFILED_OFFLINE: 'Punched out without signal; return never filed',
};

export function reasonLabel(code: string | null | undefined): string {
  return DELAY_REASON_OPTIONS.find(r => r.code === code)?.label
    ?? (code ? SYSTEM_REASONS[code] : undefined)
    ?? String(code ?? '—');
}

export const VILLAGE_STATUS_LABELS: Record<string, string> = {
  TO_DO: 'To do',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  ON_HOLD: 'On hold',
  REWORK: 'Rework',
};

export function villageStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'REWORK' || status === 'ON_HOLD') return 'danger';
  if (status === 'IN_PROGRESS') return 'warning';
  return 'neutral';
}

export const BOTTLENECK_LABELS: Record<string, string> = {
  NOT_STARTED_BY_PLAN: 'Not started by its planned date',
  STAGE_OVERDUE: 'Sitting in one stage too long',
  PAST_EXPECTED_COMPLETION: 'Past the date it was expected to finish',
  ROVERS_IDLE: 'Rovers allocated and idle',
  NO_PROGRESS_RECORDED: 'Nothing recorded for days',
  IN_REWORK: 'Sent back for rework',
};

/**
 * What the forecast means, said so the two dates cannot be confused.
 *
 * The required pace is the half worth leading with: "you are behind" invites
 * argument, a number does not.
 */
export function forecastNote(f: {
  state: string; targetDate: string | null; forecastDate: string | null;
  currentPaceAcPerDay: number | null; requiredPaceAcPerDay: number | null;
  slipDays: number | null;
} | undefined): string {
  if (!f) return 'No forecast available.';
  if (f.state === 'NO_PACE') return 'Not enough recorded progress to project a finish date.';
  if (f.state === 'NO_TARGET') {
    return f.forecastDate
      ? `At the current pace the work finishes around ${f.forecastDate}. No target date has been set to compare it with.`
      : 'No target date has been set.';
  }
  const gap = Math.abs(f.slipDays ?? 0);
  const direction = f.state === 'BEHIND' ? 'later than' : f.state === 'AHEAD' ? 'ahead of' : 'on';
  const lead = f.state === 'ON_TRACK'
    ? `On track to finish on ${f.targetDate}.`
    : `Projected to finish ${gap} day${gap === 1 ? '' : 's'} ${direction} the ${f.targetDate} target.`;
  if (f.requiredPaceAcPerDay !== null && f.currentPaceAcPerDay !== null) {
    return `${lead} Current pace ${f.currentPaceAcPerDay} acres a day; ${f.requiredPaceAcPerDay} a day would hit the target.`;
  }
  return lead;
}

export const GRAINS = [
  { value: 'DAY', label: 'Daily' },
  { value: 'WEEK', label: 'Weekly' },
  { value: 'MONTH', label: 'Monthly' },
  { value: 'YEAR', label: 'Yearly' },
] as const;

/* ---------------------------------------------------- the stage pipeline */

/**
 * How a stage tally reads.
 *
 * The four states are shown in the order work moves through them — not
 * started, in progress, on hold, completed — so a row can be scanned left to
 * right as a queue rather than read as four unrelated numbers.
 */
export const TALLY_ORDER = ['notStarted', 'inProgress', 'onHold', 'completed'] as const;
export type TallyKey = (typeof TALLY_ORDER)[number];

export const TALLY_LABELS: Record<TallyKey, string> = {
  notStarted: 'To start',
  inProgress: 'In progress',
  onHold: 'On hold',
  completed: 'Done',
};

export function tallyTone(key: TallyKey): 'neutral' | 'warning' | 'danger' | 'success' {
  if (key === 'completed') return 'success';
  if (key === 'onHold') return 'danger';
  if (key === 'inProgress') return 'warning';
  return 'neutral';
}

/** A stage code as a readable label, falling back to the code itself. */
export function stageLabel(code: string, pipeline?: Array<{ code: string; label: string }>): string {
  return pipeline?.find(s => s.code === code)?.label
    ?? code.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
}

/**
 * What the rover position means, in a sentence.
 *
 * Idle is the number worth saying out loud. Thirty allocated and eleven used
 * is not eleven rovers of progress, it is nineteen sitting in a store while
 * the schedule assumes otherwise.
 */
export function roverNote(rovers: {
  allocated: number; used: number; idle: number;
  utilisationPct: number | null; overUsed: boolean;
} | undefined): string {
  if (!rovers || rovers.allocated === 0) {
    return 'No rovers are allocated for this date.';
  }
  if (rovers.overUsed) {
    return `${rovers.used} rovers reported in use against ${rovers.allocated} allocated. `
      + 'Something is being run that is not on the books — check the allocations.';
  }
  if (rovers.idle === 0) return `All ${rovers.allocated} rovers were in use.`;
  return `${rovers.idle} of ${rovers.allocated} rovers sat idle — ${pct(rovers.utilisationPct)} utilised.`;
}

/**
 * The pace, stated so the two rates cannot be confused.
 *
 * A schedule built on how fast a crew works and delivered on how fast the
 * work actually goes is how a programme slips without anybody watching it.
 */
export function paceNote(p: {
  activeDays: number; acresPerActiveDay: number | null;
  acresPerCalendarDay: number | null; projectedFinish: string | null;
} | undefined): string {
  /*
   * Nothing recorded means nothing to measure.
   *
   * A null rate was the only case this caught, and a programme with no
   * returns at all comes back with a rate of zero rather than null — which
   * produced "— acres a day on the 0 days work was actually recorded", a
   * sentence about a measurement nobody has taken. Zero worked days is the
   * honest test.
   */
  if (!p || p.acresPerCalendarDay === null || p.activeDays === 0) {
    return 'Not enough recorded progress yet to measure a pace.';
  }
  // "on the 1 days work was recorded" is what a template does to a sentence
  // when the number can be one.
  const days = p.activeDays === 1 ? 'the one day' : `the ${p.activeDays} days`;
  const parts = [
    `${p.acresPerCalendarDay} acres a day across the calendar, and `
    + `${p.acresPerActiveDay ?? '—'} on ${days} work was actually recorded.`,
  ];
  if (p.projectedFinish) {
    parts.push(`At that rate the remaining extent runs out around ${p.projectedFinish}.`);
  }
  return parts.join(' ');
}

/* ----------------------------------------------------------- period report */

export interface PeriodComparison {
  current: number;
  previous: number;
  change: number;
  changePct: number | null;
  direction: 'UP' | 'DOWN' | 'FLAT';
}

/**
 * The change, said in words next to the figure.
 *
 * A percentage is only offered when there was something to compare against.
 * The first week of a programme has not improved by any percentage, and
 * "+100%" against a start from nothing is the kind of number that ends up in
 * a review slide meaning nothing.
 */
export function changeHint(c: PeriodComparison | undefined): string {
  if (!c) return '';
  if (c.direction === 'FLAT') return 'Unchanged from the previous period';
  const word = c.direction === 'UP' ? 'up' : 'down';
  const size = Math.abs(c.change).toFixed(2).replace(/\.00$/, '');
  return c.changePct === null
    ? `${size} Ac ${word}; nothing recorded in the previous period`
    : `${size} Ac ${word} (${Math.abs(c.changePct)}%) on the previous period`;
}

/**
 * The sentence at the top of the report.
 *
 * Says what happened and whether it is better or worse than last time, in the
 * order somebody reads it. A report that opens with a table makes everybody
 * do this arithmetic in their head, and they do it differently.
 */
export function periodNote(d: {
  period?: { label?: string };
  area?: PeriodComparison;
  effort?: { active_days?: number; calendar_days?: number; villages_worked?: number };
} | undefined): string {
  if (!d?.area) return 'Nothing has been recorded for this period.';
  const { area, effort } = d;
  if (area.current === 0) {
    return effort?.active_days
      ? 'Returns were filed in this period but no extent was recorded against them.'
      : 'No day’s return falls inside this period.';
  }
  const worked = effort?.active_days ?? 0;
  const villages = effort?.villages_worked ?? 0;
  const head = `${acres(area.current)} surveyed over ${worked} working `
    + `${worked === 1 ? 'day' : 'days'} across ${villages} `
    + `${villages === 1 ? 'village' : 'villages'}.`;
  if (area.direction === 'FLAT') return `${head} The same as the previous period.`;
  const word = area.direction === 'UP' ? 'more' : 'less';
  return area.changePct === null
    ? `${head} Nothing was recorded in the previous period to compare against.`
    : `${head} That is ${Math.abs(area.changePct)}% ${word} than the previous period.`;
}

/**
 * The acres a village has actually been surveyed for, as against its extent.
 *
 * The extent is what the revenue record says the village is; the surveyed
 * figure is what the crews have walked and measured. They differ, sometimes
 * a lot — that difference is the work remaining, and showing only one of the
 * two numbers hides it.
 */
export function surveyedExtent(
  village: { done?: Record<string, unknown> | null },
  measures: Array<{ code: string; basis?: string | null }>,
): number {
  const done = village.done ?? {};
  return measures
    .filter((m) => String(m.basis) === 'EXTENT')
    .reduce((total, m) => total + Number(done[m.code] ?? 0), 0);
}

/**
 * What a village's stage is, read the way the rest of the module reads it.
 *
 * A stage nobody has recorded anything against has not started, which is a
 * state rather than an absence — the village list filters on it and the
 * roll-up counts it.
 */
export function stageStateOf(
  village: { stages?: Record<string, string> | null }, code: string,
): string {
  return String(village.stages?.[code] ?? 'NOT_STARTED');
}

/**
 * The stage state each tally column counts.
 *
 * The roll-up names them for a reader — "To start", "Done" — and the village
 * list filters on the states the records actually hold. One map, so a count
 * and the list it opens can never disagree about what was counted.
 */
export const TALLY_STATES: Record<string, string> = {
  notStarted: 'NOT_STARTED',
  inProgress: 'IN_PROGRESS',
  onHold: 'ON_HOLD',
  completed: 'COMPLETED',
};

/* ------------------------------------------------- stepping through periods */

/**
 * The day that lands you in the period before or after this one.
 *
 * The report is fetched for whatever period contains an "as at" date, which
 * is exact but makes moving to last week a date-picker exercise. Stepping by
 * a period is what people actually want, and the step has to be big enough to
 * clear the current period whatever its length: a week back from any day in
 * a week is in the week before, and 31 days back from any day in a month is
 * in the month before — but 30 is not, for a 31-day month.
 */
export function stepPeriod(
  asOf: string, grain: 'DAY' | 'WEEK' | 'MONTH', direction: -1 | 1,
): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return asOf;
  if (grain === 'DAY') d.setUTCDate(d.getUTCDate() + direction);
  else if (grain === 'WEEK') d.setUTCDate(d.getUTCDate() + 7 * direction);
  else {
    // Stepping by a calendar month, not by 30 days: the 31st going back a
    // month would otherwise skip February entirely.
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + direction);
    // Clamp to the last day this month has — 31 January back a month is 28
    // or 29 February, not 2 or 3 March.
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  }
  return d.toISOString().slice(0, 10);
}

/** What each grain's period is called when stepping through them. */
export const PERIOD_NOUNS: Record<string, string> = {
  DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year',
};

/* ------------------------------------------------ billing milestones (§066) */

/** What each answer in the billing picker is asking for. */
export const BILLING_FILTERS = [
  { value: '', label: 'Any billing state' },
  { value: 'NONE', label: 'Nothing submitted' },
  { value: 'ANY', label: 'Something submitted' },
  { value: 'DUE_1', label: 'First milestone due' },
  { value: 'HAS_1', label: 'First milestone submitted' },
  { value: 'DUE_2', label: 'Second milestone due' },
  { value: 'HAS_2', label: 'Second milestone submitted' },
  { value: 'DUE_3', label: 'Third milestone due' },
  { value: 'HAS_3', label: 'Third milestone submitted' },
  { value: 'ALL', label: 'Fully claimed' },
] as const;

/**
 * Whether a village answers a billing question.
 *
 * "Due" is the subtle one: the second milestone is due when the first has
 * gone in and the second has not. A village where nothing has been claimed is
 * not owed a second claim — it is owed a first — and a list that said
 * otherwise would put villages into a claim out of order, which the
 * department returns.
 *
 * `claimed` holds only the milestones standing: a returned claim is off it,
 * because the milestone is owed again.
 */
export function matchesBillingFilter(claimed: number[], filter: string): boolean {
  if (!filter) return true;
  if (filter === 'NONE') return claimed.length === 0;
  if (filter === 'ANY') return claimed.length > 0;
  if (filter === 'ALL') return [1, 2, 3].every((m) => claimed.includes(m));
  const m = Number(filter.slice(4));
  if (!Number.isFinite(m) || m < 1) return true;
  if (filter.startsWith('HAS_')) return claimed.includes(m);
  if (filter.startsWith('DUE_')) {
    if (claimed.includes(m)) return false;
    for (let prior = 1; prior < m; prior += 1) {
      if (!claimed.includes(prior)) return false;
    }
    return true;
  }
  return true;
}

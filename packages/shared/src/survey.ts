import { z } from 'zod';
import type { RoleCode } from './rbac.js';
import type { TaskStatus } from './s4.js';
import { businessDay } from './india.js';

/**
 * Land survey progress (§59).
 *
 * A DGPS cadastral resurvey run village by village. Crews record what they
 * did today; somebody upstream needs to know how much of a mandal, a
 * division, a district or the whole programme is done.
 *
 * Three things here exist because the spreadsheet this replaces gets them
 * wrong: cumulative totals are derived rather than typed, roll-ups are
 * weighted by extent rather than averaged, and a percentage with no
 * denominator is reported as unknown rather than as zero.
 */

/* ------------------------------------------------------------------ units */

/**
 * One acre in square kilometres.
 *
 * The survey extent arrives in acres and is reported in both. Holding the two
 * in separate columns is how they come to disagree, so the second is always
 * derived from the first.
 */
export const SQ_KM_PER_ACRE = 0.0040468564224;

export function acresToSqKm(acres: number): number {
  return round(acres * SQ_KM_PER_ACRE, 4);
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/* --------------------------------------------------------------- measures */

export const MEASURE_UNITS = ['POINTS', 'PARCELS', 'ACRES', 'COUNT'] as const;
export type MeasureUnit = (typeof MEASURE_UNITS)[number];

/**
 * What a measure's completion is divided by.
 *
 * `EXTENT` — the village's total extent in acres, known from the master list.
 * `TARGET` — a figure recorded per village, because the total is not knowable
 *            in advance. A count of boundary points is like this.
 * `NONE`   — the quantity is worth recording and does not express progress
 *            towards anything. Reporting a percentage for it would be
 *            inventing one.
 */
export const MEASURE_BASIS = ['EXTENT', 'TARGET', 'NONE'] as const;
export type MeasureBasis = (typeof MEASURE_BASIS)[number];

export interface MeasureSeed {
  code: string;
  label: string;
  groupLabel: string;
  unit: MeasureUnit;
  basis: MeasureBasis;
  displayOrder: number;
}

/**
 * The measures the existing sheet already keeps.
 *
 * Seeded rather than hard-coded as columns: the request is explicit that more
 * get added on the fly, and a new measure should be a row rather than a
 * migration.
 */
export const MEASURE_SEEDS: MeasureSeed[] = [
  { code: 'VILLAGE_BOUNDARY_POINTS', label: 'Points', groupLabel: 'Village boundary', unit: 'POINTS', basis: 'TARGET', displayOrder: 10 },
  { code: 'HABITATION_BOUNDARY_POINTS', label: 'Points', groupLabel: 'Habitation boundary', unit: 'POINTS', basis: 'TARGET', displayOrder: 20 },
  { code: 'GOVT_LAND_PARCELS', label: 'Land parcels arrived', groupLabel: 'Government lands', unit: 'PARCELS', basis: 'TARGET', displayOrder: 30 },
  { code: 'GOVT_LAND_POINTS', label: 'Points', groupLabel: 'Government lands', unit: 'POINTS', basis: 'NONE', displayOrder: 31 },
  { code: 'GOVT_LAND_EXTENT_AC', label: 'Extent', groupLabel: 'Government lands', unit: 'ACRES', basis: 'EXTENT', displayOrder: 32 },
  { code: 'PRIVATE_LAND_PARCELS', label: 'Land parcels arrived', groupLabel: 'Private lands', unit: 'PARCELS', basis: 'TARGET', displayOrder: 40 },
  { code: 'PRIVATE_LAND_POINTS', label: 'Points', groupLabel: 'Private lands', unit: 'POINTS', basis: 'NONE', displayOrder: 41 },
  { code: 'PRIVATE_LAND_EXTENT_AC', label: 'Extent', groupLabel: 'Private lands', unit: 'ACRES', basis: 'EXTENT', displayOrder: 42 },
  { code: 'RECORDS_PREPARED', label: 'Records prepared', groupLabel: 'Preparation of records', unit: 'COUNT', basis: 'TARGET', displayOrder: 50 },
  { code: 'NOTICES_9_2_SERVED', label: '9(2) notices served', groupLabel: 'Notices', unit: 'COUNT', basis: 'TARGET', displayOrder: 60 },
  { code: 'LPMS_GENERATED', label: 'LPMs generated', groupLabel: 'Output', unit: 'COUNT', basis: 'TARGET', displayOrder: 70 },
];

export const MEASURE_CODES = MEASURE_SEEDS.map(m => m.code);

/* ---------------------------------------------------------------- stages */

export const STAGE_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD'] as const;
export type StageState = (typeof STAGE_STATES)[number];

export interface StageSeed { code: string; label: string; displayOrder: number }

/**
 * The stages the summary sheet tracks as states rather than quantities.
 *
 * Ground truthing and vectorization are either done or not; counting them
 * would say nothing. They carry start and completion dates because the
 * summary reports both.
 */
export interface StageSeedOrdered extends StageSeed {
  requires?: string;
  /** Daily progress is recorded against this stage. */
  tracksDailyProgress?: boolean;
  /**
   * Not a step on the forward sequence.
   *
   * Rework is the case: it is entered from wherever the work failed rather
   * than reached in order, and it is not something every village passes
   * through. Counting it as a step would mean no village ever completed,
   * because a village that never needed rework never completes it.
   */
  offSequence?: boolean;
}

export const STAGE_PIPELINE: StageSeedOrdered[] = [
  { code: 'GROUND_TRUTHING', label: 'Ground truthing', displayOrder: 10, tracksDailyProgress: true },
  { code: 'GT_QC', label: 'GT quality check', displayOrder: 20, requires: 'GROUND_TRUTHING' },
  { code: 'VECTORIZATION', label: 'Vectorization', displayOrder: 30, requires: 'GT_QC' },
  { code: 'VECTORIZATION_QC', label: 'Vectorization QC', displayOrder: 40, requires: 'VECTORIZATION' },
  { code: 'RECORDS_PREPARATION', label: 'Records preparation', displayOrder: 50, requires: 'VECTORIZATION_QC' },
  { code: 'LPM_GENERATION', label: 'LPM generation', displayOrder: 60, requires: 'RECORDS_PREPARATION' },
  { code: 'SUBMISSION', label: 'Submission of deliverables', displayOrder: 70, requires: 'LPM_GENERATION' },
  // Entered from wherever the work failed rather than reached in sequence, so
  // it waits on nothing. A village that comes back has a start and an end
  // like any other work, and the history has to show it happened.
  { code: 'REWORK', label: 'Rework', displayOrder: 80, offSequence: true },
];

/**
 * The same list, in the shape the seed writes.
 *
 * One list rather than two. They were two briefly, and the seed quietly
 * overwrote what the migration had just written — GT QC vanished from every
 * freshly seeded database.
 */
export const STAGE_SEEDS: StageSeed[] = STAGE_PIPELINE.map(
  ({ code, label, displayOrder }) => ({ code, label, displayOrder }));

export const STAGE_CODES = STAGE_SEEDS.map(s => s.code);

/* ------------------------------------------------------------ completion */

export const VILLAGE_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'] as const;
export type VillageState = (typeof VILLAGE_STATES)[number];

/**
 * How far along one measure is.
 *
 * `pct` is null when there is nothing to divide by. That is a deliberate
 * third answer: zero would read as "nothing done" and a hundred as
 * "finished", and both would be fabricated from the absence of a target.
 */
export interface Completion {
  done: number;
  target: number | null;
  pct: number | null;
  /** True when a target exists and the work has reached it. */
  complete: boolean;
}

export function completion(done: number, target: number | null | undefined): Completion {
  const d = round(done);
  if (target === null || target === undefined || target <= 0) {
    return { done: d, target: target === undefined ? null : target ?? null, pct: null, complete: false };
  }
  const t = round(target);
  return {
    done: d,
    target: t,
    // Not capped at 100. Overshoot is real — a village can turn out to hold
    // more parcels than the estimate — and hiding it behind a capped bar is
    // how a bad estimate goes unnoticed for a year.
    pct: round((d / t) * 100),
    complete: d >= t,
  };
}

/* -------------------------------------------------------------- roll-ups */

export interface VillageProgress {
  villageId: string;
  /** Total extent in acres — the weight, and the extent-based denominator. */
  extentAc: number | null;
  /** Cumulative quantity per measure code, as at the reporting date. */
  done: Record<string, number>;
  /** Target per measure code where one is recorded. */
  targets?: Record<string, number>;
  /** Stage states, by stage code. */
  stages?: Record<string, StageState>;
}

/**
 * What a village's state is, derived.
 *
 * Complete means every stage is complete — not "the extent adds up", because
 * a village whose parcels are all surveyed but whose records are not prepared
 * is not finished, and reporting it as finished is how the programme looks
 * further along than it is.
 */
export function villageState(v: VillageProgress, stageCodes: string[]): VillageState {
  const stages = v.stages ?? {};
  // Off-sequence stages are excluded from "every stage complete". Rework is
  // the case: a village that never needed it would otherwise never complete,
  // because it never completes a stage it never entered.
  const offSequence = new Set(
    STAGE_PIPELINE.filter(s => s.offSequence).map(s => s.code));
  const counted = stageCodes.filter(c => !offSequence.has(c));
  const known = counted.map(c => stages[c] ?? 'NOT_STARTED');
  if (known.length > 0 && known.every(s => s === 'COMPLETED')) return 'COMPLETED';

  // A village in rework has started, whatever the forward stages say.
  const anyStageStarted = known.some(s => s !== 'NOT_STARTED')
    || stageCodes.some(c => offSequence.has(c) && (stages[c] ?? 'NOT_STARTED') !== 'NOT_STARTED');
  const anyQuantity = Object.values(v.done).some(q => q > 0);
  return anyStageStarted || anyQuantity ? 'IN_PROGRESS' : 'NOT_STARTED';
}

export interface RollUp {
  villages: number;
  notStarted: number;
  inProgress: number;
  completed: number;
  /** Total extent of the villages in scope, in acres. */
  extentAc: number;
  extentSqKm: number;
  /** Extent actually surveyed, in acres — government plus private. */
  surveyedAc: number;
  /** Per measure: the weighted position across the villages in scope. */
  measures: Record<string, Completion>;
  /**
   * Extent-weighted completion across every extent-based measure.
   *
   * Null when no village in scope carries an extent, because then there is no
   * honest weight and an unweighted mean would be presented as if there were.
   */
  overallPct: number | null;
  /** Villages counted in the figures above that carry no extent. */
  unweighted: number;
}

const EXTENT_MEASURES = ['GOVT_LAND_EXTENT_AC', 'PRIVATE_LAND_EXTENT_AC'];

/**
 * Aggregate villages into one figure.
 *
 * Quantities are summed and *then* divided, which is the whole point: a
 * mandal's completion is its total done over its total target, not the mean
 * of its villages' percentages. Averaging counts a five-acre village equally
 * with a five-hundred-acre one, and every level above the village inherits
 * the error.
 */
export function rollUp(
  villages: VillageProgress[],
  measureCodes: string[],
  stageCodes: string[] = STAGE_CODES,
  basisByCode: Record<string, MeasureBasis> = {},
): RollUp {
  const out: RollUp = {
    villages: villages.length,
    notStarted: 0, inProgress: 0, completed: 0,
    extentAc: 0, extentSqKm: 0, surveyedAc: 0,
    measures: {}, overallPct: null, unweighted: 0,
  };

  for (const v of villages) {
    const state = villageState(v, stageCodes);
    if (state === 'NOT_STARTED') out.notStarted += 1;
    if (state === 'IN_PROGRESS') out.inProgress += 1;
    if (state === 'COMPLETED') out.completed += 1;
    if (v.extentAc === null || v.extentAc === undefined) out.unweighted += 1;
    else out.extentAc += v.extentAc;
    for (const code of EXTENT_MEASURES) out.surveyedAc += v.done[code] ?? 0;
  }

  out.extentAc = round(out.extentAc);
  out.extentSqKm = acresToSqKm(out.extentAc);
  out.surveyedAc = round(out.surveyedAc);

  for (const code of measureCodes) {
    let done = 0, target = 0, anyTarget = false;
    for (const v of villages) {
      done += v.done[code] ?? 0;
      // An extent-based measure is divided by the village's own extent; a
      // target-based one by whatever was recorded for it.
      const t = basisByCode[code] === 'EXTENT' ? v.extentAc : v.targets?.[code];
      if (t !== null && t !== undefined && t > 0) { target += t; anyTarget = true; }
    }
    out.measures[code] = completion(done, anyTarget ? target : null);
  }

  // The headline: total extent surveyed over total extent to survey. It uses
  // the same denominator as every extent-based measure, so the headline and
  // the detail cannot disagree.
  const extentTarget = villages.reduce(
    (t, v) => t + (v.extentAc ?? 0), 0);
  out.overallPct = extentTarget > 0 ? round((out.surveyedAc / extentTarget) * 100) : null;

  return out;
}

/* ---------------------------------------------------------------- periods */

export const PERIOD_GRAINS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
export type PeriodGrain = (typeof PERIOD_GRAINS)[number];

export interface Period { from: string; to: string; label: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function utc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Split a date range into reporting periods.
 *
 * Weeks start on Monday, which is what a survey week means in the field and
 * what every progress review in India assumes. The first and last periods are
 * clipped to the requested range rather than spilling outside it: a report
 * asked for "1st to 15th" must not quietly include the 16th.
 */
export function periodBuckets(from: string, to: string, grain: PeriodGrain): Period[] {
  if (to < from) return [];
  const out: Period[] = [];
  let cursor = utc(from);
  const end = utc(to);

  while (cursor <= end) {
    let periodEnd: Date;
    let label: string;
    const y = cursor.getUTCFullYear(), m = cursor.getUTCMonth(), d = cursor.getUTCDate();

    if (grain === 'DAY') {
      periodEnd = new Date(Date.UTC(y, m, d));
      label = iso(cursor);
    } else if (grain === 'WEEK') {
      // Monday start: getUTCDay() is 0 for Sunday, so Sunday ends the week.
      const dow = cursor.getUTCDay();
      const daysToSunday = dow === 0 ? 0 : 7 - dow;
      periodEnd = new Date(Date.UTC(y, m, d + daysToSunday));
      label = `Week of ${iso(cursor)}`;
    } else if (grain === 'MONTH') {
      periodEnd = new Date(Date.UTC(y, m + 1, 0));
      label = `${MONTHS[m]} ${y}`;
    } else {
      periodEnd = new Date(Date.UTC(y, 11, 31));
      label = String(y);
    }

    const clipped = periodEnd > end ? end : periodEnd;
    out.push({ from: iso(cursor), to: iso(clipped), label });
    cursor = new Date(clipped.getTime() + 86_400_000);
  }
  return out;
}

/**
 * The whole period of this grain that a date falls inside.
 *
 * Distinct from periodBuckets, which clips to the range asked for. A report
 * for "this week" means the whole week, Monday to Sunday, even when it is run
 * on Wednesday -- clipping it would silently answer a different question and
 * make every week-on-week comparison meaningless.
 */
export function periodContaining(on: string, grain: PeriodGrain): Period {
  const d = utc(on);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();

  if (grain === 'DAY') return { from: on, to: on, label: on };
  if (grain === 'WEEK') {
    // Monday start, as in the field and in every Indian progress review.
    const dow = d.getUTCDay();
    const back = dow === 0 ? 6 : dow - 1;
    const start = new Date(Date.UTC(y, m, day - back));
    const end = new Date(Date.UTC(y, m, day - back + 6));
    return { from: iso(start), to: iso(end), label: `Week of ${iso(start)}` };
  }
  if (grain === 'MONTH') {
    return {
      from: iso(new Date(Date.UTC(y, m, 1))),
      to: iso(new Date(Date.UTC(y, m + 1, 0))),
      label: `${MONTHS[m]} ${y}`,
    };
  }
  return {
    from: iso(new Date(Date.UTC(y, 0, 1))),
    to: iso(new Date(Date.UTC(y, 11, 31))),
    label: String(y),
  };
}

/**
 * The period before this one.
 *
 * A figure on its own is not a report. "Four hundred acres this week" means
 * nothing until it sits beside last week's, and the comparison is the only
 * part anybody acts on.
 */
export function previousPeriod(period: Period, grain: PeriodGrain): Period {
  const dayBefore = iso(new Date(utc(period.from).getTime() - 86_400_000));
  return periodContaining(dayBefore, grain);
}

/**
 * How one period compares with the one before it.
 *
 * `changePct` is null rather than zero or infinite when the previous period
 * produced nothing: the first week of a programme has not improved by any
 * percentage, and printing "+100%" against a start from nothing is the kind
 * of number that ends up in a review slide meaning nothing.
 */
export function comparePeriods(current: number, previous: number): {
  current: number; previous: number; change: number; changePct: number | null;
  direction: 'UP' | 'DOWN' | 'FLAT';
} {
  const change = current - previous;
  return {
    current, previous, change,
    changePct: previous > 0
      ? Math.round((change / previous) * 1000) / 10
      : null,
    direction: change > 0 ? 'UP' : change < 0 ? 'DOWN' : 'FLAT',
  };
}

/**
 * The Indian financial year containing a date, as a range.
 *
 * Government survey programmes are budgeted and reviewed on the financial
 * year, so "this year" in a progress review means April to March.
 */
export function financialYearRange(on: string): Period {
  const d = utc(on);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return {
    from: `${start}-04-01`,
    to: `${start + 1}-03-31`,
    label: `FY ${start}-${String(start + 1).slice(2)}`,
  };
}

/* ------------------------------------------------------ why a day went badly */

/**
 * The reasons a rover sat idle or a day produced little.
 *
 * One list for both, because in the field they are the same causes: the
 * weather that stopped the rover is the weather that stopped the crew. Two
 * lists would drift and make the two reports incomparable.
 *
 * `OTHER` is last and demands remarks. A free-text reason on every row would
 * be unanalysable; a fixed list with no escape hatch gets the nearest wrong
 * option picked, which is worse than the truth in a sentence.
 */
export const DELAY_REASONS = [
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

export const DELAY_REASON_CODES = DELAY_REASONS.map(r => r.code);
export type DelayReason = (typeof DELAY_REASONS)[number]['code'];

export function delayReasonLabel(code: string | null | undefined): string {
  return DELAY_REASONS.find(r => r.code === code)?.label ?? String(code ?? '—');
}

/** Remarks are required when the reason is "other" — otherwise nothing is said. */
export function reasonNeedsRemarks(code: string | null | undefined): boolean {
  return code === 'OTHER';
}

/* --------------------------------------------------------- rover day status */

export const ROVER_DAY_STATUSES = ['UTILIZED', 'IDLE'] as const;
export type RoverDayStatus = (typeof ROVER_DAY_STATUSES)[number];

export interface RoverDayEntry {
  assetId: string;
  status: RoverDayStatus;
  idleReason?: string | null;
  remarks?: string | null;
  areaAc?: number | null;
}

/**
 * What is wrong with a day's rover returns, in words.
 *
 * Returns an empty list when the day is properly accounted for. The rules are
 * the specification's: an idle rover must say why, and "other" must say what.
 */
export function checkRoverDay(rows: RoverDayEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.assetId)) {
      problems.push('The same rover is reported twice on one day.');
    }
    seen.add(row.assetId);

    if (row.status === 'IDLE') {
      if (!row.idleReason) {
        problems.push('An idle rover must say why it was idle.');
      } else if (!DELAY_REASON_CODES.includes(row.idleReason as DelayReason)) {
        problems.push(`"${row.idleReason}" is not a reason this system knows.`);
      } else if (reasonNeedsRemarks(row.idleReason) && !row.remarks?.trim()) {
        problems.push('An idle rover recorded as "other" must say what happened.');
      }
    }
    if (row.status === 'UTILIZED' && row.idleReason) {
      problems.push('A rover in use cannot also carry an idle reason.');
    }
  }
  return problems;
}

/* --------------------------------------------------------------- schemas */

/** Whether a YYYY-MM-DD string names a day the calendar actually has. */
function realDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isoDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  // The shape is not the same thing as a date: 2026-13-01 and 2026-02-30 both
  // match the pattern, and reach Postgres as something it refuses with a 500
  // rather than a message anybody can act on. Round-tripping through Date is
  // what separates a real calendar date from a well-formed string.
  .refine(realDate, 'That is not a real date');

/**
 * A date that has already happened, in Indian time.
 *
 * A day's return is a measurement, and work that has not been done yet cannot
 * be measured. Left open, tomorrow's figure lands in the cumulative and every
 * pace and forecast downstream quietly becomes a prediction wearing the
 * clothes of a record.
 *
 * Compared against the Indian business day rather than UTC: a crew filing at
 * half past midnight in Vijayawada is filing on today's date, and UTC still
 * thinks it is yesterday evening.
 */
const pastDate = isoDate.refine(
  // A date that is not a real date is already being reported as one, and
  // "2026-13-01 has not happened yet" on top of that reads as nonsense.
  // Each refusal should name one thing wrong with the value.
  s => !realDate(s) || s <= businessDay(),
  'That date has not happened yet',
);
/**
 * The largest number these columns can hold.
 *
 * Every quantity, area and target is numeric(14,4) — ten digits before the
 * decimal point. Anything bigger reached Postgres, overflowed the column and
 * came back as a 500 with a stack trace, where what the caller needs is a
 * sentence about the field. .finite() is not a bound: 1e308 is perfectly
 * finite and still a hundred times more acres than there are on Earth.
 */
const MAX_QUANTITY = 9_999_999_999;
const TOO_BIG = 'That is larger than this field can hold — check the units and the decimal point';

const quantity = z.number().finite()
  .min(0, 'A quantity cannot be negative')
  .max(MAX_QUANTITY, TOO_BIG);

export const surveyProjectSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  project_id: z.string().uuid().nullable().optional(),
  started_on: isoDate.nullable().optional(),
  target_completion_on: isoDate.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  /**
   * The workspace the paired project belongs to.
   *
   * Optional: with one workspace there is nothing to choose, and asking
   * would be a question with one answer. Only an organisation running
   * several has to say which.
   */
  workspace_id: z.string().uuid().optional(),
  /**
   * Whether to create and link a project alongside the programme.
   *
   * On by default. A survey programme without a project cannot put its work
   * on a board, assign a task to anybody or carry planned dates — and
   * creating the two separately and remembering to link them is a step
   * people forget, then wonder why the board is empty.
   */
  create_project: z.boolean().default(true),
});

/**
 * Adding one village by hand (enhancement note 3).
 *
 * Either an existing location by id, or a name and the mandal it sits in --
 * which is what somebody adding a single village actually has. Requiring the
 * location to exist first means creating it on another screen and coming
 * back, for the one case where a bulk import is not worth opening.
 */
export const surveyVillageCreateSchema = z.object({
  village_id: z.string().uuid().optional(),
  village_name: z.string().trim().min(1).max(255).optional(),
  village_code: z.string().trim().min(1).max(64).optional(),
  /** The mandal it belongs to. Required when creating by name. */
  mandal_id: z.string().uuid().optional(),
  total_extent_ac: z.number().finite().positive().max(MAX_QUANTITY, TOO_BIG).nullable().optional(),
  dgps_base: z.number().int().min(0).optional(),
  dgps_rovers: z.number().int().min(0).optional(),
  teams: z.number().int().min(0).optional(),
  vill_code_old: z.string().max(64).nullable().optional(),
}).refine(v => v.village_id || (v.village_name && v.village_code && v.mandal_id), {
  message: 'Give an existing village, or a name, code and mandal to create one',
  path: ['village_name'],
});

/** Editing what the programme records about a village it already has. */
export const surveyVillageEditSchema = z.object({
  village_name: z.string().trim().min(1).max(255).optional(),
  total_extent_ac: z.number().finite().positive().max(MAX_QUANTITY, TOO_BIG).nullable().optional(),
  dgps_base: z.number().int().min(0).optional(),
  dgps_rovers: z.number().int().min(0).optional(),
  teams: z.number().int().min(0).optional(),
  vill_code_old: z.string().max(64).nullable().optional(),
});

export const surveyVillageSchema = z.object({
  village_id: z.string().uuid(),
  total_extent_ac: z.number().finite().positive().max(MAX_QUANTITY, TOO_BIG).nullable().optional(),
  dgps_base: z.number().int().min(0).optional(),
  dgps_rovers: z.number().int().min(0).optional(),
  teams: z.number().int().min(0).optional(),
  vill_code_old: z.string().max(64).nullable().optional(),
});

/**
 * One day's progress for one village.
 *
 * Only today's figures. There is no cumulative field to fill in, because a
 * typed cumulative is the thing that goes wrong.
 */
/** One rover's day: used or idle, and if idle, why. */
export const roverDaySchema = z.object({
  asset_id: z.string().uuid(),
  status: z.enum(ROVER_DAY_STATUSES),
  idle_reason: z.enum(DELAY_REASON_CODES as unknown as [string, ...string[]]).nullable().optional(),
  remarks: z.string().max(1000).nullable().optional(),
  area_ac: z.number().finite().min(0).max(MAX_QUANTITY, TOO_BIG).nullable().optional(),
  employee_id: z.string().uuid().nullable().optional(),
});

export const surveyEntrySchema = z.object({
  survey_village_id: z.string().uuid(),
  entry_date: pastDate,
  teams_deployed: z.number().int().min(0).optional(),
  dgps_base: z.number().int().min(0).optional(),
  dgps_rovers: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
  values: z.record(z.string(), quantity).default({}),
  // A row per rover. The count above is kept for returns filed before this
  // existed, and is derived from these when they are given.
  rovers: z.array(roverDaySchema).optional(),
  low_progress_reason: z.enum(DELAY_REASON_CODES as unknown as [string, ...string[]])
    .nullable().optional(),
  low_progress_remarks: z.string().max(2000).nullable().optional(),
  punch_in_at: z.string().nullable().optional(),
  punch_out_at: z.string().nullable().optional(),
  punch_in_lat: z.number().min(-90).max(90).nullable().optional(),
  punch_in_lng: z.number().min(-180).max(180).nullable().optional(),
  punch_out_lat: z.number().min(-90).max(90).nullable().optional(),
  punch_out_lng: z.number().min(-180).max(180).nullable().optional(),
});

export const surveyEntryPatchSchema = surveyEntrySchema
  .omit({ survey_village_id: true, entry_date: true })
  .partial();

export const measureSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/,
    'Use capitals, digits and underscores — the code is referenced by imports'),
  label: z.string().min(1).max(255),
  group_label: z.string().max(255).nullable().optional(),
  unit: z.enum(MEASURE_UNITS),
  basis: z.enum(MEASURE_BASIS).default('NONE'),
  display_order: z.number().int().optional(),
});

export const targetSchema = z.object({
  measure_code: z.string().min(1).max(64),
  target_quantity: z.number().finite().positive().max(MAX_QUANTITY, TOO_BIG),
});

export const stageUpdateSchema = z.object({
  stage_code: z.string().min(1).max(64),
  state: z.enum(STAGE_STATES),
  started_on: isoDate.nullable().optional(),
  completed_on: isoDate.nullable().optional(),
}).refine(v => v.state !== 'COMPLETED' || v.completed_on, {
  message: 'A completed stage needs the date it was completed',
  path: ['completed_on'],
}).refine(
  v => !v.started_on || !v.completed_on || v.completed_on >= v.started_on,
  { message: 'A stage cannot be completed before it started', path: ['completed_on'] },
);

export const REPORT_LEVELS = ['village', 'mandal', 'division', 'district', 'programme'] as const;
export type ReportLevel = (typeof REPORT_LEVELS)[number];

/* ----------------------------------------------------------- permissions */

export const SURVEY_PERMISSIONS = [
  'survey.read', 'survey.enter', 'survey.manage', 'survey.target',
  // A forecast is management information. The specification is explicit that
  // a GT user does not see it, so it is its own permission.
  'survey.forecast', 'survey.assign', 'survey.qc', 'survey.vectorize',
] as const;

export const SURVEY_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...SURVEY_PERMISSIONS],
  ADMIN: [...SURVEY_PERMISSIONS],
  // Runs the programme: sets the work list, the targets and who is on it, and
  // is the first role the specification lets see a forecast.
  PROJECT_MANAGER: ['survey.read', 'survey.enter', 'survey.manage', 'survey.target',
    'survey.forecast', 'survey.assign', 'survey.qc', 'survey.vectorize'],
  // Records what the crew did and puts people on villages. Deliberately
  // cannot set the target its own completion is measured against, and does
  // not see the forecast.
  TEAM_LEAD: ['survey.read', 'survey.enter', 'survey.assign'],
  EMPLOYEE: ['survey.read', 'survey.enter'],
  AUDITOR: ['survey.read', 'survey.forecast'],
  HR_MANAGER: ['survey.read'],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: ['survey.read'],
  BID_TENDER_MANAGER: ['survey.read'],
  SALES_BD_EXECUTIVE: ['survey.read'],
  CLIENT_VIEWER: ['survey.read'],
};

/* ------------------------------------------------- tasks drive the state */

/**
 * Linking survey work to the task board.
 *
 * A village becomes a task and each of its stages a subtask, and from then on
 * the task's status is what the village's state means. The alternative —
 * letting a stage row and its task each hold a status — is the `Today` and
 * `Cumulative` problem one level up: two places to write the same fact, and
 * they disagree within a week.
 *
 * Which one applies is never ambiguous. A stage with a task linked reads its
 * state from the task and its own columns are left alone; a stage with no
 * task keeps using them. Only one is ever in play.
 */

// The task statuses are S4's; redefining them here would give the survey its
// own idea of what a task can be, which is exactly the drift this link exists
// to avoid.
/**
 * What a task's status means for the survey stage it stands for.
 *
 * IN_REVIEW folds into IN_PROGRESS: a village whose ground truthing is being
 * checked is not finished, and the survey report has no third thing to say
 * about it. CANCELLED is deliberately absent — see `isOutOfScope`.
 */
const STATUS_TO_STAGE: Record<Exclude<TaskStatus, 'CANCELLED'>, StageState> = {
  TO_DO: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_PROGRESS',
  DONE: 'COMPLETED',
  BLOCKED: 'ON_HOLD',
};

export function stageStateFromTask(status: string | null | undefined): StageState {
  if (!status) return 'NOT_STARTED';
  return STATUS_TO_STAGE[status as Exclude<TaskStatus, 'CANCELLED'>] ?? 'NOT_STARTED';
}

/**
 * A cancelled task means the village left the programme.
 *
 * It is not "nought per cent done" — it is no longer work anybody owes, so it
 * comes out of the denominator entirely. Leaving it in would hold a
 * percentage down for ever and the report would never reach a hundred.
 */
export function isOutOfScope(status: string | null | undefined): boolean {
  return status === 'CANCELLED';
}

export interface LinkedStage {
  stageCode: string;
  /** The task standing for this stage, where one has been created. */
  taskStatus?: string | null;
  taskStartedAt?: string | null;
  taskCompletedAt?: string | null;
  /** The stage row's own columns, used only when no task is linked. */
  ownState?: StageState | null;
  ownStartedOn?: string | null;
  ownCompletedOn?: string | null;
  linked: boolean;
}

export interface ResolvedStage {
  stageCode: string;
  state: StageState;
  startedOn: string | null;
  completedOn: string | null;
  /** Where the answer came from, so a screen can say so. */
  source: 'TASK' | 'STAGE';
}

const day = (v: string | null | undefined): string | null =>
  v ? String(v).slice(0, 10) : null;

/**
 * One stage's state, from whichever source governs it.
 *
 * The summary sheet reports a start and a completion date per stage, so the
 * task's actual timestamps are what those become — not its planned dates,
 * which are when somebody intended to do the work rather than when it
 * happened.
 */
export function resolveStage(stage: LinkedStage): ResolvedStage {
  if (stage.linked) {
    return {
      stageCode: stage.stageCode,
      state: stageStateFromTask(stage.taskStatus),
      startedOn: day(stage.taskStartedAt),
      completedOn: day(stage.taskCompletedAt),
      source: 'TASK',
    };
  }
  return {
    stageCode: stage.stageCode,
    state: stage.ownState ?? 'NOT_STARTED',
    startedOn: day(stage.ownStartedOn),
    completedOn: day(stage.ownCompletedOn),
    source: 'STAGE',
  };
}

/** Every stage resolved, keyed by code, for the roll-up to consume. */
export function resolveStages(stages: LinkedStage[]): Record<string, StageState> {
  return Object.fromEntries(stages.map(s => [s.stageCode, resolveStage(s).state]));
}

/**
 * What a village's task hierarchy should look like.
 *
 * One task for the village and one subtask per stage, in the order the stages
 * are defined, so the board reads the way the work runs.
 */
export function plannedTasksFor(
  village: { name: string; mandalName?: string | null },
  stages: Array<{ code: string; label: string }>,
): { parent: string; children: Array<{ stageCode: string; title: string }> } {
  const where = village.mandalName ? `${village.name}, ${village.mandalName}` : village.name;
  return {
    parent: `Survey ${where}`,
    children: stages.map(s => ({ stageCode: s.code, title: `${s.label} — ${village.name}` })),
  };
}

/* ------------------------------------------------------- the stage pipeline */

/**
 * The stages a village moves through, in order (§59.5).
 *
 * Ground truthing is checked before the drawing is vectorised, which is why
 * GT QC sits between them. Leaving it out made the pipeline look like a
 * two-step where the field actually runs four, and a village whose GT had
 * failed QC was indistinguishable from one whose GT was simply done.
 *
 * `requires` is the stage that must be complete before this one starts. It is
 * a single predecessor rather than a graph because that is what the work is:
 * a line, not a network.
 */
/**
 * Whether a stage may start yet.
 *
 * Returns the blocking predecessor rather than a bare false, so the refusal
 * can say which stage is in the way instead of "not allowed".
 */
export function stageBlockedBy(
  stageCode: string,
  states: Record<string, StageState>,
  pipeline: StageSeedOrdered[] = STAGE_PIPELINE,
): string | null {
  const stage = pipeline.find(s => s.code === stageCode);
  if (!stage?.requires) return null;
  return states[stage.requires] === 'COMPLETED' ? null : stage.requires;
}

/**
 * Where a village has actually got to.
 *
 * The furthest stage that has been started, which is what somebody means by
 * "where is this village". A village whose GT is done and whose QC has not
 * begun is at GT QC — the work waiting, not the work finished.
 */
export function currentStage(
  states: Record<string, StageState>,
  pipeline: StageSeedOrdered[] = STAGE_PIPELINE,
): { code: string; state: StageState } | null {
  // Rework, where it is under way, is where the village actually is —
  // whatever the forward sequence says about it.
  const rework = pipeline.find(s => s.offSequence);
  if (rework) {
    const state = states[rework.code] ?? 'NOT_STARTED';
    if (state === 'IN_PROGRESS' || state === 'ON_HOLD') return { code: rework.code, state };
  }
  const sequence = pipeline.filter(s => !s.offSequence);
  for (const stage of sequence) {
    const state = states[stage.code] ?? 'NOT_STARTED';
    if (state !== 'COMPLETED') return { code: stage.code, state };
  }
  return sequence.length
    ? { code: sequence[sequence.length - 1].code, state: 'COMPLETED' }
    : null;
}

/**
 * A stage whose predecessor is not finished.
 *
 * Reported rather than prevented where the task board drives the state: the
 * board is not the survey module's to police, and a card moved out of order
 * is a fact worth surfacing rather than one to hide.
 */
export function outOfSequence(
  states: Record<string, StageState>,
  pipeline: StageSeedOrdered[] = STAGE_PIPELINE,
): string[] {
  return pipeline
    .filter(s => !s.offSequence)
    .filter(s => {
      const state = states[s.code] ?? 'NOT_STARTED';
      if (state === 'NOT_STARTED') return false;
      return s.requires !== undefined && states[s.requires] !== 'COMPLETED';
    })
    .map(s => s.code);
}

/* ------------------------------------------------- counts by stage */

export interface StageTally {
  notStarted: number;
  inProgress: number;
  completed: number;
  onHold: number;
}

const emptyTally = (): StageTally => ({ notStarted: 0, inProgress: 0, completed: 0, onHold: 0 });

/**
 * How many villages sit at each state of each stage.
 *
 * This is the question the request asks to be answerable at any moment: how
 * many villages are yet to start, how many have GT in progress, how many are
 * waiting on QC. The overall village state cannot answer it — "in progress"
 * covers a village on its first day of GT and one waiting for its LPM.
 */
export function tallyByStage(
  villages: Array<{ stages?: Record<string, StageState> }>,
  pipeline: StageSeedOrdered[] = STAGE_PIPELINE,
): Record<string, StageTally> {
  const out: Record<string, StageTally> = {};
  for (const stage of pipeline) out[stage.code] = emptyTally();
  for (const village of villages) {
    for (const stage of pipeline) {
      const state = village.stages?.[stage.code] ?? 'NOT_STARTED';
      const tally = out[stage.code];
      if (state === 'NOT_STARTED') tally.notStarted += 1;
      else if (state === 'IN_PROGRESS') tally.inProgress += 1;
      else if (state === 'COMPLETED') tally.completed += 1;
      else if (state === 'ON_HOLD') tally.onHold += 1;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- rovers */

export interface RoverDay {
  /** Rovers allocated to the work on this date, from the asset register. */
  allocated: number;
  /** Rovers the crews reported using. */
  used: number;
}

export interface RoverUtilisation extends RoverDay {
  idle: number;
  /** Null rather than zero when nothing is allocated — there is no ratio. */
  utilisationPct: number | null;
  /** Used exceeds allocated: somebody is running equipment off the books. */
  overUsed: boolean;
}

/**
 * What the rovers did on a day.
 *
 * Idle is the point of the figure. A programme with thirty rovers allocated
 * and eleven used is not "eleven rovers of progress", it is nineteen sitting
 * in a store while the schedule assumes otherwise — and nothing in the
 * spreadsheet this replaces would ever have shown that.
 */
export function roverUtilisation(day: RoverDay): RoverUtilisation {
  const allocated = Math.max(0, Math.round(day.allocated));
  const used = Math.max(0, Math.round(day.used));
  return {
    allocated,
    used,
    // Never negative: more used than allocated is its own signal, reported
    // below rather than folded into a negative idle count.
    idle: Math.max(0, allocated - used),
    utilisationPct: allocated > 0 ? round((used / allocated) * 100) : null,
    overUsed: used > allocated,
  };
}

/* ------------------------------------------------------------------ pace */

export interface Pace {
  /** Days in the window that had any progress recorded. */
  activeDays: number;
  /** Extent surveyed per active day. */
  acresPerActiveDay: number | null;
  /** Extent surveyed per calendar day in the window. */
  acresPerCalendarDay: number | null;
  /** Villages finished per calendar day. */
  villagesPerCalendarDay: number | null;
  /** Calendar days to finish the remaining extent at the observed pace. */
  daysToFinish: number | null;
  /** The date the work runs out at this pace, if it can be projected. */
  projectedFinish: string | null;
}

/**
 * How fast the work is actually going, and when it would finish at that rate.
 *
 * Two rates, deliberately. Per active day is how fast a crew works when it is
 * working; per calendar day includes the rain, the holidays and the days
 * nobody went out. A schedule built on the first and delivered on the second
 * is how a programme slips without anybody seeing it happen.
 *
 * The projection is arithmetic, not a forecast: it says what happens if the
 * last stretch repeats. It is null when there is nothing to extrapolate from.
 */
export function pace(args: {
  surveyedAc: number;
  remainingAc: number;
  villagesCompleted: number;
  activeDays: number;
  calendarDays: number;
  asOf: string;
}): Pace {
  const calendar = Math.max(0, args.calendarDays);
  const perActive = args.activeDays > 0 ? round(args.surveyedAc / args.activeDays) : null;
  const perCalendar = calendar > 0 ? round(args.surveyedAc / calendar) : null;
  const villagesPer = calendar > 0 ? round(args.villagesCompleted / calendar, 3) : null;

  let daysToFinish: number | null = null;
  let projectedFinish: string | null = null;
  if (perCalendar !== null && perCalendar > 0 && args.remainingAc > 0) {
    daysToFinish = Math.ceil(args.remainingAc / perCalendar);
    const end = new Date(`${args.asOf}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + daysToFinish);
    projectedFinish = end.toISOString().slice(0, 10);
  }
  return {
    activeDays: args.activeDays,
    acresPerActiveDay: perActive,
    acresPerCalendarDay: perCalendar,
    villagesPerCalendarDay: villagesPer,
    daysToFinish,
    projectedFinish,
  };
}

/* ------------------------------------------------------------- schemas */

export const crewAssignmentSchema = z.object({
  employee_id: z.string().uuid(),
  stage_code: z.string().min(1).max(64),
  assigned_on: isoDate.optional(),
  released_on: isoDate.nullable().optional(),
});

/**
 * Allocating several rovers at once.
 *
 * A crew going out takes four instruments, not one, and opening the same
 * form four times is how the fourth gets forgotten. The dates are shared
 * because they always are — the kit goes out together.
 */
export const roverBulkAllocationSchema = z.object({
  asset_ids: z.array(z.string().uuid()).min(1).max(50),
  allocated_on: isoDate,
  released_on: isoDate.nullable().optional(),
}).refine(v => !v.released_on || v.released_on >= v.allocated_on, {
  message: 'A rover cannot be released before it was allocated',
  path: ['released_on'],
});

/** Putting several people on the same stage at once, for the same reason. */
export const crewBulkAssignmentSchema = z.object({
  employee_ids: z.array(z.string().uuid()).min(1).max(50),
  stage_code: z.string().trim().min(1).max(64),
  assigned_on: isoDate.optional(),
});

/** Correcting an allocation that was recorded with the wrong dates. */
export const roverAllocationEditSchema = z.object({
  allocated_on: isoDate.optional(),
  released_on: isoDate.nullable().optional(),
});

/** Moving villages from one programme to another (enhancement note 4). */
export const villageMoveSchema = z.object({
  village_ids: z.array(z.string().uuid()).min(1).max(2000),
  to_project_id: z.string().uuid(),
});

export const roverAllocationSchema = z.object({
  asset_id: z.string().uuid(),
  allocated_on: isoDate,
  released_on: isoDate.nullable().optional(),
}).refine(v => !v.released_on || v.released_on >= v.allocated_on, {
  message: 'A rover cannot be released before it was allocated',
  path: ['released_on'],
});

/** A stage update now carries the remarks the workflow asks for. */
export const projectEmployeeSchema = z.object({
  employee_id: z.string().uuid(),
  project_role: z.enum(['GT_USER','QC_USER','QGIS_USER','TEAM_LEAD','PROJECT_MANAGER'])
    .default('GT_USER'),
  assigned_on: isoDate.optional(),
});

export const villageStatusSchema = z.object({
  status_override: z.enum(['ON_HOLD','REWORK']).nullable(),
  status_remarks: z.string().max(2000).nullable().optional(),
}).refine(v => v.status_override === null || (v.status_remarks ?? '').trim().length >= 3, {
  message: 'A hold or a rework decision needs a reason recorded with it',
  path: ['status_remarks'],
});

export const villagePlanSchema = z.object({
  total_extent_ac: z.number().finite().positive().max(MAX_QUANTITY, TOO_BIG).nullable().optional(),
  expected_completion_on: isoDate.nullable().optional(),
  planned_start_on: isoDate.nullable().optional(),
});

export const stageRemarkSchema = z.object({
  stage_code: z.string().min(1).max(64),
  state: z.enum(STAGE_STATES),
  started_on: isoDate.nullable().optional(),
  completed_on: isoDate.nullable().optional(),
  remarks: z.string().max(2000).nullable().optional(),
});

/* ------------------------------------------------ rover-days over a window */

export interface RoverVillageDay {
  /** Instruments allocated to this village on this date. */
  allocated: number;
  /** What the crew reported using, or null when no entry was filed at all. */
  used: number | null;
}

export interface RoverWindow {
  /** Instrument-days allocated across the window. */
  allocatedRoverDays: number;
  /** Instrument-days the crews reported using. */
  usedRoverDays: number;
  /** Allocated less used, over the days that were actually reported. */
  idleRoverDays: number;
  utilisationPct: number | null;
  /** Days an instrument was out and nobody filed anything. */
  daysNotReported: number;
  /** Instrument-days on those days — idle as far as anyone can tell. */
  unreportedRoverDays: number;
  /** Days the crew reported using nothing at all. */
  daysReportedIdle: number;
}

/**
 * Rover utilisation over a window, in instrument-days.
 *
 * Instrument-days rather than instruments, because "six rovers" means
 * something different over a day and over a fortnight, and a window figure
 * that ignores the difference cannot be compared with anything.
 *
 * A day with no entry is counted apart from a day reporting nothing used.
 * The first means nobody filed a return and the equipment may well have been
 * working; the second is somebody saying the rovers sat there. Folding them
 * together would turn a reporting failure into an equipment problem, and the
 * two need different conversations.
 */
export function roverWindow(days: RoverVillageDay[]): RoverWindow {
  let allocated = 0, used = 0, notReported = 0, unreported = 0, reportedIdle = 0;
  for (const day of days) {
    allocated += day.allocated;
    if (day.used === null) {
      if (day.allocated > 0) { notReported += 1; unreported += day.allocated; }
      continue;
    }
    used += day.used;
    if (day.allocated > 0 && day.used === 0) reportedIdle += 1;
  }
  // Idle counts only against days somebody reported on. An unreported day is
  // reported separately rather than silently scored as waste.
  const reportedAllocated = allocated - unreported;
  return {
    allocatedRoverDays: allocated,
    usedRoverDays: used,
    idleRoverDays: Math.max(0, reportedAllocated - used),
    utilisationPct: reportedAllocated > 0
      ? round((used / reportedAllocated) * 100) : null,
    daysNotReported: notReported,
    unreportedRoverDays: unreported,
    daysReportedIdle: reportedIdle,
  };
}

/**
 * How badly a village is using what it has been given.
 *
 * Ranked so the worst offender surfaces first: most idle instrument-days,
 * then the most days simply unaccounted for. A village with nothing allocated
 * cannot be wasting anything and sorts last whatever its percentage.
 */
export function rankByWaste<T extends RoverWindow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.allocatedRoverDays === 0 && b.allocatedRoverDays === 0) return 0;
    if (a.allocatedRoverDays === 0) return 1;
    if (b.allocatedRoverDays === 0) return -1;
    if (b.idleRoverDays !== a.idleRoverDays) return b.idleRoverDays - a.idleRoverDays;
    return b.unreportedRoverDays - a.unreportedRoverDays;
  });
}

/* ------------------------------------------------------------ low progress */

export interface LowProgressCheck {
  isLow: boolean;
  /** The figure the day is measured against, where one is configured. */
  threshold: number | null;
  needsReason: boolean;
}

/**
 * Whether a day counts as low progress.
 *
 * Measured against a threshold set on the programme. With no threshold there
 * is nothing to be below, so no day is low and no reason is demanded — the
 * alternative is nagging every crew for an explanation of a rule nobody set.
 *
 * A day with no rovers out is not low progress either. Nothing was expected
 * of it.
 */
export function checkLowProgress(args: {
  areaToday: number;
  threshold: number | null | undefined;
  roversOut: number;
}): LowProgressCheck {
  const threshold = args.threshold ?? null;
  if (threshold === null || threshold <= 0 || args.roversOut === 0) {
    return { isLow: false, threshold, needsReason: false };
  }
  const isLow = args.areaToday < threshold;
  return { isLow, threshold, needsReason: isLow };
}

/* ------------------------------------------------------------ village status */

/**
 * The village statuses the specification names.
 *
 * `REWORK` and `ON_HOLD` are not points on the pipeline — a village in rework
 * has been through it and come back — so they sit beside the derived progress
 * rather than inside it, and are set deliberately rather than inferred.
 */
export const VILLAGE_STATUSES = [
  'TO_DO', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'REWORK',
] as const;
export type VillageStatus = (typeof VILLAGE_STATUSES)[number];

export const VILLAGE_STATUS_LABELS: Record<VillageStatus, string> = {
  TO_DO: 'To do',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  ON_HOLD: 'On hold',
  REWORK: 'Rework',
};

/**
 * A village's status, from its stages and whatever was set by hand.
 *
 * An explicit hold or rework wins over the derived answer, because both are
 * statements somebody made about work the stages cannot see: a hold is a
 * decision, and rework is a judgement that finished work was not good enough.
 */
export function villageStatus(
  stages: Record<string, StageState>,
  stageCodes: string[],
  override?: VillageStatus | null,
): VillageStatus {
  if (override === 'ON_HOLD' || override === 'REWORK') return override;
  const derived = villageState({ villageId: '', extentAc: null, done: {}, stages }, stageCodes);
  if (derived === 'COMPLETED') return 'COMPLETED';
  if (derived === 'IN_PROGRESS') return 'IN_PROGRESS';
  return 'TO_DO';
}

/**
 * The statuses a survey programme moves through.
 *
 * Named apart from S4's PROJECT_STATUSES, which describe an ERP project and
 * are a different thing with a different vocabulary. `DISABLED` is the one
 * the specification asks for by name: visibility is switched off without the
 * data going anywhere.
 */
export const SURVEY_PROJECT_STATUSES = [
  'DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'DISABLED',
] as const;
export type SurveyProjectStatus = (typeof SURVEY_PROJECT_STATUSES)[number];

export const SURVEY_PROJECT_STATUS_LABELS: Record<SurveyProjectStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
  DISABLED: 'Disabled',
};

/** A disabled programme is hidden, not deleted. Its data stays exactly where it is. */
export function programmeVisible(status: string | null | undefined): boolean {
  return status !== 'DISABLED';
}

/* ---------------------------------------------------------- the forecast */

export interface Forecast {
  /** What somebody committed to, by hand. */
  targetDate: string | null;
  /** What the observed pace implies. Arithmetic, and nobody's promise. */
  forecastDate: string | null;
  currentPaceAcPerDay: number | null;
  /** The pace needed to hit the target, if there is a target to hit. */
  requiredPaceAcPerDay: number | null;
  /** Days between the target and the forecast. Negative is early. */
  slipDays: number | null;
  state: 'ON_TRACK' | 'BEHIND' | 'AHEAD' | 'NO_TARGET' | 'NO_PACE';
}

/**
 * Where the work will land, against where somebody said it would.
 *
 * The two are kept apart throughout and labelled differently, because the
 * specification is right that they are different kinds of claim: one is a
 * commitment and the other is arithmetic on the last few weeks. Presenting
 * the forecast as a target is how a slipping programme keeps looking fine.
 *
 * The required pace is the more useful half. "You are behind" invites
 * argument; "you need 105 acres a day and you are doing 82" does not.
 */
export function forecast(args: {
  targetDate: string | null | undefined;
  remainingAc: number;
  acresPerCalendarDay: number | null;
  asOf: string;
}): Forecast {
  const target = args.targetDate ?? null;
  const pace = args.acresPerCalendarDay;
  const asOfMs = Date.parse(`${args.asOf}T00:00:00Z`);

  let forecastDate: string | null = null;
  if (pace !== null && pace > 0 && args.remainingAc > 0) {
    const days = Math.ceil(args.remainingAc / pace);
    forecastDate = new Date(asOfMs + days * 86_400_000).toISOString().slice(0, 10);
  } else if (args.remainingAc <= 0) {
    forecastDate = args.asOf;
  }

  let requiredPace: number | null = null;
  if (target && args.remainingAc > 0) {
    const daysLeft = Math.round((Date.parse(`${target}T00:00:00Z`) - asOfMs) / 86_400_000);
    // A target already past needs the work done today, which no pace
    // satisfies. Reported as null rather than as a vast number nobody reads.
    requiredPace = daysLeft > 0 ? round(args.remainingAc / daysLeft) : null;
  }

  let slipDays: number | null = null;
  if (target && forecastDate) {
    slipDays = Math.round(
      (Date.parse(`${forecastDate}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`)) / 86_400_000);
  }

  let state: Forecast['state'] = 'NO_TARGET';
  if (!target) state = pace === null ? 'NO_PACE' : 'NO_TARGET';
  else if (forecastDate === null) state = 'NO_PACE';
  else if (slipDays === null) state = 'NO_TARGET';
  else if (slipDays > 0) state = 'BEHIND';
  else if (slipDays < 0) state = 'AHEAD';
  else state = 'ON_TRACK';

  return {
    targetDate: target,
    forecastDate,
    currentPaceAcPerDay: pace,
    requiredPaceAcPerDay: requiredPace,
    slipDays,
    state,
  };
}

/* -------------------------------------------------------- bottlenecks */

export const BOTTLENECK_KINDS = [
  'NOT_STARTED_BY_PLAN', 'STAGE_OVERDUE', 'PAST_EXPECTED_COMPLETION',
  'ROVERS_IDLE', 'NO_PROGRESS_RECORDED', 'IN_REWORK',
] as const;
export type BottleneckKind = (typeof BOTTLENECK_KINDS)[number];

export const BOTTLENECK_LABELS: Record<BottleneckKind, string> = {
  NOT_STARTED_BY_PLAN: 'Not started by its planned date',
  STAGE_OVERDUE: 'Sitting in one stage too long',
  PAST_EXPECTED_COMPLETION: 'Past the date it was expected to finish',
  ROVERS_IDLE: 'Rovers allocated and idle',
  NO_PROGRESS_RECORDED: 'Nothing recorded for days',
  IN_REWORK: 'Sent back for rework',
};

export interface BottleneckInput {
  villageId: string;
  village: string;
  mandal?: string | null;
  status: VillageStatus;
  currentStageCode: string | null;
  /** Days the village has sat in its current stage. */
  daysInStage: number | null;
  plannedStartOn?: string | null;
  expectedCompletionOn?: string | null;
  lastEntryOn?: string | null;
  idleRoverDays?: number;
}

export interface Bottleneck extends BottleneckInput {
  kinds: BottleneckKind[];
  /** Worst first: how many days past whichever threshold it broke. */
  severityDays: number;
}

/**
 * Villages where the work has stalled, and why.
 *
 * One village can be stuck for several reasons at once and all of them are
 * reported: a village past its date *and* with idle rovers is a different
 * conversation from one that is merely late.
 *
 * Severity is measured in days past a threshold rather than as a score,
 * because a score is arbitrary and a number of days is something somebody can
 * check.
 */
export function findBottlenecks(
  villages: BottleneckInput[],
  opts: { asOf: string; stageSlaDays: number; silentDays?: number },
): Bottleneck[] {
  const asOf = Date.parse(`${opts.asOf}T00:00:00Z`);
  const silentDays = opts.silentDays ?? 7;
  const daysSince = (d: string | null | undefined): number | null =>
    d ? Math.round((asOf - Date.parse(`${d}T00:00:00Z`)) / 86_400_000) : null;

  const out: Bottleneck[] = [];
  for (const v of villages) {
    const kinds: BottleneckKind[] = [];
    let severity = 0;

    if (v.status === 'REWORK') kinds.push('IN_REWORK');

    const lateStart = daysSince(v.plannedStartOn);
    if (v.status === 'TO_DO' && lateStart !== null && lateStart > 0) {
      kinds.push('NOT_STARTED_BY_PLAN');
      severity = Math.max(severity, lateStart);
    }

    if (v.daysInStage !== null && v.daysInStage > opts.stageSlaDays && v.status !== 'COMPLETED') {
      kinds.push('STAGE_OVERDUE');
      severity = Math.max(severity, v.daysInStage - opts.stageSlaDays);
    }

    const overdue = daysSince(v.expectedCompletionOn);
    if (v.status !== 'COMPLETED' && overdue !== null && overdue > 0) {
      kinds.push('PAST_EXPECTED_COMPLETION');
      severity = Math.max(severity, overdue);
    }

    // Silence is only a finding for work that is supposed to be under way.
    const silent = daysSince(v.lastEntryOn);
    if (v.status === 'IN_PROGRESS' && silent !== null && silent > silentDays) {
      kinds.push('NO_PROGRESS_RECORDED');
      severity = Math.max(severity, silent - silentDays);
    }

    if ((v.idleRoverDays ?? 0) > 0) {
      kinds.push('ROVERS_IDLE');
      severity = Math.max(severity, v.idleRoverDays ?? 0);
    }

    if (kinds.length) out.push({ ...v, kinds, severityDays: severity });
  }
  return out.sort((a, b) => b.severityDays - a.severityDays);
}

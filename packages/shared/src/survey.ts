import { z } from 'zod';
import type { RoleCode } from './rbac.js';

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
export const STAGE_SEEDS: StageSeed[] = [
  { code: 'GROUND_TRUTHING', label: 'Ground truthing', displayOrder: 10 },
  { code: 'VECTORIZATION', label: 'Vectorization', displayOrder: 20 },
  { code: 'RECORDS_PREPARATION', label: 'Records preparation', displayOrder: 30 },
  { code: 'LPM_GENERATION', label: 'LPM generation', displayOrder: 40 },
];

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
  const known = stageCodes.map(c => stages[c] ?? 'NOT_STARTED');
  if (known.length > 0 && known.every(s => s === 'COMPLETED')) return 'COMPLETED';

  const anyStageStarted = known.some(s => s !== 'NOT_STARTED');
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

/* --------------------------------------------------------------- schemas */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const quantity = z.number().finite().min(0, 'A quantity cannot be negative');

export const surveyProjectSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  project_id: z.string().uuid().nullable().optional(),
  started_on: isoDate.nullable().optional(),
  target_completion_on: isoDate.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const surveyVillageSchema = z.object({
  village_id: z.string().uuid(),
  total_extent_ac: z.number().finite().positive().nullable().optional(),
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
export const surveyEntrySchema = z.object({
  survey_village_id: z.string().uuid(),
  entry_date: isoDate,
  teams_deployed: z.number().int().min(0).optional(),
  dgps_base: z.number().int().min(0).optional(),
  dgps_rovers: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
  values: z.record(z.string(), quantity).default({}),
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
  target_quantity: z.number().finite().positive(),
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
] as const;

export const SURVEY_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...SURVEY_PERMISSIONS],
  ADMIN: [...SURVEY_PERMISSIONS],
  // Runs the programme: sets the work list and the targets.
  PROJECT_MANAGER: ['survey.read', 'survey.enter', 'survey.manage', 'survey.target'],
  // Records what the crew did. Deliberately cannot set the target its own
  // completion is measured against.
  TEAM_LEAD: ['survey.read', 'survey.enter'],
  EMPLOYEE: ['survey.read', 'survey.enter'],
  AUDITOR: ['survey.read'],
  HR_MANAGER: ['survey.read'],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: ['survey.read'],
  BID_TENDER_MANAGER: ['survey.read'],
  SALES_BD_EXECUTIVE: ['survey.read'],
  CLIENT_VIEWER: ['survey.read'],
};

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

/*
 * The five stages a village passes through, and rework.
 *
 * This list was seven stages long, and the screen built on it asked somebody
 * to hold seven stages times four states in their head to answer "where is
 * this village". The contract reports eleven positions, not twenty-eight, so
 * the pipeline is now the five stages those eleven positions are made of —
 * see VILLAGE_LADDER below, which is the thing anybody actually reads.
 *
 * Three stages came out. They are kept here, commented rather than deleted,
 * because the work they named still happens — records are still prepared and
 * LPMs are still generated — it is simply not a position the programme is
 * reported at. Anything recorded against them was migrated onto the stage
 * that now covers it (§071), so no village lost a date:
 *
 *   { code: 'VECTORIZATION_QC',    label: 'Vectorization QC',           displayOrder: 40, requires: 'VECTORIZATION' },
 *   { code: 'RECORDS_PREPARATION', label: 'Records preparation',        displayOrder: 50, requires: 'VECTORIZATION_QC' },
 *   { code: 'LPM_GENERATION',      label: 'LPM generation',             displayOrder: 60, requires: 'RECORDS_PREPARATION' },
 *   { code: 'SUBMISSION',          label: 'Submission of deliverables', displayOrder: 70, requires: 'LPM_GENERATION' },
 *
 * VECTORIZATION_QC became DATA_SUBMISSION: the same checkpoint, named for
 * what the department does at it rather than for what we do before it.
 * RECORDS_PREPARATION, LPM_GENERATION and SUBMISSION became the two halves of
 * FINAL_DELIVERABLES.
 */
export const STAGE_PIPELINE: StageSeedOrdered[] = [
  { code: 'GROUND_TRUTHING', label: 'Ground truthing', displayOrder: 10, tracksDailyProgress: true },
  { code: 'GT_QC', label: 'GT quality check', displayOrder: 20, requires: 'GROUND_TRUTHING' },
  { code: 'VECTORIZATION', label: 'Vectorization', displayOrder: 30, requires: 'GT_QC' },
  /*
   * Submitted, then approved.
   *
   * These two stages carry a handover rather than a piece of work, so their
   * states read differently from the rest: IN_PROGRESS means "sent to the
   * department and waiting", COMPLETED means "they accepted it". The state
   * machine is the same one; only the words change, and the words are in
   * LADDER_LABELS so no screen ever says "data submission in progress".
   */
  { code: 'DATA_SUBMISSION', label: 'Data submission', displayOrder: 40, requires: 'VECTORIZATION' },
  { code: 'FINAL_DELIVERABLES', label: 'Final deliverables', displayOrder: 50, requires: 'DATA_SUBMISSION' },
  // Entered from wherever the work failed rather than reached in sequence, so
  // it waits on nothing. A village that comes back has a start and an end
  // like any other work, and the history has to show it happened.
  { code: 'REWORK', label: 'Rework', displayOrder: 90, offSequence: true },
];

/* ------------------------------------------------------- the village ladder */

/**
 * The eleven positions a village is reported at.
 *
 * One village, one position, and every position is a sentence somebody
 * outside this company can read. This is the whole simplification: the stage
 * table still holds five stages and four states each, and nobody has to know
 * that to answer "where is Jaggayyapeta".
 *
 * Ordered, and the order is the order of the work — so a bar chart of these
 * reads left to right as a programme moving, and "further along" is a
 * comparison the rung index answers directly.
 */
export interface LadderRung {
  key: string;
  label: string;
  /** The stage this position is derived from. Null only for NOT_STARTED. */
  stage: string | null;
  /** The state of that stage which puts a village here. */
  state: StageState | null;
}

export const VILLAGE_LADDER: LadderRung[] = [
  { key: 'NOT_STARTED', label: 'Not started', stage: null, state: null },
  { key: 'GT_IN_PROGRESS', label: 'GT in progress', stage: 'GROUND_TRUTHING', state: 'IN_PROGRESS' },
  { key: 'GT_COMPLETED', label: 'GT completed', stage: 'GROUND_TRUTHING', state: 'COMPLETED' },
  { key: 'GT_QC_IN_PROGRESS', label: 'GT QC in progress', stage: 'GT_QC', state: 'IN_PROGRESS' },
  { key: 'GT_QC_COMPLETED', label: 'GT QC completed', stage: 'GT_QC', state: 'COMPLETED' },
  { key: 'VECTORIZATION_IN_PROGRESS', label: 'Vectorization in progress', stage: 'VECTORIZATION', state: 'IN_PROGRESS' },
  { key: 'VECTORIZATION_COMPLETED', label: 'Vectorization completed', stage: 'VECTORIZATION', state: 'COMPLETED' },
  { key: 'DATA_SUBMITTED', label: 'Data submitted', stage: 'DATA_SUBMISSION', state: 'IN_PROGRESS' },
  { key: 'DATA_APPROVED', label: 'Data approved', stage: 'DATA_SUBMISSION', state: 'COMPLETED' },
  { key: 'FINAL_SUBMITTED', label: 'Final deliverables submitted', stage: 'FINAL_DELIVERABLES', state: 'IN_PROGRESS' },
  { key: 'FINAL_APPROVED', label: 'Final deliverables approved', stage: 'FINAL_DELIVERABLES', state: 'COMPLETED' },
];

export const LADDER_KEYS = VILLAGE_LADDER.map(r => r.key);
export type LadderKey = string;

export const LADDER_LABELS: Record<string, string> =
  Object.fromEntries(VILLAGE_LADDER.map(r => [r.key, r.label]));

/** How far along the ladder a position is, 0 for not started. */
export const LADDER_INDEX: Record<string, number> =
  Object.fromEntries(VILLAGE_LADDER.map((r, i) => [r.key, i]));

/**
 * Where a village sits on the ladder.
 *
 * Read from the far end backwards: the furthest stage that has been touched
 * is where the village has got to, whatever the stages behind it say. A
 * village whose GT was reopened after vectorisation started is reported at
 * vectorisation, because that is the truth an official is asking about; the
 * reopened GT shows up as a rework flag beside it rather than dragging the
 * whole village backwards.
 *
 * ON_HOLD counts as the in-progress position and is reported separately. The
 * eleven positions are the eleven the contract names, and "on hold" is a
 * thing that is true *about* a village at a position rather than a twelfth
 * position.
 */
export interface LadderPosition {
  key: string;
  label: string;
  index: number;
  /** The stage behind the position, for anything that needs to drill in. */
  stage: string | null;
  onHold: boolean;
  inRework: boolean;
}

export function villagePosition(
  states: Record<string, StageState> | null | undefined,
  ladder: LadderRung[] = VILLAGE_LADDER,
): LadderPosition {
  const map = states ?? {};
  const onHold = Object.values(map).some(v => v === 'ON_HOLD');
  const rework = map.REWORK === 'IN_PROGRESS' || map.REWORK === 'ON_HOLD';

  for (let i = ladder.length - 1; i >= 1; i -= 1) {
    const rung = ladder[i];
    if (!rung.stage) continue;
    const state = map[rung.stage];
    if (state === undefined || state === 'NOT_STARTED') continue;
    // ON_HOLD is work that started and stopped, so it sits at the
    // in-progress rung rather than at the completed one above it.
    const effective: StageState = state === 'ON_HOLD' ? 'IN_PROGRESS' : state;
    if (effective !== rung.state) continue;
    return {
      key: rung.key, label: rung.label, index: i, stage: rung.stage,
      onHold, inRework: rework,
    };
  }
  return {
    key: 'NOT_STARTED', label: LADDER_LABELS.NOT_STARTED, index: 0, stage: null,
    onHold, inRework: rework,
  };
}

/** How many villages sit at each of the eleven positions. */
export function tallyByPosition(
  villages: Array<{ stages?: Record<string, StageState> }>,
  ladder: LadderRung[] = VILLAGE_LADDER,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rung of ladder) out[rung.key] = 0;
  for (const v of villages) out[villagePosition(v.stages, ladder).key] += 1;
  return out;
}

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

/**
 * A number of people.
 *
 * Bounded well below the quantity ceiling because a headcount is not a
 * measurement: a thousand people on one village is a typo every time, and
 * catching it here is kinder than letting it distort a month of attendance.
 */
const headcount = z.number().int('Enter a whole number of people')
  .min(0, 'A number of people cannot be negative')
  .max(1000, 'That is more people than any village is staffed with — check the figure');

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
  /*
   * Who was actually in the village (§067).
   *
   * Ground truthing is walked by our crew alongside government staff, and
   * the contract is staffed on both sides turning up. When the department's
   * people do not, the crew stands in the village at our cost, and until
   * these two numbers existed that was something a supervisor knew and
   * nothing could show.
   *
   * Zero is a real answer and not the same as leaving it blank: nobody came
   * is the fact worth counting, while blank means nobody was asked.
   */
  govt_staff_present: headcount.nullable().optional(),
  crew_present: headcount.nullable().optional(),
});

export const surveyEntryPatchSchema = surveyEntrySchema
  .omit({ survey_village_id: true, entry_date: true })
  .partial()
  .extend({
    /**
     * Why the figure changed.
     *
     * A corrected number with no reason is a number somebody will query
     * later and nobody will be able to answer for. Optional rather than
     * required: a crew member fixing their own typing within the hour should
     * not have to write an essay, and the trail still records who and what.
     */
    amendment_reason: z.string().trim().max(500).optional(),
  });

/**
 * Starting ground truthing on a village.
 *
 * Four things are agreed when a village starts and none of them survived
 * anywhere: who is on it, how many of the department's staff were promised,
 * when it starts, and when it is expected to finish. They are asked together
 * because they are agreed together — a form that collects them one at a time
 * across four screens is a form where three of them stay empty.
 */
export const gtStartSchema = z.object({
  started_on: pastDate,
  /*
   * Not pastDate: this one is deliberately in the future. A village that
   * started today and is expected to finish today is the default nobody
   * meant, so the date is required rather than defaulted.
   */
  expected_end_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  /** The people put on it. At least one: a village nobody is on has not started. */
  employee_ids: z.array(z.string().uuid())
    .min(1, 'Put at least one person on the village — a village nobody is on has not started')
    .max(100, 'That is more people than any village takes'),
  govt_staff_allocated: headcount.nullable().optional(),
  crew_allocated: headcount.nullable().optional(),
  remarks: z.string().trim().max(2000).nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.expected_end_on < v.started_on) {
    ctx.addIssue({
      code: 'custom', path: ['expected_end_on'],
      message: 'The expected finish cannot be before the start',
    });
  }
});

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

/**
 * The planned dates and the reason the actual ones differ (§072).
 *
 * Shared by every route that writes a stage, because a plan recorded on one
 * of them and not the others is a plan that exists for some villages.
 */
export const stagePlanFields = {
  expected_start_on: isoDate.nullable().optional(),
  expected_end_on: isoDate.nullable().optional(),
  /*
   * The same delay vocabulary as idle instruments and short days (§052).
   *
   * One list, so "why was this stage late" and "why was that rover idle" can
   * be counted together. Two lists would drift within a month and make the
   * two reports incomparable, which is most of why the vocabulary is fixed
   * at all.
   */
  variance_reason: z.enum(DELAY_REASON_CODES as unknown as [string, ...string[]])
    .nullable().optional(),
  variance_remarks: z.string().trim().max(2000).nullable().optional(),
};

export const stageUpdateSchema = z.object({
  stage_code: z.string().min(1).max(64),
  state: z.enum(STAGE_STATES),
  started_on: isoDate.nullable().optional(),
  completed_on: isoDate.nullable().optional(),
  ...stagePlanFields,
  /*
   * How the village is staffed for ground truthing (§067).
   *
   * Asked when it starts, because that is the one moment somebody knows the
   * answer: the mandal has just told us how many of their people we get.
   * Recorded on the village, not the stage row, since it governs every day's
   * return afterwards.
   */
  gt_govt_staff_allocated: headcount.nullable().optional(),
  gt_crew_allocated: headcount.nullable().optional(),
}).refine(v => v.state !== 'COMPLETED' || v.completed_on, {
  message: 'A completed stage needs the date it was completed',
  path: ['completed_on'],
}).refine(
  v => !v.started_on || !v.completed_on || v.completed_on >= v.started_on,
  { message: 'A stage cannot be completed before it started', path: ['completed_on'] },
).refine(
  v => !v.expected_start_on || !v.expected_end_on
    || v.expected_end_on >= v.expected_start_on,
  { message: 'A stage cannot be expected to finish before it starts',
    path: ['expected_end_on'] },
).refine(
  v => v.variance_reason !== 'OTHER' || Boolean(v.variance_remarks?.trim()),
  { message: 'A variance reason of "other" must say what happened',
    path: ['variance_remarks'] },
);

/* ------------------------------------------------------ plan vs actual (§072) */

export interface StageDates {
  state?: StageState | string | null;
  startedOn?: string | null;
  completedOn?: string | null;
  expectedStartOn?: string | null;
  expectedEndOn?: string | null;
  varianceReason?: string | null;
}

/**
 * How a stage ran against its plan.
 *
 * `days` is signed and reads the way people speak: positive is late, negative
 * is early. Null means the question cannot be asked — no plan, or nothing to
 * compare a plan against yet — and null is reported as unknown rather than as
 * zero, because a stage with no expected date is not a stage that finished on
 * time.
 *
 * A stage still running is measured against today, so a village three weeks
 * past its date is late now rather than late in hindsight. That is the whole
 * value of the figure: it is a warning while something can still be done.
 */
export interface StageVariance {
  /** Signed days: + late, - early, null when unanswerable. */
  days: number | null;
  /** Measured against the finish, or against today for work still running. */
  basis: 'COMPLETED' | 'RUNNING' | 'NOT_STARTED' | 'NO_PLAN';
  late: boolean;
  /** True when the variance is big enough that a reason should be recorded. */
  needsReason: boolean;
  reason: string | null;
}

/** Days between two ISO dates, b - a. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * A slip small enough that asking for an explanation would train people to
 * type "delay" into every box. A working week.
 */
export const VARIANCE_REASON_THRESHOLD_DAYS = 5;

export function stageVariance(
  stage: StageDates,
  today: string,
  thresholdDays: number = VARIANCE_REASON_THRESHOLD_DAYS,
): StageVariance {
  const reason = stage.varianceReason ?? null;
  const expected = stage.expectedEndOn ?? null;
  if (!expected) {
    return { days: null, basis: 'NO_PLAN', late: false, needsReason: false, reason };
  }

  if (stage.completedOn) {
    const days = daysBetween(expected, stage.completedOn);
    return {
      days, basis: 'COMPLETED', late: days > 0,
      needsReason: Math.abs(days) > thresholdDays && !reason,
      reason,
    };
  }

  // Not finished. Measured against today, so lateness is news rather than
  // history — but only once the date has actually passed.
  const days = daysBetween(expected, today);
  const started = stage.state === 'IN_PROGRESS' || stage.state === 'ON_HOLD'
    || Boolean(stage.startedOn);
  return {
    days: days > 0 ? days : 0,
    basis: started ? 'RUNNING' : 'NOT_STARTED',
    late: days > 0,
    needsReason: days > thresholdDays && !reason,
    reason,
  };
}

/** "8 days late", "3 days early", "on time", or null when there is no plan. */
export function varianceNote(v: StageVariance): string | null {
  if (v.days === null) return null;
  if (v.days === 0) return v.basis === 'COMPLETED' ? 'on time' : 'on schedule';
  const n = Math.abs(v.days);
  const unit = n === 1 ? 'day' : 'days';
  return v.days > 0 ? `${n} ${unit} late` : `${n} ${unit} early`;
}

/**
 * Every stage of a village measured against its plan, worst first.
 *
 * Worst first because the list exists to be acted on: a supervisor opening a
 * village wants the stage that is hurting, not the stage that happens to come
 * first in the pipeline.
 */
export function villageVariances(
  stages: Array<StageDates & { stageCode: string }>,
  today: string,
  thresholdDays: number = VARIANCE_REASON_THRESHOLD_DAYS,
): Array<{ stageCode: string; variance: StageVariance }> {
  return stages
    .map(st => ({ stageCode: st.stageCode, variance: stageVariance(st, today, thresholdDays) }))
    .sort((a, b) => (b.variance.days ?? -Infinity) - (a.variance.days ?? -Infinity));
}

export const REPORT_LEVELS = ['village', 'mandal', 'division', 'district', 'programme'] as const;
export type ReportLevel = (typeof REPORT_LEVELS)[number];

/* ----------------------------------------------------------- permissions */

export const SURVEY_PERMISSIONS = [
  'survey.read', 'survey.enter', 'survey.manage', 'survey.target',
  // A forecast is management information. The specification is explicit that
  // a GT user does not see it, so it is its own permission.
  'survey.forecast', 'survey.assign', 'survey.qc', 'survey.vectorize',
  // Certifying a finished village is not managing one. A team lead closes
  // out the villages they ran without being able to set the targets their
  // own completion is measured against.
  'survey.certify',
  /*
   * The dashboard the department is given (§071).
   *
   * Its own permission rather than a weaker survey.read, because survey.read
   * carries the crew lists, the rover utilisation and the claim register with
   * it. An observer holding this and nothing else sees villages, extent and
   * where each one has got to — and cannot reach anything that would tell
   * them what the work cost us.
   */
  'survey.dashboard',
] as const;

export const SURVEY_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...SURVEY_PERMISSIONS],
  ADMIN: [...SURVEY_PERMISSIONS],
  // Runs the programme: sets the work list, the targets and who is on it, and
  // is the first role the specification lets see a forecast.
  PROJECT_MANAGER: ['survey.read', 'survey.enter', 'survey.manage', 'survey.target',
    'survey.forecast', 'survey.assign', 'survey.qc', 'survey.vectorize', 'survey.certify',
    'survey.dashboard'],
  // Records what the crew did and puts people on villages. Deliberately
  // cannot set the target its own completion is measured against, and does
  // not see the forecast.
  TEAM_LEAD: ['survey.read', 'survey.enter', 'survey.assign', 'survey.certify', 'survey.dashboard'],
  EMPLOYEE: ['survey.read', 'survey.enter', 'survey.dashboard'],
  AUDITOR: ['survey.read', 'survey.forecast', 'survey.dashboard'],
  HR_MANAGER: ['survey.read', 'survey.dashboard'],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: ['survey.read', 'survey.dashboard'],
  BID_TENDER_MANAGER: ['survey.read', 'survey.dashboard'],
  // The whole of the observer's access, in this module and in every other.
  GOVT_OBSERVER: ['survey.dashboard'],
  SALES_BD_EXECUTIVE: ['survey.read', 'survey.dashboard'],
  CLIENT_VIEWER: ['survey.read', 'survey.dashboard'],
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
  // Correctable afterwards: the mandal reassigns people, and an allocation
  // that cannot be changed is one everybody stops believing.
  gt_govt_staff_allocated: headcount.nullable().optional(),
  gt_crew_allocated: headcount.nullable().optional(),
});

export const stageRemarkSchema = z.object({
  stage_code: z.string().min(1).max(64),
  state: z.enum(STAGE_STATES),
  started_on: isoDate.nullable().optional(),
  completed_on: isoDate.nullable().optional(),
  ...stagePlanFields,
  remarks: z.string().max(2000).nullable().optional(),
  /*
   * How the village is staffed for ground truthing (§067).
   *
   * Asked when it starts, because that is the moment somebody knows: the
   * mandal has just said how many of their people we get. Held on the
   * village rather than the stage row, since it governs every day's return
   * from then on.
   */
  gt_govt_staff_allocated: headcount.nullable().optional(),
  gt_crew_allocated: headcount.nullable().optional(),
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

/* ------------------------------------------- billing milestones (§066) */

/**
 * What each milestone releases, by default.
 *
 * The AP resurvey contract pays a village in three claims: half once ground
 * truthing is signed off, thirty per cent at records preparation, the last
 * fifth on final submission. Defaults, not rules — the percentage is stored
 * on the claim, so a programme written under different terms keeps its own.
 */
export const MILESTONE_PERCENT: Record<number, number> = { 1: 50, 2: 30, 3: 20 };

/** What each milestone is called on the covering letter. */
export const MILESTONE_LABELS: Record<number, string> = {
  1: 'First milestone',
  2: 'Second milestone',
  3: 'Third milestone',
};

export const BILLING_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'PAID'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Returned',
  PAID: 'Paid',
};

export const villageBillingSchema = z.object({
  milestone: z.number().int()
    .min(1, 'Milestones are numbered from 1')
    .max(9, 'A contract with more than nine claims is not one this handles'),
  // Defaulted from the milestone at the route, so the common case needs no
  // decision from the person filing it.
  percent: z.number().finite()
    .gt(0, 'A claim releases some share of the value')
    .max(100, 'A claim cannot release more than the whole village')
    .optional(),
  // Backdating a claim is normal: the covering letter went out last week and
  // somebody is recording it now. Forward-dating is not.
  submitted_on: pastDate.optional(),
  status: z.enum(BILLING_STATUSES).optional(),
  decided_on: pastDate.nullable().optional(),
  reference_no: z.string().max(64).nullable().optional(),
  extent_ac: quantity.nullable().optional(),
  remarks: z.string().max(2000).nullable().optional(),
}).strict();

export const villageBillingPatchSchema = villageBillingSchema
  .partial()
  .omit({ milestone: true })
  .strict()
  .refine(v => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Whether a decision date makes sense for a status.
 *
 * A claim still sitting with the department has not been decided, and a date
 * against it is somebody's guess hardening into a record. A decided claim
 * without a date cannot be aged, which is the whole reason to track them.
 */
export function billingDecisionRequired(status: BillingStatus): boolean {
  return status === 'APPROVED' || status === 'REJECTED' || status === 'PAID';
}

/**
 * The share of a village's value that has been claimed.
 *
 * Returned claims release nothing: the work comes back and is claimed again
 * under the same milestone once it is corrected.
 */
export function claimedPercent(
  claims: { percent: number; status: string }[],
): number {
  return Math.round(
    claims
      .filter(c => c.status !== 'REJECTED')
      .reduce((sum, c) => sum + Number(c.percent || 0), 0) * 100,
  ) / 100;
}

/**
 * Claiming, or recording a decision on, a batch of villages at once.
 *
 * Forty villages going into one claim is one decision and one covering
 * letter, not forty. Doing it a village at a time is how thirty-eight go in
 * and two are found months later, unclaimed, on a programme everybody
 * believes is fully billed.
 *
 * Two actions, because they are the two things that happen to a batch: the
 * claim goes out, and later the department answers it.
 */
export const villageBillingBulkSchema = z.object({
  survey_village_ids: z.array(z.string().uuid())
    .min(1, 'Choose at least one village')
    // A thousand is more villages than any single claim covers, and it caps
    // what one request can do by accident.
    .max(1000, 'That is more than 1,000 villages at once'),
  action: z.enum(['SUBMIT', 'DECIDE']),
  milestone: z.number().int()
    .min(1, 'Milestones are numbered from 1')
    .max(9, 'A contract with more than nine claims is not one this handles'),

  /* --- submitting --- */
  percent: z.number().finite()
    .gt(0, 'A claim releases some share of the value')
    .max(100, 'A claim cannot release more than the whole village')
    .optional(),
  submitted_on: pastDate.optional(),
  reference_no: z.string().max(64).nullable().optional(),
  /**
   * Claim each village's recorded extent.
   *
   * The extent claimed is normally the village's own, and typing it forty
   * times is forty chances to transpose a digit. Off by default, because a
   * claim for an extent nobody checked is worse than a claim with none.
   */
  use_village_extent: z.boolean().optional(),
  remarks: z.string().max(2000).nullable().optional(),

  /* --- deciding --- */
  status: z.enum(['APPROVED', 'REJECTED', 'PAID']).optional(),
  decided_on: pastDate.optional(),

  /**
   * Show what would happen, and write nothing.
   *
   * This is the screen where somebody discovers they had the wrong filter
   * applied — after it has already claimed two hundred villages.
   */
  dry_run: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (v.action === 'DECIDE') {
    if (!v.status) {
      ctx.addIssue({
        code: 'custom', path: ['status'],
        message: 'Choose what the department decided',
      });
    }
    if (!v.decided_on) {
      // A decided claim with no date cannot be aged, and ageing them is the
      // reason to track them at all.
      ctx.addIssue({
        code: 'custom', path: ['decided_on'],
        message: 'Enter the date the department decided these',
      });
    }
  }
});

export type VillageBillingBulkInput = z.infer<typeof villageBillingBulkSchema>;

/**
 * Why a village in the batch was left alone.
 *
 * Named rather than counted: "12 skipped" tells somebody to go looking,
 * while "12 already claimed at this milestone" tells them nothing is wrong.
 */
export type BillingSkipReason =
  | 'ALREADY_CLAIMED'
  | 'NOTHING_TO_DECIDE'
  | 'ALREADY_IN_THAT_STATE'
  | 'NOT_EARNED';

export const BILLING_SKIP_LABELS: Record<BillingSkipReason, string> = {
  ALREADY_CLAIMED: 'already submitted at this milestone',
  NOTHING_TO_DECIDE: 'nothing submitted at this milestone to decide',
  ALREADY_IN_THAT_STATE: 'already recorded that way',
  // Named for the stage, because "not earned" alone sends somebody looking
  // for a setting rather than for the QC that has not been signed off.
  NOT_EARNED: 'the stage this milestone falls due at is not signed off yet',
};

/* ----------------------------------------------- ground-truthing staffing */

/** A day's attendance against what the village was allotted. */
export interface StaffingDay {
  /** Null where the question was never asked — an older return, or not GT. */
  govtStaffPresent: number | null;
  crewPresent: number | null;
  govtStaffAllocated: number | null;
  crewAllocated: number | null;
}

export interface StaffingSummary {
  /** Days where somebody recorded an attendance at all. */
  daysRecorded: number;
  /** Person-days actually in the village, each side. */
  govtStaffDays: number;
  crewDays: number;
  /** Person-days the allocation implies over those same days. */
  govtStaffExpected: number;
  crewExpected: number;
  /** Turnout as a percentage of the allocation, null with nothing to divide. */
  govtStaffPct: number | null;
  crewPct: number | null;
  /** Days the department fielded nobody at all. */
  daysWithNoGovtStaff: number;
  /** Days somebody was short, either side. */
  daysShort: number;
}

/**
 * Attendance against allocation, over a set of days.
 *
 * Expected person-days are counted only over days that *have* a return and a
 * known allocation. Multiplying the allocation by the calendar would charge
 * the department for Sundays and for days the crew was somewhere else, and
 * the resulting percentage would be an accusation rather than a measurement.
 *
 * A day with no attendance recorded is left out of both sides rather than
 * counted as zero. Zero attendance is a real and serious fact; a return
 * filed before anybody was asked the question is not, and conflating them
 * would manufacture absences out of the day this was built.
 */
export function summariseStaffing(days: StaffingDay[]): StaffingSummary {
  let daysRecorded = 0;
  let govtStaffDays = 0, crewDays = 0;
  let govtStaffExpected = 0, crewExpected = 0;
  let daysWithNoGovtStaff = 0, daysShort = 0;

  for (const d of days) {
    const hasGovt = d.govtStaffPresent !== null && d.govtStaffPresent !== undefined;
    const hasCrew = d.crewPresent !== null && d.crewPresent !== undefined;
    if (!hasGovt && !hasCrew) continue;
    daysRecorded += 1;

    if (hasGovt) {
      govtStaffDays += d.govtStaffPresent as number;
      if ((d.govtStaffPresent as number) === 0) daysWithNoGovtStaff += 1;
      if (d.govtStaffAllocated !== null && d.govtStaffAllocated !== undefined) {
        govtStaffExpected += d.govtStaffAllocated;
      }
    }
    if (hasCrew) {
      crewDays += d.crewPresent as number;
      if (d.crewAllocated !== null && d.crewAllocated !== undefined) {
        crewExpected += d.crewAllocated;
      }
    }

    const govtShort = hasGovt && d.govtStaffAllocated != null
      && (d.govtStaffPresent as number) < d.govtStaffAllocated;
    const crewShort = hasCrew && d.crewAllocated != null
      && (d.crewPresent as number) < d.crewAllocated;
    if (govtShort || crewShort) daysShort += 1;
  }

  const pct = (got: number, want: number) =>
    want > 0 ? Math.round((got / want) * 1000) / 10 : null;

  return {
    daysRecorded, govtStaffDays, crewDays, govtStaffExpected, crewExpected,
    govtStaffPct: pct(govtStaffDays, govtStaffExpected),
    crewPct: pct(crewDays, crewExpected),
    daysWithNoGovtStaff, daysShort,
  };
}

/**
 * What to say about a day's attendance, in one line.
 *
 * The number on its own reads as neutral. "Four of six — two short" is what
 * somebody escalates, and it should not need working out from two columns.
 */
export function staffingNote(s: StaffingSummary): string {
  if (s.daysRecorded === 0) {
    return 'Nobody has recorded attendance on these days.';
  }
  const parts: string[] = [];
  if (s.govtStaffPct !== null) {
    parts.push(`Government staff turned out at ${s.govtStaffPct}% of the agreed strength`);
  } else if (s.govtStaffDays > 0) {
    parts.push(`${s.govtStaffDays} government staff-days recorded, with no allocation to compare`);
  }
  if (s.crewPct !== null) {
    parts.push(`our crew at ${s.crewPct}%`);
  }
  let note = parts.length ? `${parts.join(', ')}.` : '';
  if (s.daysWithNoGovtStaff > 0) {
    note += ` The department fielded nobody on ${s.daysWithNoGovtStaff} day${
      s.daysWithNoGovtStaff === 1 ? '' : 's'}.`;
  } else if (s.daysShort > 0) {
    note += ` ${s.daysShort} day${s.daysShort === 1 ? ' was' : 's were'} short of the agreed strength.`;
  }
  return note.trim() || 'Attendance matched the allocation.';
}

/** Whether a stage is the one that is jointly staffed, and so asks these. */
export function stageTracksStaffing(stageCode: string | null | undefined): boolean {
  // Ground truthing alone. No other stage is walked with the department, and
  // asking on the rest would collect figures that mean nothing.
  return stageCode === 'GROUND_TRUTHING';
}

/**
 * The window immediately before a chosen range, of the same length.
 *
 * A range somebody picked has no calendar predecessor — there is no "last
 * fortnight-that-the-minister-visited". The only honest comparison is the
 * same number of days ending the day before it started, and stating that is
 * better than quietly comparing eleven days against thirty.
 */
export function priorRange(r: { from: string; to: string }): Period {
  const from = Date.parse(`${r.from}T00:00:00Z`);
  const to = Date.parse(`${r.to}T00:00:00Z`);
  const days = Math.max(0, Math.round((to - from) / 86_400_000));
  const end = new Date(from - 86_400_000);
  const start = new Date(end.getTime() - days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(start), to: iso(end),
    label: `${iso(start)} to ${iso(end)}`,
  };
}

/* --------------------------------------- what a milestone may be claimed on */

/**
 * The stage each billing milestone is earned at.
 *
 * The contract does not release money for work in progress. The first claim
 * falls due when ground-truthing QC has signed the village off, the second
 * when vectorisation QC has, the third when the final deliverables have gone
 * in. Claiming earlier is a claim the department returns, and a returned
 * claim costs a month.
 *
 * Held here rather than in the route so the screen can grey out what cannot
 * be claimed and say why, using the same rule that will refuse it.
 */
export const MILESTONE_REQUIRES: Record<number, string> = {
  1: 'GT_QC',
  // Was VECTORIZATION_QC, which is the same checkpoint under its old name
  // (§071). Nothing about when the money falls due has moved: the department
  // approving the data is what the second claim has always waited on.
  2: 'DATA_SUBMISSION',
  // Was SUBMISSION. The third claim falls due when the deliverables go in,
  // not when the department signs them off — see MILESTONE_EARNED_AT.
  3: 'FINAL_DELIVERABLES',
};

/**
 * The state of that stage which earns the milestone.
 *
 * Two of the three wait for a signature; the third does not, and the
 * difference is the contract's rather than ours. The first and second claims
 * fall due when the department accepts the work. The third falls due when the
 * final deliverables are *submitted* — the money is not held behind an
 * approval that may take the department months.
 */
export const MILESTONE_EARNED_AT: Record<number, StageState> = {
  1: 'COMPLETED',
  2: 'COMPLETED',
  3: 'IN_PROGRESS',
};

/**
 * Whether a village has earned a milestone yet.
 *
 * `stages` is the village's stage map. Where the milestone waits on a
 * signature, only COMPLETED counts: a stage in progress is work that might
 * still come back.
 */
export function milestoneEarned(
  milestone: number, stages: Record<string, string> | null | undefined,
): boolean {
  const required = MILESTONE_REQUIRES[milestone];
  // A milestone the contract does not gate is one anybody may claim; the
  // three that matter are all listed above.
  if (!required) return true;
  const at = (stages ?? {})[required] ?? 'NOT_STARTED';
  const needed = MILESTONE_EARNED_AT[milestone] ?? 'COMPLETED';
  if (needed === 'COMPLETED') return at === 'COMPLETED';
  // A submission that has already been approved has certainly been made, so
  // the later state earns the earlier milestone too.
  return at === 'IN_PROGRESS' || at === 'COMPLETED';
}

/** Why a milestone cannot be claimed yet, in words somebody can act on. */
export function milestoneBlockedNote(
  milestone: number, stages: Record<string, string> | null | undefined,
  stageLabelOf: (code: string) => string,
): string | null {
  if (milestoneEarned(milestone, stages)) return null;
  const required = MILESTONE_REQUIRES[milestone];
  const at = (stages ?? {})[required] ?? 'NOT_STARTED';
  const label = stageLabelOf(required);
  const name = MILESTONE_LABELS[milestone] ?? `Milestone ${milestone}`;
  const due = (MILESTONE_EARNED_AT[milestone] ?? 'COMPLETED') === 'COMPLETED'
    ? 'falls due when it is signed off'
    : 'falls due when it goes in';
  return at === 'NOT_STARTED'
    ? `${label} has not started on this village. ${name} ${due}.`
    : `${label} is ${at.replace(/_/g, ' ').toLowerCase()}, not finished. ${name} ${due}.`;
}

/* ------------------------------------------- certifying a finished village */

export const villageFinalSchema = z.object({
  /** Measure code, so the caller need not look up an id. */
  measure_code: z.string().min(1).max(64),
  quantity: quantity,
  // Mandatory: a figure that differs from the record with no explanation is
  // exactly what this exists to stop.
  reason: z.string().trim().min(3, 'Say why the certified figure differs').max(2000),
}).strict();

export const villageFinalsSchema = z.object({
  finals: z.array(villageFinalSchema)
    .min(1, 'Certify at least one measure')
    .max(50, 'That is more measures than any programme has'),
}).strict();

/**
 * What a village is certified at, against what its returns add up to.
 *
 * Both are reported, always. A certified figure that silently replaced the
 * daily sum would be the spreadsheet again, just inside the database — and
 * the difference between them is the thing a reviewer actually looks at.
 */
export interface CertifiedFigure {
  code: string;
  recorded: number;
  certified: number | null;
  reason: string | null;
}

export function certifiedDifference(f: CertifiedFigure): number | null {
  if (f.certified === null) return null;
  return Math.round((f.certified - f.recorded) * 10000) / 10000;
}

/* ------------------------------------------- ground control points (§069) */

export const gcpSchema = z.object({
  point_code: z.string().trim().min(1, 'Give the point a name, such as GCP-1').max(64),
  latitude: z.number().finite()
    .min(-90, 'A latitude runs from -90 to 90')
    .max(90, 'A latitude runs from -90 to 90'),
  longitude: z.number().finite()
    .min(-180, 'A longitude runs from -180 to 180')
    .max(180, 'A longitude runs from -180 to 180'),
  elevation_m: z.number().finite()
    // Below the Dead Sea or above Everest is a typed decimal point, not a
    // control point.
    .min(-500, 'That is below any land on earth — check the figure')
    .max(9000, 'That is above Everest — check the figure')
    .nullable().optional(),
  /*
   * The same point on a projected grid (§070).
   *
   * A controller gives a fix both ways, and the drawings and LPM sheets are
   * in the grid while latitude and longitude are what travels between
   * systems. Stored rather than converted: an Indian survey may be on WGS84
   * UTM or on an older Everest-based grid, and computing one from the other
   * would assert a projection the survey may not be using.
   */
  easting_m: z.number().finite()
    .min(0, 'An easting is a positive distance in metres')
    .max(1_000_000, 'That is larger than any easting on a UTM grid — check the figure')
    .nullable().optional(),
  northing_m: z.number().finite()
    .min(0, 'A northing is a positive distance in metres')
    .max(10_000_000, 'That is larger than any northing on a UTM grid — check the figure')
    .nullable().optional(),
  grid_zone: z.string().trim().max(16).nullable().optional(),
  remarks: z.string().max(2000).nullable().optional(),
  established_on: pastDate.nullable().optional(),
}).strict().superRefine((v, ctx) => {
  // A grid reference with no zone cannot be resolved to a place, and a zone
  // with no reference is noise. Either both numbers and a zone, or none.
  const hasE = v.easting_m !== null && v.easting_m !== undefined;
  const hasN = v.northing_m !== null && v.northing_m !== undefined;
  if (hasE !== hasN) {
    ctx.addIssue({
      code: 'custom', path: [hasE ? 'northing_m' : 'easting_m'],
      message: 'A grid reference needs both a northing and an easting',
    });
  }
  if ((hasE || hasN) && !v.grid_zone?.trim()) {
    ctx.addIssue({
      code: 'custom', path: ['grid_zone'],
      message: 'Name the grid, such as 44N — without it these are two numbers, not a position',
    });
  }
});

/*
 * The same fields, all optional, for a correction.
 *
 * Built from the object rather than from `gcpSchema`, which carries the
 * both-or-neither rule as an effect and so cannot be made partial. The rule
 * is restated here against whatever the patch actually sets.
 */
export const gcpPatchSchema = z.object({
  point_code: z.string().trim().min(1).max(64).optional(),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  elevation_m: z.number().finite().min(-500).max(9000).nullable().optional(),
  easting_m: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  northing_m: z.number().finite().min(0).max(10_000_000).nullable().optional(),
  grid_zone: z.string().trim().max(16).nullable().optional(),
  remarks: z.string().max(2000).nullable().optional(),
  established_on: pastDate.nullable().optional(),
}).strict()
  .refine(v => Object.keys(v).length > 0, 'Change at least one field')
  .superRefine((v, ctx) => {
    /*
     * The same both-or-neither rule the create path enforces.
     *
     * It was missing here, so a patch that set a northing and an easting
     * without a zone got past the schema, reached the database, and came
     * back as "A referenced record or value is invalid" — a check constraint
     * talking to a person. The rule has to live where the message is worth
     * reading.
     */
    const setsE = v.easting_m !== undefined && v.easting_m !== null;
    const setsN = v.northing_m !== undefined && v.northing_m !== null;
    const clearsE = v.easting_m === null;
    const clearsN = v.northing_m === null;

    if (setsE !== setsN && !(clearsE && clearsN)) {
      ctx.addIssue({
        code: 'custom', path: [setsE ? 'northing_m' : 'easting_m'],
        message: 'A grid reference needs both a northing and an easting',
      });
    }
    // Setting a grid reference needs a zone, unless the row already carries
    // one — which the route checks, because only it can see the row.
    if ((setsE || setsN) && v.grid_zone !== undefined && !v.grid_zone?.trim()) {
      ctx.addIssue({
        code: 'custom', path: ['grid_zone'],
        message: 'Name the grid, such as 44N — without it these are two numbers, not a position',
      });
    }
    // Clearing the zone while leaving a reference standing would do the same
    // damage from the other direction.
    if (v.grid_zone === null && !(clearsE && clearsN)) {
      ctx.addIssue({
        code: 'custom', path: ['grid_zone'],
        message: 'Clear the northing and easting too, or keep a grid zone against them',
      });
    }
  });

/**
 * Roughly where India is, in degrees.
 *
 * Used only to warn, never to refuse: the bounds are approximate and a
 * programme run elsewhere is not this software's business to prevent.
 */
const INDIA = { latMin: 6, latMax: 38, lngMin: 68, lngMax: 98 };

export type GcpWarning = 'SWAPPED' | 'OUTSIDE_INDIA' | 'LOW_PRECISION';

export const GCP_WARNING_NOTES: Record<GcpWarning, string> = {
  SWAPPED:
    'Those look swapped — the latitude is in the range longitudes take in India, and '
    + 'the longitude is in the range latitudes take. Check which column is which.',
  OUTSIDE_INDIA:
    'That point is outside India. Check the signs and the decimal point.',
  LOW_PRECISION:
    'Only whole or near-whole degrees were entered. A degree is about 110 km, so this '
    + 'point is not fixed to anything useful — check the figures were copied in full.',
};

/**
 * What looks wrong about a pair of coordinates.
 *
 * Warnings rather than refusals. Every one of these is a real mistake people
 * make copying a fix off a controller, and every one of them is also
 * something a legitimate programme could produce — so the answer is to say
 * what looks odd and let a person decide, not to refuse a number somebody is
 * looking straight at.
 *
 * Swapped first, because it is the common one and the other two are what it
 * looks like from the outside: a swapped Indian point is also outside India.
 */
export function checkGcp(lat: number, lng: number): GcpWarning[] {
  const out: GcpWarning[] = [];
  const inIndia = (la: number, ln: number) =>
    la >= INDIA.latMin && la <= INDIA.latMax && ln >= INDIA.lngMin && ln <= INDIA.lngMax;

  if (!inIndia(lat, lng) && inIndia(lng, lat)) {
    out.push('SWAPPED');
  } else if (!inIndia(lat, lng)) {
    out.push('OUTSIDE_INDIA');
  }

  // A degree is about 110 km. A pair given to fewer than three decimals does
  // not locate a pillar, it locates a district.
  const decimals = (n: number) => {
    const i = String(n).indexOf('.');
    return i === -1 ? 0 : String(n).length - i - 1;
  };
  if (decimals(lat) < 3 && decimals(lng) < 3) out.push('LOW_PRECISION');

  return out;
}

/** A coordinate as it is written on a survey record. */
export function formatCoordinate(value: number, axis: 'lat' | 'lng'): string {
  const hemisphere = axis === 'lat'
    ? (value >= 0 ? 'N' : 'S')
    : (value >= 0 ? 'E' : 'W');
  return `${Math.abs(value).toFixed(6)}° ${hemisphere}`;
}

/**
 * How far the surveyed extent has drifted from the revenue record.
 *
 * Signed: a village that came in smaller than the record is a different
 * conversation from one that came in larger — the first is usually land that
 * turned out to be assigned elsewhere, the second is usually an encroachment
 * or a boundary the record never caught up with. Reporting the magnitude
 * alone would merge the two.
 *
 * Null where there is nothing to compare against: a village with no recorded
 * extent has not drifted from anything, and calling that 100% would put every
 * village with a hole in its master data at the top of the exceptions list.
 */
export function extentVariancePct(
  plannedAc: number | null | undefined,
  actualAc: number | null | undefined,
): number | null {
  const planned = Number(plannedAc ?? 0);
  const actual = Number(actualAc ?? 0);
  if (!Number.isFinite(planned) || planned <= 0) return null;
  if (!Number.isFinite(actual) || actual <= 0) return null;
  return Math.round(((actual - planned) / planned) * 1000) / 10;
}

/**
 * Whether a village's extent has drifted far enough to be worth looking at.
 *
 * The threshold is the reader's to set, because what counts as a discrepancy
 * depends on the terrain and the contract: five per cent is alarming on flat
 * delta land and routine in the agency areas.
 */
export function extentVaries(
  plannedAc: number | null | undefined,
  actualAc: number | null | undefined,
  thresholdPct: number,
): boolean {
  const v = extentVariancePct(plannedAc, actualAc);
  return v !== null && Math.abs(v) >= Math.abs(thresholdPct);
}

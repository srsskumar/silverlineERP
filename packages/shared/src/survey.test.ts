import { describe, expect, it } from 'vitest';
import {
  MEASURE_CODES, MEASURE_SEEDS, STAGE_CODES, STAGE_SEEDS, SQ_KM_PER_ACRE,
  SURVEY_ROLE_GRANTS, acresToSqKm, completion, financialYearRange, measureSchema,
  periodBuckets, rollUp, stageUpdateSchema, surveyEntrySchema, villageState,
  stageStateFromTask, isOutOfScope, resolveStage, resolveStages, plannedTasksFor,
  STAGE_PIPELINE, stageBlockedBy, currentStage, outOfSequence, tallyByStage,
  roverUtilisation, pace, crewAssignmentSchema, roverAllocationSchema, stageRemarkSchema,
  roverWindow, rankByWaste, type RoverWindow,
  type MeasureBasis, type VillageProgress,
} from './survey.js';

const BASIS: Record<string, MeasureBasis> = Object.fromEntries(
  MEASURE_SEEDS.map(m => [m.code, m.basis]));

/** A village with everything defaulted, so each test states only what it means. */
function village(over: Partial<VillageProgress> = {}): VillageProgress {
  return { villageId: 'v1', extentAc: 100, done: {}, targets: {}, stages: {}, ...over };
}

const ALL_DONE = Object.fromEntries(STAGE_CODES.map(c => [c, 'COMPLETED' as const]));

describe('acresToSqKm', () => {
  it('converts using the exact factor', () => {
    expect(SQ_KM_PER_ACRE).toBeCloseTo(0.0040468564224, 12);
    // The worked example from the source sheet: 16.82 acres is 0.07 sq km.
    expect(acresToSqKm(16.82)).toBeCloseTo(0.068, 3);
  });

  it('converts a whole square kilometre back', () => {
    expect(acresToSqKm(247.105)).toBeCloseTo(1, 3);
  });

  it('handles zero without producing a negative zero', () => {
    expect(acresToSqKm(0)).toBe(0);
  });
});

describe('completion', () => {
  it('divides the work done by the target', () => {
    expect(completion(25, 100).pct).toBe(25);
    expect(completion(100, 100).complete).toBe(true);
  });

  it('reports an unknown percentage rather than zero when there is no target', () => {
    // Zero would read as "nothing done" and a hundred as "finished". Both
    // would be invented out of the absence of a denominator.
    const c = completion(480, null);
    expect(c.pct).toBeNull();
    expect(c.done).toBe(480);
    expect(c.complete).toBe(false);
  });

  it('treats a zero target as no target rather than dividing by it', () => {
    expect(completion(10, 0).pct).toBeNull();
  });

  it('does not cap overshoot at a hundred percent', () => {
    // A village can turn out to hold more parcels than the estimate. Hiding
    // that behind a capped bar is how a bad estimate survives a year.
    expect(completion(120, 100).pct).toBe(120);
  });

  it('rounds to two places rather than carrying float noise', () => {
    expect(completion(1, 3).pct).toBe(33.33);
  });
});

describe('villageState', () => {
  it('is not started when nothing has been recorded', () => {
    expect(villageState(village(), STAGE_CODES)).toBe('NOT_STARTED');
  });

  it('is in progress once any quantity is recorded', () => {
    expect(villageState(village({ done: { GOVT_LAND_POINTS: 12 } }), STAGE_CODES))
      .toBe('IN_PROGRESS');
  });

  it('is in progress once any stage has started, even with nothing counted', () => {
    // A crew can be on site for a week before anything is countable.
    expect(villageState(
      village({ stages: { GROUND_TRUTHING: 'IN_PROGRESS' } }), STAGE_CODES,
    )).toBe('IN_PROGRESS');
  });

  it('is complete only when every stage is complete', () => {
    expect(villageState(village({ stages: ALL_DONE }), STAGE_CODES)).toBe('COMPLETED');
  });

  it('is not complete while one stage is outstanding', () => {
    // A village whose parcels are all surveyed but whose records are not
    // prepared is not finished, and calling it finished makes the programme
    // look further along than it is.
    const stages = { ...ALL_DONE, RECORDS_PREPARATION: 'IN_PROGRESS' as const };
    expect(villageState(village({ stages, done: { GOVT_LAND_EXTENT_AC: 100 } }), STAGE_CODES))
      .toBe('IN_PROGRESS');
  });

  it('separates a village nobody visited from one that produced nothing', () => {
    // The request asks for "not started" as distinct from "pending", and the
    // two need different action.
    const untouched = villageState(village(), STAGE_CODES);
    const started = villageState(
      village({ stages: { GROUND_TRUTHING: 'IN_PROGRESS' }, done: { GOVT_LAND_POINTS: 0 } }),
      STAGE_CODES);
    expect(untouched).toBe('NOT_STARTED');
    expect(started).toBe('IN_PROGRESS');
  });
});

describe('rollUp', () => {
  it('counts each village into exactly one state', () => {
    const r = rollUp([
      village({ villageId: 'a' }),
      village({ villageId: 'b', done: { GOVT_LAND_POINTS: 5 } }),
      village({ villageId: 'c', stages: ALL_DONE }),
    ], MEASURE_CODES, STAGE_CODES, BASIS);
    expect(r.villages).toBe(3);
    expect(r.notStarted + r.inProgress + r.completed).toBe(3);
    expect(r).toMatchObject({ notStarted: 1, inProgress: 1, completed: 1 });
  });

  it('weights completion by extent instead of averaging percentages', () => {
    // The central correctness point. A 10-acre village fully surveyed and a
    // 990-acre village untouched is 1% of the work, not 50%.
    const r = rollUp([
      village({ villageId: 'small', extentAc: 10, done: { GOVT_LAND_EXTENT_AC: 10 } }),
      village({ villageId: 'large', extentAc: 990, done: { GOVT_LAND_EXTENT_AC: 0 } }),
    ], MEASURE_CODES, STAGE_CODES, BASIS);
    expect(r.overallPct).toBe(1);
    expect(r.overallPct).not.toBe(50);
  });

  it('divides the summed work by the summed target, not the other way round', () => {
    const r = rollUp([
      village({ villageId: 'a', extentAc: 100, done: { PRIVATE_LAND_EXTENT_AC: 50 } }),
      village({ villageId: 'b', extentAc: 300, done: { PRIVATE_LAND_EXTENT_AC: 150 } }),
    ], ['PRIVATE_LAND_EXTENT_AC'], STAGE_CODES, BASIS);
    // 200 of 400, which is also the mean here — chosen so the next test can
    // show the case where they differ.
    expect(r.measures.PRIVATE_LAND_EXTENT_AC.pct).toBe(50);
  });

  it('gives a different answer from the mean when the villages differ in size', () => {
    const villages = [
      village({ villageId: 'a', extentAc: 10, done: { GOVT_LAND_EXTENT_AC: 10 } }),
      village({ villageId: 'b', extentAc: 90, done: { GOVT_LAND_EXTENT_AC: 9 } }),
    ];
    const r = rollUp(villages, ['GOVT_LAND_EXTENT_AC'], STAGE_CODES, BASIS);
    const naiveMean = (100 + 10) / 2;
    expect(r.measures.GOVT_LAND_EXTENT_AC.pct).toBe(19);
    expect(r.measures.GOVT_LAND_EXTENT_AC.pct).not.toBe(naiveMean);
  });

  it('uses the recorded target for a measure with no natural denominator', () => {
    const r = rollUp([
      village({ villageId: 'a', done: { VILLAGE_BOUNDARY_POINTS: 40 }, targets: { VILLAGE_BOUNDARY_POINTS: 100 } }),
      village({ villageId: 'b', done: { VILLAGE_BOUNDARY_POINTS: 60 }, targets: { VILLAGE_BOUNDARY_POINTS: 100 } }),
    ], ['VILLAGE_BOUNDARY_POINTS'], STAGE_CODES, BASIS);
    expect(r.measures.VILLAGE_BOUNDARY_POINTS.pct).toBe(50);
  });

  it('reports a measure with no targets anywhere as unknown, not zero', () => {
    const r = rollUp([
      village({ villageId: 'a', done: { VILLAGE_BOUNDARY_POINTS: 40 } }),
    ], ['VILLAGE_BOUNDARY_POINTS'], STAGE_CODES, BASIS);
    expect(r.measures.VILLAGE_BOUNDARY_POINTS.done).toBe(40);
    expect(r.measures.VILLAGE_BOUNDARY_POINTS.pct).toBeNull();
  });

  it('never invents a percentage for a measure that does not express progress', () => {
    // Point counts under government land are worth recording and are not
    // progress towards anything.
    const r = rollUp([
      village({ villageId: 'a', done: { GOVT_LAND_POINTS: 900 } }),
    ], ['GOVT_LAND_POINTS'], STAGE_CODES, BASIS);
    expect(r.measures.GOVT_LAND_POINTS.pct).toBeNull();
    expect(r.measures.GOVT_LAND_POINTS.done).toBe(900);
  });

  it('counts villages with no extent rather than weighting them as one', () => {
    // Silently giving a missing extent a weight would distort the total and
    // nothing on screen would say so.
    const r = rollUp([
      village({ villageId: 'a', extentAc: 100, done: { GOVT_LAND_EXTENT_AC: 50 } }),
      village({ villageId: 'b', extentAc: null, done: { GOVT_LAND_EXTENT_AC: 20 } }),
    ], MEASURE_CODES, STAGE_CODES, BASIS);
    expect(r.unweighted).toBe(1);
    expect(r.extentAc).toBe(100);
  });

  it('reports an unknown overall percentage when no village carries an extent', () => {
    const r = rollUp([
      village({ villageId: 'a', extentAc: null, done: { GOVT_LAND_EXTENT_AC: 20 } }),
    ], MEASURE_CODES, STAGE_CODES, BASIS);
    expect(r.overallPct).toBeNull();
    expect(r.unweighted).toBe(1);
  });

  it('adds government and private extent into the surveyed total', () => {
    const r = rollUp([
      village({ extentAc: 100, done: { GOVT_LAND_EXTENT_AC: 30, PRIVATE_LAND_EXTENT_AC: 45 } }),
    ], MEASURE_CODES, STAGE_CODES, BASIS);
    expect(r.surveyedAc).toBe(75);
    expect(r.overallPct).toBe(75);
  });

  it('reports extent in both units from one stored figure', () => {
    const r = rollUp([village({ extentAc: 247.105 })], MEASURE_CODES, STAGE_CODES, BASIS);
    expect(r.extentAc).toBe(247.11);
    expect(r.extentSqKm).toBeCloseTo(1, 2);
  });

  it('handles an empty scope without dividing by zero', () => {
    const r = rollUp([], MEASURE_CODES, STAGE_CODES, BASIS);
    expect(r.villages).toBe(0);
    expect(r.overallPct).toBeNull();
    expect(r.extentAc).toBe(0);
  });

  it('is associative across levels: mandals summed equal the district', () => {
    // A district figure computed from its villages directly and one computed
    // by combining its mandals must agree, or two screens disagree.
    const all = [
      village({ villageId: 'a', extentAc: 100, done: { GOVT_LAND_EXTENT_AC: 40 } }),
      village({ villageId: 'b', extentAc: 250, done: { GOVT_LAND_EXTENT_AC: 125 } }),
      village({ villageId: 'c', extentAc: 50, done: { GOVT_LAND_EXTENT_AC: 5 } }),
    ];
    const whole = rollUp(all, ['GOVT_LAND_EXTENT_AC'], STAGE_CODES, BASIS);
    const m1 = rollUp(all.slice(0, 2), ['GOVT_LAND_EXTENT_AC'], STAGE_CODES, BASIS);
    const m2 = rollUp(all.slice(2), ['GOVT_LAND_EXTENT_AC'], STAGE_CODES, BASIS);

    expect(m1.surveyedAc + m2.surveyedAc).toBe(whole.surveyedAc);
    expect(m1.extentAc + m2.extentAc).toBe(whole.extentAc);
    const combined = ((m1.surveyedAc + m2.surveyedAc) / (m1.extentAc + m2.extentAc)) * 100;
    expect(Math.round(combined * 100) / 100).toBe(whole.overallPct);
  });
});

describe('periodBuckets', () => {
  it('splits a range into months, clipped to the range', () => {
    // A report asked for the 10th to the 20th must not quietly include the 21st.
    const b = periodBuckets('2026-01-10', '2026-03-20', 'MONTH');
    expect(b.map(p => [p.from, p.to])).toEqual([
      ['2026-01-10', '2026-01-31'],
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-03-20'],
    ]);
    expect(b[0].label).toBe('January 2026');
  });

  it('ends a week on Sunday', () => {
    // 2026-09-15 is a Tuesday; the survey week runs to the Sunday.
    const b = periodBuckets('2026-09-15', '2026-09-30', 'WEEK');
    expect(b[0]).toMatchObject({ from: '2026-09-15', to: '2026-09-20' });
    expect(b[1].from).toBe('2026-09-21');
  });

  it('treats a Sunday start as a whole week of its own', () => {
    const b = periodBuckets('2026-09-20', '2026-09-27', 'WEEK');
    expect(b[0]).toMatchObject({ from: '2026-09-20', to: '2026-09-20' });
  });

  it('splits by year and by day', () => {
    expect(periodBuckets('2025-12-30', '2026-01-02', 'YEAR').map(p => p.label))
      .toEqual(['2025', '2026']);
    expect(periodBuckets('2026-02-27', '2026-03-01', 'DAY').map(p => p.from))
      .toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });

  it('crosses a leap day correctly', () => {
    expect(periodBuckets('2028-02-27', '2028-03-01', 'DAY').map(p => p.from))
      .toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('returns one period for a single day', () => {
    const b = periodBuckets('2026-09-15', '2026-09-15', 'MONTH');
    expect(b).toEqual([{ from: '2026-09-15', to: '2026-09-15', label: 'September 2026' }]);
  });

  it('returns nothing for a backwards range rather than looping forever', () => {
    expect(periodBuckets('2026-09-30', '2026-09-01', 'DAY')).toEqual([]);
  });
});

describe('financialYearRange', () => {
  it('runs April to March', () => {
    expect(financialYearRange('2026-09-15')).toMatchObject({
      from: '2026-04-01', to: '2027-03-31', label: 'FY 2026-27',
    });
  });

  it('puts January in the year that began the previous April', () => {
    // The commonest off-by-one in Indian reporting.
    expect(financialYearRange('2026-01-15').from).toBe('2025-04-01');
  });

  it('gets both boundary days right', () => {
    expect(financialYearRange('2026-03-31').label).toBe('FY 2025-26');
    expect(financialYearRange('2026-04-01').label).toBe('FY 2026-27');
  });
});

describe('seeds', () => {
  it('has no duplicate measure or stage codes', () => {
    expect(new Set(MEASURE_CODES).size).toBe(MEASURE_CODES.length);
    expect(new Set(STAGE_CODES).size).toBe(STAGE_CODES.length);
  });

  it('covers every column the source sheet keeps', () => {
    for (const code of ['VILLAGE_BOUNDARY_POINTS', 'HABITATION_BOUNDARY_POINTS',
      'GOVT_LAND_PARCELS', 'GOVT_LAND_POINTS', 'GOVT_LAND_EXTENT_AC',
      'PRIVATE_LAND_PARCELS', 'PRIVATE_LAND_POINTS', 'PRIVATE_LAND_EXTENT_AC',
      'RECORDS_PREPARED', 'NOTICES_9_2_SERVED', 'LPMS_GENERATED']) {
      expect(MEASURE_CODES, code).toContain(code);
    }
  });

  it('measures extent-based progress against the village extent', () => {
    for (const code of ['GOVT_LAND_EXTENT_AC', 'PRIVATE_LAND_EXTENT_AC']) {
      expect(MEASURE_SEEDS.find(m => m.code === code)!.basis, code).toBe('EXTENT');
    }
  });

  it('keeps every measure in a named group, so the entry form can be laid out', () => {
    for (const m of MEASURE_SEEDS) expect(m.groupLabel, m.code).toBeTruthy();
  });

  it('tracks ground truthing and vectorization as stages, not quantities', () => {
    expect(STAGE_CODES).toContain('GROUND_TRUTHING');
    expect(STAGE_CODES).toContain('VECTORIZATION');
    expect(MEASURE_CODES).not.toContain('GROUND_TRUTHING');
  });

  it('does not seed a measure for villages completed', () => {
    // It is a roll-up of the village list. Typing it in is how it comes to
    // disagree with the villages themselves.
    expect(MEASURE_CODES.some(c => c.includes('VILLAGES_COMPLETED'))).toBe(false);
  });
});

describe('schemas', () => {
  it('accepts a day of progress with only today’s figures', () => {
    const r = surveyEntrySchema.safeParse({
      survey_village_id: '11111111-1111-4111-8111-111111111111',
      entry_date: '2026-09-15',
      teams_deployed: 3,
      values: { GOVT_LAND_POINTS: 42, GOVT_LAND_EXTENT_AC: 3.25 },
    });
    expect(r.success).toBe(true);
  });

  it('has no field for a cumulative figure at all', () => {
    // The typed cumulative is the thing that goes wrong, so there is nowhere
    // to type it.
    const keys = Object.keys(surveyEntrySchema.shape);
    expect(keys.some(k => k.toLowerCase().includes('cumulative'))).toBe(false);
  });

  it('refuses a negative quantity', () => {
    const r = surveyEntrySchema.safeParse({
      survey_village_id: '11111111-1111-4111-8111-111111111111',
      entry_date: '2026-09-15',
      values: { GOVT_LAND_POINTS: -1 },
    });
    expect(r.success).toBe(false);
  });

  it('refuses an ambiguous date', () => {
    const r = surveyEntrySchema.safeParse({
      survey_village_id: '11111111-1111-4111-8111-111111111111',
      entry_date: '15/09/2026',
      values: {},
    });
    expect(r.success).toBe(false);
  });

  it('refuses a measure code that an import could not round-trip', () => {
    expect(measureSchema.safeParse({
      code: 'lower case', label: 'x', unit: 'COUNT',
    }).success).toBe(false);
    expect(measureSchema.safeParse({
      code: 'NEW_MEASURE', label: 'New measure', unit: 'COUNT',
    }).success).toBe(true);
  });

  it('requires a completion date on a completed stage', () => {
    expect(stageUpdateSchema.safeParse({
      stage_code: 'GROUND_TRUTHING', state: 'COMPLETED',
    }).success).toBe(false);
    expect(stageUpdateSchema.safeParse({
      stage_code: 'GROUND_TRUTHING', state: 'COMPLETED', completed_on: '2026-09-15',
    }).success).toBe(true);
  });

  it('refuses a stage completed before it started', () => {
    expect(stageUpdateSchema.safeParse({
      stage_code: 'GROUND_TRUTHING', state: 'COMPLETED',
      started_on: '2026-09-15', completed_on: '2026-09-01',
    }).success).toBe(false);
  });
});

describe('role grants', () => {
  it('lets a crew record progress but not set its own target', () => {
    // Otherwise completion is measured against a number the same person can
    // move.
    for (const role of ['TEAM_LEAD', 'EMPLOYEE'] as const) {
      expect(SURVEY_ROLE_GRANTS[role]).toContain('survey.enter');
      expect(SURVEY_ROLE_GRANTS[role]).not.toContain('survey.target');
    }
  });

  it('gives an auditor reading and nothing else', () => {
    expect(SURVEY_ROLE_GRANTS.AUDITOR).toEqual(['survey.read']);
  });
});

describe('tasks driving survey state', () => {
  it('maps every task status onto a stage state', () => {
    // A status the mapping does not know would silently read as not started,
    // which is the most flattering possible answer and therefore the worst.
    expect(stageStateFromTask('TO_DO')).toBe('NOT_STARTED');
    expect(stageStateFromTask('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(stageStateFromTask('DONE')).toBe('COMPLETED');
    expect(stageStateFromTask('BLOCKED')).toBe('ON_HOLD');
  });

  it('treats a stage under review as still in progress', () => {
    // A village whose ground truthing is being checked is not finished, and
    // the survey report has no third thing to say about it.
    expect(stageStateFromTask('IN_REVIEW')).toBe('IN_PROGRESS');
  });

  it('takes a cancelled village out of the denominator rather than scoring it zero', () => {
    // Left in, it would hold the percentage down for ever and the programme
    // would never reach a hundred.
    expect(isOutOfScope('CANCELLED')).toBe(true);
    expect(isOutOfScope('DONE')).toBe(false);
    expect(isOutOfScope(null)).toBe(false);
  });

  it('reads an unlinked stage from its own columns', () => {
    const r = resolveStage({
      stageCode: 'GROUND_TRUTHING', linked: false,
      ownState: 'COMPLETED', ownStartedOn: '2026-09-01', ownCompletedOn: '2026-09-10',
    });
    expect(r).toMatchObject({
      state: 'COMPLETED', startedOn: '2026-09-01', completedOn: '2026-09-10', source: 'STAGE',
    });
  });

  it('reads a linked stage from the task and ignores its own columns', () => {
    // The whole point of the choice: one fact, one home. The stale columns
    // below must not win, or the two disagree within a week.
    const r = resolveStage({
      stageCode: 'GROUND_TRUTHING', linked: true,
      taskStatus: 'DONE',
      taskStartedAt: '2026-09-02T06:00:00Z', taskCompletedAt: '2026-09-11T14:00:00Z',
      ownState: 'NOT_STARTED', ownStartedOn: null, ownCompletedOn: null,
    });
    expect(r).toMatchObject({
      state: 'COMPLETED', startedOn: '2026-09-02', completedOn: '2026-09-11', source: 'TASK',
    });
  });

  it('uses when the work happened, not when it was planned', () => {
    // The summary sheet reports the actual GT start and completion dates.
    const r = resolveStage({
      stageCode: 'GROUND_TRUTHING', linked: true, taskStatus: 'IN_PROGRESS',
      taskStartedAt: '2026-09-05T09:30:00Z', taskCompletedAt: null,
    });
    expect(r.startedOn).toBe('2026-09-05');
    expect(r.completedOn).toBeNull();
  });

  it('reports a linked stage with no task status as not started', () => {
    expect(resolveStage({ stageCode: 'X', linked: true, taskStatus: null }).state)
      .toBe('NOT_STARTED');
  });

  it('feeds the village state, so a linked village completes when its tasks do', () => {
    const stages = resolveStages(STAGE_CODES.map(code => ({
      stageCode: code, linked: true, taskStatus: 'DONE',
    })));
    expect(villageState(village({ stages }), STAGE_CODES)).toBe('COMPLETED');
  });

  it('keeps a village open while one linked stage is still blocked', () => {
    const stages = resolveStages(STAGE_CODES.map((code, i) => ({
      stageCode: code, linked: true, taskStatus: i === 0 ? 'BLOCKED' : 'DONE',
    })));
    expect(villageState(village({ stages }), STAGE_CODES)).toBe('IN_PROGRESS');
  });
});

describe('plannedTasksFor', () => {
  it('names the village task by where the work is', () => {
    const plan = plannedTasksFor({ name: 'ADAKULA', mandalName: 'KOYYURU' },
      STAGE_SEEDS.map(s => ({ code: s.code, label: s.label })));
    expect(plan.parent).toBe('Survey ADAKULA, KOYYURU');
  });

  it('makes one subtask per stage, in the order the work runs', () => {
    const plan = plannedTasksFor({ name: 'ADAKULA' },
      STAGE_SEEDS.map(s => ({ code: s.code, label: s.label })));
    expect(plan.children.map(c => c.stageCode)).toEqual(STAGE_CODES);
    expect(plan.children[0].title).toBe('Ground truthing — ADAKULA');
  });

  it('copes with a village whose mandal is not recorded', () => {
    expect(plannedTasksFor({ name: 'Orphan', mandalName: null }, []).parent)
      .toBe('Survey Orphan');
  });
});

describe('the stage pipeline', () => {
  it('puts quality control between ground truthing and vectorization', () => {
    // Without it, a village whose GT had failed QC looked exactly like one
    // whose GT was simply done.
    const codes = STAGE_PIPELINE.map(s => s.code);
    expect(codes.indexOf('GT_QC')).toBeGreaterThan(codes.indexOf('GROUND_TRUTHING'));
    expect(codes.indexOf('GT_QC')).toBeLessThan(codes.indexOf('VECTORIZATION'));
  });

  it('chains every stage after the first to its predecessor', () => {
    for (const [i, stage] of STAGE_PIPELINE.entries()) {
      if (i === 0) expect(stage.requires).toBeUndefined();
      else expect(stage.requires, stage.code).toBe(STAGE_PIPELINE[i - 1].code);
    }
  });

  it('records daily progress against ground truthing only', () => {
    // The crews count parcels and points while ground truthing; the later
    // stages are done or not.
    const tracking = STAGE_PIPELINE.filter(s => s.tracksDailyProgress).map(s => s.code);
    expect(tracking).toEqual(['GROUND_TRUTHING']);
  });
});

describe('stageBlockedBy', () => {
  it('names the stage in the way rather than just refusing', () => {
    expect(stageBlockedBy('GT_QC', { GROUND_TRUTHING: 'IN_PROGRESS' })).toBe('GROUND_TRUTHING');
  });

  it('lets a stage start once its predecessor is complete', () => {
    expect(stageBlockedBy('GT_QC', { GROUND_TRUTHING: 'COMPLETED' })).toBeNull();
  });

  it('never blocks the first stage', () => {
    expect(stageBlockedBy('GROUND_TRUTHING', {})).toBeNull();
  });

  it('treats a stage on hold as not complete', () => {
    expect(stageBlockedBy('VECTORIZATION', { GT_QC: 'ON_HOLD' })).toBe('GT_QC');
  });
});

describe('currentStage', () => {
  it('is where the work is waiting, not where it finished', () => {
    // A village whose GT is done and whose QC has not begun is at QC.
    expect(currentStage({ GROUND_TRUTHING: 'COMPLETED' })).toEqual({
      code: 'GT_QC', state: 'NOT_STARTED',
    });
  });

  it('is the first stage for an untouched village', () => {
    expect(currentStage({})).toEqual({ code: 'GROUND_TRUTHING', state: 'NOT_STARTED' });
  });

  it('reports the last stage once everything is complete', () => {
    const all = Object.fromEntries(STAGE_PIPELINE.map(s => [s.code, 'COMPLETED' as const]));
    expect(currentStage(all)).toEqual({ code: 'LPM_GENERATION', state: 'COMPLETED' });
  });

  it('stops at a stage that is on hold rather than walking past it', () => {
    expect(currentStage({ GROUND_TRUTHING: 'ON_HOLD' })).toEqual({
      code: 'GROUND_TRUTHING', state: 'ON_HOLD',
    });
  });
});

describe('outOfSequence', () => {
  it('finds a stage started before its predecessor finished', () => {
    // Reported rather than prevented: the task board is not the survey
    // module's to police, and a card moved out of order is worth surfacing.
    expect(outOfSequence({ GROUND_TRUTHING: 'IN_PROGRESS', VECTORIZATION: 'IN_PROGRESS' }))
      .toContain('VECTORIZATION');
  });

  it('says nothing about a properly ordered village', () => {
    expect(outOfSequence({
      GROUND_TRUTHING: 'COMPLETED', GT_QC: 'COMPLETED', VECTORIZATION: 'IN_PROGRESS',
    })).toEqual([]);
  });

  it('says nothing about an untouched village', () => {
    expect(outOfSequence({})).toEqual([]);
  });
});

describe('tallyByStage', () => {
  it('answers how many villages sit at each state of each stage', () => {
    // The overall village state cannot: "in progress" covers a village on its
    // first day of GT and one waiting for its LPM.
    const tally = tallyByStage([
      { stages: {} },
      { stages: { GROUND_TRUTHING: 'IN_PROGRESS' } },
      { stages: { GROUND_TRUTHING: 'COMPLETED', GT_QC: 'IN_PROGRESS' } },
      { stages: { GROUND_TRUTHING: 'COMPLETED', GT_QC: 'ON_HOLD' } },
    ]);
    expect(tally.GROUND_TRUTHING).toEqual({
      notStarted: 1, inProgress: 1, completed: 2, onHold: 0,
    });
    expect(tally.GT_QC).toEqual({ notStarted: 2, inProgress: 1, completed: 0, onHold: 1 });
  });

  it('counts every village into exactly one state per stage', () => {
    const villages = Array.from({ length: 7 }, () => ({ stages: {} }));
    const tally = tallyByStage(villages);
    for (const stage of STAGE_PIPELINE) {
      const t = tally[stage.code];
      expect(t.notStarted + t.inProgress + t.completed + t.onHold, stage.code).toBe(7);
    }
  });

  it('reports every stage even when nothing has reached it', () => {
    const tally = tallyByStage([]);
    expect(Object.keys(tally).sort()).toEqual(STAGE_PIPELINE.map(s => s.code).sort());
  });
});

describe('roverUtilisation', () => {
  it('reports what is sitting idle, which is the point of the figure', () => {
    // Thirty allocated and eleven used is nineteen in a store while the
    // schedule assumes otherwise.
    const r = roverUtilisation({ allocated: 30, used: 11 });
    expect(r.idle).toBe(19);
    expect(r.utilisationPct).toBe(36.67);
  });

  it('reports full utilisation without an idle count', () => {
    expect(roverUtilisation({ allocated: 8, used: 8 })).toMatchObject({
      idle: 0, utilisationPct: 100, overUsed: false,
    });
  });

  it('flags equipment used beyond what was allocated rather than going negative', () => {
    // Somebody is running a rover that is not on the books.
    const r = roverUtilisation({ allocated: 5, used: 7 });
    expect(r.overUsed).toBe(true);
    expect(r.idle).toBe(0);
  });

  it('has no percentage when nothing is allocated', () => {
    expect(roverUtilisation({ allocated: 0, used: 0 }).utilisationPct).toBeNull();
  });
});

describe('pace', () => {
  const base = {
    surveyedAc: 300, remainingAc: 700, villagesCompleted: 6,
    activeDays: 10, calendarDays: 30, asOf: '2026-09-16',
  };

  it('separates how fast a crew works from how fast the work goes', () => {
    // A schedule built on the first and delivered on the second is how a
    // programme slips without anybody seeing it happen.
    const p = pace(base);
    expect(p.acresPerActiveDay).toBe(30);
    expect(p.acresPerCalendarDay).toBe(10);
  });

  it('projects the finish from the calendar rate, not the working rate', () => {
    const p = pace(base);
    expect(p.daysToFinish).toBe(70);
    expect(p.projectedFinish).toBe('2026-11-25');
  });

  it('projects nothing when no progress has been made', () => {
    // Dividing by a zero rate would produce Infinity and a date in the year
    // 275760, which is worse than saying nothing.
    const p = pace({ ...base, surveyedAc: 0 });
    expect(p.daysToFinish).toBeNull();
    expect(p.projectedFinish).toBeNull();
  });

  it('projects nothing when the work is already done', () => {
    expect(pace({ ...base, remainingAc: 0 }).projectedFinish).toBeNull();
  });

  it('survives a window with no days in it', () => {
    const p = pace({ ...base, activeDays: 0, calendarDays: 0 });
    expect(p.acresPerActiveDay).toBeNull();
    expect(p.acresPerCalendarDay).toBeNull();
    expect(p.projectedFinish).toBeNull();
  });
});

describe('crew and rover schemas', () => {
  it('assigns an employee to a village for a named stage', () => {
    // Several employees work one village; the crew is per stage because the
    // GT crew is not the vectorization team.
    expect(crewAssignmentSchema.safeParse({
      employee_id: '11111111-1111-4111-8111-111111111111',
      stage_code: 'GROUND_TRUTHING',
    }).success).toBe(true);
  });

  it('refuses a rover released before it was allocated', () => {
    expect(roverAllocationSchema.safeParse({
      asset_id: '11111111-1111-4111-8111-111111111111',
      allocated_on: '2026-09-10', released_on: '2026-09-01',
    }).success).toBe(false);
  });

  it('accepts a rover still out', () => {
    expect(roverAllocationSchema.safeParse({
      asset_id: '11111111-1111-4111-8111-111111111111',
      allocated_on: '2026-09-10',
    }).success).toBe(true);
  });

  it('carries the remarks the workflow asks for on every stage', () => {
    expect(stageRemarkSchema.safeParse({
      stage_code: 'GT_QC', state: 'IN_PROGRESS', remarks: 'Two parcels disputed',
    }).success).toBe(true);
  });
});

describe('roverWindow', () => {
  it('counts instrument-days, not instruments', () => {
    // "Six rovers" means something different over a day and a fortnight.
    const w = roverWindow([
      { allocated: 3, used: 2 },
      { allocated: 3, used: 3 },
    ]);
    expect(w.allocatedRoverDays).toBe(6);
    expect(w.usedRoverDays).toBe(5);
    expect(w.idleRoverDays).toBe(1);
  });

  it('separates a day nobody reported from a day reporting nothing used', () => {
    // The first is a reporting failure and the equipment may well have been
    // working; the second is somebody saying the rovers sat there. Folding
    // them together turns one into the other.
    const w = roverWindow([
      { allocated: 2, used: null },  // nobody filed
      { allocated: 2, used: 0 },     // filed, nothing used
    ]);
    expect(w.daysNotReported).toBe(1);
    expect(w.unreportedRoverDays).toBe(2);
    expect(w.daysReportedIdle).toBe(1);
    // Only the reported day counts as waste.
    expect(w.idleRoverDays).toBe(2);
  });

  it('keeps an unreported day out of the utilisation figure', () => {
    // Scoring it as waste would make a missing return look like idle kit.
    const w = roverWindow([
      { allocated: 4, used: 4 },
      { allocated: 4, used: null },
    ]);
    expect(w.utilisationPct).toBe(100);
    expect(w.unreportedRoverDays).toBe(4);
  });

  it('has no percentage when nothing was allocated', () => {
    expect(roverWindow([{ allocated: 0, used: null }]).utilisationPct).toBeNull();
    expect(roverWindow([]).utilisationPct).toBeNull();
  });

  it('does not report negative idle when more was used than allocated', () => {
    const w = roverWindow([{ allocated: 2, used: 5 }]);
    expect(w.idleRoverDays).toBe(0);
    expect(w.utilisationPct).toBe(250);
  });

  it('ignores an unallocated day entirely', () => {
    // No instruments out means nothing to account for, reported or not.
    const w = roverWindow([{ allocated: 0, used: null }, { allocated: 2, used: 1 }]);
    expect(w.daysNotReported).toBe(0);
    expect(w.allocatedRoverDays).toBe(2);
  });
});

describe('rankByWaste', () => {
  const row = (over: Partial<RoverWindow>): RoverWindow => ({
    allocatedRoverDays: 10, usedRoverDays: 5, idleRoverDays: 5, utilisationPct: 50,
    daysNotReported: 0, unreportedRoverDays: 0, daysReportedIdle: 0, ...over,
  });

  it('surfaces the worst offender first', () => {
    const ranked = rankByWaste([
      row({ idleRoverDays: 2 }),
      row({ idleRoverDays: 9 }),
      row({ idleRoverDays: 5 }),
    ]);
    expect(ranked.map(r => r.idleRoverDays)).toEqual([9, 5, 2]);
  });

  it('breaks a tie on what is simply unaccounted for', () => {
    const ranked = rankByWaste([
      row({ idleRoverDays: 4, unreportedRoverDays: 1 }),
      row({ idleRoverDays: 4, unreportedRoverDays: 8 }),
    ]);
    expect(ranked[0].unreportedRoverDays).toBe(8);
  });

  it('sorts a village with nothing allocated last, whatever its percentage', () => {
    // It cannot be wasting what it was never given.
    const ranked = rankByWaste([
      row({ allocatedRoverDays: 0, idleRoverDays: 0, utilisationPct: null }),
      row({ idleRoverDays: 1 }),
    ]);
    expect(ranked[0].idleRoverDays).toBe(1);
    expect(ranked[1].allocatedRoverDays).toBe(0);
  });
});

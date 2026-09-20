import { describe, expect, it } from 'vitest';
import {
  MEASURE_CODES, MEASURE_SEEDS, STAGE_CODES, STAGE_SEEDS, SQ_KM_PER_ACRE,
  SURVEY_ROLE_GRANTS, acresToSqKm, completion, financialYearRange, measureSchema,
  periodBuckets, rollUp, stageUpdateSchema, surveyEntrySchema, villageState,
  stageStateFromTask, isOutOfScope, resolveStage, resolveStages, plannedTasksFor,
  STAGE_PIPELINE, stageBlockedBy, currentStage, outOfSequence, tallyByStage,
  roverUtilisation, pace, crewAssignmentSchema, roverAllocationSchema, stageRemarkSchema,
  roverWindow, rankByWaste, type RoverWindow,
  DELAY_REASONS, delayReasonLabel, reasonNeedsRemarks, checkRoverDay, checkLowProgress,
  villageStatus, programmeVisible, SURVEY_PROJECT_STATUSES, SURVEY_PROJECT_STATUS_LABELS,
  forecast, findBottlenecks, BOTTLENECK_KINDS, BOTTLENECK_LABELS, type BottleneckInput,
  type MeasureBasis, type VillageProgress,
  periodContaining, previousPeriod, comparePeriods, surveyVillageCreateSchema,
  villageBillingBulkSchema, BILLING_SKIP_LABELS,
  summariseStaffing, staffingNote, stageTracksStaffing, type StaffingDay,
  milestoneEarned, milestoneBlockedNote, villageFinalsSchema, certifiedDifference,
  gcpSchema, checkGcp, GCP_WARNING_NOTES, formatCoordinate,
  extentVariancePct, extentVaries,
  VILLAGE_LADDER, villagePosition, tallyByPosition, LADDER_KEYS, LADDER_INDEX,
  gtStartSchema, milestoneBlockedNote,
  stageVariance, varianceNote, villageVariances, stageUpdateSchema,
  DELAY_REASON_CODES,
  gtReasonRequired, surveyEntrySchema, surveyEntryPatchSchema,
  surveyEntryBase,
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
    const stages = { ...ALL_DONE, FINAL_DELIVERABLES: 'IN_PROGRESS' as const };
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
    // Read off the base object: the exported schema carries a refinement, and
    // a refined schema is a ZodEffects with no `.shape` to look at.
    const keys = Object.keys(surveyEntryBase.shape);
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

  it('gives an auditor reading and the forecast, and no way to change anything', () => {
    // An auditor reads management information including the projection; what
    // they must not have is any of the write permissions.
    expect(SURVEY_ROLE_GRANTS.AUDITOR)
      .toEqual(['survey.read', 'survey.forecast', 'survey.dashboard']);
    for (const write of ['survey.enter', 'survey.manage', 'survey.target', 'survey.assign']) {
      expect(SURVEY_ROLE_GRANTS.AUDITOR, write).not.toContain(write);
    }
  });

  it('keeps the forecast from the roles the specification excludes', () => {
    // "Employees should not see management-only forecast information."
    for (const role of ['EMPLOYEE', 'TEAM_LEAD'] as const) {
      expect(SURVEY_ROLE_GRANTS[role], role).not.toContain('survey.forecast');
    }
    expect(SURVEY_ROLE_GRANTS.PROJECT_MANAGER).toContain('survey.forecast');
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

  it('chains every stage on the forward sequence to the one before it', () => {
    const sequence = STAGE_PIPELINE.filter(s => !s.offSequence);
    for (const [i, stage] of sequence.entries()) {
      if (i === 0) expect(stage.requires).toBeUndefined();
      else expect(stage.requires, stage.code).toBe(sequence[i - 1].code);
    }
  });

  it('runs the stages the specification names, in order', () => {
    expect(STAGE_PIPELINE.filter(s => !s.offSequence).map(s => s.code)).toEqual([
      'GROUND_TRUTHING', 'GT_QC', 'VECTORIZATION', 'DATA_SUBMISSION', 'FINAL_DELIVERABLES',
    ]);
  });

  it('keeps rework off the forward sequence', () => {
    // It is entered from wherever the work failed, not reached in order, and
    // not something every village passes through.
    const rework = STAGE_PIPELINE.find(s => s.code === 'REWORK')!;
    expect(rework.offSequence).toBe(true);
    expect(rework.requires).toBeUndefined();
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

  it('reports the last stage of the sequence once everything is complete', () => {
    const all = Object.fromEntries(STAGE_PIPELINE.map(s => [s.code, 'COMPLETED' as const]));
    expect(currentStage(all)).toEqual({ code: 'FINAL_DELIVERABLES', state: 'COMPLETED' });
  });

  it('says a village in rework is in rework, whatever the sequence says', () => {
    const all = Object.fromEntries(
      STAGE_PIPELINE.filter(s => !s.offSequence).map(s => [s.code, 'COMPLETED' as const]));
    expect(currentStage({ ...all, REWORK: 'IN_PROGRESS' }))
      .toEqual({ code: 'REWORK', state: 'IN_PROGRESS' });
  });

  it('completes a village that never needed rework', () => {
    // The trap: counting rework as a step means no village ever completes,
    // because one that never needed it never completes it.
    const codes = STAGE_PIPELINE.map(s => s.code);
    const done = Object.fromEntries(
      STAGE_PIPELINE.filter(s => !s.offSequence).map(s => [s.code, 'COMPLETED' as const]));
    expect(villageState(village({ stages: done }), codes)).toBe('COMPLETED');
  });

  it('counts a village in rework as still in progress', () => {
    const codes = STAGE_PIPELINE.map(s => s.code);
    expect(villageState(village({ stages: { REWORK: 'IN_PROGRESS' } }), codes))
      .toBe('IN_PROGRESS');
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

describe('delay reasons', () => {
  it('covers every reason the specification lists', () => {
    for (const label of ['Weather', 'Local or access issue', 'Equipment problem',
      'Rover issue', 'Data or technical issue', 'Employee issue', 'Field conditions',
      'Dependency on another team', 'No departmental staff', 'Other']) {
      expect(DELAY_REASONS.map(r => r.label), label).toContain(label);
    }
  });

  it('puts "other" last, where an escape hatch belongs', () => {
    expect(DELAY_REASONS[DELAY_REASONS.length - 1].code).toBe('OTHER');
  });

  it('demands remarks only for "other"', () => {
    // A free-text reason on every row is unanalysable; a fixed list with no
    // escape hatch gets the nearest wrong option picked.
    expect(reasonNeedsRemarks('OTHER')).toBe(true);
    expect(reasonNeedsRemarks('WEATHER')).toBe(false);
  });

  it('labels an unknown code rather than showing nothing', () => {
    expect(delayReasonLabel('MYSTERY')).toBe('MYSTERY');
    expect(delayReasonLabel(null)).toBe('—');
  });
});

describe('checkRoverDay', () => {
  it('accepts a properly accounted day', () => {
    expect(checkRoverDay([
      { assetId: 'a', status: 'UTILIZED', areaAc: 4 },
      { assetId: 'b', status: 'IDLE', idleReason: 'WEATHER' },
    ])).toEqual([]);
  });

  it('refuses an idle rover with no reason', () => {
    // The specification makes this mandatory, and it is the whole value of
    // the idle count: nineteen idle rovers with no reasons is not a finding.
    const problems = checkRoverDay([{ assetId: 'a', status: 'IDLE' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('must say why');
  });

  it('refuses "other" with nothing written', () => {
    expect(checkRoverDay([
      { assetId: 'a', status: 'IDLE', idleReason: 'OTHER' },
    ])[0]).toContain('must say what happened');
  });

  it('accepts "other" once something is written', () => {
    expect(checkRoverDay([
      { assetId: 'a', status: 'IDLE', idleReason: 'OTHER', remarks: 'Landowner dispute' },
    ])).toEqual([]);
  });

  it('refuses a reason it does not know', () => {
    expect(checkRoverDay([
      { assetId: 'a', status: 'IDLE', idleReason: 'BECAUSE' },
    ])[0]).toContain('not a reason this system knows');
  });

  it('refuses a rover reported twice on one day', () => {
    // It would be counted twice in the utilisation and the idle figures both.
    expect(checkRoverDay([
      { assetId: 'a', status: 'UTILIZED' },
      { assetId: 'a', status: 'IDLE', idleReason: 'WEATHER' },
    ])[0]).toContain('reported twice');
  });

  it('refuses a rover both in use and idle', () => {
    expect(checkRoverDay([
      { assetId: 'a', status: 'UTILIZED', idleReason: 'WEATHER' },
    ])[0]).toContain('cannot also carry an idle reason');
  });
});

describe('checkLowProgress', () => {
  it('flags a day under the threshold and demands a reason', () => {
    const c = checkLowProgress({ areaToday: 2, threshold: 5, roversOut: 3 });
    expect(c).toMatchObject({ isLow: true, threshold: 5, needsReason: true });
  });

  it('is satisfied by a day that meets the threshold', () => {
    expect(checkLowProgress({ areaToday: 5, threshold: 5, roversOut: 3 }).isLow).toBe(false);
  });

  it('demands nothing when no threshold is configured', () => {
    // The alternative is nagging every crew to explain a rule nobody set.
    expect(checkLowProgress({ areaToday: 0, threshold: null, roversOut: 3 }))
      .toMatchObject({ isLow: false, needsReason: false });
  });

  it('does not call a day with no rovers out low progress', () => {
    // Nothing was expected of it.
    expect(checkLowProgress({ areaToday: 0, threshold: 5, roversOut: 0 }).isLow).toBe(false);
  });
});

describe('villageStatus', () => {
  const codes = STAGE_PIPELINE.map(s => s.code);
  const allDone = Object.fromEntries(codes.map(c => [c, 'COMPLETED' as const]));

  it('derives to-do, in progress and completed from the stages', () => {
    expect(villageStatus({}, codes)).toBe('TO_DO');
    expect(villageStatus({ GROUND_TRUTHING: 'IN_PROGRESS' }, codes)).toBe('IN_PROGRESS');
    expect(villageStatus(allDone, codes)).toBe('COMPLETED');
  });

  it('lets a hold override the derived answer', () => {
    // A hold is a decision somebody made, which the stages cannot see.
    expect(villageStatus({ GROUND_TRUTHING: 'IN_PROGRESS' }, codes, 'ON_HOLD')).toBe('ON_HOLD');
  });

  it('lets rework override a completed village', () => {
    // Rework is a judgement that finished work was not good enough, and the
    // stages still say it is finished.
    expect(villageStatus(allDone, codes, 'REWORK')).toBe('REWORK');
  });

  it('ignores an override that is not a hold or rework', () => {
    expect(villageStatus(allDone, codes, 'TO_DO')).toBe('COMPLETED');
  });
});

describe('programme visibility', () => {
  it('hides a disabled programme without touching its data', () => {
    expect(programmeVisible('DISABLED')).toBe(false);
    expect(programmeVisible('ACTIVE')).toBe(true);
    expect(programmeVisible(null)).toBe(true);
  });

  it('labels every status the specification names', () => {
    for (const s of SURVEY_PROJECT_STATUSES) expect(SURVEY_PROJECT_STATUS_LABELS[s], s).toBeTruthy();
  });
});

describe('forecast', () => {
  const base = {
    targetDate: '2026-09-30', remainingAc: 1000,
    acresPerCalendarDay: 50, asOf: '2026-09-17',
  };

  it('keeps the promise and the arithmetic apart', () => {
    // The specification is right that these are different kinds of claim, and
    // presenting the forecast as a target is how a slipping programme keeps
    // looking fine.
    const f = forecast(base);
    expect(f.targetDate).toBe('2026-09-30');
    expect(f.forecastDate).toBe('2026-10-07');
    expect(f.state).toBe('BEHIND');
    expect(f.slipDays).toBe(7);
  });

  it('gives the required pace, which is the half worth arguing with', () => {
    // "You are behind" invites argument; "you need 77 a day and you are doing
    // 50" does not.
    const f = forecast(base);
    expect(f.currentPaceAcPerDay).toBe(50);
    expect(f.requiredPaceAcPerDay).toBe(76.92);
  });

  it('reports being ahead as its own state, not as merely not-behind', () => {
    const f = forecast({ ...base, acresPerCalendarDay: 200 });
    expect(f.state).toBe('AHEAD');
    expect(f.slipDays).toBeLessThan(0);
  });

  it('is on track when the two dates meet', () => {
    // 1000 acres, 13 days to the target, so 77 a day lands exactly.
    const f = forecast({ ...base, acresPerCalendarDay: 1000 / 13 });
    expect(f.state).toBe('ON_TRACK');
  });

  it('forecasts nothing from a pace of nothing', () => {
    // Dividing by a zero rate gives a date in the year 275760.
    const f = forecast({ ...base, acresPerCalendarDay: 0 });
    expect(f.forecastDate).toBeNull();
    expect(f.state).toBe('NO_PACE');
  });

  it('says there is no target rather than inventing one', () => {
    expect(forecast({ ...base, targetDate: null }).state).toBe('NO_TARGET');
  });

  it('asks for no pace once the work is done', () => {
    const f = forecast({ ...base, remainingAc: 0 });
    expect(f.forecastDate).toBe('2026-09-17');
    expect(f.requiredPaceAcPerDay).toBeNull();
  });

  it('reports no required pace for a target already past', () => {
    // No rate satisfies "finish yesterday", and a vast number is not read.
    const f = forecast({ ...base, targetDate: '2026-09-01' });
    expect(f.requiredPaceAcPerDay).toBeNull();
    expect(f.state).toBe('BEHIND');
  });
});

describe('findBottlenecks', () => {
  const opts = { asOf: '2026-09-17', stageSlaDays: 14 };
  const village = (over: Partial<BottleneckInput> = {}): BottleneckInput => ({
    villageId: 'v', village: 'V', status: 'IN_PROGRESS',
    currentStageCode: 'GROUND_TRUTHING', daysInStage: 3, ...over,
  });

  it('says nothing about a village that is fine', () => {
    expect(findBottlenecks([village()], opts)).toEqual([]);
  });

  it('finds a village that should have started and has not', () => {
    const [b] = findBottlenecks(
      [village({ status: 'TO_DO', plannedStartOn: '2026-09-01', daysInStage: null })], opts);
    expect(b.kinds).toContain('NOT_STARTED_BY_PLAN');
    expect(b.severityDays).toBe(16);
  });

  it('finds a village sitting in one stage past the SLA', () => {
    const [b] = findBottlenecks([village({ daysInStage: 20 })], opts);
    expect(b.kinds).toContain('STAGE_OVERDUE');
    expect(b.severityDays).toBe(6);
  });

  it('reports every reason a village is stuck, not just the first', () => {
    // Past its date *and* with idle rovers is a different conversation from
    // merely late.
    const [b] = findBottlenecks([village({
      daysInStage: 30, expectedCompletionOn: '2026-09-01', idleRoverDays: 4,
    })], opts);
    expect(b.kinds).toEqual(expect.arrayContaining([
      'STAGE_OVERDUE', 'PAST_EXPECTED_COMPLETION', 'ROVERS_IDLE',
    ]));
  });

  it('treats silence as a finding only for work under way', () => {
    // A village nobody has started is not "silent", it is waiting.
    const started = findBottlenecks([village({ lastEntryOn: '2026-09-01' })], opts);
    expect(started[0].kinds).toContain('NO_PROGRESS_RECORDED');
    const waiting = findBottlenecks(
      [village({ status: 'TO_DO', lastEntryOn: '2026-09-01', daysInStage: null })], opts);
    expect(waiting).toEqual([]);
  });

  it('does not call a finished village overdue', () => {
    expect(findBottlenecks([village({
      status: 'COMPLETED', daysInStage: 40, expectedCompletionOn: '2026-09-01',
    })], opts)).toEqual([]);
  });

  it('flags a village in rework', () => {
    expect(findBottlenecks([village({ status: 'REWORK' })], opts)[0].kinds)
      .toContain('IN_REWORK');
  });

  it('puts the worst first, measured in days rather than a score', () => {
    const found = findBottlenecks([
      village({ villageId: 'a', daysInStage: 20 }),
      village({ villageId: 'b', daysInStage: 60 }),
      village({ villageId: 'c', daysInStage: 30 }),
    ], opts);
    expect(found.map(b => b.villageId)).toEqual(['b', 'c', 'a']);
  });

  it('labels every kind it can report', () => {
    for (const k of BOTTLENECK_KINDS) expect(BOTTLENECK_LABELS[k], k).toBeTruthy();
  });
});

describe('the period a report covers', () => {
  it('gives the whole week a Wednesday falls in, not the week so far', () => {
    // A report for "this week" run on Wednesday means Monday to Sunday.
    // Clipping it would answer a different question and make every
    // week-on-week comparison meaningless.
    expect(periodContaining('2026-09-16', 'WEEK'))
      .toMatchObject({ from: '2026-09-14', to: '2026-09-20' });
  });

  it('starts weeks on Monday, including for a Sunday', () => {
    // Sunday ends the week it belongs to; it does not start the next one.
    expect(periodContaining('2026-09-20', 'WEEK'))
      .toMatchObject({ from: '2026-09-14', to: '2026-09-20' });
    expect(periodContaining('2026-09-14', 'WEEK').from).toBe('2026-09-14');
  });

  it('gives the whole month, and the whole year', () => {
    expect(periodContaining('2026-09-16', 'MONTH'))
      .toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(periodContaining('2026-02-10', 'MONTH').to).toBe('2026-02-28');
    expect(periodContaining('2026-09-16', 'YEAR'))
      .toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('gives a single day for the daily report', () => {
    expect(periodContaining('2026-09-16', 'DAY'))
      .toMatchObject({ from: '2026-09-16', to: '2026-09-16' });
  });

  it('steps back a whole period, across a month and a year boundary', () => {
    expect(previousPeriod(periodContaining('2026-09-16', 'WEEK'), 'WEEK').from)
      .toBe('2026-09-07');
    expect(previousPeriod(periodContaining('2026-09-16', 'MONTH'), 'MONTH'))
      .toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(previousPeriod(periodContaining('2026-01-10', 'MONTH'), 'MONTH'))
      .toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(previousPeriod(periodContaining('2026-03-02', 'DAY'), 'DAY').from)
      .toBe('2026-03-01');
  });
});

describe('comparing a period with the one before it', () => {
  it('reports the direction and the size of the change', () => {
    expect(comparePeriods(400, 320)).toMatchObject({
      change: 80, changePct: 25, direction: 'UP',
    });
    expect(comparePeriods(240, 320)).toMatchObject({
      change: -80, changePct: -25, direction: 'DOWN',
    });
  });

  it('says nothing about the percentage when there was nothing before', () => {
    // The first week of a programme has not improved by any percentage, and
    // "+100%" against a start from nothing is a number that means nothing.
    expect(comparePeriods(400, 0).changePct).toBeNull();
    expect(comparePeriods(400, 0).direction).toBe('UP');
  });

  it('calls no change flat rather than up or down', () => {
    expect(comparePeriods(320, 320)).toMatchObject({
      change: 0, changePct: 0, direction: 'FLAT',
    });
  });
});

describe("the date on a day's return", () => {
  const entry = (entry_date: string) => surveyEntrySchema.safeParse({
    survey_village_id: '11111111-1111-4111-8111-111111111111',
    entry_date, teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 5 },
  });

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  it('takes today, in Indian time', () => {
    // A crew filing at half past midnight in Vijayawada is filing on today's
    // date; UTC still thinks it is yesterday evening.
    expect(entry(today).success).toBe(true);
  });

  it('takes a day that has already happened', () => {
    expect(entry('2026-01-15').success).toBe(true);
  });

  it('refuses tomorrow', () => {
    const t = new Date(`${today}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    const r = entry(t.toISOString().slice(0, 10));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain('has not happened yet');
    }
  });

  it('refuses a month and a day the calendar does not have', () => {
    // Both match YYYY-MM-DD. Postgres refuses them too, but as a driver error
    // that surfaces as a 500 rather than as a sentence about the field.
    for (const bad of ['2026-13-01', '2026-02-30', '2026-00-10', '2026-04-31']) {
      expect(entry(bad).success, bad).toBe(false);
    }
  });

  it('refuses a shape that is not a date at all', () => {
    for (const bad of ['31/12/2026', 'yesterday', '', '2026-1-5', '20260105']) {
      expect(entry(bad).success, bad).toBe(false);
    }
  });

  it('accepts a leap day in a leap year and refuses it otherwise', () => {
    expect(entry('2024-02-29').success).toBe(true);
    expect(entry('2026-02-29').success).toBe(false);
  });
});

describe('one thing wrong per date', () => {
  it('does not also say an impossible date is in the future', () => {
    // "2026-13-01 has not happened yet" is true of a date that does not
    // exist, and reads as nonsense to the person who mistyped a month.
    const r = surveyEntrySchema.safeParse({
      survey_village_id: '11111111-1111-4111-8111-111111111111',
      entry_date: '2026-13-01', teams_deployed: 1, values: {},
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const said = r.error.issues.map(i => i.message);
      expect(said).toContain('That is not a real date');
      expect(said).not.toContain('That date has not happened yet');
    }
  });
});

describe('numbers larger than the column can hold', () => {
  const entry = (v: number) => surveyEntrySchema.safeParse({
    survey_village_id: '11111111-1111-4111-8111-111111111111',
    entry_date: '2026-01-15', teams_deployed: 1,
    values: { GOVT_LAND_EXTENT_AC: v },
  });

  it('refuses one that would overflow numeric(14,4)', () => {
    // .finite() is not a bound. 1e308 is perfectly finite, a hundred times
    // more acres than there are on Earth, and it reached Postgres and came
    // back as a 500 with a stack trace.
    expect(entry(1e308).success).toBe(false);
    expect(entry(1e11).success).toBe(false);
  });

  it('says what to check rather than only refusing', () => {
    const r = entry(1e308);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain('decimal point');
    }
  });

  it('still takes a number any real programme would produce', () => {
    // The largest programme in production is about 405,000 acres.
    expect(entry(405_169.53).success).toBe(true);
    expect(entry(9_999_999_999).success).toBe(true);
  });

  it('bounds the village extent and the target the same way', () => {
    expect(surveyVillageCreateSchema.safeParse({
      village_name: 'Huge', village_code: 'H1',
      mandal_id: '11111111-1111-4111-8111-111111111111', total_extent_ac: 1e308,
    }).success).toBe(false);
  });
});

describe('claiming a batch of villages', () => {
  const base = {
    survey_village_ids: ['11111111-1111-4111-8111-111111111111'],
    milestone: 1,
  };
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  it('takes a submission with nothing but the villages and the milestone', () => {
    // The percentage, the date and the reference all have sensible defaults;
    // demanding them turns a two-click job into a form.
    const r = villageBillingBulkSchema.safeParse({ ...base, action: 'SUBMIT' });
    expect(r.success).toBe(true);
  });

  it('previews by default, so a wrong filter cannot write anything', () => {
    const r = villageBillingBulkSchema.parse({ ...base, action: 'SUBMIT' });
    expect(r.dry_run).toBe(true);
  });

  it('will not record a decision without saying what was decided', () => {
    const r = villageBillingBulkSchema.safeParse({
      ...base, action: 'DECIDE', decided_on: yesterday,
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/what the department decided/i);
  });

  it('will not record a decision without the date it was decided', () => {
    // A decided claim with no date cannot be aged, and ageing them is the
    // reason to track them.
    const r = villageBillingBulkSchema.safeParse({
      ...base, action: 'DECIDE', status: 'APPROVED',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/date the department decided/i);
  });

  it('refuses an empty batch rather than reporting nothing done', () => {
    const r = villageBillingBulkSchema.safeParse({
      ...base, survey_village_ids: [], action: 'SUBMIT',
    });
    expect(r.success).toBe(false);
  });

  it('refuses more villages than one claim could plausibly cover', () => {
    const r = villageBillingBulkSchema.safeParse({
      ...base,
      survey_village_ids: Array.from({ length: 1001 },
        () => '11111111-1111-4111-8111-111111111111'),
      action: 'SUBMIT',
    });
    expect(r.success).toBe(false);
  });

  it('refuses a claim dated in the future', () => {
    const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    const r = villageBillingBulkSchema.safeParse({
      ...base, action: 'SUBMIT', submitted_on: soon,
    });
    expect(r.success).toBe(false);
  });

  it('refuses a field it does not know rather than ignoring it', () => {
    // A typo in a field name that is silently dropped is a batch that did
    // not do what the caller asked and said it did.
    const r = villageBillingBulkSchema.safeParse({
      ...base, action: 'SUBMIT', referance_no: 'RC/2026/1',
    });
    expect(r.success).toBe(false);
  });

  it('names every reason a village can be left out of a batch', () => {
    for (const reason of ['ALREADY_CLAIMED', 'NOTHING_TO_DECIDE', 'ALREADY_IN_THAT_STATE'] as const) {
      expect(BILLING_SKIP_LABELS[reason], reason).toBeTruthy();
    }
  });
});

describe('attendance against allocation', () => {
  const day = (over: Partial<StaffingDay> = {}): StaffingDay => ({
    govtStaffPresent: 2, crewPresent: 4,
    govtStaffAllocated: 2, crewAllocated: 4, ...over,
  });

  it('counts person-days on each side', () => {
    const s = summariseStaffing([day(), day()]);
    expect(s.daysRecorded).toBe(2);
    expect(s.govtStaffDays).toBe(4);
    expect(s.crewDays).toBe(8);
    expect(s.govtStaffPct).toBe(100);
  });

  it('expects the allocation only on days that have a return', () => {
    /*
     * Multiplying the allocation by the calendar would charge the department
     * for Sundays and for days the crew was elsewhere, and the percentage
     * that came out would be an accusation rather than a measurement.
     */
    const s = summariseStaffing([day(), day({ govtStaffPresent: 1 })]);
    expect(s.govtStaffExpected).toBe(4);
    expect(s.govtStaffDays).toBe(3);
    expect(s.govtStaffPct).toBe(75);
  });

  it('leaves out a day nobody was asked about, rather than calling it zero', () => {
    // A return filed before this existed is not an absence, and counting it
    // as one would manufacture absences out of the day the field was added.
    const s = summariseStaffing([
      day(),
      { govtStaffPresent: null, crewPresent: null, govtStaffAllocated: 2, crewAllocated: 4 },
    ]);
    expect(s.daysRecorded).toBe(1);
    expect(s.govtStaffExpected).toBe(2);
  });

  it('counts a day nobody came as a real absence', () => {
    // Zero is the fact worth having, and it is not the same as blank.
    const s = summariseStaffing([day({ govtStaffPresent: 0 })]);
    expect(s.daysRecorded).toBe(1);
    expect(s.daysWithNoGovtStaff).toBe(1);
    expect(s.govtStaffPct).toBe(0);
  });

  it('counts a day short once, however many sides were short', () => {
    const s = summariseStaffing([day({ govtStaffPresent: 1, crewPresent: 2 })]);
    expect(s.daysShort).toBe(1);
  });

  it('does not call a day short when more turned up than agreed', () => {
    const s = summariseStaffing([day({ govtStaffPresent: 5 })]);
    expect(s.daysShort).toBe(0);
    expect(s.govtStaffPct).toBe(250);
  });

  it('has no percentage to report with no allocation recorded', () => {
    const s = summariseStaffing([day({ govtStaffAllocated: null, crewAllocated: null })]);
    expect(s.govtStaffPct).toBeNull();
    expect(s.crewPct).toBeNull();
    expect(s.govtStaffDays).toBe(2);
  });

  it('says nothing was recorded rather than reporting a hollow zero', () => {
    const s = summariseStaffing([]);
    expect(s.daysRecorded).toBe(0);
    expect(staffingNote(s)).toMatch(/nobody has recorded/i);
  });
});

describe('what to say about attendance', () => {
  it('leads with the shortfall the office escalates', () => {
    const s = summariseStaffing([
      { govtStaffPresent: 0, crewPresent: 4, govtStaffAllocated: 2, crewAllocated: 4 },
      { govtStaffPresent: 0, crewPresent: 4, govtStaffAllocated: 2, crewAllocated: 4 },
    ]);
    const note = staffingNote(s);
    expect(note).toMatch(/0%/);
    expect(note).toMatch(/fielded nobody on 2 days/i);
  });

  it('reports a short day without calling it an absence', () => {
    const s = summariseStaffing([
      { govtStaffPresent: 1, crewPresent: 4, govtStaffAllocated: 2, crewAllocated: 4 },
    ]);
    expect(staffingNote(s)).toMatch(/1 day was short/i);
    expect(staffingNote(s)).not.toMatch(/fielded nobody/i);
  });

  it('says so plainly when everybody turned up', () => {
    const s = summariseStaffing([
      { govtStaffPresent: 2, crewPresent: 4, govtStaffAllocated: 2, crewAllocated: 4 },
    ]);
    expect(staffingNote(s)).toMatch(/100%/);
    expect(staffingNote(s)).not.toMatch(/short|nobody/i);
  });
});

describe('which stage asks about attendance', () => {
  it('is ground truthing, and only ground truthing', () => {
    // No other stage is walked with the department, and asking on the rest
    // would collect figures that mean nothing.
    expect(stageTracksStaffing('GROUND_TRUTHING')).toBe(true);
    for (const code of ['GT_QC', 'VECTORIZATION', 'DATA_SUBMISSION', 'FINAL_DELIVERABLES']) {
      expect(stageTracksStaffing(code), code).toBe(false);
    }
    expect(stageTracksStaffing(null)).toBe(false);
  });
});

describe('what a milestone may be claimed on', () => {
  const label = (c: string) => c.replace(/_/g, ' ').toLowerCase();

  it('holds the first claim until ground-truthing QC signs the village off', () => {
    // The contract does not release money for work in progress, and a claim
    // the department returns costs a month.
    expect(milestoneEarned(1, { GROUND_TRUTHING: 'COMPLETED' })).toBe(false);
    expect(milestoneEarned(1, { GT_QC: 'IN_PROGRESS' })).toBe(false);
    expect(milestoneEarned(1, { GT_QC: 'COMPLETED' })).toBe(true);
  });

  it('holds the second until the department approves the data', () => {
    // Renamed by §071, not moved: DATA_SUBMISSION is the checkpoint that was
    // called VECTORIZATION_QC, named for what the department does at it.
    expect(milestoneEarned(2, { GT_QC: 'COMPLETED' })).toBe(false);
    expect(milestoneEarned(2, { VECTORIZATION: 'COMPLETED' })).toBe(false);
    expect(milestoneEarned(2, { DATA_SUBMISSION: 'COMPLETED' })).toBe(true);
  });

  it('holds the third until the deliverables have gone in', () => {
    expect(milestoneEarned(3, { DATA_SUBMISSION: 'COMPLETED' })).toBe(false);
    // Submitted is enough here, unlike the two before it: the contract does
    // not hold the money behind an approval the department may sit on.
    expect(milestoneEarned(3, { FINAL_DELIVERABLES: 'IN_PROGRESS' })).toBe(true);
    expect(milestoneEarned(3, { FINAL_DELIVERABLES: 'COMPLETED' })).toBe(true);
  });

  it('treats a village with no stages at all as having earned nothing', () => {
    for (const m of [1, 2, 3]) {
      expect(milestoneEarned(m, {}), String(m)).toBe(false);
      expect(milestoneEarned(m, null), String(m)).toBe(false);
    }
  });

  it('does not gate a milestone the contract says nothing about', () => {
    // A later contract with a fourth claim is data, not a code change, and
    // refusing what no rule covers would block it outright.
    expect(milestoneEarned(4, {})).toBe(true);
  });

  it('says what is missing and what would earn it', () => {
    const note = milestoneBlockedNote(1, {}, label);
    expect(note).toMatch(/gt qc/i);
    expect(note).toMatch(/has not started/i);
    expect(note).toMatch(/first milestone/i);
  });

  it('distinguishes a stage running from one never begun', () => {
    // "In progress, not finished" and "has not started" send somebody to
    // different places.
    const running = milestoneBlockedNote(2, { DATA_SUBMISSION: 'IN_PROGRESS' }, label);
    expect(running).toMatch(/not finished/i);
    expect(running).not.toMatch(/has not started/i);
  });

  it('has nothing to say about a milestone that has been earned', () => {
    expect(milestoneBlockedNote(1, { GT_QC: 'COMPLETED' }, label)).toBeNull();
  });
});

describe('certifying a finished village', () => {
  it('demands a reason for a figure that differs from the record', () => {
    const r = villageFinalsSchema.safeParse({
      finals: [{ measure_code: 'GOVT_LAND_EXTENT_AC', quantity: 120 }],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a reason that says nothing', () => {
    const r = villageFinalsSchema.safeParse({
      finals: [{ measure_code: 'GOVT_LAND_EXTENT_AC', quantity: 120, reason: '  ' }],
    });
    expect(r.success).toBe(false);
  });

  it('takes a certified figure with its reason', () => {
    const r = villageFinalsSchema.safeParse({
      finals: [{
        measure_code: 'GOVT_LAND_EXTENT_AC', quantity: 118.5,
        reason: 'Recount at handover; two parcels merged',
      }],
    });
    expect(r.success).toBe(true);
  });

  it('refuses an empty certification rather than reporting nothing done', () => {
    expect(villageFinalsSchema.safeParse({ finals: [] }).success).toBe(false);
  });

  it('reports the difference, never hiding it', () => {
    /*
     * A certified figure that silently replaced the daily sum would be the
     * spreadsheet again, just inside the database. The gap between them is
     * the thing a reviewer actually looks at.
     */
    expect(certifiedDifference({
      code: 'X', recorded: 120, certified: 118.5, reason: 'Recount',
    })).toBe(-1.5);
    expect(certifiedDifference({
      code: 'X', recorded: 120, certified: null, reason: null,
    })).toBeNull();
  });
});

describe('coordinates for a ground control point', () => {
  it('takes a point in Andhra Pradesh without complaint', () => {
    expect(checkGcp(17.6868, 83.2185)).toEqual([]);
  });

  it('spots the classic swap', () => {
    /*
     * Latitude and longitude typed into each other's boxes is the mistake
     * people actually make copying a fix off a controller, and in India the
     * two ranges do not overlap — so it is detectable rather than merely
     * suspicious.
     */
    expect(checkGcp(83.2185, 17.6868)).toEqual(['SWAPPED']);
  });

  it('says a point is outside India rather than calling it swapped', () => {
    // Swapping these would not put them in India either, so the honest
    // warning is the plainer one.
    expect(checkGcp(48.8584, 2.2945)).toEqual(['OUTSIDE_INDIA']);
  });

  it('warns when the figures are too coarse to locate anything', () => {
    // A degree is about 110 km. Two round numbers locate a district.
    expect(checkGcp(17, 83)).toContain('LOW_PRECISION');
    expect(checkGcp(17.68, 83.21)).toContain('LOW_PRECISION');
  });

  it('does not call a precise point coarse', () => {
    expect(checkGcp(17.686801, 83.218500)).not.toContain('LOW_PRECISION');
  });

  it('warns rather than refuses, always', () => {
    // Every one of these is also something a legitimate programme could
    // produce, so the answer is to say what looks odd and let a person
    // decide — not to refuse a number somebody is looking straight at.
    for (const w of checkGcp(83.2185, 17.6868)) {
      expect(GCP_WARNING_NOTES[w], w).toBeTruthy();
    }
  });

  it('refuses a latitude that is not a latitude', () => {
    expect(gcpSchema.safeParse({
      point_code: 'GCP-1', latitude: 120, longitude: 83,
    }).success).toBe(false);
  });

  it('refuses a point with no name, because a village may have three', () => {
    expect(gcpSchema.safeParse({
      point_code: '  ', latitude: 17.6, longitude: 83.2,
    }).success).toBe(false);
  });

  it('refuses an elevation below any land on earth', () => {
    expect(gcpSchema.safeParse({
      point_code: 'GCP-1', latitude: 17.6, longitude: 83.2, elevation_m: -9000,
    }).success).toBe(false);
  });

  it('takes a point with nothing but a name and a fix', () => {
    // A horizontal control point is still a control point.
    expect(gcpSchema.safeParse({
      point_code: 'GCP-1', latitude: 17.6868, longitude: 83.2185,
    }).success).toBe(true);
  });

  it('writes a coordinate the way a survey record does', () => {
    expect(formatCoordinate(17.6868, 'lat')).toBe('17.686800° N');
    expect(formatCoordinate(-17.6868, 'lat')).toBe('17.686800° S');
    expect(formatCoordinate(83.2185, 'lng')).toBe('83.218500° E');
  });
});

describe('how far the surveyed extent has drifted from the record', () => {
  it('is signed, because bigger and smaller are different conversations', () => {
    /*
     * A village that came in smaller is usually land assigned elsewhere; one
     * that came in larger is usually an encroachment or a boundary the
     * record never caught up with. Reporting the magnitude alone merges the
     * two.
     */
    expect(extentVariancePct(200, 180)).toBe(-10);
    expect(extentVariancePct(200, 220)).toBe(10);
  });

  it('is nothing when there is nothing to compare against', () => {
    // Calling a village with no recorded extent 100% adrift would put every
    // hole in the master data at the top of the exceptions list.
    expect(extentVariancePct(null, 180)).toBeNull();
    expect(extentVariancePct(0, 180)).toBeNull();
    expect(extentVariancePct(200, null)).toBeNull();
    expect(extentVariancePct(200, 0)).toBeNull();
  });

  it('reports to one decimal, which is finer than any extent is known to', () => {
    expect(extentVariancePct(300, 311)).toBe(3.7);
  });

  it('catches drift in either direction against a threshold', () => {
    expect(extentVaries(200, 180, 10)).toBe(true);
    expect(extentVaries(200, 220, 10)).toBe(true);
    expect(extentVaries(200, 195, 10)).toBe(false);
  });

  it('includes a village sitting exactly on the threshold', () => {
    // "Varies by 10% or more" is what somebody means by "varies by 10%".
    expect(extentVaries(200, 180, 10)).toBe(true);
  });

  it('never flags a village it cannot measure', () => {
    expect(extentVaries(null, 180, 1)).toBe(false);
    expect(extentVaries(200, null, 1)).toBe(false);
  });

  it('treats a negative threshold as the distance it is', () => {
    // A threshold typed with a minus sign means the same thing.
    expect(extentVaries(200, 180, -10)).toBe(true);
  });
});

describe('the village ladder (§071)', () => {
  it('reports the eleven positions the contract names, in the order of the work', () => {
    expect(VILLAGE_LADDER.map(r => r.label)).toEqual([
      'Not started',
      'GT in progress', 'GT completed',
      'GT QC in progress', 'GT QC completed',
      'Vectorization in progress', 'Vectorization completed',
      'Data submitted', 'Data approved',
      'Final deliverables submitted', 'Final deliverables approved',
    ]);
  });

  it('puts a village with nothing recorded at the bottom', () => {
    expect(villagePosition({}).key).toBe('NOT_STARTED');
    expect(villagePosition(undefined).key).toBe('NOT_STARTED');
    expect(villagePosition({ GROUND_TRUTHING: 'NOT_STARTED' }).key).toBe('NOT_STARTED');
  });

  it('walks each rung as the work advances', () => {
    const steps: Array<[Record<string, StageState>, string]> = [
      [{ GROUND_TRUTHING: 'IN_PROGRESS' }, 'GT_IN_PROGRESS'],
      [{ GROUND_TRUTHING: 'COMPLETED' }, 'GT_COMPLETED'],
      [{ GROUND_TRUTHING: 'COMPLETED', GT_QC: 'IN_PROGRESS' }, 'GT_QC_IN_PROGRESS'],
      [{ GROUND_TRUTHING: 'COMPLETED', GT_QC: 'COMPLETED' }, 'GT_QC_COMPLETED'],
      [{ GT_QC: 'COMPLETED', VECTORIZATION: 'IN_PROGRESS' }, 'VECTORIZATION_IN_PROGRESS'],
      [{ GT_QC: 'COMPLETED', VECTORIZATION: 'COMPLETED' }, 'VECTORIZATION_COMPLETED'],
      [{ VECTORIZATION: 'COMPLETED', DATA_SUBMISSION: 'IN_PROGRESS' }, 'DATA_SUBMITTED'],
      [{ VECTORIZATION: 'COMPLETED', DATA_SUBMISSION: 'COMPLETED' }, 'DATA_APPROVED'],
      [{ DATA_SUBMISSION: 'COMPLETED', FINAL_DELIVERABLES: 'IN_PROGRESS' }, 'FINAL_SUBMITTED'],
      [{ DATA_SUBMISSION: 'COMPLETED', FINAL_DELIVERABLES: 'COMPLETED' }, 'FINAL_APPROVED'],
    ];
    for (const [stages, expected] of steps) {
      expect(villagePosition(stages).key, JSON.stringify(stages)).toBe(expected);
    }
  });

  it('reports the furthest stage touched, not the earliest gap', () => {
    // GT reopened after vectorisation began. An official asking where the
    // village is means vectorisation; the reopened GT is a rework flag
    // beside it, not a reason to drag the whole village backwards.
    const p = villagePosition({
      GROUND_TRUTHING: 'IN_PROGRESS', GT_QC: 'COMPLETED', VECTORIZATION: 'IN_PROGRESS',
    });
    expect(p.key).toBe('VECTORIZATION_IN_PROGRESS');
  });

  it('treats on hold as the in-progress rung and flags it separately', () => {
    // Eleven positions is what the contract names. "On hold" is something
    // true about a village at a position, not a twelfth position.
    const p = villagePosition({ GROUND_TRUTHING: 'ON_HOLD' });
    expect(p.key).toBe('GT_IN_PROGRESS');
    expect(p.onHold).toBe(true);
    expect(LADDER_KEYS).toHaveLength(11);
  });

  it('flags rework without moving the village', () => {
    const p = villagePosition({ GT_QC: 'COMPLETED', REWORK: 'IN_PROGRESS' });
    expect(p.key).toBe('GT_QC_COMPLETED');
    expect(p.inRework).toBe(true);
  });

  it('ignores the retired stages entirely', () => {
    // A stale row on a stage that is no longer part of the pipeline must not
    // place a village anywhere. Records preparation is work between data
    // approval and submission, and the ladder has no rung for it.
    const p = villagePosition({
      DATA_SUBMISSION: 'COMPLETED', RECORDS_PREPARATION: 'COMPLETED',
      LPM_GENERATION: 'IN_PROGRESS', VECTORIZATION_QC: 'COMPLETED',
    });
    expect(p.key).toBe('DATA_APPROVED');
  });

  it('counts every village exactly once', () => {
    const villages = [
      { stages: {} },
      { stages: { GROUND_TRUTHING: 'IN_PROGRESS' as StageState } },
      { stages: { GROUND_TRUTHING: 'ON_HOLD' as StageState } },
      { stages: { DATA_SUBMISSION: 'COMPLETED' as StageState } },
      { stages: { FINAL_DELIVERABLES: 'COMPLETED' as StageState } },
    ];
    const tally = tallyByPosition(villages);
    expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBe(villages.length);
    expect(tally.GT_IN_PROGRESS).toBe(2);
    expect(tally.NOT_STARTED).toBe(1);
    expect(tally.FINAL_APPROVED).toBe(1);
  });

  it('orders the rungs so "further along" is a comparison of indexes', () => {
    expect(LADDER_INDEX.NOT_STARTED).toBe(0);
    expect(LADDER_INDEX.FINAL_APPROVED).toBe(10);
    expect(LADDER_INDEX.GT_COMPLETED).toBeLessThan(LADDER_INDEX.DATA_APPROVED);
  });
});

describe('the pipeline after §071', () => {
  it('is the five stages the eleven positions are made of', () => {
    expect(STAGE_PIPELINE.filter(s => !s.offSequence).map(s => s.code)).toEqual([
      'GROUND_TRUTHING', 'GT_QC', 'VECTORIZATION', 'DATA_SUBMISSION', 'FINAL_DELIVERABLES',
    ]);
  });

  it('keeps rework off the sequence', () => {
    expect(STAGE_PIPELINE.find(s => s.code === 'REWORK')?.offSequence).toBe(true);
  });

  it('still refuses a stage whose predecessor is unfinished', () => {
    expect(stageBlockedBy('FINAL_DELIVERABLES', { DATA_SUBMISSION: 'IN_PROGRESS' }))
      .toBe('DATA_SUBMISSION');
    expect(stageBlockedBy('FINAL_DELIVERABLES', { DATA_SUBMISSION: 'COMPLETED' }))
      .toBeNull();
  });
});

describe('billing gates after §071', () => {
  it('holds the first claim at GT QC, where it always was', () => {
    expect(milestoneEarned(1, { GT_QC: 'COMPLETED' })).toBe(true);
    expect(milestoneEarned(1, { GT_QC: 'IN_PROGRESS' })).toBe(false);
  });

  it('holds the second claim until the department approves the data', () => {
    // The same checkpoint the old VECTORIZATION_QC gate named. Submitting is
    // not being paid for: a submission can come back.
    expect(milestoneEarned(2, { DATA_SUBMISSION: 'IN_PROGRESS' })).toBe(false);
    expect(milestoneEarned(2, { DATA_SUBMISSION: 'COMPLETED' })).toBe(true);
  });

  it('releases the third claim when the deliverables go in, not when they come back', () => {
    // The contract does not hold our money behind an approval that may take
    // the department months.
    expect(milestoneEarned(3, { FINAL_DELIVERABLES: 'NOT_STARTED' })).toBe(false);
    expect(milestoneEarned(3, { FINAL_DELIVERABLES: 'IN_PROGRESS' })).toBe(true);
    expect(milestoneEarned(3, { FINAL_DELIVERABLES: 'COMPLETED' })).toBe(true);
  });

  it('says what is in the way in words that name the right event', () => {
    const label = (c: string) => c.replace(/_/g, ' ').toLowerCase();
    expect(milestoneBlockedNote(2, { DATA_SUBMISSION: 'IN_PROGRESS' }, label))
      .toMatch(/signed off/);
    expect(milestoneBlockedNote(3, {}, label)).toMatch(/goes in/);
    expect(milestoneBlockedNote(1, { GT_QC: 'COMPLETED' }, label)).toBeNull();
  });
});

describe('starting ground truthing (§071)', () => {
  const ok = {
    started_on: '2026-01-05', expected_end_on: '2026-02-20',
    employee_ids: ['123e4567-e89b-12d3-a456-426614174000'],
  };

  it('accepts the four things agreed when a village starts', () => {
    const r = gtStartSchema.safeParse({ ...ok, govt_staff_allocated: 2, crew_allocated: 6 });
    expect(r.success, JSON.stringify(r.success ? {} : r.error.issues)).toBe(true);
  });

  it('refuses a village with nobody on it', () => {
    const r = gtStartSchema.safeParse({ ...ok, employee_ids: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/at least one person/);
  });

  it('refuses a finish before the start', () => {
    const r = gtStartSchema.safeParse({ ...ok, expected_end_on: '2026-01-04' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/cannot be before the start/);
  });

  it('lets the expected finish be in the future, unlike every other date here', () => {
    const future = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
    expect(gtStartSchema.safeParse({ ...ok, expected_end_on: future }).success).toBe(true);
  });

  it('will not take a headcount that is not a whole number of people', () => {
    expect(gtStartSchema.safeParse({ ...ok, crew_allocated: 4.5 }).success).toBe(false);
  });
});

describe('plan against actual (§072)', () => {
  const TODAY = '2026-09-20';

  it('says nothing at all when there is no plan', () => {
    // A stage with no expected date is not a stage that finished on time.
    const v = stageVariance({ state: 'COMPLETED', completedOn: '2026-09-01' }, TODAY);
    expect(v.days).toBeNull();
    expect(v.basis).toBe('NO_PLAN');
    expect(varianceNote(v)).toBeNull();
  });

  it('measures a finished stage against the date it was promised', () => {
    const late = stageVariance(
      { state: 'COMPLETED', expectedEndOn: '2026-09-01', completedOn: '2026-09-09' }, TODAY);
    expect(late.days).toBe(8);
    expect(late.late).toBe(true);
    expect(varianceNote(late)).toBe('8 days late');

    const early = stageVariance(
      { state: 'COMPLETED', expectedEndOn: '2026-09-10', completedOn: '2026-09-07' }, TODAY);
    expect(early.days).toBe(-3);
    expect(early.late).toBe(false);
    expect(varianceNote(early)).toBe('3 days early');

    const onTime = stageVariance(
      { state: 'COMPLETED', expectedEndOn: '2026-09-07', completedOn: '2026-09-07' }, TODAY);
    expect(onTime.days).toBe(0);
    expect(varianceNote(onTime)).toBe('on time');
  });

  it('measures work still running against today, so lateness is news', () => {
    // The whole value of the figure: a warning while something can still be
    // done about it, not a finding after the fact.
    const running = stageVariance(
      { state: 'IN_PROGRESS', startedOn: '2026-08-01', expectedEndOn: '2026-09-01' }, TODAY);
    expect(running.basis).toBe('RUNNING');
    expect(running.days).toBe(19);
    expect(running.late).toBe(true);
  });

  it('does not call a stage late before its date has passed', () => {
    const ahead = stageVariance(
      { state: 'IN_PROGRESS', startedOn: '2026-09-01', expectedEndOn: '2026-10-01' }, TODAY);
    expect(ahead.days).toBe(0);
    expect(ahead.late).toBe(false);
    expect(ahead.needsReason).toBe(false);
  });

  it('notices a stage that has not begun and is already overdue', () => {
    const unstarted = stageVariance({ state: 'NOT_STARTED', expectedEndOn: '2026-09-01' }, TODAY);
    expect(unstarted.basis).toBe('NOT_STARTED');
    expect(unstarted.late).toBe(true);
    expect(unstarted.days).toBe(19);
  });

  it('asks for a reason only once the slip is worth explaining', () => {
    // Asking about two days trains people to type "delay" into every box.
    const small = stageVariance(
      { state: 'COMPLETED', expectedEndOn: '2026-09-01', completedOn: '2026-09-04' }, TODAY);
    expect(small.needsReason).toBe(false);

    const big = stageVariance(
      { state: 'COMPLETED', expectedEndOn: '2026-09-01', completedOn: '2026-09-20' }, TODAY);
    expect(big.needsReason).toBe(true);

    const explained = stageVariance({
      state: 'COMPLETED', expectedEndOn: '2026-09-01', completedOn: '2026-09-20',
      varianceReason: 'WEATHER',
    }, TODAY);
    expect(explained.needsReason).toBe(false);
    expect(explained.reason).toBe('WEATHER');
  });

  it('asks about finishing far early too, which is usually a wrong plan', () => {
    const veryEarly = stageVariance(
      { state: 'COMPLETED', expectedEndOn: '2026-09-30', completedOn: '2026-09-01' }, TODAY);
    expect(veryEarly.late).toBe(false);
    expect(veryEarly.needsReason).toBe(true);
  });

  it('puts the worst stage of a village first', () => {
    const ordered = villageVariances([
      { stageCode: 'GT_QC', expectedEndOn: '2026-09-18', completedOn: '2026-09-19' },
      { stageCode: 'GROUND_TRUTHING', expectedEndOn: '2026-08-01', completedOn: '2026-09-01' },
      { stageCode: 'VECTORIZATION', expectedEndOn: '2026-09-25', completedOn: '2026-09-20' },
    ], TODAY);
    expect(ordered.map(o => o.stageCode))
      .toEqual(['GROUND_TRUTHING', 'GT_QC', 'VECTORIZATION']);
    expect(ordered[0].variance.days).toBe(31);
  });
});

describe('the stage schema carries the plan (§072)', () => {
  const base = { stage_code: 'GROUND_TRUTHING', state: 'IN_PROGRESS' as const };

  it('takes both planned dates and a reason', () => {
    const r = stageUpdateSchema.safeParse({
      ...base, started_on: '2026-09-01',
      expected_start_on: '2026-09-01', expected_end_on: '2026-10-01',
      variance_reason: 'WEATHER',
    });
    expect(r.success, JSON.stringify(r.success ? {} : r.error.issues)).toBe(true);
  });

  it('refuses a plan that finishes before it starts', () => {
    const r = stageUpdateSchema.safeParse({
      ...base, expected_start_on: '2026-10-01', expected_end_on: '2026-09-01',
    });
    expect(r.success).toBe(false);
  });

  it('refuses an "other" variance with nothing said', () => {
    const r = stageUpdateSchema.safeParse({ ...base, variance_reason: 'OTHER' });
    expect(r.success).toBe(false);
    const ok = stageUpdateSchema.safeParse({
      ...base, variance_reason: 'OTHER', variance_remarks: 'Panchayat election',
    });
    expect(ok.success).toBe(true);
  });

  it('will not invent a reason outside the delay vocabulary', () => {
    // One list across the module, so late stages and idle rovers count together.
    const r = stageUpdateSchema.safeParse({ ...base, variance_reason: 'SLOW' });
    expect(r.success).toBe(false);
    for (const code of DELAY_REASON_CODES) {
      const each = stageUpdateSchema.safeParse({
        ...base, variance_reason: code, variance_remarks: 'because',
      });
      expect(each.success, code).toBe(true);
    }
  });
});

describe('a rover nobody reported on', () => {
  it('is unaccounted, not idle', () => {
    // Before this, every morning ahead of the day's returns the screen told a
    // project manager his whole fleet was sitting in a store. A false alarm
    // daily is how a number stops being read.
    const r = roverUtilisation({ allocated: 127, used: 0, accountedFor: 0 });
    expect(r.idle).toBe(0);
    expect(r.unaccounted).toBe(127);
    // No denominator anybody measured, so no percentage.
    expect(r.utilisationPct).toBeNull();
  });

  it('counts idle only among the rovers the returns spoke for', () => {
    const r = roverUtilisation({ allocated: 127, used: 90, accountedFor: 100 });
    expect(r.idle).toBe(10);
    expect(r.unaccounted).toBe(27);
    expect(r.utilisationPct).toBe(90);
  });

  it('leaves callers that cannot tell exactly as they were', () => {
    const r = roverUtilisation({ allocated: 30, used: 11 });
    expect(r.idle).toBe(19);
    expect(r.unaccounted).toBe(0);
    expect(r.utilisationPct).toBe(36.67);
  });

  it('still reports equipment run off the books', () => {
    const r = roverUtilisation({ allocated: 10, used: 14, accountedFor: 10 });
    expect(r.overUsed).toBe(true);
    expect(r.idle).toBe(0);
    expect(r.unaccounted).toBe(0);
  });
});

describe('ground truthing past its date (§074)', () => {
  const TODAY = '2026-09-20';

  it('demands nothing while the work is inside its window', () => {
    expect(gtReasonRequired(
      { state: 'IN_PROGRESS', expectedEndOn: '2026-10-15' }, TODAY)).toBe(false);
  });

  it('demands a reason once the date has passed and it is still open', () => {
    expect(gtReasonRequired(
      { state: 'IN_PROGRESS', expectedEndOn: '2026-09-01' }, TODAY)).toBe(true);
  });

  it('demands one from a stage that finished late', () => {
    expect(gtReasonRequired(
      { state: 'COMPLETED', expectedEndOn: '2026-09-01', completedOn: '2026-09-11' },
      TODAY)).toBe(true);
  });

  it('demands nothing of a stage that finished on time or early', () => {
    expect(gtReasonRequired(
      { state: 'COMPLETED', expectedEndOn: '2026-09-11', completedOn: '2026-09-11' },
      TODAY)).toBe(false);
    expect(gtReasonRequired(
      { state: 'COMPLETED', expectedEndOn: '2026-09-11', completedOn: '2026-09-02' },
      TODAY)).toBe(false);
  });

  it('asks once and then stops', () => {
    // The point is to get the explanation on file, not to hold a crew to
    // ransom every evening for an answer they have already given.
    expect(gtReasonRequired({
      state: 'IN_PROGRESS', expectedEndOn: '2026-09-01', varianceReason: 'NO_DEPT_STAFF',
    }, TODAY)).toBe(false);
  });

  it('cannot ask about a village nobody gave a date', () => {
    // No expected date is not a missed date. Demanding an explanation for a
    // deadline nobody set teaches people to type anything.
    expect(gtReasonRequired({ state: 'IN_PROGRESS' }, TODAY)).toBe(false);
    expect(gtReasonRequired(null, TODAY)).toBe(false);
  });
});

describe("the day's return can carry the reason (§074)", () => {
  const base = {
    survey_village_id: '123e4567-e89b-12d3-a456-426614174000',
    entry_date: '2026-09-19',
    values: { GOVT_LAND_EXTENT_AC: 4 },
  };

  it('accepts a reason from whoever is filing the day', () => {
    const r = surveyEntrySchema.safeParse({ ...base, gt_variance_reason: 'NO_DEPT_STAFF' });
    expect(r.success, JSON.stringify(r.success ? {} : r.error.issues)).toBe(true);
  });

  it('refuses "other" with nothing said', () => {
    expect(surveyEntrySchema.safeParse(
      { ...base, gt_variance_reason: 'OTHER' }).success).toBe(false);
    expect(surveyEntrySchema.safeParse({
      ...base, gt_variance_reason: 'OTHER', gt_variance_remarks: 'Panchayat election',
    }).success).toBe(true);
  });

  it('will not take a reason outside the vocabulary', () => {
    expect(surveyEntrySchema.safeParse(
      { ...base, gt_variance_reason: 'SLOW' }).success).toBe(false);
  });

  it('still lets a correction be filed without one', () => {
    // The patch schema is derived from the same object; a superRefine would
    // have made it underivable, which is why the base is kept unrefined.
    expect(surveyEntryPatchSchema.safeParse({ values: { GOVT_LAND_EXTENT_AC: 5 } }).success)
      .toBe(true);
  });
});

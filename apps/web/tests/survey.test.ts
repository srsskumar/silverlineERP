import { describe, expect, it } from 'vitest';
import {
  GRAINS, LEVEL_LABELS, REPORT_LEVELS, STAGE_STATE_LABELS, VILLAGE_STATE_LABELS,
  acres, barWidth, count, financialYearToDate, groupMeasures, hasPct, pct,
  pctTone, progressHeadline, sqKm, stateTone,
  TALLY_ORDER, TALLY_LABELS, tallyTone, stageLabel, roverNote, paceNote,
  surveyedExtent, stageStateOf, TALLY_STATES, stepPeriod,
  matchesBillingFilter, BILLING_FILTERS,
  DELAY_REASON_OPTIONS, reasonLabel, villageStatusTone, BOTTLENECK_LABELS, forecastNote,
  changeHint, periodNote,
} from '../lib/survey';
import { businessToday } from '../lib/finance';
import { NAV_GROUPS } from '../lib/nav';
import { IMPORT_TEMPLATES } from '../lib/import-templates';
import {
  MEASURE_SEEDS, STAGE_STATES, SURVEY_PERMISSIONS, VILLAGE_STATES,
  PERIOD_GRAINS, REPORT_LEVELS as SHARED_LEVELS,
} from '@silverline/shared';

describe('pct', () => {
  it('says there is no target rather than showing a number', () => {
    // 0% and "we never set a target" look identical once a number is
    // formatted, and somebody acts on the difference.
    expect(pct(null)).toBe('No target set');
    expect(pct(undefined)).toBe('No target set');
    expect(hasPct(null)).toBe(false);
  });

  it('shows a decimal only where it carries information', () => {
    expect(pct(4.2)).toBe('4.2%');
    expect(pct(62.4)).toBe('62%');
  });

  it('shows an overshoot rather than capping it', () => {
    expect(pct(140)).toBe('140%');
  });
});

describe('pctTone', () => {
  it('marks an overshoot as worth looking at, not as extra success', () => {
    // Over 100% means the estimate was wrong.
    expect(pctTone(140)).toBe('warning');
    expect(pctTone(100)).toBe('success');
  });

  it('has no tone where there is no percentage', () => {
    expect(pctTone(null)).toBe('default');
  });
});

describe('barWidth', () => {
  it('draws nothing when there is no percentage', () => {
    expect(barWidth(null)).toBe(0);
  });

  it('caps the drawing at full width without changing the figure', () => {
    expect(barWidth(140)).toBe(100);
    expect(barWidth(-5)).toBe(0);
  });
});

describe('units', () => {
  it('shows an em dash rather than zero for a missing extent', () => {
    // A village with no extent recorded and one of zero acres are different.
    expect(acres(null)).toBe('—');
    expect(sqKm(null)).toBe('—');
    expect(count(null)).toBe('—');
    expect(acres(0)).toBe('0 Ac');
  });

  it('groups digits the Indian way', () => {
    expect(count(1234567)).toBe('12,34,567');
  });
});

describe('groupMeasures', () => {
  it('keeps the headings the source sheet uses', () => {
    // Somebody who has filled the workbook in for a year should recognise
    // the form.
    const groups = groupMeasures(MEASURE_SEEDS.map(m => ({
      code: m.code, label: m.label, group_label: m.groupLabel,
    })));
    const names = groups.map(g => g.group);
    expect(names).toContain('Government lands');
    expect(names).toContain('Private lands');
    expect(names).toContain('Village boundary');
  });

  it('keeps every measure exactly once', () => {
    const groups = groupMeasures(MEASURE_SEEDS.map(m => ({
      code: m.code, label: m.label, group_label: m.groupLabel,
    })));
    const flat = groups.flatMap(g => g.items.map(i => i.code));
    expect(flat.sort()).toEqual(MEASURE_SEEDS.map(m => m.code).sort());
  });

  it('preserves the order the measures arrive in', () => {
    const groups = groupMeasures([
      { code: 'A', label: 'a', group_label: 'One' },
      { code: 'B', label: 'b', group_label: 'Two' },
      { code: 'C', label: 'c', group_label: 'One' },
    ]);
    expect(groups.map(g => g.group)).toEqual(['One', 'Two']);
    expect(groups[0].items.map(i => i.code)).toEqual(['A', 'C']);
  });

  it('files a measure with no heading under Other', () => {
    expect(groupMeasures([{ code: 'X', label: 'x' }])[0].group).toBe('Other');
  });
});

describe('progressHeadline', () => {
  const base = {
    villages: 100, notStarted: 0, inProgress: 0, completed: 0,
    overallPct: 60, unweighted: 0,
  };

  it('states villages never visited separately from the percentage', () => {
    // 60% with a third never visited is a different situation from 60% with
    // work under way everywhere.
    const text = progressHeadline({ ...base, notStarted: 33 });
    expect(text).toContain('60%');
    expect(text).toContain('33 not started');
    expect(text).toContain('nobody has visited');
  });

  it('says why there is no percentage when nothing carries an extent', () => {
    const text = progressHeadline({ ...base, overallPct: null });
    expect(text).toContain('No extent is recorded');
    expect(text).not.toContain('0%');
  });

  it('flags villages left out of the percentage', () => {
    const text = progressHeadline({ ...base, unweighted: 4 });
    expect(text).toContain('4 villages have no extent');
    expect(text).toContain('left out of the percentage');
  });

  it('handles an empty programme without claiming progress', () => {
    expect(progressHeadline({ ...base, villages: 0 })).toContain('No villages are listed');
    expect(progressHeadline(undefined)).toContain('No villages are listed');
  });

  it('gets the grammar right for a single village', () => {
    expect(progressHeadline({ ...base, unweighted: 1 })).toContain('1 village has no extent');
  });
});

describe('financialYearToDate', () => {
  it('starts on 1 April', () => {
    expect(financialYearToDate('2026-09-15')).toEqual({ from: '2026-04-01', to: '2026-09-15' });
  });

  it('puts January in the year that began the previous April', () => {
    expect(financialYearToDate('2026-01-15').from).toBe('2025-04-01');
  });

  it('gets both boundary days right', () => {
    expect(financialYearToDate('2026-03-31').from).toBe('2025-04-01');
    expect(financialYearToDate('2026-04-01').from).toBe('2026-04-01');
  });
});

describe('labels', () => {
  it('labels every level the server reports', () => {
    expect([...REPORT_LEVELS].sort()).toEqual([...SHARED_LEVELS].sort());
    for (const l of REPORT_LEVELS) expect(LEVEL_LABELS[l], l).toBeTruthy();
  });

  it('labels every village and stage state the server can return', () => {
    for (const s of VILLAGE_STATES) expect(VILLAGE_STATE_LABELS[s], s).toBeTruthy();
    for (const s of STAGE_STATES) expect(STAGE_STATE_LABELS[s], s).toBeTruthy();
  });

  it('offers every grain the server accepts', () => {
    expect(GRAINS.map(g => g.value).sort()).toEqual([...PERIOD_GRAINS].sort());
  });

  it('tones a finished village green and an untouched one neutral', () => {
    expect(stateTone('COMPLETED')).toBe('success');
    expect(stateTone('NOT_STARTED')).toBe('neutral');
    expect(stateTone('ON_HOLD')).toBe('danger');
  });
});

describe('the village import template', () => {
  const template = IMPORT_TEMPLATES.find(t => t.key === 'survey-villages')!;

  it('carries the columns the revenue department issues', () => {
    // So the list can be pasted in as it arrives.
    for (const header of ['district_code', 'district_name', 'division_code', 'division_name',
      'mandal_code', 'mandal_name', 'village_code', 'village_name', 'vill_code_old']) {
      expect(template.headers, header).toContain(header);
    }
  });

  it('lines the example row up with the headers', () => {
    expect(template.example).toHaveLength(template.headers.length);
  });

  it('uses the worked example from the source document', () => {
    const at = (h: string) => template.example[template.headers.indexOf(h)];
    expect(at('district_name')).toBe('Alluri Sitharama Raju');
    expect(at('village_code')).toBe('1511077');
    expect(at('vill_code_old')).toBe('314077');
  });

  it('does not ask for an extent in square kilometres', () => {
    // It is derived from the acres. Two columns holding one quantity in
    // different units disagree the moment either is edited.
    expect(template.headers.some(h => h.includes('sq_km'))).toBe(false);
  });

  it('does not ask for a cumulative anything', () => {
    expect(template.headers.some(h => h.includes('cumulative'))).toBe(false);
  });

  it('says what a missing extent costs', () => {
    expect(template.notes.join(' ')).toContain('left out of the completion figure');
  });
});

describe('navigation', () => {
  it('reaches the survey behind a permission the server issues', () => {
    const item = NAV_GROUPS.flatMap(g => g.items).find(i => i.href === '/survey');
    expect(item).toBeTruthy();
    expect([...SURVEY_PERMISSIONS]).toContain(item!.permission);
  });
});

describe('stage tallies', () => {
  it('reads left to right as the queue work moves through', () => {
    // Not four unrelated numbers: to start, in progress, on hold, done.
    expect([...TALLY_ORDER]).toEqual(['notStarted', 'inProgress', 'onHold', 'completed']);
    for (const k of TALLY_ORDER) expect(TALLY_LABELS[k], k).toBeTruthy();
  });

  it('colours a held village as a problem and a done one as finished', () => {
    expect(tallyTone('onHold')).toBe('danger');
    expect(tallyTone('completed')).toBe('success');
    expect(tallyTone('notStarted')).toBe('neutral');
  });
});

describe('stageLabel', () => {
  it('prefers the label the server gives', () => {
    expect(stageLabel('GT_QC', [{ code: 'GT_QC', label: 'GT quality check' }]))
      .toBe('GT quality check');
  });

  it('makes a readable label from a code it does not know', () => {
    // Better than printing GROUND_TRUTHING at somebody.
    expect(stageLabel('GROUND_TRUTHING')).toBe('Ground truthing');
  });
});

describe('roverNote', () => {
  it('leads with what is sitting idle', () => {
    // Thirty allocated and eleven used is nineteen in a store, not eleven
    // rovers of progress.
    const note = roverNote({
      allocated: 30, used: 11, idle: 19, utilisationPct: 36.67, overUsed: false,
    });
    expect(note).toContain('19 of 30');
    expect(note).toContain('idle');
  });

  it('says so plainly when everything is out working', () => {
    expect(roverNote({ allocated: 8, used: 8, idle: 0, utilisationPct: 100, overUsed: false }))
      .toContain('All 8');
  });

  it('flags equipment being run off the books', () => {
    const note = roverNote({
      allocated: 5, used: 7, idle: 0, utilisationPct: 140, overUsed: true,
    });
    expect(note).toContain('not on the books');
  });

  it('says there is nothing allocated rather than showing a zero ratio', () => {
    expect(roverNote({ allocated: 0, used: 0, idle: 0, utilisationPct: null, overUsed: false }))
      .toContain('No rovers are allocated');
    expect(roverNote(undefined)).toContain('No rovers are allocated');
  });
});

describe('paceNote', () => {
  it('states both rates so they cannot be confused', () => {
    // A schedule built on how fast a crew works and delivered on how fast the
    // work goes is how a programme slips unnoticed.
    const note = paceNote({
      activeDays: 10, acresPerActiveDay: 30, acresPerCalendarDay: 10,
      projectedFinish: '2026-11-25',
    });
    expect(note).toContain('10 acres a day across the calendar');
    expect(note).toContain('30 on the 10 days');
    expect(note).toContain('2026-11-25');
  });

  it('reads as English when only one day has been worked', () => {
    // A template that writes "on the 1 days work was recorded" is a template
    // nobody proofread against the number being one.
    const note = paceNote({
      activeDays: 1, acresPerActiveDay: 12, acresPerCalendarDay: 4,
      projectedFinish: null,
    });
    expect(note).toContain('on the one day work was actually recorded');
    expect(note).not.toContain('1 days');
  });

  it('says there is not enough to measure rather than showing zero', () => {
    expect(paceNote({
      activeDays: 0, acresPerActiveDay: null, acresPerCalendarDay: null, projectedFinish: null,
    })).toContain('Not enough recorded progress');
    expect(paceNote(undefined)).toContain('Not enough recorded progress');
  });

  it('omits the projection when there is nothing to project', () => {
    const note = paceNote({
      activeDays: 3, acresPerActiveDay: 5, acresPerCalendarDay: 2, projectedFinish: null,
    });
    expect(note).not.toContain('runs out');
  });
});

describe('businessToday', () => {
  it('is the Indian calendar day, not the browser\'s and not UTC', () => {
    // A crew opening the form at nine in the morning would otherwise find it
    // defaulted to yesterday, and most would simply file it.
    expect(businessToday(new Date('2026-09-16T20:00:00Z'))).toBe('2026-09-17');
    expect(businessToday(new Date('2026-09-16T18:29:00Z'))).toBe('2026-09-16');
  });

  it('gives every reader the same day, wherever they are', () => {
    // The figures are the organisation's, not the reader's. A manager
    // travelling must not see different dates from the crew.
    const at = new Date('2026-09-16T20:00:00Z');
    expect(businessToday(at)).toBe('2026-09-17');
  });
});

describe('reasons and statuses on screen', () => {
  it('offers every reason the specification lists', () => {
    expect(DELAY_REASON_OPTIONS).toHaveLength(10);
    expect(DELAY_REASON_OPTIONS.map(o => o.code)).toContain('OTHER');
    expect(DELAY_REASON_OPTIONS[DELAY_REASON_OPTIONS.length - 1].code).toBe('OTHER');
  });

  it('labels a reason, and shows the code rather than nothing for an unknown one', () => {
    expect(reasonLabel('ROVER')).toBe('Rover issue');
    expect(reasonLabel('MYSTERY')).toBe('MYSTERY');
  });

  it('colours a village on hold or in rework as a problem', () => {
    // Both mean the work has stopped, whatever the stages say.
    expect(villageStatusTone('ON_HOLD')).toBe('danger');
    expect(villageStatusTone('REWORK')).toBe('danger');
    expect(villageStatusTone('COMPLETED')).toBe('success');
    expect(villageStatusTone('TO_DO')).toBe('neutral');
  });

  it('labels every bottleneck kind', () => {
    for (const k of ['NOT_STARTED_BY_PLAN', 'STAGE_OVERDUE', 'PAST_EXPECTED_COMPLETION',
      'ROVERS_IDLE', 'NO_PROGRESS_RECORDED', 'IN_REWORK']) {
      expect(BOTTLENECK_LABELS[k], k).toBeTruthy();
    }
  });
});

describe('forecastNote', () => {
  it('leads with the required pace, which is the half worth arguing with', () => {
    const note = forecastNote({
      state: 'BEHIND', targetDate: '2026-09-30', forecastDate: '2026-10-04',
      currentPaceAcPerDay: 82, requiredPaceAcPerDay: 105, slipDays: 4,
    });
    expect(note).toContain('4 days later than');
    expect(note).toContain('82 acres a day');
    expect(note).toContain('105 a day would hit the target');
  });

  it('says being ahead is being ahead', () => {
    expect(forecastNote({
      state: 'AHEAD', targetDate: '2026-09-30', forecastDate: '2026-09-20',
      currentPaceAcPerDay: 200, requiredPaceAcPerDay: 50, slipDays: -10,
    })).toContain('ahead of');
  });

  it('says there is not enough progress rather than showing a date', () => {
    expect(forecastNote({
      state: 'NO_PACE', targetDate: '2026-09-30', forecastDate: null,
      currentPaceAcPerDay: null, requiredPaceAcPerDay: null, slipDays: null,
    })).toContain('Not enough recorded progress');
  });

  it('offers the projection even with no target to compare it against', () => {
    const note = forecastNote({
      state: 'NO_TARGET', targetDate: null, forecastDate: '2026-10-04',
      currentPaceAcPerDay: 82, requiredPaceAcPerDay: null, slipDays: null,
    });
    expect(note).toContain('2026-10-04');
    expect(note).toContain('No target date has been set');
  });
});

describe('naming a reason on the chase list', () => {
  it('reads out a reason somebody picked', () => {
    expect(reasonLabel('DATA_TECHNICAL')).toBe('Data or technical issue');
  });

  it('explains a reason the server stamped itself', () => {
    // A punch replayed from the offline queue with nothing filed. It appears
    // on the chase list rather than vanishing, so it needs words a supervisor
    // can read — not a code they have to look up.
    expect(reasonLabel('UNFILED_OFFLINE')).toContain('without signal');
  });

  it('shows a dash where no reason was given at all', () => {
    // The case worth chasing first, and the one a stray "Other" would hide.
    expect(reasonLabel(null)).toBe('—');
  });
});

describe('saying what a period did', () => {
  const up = {
    current: 400, previous: 320, change: 80, changePct: 25, direction: 'UP' as const,
  };

  it('puts the size and the direction next to the figure', () => {
    expect(changeHint(up)).toContain('up');
    expect(changeHint(up)).toContain('25%');
  });

  it('offers no percentage when there was nothing to compare against', () => {
    // "+100%" against a start from nothing is a number that means nothing.
    const first = { ...up, previous: 0, change: 400, changePct: null };
    expect(changeHint(first)).toContain('nothing recorded');
    expect(changeHint(first)).not.toContain('%');
  });

  it('calls no change unchanged rather than up nothing', () => {
    expect(changeHint({ ...up, previous: 400, change: 0, changePct: 0, direction: 'FLAT' }))
      .toContain('Unchanged');
  });

  it('opens the report with what happened, then the comparison', () => {
    const note = periodNote({
      period: { label: 'Week of 2026-09-14' }, area: up,
      effort: { active_days: 4, calendar_days: 7, villages_worked: 3 },
    });
    expect(note).toContain('4 working days');
    expect(note).toContain('3 villages');
    expect(note).toContain('25% more');
  });

  it('distinguishes a period nobody worked from one that recorded no extent', () => {
    // A crew that filed returns with nothing against them is a different
    // problem from a crew that filed nothing, and the two want different
    // conversations.
    const noReturns = periodNote({
      area: { current: 0, previous: 0, change: 0, changePct: null, direction: 'FLAT' },
      effort: { active_days: 0, calendar_days: 7, villages_worked: 0 },
    });
    expect(noReturns).toContain('No day’s return');

    const noExtent = periodNote({
      area: { current: 0, previous: 0, change: 0, changePct: null, direction: 'FLAT' },
      effort: { active_days: 3, calendar_days: 7, villages_worked: 2 },
    });
    expect(noExtent).toContain('no extent was recorded');
  });

  it('says days and villages in the singular when there is one', () => {
    const note = periodNote({
      area: { ...up, changePct: null, previous: 0 },
      effort: { active_days: 1, calendar_days: 1, villages_worked: 1 },
    });
    expect(note).toContain('1 working day across 1 village.');
    expect(note).not.toContain('working days');
    expect(note).not.toContain('1 villages');
  });
});

describe('pace before anybody has worked', () => {
  it('says there is nothing to measure rather than describing zero days', () => {
    // A programme with no returns comes back with a rate of zero rather than
    // null, and the old guard only caught null — so an untouched programme
    // described a measurement nobody had taken.
    const note = paceNote({
      activeDays: 0, acresPerActiveDay: null, acresPerCalendarDay: 0, projectedFinish: null,
    });
    expect(note).toBe('Not enough recorded progress yet to measure a pace.');
    expect(note).not.toContain('0 days');
  });
});

describe('surveyed extent against planned extent', () => {
  const measures = [
    { code: 'GOVT_LAND_EXTENT_AC', basis: 'EXTENT' },
    { code: 'PRIVATE_LAND_EXTENT_AC', basis: 'EXTENT' },
    { code: 'VILLAGE_BOUNDARY_POINTS', basis: 'COUNT' },
  ];

  it('adds the acres actually walked, across every extent measure', () => {
    // The extent is what the revenue record says the village is; this is what
    // the crews have measured. The difference is the work remaining.
    expect(surveyedExtent(
      { done: { GOVT_LAND_EXTENT_AC: 120.5, PRIVATE_LAND_EXTENT_AC: 30 } },
      measures,
    )).toBe(150.5);
  });

  it('ignores anything counted rather than measured in acres', () => {
    expect(surveyedExtent(
      { done: { GOVT_LAND_EXTENT_AC: 10, VILLAGE_BOUNDARY_POINTS: 4000 } },
      measures,
    )).toBe(10);
  });

  it('is nothing for a village nobody has been to', () => {
    expect(surveyedExtent({ done: {} }, measures)).toBe(0);
    expect(surveyedExtent({ done: null }, measures)).toBe(0);
  });
});

describe('the state a stage is in', () => {
  it('reads a stage nobody has touched as not started', () => {
    // An absence is a state here: the list filters on it and the roll-up
    // counts it.
    expect(stageStateOf({ stages: {} }, 'VECTORIZATION')).toBe('NOT_STARTED');
    expect(stageStateOf({ stages: null }, 'VECTORIZATION')).toBe('NOT_STARTED');
  });

  it('reads what was recorded', () => {
    expect(stageStateOf({ stages: { VECTORIZATION: 'ON_HOLD' } }, 'VECTORIZATION'))
      .toBe('ON_HOLD');
  });
});

describe('the tally columns and the states they count', () => {
  it('maps every column a reader sees to a state a record holds', () => {
    /*
     * The roll-up names them for a reader — "To start", "Done" — and the
     * village list filters on the states the records hold. One map, so a
     * count and the list it opens can never disagree about what was counted.
     */
    for (const key of TALLY_ORDER) {
      expect(TALLY_STATES[key], key).toBeTruthy();
      expect(STAGE_STATE_LABELS[TALLY_STATES[key]], key).toBeTruthy();
    }
  });

  it('counts "to start" as the state an untouched stage reports', () => {
    expect(TALLY_STATES.notStarted).toBe(stageStateOf({ stages: {} }, 'ANY'));
  });
});

describe('stepping from one report period to the next', () => {
  it('moves a week at a time', () => {
    expect(stepPeriod('2026-09-18', 'WEEK', -1)).toBe('2026-09-11');
    expect(stepPeriod('2026-09-18', 'WEEK', 1)).toBe('2026-09-25');
  });

  it('moves a calendar month, not thirty days', () => {
    // 31 days back from 31 March is 28 February; 30 days back is 1 March,
    // which is the same month and leaves the button doing nothing.
    expect(stepPeriod('2026-03-31', 'MONTH', -1)).toBe('2026-02-28');
    expect(stepPeriod('2026-01-31', 'MONTH', 1)).toBe('2026-02-28');
  });

  it('crosses a year boundary', () => {
    expect(stepPeriod('2026-01-05', 'MONTH', -1)).toBe('2025-12-05');
    expect(stepPeriod('2026-12-31', 'DAY', 1)).toBe('2027-01-01');
  });

  it('leaves a value it cannot read alone rather than guessing', () => {
    expect(stepPeriod('not-a-date', 'WEEK', -1)).toBe('not-a-date');
  });
});

describe('pulling villages by what has been claimed', () => {
  it('finds villages nothing has been claimed on', () => {
    expect(matchesBillingFilter([], 'NONE')).toBe(true);
    expect(matchesBillingFilter([1], 'NONE')).toBe(false);
  });

  it('finds villages owed their first claim', () => {
    expect(matchesBillingFilter([], 'DUE_1')).toBe(true);
    expect(matchesBillingFilter([1], 'DUE_1')).toBe(false);
  });

  it('does not call a second claim due before the first has gone in', () => {
    // Claiming out of order is returned by the department, so a list that
    // said this village was owed a second claim would create the rework.
    expect(matchesBillingFilter([], 'DUE_2')).toBe(false);
    expect(matchesBillingFilter([1], 'DUE_2')).toBe(true);
    expect(matchesBillingFilter([1, 2], 'DUE_2')).toBe(false);
  });

  it('calls the third due only once the first two are in', () => {
    expect(matchesBillingFilter([1], 'DUE_3')).toBe(false);
    expect(matchesBillingFilter([1, 2], 'DUE_3')).toBe(true);
    expect(matchesBillingFilter([1, 2, 3], 'DUE_3')).toBe(false);
  });

  it('finds a village by a claim it has made, whatever else it has', () => {
    expect(matchesBillingFilter([1, 3], 'HAS_3')).toBe(true);
    expect(matchesBillingFilter([1, 2], 'HAS_3')).toBe(false);
  });

  it('calls a village fully claimed only with all three standing', () => {
    expect(matchesBillingFilter([1, 2, 3], 'ALL')).toBe(true);
    // Three claims where one was returned is not three standing.
    expect(matchesBillingFilter([1, 2], 'ALL')).toBe(false);
  });

  it('lets everything through when nothing is asked', () => {
    expect(matchesBillingFilter([], '')).toBe(true);
    expect(matchesBillingFilter([2], '')).toBe(true);
  });

  it('offers a label for every answer it can be given', () => {
    for (const b of BILLING_FILTERS) {
      expect(b.label, b.value).toBeTruthy();
      // Every option has to be one the filter understands, or the picker
      // silently shows the unfiltered list.
      expect(() => matchesBillingFilter([1], b.value)).not.toThrow();
    }
  });
});

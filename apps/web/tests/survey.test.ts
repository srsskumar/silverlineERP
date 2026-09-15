import { describe, expect, it } from 'vitest';
import {
  GRAINS, LEVEL_LABELS, REPORT_LEVELS, STAGE_STATE_LABELS, VILLAGE_STATE_LABELS,
  acres, barWidth, count, financialYearToDate, groupMeasures, hasPct, pct,
  pctTone, progressHeadline, sqKm, stateTone,
} from '../lib/survey';
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

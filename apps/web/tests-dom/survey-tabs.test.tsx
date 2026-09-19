/**
 * Every survey tab, mounted for real, through loading and loaded.
 *
 * The Villages tab shipped to production showing an error boundary instead of
 * a village list. It threw "rendered more hooks than during the previous
 * render" — a `useMemo` that had ended up below an early return, so the first
 * render ran one hook fewer than the second.
 *
 * A green typecheck, a green build and seventeen hundred passing tests all
 * missed it, because not one of them rendered a component. These do.
 *
 * Deliberately shallow on assertions and broad on coverage: what matters is
 * that each screen survives the transition from loading to loaded, which is
 * the moment a misplaced hook blows up. What the screen then says is the job
 * of the logic suite next door.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------ the fixtures */

const VILLAGE = {
  id: 'v1', village_id: 'ou1', village_name: 'Adakula', village_code: '1501041',
  district_name: 'Alluri Sitharama Raju', mandal_name: 'Koyyuru',
  total_extent_ac: 200, total_extent_sq_km: 0.81,
  stages: { GROUND_TRUTHING: 'IN_PROGRESS' }, stage_dates: {},
  done: { GOVT_LAND_EXTENT_AC: 120 },
  claimed_milestones: [], claimed_percent: 0,
  assignee_name: 'Ravi Kumar', version: 1,
};

const PROGRESS = {
  level: 'mandal', as_of: '2026-09-19', from: null,
  staffing: { daysRecorded: 2, govtStaffDays: 3, crewDays: 8, govtStaffExpected: 4,
    crewExpected: 8, govtStaffPct: 75, crewPct: 100, daysWithNoGovtStaff: 1, daysShort: 1 },
  filter: { district: null, mandal: null, village_id: null, stage: null,
    stage_state: null, villages: 1, of_villages: 1 },
  options: { districts: ['Alluri Sitharama Raju'], mandals: ['Koyyuru'],
    villages: [{ id: 'v1', name: 'Adakula' }] },
  rows: [{ id: 'm1', name: 'Koyyuru', villages: 1, completed: 0, notStarted: 0,
    extentAc: 200, surveyedAc: 120, overallPct: 60, measures: {}, period_done: null,
    by_stage: {}, out_of_sequence: 0 }],
  total: { villages: 1, completed: 0, notStarted: 0, inProgress: 1, extentAc: 200,
    extentSqKm: 0.81, surveyedAc: 120, overallPct: 60, unweighted: 0, measures: {} },
  by_stage: { GROUND_TRUTHING: { notStarted: 0, inProgress: 1, onHold: 0, completed: 0 } },
  rovers: { as_of: '2026-09-19', allocated: 2, used: 1, idle: 1, utilisationPct: 50, overUsed: false },
  pace: { activeDays: 2, projectedFinish: '2026-12-01', daysToFinish: 70, areaPerActiveDay: 60 },
  pipeline: [
    { code: 'GROUND_TRUTHING', label: 'Ground truthing', requires: null, tracks_daily_progress: true },
    { code: 'GT_QC', label: 'GT quality check', requires: 'GROUND_TRUTHING', tracks_daily_progress: false },
  ],
  measures: [
    { code: 'GOVT_LAND_EXTENT_AC', label: 'Government land', group_label: null, unit: 'Ac', basis: 'EXTENT' },
    { code: 'GOVT_LAND_POINTS', label: 'Government points', group_label: null, unit: 'no', basis: 'COUNT' },
  ],
};

const REPORT = {
  grain: 'WEEK', level: 'mandal', as_of: '2026-09-19',
  period: { from: '2026-09-14', to: '2026-09-20', label: 'Week of 2026-09-14' },
  previous_period: { from: '2026-09-07', to: '2026-09-13', label: 'Week of 2026-09-07' },
  programme: { id: 'p1', name: 'Krishna', code: 'KR1' },
  area: { current: 120, previous: 90, direction: 'UP', changePct: 33, unit: 'Ac' },
  measures: { GOVT_LAND_EXTENT_AC: { current: 120, previous: 90, direction: 'UP', changePct: 33 } },
  measure_list: PROGRESS.measures,
  effort: { active_days: 4, calendar_days: 7, villages_worked: 1, team_days: 8, area_per_active_day: 30 },
  rovers: { utilised: 3, idle: 1, idle_reasons: ['ROVER'] },
  staffing: PROGRESS.staffing, previous_staffing: PROGRESS.staffing,
  stage_movements: [], units: [{ id: 'm1', name: 'Koyyuru', villages: 1,
    period: { GOVT_LAND_EXTENT_AC: 120 }, previous: { GOVT_LAND_EXTENT_AC: 90 },
    cumulative: { doneAc: 120, pct: 60, measures: {} } }],
  overall: { measures: {} },
};

const LADDER = [
  { key: 'NOT_STARTED', label: 'Not started' },
  { key: 'GT_IN_PROGRESS', label: 'GT in progress' },
  { key: 'GT_COMPLETED', label: 'GT completed' },
  { key: 'GT_QC_IN_PROGRESS', label: 'GT QC in progress' },
  { key: 'GT_QC_COMPLETED', label: 'GT QC completed' },
  { key: 'VECTORIZATION_IN_PROGRESS', label: 'Vectorization in progress' },
  { key: 'VECTORIZATION_COMPLETED', label: 'Vectorization completed' },
  { key: 'DATA_SUBMITTED', label: 'Data submitted' },
  { key: 'DATA_APPROVED', label: 'Data approved' },
  { key: 'FINAL_SUBMITTED', label: 'Final deliverables submitted' },
  { key: 'FINAL_APPROVED', label: 'Final deliverables approved' },
];

/** The delay vocabulary, in the order the API returns it. */
const REASONS = [
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
];

const DASHBOARD = {
  project: { id: 'p1', name: 'Krishna', code: 'KR1' },
  period: { from: null, to: '2026-09-19' },
  level: 'district',
  filter: { district: null, mandal: null, position: null, reason: null,
    reason_source: null, villages: 1, of_villages: 1 },
  options: { districts: [{ id: 'd1', name: 'Krishna' }], mandals: [{ id: 'm1', name: 'Koyyuru' }] },
  ladder: LADDER,
  totals: {
    villages: 1, extent_ac: 200, extent_sqkm: 0.81, surveyed_ac: 120, surveyed_sqkm: 0.49,
    by_position: Object.fromEntries(LADDER.map(r => [r.key, r.key === 'GT_COMPLETED' ? 1 : 0])),
    on_hold: 0, in_rework: 0, gcp_missing: 0,
    late: 1, late_unexplained: 1, unplanned: 0,
  },
  reasons: {
    stage_variance: { unit: 'stages', note: '', total: 3,
      by_reason: REASONS.map((r, i) => ({ ...r, count: i === 0 ? 3 : 0, villages: i === 0 ? 1 : 0 })) },
    instrument_idle: { unit: 'instrument-days', note: '', total: 2,
      by_reason: REASONS.map((r, i) => ({ ...r, count: i === 3 ? 2 : 0, villages: i === 3 ? 1 : 0 })) },
    low_progress: { unit: 'days', note: '', total: 1,
      by_reason: REASONS.map((r, i) => ({ ...r, count: i === 8 ? 1 : 0, villages: i === 8 ? 1 : 0 })) },
  },
  rows: [{ id: 'd1', name: 'Krishna', villages: 1, extent_ac: 200, extent_sqkm: 0.81,
    surveyed_ac: 120,
    by_position: Object.fromEntries(LADDER.map(r => [r.key, r.key === 'GT_COMPLETED' ? 1 : 0])),
    completed: 0, not_started: 0, late: 1 }],
  villages: [{ id: 'v1', name: 'Adakula', code: '1501041', district: 'Krishna',
    mandal: 'Koyyuru', extent_ac: 200, extent_sqkm: 0.81, surveyed_ac: 120,
    position: 'GT_COMPLETED', position_label: 'GT completed', on_hold: false,
    in_rework: false, gt_started_on: '2026-09-01', gt_expected_end_on: '2026-10-01',
    gcp_count: 1, slip_days: 8, slip_stage: 'GROUND_TRUTHING', slip_note: '8 days late',
    slip_reason: null, slip_needs_reason: true }],
};

/** Every endpoint these screens reach for, keyed by a fragment of the path. */
const ROUTES: Array<[string, unknown]> = [
  // Before /progress: both match a path containing "/progress"? No — but the
  // dashboard path must be matched ahead of the generic /villages fragment.
  ['/dashboard', DASHBOARD],
  ['/progress', PROGRESS],
  ['/report', REPORT],
  ['/villages', [VILLAGE]],
  ['/summary', [{ mandal: 'Koyyuru', village: 'Adakula', extent_ac: 200, extent_sq_km: 0.81,
    gt_status: 'COMPLETED', vectorization_status: 'NOT_STARTED', points: 400, lpms: 0,
    actual_extent_ac: 190, actual_extent_sq_km: 0.77, gt_started_on: '2026-09-01',
    gt_completed_on: '2026-09-10', assignee_name: 'Ravi Kumar',
    gt_govt_staff_allocated: 2, gt_crew_allocated: 4, attendance_days: 2,
    govt_staff_days: 3, crew_days: 8, days_no_govt_staff: 1, govt_staff_pct: 75,
    crew_pct: 100, rovers_allocated: 2, rover_days_used: 3, rover_days_idle: 1,
    rover_utilisation_pct: 75, crew_assigned: 4, return_days: 2, team_days: 8,
    stages: {}, out_of_sequence: [], stage_remarks: {} }]],
  ['/gcps', [{ id: 'g1', survey_village_id: 'v1', village_name: 'Adakula',
    mandal_name: 'Koyyuru', village_code: '1501041', point_code: 'GCP-1',
    latitude: 17.6868231, longitude: 83.2184815, elevation_m: 45.2,
    easting_m: 736412.318, northing_m: 1956043.772, grid_zone: '44N',
    remarks: 'Tied to BM 42', established_on: '2026-09-01', warnings: [], version: 1 }]],
  ['/deployment', { level: 'mandal', units: [{ id: 'm1', name: 'Koyyuru', villages: 1,
    crew: 4, rovers_out: 2, villages_uncrewed: 0, villages_unequipped: 0,
    people: [{ employee_id: 'e1', name: 'Ravi Kumar', emp_no: 'E1' }],
    assets: [{ asset_id: 'a1', asset_code: 'RVR-1', name: 'DGPS 1' }] }],
    programme_staff: [], totals: { villages: 1, crew: 4, assets: 2, programme_staff: 0,
      villages_uncrewed: 0, villages_unequipped: 0 } }],
  ['/timeline', { grain: 'MONTH', from: '2026-04-01', to: '2026-09-19',
    financial_year: { label: '2026-27' },
    periods: [{ from: '2026-09-01', to: '2026-09-30', label: 'Sep 2026', villages: 1,
      measures: { GOVT_LAND_EXTENT_AC: 120 },
      staffing: PROGRESS.staffing }] }],
  ['/employee-productivity', { employees: [] }],
  ['/rover-productivity', { rovers: [] }],
  ['/bottlenecks', { bottlenecks: [], forecast: null }],
  ['/forecast', { projectedFinish: null }],
  ['/projects', [{ id: 'p1', name: 'Krishna', code: 'KR1', village_count: 1 }]],
];

beforeEach(() => {
  vi.resetModules();
  vi.doMock('@/lib/apiClient', () => ({
    apiRequest: vi.fn(async () => ({ data: {} })),
    apiRequestRaw: vi.fn(async (path: string) => {
      for (const [fragment, body] of ROUTES) {
        if (path.includes(fragment)) return { body: { data: body }, requestId: 't' };
      }
      return { body: { data: [] }, requestId: 't' };
    }),
  }));
  vi.doMock('@/components/AuthProvider', () => ({
    useAuth: () => ({
      session: {
        permissions: ['survey.read', 'survey.enter', 'survey.manage',
          'survey.certify', 'survey.forecast', 'survey.assign'],
        roles: ['ADMIN'], user: { id: 'u1', username: 'qa' },
      },
      status: 'authenticated', logout: vi.fn(), login: vi.fn(),
    }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
  vi.doMock('@/components/AppShell', () => ({
    AppShell: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
  }));
});

function wrap(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    React.createElement(QueryClientProvider, { client }, node),
  );
}

/*
 * The four anybody sees, and the six behind "More" (§071).
 *
 * Split the way the screen splits them, so the test has to click "More" to
 * reach the deep ones — which is also the only way it would notice if that
 * button ever stopped revealing them.
 */
const PRIMARY = ['Dashboard', 'Progress', 'Villages', 'Report'] as const;
const BEHIND_MORE = ['Crew & rovers', 'Deployment', 'Bottlenecks', 'Trend',
  'Summary', 'Control points'] as const;
const TABS = [...PRIMARY, ...BEHIND_MORE] as const;

/** Reveal a tab, opening "More" first when it lives there. */
async function reveal(tab: string): Promise<HTMLElement> {
  // Only open "More" when the tab is not already showing — it is a toggle, and
  // clicking it for the second deep tab would close it again.
  if ((BEHIND_MORE as readonly string[]).includes(tab)
      && !screen.queryByRole('button', { name: tab })) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument());
    screen.getByRole('button', { name: 'More' }).click();
  }
  await waitFor(() => expect(screen.getByRole('button', { name: tab })).toBeInTheDocument());
  return screen.getByRole('button', { name: tab });
}

describe('the land survey screen', () => {
  it('mounts without throwing', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() => expect(screen.getByText('Land survey')).toBeInTheDocument());
  });

  it('offers every tab', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    for (const tab of PRIMARY) {
      await waitFor(() => expect(screen.getByRole('button', { name: tab })).toBeInTheDocument());
    }
    // The six deep ones are one click away, not gone.
    for (const tab of BEHIND_MORE) {
      expect(screen.queryByRole('button', { name: tab })).toBeNull();
    }
    for (const tab of BEHIND_MORE) await reveal(tab);
  });

  it('writes the village count on every bar', async () => {
    // The ask was plain: show the numbers of villages at each stage. Reading
    // a bar and tracking across to a column of figures is two movements for
    // one fact, and on eleven rows people lose their line.
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    // Read inside the row rather than off its concatenated text: "1" and
    // "100%" run together in textContent and a loose regex would pass on the
    // percentage alone.
    for (const rung of LADDER) {
      const row = screen.getByRole('button', { name: new RegExp(rung.label) });
      const expected = rung.key === 'GT_COMPLETED' ? '1' : '0';
      expect(within(row).getByText(expected), rung.key).toBeInTheDocument();
    }
  });

  it('reports what is behind plan, and what has no plan at all', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('1 behind plan')).toBeInTheDocument());
    expect(screen.getByText('1 slipping with no reason recorded')).toBeInTheDocument();
    expect(screen.getByText('8 days late')).toBeInTheDocument();
    expect(screen.getByText('reason not given')).toBeInTheDocument();
  });

  it('shows why the work is held up, in all three places a reason is recorded', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Why the work is held up')).toBeInTheDocument());
    expect(screen.getByText('Stages that missed their date')).toBeInTheDocument();
    expect(screen.getByText('Instruments standing idle')).toBeInTheDocument();
    expect(screen.getByText('Days that fell short')).toBeInTheDocument();
    // Every reason listed in every group, including the ones at zero: a
    // reason being absent is a finding, but only if it was visibly looked for.
    for (const r of REASONS) {
      expect(screen.getAllByText(r.label).length, r.code).toBe(3);
    }
    // The three units are named and never summed.
    expect(screen.getByText('3 stages')).toBeInTheDocument();
    expect(screen.getByText('2 instrument-days')).toBeInTheDocument();
    expect(screen.getByText('1 days')).toBeInTheDocument();
  });

  it('lets a reason be clicked, and leaves the ones that never happened alone', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Why the work is held up')).toBeInTheDocument());
    const weather = screen.getAllByText('Weather').map(
      (el) => el.closest('button')!).filter(Boolean);
    // Recorded against a stage, so that one is live; the other two are not.
    expect(weather.filter((b) => !b.hasAttribute('disabled'))).toHaveLength(1);
  });

  it('opens on the dashboard', async () => {
    // The question almost everybody arrives with, so it is the first thing
    // they see rather than the fifth tab along.
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    for (const rung of LADDER) {
      // getAllBy: a rung name is both a bar on the chart and, for some, a
      // value in the village table below it.
      expect(screen.getAllByText(rung.label).length, rung.key).toBeGreaterThan(0);
    }
  });

  /*
   * The regression this whole suite exists for.
   *
   * Each tab goes from a loading render to a loaded one, which is the moment
   * a hook below an early return changes the hook count and React throws.
   * Rendering the tab once would not catch it; the transition is the test.
   */
  for (const tab of TABS) {
    it(`survives loading and then showing ${tab}`, async () => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
        errors.push(args[0]);
      });
      try {
        const { default: SurveyPage } = await import('@/app/survey/page');
        wrap(React.createElement(SurveyPage));
        (await reveal(tab)).click();
        // Long enough for the tab's own queries to resolve and re-render.
        await waitFor(() => expect(
          screen.getByRole('button', { name: tab })).toBeInTheDocument());
        await new Promise((r) => setTimeout(r, 60));

        const hookErrors = errors
          .map(String)
          .filter((e) => /hook|Rendered more|Rendered fewer|Minified React error/i.test(e));
        expect(hookErrors, `${tab}: ${hookErrors.join(' | ')}`).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  }
});

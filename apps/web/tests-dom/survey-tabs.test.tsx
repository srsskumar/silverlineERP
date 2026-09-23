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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  { key: 'NOT_STARTED', label: 'Not started', note: 'Nothing has been recorded yet.' },
  { key: 'GT_IN_PROGRESS', label: 'GT in progress' },
  { key: 'GT_COMPLETED', label: 'GT completed',
    note: 'The walking is finished. Nobody has checked it yet, so none of it can be billed.' },
  { key: 'GT_QC_IN_PROGRESS', label: 'GT QC in progress' },
  { key: 'GT_QC_COMPLETED', label: 'GT QC completed' },
  { key: 'VECTORIZATION_IN_PROGRESS', label: 'Vectorization in progress' },
  { key: 'VECTORIZATION_COMPLETED', label: 'Vectorization completed' },
  { key: 'DATA_SUBMITTED', label: 'Data submitted' },
  { key: 'DATA_APPROVED', label: 'Data approved' },
  { key: 'FINAL_SUBMITTED', label: 'Final deliverables submitted' },
  { key: 'FINAL_APPROVED', label: 'Final deliverables approved',
    note: 'The department signed the deliverables off. The village is not yet '
      + 'finished: the last 20% now waits on the department issuing notification (§086).' },
  { key: 'NOTIFICATION_IN_PROGRESS', label: '13 Notification pending' },
  { key: 'NOTIFICATION_ISSUED', label: '13 Notification issued' },
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
  refreshed: {
    generated_at: '2026-09-21T09:15:00.000Z',
    last_return: '2026-09-19',
    last_stage_change: '2026-09-20T06:00:00.000Z',
  },
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
    earned: { 1: 1, 2: 0, 3: 0 },
    claimed_unearned: { 1: 0, 2: 0, 3: 2 },
    awaiting_sign_off: [
      { code: 'GROUND_TRUTHING', label: 'Ground truthing', villages: 2,
        signed_off_by: 'GT_QC' },
      { code: 'VECTORIZATION', label: 'Vectorization', villages: 0,
        signed_off_by: 'DATA_SUBMISSION' },
    ],
    positions: LADDER.map(r => r.key === 'GT_COMPLETED'
      ? { ...r, villages: 1, extent_ac: 200, extent_sqkm: 0.81,
          surveyed_ac: 120, surveyed_sqkm: 0.49, share_pct: 100 }
      : { ...r, villages: 0, extent_ac: 0, extent_sqkm: 0,
          surveyed_ac: 0, surveyed_sqkm: 0, share_pct: 0 }),
  },
  reasons: {
    stage_variance: { unit: 'stages', note: '', total: 3,
      by_reason: REASONS.map((r, i) => ({ ...r, count: i === 0 ? 3 : 0, villages: i === 0 ? 1 : 0 })) },
    instrument_idle: { unit: 'instrument-days', note: '', total: 2,
      by_reason: REASONS.map((r, i) => ({ ...r, count: i === 3 ? 2 : 0, villages: i === 3 ? 1 : 0 })) },
    low_progress: { unit: 'days', note: '', total: 1,
      by_reason: REASONS.map((r, i) => ({ ...r, count: i === 8 ? 1 : 0, villages: i === 8 ? 1 : 0 })) },
  },
  stage_days: [
    { code: 'GROUND_TRUTHING', label: 'Ground truthing', villages_measured: 1,
      villages_here: 3, avg_days: 21.5, median_days: 20, max_days: 44,
      holders: [{ name: 'Ravi Kumar', villages: 2 }], unassigned: 1 },
    { code: 'GT_QC', label: 'GT quality check', villages_measured: 0, villages_here: 1,
      avg_days: null, median_days: null, max_days: null, holders: [], unassigned: 1 },
    { code: 'VECTORIZATION', label: 'Vectorization', villages_measured: 0, villages_here: 0,
      avg_days: null, median_days: null, max_days: null, holders: [], unassigned: 0 },
    { code: 'DATA_SUBMISSION', label: 'Data submission', villages_measured: 0,
      villages_here: 0, avg_days: null, median_days: null, max_days: null,
      holders: [], unassigned: 0 },
    { code: 'FINAL_DELIVERABLES', label: 'Final deliverables', villages_measured: 0,
      villages_here: 0, avg_days: null, median_days: null, max_days: null,
      holders: [], unassigned: 0 },
    { code: 'NOTIFICATION', label: '13 Notification', villages_measured: 0,
      villages_here: 0, avg_days: null, median_days: null, max_days: null,
      holders: [], unassigned: 0 },
  ],
  rows: [{ id: 'd1', name: 'Krishna', villages: 1, extent_ac: 200, extent_sqkm: 0.81,
    surveyed_ac: 120, surveyed_sqkm: 0.49,
    by_position: Object.fromEntries(LADDER.map(r => [r.key, r.key === 'GT_COMPLETED' ? 1 : 0])),
    completed: 0, not_started: 0, late: 1 }],
  by_mandal: [{ id: 'm1', name: 'Koyyuru', district: 'Krishna', villages: 1,
    extent_ac: 200, extent_sqkm: 0.81, surveyed_ac: 120, surveyed_sqkm: 0.49,
    by_position: Object.fromEntries(LADDER.map(r => [r.key, r.key === 'GT_COMPLETED' ? 1 : 0])),
    completed: 0, not_started: 0, late: 1 }],
  villages: [{ id: 'v1', name: 'Adakula', code: '1501041', district: 'Krishna',
    mandal: 'Koyyuru', extent_ac: 200, extent_sqkm: 0.81, surveyed_ac: 120,
    position: 'GT_COMPLETED', position_label: 'GT completed', on_hold: false,
    in_rework: false, gt_started_on: '2026-09-01', gt_expected_end_on: '2026-10-01',
    gcp_count: 1, earned_milestones: [], slip_days: 8, slip_stage: 'GROUND_TRUTHING', slip_note: '8 days late',
    slip_reason: null, slip_needs_reason: true,
    gt_completed_on: '2026-10-09', surveyed_sqkm: 0.49,
    stage_days: { GROUND_TRUTHING: 38 }, days_in_stage: 38,
    holders: ['Ravi Kumar', 'Sita Devi'], holder_count: 2 }],
};

/** Every endpoint these screens reach for, keyed by a fragment of the path. */
const ROUTES: Array<[string, unknown]> = [
  // Before /progress: both match a path containing "/progress"? No — but the
  // dashboard path must be matched ahead of the generic /villages fragment.
  ['/dashboard', DASHBOARD],
  ['/contacts', [
    { id: 'c1', side: 'GOVT', name: 'K. Srinivas', designation: 'Tahsildar',
      phone: '+91 98480 11111', email: null, covers_name: 'Koyyuru', active: true },
    { id: 'c2', side: 'SILVERLINE', name: 'Ravi Kumar', designation: 'Project Manager',
      phone: '+91 98480 22222', email: 'ravi@silverline.example', covers_name: null,
      active: true },
  ]],
  ['/queries', [
    { id: 'q1', kind: 'CONCERN', subject: 'Why is Adakula still at GT QC?',
      body: 'It has been four months.', status: 'OPEN', village_name: 'Adakula',
      position_label: 'GT QC completed', raised_by_name: 'District Collector',
      raised_at: '2026-09-18T10:00:00Z', answer: null, answered_by_name: null,
      version: 1 },
  ]],
  ['/alert-subscriptions', []],  // meta is added by the mock below
  ['/progress', PROGRESS],
  ['/report', REPORT],
  ['/villages', [VILLAGE, {
    ...VILLAGE, id: 'v2', village_name: 'Butchampeta', village_code: '1501042',
    // Past GT QC, so it has earned the first claim where Adakula has not.
    stages: { GROUND_TRUTHING: 'COMPLETED', GT_QC: 'COMPLETED' },
  }]],
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
        if (path.includes(fragment)) {
          return {
            body: {
              data: body,
              // The alert screen reads whether anything can actually send.
              ...(fragment === '/alert-subscriptions'
                ? { meta: { mail_configured: false, queued: 7 } } : {}),
            },
            requestId: 't',
          };
        }
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
    // Scoped to the bars: the table of the same eleven rungs below them has
    // a button per row too.
    const bars = screen.getByRole('list', { name: /as bars/ });
    for (const rung of LADDER) {
      const row = within(bars).getByRole('button', { name: new RegExp(rung.label) });
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

  it('reports how long each stage takes and who it is sitting with', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('How long each stage takes')).toBeInTheDocument());
    // Median beside the mean: a few villages stuck for months drag an average
    // somewhere no village actually is.
    expect(screen.getByText('Median days')).toBeInTheDocument();
    expect(screen.getByText('Average days')).toBeInTheDocument();
    expect(screen.getByText('Ravi Kumar · 2')).toBeInTheDocument();
    // A stage with villages on it and nobody holding them is worth its own badge.
    expect(screen.getByText('1 with nobody')).toBeInTheDocument();
    // And a stage whose villages have nobody at all says so in words.
    expect(screen.getByText('nobody assigned')).toBeInTheDocument();
  });

  it('shows the actual GT completion beside the promised one, and km² beside acres', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('GT actual end')).toBeInTheDocument());
    // Appears in the village row and again in the export preview, so count
    // rather than insist on one.
    // DD-MMM-YYYY everywhere now, not the raw ISO the API sends.
    expect(screen.getAllByText('09-Oct-2026').length).toBeGreaterThan(0);
    expect(screen.getByText('GT expected end')).toBeInTheDocument();
    // Surveyed extent carries km² as well as acres.
    expect(screen.getAllByText(/0\.49/).length).toBeGreaterThan(0);
    // Two roll-ups, the stage table and the village list all carry it.
    expect(screen.getAllByText('Surveyed (km²)').length).toBe(4);
  });

  it('rolls up by mandal as well as by district', async () => {
    /*
     * A district says the programme is behind; the mandal says which
     * tahsildar to ring. It is the level the work is organised at, so it is
     * always shown rather than only when somebody changes the grouping.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() => expect(screen.getByText('By district')).toBeInTheDocument());
    expect(screen.getByText('By mandal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Koyyuru' })).toBeInTheDocument();
    // Mandal names repeat across districts, so the parent is named beside
    // them. Scoped to the mandal card: "District" is also a filter label, a
    // grouping option and a column on two other tables.
    const card = screen.getByText('By mandal').closest('div')!.parentElement!;
    expect(within(card).getByText('District')).toBeInTheDocument();
    expect(within(card).getByText('Krishna')).toBeInTheDocument();
  });

  it('shows the eleven rungs as figures as well as a chart', async () => {
    /*
     * The chart answers "where is the weight" and is useless for reading a
     * number off; the table answers "how many, and how much extent". A reader
     * putting a figure in a note should not have to count pixels.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    const card = screen.getByText('Where every village has got to')
      .closest('div')!.parentElement!;
    expect(within(card).getByText('Stage')).toBeInTheDocument();
    expect(within(card).getByText('Share')).toBeInTheDocument();
    // Every rung has a row, whether or not anything is at it.
    for (const rung of LADDER) {
      expect(within(card).getAllByText(rung.label).length, rung.key)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it('ends the table with a total summed from the rows above it', async () => {
    // A total fetched separately is a total that can disagree with what is on
    // the screen, and nothing tells the reader which of the two to believe.
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    const row = screen.getByText('Total').closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
    // One village, 100% of what is shown, 200 acres, 120 surveyed.
    expect(cells[1]).toBe('1');
    expect(cells[2]).toBe('100%');
    expect(cells[3]).toBe('200');
    expect(cells[5]).toBe('120');
  });

  it('filters the villages by stage status, the way the dashboard counts them', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    (await reveal('Villages')).click();
    await waitFor(() => expect(screen.getByText('Adakula')).toBeInTheDocument());

    const picker = screen.getByTitle(/Where the village has got to/);
    // Every rung the dashboard reports is offered here too.
    for (const rung of LADDER) {
      expect(within(picker).getByText(rung.label), rung.key).toBeInTheDocument();
    }

    // Adakula's ground truthing is in progress; Butchampeta is past QC.
    fireEvent.change(picker, { target: { value: 'GT_QC_COMPLETED' } });
    await waitFor(() => expect(screen.queryByText('Adakula')).toBeNull());
    expect(screen.getByText('Butchampeta')).toBeInTheDocument();
  });

  it('says which selected villages have not earned the milestone, before sending', async () => {
    /*
     * The server has always refused an unearned claim, but only after a dry
     * run and after somebody had swept a thousand villages into a selection.
     * The contract does not release money for work in progress, and a claim
     * the department returns costs a month.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    (await reveal('Villages')).click();
    await waitFor(() => expect(screen.getByText('Adakula')).toBeInTheDocument());

    const selectAll = screen.getByLabelText(/Select every village shown/);
    fireEvent.click(selectAll);

    // Adakula is still in ground truthing; Butchampeta has passed QC.
    await waitFor(() =>
      expect(screen.getByText(/1 of 2 selected cannot be claimed/)).toBeInTheDocument());
    // Scoped to the notice: "GT quality check" is also a stage in the filter
    // above it and a column in the table below.
    const notice = screen.getByText(/1 of 2 selected cannot be claimed/)
      .closest('div')!.parentElement!;
    expect(within(notice).getByText(/GT quality check/)).toBeInTheDocument();
    // And the way out is one press, not a re-tick of the whole list.
    expect(screen.getByRole('button', { name: 'Keep the 1 that is eligible' }))
      .toBeInTheDocument();
  });

  it('separates work that is finished from work that has been accepted', async () => {
    /*
     * The contract pays on the signature, not the completion. A dashboard
     * that only showed completions would report a programme as billable
     * months before any of it is.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Waiting to be signed off')).toBeInTheDocument());
    expect(screen.getByText('2 ground truthing awaiting gt qc')).toBeInTheDocument();
    expect(screen.getByText('1 eligible for milestone 1')).toBeInTheDocument();
    expect(screen.getByText('0 eligible for milestone 3')).toBeInTheDocument();
    // Claims raised before the rule tightened are named, not erased.
    expect(screen.getByText('2 claimed at milestone 3 without a sign-off'))
      .toBeInTheDocument();
  });

  it('explains what each position means rather than assuming the jargon', async () => {
    /*
     * "Data submitted" and "data approved" are days apart in the work and
     * months apart in the money. A reader who does not know that reads the
     * dashboard as though they were the same thing.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    const bars = screen.getByRole('list', { name: /as bars/ });
    const gt = within(bars).getByRole('button', { name: /GT completed/ });
    expect(gt.getAttribute('title')).toMatch(/none of it can be billed/);
  });

  it('spells the position out in full once the screen is narrowed to it', async () => {
    // A hover is no use to somebody who has already filtered to one rung.
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    const bars = screen.getByRole('list', { name: /as bars/ });
    within(bars).getByRole('button', { name: /GT completed/ }).click();
    await waitFor(() =>
      expect(screen.getByText(/none of it can be billed/)).toBeInTheDocument());
  });

  it('offers a way to ask, and never a way to edit', async () => {
    /*
     * The dashboard is what somebody outside this company is shown. A screen
     * that reports and edits in the same breath is one where a filter and a
     * change look alike — so the only thing it lets anybody do is respond.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Questions and concerns')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Raise a question' })).toBeInTheDocument();
    // What has been asked already, with the status it was asked against.
    // Waited for, not asserted straight away: the list is its own request and
    // the card's heading renders before it lands.
    await waitFor(() =>
      expect(screen.getByText('Why is Adakula still at GT QC?')).toBeInTheDocument());
    expect(screen.getByText('Waiting for an answer')).toBeInTheDocument();
  });

  it('shows who to ring on both sides, with a dialable number', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() => expect(screen.getByText('Revenue department')).toBeInTheDocument());
    expect(screen.getByText('Silverline')).toBeInTheDocument();
    expect(screen.getByText('K. Srinivas')).toBeInTheDocument();
    expect(screen.getByText('Tahsildar')).toBeInTheDocument();
    // A number on a screen somebody reads on a phone should dial.
    const tel = screen.getByText('+91 98480 11111');
    expect(tel.getAttribute('href')).toBe('tel:+919848011111');
  });

  it('lets whoever runs the programme say where alerts go, and until when', async () => {
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() => expect(screen.getByText('Alerts by email')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/every alert goes/)).toBeInTheDocument());
    // Nothing ticked is every alert, said out loud — an empty list otherwise
    // reads as "none" and somebody signs up for silence.
    expect(screen.getByText(/every alert goes/)).toBeInTheDocument();
    // The form must say that nothing can send yet — a form that takes an
    // address and stays quiet about it lies by omission.
    await waitFor(() => expect(
      screen.getByText(/Nothing is configured to send these yet/)).toBeInTheDocument());
    expect(screen.getByText(/7 are waiting now/)).toBeInTheDocument();
  });

  it('keeps Setup and the day\'s return off the dashboard, and nowhere else', async () => {
    /*
     * The dashboard is a reading screen and is what people outside this
     * company are shown. Setup loads the village master; "record today's
     * progress" writes a return. Neither belongs beside a figure somebody is
     * reading — but both belong on the tabs where that work is done.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Record today/ })).toBeNull();

    // Still there the moment somebody leaves the dashboard.
    (await reveal('Villages')).click();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Setup' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Record today/ })).toBeInTheDocument();
  });

  it('says when it was drawn and how current the figures are', async () => {
    /*
     * A dashboard left open on a wall looks identical at nine in the morning
     * and at six in the evening; one drawn at six from returns that stop on
     * Tuesday is not current either. Both facts, because either alone
     * misleads.
     */
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() => expect(screen.getByText(/^Refreshed/)).toBeInTheDocument());
    expect(screen.getByText('Latest return 19-Sep-2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('lets a question be raised from a district, a mandal or a village', async () => {
    // "Why is Bapatla behind" is not a question about any one of its four
    // hundred villages, and describing the district in a free-text box is how
    // it reaches the wrong person.
    const { default: SurveyPage } = await import('@/app/survey/page');
    wrap(React.createElement(SurveyPage));
    await waitFor(() => expect(screen.getByText('By district')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Ask about Krishna' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask about Koyyuru' })).toBeInTheDocument();
    // getAllBy: the export menu renders a print copy of the same table into
    // a portal, so every row's controls appear twice in the document.
    expect(screen.getAllByRole('button', { name: 'Ask about Adakula' }).length)
      .toBeGreaterThan(0);

    /*
     * Pressing one opens the form already scoped to it -- and brings it into
     * view. The card sits below the roll-ups and the alerts, often a full
     * screen down; opening it there with nothing else visibly changing is
     * indistinguishable from the button having done nothing at all.
     */
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    screen.getByRole('button', { name: 'Ask about Koyyuru' }).click();
    await waitFor(() =>
      expect(screen.getByText(/About Koyyuru mandal/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Ask about the programme instead/ }))
      .toBeInTheDocument();
    expect(scrolled).toHaveBeenCalled();
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

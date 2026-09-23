/**
 * Every column has a heading, and every heading has a column.
 *
 * The dashboard's village table shipped with twenty cells under fifteen
 * headings: a patch applied twice put the cells in twice and the headings in
 * once, so the extra columns appeared on the right with nothing above them.
 * Nothing failed — a table with ragged rows renders perfectly happily — and
 * it reached somebody reading the screen.
 *
 * Counting the source cannot see it, because the row is built from
 * conditionals. This mounts the thing and counts what the browser drew.
 *
 * The fixtures are a copy of the tab suite's. Sharing them was tried and
 * abandoned: they sit above a vi.mock factory, which is hoisted above every
 * import in the file, and pulling them into a module took the suite's own
 * setup with them. A copied fixture is a smaller problem than a test file
 * whose mocks do not resolve.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
  { key: 'FINAL_APPROVED', label: 'Final deliverables approved' },
  { key: 'NOTIFICATION_IN_PROGRESS', label: 'Notification pending' },
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
    { code: 'NOTIFICATION', label: 'Notification', villages_measured: 0,
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

async function mountDashboard() {
  const { SurveyDashboard } = await import('@/components/survey/Dashboard');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(SurveyDashboard, {
        projectId: 'p1', canDrill: true, canAnswer: true, canManage: true,
      })),
  );
}

describe('tables draw as many cells as they have headings', () => {
  it('leaves no column without a heading anywhere on the dashboard', async () => {
    await mountDashboard();
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole('table').length).toBeGreaterThan(2));

    const ragged: string[] = [];
    for (const table of screen.getAllByRole('table')) {
      const headRow = table.querySelector('thead tr');
      if (!headRow) continue;
      const headings = headRow.querySelectorAll('th').length;
      for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
        const cells = Array.from(row.querySelectorAll('td'));
        // The empty-state row is one cell spanning the lot, by design.
        if (cells.length === 1 && cells[0].hasAttribute('colspan')) continue;
        if (cells.length !== headings) {
          ragged.push(`${headRow.textContent?.slice(0, 60)}… — `
            + `${headings} headings, ${cells.length} cells`);
        }
      }
    }
    expect(ragged, `columns with no heading above them:\n${ragged.join('\n')}`)
      .toEqual([]);
  });

  it('spans the whole table when it has nothing to show', async () => {
    // A colspan that does not match the headings leaves a stray empty cell
    // beside the "nothing here" message.
    await mountDashboard();
    await waitFor(() =>
      expect(screen.getByText('Where every village has got to')).toBeInTheDocument());
    for (const table of screen.getAllByRole('table')) {
      const headings = table.querySelectorAll('thead th').length;
      for (const td of Array.from(table.querySelectorAll('tbody td[colspan]'))) {
        expect(Number(td.getAttribute('colspan')), td.textContent?.slice(0, 40))
          .toBe(headings);
      }
    }
  });
});

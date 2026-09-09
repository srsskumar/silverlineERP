import { describe, expect, it } from 'vitest';
import {
  ROLE_PRIORITY,
  TEMPLATE_LABELS,
  formatGeneratedAt,
  formatStat,
  getMyWork,
  listWidgets,
  normalizeMyWork,
  normalizeRole,
  normalizeRoleDashboard,
  selectDefaultTemplate,
  sessionRolesToTemplates,
  widgetTone,
} from '../lib/dashboards';
import {
  REPORT_FORMAT,
  REPORT_ROW_LIMIT,
  REPORT_TYPE_META,
  REPORT_TYPE_PERMISSION,
  canGenerateReportType,
  downloadReportUrl,
  generateReport,
  normalizeReportJob,
  reportTypePermission,
  reportTypesForPermissions,
} from '../lib/reports';
import { queryKeys } from '../lib/query-keys';
import { PERMISSIONS } from '../lib/permissions';
import { reportSchema } from '../lib/validation';

describe('template priority selector', () => {
  it('picks the first held role in ROLE_PRIORITY order', () => {
    expect(selectDefaultTemplate(['EMPLOYEE', 'ADMIN'])).toBe('admin');
    expect(selectDefaultTemplate(['employee', 'team_lead'])).toBe('team_lead');
    expect(selectDefaultTemplate(['CLIENT_VIEWER', 'AUDITOR'])).toBe('auditor');
  });

  it('maps UPPER_SNAKE session roles to lowercase templates', () => {
    expect(sessionRolesToTemplates(['HR_MANAGER', 'ADMIN'])).toEqual(['admin', 'hr_manager']);
    expect(normalizeRole('PROJECT_MANAGER')).toBe('project_manager');
    expect(normalizeRole('super_admin')).toBe('super_admin');
  });

  it('returns null when no known role is held', () => {
    expect(selectDefaultTemplate([])).toBeNull();
    expect(selectDefaultTemplate(['SOMETHING_ELSE', 42, null])).toBeNull();
    expect(sessionRolesToTemplates([])).toEqual([]);
  });

  it('de-duplicates and sorts client_viewer last', () => {
    expect(sessionRolesToTemplates(['CLIENT_VIEWER', 'client_viewer', 'EMPLOYEE'])).toEqual([
      'employee',
      'client_viewer',
    ]);
    expect(ROLE_PRIORITY[ROLE_PRIORITY.length - 1]).toBe('client_viewer');
    expect(TEMPLATE_LABELS.hr_manager).toBe('HR Manager');
  });
});

describe('widgetTone mapping', () => {
  it('maps overdue→danger and pct-family→info', () => {
    expect(widgetTone('tasks_overdue')).toBe('danger');
    expect(widgetTone('OVERDUE_COUNT')).toBe('danger');
    expect(widgetTone('attendance_pct')).toBe('info');
    expect(widgetTone('utilization_rate')).toBe('info');
    expect(widgetTone('completion_percent')).toBe('info');
  });

  it('maps open/pending→warning, done-family→success, unknown→neutral', () => {
    expect(widgetTone('assigned_open')).toBe('warning');
    expect(widgetTone('pending_approvals')).toBe('warning');
    expect(widgetTone('tasks_done')).toBe('success');
    expect(widgetTone('leave_approved')).toBe('success');
    expect(widgetTone('headcount_total')).toBe('neutral');
    expect(widgetTone(null)).toBe('neutral');
    expect(widgetTone(undefined)).toBe('neutral');
  });
});

describe('generated_at relative formatter', () => {
  const NOW = Date.parse('2026-09-07T12:00:00.000Z');

  it('renders seconds/minutes/hours/days ago', () => {
    expect(formatGeneratedAt('2026-09-07T11:59:30.000Z', NOW)).toBe('updated 30s ago');
    expect(formatGeneratedAt('2026-09-07T11:57:00.000Z', NOW)).toBe('updated 3m ago');
    expect(formatGeneratedAt('2026-09-07T10:00:00.000Z', NOW)).toBe('updated 2h ago');
    expect(formatGeneratedAt('2026-09-03T12:00:00.000Z', NOW)).toBe('updated 4d ago');
  });

  it('handles just-now, future skew and unknown input', () => {
    expect(formatGeneratedAt('2026-09-07T11:59:58.000Z', NOW)).toBe('updated just now');
    expect(formatGeneratedAt('2026-09-07T12:05:00.000Z', NOW)).toBe('updated just now');
    expect(formatGeneratedAt(null, NOW)).toBe('updated time unknown');
    expect(formatGeneratedAt(undefined, NOW)).toBe('updated time unknown');
    expect(formatGeneratedAt('not-a-date', NOW)).toBe('updated time unknown');
  });

  it('formats workforce stats compactly', () => {
    expect(formatStat(59)).toBe('59');
    expect(formatStat(1250)).toBe('1,250');
    expect(formatStat(87.5)).toBe('87.50');
    expect(formatStat(null)).toBe('—');
    expect(formatStat(undefined)).toBe('—');
    expect(formatStat('active')).toBe('active');
    expect(formatStat('  ')).toBe('—');
  });
});

describe('report type→perm mapping', () => {
  it('maps each frozen type to its read permission', () => {
    expect(reportTypePermission('employees')).toBe('employee.read');
    expect(reportTypePermission('attendance')).toBe('attendance.read');
    expect(reportTypePermission('tasks')).toBe('task.read');
    expect(reportTypePermission('leave')).toBe('leave.read');
    expect(reportTypePermission('payroll')).toBe('payroll.read');
  });

  it('gates generation per-type and lists allowed types', () => {
    expect(canGenerateReportType(['task.read'], 'tasks')).toBe(true);
    expect(canGenerateReportType(['task.read'], 'leave')).toBe(false);
    expect(canGenerateReportType(null, 'tasks')).toBe(false);
    expect(reportTypesForPermissions(['employee.read', 'leave.read']).map((m) => m.type)).toEqual([
      'employees',
      'leave',
    ]);
    expect(reportTypesForPermissions([])).toEqual([]);
    expect(REPORT_TYPE_META).toHaveLength(8);
    expect(REPORT_TYPE_PERMISSION.tasks).toBe('task.read');
  });
});

describe('my-work normalizers (envelope/bare)', () => {
  const LEAVE = { id: 'lr_1', employee_id: 'e_1', from_date: '2026-09-01', to_date: '2026-09-02' };
  const OVERDUE = { id: 't_1', title: 'fix pump', project_id: 'pr_1', planned_end_date: '2026-08-01' };

  it('normalizes the bare payload', () => {
    const out = normalizeMyWork({
      assigned_open: 3,
      assigned_overdue: [OVERDUE],
      pending_approvals: { leave: [LEAVE], exceptions_count: 2 },
      unread_count: 5,
    });
    expect(out.assigned_open).toBe(3);
    expect(out.assigned_overdue).toHaveLength(1);
    expect(out.pending_approvals.leave).toHaveLength(1);
    expect(out.pending_approvals.exceptions_count).toBe(2);
    expect(out.unread_count).toBe(5);
  });

  it('tolerates {data:...} envelopes and defaults missing keys', () => {
    const out = normalizeMyWork({
      data: {
        assigned_open: 1,
        assigned_overdue: [OVERDUE],
        pending_approvals: { leave: [LEAVE], exceptions_count: 0 },
        unread_count: 0,
      },
    });
    expect(out.assigned_open).toBe(1);
    expect(out.assigned_overdue).toHaveLength(1);
    const empty = normalizeMyWork({});
    expect(empty).toMatchObject({
      assigned_open: 0,
      assigned_overdue: [],
      unread_count: 0,
    });
    expect(empty.pending_approvals).toMatchObject({ leave: [], exceptions_count: 0 });
    expect(normalizeMyWork(null)).toMatchObject({ assigned_open: 0, unread_count: 0 });
  });
});

describe('S6 gating codes exact values', () => {
  it('exposes dashboard.read and report.generate verbatim', () => {
    expect(PERMISSIONS.DASHBOARD_READ).toBe('dashboard.read');
    expect(PERMISSIONS.REPORT_GENERATE).toBe('report.generate');
  });
});

describe('role dashboard normalizer + query keys', () => {
  it('normalizes envelope/bare payloads with scope_note', () => {
    const widgets = [{ key: 'assigned_open', title: 'Open', value: 4, link: '/my-work' }];
    const bare = normalizeRoleDashboard({
      template: 'employee',
      generated_at: '2026-09-07T12:00:00.000Z',
      widgets,
      scope_note: 'scoped to your teams',
    });
    expect(bare.template).toBe('employee');
    expect(bare.widgets).toHaveLength(1);
    expect(bare.scope_note).toBe('scoped to your teams');
    const enveloped = normalizeRoleDashboard({
      data: { template: 'admin', generated_at: null, widgets },
    });
    expect(enveloped.template).toBe('admin');
    expect(enveloped.scope_note).toBeNull();
    expect(() => normalizeRoleDashboard({ nope: true })).toThrow();
  });

  it('exposes dashboardRole + myWork keys and report format/limits', () => {
    expect(queryKeys.dashboard.dashboardRole('admin')).toEqual(['dashboard', 'role', 'admin']);
    expect(queryKeys.dashboard.role('admin')).toEqual(queryKeys.dashboard.dashboardRole('admin'));
    expect(queryKeys.dashboard.myWork()).toEqual(['dashboard', 'my-work']);
    expect(queryKeys.reports.job('r_1')).toContain('r_1');
    expect(REPORT_FORMAT).toBe('csv');
    expect(REPORT_ROW_LIMIT).toBe(5000);
  });

  it('validates the report form schema (type-only)', () => {
    expect(reportSchema.safeParse({ type: 'tasks' }).success).toBe(true);
    expect(reportSchema.safeParse({ type: 'payroll' }).success).toBe(true);
    expect(reportSchema.safeParse({}).success).toBe(false);
  });

  it('normalizes report jobs and builds absolute download hrefs', () => {
    const job = normalizeReportJob({ id: 'r_1', status: 'ready', rows: 12, download_url: '/api/v1/reports/r_1/download' });
    expect(job.rows).toBe(12);
    expect(normalizeReportJob({ data: job }).id).toBe('r_1');
    expect(() => normalizeReportJob({ id: 'x' })).toThrow();
    expect(downloadReportUrl('/api/v1/reports/r_1/download')).toContain('/api/v1/reports/r_1/download');
    expect(downloadReportUrl('https://cdn.example/r.csv')).toBe('https://cdn.example/r.csv');
    expect(typeof generateReport).toBe('function');
    expect(typeof listWidgets).toBe('function');
    expect(typeof getMyWork).toBe('function');
  });
});

import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../lib/apiClient';
import {
  buildMyPayslipQuery,
  buildRunsQuery,
  firstDayOfMonth,
  formatPeriod,
  inr,
  isNoAttendanceData,
  isNoEmployeeLink,
  isNoPayslip,
  isOverlappingRun,
  isPeriodTooLong,
  isRunSealed,
  lastDayOfMonth,
  nextAction,
  normalizeMyPayslip,
  normalizePayslipsPage,
  normalizePolicy,
  normalizeRunDetail,
  normalizeRunsPage,
  parseRunSealedExpected,
  periodSpanDays,
  RUN_STATUS_FLOW,
  runStatusIndex,
  runStatusTone,
  toneForRunStatus,
  warningTone,
} from '../lib/payroll';
import { PERMISSIONS } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import {
  MAX_PAYROLL_PERIOD_DAYS,
  payrollApproveSchema,
  payrollPeriodSchema,
  payrollPolicySchema,
  payrollReopenSchema,
  periodSchema,
  policySchema,
  reopenSchema,
  approveNoteSchema,
} from '../lib/validation';

const RUN_OPEN = {
  id: 'run_1', period_start: '2026-09-01', period_end: '2026-09-30', status: 'OPEN', version: 1,
};
const TOTALS = { gross: 100000, total_deductions: 12000, net_pay: 88000, headcount: 4 };
const WARNINGS = [
  { code: 'NO_RECORDS', message: 'No attendance rows', employee_id: 'emp_9' },
  { code: 'NO_SALARY', message: 'No salary on file', employee_id: 'emp_10' },
];
const SLIP_ROW = {
  id: 'sl_1', employee_id: 'emp_1', emp_no: 'E001', employee_name: 'Asha Rao',
  gross: 50000, total_deductions: 6000, net_pay: 44000,
};
const MY_SLIP = {
  id: 'sl_1',
  period: { start: '2026-09-01', end: '2026-09-30' },
  run_status: 'LOCKED',
  employee: { emp_no: 'E001', name: 'Asha Rao', designation: 'Nurse' },
  earnings: { basic: 40000, hra: 10000 },
  deductions: { pf: 4800, esi: 1200 },
  gross: 50000,
  total_deductions: 6000,
  net_pay: 44000,
  version: 2,
};

describe('payroll period validation (start≤end, ≤62d span)', () => {
  it('accepts a 62-day span (2026-09-01 → 2026-11-01)', () => {
    expect(periodSpanDays('2026-09-01', '2026-11-01')).toBe(62);
    expect(payrollPeriodSchema.safeParse({ period_start: '2026-09-01', period_end: '2026-11-01' }).success).toBe(true);
  });

  it('rejects a 63-day span with a PERIOD_TOO_LONG hint', () => {
    expect(periodSpanDays('2026-09-01', '2026-11-02')).toBe(63);
    const res = payrollPeriodSchema.safeParse({ period_start: '2026-09-01', period_end: '2026-11-02' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.period_end?.join(' ')).toMatch(/PERIOD_TOO_LONG/);
    }
  });

  it('rejects start > end', () => {
    const res = payrollPeriodSchema.safeParse({ period_start: '2026-10-01', period_end: '2026-09-01' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.period_end?.join(' ')).toMatch(/on or after/);
    }
  });

  it('rejects malformed dates and exposes MAX_PAYROLL_PERIOD_DAYS = 62', () => {
    expect(MAX_PAYROLL_PERIOD_DAYS).toBe(62);
    expect(payrollPeriodSchema.safeParse({ period_start: '09/01/2026', period_end: '2026-09-30' }).success).toBe(false);
    expect(periodSchema).toBe(payrollPeriodSchema);
  });
});

describe('payroll policy validation (divisor 1..31, pct 0..100)', () => {
  it('accepts boundary divisors 1 and 31, rejects 0 / 32 / fractions', () => {
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 1, pf_pct: 12 }).success).toBe(true);
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 31, pf_pct: 12 }).success).toBe(true);
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 0, pf_pct: 12 }).success).toBe(false);
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 32, pf_pct: 12 }).success).toBe(false);
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 30.5, pf_pct: 12 }).success).toBe(false);
  });

  it('accepts pf 0..100, rejects negatives and >100', () => {
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 30, pf_pct: 0 }).success).toBe(true);
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 30, pf_pct: 100 }).success).toBe(true);
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 30, pf_pct: -1 }).success).toBe(false);
    expect(payrollPolicySchema.safeParse({ per_day_divisor: 30, pf_pct: 100.5 }).success).toBe(false);
    expect(policySchema).toBe(payrollPolicySchema);
  });
});

describe('approve note optional / reopen reason required', () => {
  it('accepts approve with no note, rejects an over-long note', () => {
    expect(payrollApproveSchema.safeParse({}).success).toBe(true);
    expect(payrollApproveSchema.safeParse({ note: 'Verified' }).success).toBe(true);
    expect(payrollApproveSchema.safeParse({ note: 'x'.repeat(1001) }).success).toBe(false);
    expect(approveNoteSchema.safeParse(undefined).success).toBe(true);
  });

  it('requires a reopen reason', () => {
    expect(payrollReopenSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(payrollReopenSchema.safeParse({}).success).toBe(false);
    expect(payrollReopenSchema.safeParse({ reason: 'Wrong attendance import' }).success).toBe(true);
    expect(reopenSchema).toBe(payrollReopenSchema);
  });
});

describe('RUN_STATUS_FLOW + nextAction per state', () => {
  it('orders the six states OPEN → … → LOCKED', () => {
    expect(RUN_STATUS_FLOW).toEqual(['OPEN', 'VALIDATING', 'CALCULATED', 'REVIEW', 'APPROVED', 'LOCKED']);
    expect(runStatusIndex('OPEN')).toBe(0);
    expect(runStatusIndex('LOCKED')).toBe(5);
    expect(runStatusIndex('SOMETHING_NEW')).toBe(-1);
  });

  it('maps OPEN → calculate (generate) and CALCULATED → submit-review (generate)', () => {
    expect(nextAction({ status: 'OPEN' })).toEqual({ label: 'Calculate', endpoint: 'calculate', perm: 'payroll.generate' });
    expect(nextAction({ status: 'CALCULATED' })).toEqual({
      label: 'Submit for review', endpoint: 'submit-review', perm: 'payroll.generate',
    });
  });

  it('maps REVIEW → approve, APPROVED → lock, LOCKED → reopen', () => {
    expect(nextAction({ status: 'REVIEW' })).toEqual({ label: 'Approve', endpoint: 'approve', perm: 'payroll.approve' });
    expect(nextAction({ status: 'APPROVED' })).toEqual({ label: 'Lock', endpoint: 'lock', perm: 'payroll.lock' });
    expect(nextAction({ status: 'LOCKED' })).toEqual({ label: 'Reopen', endpoint: 'reopen', perm: 'payroll.lock' });
  });

  it('returns null for VALIDATING, unknown states, and missing runs', () => {
    expect(nextAction({ status: 'VALIDATING' })).toBeNull();
    expect(nextAction({ status: 'FROZEN' })).toBeNull();
    expect(nextAction('OPEN')).toEqual({ label: 'Calculate', endpoint: 'calculate', perm: 'payroll.generate' });
    expect(nextAction(null)).toBeNull();
    expect(nextAction(undefined)).toBeNull();
  });
});

describe('run status + warning tones', () => {
  it('maps the frozen status vocabulary to tones with a neutral fallback', () => {
    expect(runStatusTone.OPEN).toBe('neutral');
    expect(runStatusTone.VALIDATING).toBe('info');
    expect(runStatusTone.CALCULATED).toBe('info');
    expect(runStatusTone.REVIEW).toBe('warning');
    expect(runStatusTone.APPROVED).toBe('success');
    expect(runStatusTone.LOCKED).toBe('neutral');
    expect(toneForRunStatus('SOMETHING_NEW')).toBe('neutral');
  });

  it('tones NO_SALARY as danger and NO_RECORDS as warning', () => {
    expect(warningTone('NO_SALARY')).toBe('danger');
    expect(warningTone('NO_RECORDS')).toBe('warning');
    expect(warningTone('WHATEVER')).toBe('neutral');
  });
});

describe('inr money formatting (en-IN, 2dp)', () => {
  it('formats Indian grouping with 2 decimals', () => {
    expect(inr(123456.5)).toBe('₹1,23,456.50');
    expect(inr('1000')).toBe('₹1,000.00');
    expect(inr(0)).toBe('₹0.00');
  });

  it('renders a placeholder for missing/non-numeric values', () => {
    expect(inr(null)).toBe('—');
    expect(inr(undefined)).toBe('—');
    expect(inr(NaN)).toBe('—');
    expect(inr('not-a-number')).toBe('—');
  });
});

describe('payroll error parsers', () => {
  it('detects RUN_SEALED and extracts the expected state from the message', () => {
    const err = new ApiClientError(422, { code: 'RUN_SEALED', message: 'Run must be CALCULATED to submit for review' });
    expect(isRunSealed(err)).toBe(true);
    expect(parseRunSealedExpected(err)).toBe('CALCULATED');
    expect(isNoAttendanceData(err)).toBe(false);
  });

  it('returns null expected-state when the message names no known state', () => {
    const bare = new ApiClientError(422, { code: 'RUN_SEALED', message: 'Run is sealed' });
    expect(parseRunSealedExpected(bare)).toBeNull();
    const other = new ApiClientError(422, { code: 'OVERLAPPING_RUN', message: 'Run must be OPEN but overlaps' });
    expect(parseRunSealedExpected(other)).toBeNull();
    expect(parseRunSealedExpected(new Error('boom'))).toBeNull();
  });

  it('detects NO_ATTENDANCE_DATA / OVERLAPPING_RUN / PERIOD_TOO_LONG', () => {
    expect(isNoAttendanceData(new ApiClientError(422, { code: 'NO_ATTENDANCE_DATA', message: 'empty' }))).toBe(true);
    expect(isOverlappingRun(new ApiClientError(422, { code: 'OVERLAPPING_RUN', message: 'overlap' }))).toBe(true);
    expect(isPeriodTooLong(new ApiClientError(422, { code: 'PERIOD_TOO_LONG', message: 'too long' }))).toBe(true);
    expect(isOverlappingRun(new ApiClientError(422, { code: 'PERIOD_TOO_LONG', message: 'too long' }))).toBe(false);
  });

  it('detects NO_PAYSLIP / NO_EMPLOYEE_LINK on the own-slip endpoint', () => {
    expect(isNoPayslip(new ApiClientError(404, { code: 'NO_PAYSLIP', message: 'none' }))).toBe(true);
    expect(isNoEmployeeLink(new ApiClientError(404, { code: 'NO_EMPLOYEE_LINK', message: 'no link' }))).toBe(true);
    expect(isNoPayslip(new ApiClientError(404, { code: 'NO_EMPLOYEE_LINK', message: 'no link' }))).toBe(false);
  });
});

describe('payroll normalizers (envelope / bare)', () => {
  it('normalizes the policy from envelope and bare payloads', () => {
    const policy = { per_day_divisor: 30, pf_pct: 12 };
    expect(normalizePolicy({ data: policy }).per_day_divisor).toBe(30);
    expect(normalizePolicy(policy).pf_pct).toBe(12);
    expect(() => normalizePolicy(null)).toThrow();
  });

  it('normalizes run lists from envelope and bare arrays', () => {
    expect(normalizeRunsPage({ data: [RUN_OPEN] })).toHaveLength(1);
    expect(normalizeRunsPage([RUN_OPEN])).toHaveLength(1);
    expect(normalizeRunsPage(null)).toEqual([]);
  });

  it('normalizes run detail from nested, flat, and enveloped shapes', () => {
    const nested = normalizeRunDetail({ run: RUN_OPEN, totals: TOTALS, warnings: WARNINGS });
    expect(nested.run.id).toBe('run_1');
    expect(nested.totals?.net_pay).toBe(88000);
    expect(nested.warnings).toHaveLength(2);
    const flat = normalizeRunDetail({ ...RUN_OPEN, totals: TOTALS, warnings: WARNINGS });
    expect(flat.run.status).toBe('OPEN');
    expect(flat.totals?.headcount).toBe(4);
    const enveloped = normalizeRunDetail({ data: { run: RUN_OPEN, totals: null, warnings: [] } });
    expect(enveloped.totals).toBeNull();
    expect(enveloped.warnings).toEqual([]);
    expect(() => normalizeRunDetail(null)).toThrow();
    expect(() => normalizeRunDetail({})).toThrow();
  });

  it('normalizes payslip rows from envelope and bare arrays', () => {
    expect(normalizePayslipsPage({ data: [SLIP_ROW] })).toHaveLength(1);
    expect(normalizePayslipsPage([SLIP_ROW])[0].net_pay).toBe(44000);
    expect(normalizePayslipsPage(null)).toEqual([]);
  });

  it('normalizes the own slip (bare or enveloped) and rejects garbage', () => {
    expect(normalizeMyPayslip(MY_SLIP).net_pay).toBe(44000);
    expect(normalizeMyPayslip({ data: MY_SLIP }).employee.emp_no).toBe('E001');
    expect(() => normalizeMyPayslip(null)).toThrow();
  });
});

describe('payroll period helpers + query builders', () => {
  it('computes inclusive spans (1-day, multi-day, invalid, reversed)', () => {
    expect(periodSpanDays('2026-09-01', '2026-09-01')).toBe(1);
    expect(periodSpanDays('2026-09-01', '2026-09-30')).toBe(30);
    expect(periodSpanDays('nope', '2026-09-01')).toBeNull();
    expect(periodSpanDays('2026-10-01', '2026-09-01')).toBeLessThanOrEqual(0);
  });

  it('derives current-month bounds and formats period labels', () => {
    const probe = new Date(2026, 8, 15); // September 2026 (local)
    expect(firstDayOfMonth(probe)).toBe('2026-09-01');
    expect(lastDayOfMonth(probe)).toBe('2026-09-30');
    expect(formatPeriod('2026-09-01', '2026-09-30')).toBe('2026-09-01 → 2026-09-30');
  });

  it('builds the runs and my-payslip query strings', () => {
    expect(buildRunsQuery({})).toBe('/api/v1/payroll/runs');
    expect(buildRunsQuery({ status: 'OPEN' })).toContain('status=OPEN');
    const mine = buildMyPayslipQuery({ period_start: '2026-09-01', period_end: '2026-09-30' });
    expect(mine).toContain('/api/v1/payslips/me?');
    expect(mine).toContain('period_start=2026-09-01');
    expect(mine).toContain('period_end=2026-09-30');
  });

  it('exposes the payroll query-key family', () => {
    expect(queryKeys.payroll.policy()).toEqual(['payroll', 'policy']);
    expect(queryKeys.payroll.runs({ status: 'OPEN' })).toEqual(['payroll', 'runs', { status: 'OPEN' }]);
    expect(queryKeys.payroll.run('run_1')).toEqual(['payroll', 'run', 'run_1']);
    expect(queryKeys.payroll.payslips('run_1')).toEqual(['payroll', 'payslips', 'run_1']);
    expect(queryKeys.payroll.myPayslip({ period_start: '2026-09-01' })).toEqual([
      'payroll',
      'myPayslip',
      { period_start: '2026-09-01' },
    ]);
  });
});

describe('P1 permission gating codes (exact values)', () => {
  it('exposes the frozen P1 payroll dot-style codes', () => {
    expect(PERMISSIONS.PAYROLL_READ).toBe('payroll.read');
    expect(PERMISSIONS.PAYROLL_GENERATE).toBe('payroll.generate');
    expect(PERMISSIONS.PAYROLL_APPROVE).toBe('payroll.approve');
    expect(PERMISSIONS.PAYROLL_LOCK).toBe('payroll.lock');
    expect(PERMISSIONS.PAYROLL_CONFIGURE).toBe('payroll.configure');
    expect(PERMISSIONS.PAYSLIP_READ).toBe('payslip.read');
  });
});

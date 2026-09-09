import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../lib/apiClient';
import {
  balanceTotal,
  buildLeaveListParams,
  buildRequestsQuery,
  findBalanceForType,
  formatDays,
  inclusiveDays,
  isBackdated,
  isUnpaidType,
  normalizeBalances,
  normalizeFileRequestResponse,
  normalizeLeaveRequest,
  normalizeLeaveTypes,
  normalizeRequestsPage,
  parseAttendanceConflictDates,
  parseInsufficientBalance,
  parseOverlapIds,
  statusBadgeTone,
  toneForLeaveStatus,
} from '../lib/leave';
import { PERMISSIONS } from '../lib/permissions';
import {
  leaveBalanceSchema,
  leaveDecisionSchema,
  LEAVE_DECISIONS,
  LEAVE_STATUSES,
  leaveRequestSchema,
} from '../lib/validation';

const CL = { id: 'lt_cl', code: 'CL', name: 'Casual', is_paid: true, annual_entitlement: 12, requires_balance: true };
const LOP = { id: 'lt_lop', code: 'LOP', name: 'Loss of Pay', is_paid: false, annual_entitlement: 0, requires_balance: false };
const BAL_CL = {
  id: 'b1', employee_id: 'emp_1', leave_type_id: 'lt_cl', leave_code: 'CL', period_year: 2026,
  opening_balance: 12, credits: 0, consumed: 2, adjustments: 0, current_balance: 10,
};
const REQ = {
  id: 'lr_1', employee_id: 'emp_1', leave_type_id: 'lt_cl', leave_code: 'CL',
  from_date: '2026-09-10', to_date: '2026-09-12', total_days: 3, reason: 'Family',
  status: 'PENDING', current_approver_id: 'usr_9', version: 1, created_at: '2026-09-01T00:00:00Z',
};

describe('inclusiveDays', () => {
  it('counts a single day as 1', () => {
    expect(inclusiveDays('2026-09-01', '2026-09-01')).toBe(1);
  });

  it('counts multi-day ranges inclusively', () => {
    expect(inclusiveDays('2026-09-01', '2026-09-03')).toBe(3);
    expect(inclusiveDays('2026-09-01', '2026-10-01')).toBe(31);
  });

  it('returns null for unparseable dates', () => {
    expect(inclusiveDays('not-a-date', '2026-09-01')).toBeNull();
    expect(inclusiveDays('2026-09-01', '')).toBeNull();
  });

  it('returns <= 0 when from > to (invalid range)', () => {
    expect(inclusiveDays('2026-09-05', '2026-09-01')).toBeLessThanOrEqual(0);
  });
});

describe('leaveRequestSchema (type required, from<=to, past-date reason rule)', () => {
  it('accepts a future range without a reason', () => {
    expect(
      leaveRequestSchema.safeParse({ leave_type_id: 'lt_cl', from_date: '2999-01-10', to_date: '2999-01-12' }).success,
    ).toBe(true);
  });

  it('requires a leave type', () => {
    const res = leaveRequestSchema.safeParse({ leave_type_id: '', from_date: '2999-01-10', to_date: '2999-01-12' });
    expect(res.success).toBe(false);
  });

  it('rejects from > to', () => {
    const res = leaveRequestSchema.safeParse({ leave_type_id: 'lt_cl', from_date: '2999-01-12', to_date: '2999-01-10', reason: 'x' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.to_date?.join(' ')).toMatch(/on or after/);
    }
  });

  it('requires reason when from < today (backdated), with a server-revalidates note', () => {
    const res = leaveRequestSchema.safeParse({ leave_type_id: 'lt_cl', from_date: '2000-01-10', to_date: '2000-01-12' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.flatten().fieldErrors.reason?.join(' ')).toMatch(/server re-validates/);
    }
    expect(
      leaveRequestSchema.safeParse({ leave_type_id: 'lt_cl', from_date: '2000-01-10', to_date: '2000-01-12', reason: 'Forgot to file' }).success,
    ).toBe(true);
  });

  it('isBackdated compares against an injectable today', () => {
    expect(isBackdated('2026-08-31', '2026-09-01')).toBe(true);
    expect(isBackdated('2026-09-01', '2026-09-01')).toBe(false);
    expect(isBackdated('2026-09-02', '2026-09-01')).toBe(false);
  });
});

describe('leave error-mapping helpers', () => {
  it('parses INSUFFICIENT_BALANCE available days', () => {
    const err = new ApiClientError(422, { code: 'INSUFFICIENT_BALANCE', message: 'short', details: { available: 2 } });
    expect(parseInsufficientBalance(err)).toBe(2);
    expect(parseInsufficientBalance(new ApiClientError(422, { code: 'INSUFFICIENT_BALANCE', message: 'short' }))).toBeNull();
  });

  it('parses LEAVE_OVERLAP conflicting request ids', () => {
    const err = new ApiClientError(422, {
      code: 'LEAVE_OVERLAP', message: 'overlap', details: { conflicting_ids: ['lr_1', 'lr_2'] },
    });
    expect(parseOverlapIds(err)).toEqual(['lr_1', 'lr_2']);
    const alt = new ApiClientError(422, {
      code: 'LEAVE_OVERLAP', message: 'overlap', details: { conflicting_request_ids: 'lr_9' },
    });
    expect(parseOverlapIds(alt)).toEqual(['lr_9']);
  });

  it('parses ATTENDANCE_CONFLICT conflicting dates', () => {
    const err = new ApiClientError(422, {
      code: 'ATTENDANCE_CONFLICT', message: 'conflict', details: { conflicting_dates: ['2026-09-10', '2026-09-11'] },
    });
    expect(parseAttendanceConflictDates(err)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('reads rule data nested under details.extra (server shape)', () => {
    const bal = new ApiClientError(422, {
      code: 'INSUFFICIENT_BALANCE', message: 'short', details: { extra: { available: 7 } },
    });
    expect(parseInsufficientBalance(bal)).toBe(7);
    const ov = new ApiClientError(422, {
      code: 'LEAVE_OVERLAP', message: 'overlap', details: { extra: { conflicting_request_ids: ['lr_3'] } },
    });
    expect(parseOverlapIds(ov)).toEqual(['lr_3']);
    const att = new ApiClientError(422, {
      code: 'ATTENDANCE_CONFLICT', message: 'conflict', details: { extra: { conflicting_dates: ['2026-09-12'] } },
    });
    expect(parseAttendanceConflictDates(att)).toEqual(['2026-09-12']);
  });
});

describe('LOP skips the balance hint', () => {
  it('flags LOP / unpaid / no-balance types via isUnpaidType', () => {
    expect(isUnpaidType(LOP)).toBe(true);
    expect(isUnpaidType(CL)).toBe(false);
    expect(isUnpaidType({ code: 'X', is_paid: false, requires_balance: true })).toBe(true);
  });

  it('findBalanceForType returns undefined for LOP even when rows exist', () => {
    expect(findBalanceForType([BAL_CL], LOP)).toBeUndefined();
    expect(findBalanceForType([BAL_CL], CL)?.id).toBe('b1');
  });
});

describe('leaveDecisionSchema (note required on reject)', () => {
  it('accepts APPROVE without a note, rejects REJECT without a note', () => {
    expect(leaveDecisionSchema.safeParse({ decision: 'APPROVE' }).success).toBe(true);
    expect(leaveDecisionSchema.safeParse({ decision: 'REJECT' }).success).toBe(false);
    expect(leaveDecisionSchema.safeParse({ decision: 'REJECT', note: 'No cover' }).success).toBe(true);
  });

  it('rejects unknown decisions', () => {
    expect(leaveDecisionSchema.safeParse({ decision: 'MAYBE' }).success).toBe(false);
    expect(LEAVE_DECISIONS).toEqual(['APPROVE', 'REJECT']);
  });
});

describe('leaveBalanceSchema', () => {
  it('accepts a zero opening balance, rejects negatives and missing ids', () => {
    expect(
      leaveBalanceSchema.safeParse({ employee_id: 'emp_1', leave_type_id: 'lt_cl', period_year: 2026, opening_balance: 0 }).success,
    ).toBe(true);
    expect(
      leaveBalanceSchema.safeParse({ employee_id: 'emp_1', leave_type_id: 'lt_cl', period_year: 2026, opening_balance: -1 }).success,
    ).toBe(false);
    expect(
      leaveBalanceSchema.safeParse({ employee_id: '', leave_type_id: 'lt_cl', period_year: 2026, opening_balance: 5 }).success,
    ).toBe(false);
  });
});

describe('leave normalizers (envelope / bare / 200-applied)', () => {
  it('normalizes leave types from envelope and bare arrays', () => {
    expect(normalizeLeaveTypes({ data: [CL] })).toHaveLength(1);
    expect(normalizeLeaveTypes([CL])).toHaveLength(1);
    expect(normalizeLeaveTypes(null)).toEqual([]);
  });

  it('normalizes balances from envelope and bare arrays', () => {
    expect(normalizeBalances({ data: [BAL_CL] })).toHaveLength(1);
    expect(normalizeBalances([BAL_CL])).toHaveLength(1);
    expect(balanceTotal(BAL_CL)).toBe(12);
  });

  it('normalizes requests pages from envelope and bare arrays', () => {
    const fromEnvelope = normalizeRequestsPage({ data: [REQ], next_cursor: 'c1', has_more: true });
    expect(fromEnvelope.data).toHaveLength(1);
    expect(fromEnvelope.next_cursor).toBe('c1');
    expect(fromEnvelope.has_more).toBe(true);
    const fromBare = normalizeRequestsPage([REQ]);
    expect(fromBare.data).toHaveLength(1);
    expect(fromBare.has_more).toBe(false);
  });

  it('maps the 201 bare shape to created', () => {
    const res = normalizeFileRequestResponse(REQ);
    expect(res.kind).toBe('created');
    if (res.kind === 'created') expect(res.request.id).toBe('lr_1');
  });

  it('maps the 200 {applied:true,request} replay shape to applied', () => {
    const res = normalizeFileRequestResponse({ applied: true, request: REQ });
    expect(res.kind).toBe('applied');
    if (res.kind === 'applied') expect(res.applied).toBe(true);
  });

  it('tolerates a {data:...} envelope around file-request responses', () => {
    expect(normalizeFileRequestResponse({ data: REQ }).kind).toBe('created');
    expect(normalizeFileRequestResponse({ data: { applied: true, request: REQ } }).kind).toBe('applied');
  });

  it('normalizes GET /:id detail (bare or enveloped, with chain)', () => {
    const withChain = { ...REQ, approval_chain: [{ step: 1, approver_user_id: 'usr_9', status: 'PENDING', decided_at: null, note: null }] };
    expect(normalizeLeaveRequest(withChain).approval_chain).toHaveLength(1);
    expect(normalizeLeaveRequest({ data: REQ }).id).toBe('lr_1');
    expect(() => normalizeLeaveRequest(null)).toThrow();
  });
});

describe('leave list-view builder', () => {
  it('maps mine/approvals/all to mine=/approver_me=/employee_id params', () => {
    expect(buildLeaveListParams('mine', {})).toMatchObject({ mine: 'true' });
    expect(buildLeaveListParams('approvals', {})).toMatchObject({ approver_me: 'true' });
    expect(buildLeaveListParams('all', { employee_id: 'emp_1' })).toMatchObject({ employee_id: 'emp_1' });
    expect(buildLeaveListParams('all', {})).not.toHaveProperty('mine');
    expect(buildLeaveListParams('mine', { status: 'PENDING' }).status).toBe('PENDING');
  });

  it('builds the requests query string with all supported params', () => {
    const qs = buildRequestsQuery({ status: 'PENDING', mine: 'true', limit: 20, cursor: 'c1' });
    expect(qs).toContain('/api/v1/leave/requests?');
    expect(qs).toContain('status=PENDING');
    expect(qs).toContain('mine=true');
    expect(qs).toContain('limit=20');
    expect(qs).toContain('cursor=c1');
  });
});

describe('formatDays + statusBadgeTone', () => {
  it('renders day counts with singular/plural and a placeholder', () => {
    expect(formatDays(1)).toBe('1 day');
    expect(formatDays(3)).toBe('3 days');
    expect(formatDays(null)).toBe('—');
    expect(formatDays(NaN)).toBe('—');
  });

  it('maps the frozen status vocabulary to tones', () => {
    expect(statusBadgeTone.PENDING).toBe('warning');
    expect(statusBadgeTone.APPROVED).toBe('success');
    expect(statusBadgeTone.REJECTED).toBe('danger');
    expect(statusBadgeTone.CANCELLED).toBe('neutral');
    expect(toneForLeaveStatus('SOMETHING_NEW')).toBe('neutral');
    expect(LEAVE_STATUSES).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
  });
});

describe('S3 permission gating codes (exact values)', () => {
  it('exposes the frozen S3 dot-style codes', () => {
    expect(PERMISSIONS.LEAVE_REQUEST).toBe('leave.request');
    expect(PERMISSIONS.LEAVE_DECIDE).toBe('leave.decide');
    expect(PERMISSIONS.LEAVE_READ).toBe('leave.read');
    expect(PERMISSIONS.LEAVE_ADMIN).toBe('leave.admin');
  });
});

import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../lib/apiClient';
import {
  formatHours,
  normalizePunchResponse,
  normalizeRecordDetail,
  normalizeRecordsPage,
} from '../lib/attendance';
import { isConflictError } from '../lib/form-errors';
import { PERMISSIONS } from '../lib/permissions';
import {
  decisionSchema,
  exceptionSchema,
  EXCEPTION_TYPE_LABELS,
  regularizeSchema,
} from '../lib/validation';

const EVENT = { id: 'evt_1', employee_id: 'emp_1', event_type: 'CHECK_IN', client_timestamp: '2026-09-01T09:00:00Z' };
const RECORD = { id: 'rec_1', employee_id: 'emp_1', work_date: '2026-09-01', status: 'PRESENT', version: 3 };

describe('normalizePunchResponse', () => {
  it('maps the 201 shape (event+record+decision) to accepted', () => {
    const res = normalizePunchResponse({ event: EVENT, record: RECORD, decision: 'ACCEPTED' });
    expect(res.kind).toBe('accepted');
    if (res.kind === 'accepted') expect(res.event.id).toBe('evt_1');
  });

  it('maps the 200 replay shape (applied:true) to applied', () => {
    const res = normalizePunchResponse({ applied: true, event: EVENT, record: RECORD });
    expect(res.kind).toBe('applied');
  });

  it('maps the 202 shape (review+code+exception_id) to review', () => {
    const res = normalizePunchResponse({
      review: 'REQUIRES_REVIEW',
      code: 'MOCK_LOCATION',
      exception_id: 'exc_9',
      message: 'Mock location detected',
    });
    expect(res.kind).toBe('review');
    if (res.kind === 'review') {
      expect(res.code).toBe('MOCK_LOCATION');
      expect(res.exception_id).toBe('exc_9');
    }
  });

  it('tolerates a {data:...} envelope around the 202 body', () => {
    const res = normalizePunchResponse({
      data: { review: 'REQUIRES_REVIEW', code: 'LATE_CHECKIN', exception_id: 'exc_1', message: 'm' },
    });
    expect(res.kind).toBe('review');
  });

  it('throws on unrecognized shapes (e.g. 422 bodies must surface as errors, not results)', () => {
    expect(() => normalizePunchResponse({ code: 'FUTURE_PUNCH', message: 'nope' })).toThrow();
    expect(() => normalizePunchResponse(null)).toThrow();
  });
});

describe('exception + decision + regularize schemas', () => {
  it('accepts a valid exception filing', () => {
    expect(
      exceptionSchema.safeParse({ employee_id: 'emp_1', exception_type: 'MISSED_PUNCH', reason: 'Forgot to punch' }).success,
    ).toBe(true);
  });

  it('no longer lets an outside-geofence exception be filed, but still labels an old one', () => {
    // The geo-fence is gone (2026-09-22). Rows raised while it existed keep
    // the type and need a name; nothing new may be filed under it.
    expect(
      exceptionSchema.safeParse({ employee_id: 'emp_1', exception_type: 'OUTSIDE_GEOFENCE', reason: 'x' }).success,
    ).toBe(false);
    expect(EXCEPTION_TYPE_LABELS.OUTSIDE_GEOFENCE).toMatch(/legacy/i);
  });

  it('rejects an exception with an empty reason', () => {
    expect(
      exceptionSchema.safeParse({ employee_id: 'emp_1', exception_type: 'MISSED_PUNCH', reason: '' }).success,
    ).toBe(false);
  });

  it('accepts a decision with no note, rejects an unknown decision', () => {
    expect(decisionSchema.safeParse({ decision: 'APPROVE' }).success).toBe(true);
    expect(decisionSchema.safeParse({ decision: 'APPROVE', note: 'ok' }).success).toBe(true);
    expect(decisionSchema.safeParse({ decision: 'MAYBE' }).success).toBe(false);
  });

  it('requires at least one claimed time on regularize', () => {
    const base = { employee_id: 'emp_1', work_date: '2026-09-01', reason: 'Missed punch' };
    expect(regularizeSchema.safeParse({ ...base, claimed_check_in: '2026-09-01T09:00:00Z' }).success).toBe(true);
    expect(regularizeSchema.safeParse({ ...base, claimed_check_out: '2026-09-01T18:00:00Z' }).success).toBe(true);
    expect(regularizeSchema.safeParse(base).success).toBe(false);
    expect(regularizeSchema.safeParse({ ...base, work_date: '01-09-2026', claimed_check_in: 'x' }).success).toBe(false);
  });
});

describe('decision version-conflict detection (isConflictError)', () => {
  it('flags 409 and VERSION_CONFLICT as conflicts', () => {
    expect(isConflictError(new ApiClientError(409, { code: 'VERSION_CONFLICT', message: 'stale' }))).toBe(true);
    expect(isConflictError(new ApiClientError(200, { code: 'VERSION_CONFLICT', message: 'stale' }))).toBe(true);
  });

  it('does not flag 422 validation errors', () => {
    expect(isConflictError(new ApiClientError(422, { code: 'VALIDATION_ERROR', message: 'bad' }))).toBe(false);
  });
});

describe('formatHours', () => {
  it('renders decimal hours as "7h 30m"', () => {
    expect(formatHours(7.5)).toBe('7h 30m');
    expect(formatHours(8)).toBe('8h');
    expect(formatHours(0.5)).toBe('30m');
  });

  it('renders a placeholder for missing/invalid values', () => {
    expect(formatHours(null)).toBe('—');
    expect(formatHours(undefined)).toBe('—');
    expect(formatHours(NaN)).toBe('—');
  });
});

describe('S2 permission gating codes (exact values)', () => {
  it('exposes the frozen S2 dot-style codes', () => {
    expect(PERMISSIONS.ATTENDANCE_PUNCH).toBe('attendance.punch');
    expect(PERMISSIONS.ATTENDANCE_READ).toBe('attendance.read');
    expect(PERMISSIONS.ATTENDANCE_DECIDE).toBe('attendance.decide');
  });

  it('no longer knows the retired geo-fence codes', () => {
    expect(PERMISSIONS).not.toHaveProperty('GEO_READ');
    expect(PERMISSIONS).not.toHaveProperty('GEO_MANAGE');
  });
});

describe('records / record-detail normalizers', () => {
  it('normalizes both envelope and bare-array records pages', () => {
    const fromEnvelope = normalizeRecordsPage({ data: [RECORD], next_cursor: 'c1', has_more: true });
    expect(fromEnvelope.data).toHaveLength(1);
    expect(fromEnvelope.next_cursor).toBe('c1');
    expect(fromEnvelope.has_more).toBe(true);
    const fromBare = normalizeRecordsPage([RECORD]);
    expect(fromBare.data).toHaveLength(1);
    expect(fromBare.has_more).toBe(false);
  });

  it('normalizes {record,events} and flat record-detail shapes', () => {
    const nested = normalizeRecordDetail({ record: RECORD, events: [EVENT] });
    expect(nested.record.id).toBe('rec_1');
    expect(nested.events).toHaveLength(1);
    const flat = normalizeRecordDetail({ ...RECORD, events: [] });
    expect(flat.record.id).toBe('rec_1');
    expect(flat.events).toEqual([]);
  });
});

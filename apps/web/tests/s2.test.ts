import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../lib/apiClient';
import {
  formatHours,
  normalizePunchResponse,
  normalizeRecordDetail,
  normalizeRecordsPage,
} from '../lib/attendance';
import { normalizeFences } from '../lib/geo';
import { isConflictError } from '../lib/form-errors';
import { PERMISSIONS } from '../lib/permissions';
import {
  decisionSchema,
  exceptionSchema,
  fenceSchema,
  parsePolygonTextarea,
  regularizeSchema,
} from '../lib/validation';

const EVENT = { id: 'evt_1', employee_id: 'emp_1', event_type: 'CHECK_IN', client_timestamp: '2026-09-01T09:00:00Z' };
const RECORD = { id: 'rec_1', employee_id: 'emp_1', work_date: '2026-09-01', status: 'PRESENT', version: 3 };

describe('parsePolygonTextarea', () => {
  it('parses a valid 3-point polygon', () => {
    const res = parsePolygonTextarea('17.44,78.34\n17.45,78.35\n17.43,78.36');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.points).toHaveLength(3);
      expect(res.points[0]).toEqual({ lat: 17.44, lng: 78.34 });
    }
  });

  it('rejects a malformed line with a line number', () => {
    const res = parsePolygonTextarea('17.44,78.34\nnope\n17.43,78.36');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Line 2/);
  });

  it('rejects fewer than 3 points', () => {
    const res = parsePolygonTextarea('17.44,78.34\n17.45,78.35');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/at least 3 points/);
  });

  it('rejects out-of-range coordinates', () => {
    expect(parsePolygonTextarea('91,0\n17.45,78.35\n17.43,78.36').ok).toBe(false);
    expect(parsePolygonTextarea('17.44,200\n17.45,78.35\n17.43,78.36').ok).toBe(false);
  });
});

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
      code: 'OUTSIDE_GEOFENCE',
      exception_id: 'exc_9',
      message: 'Outside fence',
    });
    expect(res.kind).toBe('review');
    if (res.kind === 'review') {
      expect(res.code).toBe('OUTSIDE_GEOFENCE');
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

describe('fenceSchema', () => {
  const base = { name: 'Gate', scope_type: 'site', scope_id: 's1', tolerance_meters: 50, accuracy_threshold_meters: 100 };

  it('accepts a valid circle fence', () => {
    expect(
      fenceSchema.safeParse({ ...base, geometry_type: 'circle', circle_lat: 17.44, circle_lng: 78.34, radius_m: 100 }).success,
    ).toBe(true);
  });

  it('rejects a circle with radius_m <= 0', () => {
    expect(
      fenceSchema.safeParse({ ...base, geometry_type: 'circle', circle_lat: 17.44, circle_lng: 78.34, radius_m: 0 }).success,
    ).toBe(false);
  });

  it('accepts a valid polygon textarea, rejects <3 points', () => {
    expect(
      fenceSchema.safeParse({ ...base, geometry_type: 'polygon', polygon_text: '17.44,78.34\n17.45,78.35\n17.43,78.36' }).success,
    ).toBe(true);
    expect(
      fenceSchema.safeParse({ ...base, geometry_type: 'polygon', polygon_text: '17.44,78.34\n17.45,78.35' }).success,
    ).toBe(false);
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
    expect(PERMISSIONS.GEO_READ).toBe('geo.read');
    expect(PERMISSIONS.GEO_MANAGE).toBe('geo.manage');
  });
});

describe('records / fences / record-detail normalizers', () => {
  it('normalizes both envelope and bare-array records pages', () => {
    const fromEnvelope = normalizeRecordsPage({ data: [RECORD], next_cursor: 'c1', has_more: true });
    expect(fromEnvelope.data).toHaveLength(1);
    expect(fromEnvelope.next_cursor).toBe('c1');
    expect(fromEnvelope.has_more).toBe(true);
    const fromBare = normalizeRecordsPage([RECORD]);
    expect(fromBare.data).toHaveLength(1);
    expect(fromBare.has_more).toBe(false);
  });

  it('normalizes both envelope and bare-array fence lists', () => {
    const fence = { id: 'f1', name: 'Gate', scope_type: 'site', scope_id: 's1', geometry_type: 'circle', version: 1 };
    expect(normalizeFences({ data: [fence] })).toHaveLength(1);
    expect(normalizeFences([fence])).toHaveLength(1);
    expect(normalizeFences(null)).toEqual([]);
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

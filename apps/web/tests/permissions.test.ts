import { describe, expect, it } from 'vitest';
import { PERMISSIONS, hasPermission } from '../lib/permissions';

describe('hasPermission', () => {
  it('returns true when the holder has the code', () => {
    expect(
      hasPermission({ permissions: [PERMISSIONS.EMPLOYEE_READ, 'other.code'] }, PERMISSIONS.EMPLOYEE_READ),
    ).toBe(true);
  });

  it('returns false when the holder lacks the code', () => {
    expect(hasPermission({ permissions: [PERMISSIONS.DOCUMENT_READ] }, PERMISSIONS.EMPLOYEE_READ)).toBe(false);
  });

  it('returns false for an empty permission list', () => {
    expect(hasPermission({ permissions: [] }, PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it('returns false for a null holder', () => {
    expect(hasPermission(null, PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it('returns false for an undefined holder', () => {
    expect(hasPermission(undefined, PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it('returns false when permissions is missing or not an array', () => {
    expect(hasPermission({}, PERMISSIONS.AUDIT_READ)).toBe(false);
    expect(hasPermission({ permissions: null }, PERMISSIONS.AUDIT_READ)).toBe(false);
  });
});

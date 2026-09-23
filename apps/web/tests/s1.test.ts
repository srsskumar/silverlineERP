import { describe, expect, it } from 'vitest';
import {
  employeeCreateSchema,
  employeeExitSchema,
  employeeUpdateSchema,
  holidaySchema,
  importRowSchema,
  orgUnitSchema,
} from '../lib/validation';
import { parseEmployeeCsv } from '../lib/csv';
import { displayMasked, MASKED_PLACEHOLDER } from '../lib/masking';
import { PERMISSIONS, hasAllPermissions, hasAnyPermission, hasPermission } from '../lib/permissions';

const VALID_EMPLOYEE = {
  emp_no: 'EMP001',
  first_name: 'Asha',
  last_name: 'Kumari',
  phone: '+919876543210',
  date_of_joining: '2024-01-15',
  designation: 'Field Officer',
};

describe('employeeCreateSchema', () => {
  it('accepts a minimal valid employee', () => {
    expect(employeeCreateSchema.safeParse(VALID_EMPLOYEE).success).toBe(true);
  });

  it('accepts a full valid employee with PII + location fields', () => {
    const result = employeeCreateSchema.safeParse({
      ...VALID_EMPLOYEE,
      father_name: 'Rama Rao',
      date_of_birth: '1995-05-01',
      gender: 'FEMALE',
      email: 'asha@example.com',
      aadhaar: '123456789012',
      pan: 'ABCDE1234F',
      district_id: 'd1',
      mandal_id: 'm1',
      village_id: 'v1',
      salary_basic: 15000,
      bank_ifsc: 'ABCD0123456',
      phonepe_number: '+919876543211',
      experience_years: 2.5,
      status: 'ACTIVE',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing emp_no', () => {
    const { emp_no: _omit, ...rest } = VALID_EMPLOYEE;
    const result = employeeCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects a non-E.164 phone number', () => {
    expect(employeeCreateSchema.safeParse({ ...VALID_EMPLOYEE, phone: '123' }).success).toBe(false);
    expect(employeeCreateSchema.safeParse({ ...VALID_EMPLOYEE, phone: 'not-a-phone' }).success).toBe(false);
  });

  it('rejects date of birth after date of joining', () => {
    const result = employeeCreateSchema.safeParse({
      ...VALID_EMPLOYEE,
      date_of_birth: '2025-01-01',
      date_of_joining: '2024-01-15',
    });
    expect(result.success).toBe(false);
  });

  it('employeeUpdateSchema accepts a partial patch', () => {
    expect(employeeUpdateSchema.safeParse({ designation: 'Supervisor' }).success).toBe(true);
    expect(employeeUpdateSchema.safeParse({ phone: 'bad' }).success).toBe(false);
  });
});

describe('employeeExitSchema', () => {
  it('rejects exit_date before date_of_joining', () => {
    const result = employeeExitSchema.safeParse({
      exit_date: '2024-01-01',
      reason: 'Resigned',
      date_of_joining: '2024-06-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.exit_date?.[0]).toMatch(/before date of joining/);
    }
  });

  it('accepts exit_date on/after date_of_joining', () => {
    expect(
      employeeExitSchema.safeParse({
        exit_date: '2024-06-01',
        reason: 'Resigned',
        date_of_joining: '2024-06-01',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty reason', () => {
    expect(employeeExitSchema.safeParse({ exit_date: '2024-07-01', reason: '' }).success).toBe(false);
  });
});

describe('orgUnit + holiday schemas', () => {
  it('accepts a valid org unit and rejects an empty code', () => {
    expect(orgUnitSchema.safeParse({ type: 'mandal', code: 'M01', name: 'Mandal One', parent_id: 'd1' }).success).toBe(
      true,
    );
    expect(orgUnitSchema.safeParse({ type: 'mandal', code: '', name: 'Mandal One' }).success).toBe(false);
  });

  it('accepts a valid holiday and rejects scope_id without scope_type', () => {
    expect(holidaySchema.safeParse({ date: '2026-01-26', name: 'Republic Day', type: 'national' }).success).toBe(true);
    expect(
      holidaySchema.safeParse({ date: '2026-01-26', name: 'Local Fest', type: 'national', scope_id: 'd1' }).success,
    ).toBe(false);
  });

  it('rejects a holiday type the API does not accept (A-007: the create form let anyone type PUBLIC/FESTIVAL, which the server always 422s)', () => {
    // The API's holidayTypeSchema (packages/shared/src/s1.ts) only accepts
    // national/regional/local/weekly_off/manual, but the old placeholder text
    // on the Type field ("PUBLIC / FESTIVAL / REGIONAL…") suggested uppercase
    // words that were never valid — every one of them 422s server-side.
    expect(holidaySchema.safeParse({ date: '2026-01-26', name: 'Republic Day', type: 'PUBLIC' }).success).toBe(false);
    expect(holidaySchema.safeParse({ date: '2026-01-26', name: 'Local Fest', type: 'FESTIVAL' }).success).toBe(false);
  });

  it(
    'accepts scope_type left on its blank "Org-wide" option (A-009: the create dialog\'s ' +
      '<select id="hol-scope-type"> defaults to "", which z.enum(...).optional() alone rejects)',
    () => {
      expect(
        holidaySchema.safeParse({ date: '2026-01-26', name: 'Republic Day', type: 'national', scope_type: '' })
          .success,
      ).toBe(true);
    },
  );

  it('importRowSchema requires the identity quartet', () => {
    expect(importRowSchema.safeParse(VALID_EMPLOYEE).success).toBe(true);
    const { phone: _omit, ...noPhone } = VALID_EMPLOYEE;
    expect(importRowSchema.safeParse(noPhone).success).toBe(false);
  });
});

describe('parseEmployeeCsv', () => {
  it('maps aliased headers to canonical employee fields', () => {
    const parsed = parseEmployeeCsv(
      'Emp No,FirstName,Mobile,DOJ,Role\nEMP001,Asha,+919876543210,2024-01-15,Officer',
    );
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      emp_no: 'EMP001',
      first_name: 'Asha',
      phone: '+919876543210',
      date_of_joining: '2024-01-15',
      designation: 'Officer',
    });
  });

  it('reports rows with the wrong column count and keeps good rows', () => {
    const parsed = parseEmployeeCsv('emp_no,first_name,phone\nEMP001,Asha\nEMP002,Ravi,+919876543211');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].emp_no).toBe('EMP002');
    expect(parsed.parseErrors).toHaveLength(1);
    expect(parsed.parseErrors[0].index).toBe(1);
  });

  it('handles quoted fields containing commas', () => {
    const parsed = parseEmployeeCsv('emp_no,first_name,address\nEMP001,"Asha, Jr","H.No 1, Main Road"');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].address).toBe('H.No 1, Main Road');
  });
});

describe('displayMasked', () => {
  it('returns the full value when present', () => {
    expect(displayMasked('+919876543210', '3210')).toBe('+919876543210');
  });

  it('renders the last4 when the full value is masked (null)', () => {
    const out = displayMasked(null, '3210');
    expect(out).toContain('3210');
    expect(out).not.toBe(MASKED_PLACEHOLDER);
  });

  it('renders a placeholder when both value and last4 are missing', () => {
    expect(displayMasked(null, null)).toBe(MASKED_PLACEHOLDER);
    expect(displayMasked(undefined, '')).toBe(MASKED_PLACEHOLDER);
  });
});

describe('S1 permission gating helpers', () => {
  const holder = {
    permissions: [PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.ORG_UNITS_READ, PERMISSIONS.HOLIDAY_READ],
  };

  it('exposes the frozen S1 dot-style codes', () => {
    expect(PERMISSIONS.ORG_UNITS_READ).toBe('org.units.read');
    expect(PERMISSIONS.EMPLOYEE_IMPORT).toBe('employee.import');
    expect(PERMISSIONS.DOCUMENT_UPLOAD).toBe('document.upload');
    expect(PERMISSIONS.HOLIDAY_MANAGE).toBe('holiday.manage');
  });

  it('gates new codes with hasPermission', () => {
    expect(hasPermission(holder, PERMISSIONS.EMPLOYEE_READ)).toBe(true);
    expect(hasPermission(holder, PERMISSIONS.EMPLOYEE_CREATE)).toBe(false);
  });

  it('hasAnyPermission passes when any code matches', () => {
    expect(hasAnyPermission(holder, [PERMISSIONS.EMPLOYEE_CREATE, PERMISSIONS.ORG_UNITS_READ])).toBe(true);
    expect(hasAnyPermission(holder, [PERMISSIONS.EMPLOYEE_CREATE, PERMISSIONS.DOCUMENT_UPLOAD])).toBe(false);
  });

  it('hasAllPermissions requires every code', () => {
    expect(hasAllPermissions(holder, [PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.ORG_UNITS_READ])).toBe(true);
    expect(hasAllPermissions(holder, [PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.EMPLOYEE_EXIT])).toBe(false);
  });
});

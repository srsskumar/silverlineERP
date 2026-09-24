import { describe, expect, it } from 'vitest';
import { raBillSchema, advanceSchema } from '../lib/validation';

/**
 * Task 5a / B-007 — billing had no web creation form for RA bills or
 * advances even though `POST /ra-bills` and `POST /advances` exist server
 * side. These schemas gate those two forms; every field must match what
 * `raBillSchema`/`advanceSchema` in packages/shared/src/ra-billing.ts accept.
 */

const validRaBill = {
  project_id: '11111111-1111-1111-1111-111111111111',
  period_from: '2026-08-01',
  period_to: '2026-08-31',
  lines: [
    { boq_item_id: '22222222-2222-2222-2222-222222222222', cumulative_quantity: 120 },
  ],
};

describe('raBillSchema (B-007)', () => {
  it('accepts a valid RA bill and defaults bill_type to RA', () => {
    const result = raBillSchema.safeParse(validRaBill);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.bill_type).toBe('RA');
  });

  it('accepts a FINAL bill with a fixed deduction', () => {
    const result = raBillSchema.safeParse({
      ...validRaBill,
      bill_type: 'FINAL',
      measurement_book_ref: 'MB-44',
      remarks: 'Final measurement',
      fixed_deductions: [
        { head: 'PENALTY', label: 'Delay penalty', amount: '5000.00', reason: 'Two weeks beyond the schedule' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty line list', () => {
    const result = raBillSchema.safeParse({ ...validRaBill, lines: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a period that ends before it starts', () => {
    const result = raBillSchema.safeParse({ ...validRaBill, period_to: '2026-07-01' });
    expect(result.success).toBe(false);
  });

  it('rejects a bad bill_type enum value', () => {
    const result = raBillSchema.safeParse({ ...validRaBill, bill_type: 'INTERIM' });
    expect(result.success).toBe(false);
  });

  it('rejects a fixed deduction with a bad head enum value', () => {
    const result = raBillSchema.safeParse({
      ...validRaBill,
      fixed_deductions: [{ head: 'DISCOUNT', label: 'x', amount: '10', reason: 'y' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative fixed-deduction amount', () => {
    const result = raBillSchema.safeParse({
      ...validRaBill,
      fixed_deductions: [{ head: 'OTHER', label: 'x', amount: '-10', reason: 'y' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a fixed-deduction amount with more than 2 decimal places', () => {
    const result = raBillSchema.safeParse({
      ...validRaBill,
      fixed_deductions: [{ head: 'OTHER', label: 'x', amount: '10.999', reason: 'y' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing project', () => {
    const result = raBillSchema.safeParse({ ...validRaBill, project_id: '' });
    expect(result.success).toBe(false);
  });
});

const validAdvance = {
  project_id: '11111111-1111-1111-1111-111111111111',
  advance_type: 'MOBILISATION',
  amount: '500000.00',
  paid_on: '2026-09-01',
  recovery_pct: 10,
};

describe('advanceSchema (B-007)', () => {
  it('accepts a valid advance', () => {
    const result = advanceSchema.safeParse(validAdvance);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.amount).toBe(500000);
  });

  it('accepts an optional bank guarantee id and remarks', () => {
    const result = advanceSchema.safeParse({
      ...validAdvance,
      bank_guarantee_id: '33333333-3333-3333-3333-333333333333',
      remarks: 'Against BG-102',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bad advance_type enum value', () => {
    const result = advanceSchema.safeParse({ ...validAdvance, advance_type: 'FUEL' });
    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative amount', () => {
    expect(advanceSchema.safeParse({ ...validAdvance, amount: '0' }).success).toBe(false);
    expect(advanceSchema.safeParse({ ...validAdvance, amount: '-500' }).success).toBe(false);
  });

  it('rejects an amount with more than 2 decimal places', () => {
    const result = advanceSchema.safeParse({ ...validAdvance, amount: '500000.999' });
    expect(result.success).toBe(false);
  });

  it('rejects a recovery percentage of 0 or below', () => {
    const result = advanceSchema.safeParse({ ...validAdvance, recovery_pct: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a recovery percentage above 100', () => {
    const result = advanceSchema.safeParse({ ...validAdvance, recovery_pct: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects a missing paid_on date', () => {
    const result = advanceSchema.safeParse({ ...validAdvance, paid_on: '' });
    expect(result.success).toBe(false);
  });
});

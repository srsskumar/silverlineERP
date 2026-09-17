import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldLabel, toFieldErrors, validationSummary } from './errors.js';

/**
 * The words a person sees when they get something wrong.
 *
 * Zod's own messages describe the schema — "Invalid uuid", "Expected number,
 * received string", "Required". They are accurate, and they are useless to
 * somebody looking at a form, which is who reads them.
 */

const problems = (schema: z.ZodTypeAny, value: unknown) => {
  const r = schema.safeParse(value);
  if (r.success) throw new Error('expected that to fail');
  return toFieldErrors(r.error);
};

describe('naming a field the way a person would', () => {
  it('uses the label on the form, not the column in the table', () => {
    expect(fieldLabel('survey_village_id')).toBe('Village');
    expect(fieldLabel('date_of_joining')).toBe('Date of joining');
    expect(fieldLabel('emp_no')).toBe('Employee number');
  });

  it('works out something readable for a field nobody listed', () => {
    // The list cannot cover every field in eight modules, and a fallback that
    // prints the column name is the thing being fixed.
    expect(fieldLabel('warranty_expires_on')).toBe('Warranty expires on');
    expect(fieldLabel('vendor_id')).toBe('Vendor');
  });

  it('counts rows the way the person looking at the spreadsheet counts them', () => {
    // Row 0 is a programmer's row. Theirs starts at 1.
    expect(fieldLabel('rows.3.phone')).toBe('Phone on row 4');
  });

  it('names the measure rather than the path to it', () => {
    expect(fieldLabel('values.GOVT_LAND_EXTENT_AC')).toBe('GOVT_LAND_EXTENT_AC');
  });
});

describe('saying what is actually wrong', () => {
  it('says a missing field is required, by name', () => {
    const [p] = problems(z.object({ first_name: z.string() }), {});
    expect(p.message).toBe('First name is required');
  });

  it('does not say "Invalid uuid" to somebody who has never seen one', () => {
    const [p] = problems(z.object({ survey_village_id: z.string().uuid() }),
      { survey_village_id: 'abc' });
    expect(p.message).toBe('Village is not a valid reference');
  });

  it('says a number is a number', () => {
    const [p] = problems(z.object({ salary_basic: z.number() }), { salary_basic: '35000' });
    expect(p.message).toBe('Basic salary must be a number');
  });

  it('says how long is too long, in characters', () => {
    const [p] = problems(z.object({ name: z.string().max(10) }), { name: 'x'.repeat(40) });
    expect(p.message).toContain('too long');
    expect(p.message).toContain('10');
  });

  it('says which values an enum will take', () => {
    const [p] = problems(z.object({ gender: z.enum(['MALE', 'FEMALE', 'OTHER']) }),
      { gender: 'M' });
    expect(p.message).toBe('Gender must be one of: MALE, FEMALE, OTHER');
  });

  it('says an empty box is empty rather than too small', () => {
    const [p] = problems(z.object({ village_name: z.string().min(1) }), { village_name: '' });
    expect(p.message).toBe('Village name cannot be empty');
  });

  it('leaves a message somebody wrote on purpose exactly as written', () => {
    // The whole value of a hand-written message is that it says the domain
    // thing. Rewriting it into a generic sentence would lose that.
    const schema = z.object({ qty: z.number().min(0, 'A quantity cannot be negative') });
    const [p] = problems(schema, { qty: -5 });
    expect(p.message).toBe('A quantity cannot be negative');
  });
});

describe('the headline above the list', () => {
  it('says the problem when there is only one', () => {
    const one = problems(z.object({ first_name: z.string() }), {});
    expect(validationSummary(one)).toBe('First name is required');
  });

  it('says how many there are when there are several', () => {
    // So nobody fixes the first one and resubmits into the same wall.
    const several = problems(
      z.object({ first_name: z.string(), phone: z.string(), date_of_joining: z.string() }), {});
    expect(validationSummary(several)).toBe('3 things need fixing before this can be saved');
  });

  it('still says something when the list is empty', () => {
    expect(validationSummary([])).toBe('Check the details and try again');
  });
});

import { describe, expect, it } from 'vitest';
import { addMoney, lineAmount, percentOf } from './money-exact.js';

describe('exact line money (D-010)', () => {
  it('rounds a true half paisa up, where the float product sits just below it', () => {
    expect(lineAmount(0.5, 4.35)).toBe(2.18);
    expect(lineAmount(0.3, 2.15)).toBe(0.65);
    expect(lineAmount(12.5, 4.35)).toBe(54.38);
    expect(percentOf(2.25, 18)).toBe(0.41);
  });

  it('keeps every paisa on amounts far past Rs 1e10', () => {
    // toPrecision(12) returned 123456789012.35 for this; the exact value is .345 -> .35
    // and for the one below it dropped the paise altogether.
    expect(lineAmount(1, 98765432109.87)).toBe(98765432109.87);
    expect(lineAmount(3, 33333333333.33)).toBe(99999999999.99);
    expect(addMoney(98765432109.87, 0.01, 0.02)).toBe(98765432109.9);
  });

  it('rounds negatives half away from zero, like NUMERIC', () => {
    expect(lineAmount(-0.5, 4.35)).toBe(-2.18);
  });
});

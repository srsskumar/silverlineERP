import { describe, expect, it } from 'vitest';
import { day, dayTime, maybeDay, looksLikeDate } from './dates.js';

describe('day', () => {
  it('writes DD-MMM-YYYY', () => {
    expect(day('2026-09-21')).toBe('21-Sep-2026');
    expect(day('2026-01-01T00:00:00.000Z')).toBe('01-Jan-2026');
  });

  it('is the same string for everybody, whatever their machine thinks', () => {
    // A UTC instant that is already tomorrow in India.
    expect(day('2026-09-21T19:30:00.000Z')).toBe('22-Sep-2026');
  });

  it('says so plainly when there is no date', () => {
    expect(day(null)).toBe('—');
    expect(day('')).toBe('—');
    expect(day('not a date')).toBe('—');
  });
});

describe('dayTime', () => {
  it('adds the hour, in twenty-four, marked IST', () => {
    expect(dayTime('2026-09-21T05:33:00.000Z')).toBe('21-Sep-2026 11:03 IST');
  });

  it('renders midnight as 00, not 24', () => {
    expect(dayTime('2026-09-20T18:30:00.000Z')).toBe('21-Sep-2026 00:00 IST');
  });
});

describe('maybeDay', () => {
  it('formats a bare date as a date', () => {
    expect(maybeDay('2026-09-21')).toBe('21-Sep-2026');
  });

  it('formats an instant with its time', () => {
    expect(maybeDay('2026-09-21T05:33:00.000Z')).toBe('21-Sep-2026 11:03 IST');
    expect(maybeDay('2026-09-21T05:33:00Z')).toBe('21-Sep-2026 11:03 IST');
    expect(maybeDay('2026-09-21 05:33:00+00:00')).toBe('21-Sep-2026 11:03 IST');
  });

  it('leaves anything that is not a date exactly as it was', () => {
    /*
     * The reason this is strict. A generic table is handed whatever the row
     * contains, and mangling a code or a reference into a date would be a
     * worse bug than the one this fixes.
     */
    for (const value of [
      'PRJ-2026-001', '90158030', '2026', '18', 'ACTIVE',
      '2026-09', '2026-9-21', '21-09-2026', '1500.00',
    ]) {
      expect(maybeDay(value), value).toBe(value);
    }
  });

  it('renders nothing as an em dash, the way every other cell does', () => {
    expect(maybeDay(null)).toBe('—');
    expect(maybeDay(undefined)).toBe('—');
  });

  it('passes numbers and booleans through as text', () => {
    expect(maybeDay(42)).toBe('42');
    expect(maybeDay(true)).toBe('true');
  });
});

describe('looksLikeDate', () => {
  it('knows the two shapes this API sends', () => {
    expect(looksLikeDate('2026-09-21')).toBe(true);
    expect(looksLikeDate('2026-09-21T05:33:00.000Z')).toBe(true);
    expect(looksLikeDate(new Date())).toBe(true);
  });

  it('is not fooled by a number that starts like a year', () => {
    expect(looksLikeDate('2026')).toBe(false);
    expect(looksLikeDate('2026-09')).toBe(false);
    expect(looksLikeDate(20260921)).toBe(false);
  });
});

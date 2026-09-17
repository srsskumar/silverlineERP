import { describe, expect, it } from 'vitest';
import { employeeImportRow, spreadsheetDate } from './s1.js';

describe('a spreadsheet row on its way to the employee importer', () => {
  it('drops empty cells rather than sending them as empty strings', () => {
    /*
     * The reported failure: a blank second phone number failed the phone
     * format. An empty cell means "not given", not "given as nothing".
     */
    const row = employeeImportRow({
      first_name: 'Anitha', phone_secondary: '', email: '   ', address: '',
    }) as Record<string, unknown>;
    expect('phone_secondary' in row).toBe(false);
    expect('email' in row).toBe(false);
    expect('address' in row).toBe(false);
    expect(row.first_name).toBe('Anitha');
  });

  it('reads numbers that arrived as text, commas and symbols included', () => {
    const row = employeeImportRow({
      salary_basic: '35000', experience_years: '6',
    }) as Record<string, unknown>;
    expect(row.salary_basic).toBe(35000);
    expect(row.experience_years).toBe(6);

    const typed = employeeImportRow({ salary_basic: '₹35,000' }) as Record<string, unknown>;
    expect(typed.salary_basic).toBe(35000);
  });

  it('splits a skills cell into the list the schema wants', () => {
    expect((employeeImportRow({ skills: 'Survey;AutoCAD; QGIS' }) as any).skills)
      .toEqual(['Survey', 'AutoCAD', 'QGIS']);
    expect((employeeImportRow({ skills: 'Survey, AutoCAD' }) as any).skills)
      .toEqual(['Survey', 'AutoCAD']);
  });

  it('leaves a value it cannot convert alone, so the schema reports it', () => {
    // Silently dropping a bad value would import the row with a field
    // missing and tell nobody.
    const row = employeeImportRow({ salary_basic: 'about forty' }) as Record<string, unknown>;
    expect(row.salary_basic).toBe('about forty');
  });
});

describe('dates as a spreadsheet gives them', () => {
  it('converts an Excel serial number', () => {
    // Excel hands over a day count, so a date of birth arrives as 33078.
    expect(spreadsheetDate(33078)).toBe('1990-07-24');
  });

  it('compensates for the leap year 1900 never had', () => {
    /*
     * Excel treats 1900 as a leap year. Serial 60 is its phantom 29 February;
     * 61 is 1 March 1900. An epoch that ignores this puts every date after
     * February 1900 one day out.
     */
    expect(spreadsheetDate(61)).toBe('1900-03-01');
    expect(spreadsheetDate(1)).toBe('1900-01-01');
  });

  it('passes an already-correct date straight through', () => {
    expect(spreadsheetDate('1990-07-24')).toBe('1990-07-24');
  });

  it('reads the order people write dates in here', () => {
    // A sheet typed by hand in India uses DD/MM/YYYY, and rejecting the row
    // teaches nobody anything.
    expect(spreadsheetDate('24/07/1990')).toBe('1990-07-24');
    expect(spreadsheetDate('24-07-1990')).toBe('1990-07-24');
    expect(spreadsheetDate('4/7/1990')).toBe('1990-07-04');
  });

  it('does not guess at American order', () => {
    // 03/04/2026 is the fourth of March here, and reading it as 3 April
    // would silently move somebody's date of joining by a month.
    expect(spreadsheetDate('03/04/2026')).toBe('2026-04-03');
  });

  it('returns nothing for a blank or unreadable cell', () => {
    expect(spreadsheetDate('')).toBeUndefined();
    expect(spreadsheetDate(null)).toBeUndefined();
    expect(spreadsheetDate('last Tuesday')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { IMPORT_TEMPLATES, templateCsv } from '../lib/import-templates';
import { parseEmployeeCsv } from '../lib/csv';

/**
 * A template nobody can actually upload is worse than none: it sends the user
 * round a loop of validation errors while looking authoritative.
 */
describe('import templates', () => {
  it('gives every template a distinct key and a distinct file name', () => {
    // Pinning the exact list here only compared this file to itself and had
    // to be edited every time a format was added. What actually matters is
    // that two templates cannot collide: a shared key makes one
    // unreachable, and a shared file name overwrites the other on download.
    const keys = IMPORT_TEMPLATES.map((t) => t.key);
    const files = IMPORT_TEMPLATES.map((t) => t.fileName);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(files).size).toBe(files.length);
    expect(keys).toContain('employees');
  });

  it('gives every column an example value', () => {
    // A header with no example leaves the reader guessing at exactly the
    // formats they most need to see.
    for (const t of IMPORT_TEMPLATES) {
      expect(t.example, `${t.key} example`).toHaveLength(t.headers.length);
    }
  });

  it('includes every required column in the header row', () => {
    for (const t of IMPORT_TEMPLATES) {
      for (const r of t.required) expect(t.headers, `${t.key}`).toContain(r);
    }
  });

  it('produces a CSV the employee importer actually accepts', () => {
    // The point of the template: round-trip it through the real parser rather
    // than trusting that the columns look right.
    const employees = IMPORT_TEMPLATES.find((t) => t.key === 'employees')!;
    const parsed = parseEmployeeCsv(templateCsv(employees));
    expect(parsed.parseErrors).toHaveLength(0);
    expect(parsed.rows).toHaveLength(1);
    // No emp_no column: the server allocates the number, so the sheet does
    // not ask anybody to invent a unique identifier two hundred times.
    expect(parsed.rows[0].emp_no).toBeUndefined();
    expect(employees.headers).not.toContain('emp_no');
    expect(parsed.rows[0].first_name).toBe('Anitha');
    // Dates land as written, in the form the server expects.
    expect(parsed.rows[0].date_of_birth).toBe('1990-07-24');
  });

  it('maps every template header to a field the parser recognises', () => {
    const employees = IMPORT_TEMPLATES.find((t) => t.key === 'employees')!;
    const parsed = parseEmployeeCsv(templateCsv(employees));
    expect(parsed.headers).toEqual(employees.headers);
  });

  it('quotes a value containing a comma', () => {
    const employees = IMPORT_TEMPLATES.find((t) => t.key === 'employees')!;
    // The example address has a comma in it; unquoted it would shift every
    // subsequent column by one and the whole row would be wrong.
    expect(templateCsv(employees)).toContain('"12 MG Road, Hyderabad"');
  });

  it('names a unique file per template', () => {
    const names = IMPORT_TEMPLATES.map((t) => t.fileName);
    expect(new Set(names).size).toBe(names.length);
  });
});

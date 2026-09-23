import { describe, expect, it } from 'vitest';
import { employeeOptionLabel, fullName, personDisplay, shortId } from '../lib/people';

/**
 * One way to print a person.
 *
 * The screens used to disagree: a truncated UUID on the leave list, a
 * username on delegations, a name with no employee number on tasks. These
 * pin the order of preference — name, then username, then the shortened id
 * — and what goes with it.
 */
describe('personDisplay', () => {
  it('prints the employee name with the number alongside', () => {
    expect(personDisplay({ first_name: 'Anita', last_name: 'Rao', emp_no: 'EMP-042' }))
      .toEqual({ text: 'Anita Rao', empNo: 'EMP-042', isId: false });
  });

  it('prefers an explicit name over the parts', () => {
    expect(personDisplay({ name: 'Anita Rao', first_name: 'A', last_name: 'R' }).text).toBe('Anita Rao');
  });

  it('falls back to the username for an account with no employee record', () => {
    expect(personDisplay({ username: 'admin', first_name: null, last_name: null }))
      .toEqual({ text: 'admin', empNo: null, isId: false });
  });

  it('falls back to the shortened id, and says so', () => {
    const id = '64634e67-6b51-4c1e-9a3e-0123456789ab';
    expect(personDisplay(null, id)).toEqual({ text: '64634e67…', empNo: null, isId: true });
    expect(personDisplay({ id })).toEqual({ text: '64634e67…', empNo: null, isId: true });
  });

  it('prints a dash when there is nothing at all', () => {
    expect(personDisplay(null, null).text).toBe('—');
    expect(personDisplay(undefined).text).toBe('—');
  });

  it('treats blank names as absent', () => {
    expect(personDisplay({ name: '  ', first_name: ' ', username: 'x' }).text).toBe('x');
  });
});

describe('fullName', () => {
  it('joins first and last, skipping what is missing', () => {
    expect(fullName({ first_name: 'Anita', last_name: null })).toBe('Anita');
    expect(fullName({ first_name: 'Anita', last_name: 'Rao' })).toBe('Anita Rao');
    expect(fullName(null)).toBe('');
  });
});

describe('shortId', () => {
  it('shortens a uuid and leaves a short code alone', () => {
    expect(shortId('64634e67-6b51-4c1e-9a3e-0123456789ab')).toBe('64634e67…');
    expect(shortId('EMP-042')).toBe('EMP-042');
    expect(shortId(null)).toBe('');
  });
});

describe('employeeOptionLabel', () => {
  it('reads "Name · EMP-NO · Designation"', () => {
    expect(employeeOptionLabel({ first_name: 'Anita', last_name: 'Rao', emp_no: 'EMP-042', designation: 'Surveyor' }))
      .toBe('Anita Rao · EMP-042 · Surveyor');
  });

  it('drops the parts the record has not got', () => {
    expect(employeeOptionLabel({ first_name: 'Anita', emp_no: 'EMP-042' })).toBe('Anita · EMP-042');
  });
});

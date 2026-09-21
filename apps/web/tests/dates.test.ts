/**
 * One date format, everywhere.
 *
 * The application rendered dates three ways at once: a locale-dependent
 * helper, raw toLocaleDateString calls, and ISO strings sliced out of an API
 * response. Two people comparing figures over the telephone were reading
 * different characters for the same day, and a screenshot in a report
 * disagreed with the screen it came from.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Imported the way every screen imports them, so the re-export is
// covered too — the implementation lives in @silverline/shared.
import { day, dayTime } from '@/lib/finance';

describe('day()', () => {
  it('renders DD-MMM-YYYY', () => {
    expect(day('2026-09-21')).toBe('21-Sep-2026');
    expect(day('2026-01-05')).toBe('05-Jan-2026');
    expect(day('2026-12-31')).toBe('31-Dec-2026');
  });

  it('spells the month, never numbers it', () => {
    // 03-04-2026 is the third of April to half the world and the fourth of
    // March to the other half. A survey programme run between an Indian
    // department and anybody's software is where that costs a day.
    expect(day('2026-04-03')).toBe('03-Apr-2026');
    expect(day('2026-04-03')).not.toMatch(/^\d\d-\d\d-/);
  });

  it('puts a bare date through the same clock as everything else', () => {
    /*
     * There is one path, not two. A bare date parses as UTC midnight and IST
     * is five and a half hours ahead, so it lands at 05:30 on the same day
     * and cannot slip backwards — the special case that used to sit here was
     * guarding against a reader west of Greenwich, and there is no such
     * reader.
     */
    expect(day('2026-09-21')).toBe('21-Sep-2026');
    expect(day('2026-01-01')).toBe('01-Jan-2026');
    expect(day('2026-12-31')).toBe('31-Dec-2026');
  });

  it('does not render a day that does not exist', () => {
    // The old special case read the string straight through and printed
    // "29-Feb-2026" for a year with no 29th of February.
    expect(day('2026-02-29')).toBe('01-Mar-2026');
  });

  it('reads a full timestamp, in IST', () => {
    expect(day('2026-09-21T10:30:00.000Z')).toBe('21-Sep-2026');
    // 20:00 UTC is already the next day in India, and the date has to say so.
    expect(day('2026-09-21T20:00:00.000Z')).toBe('22-Sep-2026');
  });

  it('gives a dash for nothing rather than inventing a date', () => {
    // An absent date is not the epoch, and "01-Jan-1970" is how a null gets
    // mistaken for a very old record.
    for (const empty of [null, undefined, '', 0]) {
      expect(day(empty), String(empty)).toBe('—');
    }
    expect(day('not a date')).toBe('—');
  });

  it('pads the day, so a column of them lines up', () => {
    expect(day('2026-09-05')).toBe('05-Sep-2026');
    expect(day('2026-09-05')).toHaveLength(11);
    expect(day('2026-09-15')).toHaveLength(11);
  });
});

describe('dayTime()', () => {
  it('adds a twenty-four hour clock, in IST, whatever the reader\'s clock says', () => {
    /*
     * The instant below is 11:00 UTC, which is 16:30 in India. Rendering it
     * in the reader's own timezone puts a project manager in London five and
     * a half hours behind the work.
     */
    expect(dayTime('2026-09-21T11:00:00.000Z')).toBe('21-Sep-2026 16:30 IST');
    // And across midnight IST: 20:00 UTC is 01:30 the next morning in India.
    expect(dayTime('2026-09-21T20:00:00.000Z')).toBe('22-Sep-2026 01:30 IST');
  });

  it('says which clock it is, so nobody has to wonder', () => {
    expect(dayTime('2026-09-21T11:00:00.000Z')).toMatch(/ IST$/);
  });

  it('gives a dash for nothing', () => {
    expect(dayTime(null)).toBe('—');
    expect(dayTime('rubbish')).toBe('—');
  });
});

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '.next-verify', 'dist', 'android', 'ios',
      'tests', 'tests-dom'].includes(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('one clock, no settings', () => {
  it('has no per-user timezone anywhere', () => {
    /*
     * The phone's home screen used to compute "today" from the account's own
     * timezone, falling back to Asia/Kolkata. A profile set to anything else
     * gave that person a different today from the crew standing in the
     * village — and the day a return is filed against is the crew's.
     */
    const offenders: string[] = [];
    const roots = [
      fileURLToPath(new URL('../', import.meta.url)),
      fileURLToPath(new URL('../../mobile/', import.meta.url)),
    ];
    for (const root of roots) {
      for (const file of sources(root)) {
        if (file.includes('/tests')) continue;
        const body = readFileSync(file, 'utf8');
        /*
         * Captured and compared, not matched with a negative lookahead. The
         * lookahead version passed every file: `\s*` backtracks to a
         * position where the thing it was told to reject is no longer
         * directly ahead of it, and the assertion quietly became "does this
         * file contain the word timeZone".
         */
        for (const m of body.matchAll(/timeZone\s*:\s*([^,\n}]+)/g)) {
          const value = m[1].trim().replace(/['"]/g, '');
          if (value !== 'Asia/Kolkata' && value !== 'DISPLAY_TIME_ZONE') {
            offenders.push(`${file.split(root)[1] ?? file}: ${value.slice(0, 40)}`);
          }
        }
      }
    }
    expect(offenders, 'every timeZone must be Asia/Kolkata:\n'
      + offenders.join('\n')).toEqual([]);
  });
});

describe('one formatter, not three', () => {
  /*
   * The application rendered dates three ways at once and nobody noticed,
   * because each one looked reasonable on its own screen. This walks the
   * source instead of trusting that: a date formatted anywhere but
   * lib/finance is a fourth format waiting to happen.
   */
  // fileURLToPath, not URL.pathname: this repository's own directory has a
  // space in its name, and a percent-encoded path fails to stat.
  const SOURCE = fileURLToPath(new URL('../', import.meta.url));

  it('formats dates in exactly one place', () => {
    const offenders: string[] = [];
    for (const file of sources(SOURCE)) {
      // The formatter itself is allowed to know how dates are spelled.
      if (file.endsWith('/lib/finance.ts')) continue;
      const body = readFileSync(file, 'utf8');
      /*
       * Dates only. `toLocaleString` is also how this application formats
       * numbers — "1,23,456" in the Indian grouping — and flagging those
       * would make the guard noise somebody switches off. A date is a
       * toLocaleDateString, or a toLocaleString carrying calendar options.
       */
      const dateish = new RegExp(
        'toLocaleDateString\\s*\\('
        + '|toLocaleString\\s*\\([^)]*\\b(?:year|month|day|hour|minute|dateStyle|timeStyle)\\s*:',
        'g');
      for (const m of body.matchAll(dateish)) {
        offenders.push(`${file.split(SOURCE)[1] ?? file}: ${m[0].trim().slice(0, 60)}`);
      }
    }
    expect(offenders, 'format dates through day()/dayTime() in @/lib/finance:\n'
      + offenders.join('\n')).toEqual([]);
  });
});

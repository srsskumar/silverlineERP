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

  it('does not shift a bare date into the reader\'s timezone', () => {
    /*
     * "2026-09-21" is a calendar date, not an instant. Parsing it as UTC and
     * printing it locally shows the day before for anybody west of
     * Greenwich — which is how a return filed on the 21st appears on the
     * 20th to somebody in London.
     */
    expect(day('2026-09-21')).toBe('21-Sep-2026');
    expect(day('2026-01-01')).toBe('01-Jan-2026');
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

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', '.next-verify', 'tests', 'tests-dom'].includes(entry)
        || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

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

/**
 * How this system writes a date. One answer, for every screen it has.
 *
 * In `shared` rather than in the web app because the phone renders dates too,
 * and a crew reading "2026-09-21" on a handset while the office reads
 * "21-Sep-2026" for the same return is the same inconsistency wearing a
 * different coat.
 */

/** The months, spelled the way the whole application spells them. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * The clock this business runs on. The only one.
 *
 * Every date in this system is an Indian working day: a return is filed on
 * the day the crew walked the village, a claim goes out on the date on the
 * covering letter, attendance is a punch in a mandal office. Every reader is
 * in the same country as the work.
 *
 * So there is one clock and no local fallback anywhere — the server computes
 * the business day in Asia/Kolkata and this renders it in Asia/Kolkata, and
 * nothing in between asks the machine what time it thinks it is.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Kolkata';

/** The calendar parts of an instant, as they read in India. */
function istParts(d: Date): { day: string; month: number; year: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return {
    day: get('day'), month: Number(get('month')), year: get('year'),
    // 24-hour formatters render midnight as "24" in some engines.
    hour: get('hour') === '24' ? '00' : get('hour'),
    minute: get('minute'),
  };
}

/**
 * A date, as DD-MMM-YYYY. One format, everywhere.
 *
 * Written out rather than handed to toLocaleDateString, which takes the
 * *reader's* locale: the same row renders "21 Sept 2026" for one person and
 * "Sep 21, 2026" for another, and a screenshot in a report then disagrees
 * with the screen it was taken from. Two people comparing figures over the
 * telephone should be reading the same characters.
 *
 * The month is spelled, never numbered. 03-04-2026 is the third of April to
 * half the world and the fourth of March to the other half, and a survey
 * programme run between an Indian department and anybody's software is
 * exactly where that costs a day.
 *
 * Everything goes through the same clock — a bare "2026-09-21" as much as a
 * full timestamp. There used to be a special case here that took a bare date
 * at face value, guarding against a reader west of Greenwich seeing the day
 * before. Nobody here is west of Greenwich: this is an Indian programme read
 * by Indian offices, and IST is five and a half hours *ahead* of UTC, so a
 * bare date parsed as UTC midnight lands at 05:30 on the same day and can
 * never slip backwards. The branch defended against nothing and cost a
 * second code path.
 *
 * Removing it also stopped an impossible date being rendered as though it
 * were real: the old branch read "2026-02-29" straight out of the string and
 * printed "29-Feb-2026" for a day that does not exist. The single path
 * normalises it the way the rest of the system does.
 */
export function day(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '—';
  const p = istParts(d);
  const month = MONTHS[p.month - 1];
  return month ? `${p.day}-${month}-${p.year}` : '—';
}

/**
 * A date and a time, as DD-MMM-YYYY HH:MM IST.
 *
 * For the places where the hour matters — when a dashboard was drawn, when
 * somebody asked a question. Twenty-four hour, because "4:30" with no marker
 * is a fifty-fifty guess, and labelled IST so nobody has to wonder whose
 * afternoon it was.
 */
export function dayTime(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '—';
  const p = istParts(d);
  const month = MONTHS[p.month - 1];
  if (!month) return '—';
  return `${p.day}-${month}-${p.year} ${p.hour}:${p.minute} IST`;
}

/*
 * Bare date, or an instant. The API sends both, on the same row.
 *
 * A DATE column comes back as "2026-09-21"; a TIMESTAMPTZ comes back as
 * "2026-09-21T05:33:00.000Z". Deliberately strict: a code, an amount or a
 * reference that happens to contain digits must pass through untouched, so
 * these match the whole string and nothing less.
 */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** True when a value is a date or timestamp as this API sends them. */
export function looksLikeDate(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== 'string') return false;
  return BARE_DATE.test(value) || INSTANT.test(value);
}

/**
 * Format a value if it is a date, and leave it alone if it is not.
 *
 * For generic tables that are handed whatever a row contains and have no
 * column-by-column knowledge of it. Those were rendering raw ISO strings --
 * "2026-09-21T05:33:00.000Z" in a cell headed "Assigned on" -- because
 * String() is the honest thing to do with an unknown value and the wrong
 * thing to do with this one.
 *
 * A bare date gets the date. An instant gets the time as well, because a
 * timestamp column is a timestamp column for a reason: somebody wanted to
 * know when, not just which day.
 */
export function maybeDay(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return dayTime(value);
  if (typeof value === 'string') {
    if (BARE_DATE.test(value)) return day(value);
    if (INSTANT.test(value)) return dayTime(value);
  }
  return String(value);
}

/**
 * Just the clock, as HH:MM in IST.
 *
 * For a column that sits next to the date it belongs to -- a punch-in beside
 * its work date -- where repeating "21-Sep-2026" in every cell of every row
 * is noise rather than information. Twenty-four hour, for the same reason
 * dayTime is: "4:30" with no marker is a fifty-fifty guess.
 */
export function clock(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '—';
  const p = istParts(d);
  return `${p.hour}:${p.minute}`;
}

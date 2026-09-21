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
 * The clock this business runs on.
 *
 * Every date in this system is an Indian working day: a return is filed on
 * the day the crew walked the village, a claim goes out on the date on the
 * covering letter, attendance is a punch in a mandal office. Rendering those
 * in the reader's own timezone puts a project manager in London five and a
 * half hours behind the work, and shows a return filed at nine in the
 * morning as the previous evening.
 *
 * So the clock is fixed, not local. The server already computes the business
 * day in Asia/Kolkata; this is the same decision on the way back out.
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
 * A bare date — "2026-09-21" — is taken at face value and never put through
 * a timezone at all. It is a calendar date, not an instant, and converting
 * it would print the day before for anybody west of Greenwich.
 */
export function day(value: unknown): string {
  if (!value) return '—';
  const raw = String(value);
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (plain) {
    const month = MONTHS[Number(plain[2]) - 1];
    return month ? `${plain[3]}-${month}-${plain[1]}` : '—';
  }
  const d = new Date(raw);
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

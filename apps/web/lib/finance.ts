/**
 * Presentation helpers shared by the finance and procurement screens.
 *
 * These live in one module because six screens read the same figures, and a
 * rupee formatted two ways across two pages reads as two different systems.
 * They are pure so the rules that matter — what counts as overdue, when a
 * number is actually absent rather than zero — can be asserted without
 * mounting React.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 2,
});
const INR_COMPACT = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});

/**
 * A rupee figure, or an em dash when there is genuinely nothing there.
 *
 * Zero is a real amount and prints as zero — a nil receivable is information.
 * Only null, undefined and unparseable values become a dash, because those
 * mean "not recorded", which is a different statement.
 */
export function money(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? INR.format(n) : '—';
}

/** The same figure without paise, for headline cards and column totals. */
export function moneyShort(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? INR_COMPACT.format(n) : '—';
}

/**
 * Indian numbering for large figures — lakh and crore, not million.
 *
 * A site manager reading "₹1.2 Cr" understands it instantly; "₹12,000,000"
 * has to be counted. Used only where space is tight.
 */
export function moneyIndian(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return INR_COMPACT.format(n);
}

/*
 * Dates are formatted in @silverline/shared, so the phone and the desk spell
 * them the same way. Re-exported here because every screen in this app
 * already reaches for them through lib/finance.
 */
export { day, dayTime, clock, maybeDay, looksLikeDate, DISPLAY_TIME_ZONE } from '@silverline/shared';


/**
 * A percentage, or a dash when there is none.
 *
 * null is not zero here. A cost head with no budget has no utilisation, and
 * rendering that as "0%" reads as "nothing used" — the opposite of the truth,
 * which is that the figure cannot be computed at all.
 */
export function percent(value: unknown, digits = 1): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

/* ------------------------------------------------------------ approvals */

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  PURCHASE_REQUISITION: 'Requisition',
  PURCHASE_ORDER: 'Purchase order',
  VENDOR_INVOICE: 'Vendor invoice',
  EXPENSE_CLAIM: 'Expense claim',
  PAYMENT: 'Payment',
  RA_BILL: 'RA bill',
  TENDER_SUBMISSION: 'Tender submission',
  LEAVE_REQUEST: 'Leave request',
  ADVANCE: 'Advance',
  RETENTION_RELEASE: 'Retention release',
};

export function documentTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return DOCUMENT_TYPE_LABELS[type] ?? type.replaceAll('_', ' ').toLowerCase();
}

/** Where a document type's own screen lives, so an approval can link to it. */
export function documentHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'PURCHASE_REQUISITION': return `/procurement?kind=requisitions&open=${id}`;
    case 'PURCHASE_ORDER': return `/procurement?kind=orders&open=${id}`;
    case 'EXPENSE_CLAIM': return `/expenses?open=${id}`;
    case 'RA_BILL': return `/billing?open=${id}`;
    // Everything else has no screen yet. Returning null keeps the approval
    // readable rather than offering a link into a 404.
    default: return null;
  }
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Colour for a lifecycle status.
 *
 * Only outcomes get colour. Working states stay neutral so that a list of
 * fifty in-flight documents does not read as fifty alerts, and the three that
 * genuinely need attention are the ones the eye lands on.
 */
export function financialTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'APPROVED': case 'CERTIFIED': case 'RECEIVED': case 'REIMBURSED':
    case 'MATCHED': case 'CLOSED': case 'AWARDED': case 'ACKNOWLEDGED':
      return 'success';
    case 'REJECTED': case 'CANCELLED': case 'BLOCKED': case 'OVERDUE':
    case 'MISMATCH': case 'EXPIRED':
      return 'danger';
    case 'PENDING': case 'PENDING_APPROVAL': case 'SUBMITTED': case 'ESCALATED':
    case 'PARTIALLY_RECEIVED':
      return 'warning';
    case 'SENT': case 'CONVERTED': case 'SUPERSEDED': case 'IN_PROGRESS':
      return 'info';
    default:
      return 'neutral';
  }
}

/* ----------------------------------------------------------------- SLA */

export interface SlaState {
  /** Hours the step has been waiting, rounded down. */
  waitedHours: number;
  /** Null when the step carries no SLA, which is not the same as "on time". */
  remainingHours: number | null;
  breached: boolean;
  tone: Tone;
  label: string;
}

/**
 * How long an approval step has been sitting, against its SLA.
 *
 * A step with no SLA is reported as untimed rather than as healthy: a queue
 * showing green for steps nobody ever set a clock on is worse than showing
 * nothing, because it claims a guarantee that does not exist.
 */
export function slaState(
  pendingSince: string | null | undefined,
  slaHours: number | null | undefined,
  now: Date = new Date(),
): SlaState {
  if (!pendingSince) {
    return { waitedHours: 0, remainingHours: null, breached: false, tone: 'neutral', label: 'Not started' };
  }
  const started = new Date(String(pendingSince)).getTime();
  if (Number.isNaN(started)) {
    return { waitedHours: 0, remainingHours: null, breached: false, tone: 'neutral', label: 'Not started' };
  }
  const waitedHours = Math.max(0, Math.floor((now.getTime() - started) / 3_600_000));
  const waited = waitedHours < 24
    ? `${waitedHours}h`
    : `${Math.floor(waitedHours / 24)}d`;

  if (slaHours === null || slaHours === undefined) {
    return { waitedHours, remainingHours: null, breached: false, tone: 'neutral', label: `Waiting ${waited}` };
  }
  const remainingHours = slaHours - waitedHours;
  if (remainingHours < 0) {
    return {
      waitedHours, remainingHours, breached: true, tone: 'danger',
      label: `Overdue by ${Math.abs(remainingHours) < 24 ? `${Math.abs(remainingHours)}h` : `${Math.floor(Math.abs(remainingHours) / 24)}d`}`,
    };
  }
  // Inside the last quarter of the window is where a nudge still changes the
  // outcome; earlier than that it is just noise.
  const tone: Tone = remainingHours <= slaHours * 0.25 ? 'warning' : 'success';
  return { waitedHours, remainingHours, breached: false, tone, label: `${remainingHours}h left` };
}

/* ------------------------------------------------------------- budgets */

/**
 * The bar width for a cost head, capped so an overrun stays readable.
 *
 * An unbudgeted head consuming money has no meaningful percentage, so it
 * returns null and the caller shows the figure instead of a misleading
 * full bar.
 */
export function utilisationWidth(forecast: number, budgeted: number): number | null {
  if (!Number.isFinite(budgeted) || budgeted <= 0) return null;
  return Math.min(100, Math.max(0, (forecast / budgeted) * 100));
}

/* ------------------------------------------------------------ expenses */

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  TRAVEL: 'Travel',
  LODGING: 'Lodging',
  FUEL: 'Fuel',
  PER_DIEM: 'Per diem',
  SITE_MATERIALS_PETTY: 'Site materials (petty)',
  CLIENT_ENTERTAINMENT: 'Client entertainment',
  COMMUNICATION: 'Communication',
  OTHER: 'Other',
};

export function categoryLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return EXPENSE_CATEGORY_LABELS[code] ?? code.replaceAll('_', ' ').toLowerCase();
}

/**
 * Plain-English reason a line carries no input credit.
 *
 * The API returns a code; finance staff need the sentence, because "blocked
 * under s.17(5)" is the answer to the question they will actually be asked.
 */
export function creditBlockLabel(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'BLOCKED_SECTION_17_5': return 'Blocked credit under s.17(5) CGST';
    case 'NO_GSTIN_ON_BILL': return 'No supplier GSTIN on the bill';
    case 'PLACE_OF_SUPPLY_UNREGISTERED': return 'Supplied in a state with no registration';
    default: return null;
  }
}

/**
 * Re-exported from @silverline/shared rather than kept as a second, hand
 * copied list here: this file's own copy had drifted (missing DD and
 * ADJUSTMENT — R5 parity finding), which is exactly what a second list of
 * the same instruments always ends up doing.
 */
export { PAYMENT_MODES } from '@silverline/shared';

/**
 * Today, where the work happens.
 *
 * `new Date().toISOString()` is UTC, and for the first five and a half hours
 * of every Indian day that is yesterday. A crew opening the daily progress
 * form at nine in the morning would find it defaulted to the day before, and
 * most would simply file it.
 *
 * The browser's own timezone is not used: a manager travelling would
 * otherwise see different dates from the crew, and the figures are the
 * organisation's, not the reader's.
 */
export function businessToday(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

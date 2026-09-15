import { money } from './finance';

/**
 * Presentation for the receivables and payables ledgers (section 58).
 *
 * The ageing buckets and their labels live here rather than in each page
 * because the two ledgers must show the same buckets in the same order. An AR
 * screen bucketing at 30/60/90 beside an AP screen bucketing at 15/30/45 is
 * the kind of inconsistency that makes somebody distrust both numbers.
 */

export const AGEING_BUCKETS = ['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const BUCKET_LABELS: Record<AgeingBucket, string> = {
  NOT_DUE: 'Not yet due',
  D1_30: '1 to 30 days',
  D31_60: '31 to 60 days',
  D61_90: '61 to 90 days',
  OVER_90: 'Over 90 days',
};

/**
 * How alarming a bucket is.
 *
 * Deliberately graded rather than binary: money one day late and money four
 * months late are both "overdue", and colouring them the same removes the
 * only signal that says which to chase first.
 */
export function bucketTone(bucket: AgeingBucket): 'default' | 'warning' | 'danger' {
  if (bucket === 'NOT_DUE') return 'default';
  if (bucket === 'D1_30' || bucket === 'D31_60') return 'warning';
  return 'danger';
}

export interface AgeingSummary {
  buckets: Record<AgeingBucket, number>;
  undated: number;
  disputed: number;
  retention: number;
  onHold: number;
  total: number;
  overdue: number;
}

/**
 * The buckets as proportions, for the stacked bar.
 *
 * Only the aged buckets are shown. Retention and disputes are excluded from
 * the bar for the same reason they are excluded from the buckets themselves:
 * neither is late, and neither is collectable by chasing.
 */
export function bucketBars(summary: AgeingSummary): Array<{
  bucket: AgeingBucket; amount: number; pct: number; tone: ReturnType<typeof bucketTone>;
}> {
  const aged = AGEING_BUCKETS.reduce((t, b) => t + (summary.buckets[b] ?? 0), 0);
  return AGEING_BUCKETS
    .map((bucket) => ({
      bucket,
      amount: summary.buckets[bucket] ?? 0,
      pct: aged > 0 ? ((summary.buckets[bucket] ?? 0) / aged) * 100 : 0,
      tone: bucketTone(bucket),
    }))
    .filter((b) => b.amount > 0.005);
}

/**
 * What a DSO figure means in words.
 *
 * A bare number invites the reader to supply their own benchmark, and in
 * construction the honest answer depends on the contract. Naming the window
 * it was measured over is the part that stops it being misread.
 */
export function dsoNote(dso: number | null, periodDays: number): string {
  if (dso === null) return `No certified billing in the last ${periodDays} days to measure against.`;
  return `Measured over ${periodDays} days. Collection is taking about ${Math.round(dso)} days from certification.`;
}

/** Why an invoice was kept out of a payment run, in words the user can act on. */
export const EXCLUSION_REASONS: Record<string, string> = {
  DISPUTED: 'Under dispute',
  ON_HOLD: 'On hold',
  MATCH_FAILED: 'Three-way match has not passed',
  NOT_DUE: 'Not due within the window',
  NOTHING_OUTSTANDING: 'Nothing left outstanding',
};

export function exclusionReason(code: string | null | undefined): string {
  return EXCLUSION_REASONS[String(code)] ?? String(code ?? 'Excluded');
}

/**
 * The MSME position stated as a sentence.
 *
 * Interest under section 16 of the MSMED Act accrues whether or not anybody
 * records it, and it is not deductible for income tax. A screen that shows
 * the principal and stays silent about the interest understates a real
 * liability, so this line is shown even when the amount is zero.
 */
export function msmeNote(outstanding: number, interest: number): string {
  if (outstanding <= 0.005) return 'Nothing outstanding to a registered MSME supplier.';
  const base = `${money(outstanding)} is owed to registered MSME suppliers.`;
  if (interest <= 0.005) return `${base} Nothing has run past its statutory due date yet.`;
  return `${base} ${money(interest)} of interest has accrued under section 16 of the MSMED Act, `
    + 'compounded monthly at three times the RBI bank rate. It is payable whether or not the '
    + 'supplier asks for it, and it is not deductible for income tax.';
}

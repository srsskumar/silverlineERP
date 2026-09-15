import { describe, expect, it } from 'vitest';
import {
  AGEING_BUCKETS, BUCKET_LABELS, bucketBars, bucketTone, dsoNote,
  exclusionReason, msmeNote, type AgeingSummary,
} from '../lib/ledgers';
import { NAV_GROUPS } from '../lib/nav';

const summary = (over: Partial<AgeingSummary> = {}): AgeingSummary => ({
  buckets: { NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 },
  undated: 0, disputed: 0, retention: 0, onHold: 0, total: 0, overdue: 0,
  ...over,
});

describe('ageing buckets', () => {
  it('labels every bucket', () => {
    for (const bucket of AGEING_BUCKETS) {
      expect(BUCKET_LABELS[bucket], bucket).toBeTruthy();
    }
  });

  it('grades lateness rather than treating it as binary', () => {
    // One day late and four months late are both overdue; colouring them the
    // same removes the only signal that says which to chase first.
    expect(bucketTone('NOT_DUE')).toBe('default');
    expect(bucketTone('D1_30')).toBe('warning');
    expect(bucketTone('D31_60')).toBe('warning');
    expect(bucketTone('D61_90')).toBe('danger');
    expect(bucketTone('OVER_90')).toBe('danger');
  });
});

describe('bucketBars', () => {
  it('splits the bar in proportion to the aged buckets', () => {
    const bars = bucketBars(summary({
      buckets: { NOT_DUE: 300, D1_30: 100, D31_60: 0, D61_90: 0, OVER_90: 100 },
      total: 500,
    }));
    expect(bars.map((b) => b.bucket)).toEqual(['NOT_DUE', 'D1_30', 'OVER_90']);
    expect(bars.map((b) => Math.round(b.pct))).toEqual([60, 20, 20]);
  });

  it('leaves retention and disputes out of the bar', () => {
    // Neither is late, and neither is collectable by chasing. Including them
    // would make a fully-settled project look like an overdue balance.
    const bars = bucketBars(summary({ retention: 900, disputed: 400, total: 1300 }));
    expect(bars).toEqual([]);
  });

  it('does not divide by zero on an empty book', () => {
    expect(bucketBars(summary())).toEqual([]);
  });

  it('drops a bucket holding only rounding dust', () => {
    const bars = bucketBars(summary({
      buckets: { NOT_DUE: 100, D1_30: 0.001, D31_60: 0, D61_90: 0, OVER_90: 0 },
    }));
    expect(bars.map((b) => b.bucket)).toEqual(['NOT_DUE']);
  });
});

describe('dsoNote', () => {
  it('always names the window it was measured over', () => {
    // The same receivable gives a wildly different figure over a month and
    // over a year, so a bare number invites a wrong reading.
    expect(dsoNote(47.3, 90)).toContain('90 days');
    expect(dsoNote(47.3, 90)).toContain('47 days');
  });

  it('says why there is no figure rather than showing zero', () => {
    const note = dsoNote(null, 30);
    expect(note).toContain('No certified billing');
    // Not a zero DSO, which would read as "we collect the same day".
    expect(note).not.toMatch(/about \d+ days/);
  });
});

describe('msmeNote', () => {
  it('says plainly that nothing is owed when nothing is', () => {
    expect(msmeNote(0, 0)).toContain('Nothing outstanding');
  });

  it('reports the principal and notes nothing is late yet', () => {
    const note = msmeNote(250000, 0);
    expect(note).toContain('2,50,000');
    expect(note).toContain('statutory due date');
  });

  it('states the interest, its basis, and that it is not deductible', () => {
    // It accrues whether or not anybody records it, and understating it
    // understates a real liability.
    const note = msmeNote(250000, 4820);
    expect(note).toContain('4,820');
    expect(note).toContain('section 16');
    expect(note).toContain('not deductible');
    expect(note).toContain('three times the RBI bank rate');
  });
});

describe('exclusionReason', () => {
  it('explains every reason the API can give', () => {
    for (const code of ['DISPUTED', 'ON_HOLD', 'MATCH_FAILED', 'NOT_DUE', 'NOTHING_OUTSTANDING']) {
      expect(exclusionReason(code), code).not.toBe(code);
    }
  });

  it('shows an unknown code rather than swallowing it', () => {
    // A silently dropped invoice is how a supplier goes unpaid for a month
    // with nobody able to say why.
    expect(exclusionReason('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('navigation', () => {
  it('reaches both ledgers, each behind its own permission', () => {
    const items = NAV_GROUPS.flatMap((g) => g.items);
    const ar = items.find((i) => i.href === '/receivables');
    const ap = items.find((i) => i.href === '/payables');
    expect(ar?.permission).toBe('ar.read');
    expect(ap?.permission).toBe('ap.read');
  });
});

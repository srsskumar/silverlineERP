'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { money } from '@/lib/finance';
import {
  AGEING_BUCKETS, BUCKET_LABELS, bucketBars, bucketTone,
  type AgeingBucket, type AgeingSummary,
} from '@/lib/ledgers';

/**
 * The ageing profile of a balance, as a bar and a row of figures.
 *
 * The bar is there so the shape reads before any number does: a balance that
 * is mostly not-yet-due and one that is mostly over ninety days are the same
 * total and completely different problems.
 */
export function AgeingBar({ summary }: { summary: AgeingSummary }) {
  const bars = bucketBars(summary);
  if (!bars.length) return null;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
      {bars.map((b) => (
        <div
          key={b.bucket}
          style={{ width: `${b.pct}%` }}
          title={`${BUCKET_LABELS[b.bucket]}: ${money(b.amount)}`}
          className={cn(
            b.tone === 'danger' && 'bg-danger',
            b.tone === 'warning' && 'bg-warning',
            b.tone === 'default' && 'bg-success',
          )}
        />
      ))}
    </div>
  );
}

/**
 * Every bucket, including the empty ones.
 *
 * Empty buckets are shown rather than hidden: a missing "over 90 days" column
 * reads as an omission, where a column showing nothing is a positive
 * statement that there is nothing there.
 */
export function AgeingBuckets({ summary }: { summary: AgeingSummary }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {AGEING_BUCKETS.map((bucket) => {
        const amount = summary.buckets[bucket] ?? 0;
        const tone = bucketTone(bucket);
        return (
          <div key={bucket} className="rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-2xs uppercase tracking-wide text-text-subtle">
              {BUCKET_LABELS[bucket]}
            </p>
            <p className={cn(
              'mt-0.5 text-sm font-semibold tabular-nums',
              amount > 0.005 && tone === 'danger' && 'text-danger',
              amount > 0.005 && tone === 'warning' && 'text-warning',
              (amount <= 0.005 || tone === 'default') && 'text-text',
            )}>
              {money(amount)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * What sits outside the buckets.
 *
 * Retention is not late — it is held back by agreement until defects
 * liability ends — and a disputed amount is not collectable by chasing it.
 * Both are real balances, so they are shown; neither is aged, so they are
 * shown apart. Rolling them into the overdue figure is how a collections
 * report ends up chasing money nobody owes yet.
 */
export function OutsideBuckets({
  summary, extras,
}: {
  summary: AgeingSummary;
  extras?: Array<{ label: string; amount: number; note: string }>;
}) {
  const items = [
    summary.retention > 0.005 && {
      label: 'Retention held',
      amount: summary.retention,
      note: 'Held by agreement until defects liability ends. Not overdue.',
    },
    summary.disputed > 0.005 && {
      label: 'Disputed',
      amount: summary.disputed,
      note: 'Not aged while it is in dispute. Chasing it is not the next step.',
    },
    summary.onHold > 0.005 && {
      label: 'On hold',
      amount: summary.onHold,
      note: 'Held internally. Still owed, and still accruing any statutory interest.',
    },
    summary.undated > 0.005 && {
      label: 'No due date',
      amount: summary.undated,
      note: 'Cannot be aged until a due date is recorded.',
    },
    ...(extras ?? []),
  ].filter(Boolean) as Array<{ label: string; amount: number; note: string }>;

  if (!items.length) return null;
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="rounded-lg border border-border bg-surface-sunken px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-xs font-medium text-text">{i.label}</dt>
            <dd className="text-sm font-semibold tabular-nums text-text">{money(i.amount)}</dd>
          </div>
          <p className="mt-0.5 text-2xs text-text-subtle">{i.note}</p>
        </div>
      ))}
    </dl>
  );
}

/** One party's ageing, compact enough to sit in a table row. */
export function BucketCells({ summary }: { summary: AgeingSummary }) {
  return (
    <>
      {AGEING_BUCKETS.map((bucket: AgeingBucket) => {
        const amount = summary.buckets[bucket] ?? 0;
        const tone = bucketTone(bucket);
        return (
          <td
            key={bucket}
            className={cn(
              'px-3 py-2 text-right text-xs tabular-nums',
              amount <= 0.005 ? 'text-text-subtle' :
                tone === 'danger' ? 'font-semibold text-danger' :
                tone === 'warning' ? 'text-warning' : 'text-text',
            )}
          >
            {amount > 0.005 ? money(amount) : '—'}
          </td>
        );
      })}
    </>
  );
}

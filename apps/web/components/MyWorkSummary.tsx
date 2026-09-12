'use client';

import Link from '@/components/AppLink';
import type { MyWorkSummary } from '@/lib/dashboards';
import { ErrorCard } from './ui/ErrorCard';
import { Skeleton } from './ui/Skeleton';

/**
 * Count cards for the my-work summary payload (GET /dashboards/my-work):
 * assigned-open, overdue, pending leave approvals (+ exceptions), unread.
 * Links point at the S5/S6 surfaces that own each queue.
 */
export function MyWorkSummary({
  summary,
  isLoading,
  error,
  onRetry,
}: {
  summary?: MyWorkSummary | null;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading work summary">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-8 w-16" />
          </div>
        ))}
      </div>
    );
  }
  if (error) {
    return <ErrorCard title="Could not load work summary" error={error} onRetry={onRetry} />;
  }
  if (!summary) return null;
  const cards = [
    {
      title: 'Assigned open',
      value: summary.assigned_open,
      href: '/my-work',
      linkLabel: 'View tasks',
    },
    {
      title: 'Overdue mine',
      value: summary.assigned_overdue.length,
      href: '/my-work',
      linkLabel: 'View overdue',
    },
    {
      title: 'Pending leave approvals',
      value: summary.pending_approvals.leave.length,
      href: '/leave',
      linkLabel: 'Review leave',
      extra:
        summary.pending_approvals.exceptions_count > 0
          ? `${summary.pending_approvals.exceptions_count} attendance exception(s) awaiting decision`
          : null,
    },
    {
      title: 'Unread inbox',
      value: summary.unread_count,
      href: '/inbox',
      linkLabel: 'Open inbox',
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <div key={c.title} className="rounded-lg border border-border bg-surface p-4">
          <p className="text-sm font-medium text-text-muted">{c.title}</p>
          <p className="mt-2 text-2xl font-bold text-text">{c.value}</p>
          {c.extra ? <p className="mt-1 text-xs text-text-muted">{c.extra}</p> : null}
          <Link href={c.href} className="mt-2 inline-block text-sm text-primary hover:underline">
            {c.linkLabel} →
          </Link>
        </div>
      ))}
    </div>
  );
}

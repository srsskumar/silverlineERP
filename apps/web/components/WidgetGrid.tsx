'use client';

import Link from '@/components/AppLink';
import { widgetTone, type DashboardWidget } from '@/lib/dashboards';
import { ErrorCard } from './ui/ErrorCard';
import { Skeleton } from './ui/Skeleton';

const toneValueClass: Record<string, string> = {
  danger: 'text-danger',
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  neutral: 'text-text',
};

function formatValue(value: string | number): string {
  return typeof value === 'number' ? String(value) : value;
}

/**
 * One stat card: title, big number, optional link. A widget with a missing
 * title/key renders a per-widget error card so one bad row never kills the grid.
 */
export function WidgetCard({ widget }: { widget: DashboardWidget }) {
  const tone = widgetTone(widget.key);
  const body = (
    <>
      <p className="text-sm font-medium text-text-muted">{widget.title}</p>
      <p className={`mt-2 text-2xl font-bold ${toneValueClass[tone] ?? toneValueClass.neutral}`}>
        {formatValue(widget.value)}
      </p>
    </>
  );
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      {body}
      {widget.link ? (
        <Link href={widget.link} className="mt-2 inline-block text-sm text-primary hover:underline">
          View →
        </Link>
      ) : null}
    </div>
  );
}

function WidgetErrorCard({ index }: { index: number }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-warning/30 bg-warning-subtle p-4"
      title={`Widget at index ${index} was missing its title/key and was skipped`}
    >
      <p className="text-sm font-medium text-warning">Widget unavailable</p>
      <p className="mt-1 text-xs text-warning">This widget was missing its title and was skipped.</p>
    </div>
  );
}

/**
 * Stat-card grid for a role dashboard. Skeleton cells while loading; a query
 * failure renders one ErrorCard + Retry above an empty grid (the grid itself
 * never crashes on per-widget gaps — those become inline warning cards).
 */
export function WidgetGrid({
  widgets,
  rawCount,
  isLoading,
  error,
  onRetry,
}: {
  widgets: DashboardWidget[];
  /** Total rows received (including skipped ones) — drives per-widget error cells. */
  rawCount?: number;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading widgets">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-8 w-16" />
          </div>
        ))}
      </div>
    );
  }
  const skipped = Math.max(0, (rawCount ?? widgets.length) - widgets.length);
  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorCard title="Could not load dashboard widgets" error={error} onRetry={onRetry} /> : null}
      {widgets.length === 0 && !error ? (
        <p className="text-sm text-text-muted">No widgets in this template.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {widgets.map((w) => (
            <WidgetCard key={w.key} widget={w} />
          ))}
          {Array.from({ length: skipped }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <WidgetErrorCard key={`skipped-${i}`} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

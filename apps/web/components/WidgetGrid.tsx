'use client';

import Link from '@/components/AppLink';
import { widgetTone, type DashboardWidget } from '@/lib/dashboards';
import { ErrorCard } from './ui/ErrorCard';
import { Skeleton } from './ui/Skeleton';

const toneValueClass: Record<string, string> = {
  danger: 'text-red-700',
  info: 'text-brand-700',
  success: 'text-green-700',
  warning: 'text-amber-700',
  neutral: 'text-slate-900',
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
      <p className="text-sm font-medium text-slate-500">{widget.title}</p>
      <p className={`mt-2 text-2xl font-bold ${toneValueClass[tone] ?? toneValueClass.neutral}`}>
        {formatValue(widget.value)}
      </p>
    </>
  );
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      {body}
      {widget.link ? (
        <Link href={widget.link} className="mt-2 inline-block text-sm text-brand-600 hover:underline">
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
      className="rounded-lg border border-amber-200 bg-amber-50 p-4"
      title={`Widget at index ${index} was missing its title/key and was skipped`}
    >
      <p className="text-sm font-medium text-amber-800">Widget unavailable</p>
      <p className="mt-1 text-xs text-amber-700">This widget was missing its title and was skipped.</p>
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
          <div key={i} className="rounded-lg border border-slate-200 bg-white p-4">
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
        <p className="text-sm text-slate-500">No widgets in this template.</p>
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

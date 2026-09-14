'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './AuthProvider';
import { Skeleton } from './ui/Skeleton';
import {
  DASHBOARD_STALE_TIME,
  formatStat,
  listWidgets,
  selectDefaultTemplate,
  widgetTone,
} from '@/lib/dashboards';
import { queryKeys } from '@/lib/query-keys';

/**
 * Workforce-at-a-glance strip for board pages: headcount, presence and queue
 * counts from the viewer's default role template (adapts per role — a TL sees
 * team numbers, an admin org numbers). Compact chips; server caches 60s.
 */
export function WorkforceStrip({ dense = false }: { dense?: boolean } = {}) {
  const { session } = useAuth();
  const template = React.useMemo(
    () => selectDefaultTemplate(session?.roles ?? []),
    [session?.roles],
  );
  const widgetsQuery = useQuery({
    queryKey: template ? queryKeys.dashboard.dashboardRole(template) : ['dashboard', 'role', 'none'],
    queryFn: () => listWidgets(template as string),
    enabled: !!template,
    staleTime: DASHBOARD_STALE_TIME,
    retry: false,
  });
  const widgets = widgetsQuery.data?.widgets ?? [];

  if (!template) return null;

  // Dense: one hairline-separated row rather than a grid of cards. On the board
  // the numbers are context for the work below, not the subject of the page —
  // stacked cards pushed the first column of the board past the fold.
  if (dense) {
    return (
      <div
        aria-label="Workforce summary"
        className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-border bg-surface px-3 py-1.5"
      >
        {widgetsQuery.isLoading ? (
          <Skeleton className="h-4 w-full" />
        ) : widgetsQuery.isError || widgets.length === 0 ? (
          <p className="text-xs text-text-muted">Workforce numbers unavailable right now.</p>
        ) : (
          widgets.slice(0, 6).map((w) => (
            <span key={String(w.key)} className="flex items-baseline gap-1.5 text-xs">
              <span className="text-text-muted">{String(w.title)}</span>
              <span className={`font-semibold tabular-nums ${toneClass(widgetTone(w.key))}`}>
                {formatStat(w.value)}
              </span>
            </span>
          ))
        )}
      </div>
    );
  }

  return (
    <div aria-label="Workforce summary" className="flex flex-wrap items-stretch gap-2">
      {widgetsQuery.isLoading ? (
        <Skeleton className="h-14 w-full" />
      ) : widgetsQuery.isError || widgets.length === 0 ? (
        <p className="text-xs text-text-muted">Workforce numbers unavailable right now.</p>
      ) : (
        widgets.slice(0, 6).map((w) => (
          <div
            key={String(w.key)}
            className="min-w-28 flex-1 rounded-lg border border-border bg-surface px-3 py-2"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
              {String(w.title)}
            </p>
            <p className={`mt-0.5 text-lg font-bold ${toneClass(widgetTone(w.key))}`}>
              {formatStat(w.value)}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

function toneClass(tone: string): string {
  switch (tone) {
    case 'danger':
      return 'text-danger';
    case 'warning':
      return 'text-warning';
    case 'success':
      return 'text-success';
    case 'info':
      return 'text-primary';
    default:
      return 'text-text';
  }
}

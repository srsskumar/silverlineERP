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
export function WorkforceStrip() {
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
  return (
    <div aria-label="Workforce summary" className="flex flex-wrap items-stretch gap-2">
      {widgetsQuery.isLoading ? (
        <Skeleton className="h-14 w-full" />
      ) : widgetsQuery.isError || widgets.length === 0 ? (
        <p className="text-xs text-slate-500">Workforce numbers unavailable right now.</p>
      ) : (
        widgets.slice(0, 6).map((w) => (
          <div
            key={String(w.key)}
            className="min-w-28 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
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
      return 'text-red-700';
    case 'warning':
      return 'text-amber-700';
    case 'success':
      return 'text-green-700';
    case 'info':
      return 'text-brand-700';
    default:
      return 'text-slate-900';
  }
}

'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { listHolidays, type Holiday } from '@/lib/holidays';
import { queryKeys } from '@/lib/query-keys';
import { CreateHolidayDialog, EditHolidayDialog, HolidayStatusDialog } from '@/components/HolidayDialogs';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { day } from '@/lib/finance';

export const dynamic = 'force-static';

function HolidaysManager() {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, PERMISSIONS.HOLIDAY_MANAGE);
  const [year, setYear] = React.useState(new Date().getFullYear());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Holiday | null>(null);
  const [statusChange, setStatusChange] = React.useState<{ holiday: Holiday; targetActive: boolean } | null>(null);
  // Retired holidays are excluded by default (matches the calendar's own
  // "what applies now" view); a manager can look for one to reactivate.
  const [showRetired, setShowRetired] = React.useState(false);
  const includeInactive = canManage && showRetired;

  const holidaysQuery = useQuery({
    queryKey: queryKeys.holidays.list({ year, includeInactive }),
    queryFn: () => listHolidays({ year, includeInactive }),
    staleTime: 60_000,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <div>
          <FormField label="Year" htmlFor="hol-year">
            <Input
              id="hol-year"
              type="number"
              value={year}
              min={2000}
              max={2100}
              onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())}
              className="w-32"
            />
          </FormField>
        </div>
        {canManage && (
          <label className="flex items-center gap-2 pb-2 text-sm text-text-muted">
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
            Show retired holidays
          </label>
        )}
        <div className="ml-auto">{canManage && <Button onClick={() => setCreateOpen(true)}>New holiday</Button>}</div>
      </div>
      {holidaysQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : holidaysQuery.isError ? (
        <ErrorCard title="Could not load holidays" error={holidaysQuery.error} onRetry={() => holidaysQuery.refetch()} />
      ) : (holidaysQuery.data ?? []).length === 0 ? (
        <EmptyState title={`No holidays in ${year}`} description="Add the year's public and festival holidays." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border bg-surface text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Date</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Name</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Type</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Scope</th>
                {includeInactive && <th className="px-3 py-2 text-left font-medium text-text-muted">Status</th>}
                {canManage && <th className="px-3 py-2 text-left font-medium text-text-muted">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(holidaysQuery.data ?? []).map((h) => (
                <tr key={h.id}>
                  <td className="px-3 py-2 font-mono text-xs">{day(h.date)}</td>
                  <td className="px-3 py-2">{h.name}</td>
                  <td className="px-3 py-2">{h.type}</td>
                  <td className="px-3 py-2 text-text-muted">
                    {h.scope_type ? (
                      <span title={String(h.scope_id ?? '')}>
                        {h.scope_name ? `${h.scope_name} (${h.scope_type})` : `${h.scope_type} ${String(h.scope_id).slice(0, 8)}…`}
                      </span>
                    ) : 'Org-wide'}
                  </td>
                  {includeInactive && (
                    <td className="px-3 py-2">
                      {h.active === false ? <span className="text-text-muted">Retired</span> : 'Active'}
                    </td>
                  )}
                  {canManage && (
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        {h.active !== false && (
                          <Button variant="secondary" onClick={() => setEditing(h)}>
                            Edit
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          onClick={() => setStatusChange({ holiday: h, targetActive: h.active === false })}
                        >
                          {h.active === false ? 'Reactivate' : 'Deactivate'}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CreateHolidayDialog open={createOpen} year={year} onClose={() => setCreateOpen(false)} />
      <EditHolidayDialog open={!!editing} holiday={editing} onClose={() => setEditing(null)} />
      <HolidayStatusDialog
        open={!!statusChange}
        holiday={statusChange?.holiday ?? null}
        targetActive={statusChange?.targetActive ?? false}
        onClose={() => setStatusChange(null)}
      />
    </div>
  );
}

export default function HolidaysPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.HOLIDAY_READ}>
        <h1 className="text-xl font-bold text-text">Holidays</h1>
        <p className="mt-1 text-sm text-text-muted">Yearly holiday calendar, optionally scoped to a location.</p>
        <div className="mt-6">
          <HolidaysManager />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

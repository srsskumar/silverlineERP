'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { buildLeaveListParams, formatDays, listRequests, type LeaveListView } from '@/lib/leave';
import { LEAVE_STATUSES } from '@/lib/validation';
import { queryKeys } from '@/lib/query-keys';
import { LeaveStatusBadge } from '@/components/LeaveStatusBadge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';

export const dynamic = 'force-static';

const PAGE_LIMIT = 20;
const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

function RequestsTable({ view }: { view: LeaveListView }) {
  const [status, setStatus] = React.useState('');
  const [employeeId, setEmployeeId] = React.useState('');

  const params = React.useMemo(
    () => buildLeaveListParams(view, { status: status || undefined, employee_id: view === 'all' ? employeeId.trim() || undefined : undefined, limit: PAGE_LIMIT }),
    [view, status, employeeId],
  );

  const listQuery = useInfiniteQuery({
    queryKey: queryKeys.leave.requests({ ...params }),
    queryFn: ({ pageParam }) =>
      listRequests({ ...params, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as unknown as string | undefined,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    staleTime: 30_000,
  });

  const rows = (listQuery.data?.pages ?? []).flatMap((p) => p.data);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-end">
        <div>
          <label htmlFor={`leave-status-${view}`} className="text-sm font-medium text-slate-700">Status</label>
          <select id={`leave-status-${view}`} className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {LEAVE_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        {view === 'all' && (
          <div className="flex-1">
            <label htmlFor={`leave-employee-${view}`} className="text-sm font-medium text-slate-700">Employee ID</label>
            <Input id={`leave-employee-${view}`} placeholder="Filter by employee…" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
          </div>
        )}
        <Link href="/leave/new" className="text-sm text-brand-600 hover:underline">
          + New request
        </Link>
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load leave requests" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No leave requests" description="Nothing matches this view and filter yet." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Type</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">From → To</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Days</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Employee</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-800">{r.leave_code}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.from_date} → {r.to_date}</td>
                    <td className="px-3 py-2 text-slate-800">{formatDays(r.total_days)}</td>
                    <td className="px-3 py-2">
                      <LeaveStatusBadge status={String(r.status)} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.employee_id}</td>
                    <td className="px-3 py-2">
                      <Link href={`/leave/${r.id}`} className="text-brand-600 hover:underline">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            {listQuery.hasNextPage ? (
              <Button variant="secondary" loading={listQuery.isFetchingNextPage} onClick={() => listQuery.fetchNextPage()}>
                Load more
              </Button>
            ) : (
              <p className="text-xs text-slate-500">End of list ({rows.length} shown).</p>
            )}
            {listQuery.isFetching && !listQuery.isFetchingNextPage && <Spinner size="sm" />}
          </div>
        </>
      )}
    </div>
  );
}

function LeaveTabs() {
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canDecide = hasPermission(holder, PERMISSIONS.LEAVE_DECIDE);
  const canReadAll = hasPermission(holder, PERMISSIONS.LEAVE_READ);
  const [view, setView] = React.useState<LeaveListView>('mine');

  const tabs: Array<{ view: LeaveListView; label: string; visible: boolean }> = [
    { view: 'mine', label: 'Mine', visible: true },
    { view: 'approvals', label: 'Approvals', visible: canDecide },
    { view: 'all', label: 'All', visible: canReadAll },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2" role="tablist" aria-label="Leave request views">
        {tabs.filter((t) => t.visible).map((t) => (
          <button
            key={t.view}
            type="button"
            role="tab"
            aria-selected={view === t.view}
            onClick={() => setView(t.view)}
            className={`rounded-md px-4 py-2 text-sm font-medium ring-1 ${
              view === t.view ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <RequestsTable key={view} view={view} />
    </div>
  );
}

export default function LeavePage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.LEAVE_REQUEST}>
        <h1 className="text-xl font-bold text-slate-900">Leave requests</h1>
        <p className="mt-1 text-sm text-slate-500">Your requests, your approval queue, and the full directory (permission-gated).</p>
        <div className="mt-6">
          <LeaveTabs />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

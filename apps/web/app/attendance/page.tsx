'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { AttendanceStatusBadge } from '@/components/AttendanceStatusBadge';
import { PunchPanel } from '@/components/PunchPanel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { PERMISSIONS } from '@/lib/permissions';
import { formatHours, listRecords } from '@/lib/attendance';
import { queryKeys } from '@/lib/query-keys';

export const dynamic = 'force-static';

const PAGE_LIMIT = 20;
const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

function RecordsTable() {
  const [employeeId, setEmployeeId] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [violation, setViolation] = React.useState('');
  const [punchOpen, setPunchOpen] = React.useState(false);

  const filters = React.useMemo(
    () => ({
      employee_id: employeeId.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      status: status || undefined,
      violation: violation || undefined,
    }),
    [employeeId, from, to, status, violation],
  );

  const listQuery = useInfiniteQuery({
    queryKey: queryKeys.attendance.records({ ...filters, limit: PAGE_LIMIT }),
    queryFn: ({ pageParam }) =>
      listRecords({ ...filters, limit: PAGE_LIMIT, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as unknown as string | undefined,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    staleTime: 30_000,
  });

  const rows = (listQuery.data?.pages ?? []).flatMap((p) => p.data);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 lg:flex-row lg:items-end">
        <div className="flex-1">
          <label htmlFor="rec-employee" className="text-sm font-medium text-slate-700">Employee ID</label>
          <Input id="rec-employee" placeholder="Filter by employee…" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rec-from" className="text-sm font-medium text-slate-700">From</label>
          <Input id="rec-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rec-to" className="text-sm font-medium text-slate-700">To</label>
          <Input id="rec-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rec-status" className="text-sm font-medium text-slate-700">Status</label>
          <select id="rec-status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {['PRESENT', 'PARTIAL', 'ABSENT', 'VIOLATION'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rec-violation" className="text-sm font-medium text-slate-700">Geofence</label>
          <select id="rec-violation" className={inputClass} value={violation} onChange={(e) => setViolation(e.target.value)}>
            <option value="">All</option>
            <option value="true">Violation only</option>
            <option value="false">No violation</option>
          </select>
        </div>
        <Button variant="secondary" onClick={() => setPunchOpen((v) => !v)}>
          {punchOpen ? 'Hide punch' : 'Manual punch'}
        </Button>
      </div>

      {punchOpen && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Manual punch (testing / admin)</h2>
          <PunchPanel
            onPunched={() => {
              listQuery.refetch();
            }}
          />
        </div>
      )}

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load attendance records" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No attendance records" description="Adjust filters or record a punch above." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Date</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Employee</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Check in</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Check out</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Hours</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-800">{r.work_date}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.employee_id}</td>
                    <td className="px-3 py-2">
                      <AttendanceStatusBadge status={String(r.status)} violation={!!r.geofence_violation} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">{r.check_in_at ? String(r.check_in_at) : '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">{r.check_out_at ? String(r.check_out_at) : '—'}</td>
                    <td className="px-3 py-2 text-slate-800">{formatHours(r.total_hours)}</td>
                    <td className="px-3 py-2">
                      <Link href={`/attendance/records/${r.id}`} className="text-brand-600 hover:underline">
                        View
                      </Link>
                      {r.geofence_violation ? (
                        <span className="ml-2">
                          <Badge tone="warning">⚠</Badge>
                        </span>
                      ) : null}
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

export default function AttendancePage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.ATTENDANCE_READ}>
        <h1 className="text-xl font-bold text-slate-900">Attendance records</h1>
        <p className="mt-1 text-sm text-slate-500">Daily records with punch status, hours and geofence flags.</p>
        <div className="mt-6">
          <RecordsTable />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

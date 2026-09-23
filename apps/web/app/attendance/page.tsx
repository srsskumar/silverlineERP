'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import nextDynamic from 'next/dynamic';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { Forbidden } from '@/components/Forbidden';
import { useAuth } from '@/components/AuthProvider';
import { AttendanceStatusBadge } from '@/components/AttendanceStatusBadge';
import { PunchPanel } from '@/components/PunchPanel';
import { EmployeePicker } from '@/components/EmployeePicker';
import { PersonName } from '@/components/PersonName';
import { PlaceName } from '@/components/PunchPlace';
import type { PunchClusterMapProps } from '@/components/map/PunchClusterMap';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { PERMISSIONS } from '@/lib/permissions';
import { attendanceView } from '@/lib/attendance-view';
import { formatHours, listMapEvents, listRecords } from '@/lib/attendance';
import { queryKeys } from '@/lib/query-keys';
import { clock, day } from '@/lib/finance';
import { PunchClock } from '@/components/PunchClock';

export const dynamic = 'force-static';

const PAGE_LIMIT = 20;
const PunchClusterMap = nextDynamic<PunchClusterMapProps>(
  () => import('@/components/map/PunchClusterMap').then((module) => module.PunchClusterMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[420px] w-full" />,
  },
);
const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

function RecordsTable() {
  const [employeeId, setEmployeeId] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [punchOpen, setPunchOpen] = React.useState(false);

  const filters = React.useMemo(
    () => ({
      employee_id: employeeId.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      status: status || undefined,
    }),
    [employeeId, from, to, status],
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
  const [showMap, setShowMap] = React.useState(false);
  const mapQuery = useQuery({
    queryKey: queryKeys.attendance.map(filters),
    queryFn: () => listMapEvents({ employee_id: employeeId || undefined, from: from || undefined, to: to || undefined }),
    // Only fetched once the user opens the map: it is a second round trip over
    // a different table, and most visits to this page never need it.
    enabled: showMap,
  });

  return (
    <div className="flex flex-col gap-4">
      {/* §079. Your own attendance, first: marking it is what most people
          open this page to do. The register below is what a supervisor
          opens it for, and until now it was all the page had. */}
      <PunchClock />

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 lg:flex-row lg:items-end">
        <div className="flex-1">
          <label htmlFor="rec-employee" className="text-sm font-medium text-text-muted">Employee</label>
          {/* Any status: the register is history, and somebody who has left still has days in it. */}
          <EmployeePicker id="rec-employee" status={null} value={employeeId} onChange={setEmployeeId} placeholder="Everybody — type a name to filter" />
        </div>
        <div>
          <label htmlFor="rec-from" className="text-sm font-medium text-text-muted">From</label>
          <Input id="rec-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rec-to" className="text-sm font-medium text-text-muted">To</label>
          <Input id="rec-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rec-status" className="text-sm font-medium text-text-muted">Status</label>
          <select id="rec-status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {['PRESENT', 'PARTIAL', 'ABSENT'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <Button
            variant={showMap ? 'primary' : 'secondary'}
            onClick={() => setShowMap((v) => !v)}
            aria-pressed={showMap}
          >
            {showMap ? 'Hide map' : 'Show map'}
          </Button>
        </div>
        <Button variant="secondary" onClick={() => setPunchOpen((v) => !v)}>
          {punchOpen ? 'Hide' : 'Punch for somebody else'}
        </Button>
      </div>

      {punchOpen && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold text-text">Punch on behalf of somebody</h2>
          <p className="mb-3 text-xs text-text-muted">
            {/* Renamed from "Manual punch (testing / admin)". It is not a
                testing tool -- it is how a supervisor fixes a day for
                somebody whose phone was flat -- and a heading that calls
                itself testing is a heading people avoid in earnest. */}
            For correcting somebody else&rsquo;s day. Your own attendance is the panel above.
          </p>
          <PunchPanel
            onPunched={() => {
              listQuery.refetch();
            }}
          />
        </div>
      )}

      {/* Map view: the table answers "who punched", the map answers "where from".
          Hidden until there is something positioned to plot. */}
      {showMap ? (
        mapQuery.isLoading ? (
          <Skeleton className="mb-4 h-[420px] w-full" />
        ) : mapQuery.data && mapQuery.data.data.length > 0 ? (
          <div className="mb-4">
            <PunchClusterMap points={mapQuery.data.data} />
            <p className="mt-1.5 text-xs text-text-muted">
              {mapQuery.data.data.length} positioned {mapQuery.data.data.length === 1 ? 'punch' : 'punches'}
              {mapQuery.data.truncated ? ' (showing the most recent — narrow the date range for the full set)' : ''}
              {' · '}
              <span className="text-success">green</span> accepted,{' '}
              <span className="text-warning">amber</span> flagged for review
            </p>
          </div>
        ) : (
          <div className="mb-4">
            <EmptyState
              title="No positioned punches"
              description="Punches recorded without GPS do not appear on the map."
            />
          </div>
        )
      ) : null}

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load attendance records" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No attendance records" description="Adjust filters or record a punch above." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border bg-surface text-sm">
              <thead className="bg-surface-sunken">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Date</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Employee</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Check in</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Check out</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Hours</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Where</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs text-text">{day(r.work_date)}</td>
                    <td className="px-3 py-2 text-xs text-text">
                      <PersonName id={r.employee_id} name={r.employee_name} empNo={r.employee_emp_no} />
                    </td>
                    <td className="px-3 py-2">
                      <AttendanceStatusBadge status={String(r.status)} />
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted">{clock(r.check_in_at)}</td>
                    <td className="px-3 py-2 text-xs text-text-muted">{clock(r.check_out_at)}</td>
                    <td className="px-3 py-2 text-text">{formatHours(r.total_hours)}</td>
                    <td className="px-3 py-2 text-xs text-text-muted">
                      {/* The place each end of the day was punched from; one name when both are the same. */}
                      {r.check_in_at ? (
                        <PlaceName name={r.check_in_place_name} status={r.check_in_place_status} />
                      ) : '—'}
                      {r.check_out_at && r.check_out_place_name !== r.check_in_place_name ? (
                        <>
                          {' → '}
                          <PlaceName name={r.check_out_place_name} status={r.check_out_place_status} />
                        </>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/attendance/records/${r.id}`} className="text-primary hover:underline">
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
              <p className="text-xs text-text-muted">End of list ({rows.length} shown).</p>
            )}
            {listQuery.isFetching && !listQuery.isFetchingNextPage && <Spinner size="sm" />}
          </div>
        </>
      )}
    </div>
  );
}

export default function AttendancePage() {
  const { session, isLoading } = useAuth();
  const view = attendanceView(session?.permissions);
  return (
    <AppShell>
      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Spinner /></div>
      ) : view === 'none' ? (
        <Forbidden required={PERMISSIONS.ATTENDANCE_PUNCH} />
      ) : view === 'punch' ? (
        /*
         * Somebody who marks their own day and reads nobody else's. The
         * register below needs attendance.read, which they do not hold, so
         * the page is the clock and nothing that would answer with a 403.
         */
        <>
          <h1 className="text-xl font-bold text-text">Attendance</h1>
          <p className="mt-1 text-sm text-text-muted">Mark your own attendance for today.</p>
          <div className="mt-6">
            <PunchClock />
          </div>
        </>
      ) : (
        <>
          <h1 className="text-xl font-bold text-text">Attendance records</h1>
          <p className="mt-1 text-sm text-text-muted">Daily records with punch status, hours and where each punch was made.</p>
          <div className="mt-6">
            <RecordsTable />
          </div>
        </>
      )}
    </AppShell>
  );
}

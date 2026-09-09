'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { Skeleton } from '@/components/ui/Skeleton';
import { PERMISSIONS } from '@/lib/permissions';
import { listEmployees } from '@/lib/employees';
import { listOrgUnits } from '@/lib/org';
import { queryKeys } from '@/lib/query-keys';
import { displayMasked, displayEmployeeName } from '@/lib/masking';

export const dynamic = 'force-static';

const PAGE_LIMIT = 20;

function statusTone(status: string): 'success' | 'neutral' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'ON_LEAVE':
      return 'warning';
    case 'EXITED':
    case 'TERMINATED':
      return 'danger';
    case 'DRAFT':
      return 'info';
    default:
      return 'neutral';
  }
}

function EmployeesTable() {
  const [q, setQ] = React.useState('');
  const [debouncedQ, setDebouncedQ] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [districtId, setDistrictId] = React.useState('');

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filters = React.useMemo(
    () => ({ q: debouncedQ || undefined, status: status || undefined, district_id: districtId || undefined }),
    [debouncedQ, status, districtId],
  );

  const listQuery = useInfiniteQuery({
    queryKey: queryKeys.employees.list({ ...filters, limit: PAGE_LIMIT }),
    queryFn: ({ pageParam }) => listEmployees({ ...filters, limit: PAGE_LIMIT, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as unknown as string | undefined,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    staleTime: 30_000,
  });

  const districtsQuery = useQuery({
    queryKey: queryKeys.orgUnits.list({ type: 'district', limit: 200 }),
    queryFn: () => listOrgUnits({ type: 'district', limit: 200 }),
    staleTime: 10 * 60_000,
  });

  const rows = (listQuery.data?.pages ?? []).flatMap((p) => p.data);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="emp-search" className="text-sm font-medium text-slate-700">
            Search
          </label>
          <Input id="emp-search" placeholder="emp_no, name…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label htmlFor="emp-status" className="text-sm font-medium text-slate-700">
            Status
          </label>
          <select
            id="emp-status"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm sm:w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {['DRAFT', 'ACTIVE', 'ON_LEAVE', 'EXITED', 'TERMINATED'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="emp-district" className="text-sm font-medium text-slate-700">
            District
          </label>
          <select
            id="emp-district"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm sm:w-48"
            value={districtId}
            onChange={(e) => setDistrictId(e.target.value)}
          >
            <option value="">All districts</option>
            {(districtsQuery.data?.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <Link href="/employees/new">
          <Button>New employee</Button>
        </Link>
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load employees" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No employees found" description="Adjust filters or create the first employee." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Emp No</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Name</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Phone</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Aadhaar (masked)</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Designation</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-800">{e.emp_no}</td>
                    <td className="px-3 py-2 text-slate-800">{displayEmployeeName(e)}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {displayMasked(e.phone ?? null, (e.phone_last4 as string | null) ?? null)}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {displayMasked(e.aadhaar ?? null, (e.aadhaar_last4 as string | null) ?? null)}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{(e.designation as string) ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/employees/${e.id}`} className="text-brand-600 hover:underline">
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

export default function EmployeesPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.EMPLOYEE_READ}>
        <h1 className="text-xl font-bold text-slate-900">Employees</h1>
        <p className="mt-1 text-sm text-slate-500">Directory with masked PII. Full values need extra permission.</p>
        <div className="mt-6">
          <EmployeesTable />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

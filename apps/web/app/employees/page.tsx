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
import { FormField } from '@/components/ui/FormField';
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
    queryKey: queryKeys.orgUnits.list({ type: 'district', limit: 100 }),
    queryFn: () => listOrgUnits({ type: 'district', limit: 100 }),
    staleTime: 10 * 60_000,
  });

  const rows = (listQuery.data?.pages ?? []).flatMap((p) => p.data);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-end">
        <FormField label="Search" htmlFor="emp-search" className="flex-1">
          <Input id="emp-search" placeholder="emp_no, name…" value={q} onChange={(e) => setQ(e.target.value)} />
        </FormField>
        <FormField label="Status" htmlFor="emp-status" className="sm:w-40">
          <select
            id="emp-status"
            className="w-full"
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
        </FormField>
        <FormField label="District" htmlFor="emp-district" className="sm:w-48">
          <select
            id="emp-district"
            className="w-full"
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
        </FormField>
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
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border bg-surface text-sm">
              <thead className="bg-surface-sunken">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Emp No</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Name</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Phone</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Aadhaar (masked)</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Designation</th>
                  {/* The reporting line at a glance. It was on the record and
                      on the form, and nowhere you could see it without
                      opening two people to compare them. */}
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Reports to</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-text-muted">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 font-mono text-xs text-text">{e.emp_no}</td>
                    <td className="px-3 py-2 text-text">{displayEmployeeName(e)}</td>
                    <td className="px-3 py-2 text-text-muted">
                      {displayMasked(e.phone ?? null, (e.phone_last4 as string | null) ?? null)}
                    </td>
                    <td className="px-3 py-2 text-text-muted">
                      {displayMasked(e.aadhaar ?? null, (e.aadhaar_last4 as string | null) ?? null)}
                    </td>
                    <td className="px-3 py-2 text-text-muted">{(e.designation as string) ?? '—'}</td>
                    <td className="px-3 py-2 text-text-muted">
                      {e.reports_to_name ? (
                        <>
                          {String(e.reports_to_name)}
                          {e.reports_to_emp_no ? (
                            <span className="ml-1 text-2xs text-text-subtle">
                              {String(e.reports_to_emp_no)}
                            </span>
                          ) : null}
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/employees/${e.id}`} className="text-primary hover:underline">
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

export default function EmployeesPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.EMPLOYEE_READ}>
        <h1 className="text-xl font-bold text-text">Employees</h1>
        <p className="mt-1 text-sm text-text-muted">Directory with masked PII. Full values need extra permission.</p>
        <div className="mt-6">
          <EmployeesTable />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

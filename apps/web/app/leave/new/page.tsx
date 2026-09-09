'use client';

import { staticHref } from '@/lib/routes';
import * as React from 'react';
import Link from '@/components/AppLink';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { getMyEmployee } from '@/lib/employees';
import { listBalances, listTypes, type FileRequestResult } from '@/lib/leave';
import { queryKeys } from '@/lib/query-keys';
import { PERMISSIONS } from '@/lib/permissions';
import { LeaveRequestForm } from '@/components/LeaveRequestForm';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

/**
 * File a new leave request. Balances are previewed for the caller's own
 * employee row (best effort — the preview is empty when /employees/me is
 * unavailable; the server still validates). On success navigates to the
 * detail page; idempotent replays (200 {applied:true}) navigate too, with an
 * "already filed" notice carried via sessionStorage (static-export safe,
 * no search params).
 */
function NewRequestPanel() {
  const router = useRouter();

  const typesQuery = useQuery({
    queryKey: queryKeys.leave.types(),
    queryFn: listTypes,
    staleTime: 10 * 60_000,
  });

  const meQuery = useQuery({
    queryKey: queryKeys.employees.me(),
    queryFn: getMyEmployee,
    retry: false,
    staleTime: 60_000,
  });

  const myEmployeeId = meQuery.data?.id;
  const year = new Date().getFullYear();

  const balancesQuery = useQuery({
    queryKey: queryKeys.leave.balances({ employee_id: myEmployeeId ?? 'unknown', period_year: year }),
    queryFn: () => listBalances({ employee_id: myEmployeeId as string, period_year: year }),
    enabled: !!myEmployeeId,
    retry: false,
    staleTime: 60_000,
  });

  const onSuccess = React.useCallback(
    (result: FileRequestResult) => {
      try {
        if (result.kind === 'applied') {
          window.sessionStorage.setItem(`leave-replay-${result.request.id}`, '1');
        }
      } catch {
        /* storage unavailable — detail still opens */
      }
      router.push(staticHref(`/leave/${result.request.id}`));
    },
    [router],
  );

  if (typesQuery.isLoading) return <Skeleton className="h-96 w-full" />;
  if (typesQuery.isError) {
    return <ErrorCard title="Could not load leave types" error={typesQuery.error} onRetry={() => typesQuery.refetch()} />;
  }

  return (
    <div className="max-w-2xl rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
      <LeaveRequestForm types={typesQuery.data ?? []} balances={balancesQuery.data ?? []} onSuccess={onSuccess} />
      <p className="mt-4 text-xs text-slate-500">
        <Link href="/leave" className="text-brand-600 hover:underline">Back to requests</Link>
        {' · '}total days are inclusive and re-computed by the server.
      </p>
    </div>
  );
}

export default function NewLeaveRequestPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.LEAVE_REQUEST}>
        <h1 className="text-xl font-bold text-slate-900">New leave request</h1>
        <p className="mt-1 text-sm text-slate-500">Pick a type and date range — the server computes days and checks balance.</p>
        <div className="mt-6">
          <NewRequestPanel />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

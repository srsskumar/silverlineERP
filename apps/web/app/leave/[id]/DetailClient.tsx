'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { getRequest, formatDays } from '@/lib/leave';
import { getMyEmployee } from '@/lib/employees';
import { queryKeys } from '@/lib/query-keys';
import { PERMISSIONS } from '@/lib/permissions';
import { ApprovalTimeline } from '@/components/ApprovalTimeline';
import { listPeople, peopleIndex, personLabel } from '@/lib/people';
import { DecisionButtons } from '@/components/DecisionButtons';
import { CancelButton } from '@/components/CancelButton';
import { LeaveStatusBadge } from '@/components/LeaveStatusBadge';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { day, dayTime } from '@/lib/finance';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm text-text">{value}</dd>
    </div>
  );
}

export function LeaveDetailView({ id }: { id: string }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [replayNotice, setReplayNotice] = React.useState(false);

  const detailQuery = useQuery({
    queryKey: queryKeys.leave.request(id),
    queryFn: () => getRequest(id),
  });

  // The approver is shown by name; an id tells the requester nothing about
  // who is holding up their leave.
  const peopleQuery = useQuery({ queryKey: ['people'], queryFn: listPeople, staleTime: 300_000 });
  const people = React.useMemo(() => peopleIndex(peopleQuery.data ?? []), [peopleQuery.data]);

  const meQuery = useQuery({
    queryKey: queryKeys.employees.me(),
    queryFn: getMyEmployee,
    retry: false,
    staleTime: 60_000,
  });

  React.useEffect(() => {
    try {
      if (window.sessionStorage.getItem(`leave-replay-${id}`)) {
        setReplayNotice(true);
        window.sessionStorage.removeItem(`leave-replay-${id}`);
      }
    } catch {
      /* storage unavailable */
    }
  }, [id]);

  const refetchAll = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.leave.request(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.leave.requests() });
  };

  if (detailQuery.isLoading) {
    return (
      <AppShell>
        <Skeleton className="h-96 w-full" />
      </AppShell>
    );
  }
  if (detailQuery.isError) {
    return (
      <AppShell>
        <ErrorCard title="Could not load leave request" error={detailQuery.error} onRetry={() => detailQuery.refetch()} />
      </AppShell>
    );
  }
  const req = detailQuery.data;
  if (!req) {
    return (
      <AppShell>
        <EmptyState title="Leave request not found" />
      </AppShell>
    );
  }

  const userId = session?.user?.id ? String(session.user.id) : undefined;
  const myEmployeeId = meQuery.data?.id;
  const isMine = !!req.employee_id && (req.employee_id === myEmployeeId || (!!userId && req.employee_id === userId));
  const isPending = req.status === 'PENDING';
  const isMyApproval = isPending && !!req.current_approver_id && !!userId && String(req.current_approver_id) === userId;
  const chain = Array.isArray(req.approval_chain) ? req.approval_chain : [];

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.LEAVE_REQUEST}>
        <div className="flex flex-col gap-6">
          {replayNotice && (
            <div role="status" className="rounded-lg border border-primary/30 bg-primary-subtle px-4 py-3 text-sm text-text">
              This request was already filed — your retry was de-duplicated (same idempotency key), no duplicate was created.
            </div>
          )}

          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-text">
                  <span className="font-mono">{req.leave_code}</span>{' '}
                  <span className="text-base font-normal text-text-muted">
                    {day(req.from_date)} → {day(req.to_date)}
                  </span>
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <LeaveStatusBadge status={String(req.status)} />
                  <Badge tone="info">{formatDays(req.total_days)}</Badge>
                  <span className="text-xs text-text-muted">v{req.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/leave" className="text-sm text-primary hover:underline">
                  Back to requests
                </Link>
              </div>
            </div>
            <dl className="mt-4 divide-y divide-border">
              <DetailRow label="Request ID" value={<span className="font-mono text-xs">{req.id}</span>} />
              <DetailRow label="Employee" value={<span className="font-mono text-xs">{req.employee_id}</span>} />
              <DetailRow
                label="Current approver"
                value={
                  req.current_approver_id ? (
                    <span title={String(req.current_approver_id)}>
                      {personLabel(people, String(req.current_approver_id))}
                      <span className="ml-2 text-text-subtle">(user id — names are not provided by the API)</span>
                    </span>
                  ) : (
                    '—'
                  )
                }
              />
              <DetailRow label="Reason" value={req.reason ? String(req.reason) : '—'} />
              {req.created_at ? <DetailRow label="Filed at" value={dayTime(req.created_at)} /> : null}
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Approval chain ({chain.length})</h2>
            <p className="mt-1 text-xs text-text-muted">Approvers are shown as user ids — the API does not return approver names.</p>
            <div className="mt-3">
              <ApprovalTimeline chain={chain} />
            </div>
          </div>

          {isMyApproval && (
            <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
              <h2 className="text-sm font-semibold text-text">Your decision</h2>
              <p className="mt-1 text-xs text-text-muted">You are the current approver. Rejecting requires a note.</p>
              <div className="mt-3 max-w-xl">
                <DecisionButtons
                  requestId={req.id}
                  version={req.version}
                  onReload={refetchAll}
                  onDecided={refetchAll}
                />
              </div>
            </div>
          )}

          {isMine && isPending && (
            <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
              <h2 className="text-sm font-semibold text-text">Cancel</h2>
              <p className="mt-1 text-xs text-text-muted">You filed this request and it is still pending.</p>
              <div className="mt-3 max-w-xl">
                <CancelButton requestId={req.id} onCancelled={refetchAll} />
              </div>
            </div>
          )}
        </div>
      </RequirePermission>
    </AppShell>
  );
}

'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { MyWorkSummary } from '@/components/MyWorkSummary';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { DASHBOARD_GC_TIME, DASHBOARD_STALE_TIME, getMyWork } from '@/lib/dashboards';
import { listTasksPage, type Task } from '@/lib/tasks';
import { queryKeys } from '@/lib/query-keys';
import { LabelPill } from '@/components/LabelPill';
import { SlaBadge } from '@/components/SlaBadge';
import { TaskStatusBadge } from '@/components/TaskStatusBadge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';

export const dynamic = 'force-static';

const PAGE_LIMIT = 20;

/** Trivially-safe memo: pure row, props are a single stable task object. */
const TaskRow = React.memo(function TaskRow({ task }: { task: Task }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">{task.title}</p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-400">
          {String(task.project_id).slice(0, 8)}… · {String(task.id).slice(0, 8)}…
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <TaskStatusBadge status={String(task.status)} />
          <SlaBadge status={task.sla_status} />
          {(task.labels ?? []).map((l) => (
            <LabelPill key={l.id} label={l} />
          ))}
        </div>
      </div>
      <Link
        href={`/projects/${task.project_id}/tasks/${task.id}`}
        className="shrink-0 text-sm text-brand-600 hover:underline"
      >
        Open
      </Link>
    </li>
  );
});

function PagedTaskSection({
  title,
  description,
  queryKey,
  params,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description: string;
  queryKey: readonly unknown[];
  params: { assignee_me: string; sla?: string; limit: number };
  emptyTitle: string;
  emptyDescription: string;
}) {
  const listQuery = useInfiniteQuery({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryKey: queryKey as any,
    queryFn: ({ pageParam }) =>
      listTasksPage({ ...params, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as unknown as string | undefined,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    staleTime: 30_000,
  });

  const rows = (listQuery.data?.pages ?? []).flatMap((p) => p.tasks);

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      {listQuery.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title={`Could not load ${title.toLowerCase()}`} error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </ul>
          <div className="flex items-center gap-3">
            {listQuery.hasNextPage ? (
              <Button
                variant="secondary"
                loading={listQuery.isFetchingNextPage}
                onClick={() => listQuery.fetchNextPage()}
              >
                Load more
              </Button>
            ) : (
              <p className="text-xs text-slate-500">
                End of list ({rows.length} shown).
              </p>
            )}
            {listQuery.isFetching && !listQuery.isFetchingNextPage ? <Spinner size="sm" /> : null}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * S6 pending-approvals slice from the my-work payload: leave requests awaiting
 * the session's decision (links to /leave/:id) plus the attendance-exceptions
 * count that routes to the exceptions queue.
 */
function PendingApprovals() {
  const summaryQuery = useQuery({
    queryKey: queryKeys.dashboard.myWork(),
    queryFn: getMyWork,
    staleTime: DASHBOARD_STALE_TIME,
    gcTime: DASHBOARD_GC_TIME,
    retry: false,
  });
  const leave = summaryQuery.data?.pending_approvals.leave ?? [];
  const exceptionsCount = summaryQuery.data?.pending_approvals.exceptions_count ?? 0;

  return (
    <section aria-label="Pending approvals" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Pending approvals</h2>
        <p className="text-xs text-slate-500">
          Leave requests awaiting your decision (from the my-work payload) + attendance exceptions count.
        </p>
      </div>
      {summaryQuery.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : summaryQuery.isError ? (
        <ErrorCard
          title="Could not load pending approvals"
          error={summaryQuery.error}
          onRetry={() => summaryQuery.refetch()}
        />
      ) : leave.length === 0 && exceptionsCount === 0 ? (
        <EmptyState
          title="Nothing awaiting approval"
          description="Leave requests needing your decision will appear here."
        />
      ) : (
        <>
          {leave.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {leave.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      Leave {String(l.id).slice(0, 8)}… · {String(l.from_date)} → {String(l.to_date)}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                      employee {String(l.employee_id).slice(0, 8)}…
                    </p>
                  </div>
                  <Link href={`/leave/${l.id}`} className="shrink-0 text-sm text-brand-600 hover:underline">
                    Review →
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {exceptionsCount > 0 ? (
            <p className="text-sm text-slate-700">
              {exceptionsCount} attendance exception(s) awaiting decision —{' '}
              <Link href="/attendance/exceptions" className="text-brand-600 hover:underline">
                open the exceptions queue →
              </Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * S6 unread-inbox card from the my-work payload (count only — the inbox page
 * owns the rows and still polls every 60s).
 */
function UnreadInboxCard() {
  const summaryQuery = useQuery({
    queryKey: queryKeys.dashboard.myWork(),
    queryFn: getMyWork,
    staleTime: DASHBOARD_STALE_TIME,
    gcTime: DASHBOARD_GC_TIME,
    retry: false,
  });
  if (summaryQuery.isLoading) return <Skeleton className="h-24 w-full" />;
  if (summaryQuery.isError) {
    return (
      <ErrorCard
        title="Could not load unread count"
        error={summaryQuery.error}
        onRetry={() => summaryQuery.refetch()}
      />
    );
  }
  const unread = summaryQuery.data?.unread_count ?? 0;
  return (
    <section
      aria-label="Unread inbox"
      className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3"
    >
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Unread inbox</h2>
        <p className="text-xs text-slate-500">
          {unread === 0 ? 'All caught up.' : `${unread} unread notification(s).`}
        </p>
      </div>
      <Link href="/inbox" className="shrink-0 text-sm text-brand-600 hover:underline">
        Open inbox →
      </Link>
    </section>
  );
}

/**
 * My Work: S5 assigned/overdue slices (unchanged) + S6 summary counts,
 * pending-approvals leave list, and the unread-inbox card.
 */
export default function MyWorkPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.TASK_READ}>
        <MyWorkInner />
      </RequirePermission>
    </AppShell>
  );
}

function MyWorkInner() {
  const summaryQuery = useQuery({
    queryKey: queryKeys.dashboard.myWork(),
    queryFn: getMyWork,
    staleTime: DASHBOARD_STALE_TIME,
    gcTime: DASHBOARD_GC_TIME,
    retry: false,
  });
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">My Work</h1>
          <p className="mt-1 text-sm text-slate-500">
            Everything assigned to you, with your overdue slice on top. Mentions live in{' '}
            <Link href="/inbox" className="text-brand-600 hover:underline">
              Inbox
            </Link>
            .
          </p>
        </div>
        <Link href="/inbox" className="text-sm text-brand-600 hover:underline">
          Go to inbox →
        </Link>
      </div>
      <div className="mt-6">
        <MyWorkSummary
          summary={summaryQuery.data ?? null}
          isLoading={summaryQuery.isLoading}
          error={summaryQuery.error}
          onRetry={() => summaryQuery.refetch()}
        />
      </div>
      <div className="mt-6 flex flex-col gap-8">
        <PendingApprovals />
        <UnreadInboxCard />
        <PagedTaskSection
          title="Overdue mine"
          description="Assigned to me with sla=overdue."
          queryKey={queryKeys.tasks.list({ assignee_me: 'true', sla: 'overdue', limit: PAGE_LIMIT })}
          params={{ assignee_me: 'true', sla: 'overdue', limit: PAGE_LIMIT }}
          emptyTitle="Nothing overdue"
          emptyDescription="No overdue tasks are assigned to you right now."
        />
        <PagedTaskSection
          title="Assigned to me"
          description="All open and closed tasks where you are the assignee."
          queryKey={queryKeys.tasks.list({ assignee_me: 'true', limit: PAGE_LIMIT })}
          params={{ assignee_me: 'true', limit: PAGE_LIMIT }}
          emptyTitle="No tasks assigned"
          emptyDescription="Tasks assigned to you will appear here."
        />
      </div>
    </>
  );
}

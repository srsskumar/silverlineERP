'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getTask } from '@/lib/tasks';
import {
  inboxEntityHref,
  isUnread,
  listInbox,
  markAllInboxRead,
  markInboxRead,
  type InboxItem,
} from '@/lib/notifications';
import { queryKeys } from '@/lib/query-keys';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { ErrorCard } from './ui/ErrorCard';
import { Skeleton } from './ui/Skeleton';
import { Spinner } from './ui/Spinner';

const PAGE_LIMIT = 20;

/** Small type glyph (text, not emoji-heavy): first letter of the type. */
function typeGlyph(type: string): string {
  const t = type.toUpperCase();
  if (t.includes('MENTION')) return '@';
  if (t.includes('ASSIGN')) return '→';
  if (t.includes('COMMENT')) return '💬';
  if (t.includes('STATUS') || t.includes('TRANSITION')) return '⇄';
  if (t.includes('LEAVE')) return '🌴';
  return '•';
}

function EntityLink({ item }: { item: InboxItem }) {
  const direct = inboxEntityHref(item);
  if (direct) {
    return (
      <Link href={direct} className="text-brand-600 hover:underline">
        Open {String(item.entity_type).toLowerCase()} →
      </Link>
    );
  }
  const type = String(item.entity_type ?? '').toUpperCase();
  if ((type === 'TASK' || type === 'TASKS') && item.entity_id) {
    return <TaskEntityLink taskId={String(item.entity_id)} />;
  }
  if (!item.entity_id) return null;
  return <span className="font-mono text-xs text-slate-500">{String(item.entity_id)}</span>;
}

/** Resolve a task notification to /projects/:projectId/tasks/:taskId via getTask. */
function TaskEntityLink({ taskId }: { taskId: string }) {
  const taskQuery = useQuery({
    queryKey: queryKeys.tasks.detail(taskId),
    queryFn: () => getTask(taskId),
    staleTime: 60_000,
    retry: false,
  });
  if (taskQuery.isLoading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
        <Spinner size="sm" /> Resolving task…
      </span>
    );
  }
  if (taskQuery.isError || !taskQuery.data) {
    return <span className="font-mono text-xs text-slate-500" title={taskId}>task:{taskId.slice(0, 8)}…</span>;
  }
  const projectId = String(taskQuery.data.task.project_id);
  return (
    <Link href={`/projects/${projectId}/tasks/${taskId}`} className="text-brand-600 hover:underline">
      Open task →
    </Link>
  );
}

function InboxRow({
  item,
  onMarked,
}: {
  item: InboxItem;
  onMarked: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);
  const unread = isUnread(item);

  const markMutation = useMutation({
    mutationFn: () => markInboxRead(item.id),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      onMarked();
    },
    onError: (err) => setError(err),
  });

  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between ${
        unread ? 'border-brand-200 bg-brand-50' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-bold text-slate-700"
        >
          {typeGlyph(String(item.type ?? ''))}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={unread ? 'info' : 'neutral'}>{String(item.type)}</Badge>
            {unread ? <span aria-label="unread" className="text-sm font-bold text-brand-600">•</span> : null}
            {item.created_at ? (
              <span className="text-xs text-slate-500">{String(item.created_at)}</span>
            ) : null}
          </div>
          <p className="mt-1 text-sm font-medium text-slate-900">{item.title}</p>
          {item.body ? <p className="mt-1 text-sm text-slate-600">{String(item.body)}</p> : null}
          <div className="mt-2 text-sm">
            <EntityLink item={item} />
          </div>
          {error ? (
            <div className="mt-2">
              <ErrorCard title="Could not mark as read" error={error} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {unread ? (
          <Button variant="secondary" loading={markMutation.isPending} onClick={() => markMutation.mutate()}>
            Mark read
          </Button>
        ) : (
          <span className="px-2 py-2 text-xs text-slate-400">Read</span>
        )}
      </div>
    </li>
  );
}

/**
 * Inbox list with 60s polling, unread-only filter and read-all. Cursor pages
 * accumulate via "Load more".
 */
export function InboxList() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [readAllNote, setReadAllNote] = React.useState<string | null>(null);
  const [readAllError, setReadAllError] = React.useState<unknown>(null);

  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const activeCursor = cursorStack[cursorStack.length - 1];

  const pageQuery = useQuery({
    queryKey: queryKeys.notifications.inboxList({
      unread: unreadOnly ? 'true' : 'all',
      cursor: activeCursor ?? '',
      limit: PAGE_LIMIT,
    }),
    queryFn: () =>
      listInbox({
        unread: unreadOnly ? true : undefined,
        limit: PAGE_LIMIT,
        cursor: activeCursor ?? undefined,
      }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Accumulated pages for "Load more" (reset on filter change).
  const [accumulated, setAccumulated] = React.useState<InboxItem[]>([]);
  const [seenCursors, setSeenCursors] = React.useState<string[]>([]);
  React.useEffect(() => {
    setAccumulated([]);
    setSeenCursors([]);
    setCursorStack([undefined]);
  }, [unreadOnly]);

  React.useEffect(() => {
    if (pageQuery.data && !seenCursors.includes(activeCursor ?? '')) {
      setSeenCursors((prev) => [...prev, activeCursor ?? '']);
      setAccumulated((prev) => {
        const ids = new Set(prev.map((i) => i.id));
        const fresh = pageQuery.data!.items.filter((i) => !ids.has(i.id));
        return [...prev, ...fresh];
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageQuery.data]);

  const hasMore = pageQuery.data?.has_more === true;
  const nextCursor = pageQuery.data?.next_cursor ?? null;

  const readAllMutation = useMutation({
    mutationFn: markAllInboxRead,
    onSuccess: async (res) => {
      setReadAllError(null);
      setReadAllNote(`Marked ${res.marked} notification${res.marked === 1 ? '' : 's'} as read.`);
      setAccumulated([]);
      setSeenCursors([]);
      setCursorStack([undefined]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
    onError: (err) => {
      setReadAllError(err);
      setReadAllNote(null);
    },
  });

  const refresh = React.useCallback(async () => {
    setAccumulated([]);
    setSeenCursors([]);
    setCursorStack([undefined]);
    await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
  }, [queryClient]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Unread only
        </label>
        <div className="flex items-center gap-2">
          <Button variant="secondary" loading={readAllMutation.isPending} onClick={() => readAllMutation.mutate()}>
            Mark all read
          </Button>
          <Button variant="secondary" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      </div>
      {readAllNote ? (
        <p role="status" className="text-sm text-green-700">
          {readAllNote}
        </p>
      ) : null}
      {readAllError ? <ErrorCard title="Could not mark all as read" error={readAllError} /> : null}

      {pageQuery.isLoading && accumulated.length === 0 ? (
        <Skeleton className="h-64 w-full" />
      ) : pageQuery.isError && accumulated.length === 0 ? (
        <ErrorCard title="Could not load inbox" error={pageQuery.error} onRetry={() => pageQuery.refetch()} />
      ) : accumulated.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'No unread notifications' : 'Inbox is empty'}
          description="Mentions, assignments and status changes land here."
        />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {accumulated.map((item) => (
              <InboxRow key={item.id} item={item} onMarked={() => void refresh()} />
            ))}
          </ul>
          <div className="flex items-center gap-3">
            {hasMore && nextCursor ? (
              <Button
                variant="secondary"
                loading={pageQuery.isFetching}
                onClick={() => setCursorStack((prev) => [...prev, nextCursor])}
              >
                Load more
              </Button>
            ) : (
              <p className="text-xs text-slate-500">End of inbox ({accumulated.length} shown).</p>
            )}
            {pageQuery.isFetching && <Spinner size="sm" />}
          </div>
        </>
      )}
      <p className="text-xs text-slate-400">Polls every 60s for new notifications.</p>
    </div>
  );
}

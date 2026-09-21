'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { dayTime } from '@/lib/finance';

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

/**
 * The whole notification is the thing you click (§note 14).
 *
 * It used to be a small "Open task →" link beside the text, and only for
 * tasks and leave. Everything else — a ready report, a paused schedule, a
 * village where nothing has been recorded — printed a bare UUID next to an
 * instruction to go and deal with it, which is an instruction and a riddle.
 *
 * Opening it marks it read on the way, because an alert you have acted on
 * and still have to tick off is an alert people stop ticking off.
 */
function RowShell({
  item, href, onOpen, children,
}: {
  item: InboxItem;
  href: string | null;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const unread = isUnread(item);
  const className = `flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between ${
    unread ? 'border-primary/30 bg-primary-subtle' : 'border-border bg-surface'
  } ${href ? 'transition-colors hover:border-primary/60' : ''}`;

  if (!href) return <li className={className}>{children}</li>;
  return (
    <li className={className}>
      {/* The link wraps the content, not the row, so the Mark-read button
          beside it stays its own control rather than a nested one. */}
      <Link href={href} onClick={onOpen} className="flex min-w-0 flex-1 gap-3 text-left">
        {children}
      </Link>
    </li>
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
  const href = inboxEntityHref(item);

  const markMutation = useMutation({
    mutationFn: () => markInboxRead(item.id),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      onMarked();
    },
    onError: (err) => setError(err),
  });

  const contents = (
    <>
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-border text-sm font-bold text-text-muted"
      >
        {typeGlyph(String(item.type ?? ''))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={unread ? 'info' : 'neutral'}>{String(item.type)}</Badge>
          {unread ? <span aria-label="unread" className="text-sm font-bold text-primary">•</span> : null}
          {item.created_at ? (
            <span className="text-xs text-text-muted">{when(item.created_at)}</span>
          ) : null}
        </span>
        <span className="mt-1 block text-sm font-medium text-text">{item.title}</span>
        {item.body ? (
          <span className="mt-1 block text-sm text-text-muted">{String(item.body)}</span>
        ) : null}
        {href ? (
          <span className="mt-1 block text-xs text-primary">Open to deal with it →</span>
        ) : null}
      </span>
    </>
  );

  return (
    <RowShell
      item={item}
      href={href}
      onOpen={() => { if (unread) markMutation.mutate(); }}
    >
      {href ? contents : <div className="flex min-w-0 flex-1 gap-3">{contents}</div>}
      {error ? (
        <div className="mt-2">
          <ErrorCard title="Could not mark as read" error={error} />
        </div>
      ) : null}
      <span className="flex shrink-0 gap-2">
        {unread ? (
          <Button
            variant="secondary"
            loading={markMutation.isPending}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); markMutation.mutate(); }}
          >
            Mark read
          </Button>
        ) : (
          <span className="px-2 py-2 text-xs text-text-subtle">Read</span>
        )}
      </span>
    </RowShell>
  );
}

/** A timestamp in the reader's own clock, which is the one they compare against. */
function when(value: unknown): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  // One format across the application (lib/finance): DD-MMM-YYYY HH:MM.
  return dayTime(d);
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
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm text-text-muted">
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
        <p role="status" className="text-sm text-success">
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
              <p className="text-xs text-text-muted">End of inbox ({accumulated.length} shown).</p>
            )}
            {pageQuery.isFetching && <Spinner size="sm" />}
          </div>
        </>
      )}
      <p className="text-xs text-text-subtle">Polls every 60s for new notifications.</p>
    </div>
  );
}

import { apiRequest, apiRequestRaw } from './apiClient';

/**
 * S5 inbox client (frozen contract).
 *
 *   GET   /api/v1/notifications?unread=&limit=&cursor= → {data:[{id,type,title,body,entity_type,entity_id,read_at,created_at}]}
 *   PATCH /api/v1/notifications/:id/read → 200
 *   POST  /api/v1/notifications/read-all → 200 {marked}
 *
 * List responses tolerate `{data:[...],next_cursor,has_more}` and bare
 * arrays. Pagination siblings are read from the RAW envelope (see
 * apiRequestRaw) because the standard unwrap discards them. The AppShell
 * badge and inbox page poll with `refetchInterval: 60_000`.
 */

export interface InboxItem {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  read_at?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface InboxPage {
  items: InboxItem[];
  next_cursor: string | null;
  has_more: boolean;
  request_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize an inbox payload tolerating `{data:[...],next_cursor,has_more}`
 * and bare arrays. `has_more`/`next_cursor` may also ride inside one extra
 * `{data:{...}}` level — both are checked.
 */
export function normalizeInboxPage(body: unknown): InboxPage {
  if (Array.isArray(body)) return { items: body as InboxItem[], next_cursor: null, has_more: false };
  if (isRecord(body)) {
    const nested = 'data' in body ? (body as { data: unknown }).data : undefined;
    const items = Array.isArray(nested)
      ? (nested as InboxItem[])
      : Array.isArray(body)
        ? (body as unknown as InboxItem[])
        : [];
    const rec = body as Record<string, unknown>;
    const inner = isRecord(nested) ? (nested as Record<string, unknown>) : null;
    const nextCursor =
      typeof rec.next_cursor === 'string'
        ? rec.next_cursor
        : inner && typeof inner.next_cursor === 'string'
          ? (inner.next_cursor as string)
          : null;
    const hasMore =
      rec.has_more === true || (inner ? inner.has_more === true : false);
    return { items, next_cursor: nextCursor, has_more: hasMore };
  }
  return { items: [], next_cursor: null, has_more: false };
}

export interface ListInboxParams {
  unread?: boolean;
  limit?: number;
  cursor?: string | null;
}

export function buildInboxQuery(params: ListInboxParams = {}): string {
  const search = new URLSearchParams();
  if (params.unread !== undefined) search.set('unread', params.unread ? 'true' : 'false');
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/v1/notifications${qs ? `?${qs}` : ''}`;
}

export async function listInbox(params: ListInboxParams = {}): Promise<InboxPage> {
  const raw = await apiRequestRaw(buildInboxQuery(params), { method: 'GET' });
  return { ...normalizeInboxPage(raw.body), request_id: raw.requestId };
}

export async function markInboxRead(id: string): Promise<InboxItem> {
  const { data } = await apiRequest<unknown>(
    `/api/v1/notifications/${encodeURIComponent(id)}/read`,
    { method: 'PATCH' },
  );
  const raw = ((): unknown => {
    if (isRecord(data)) {
      if (typeof data.id === 'string') return data;
      if (isRecord(data.notification)) return data.notification;
    }
    return data;
  })();
  return (isRecord(raw) && typeof raw.id === 'string' ? raw : { id }) as InboxItem;
}

export async function markAllInboxRead(): Promise<{ marked: number }> {
  const { data } = await apiRequest<unknown>('/api/v1/notifications/read-all', {
    method: 'POST',
    body: {},
  });
  if (isRecord(data) && typeof data.marked === 'number') return { marked: data.marked };
  if (typeof data === 'number') return { marked: data };
  return { marked: 0 };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** True when the item is still unread (`read_at` absent). */
export function isUnread(item: Pick<InboxItem, 'read_at'>): boolean {
  return item.read_at == null;
}

/**
 * Unread-dot visibility for the AppShell badge / inbox header: show the "•"
 * dot when the `limit=1&unread=true` probe returns any row OR `has_more`.
 * Never renders an exact count (the probe is capped at 1 by design).
 */
export function unreadDotVisible(itemCount: number, hasMore?: boolean): boolean {
  return itemCount > 0 || hasMore === true;
}

/** Page-level alias: dot when the inbox page holds any unread row. */
export function hasUnreadDot(page: Pick<InboxPage, 'items' | 'has_more'>): boolean {
  return unreadDotVisible(page.items.length, page.has_more);
}

/**
 * Direct entity href for inbox rows that need no extra fetch:
 *   LEAVE_* → /leave/:entity_id
 * Task rows return null — the caller resolves the project via getTask and
 * links to /projects/:projectId/tasks/:taskId (see InboxList).
 */
export function inboxEntityHref(
  item: Pick<InboxItem, 'entity_type' | 'entity_id'>,
): string | null {
  const type = String(item.entity_type ?? '').toUpperCase();
  if (!item.entity_id) return null;
  if (type === 'LEAVE' || type === 'LEAVE_REQUEST' || type === 'LEAVE_REQUESTS') {
    return `/leave/${item.entity_id}`;
  }
  return null;
}

'use client';

import Link from 'next/link';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/finance/Primitives';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { apiRequestRaw } from '@/lib/apiClient';
import { peopleIndex, personLabel, listPeople } from '@/lib/people';
import { dayTime } from '@/lib/finance';
import { auditQuery } from '@/lib/admin-forms';

/**
 * The audit trail (§note 6).
 *
 * Every change the system records has been written to audit_events since the
 * beginning, and there was nowhere to read it: the API served it and the only
 * way to see it was an export from Reports, which nobody hunting for "who
 * changed this" would think to open. A trail nobody can read is a trail that
 * settles no argument.
 *
 * Read-only by construction — there is no endpoint that edits or deletes an
 * entry, and there should not be. An audit trail somebody can tidy up is
 * worth nothing at the moment it matters.
 */

type Row = Record<string, any>;

export default function AuditPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canRead = hasPermission(perms, 'audit.read');

  const [action, setAction] = React.useState('');
  const [entity, setEntity] = React.useState('');
  /*
   * The two questions a trail is actually consulted for -- what did this
   * person do, what happened to this record -- and a span of days to ask
   * them over. The API has taken these for a while; the screen offered
   * only the action and the entity type, which left both questions to be
   * answered by paging through everything.
   */
  const [actorId, setActorId] = React.useState('');
  const [entityId, setEntityId] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [pages, setPages] = React.useState<string[]>([]);

  const cursor = pages[pages.length - 1] ?? '';
  const filtered = Boolean(action || entity || actorId || entityId || from || to);

  const events = useQuery({
    queryKey: ['audit', action, entity, actorId, entityId, from, to, cursor],
    enabled: canRead,
    queryFn: async () =>
      (await apiRequestRaw(`/api/v1/audit?${auditQuery({ action, entity, actorId, entityId, from, to, cursor })}`)).body as Row,
  });

  // Names, not identifiers: an actor id answers nobody's question.
  const people = useQuery({
    queryKey: ['people'], queryFn: listPeople, staleTime: 300_000, enabled: canRead,
  });
  const peopleIdx = React.useMemo(() => peopleIndex(people.data ?? []), [people.data]);

  if (!canRead) {
    return (
      <AppShell>
        <PageHeader title="Audit trail" />
        <PageBody>
          <Notice tone="info" title="You do not have access to the audit trail">
            This screen needs the <code>audit.read</code> permission. It is held by
            administrators and auditors, because a trail that everybody can read is a trail
            that tells everybody what everybody else has been doing.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  const rows: Row[] = events.data?.data ?? [];
  const hasMore = Boolean(events.data?.has_more ?? events.data?.next_cursor);
  const nextCursor = events.data?.next_cursor;

  const reset = (fn: () => void) => { fn(); setPages([]); };

  return (
    <AppShell>
      <PageHeader
        title="Audit trail"
        description="Every recorded change, in the order it happened, with who made it."
        breadcrumb={<Link href="/admin" className="hover:underline">Administration</Link>}
      />
      <PageBody>
        <div className="space-y-4">
          <Toolbar>
            <input
              value={action}
              onChange={(e) => reset(() => setAction(e.target.value))}
              placeholder="Action, e.g. asset.transfer"
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            />
            <input
              value={entity}
              onChange={(e) => reset(() => setEntity(e.target.value))}
              placeholder="Entity, e.g. asset"
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            />
            <select
              aria-label="Who"
              value={actorId}
              onChange={(e) => reset(() => setActorId(e.target.value))}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            >
              <option value="">Anybody</option>
              {(people.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input
              value={entityId}
              onChange={(e) => reset(() => setEntityId(e.target.value))}
              placeholder="Record id"
              aria-label="Record id"
              className="w-40 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text"
            />
            <label className="flex items-center gap-1 text-xs text-text-muted">
              From
              <input type="date" value={from} max={to || undefined}
                onChange={(e) => reset(() => setFrom(e.target.value))}
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text" />
            </label>
            <label className="flex items-center gap-1 text-xs text-text-muted">
              to
              <input type="date" value={to} min={from || undefined}
                onChange={(e) => reset(() => setTo(e.target.value))}
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text" />
            </label>
            {filtered ? (
              <Button type="button" variant="ghost"
                onClick={() => reset(() => { setAction(''); setEntity(''); setActorId(''); setEntityId(''); setFrom(''); setTo(''); })}>
                Clear
              </Button>
            ) : null}
            <Link href="/reports" className="ml-auto">
              <Button type="button" variant="secondary">Export the trail</Button>
            </Link>
          </Toolbar>

          <p className="text-xs text-text-muted">
            {/* Said plainly, because the value of a trail is that it cannot be
                tidied up by whoever it is about. */}
            Entries cannot be edited or deleted, by anybody. What is here is what happened.
          </p>

          <ViewAsRegister />

          {events.isLoading ? <Skeleton className="h-64" /> : null}
          {events.isError ? (
            <ErrorCard error={events.error} onRetry={() => events.refetch()} />
          ) : null}

          {events.isSuccess && rows.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              description={filtered
                ? 'No entry matches those filters. Actions read like asset.transfer or survey.village.add; the days are calendar days in the organisation\u2019s timezone, both ends included.'
                : 'No changes have been recorded yet.'}
            />
          ) : null}

          {rows.length > 0 ? (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="px-4 py-2">When</th>
                    <th className="px-4 py-2">Who</th>
                    <th className="px-4 py-2">Did what</th>
                    <th className="px-4 py-2">To what</th>
                    <th className="px-4 py-2">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={String(r.id)} className="border-b border-border align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-text-muted tabular-nums">
                        {when(r.created_at)}
                      </td>
                      <td className="px-4 py-2">
                        <span className="text-text">
                          {r.actor_id
                            ? personLabel(peopleIdx, String(r.actor_id))
                            : <span className="text-text-subtle">the system</span>}
                        </span>
                        {/* §075. The row already named whoever the system
                            believed was acting; this says when somebody
                            else was holding their session at the time.
                            Without it the trail quietly misattributes. */}
                        {r.impersonator_username ? (
                          <div className="text-2xs text-warning">
                            {String(r.impersonator_username)} was viewing as them
                          </div>
                        ) : null}
                        {r.actor_ip ? (
                          <div className="text-2xs text-text-subtle">{String(r.actor_ip)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={tone(String(r.action))}>{String(r.action)}</Badge>
                      </td>
                      <td className="px-4 py-2 text-text-muted">
                        {String(r.entity_type ?? '—')}
                        {r.entity_id ? (
                          <div className="font-mono text-2xs text-text-subtle"
                            title={String(r.entity_id)}>
                            {String(r.entity_id).slice(0, 8)}…
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-2xs text-text-muted">
                        {r.reason ? String(r.reason) : <Change row={r} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}

          {rows.length > 0 ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" disabled={pages.length === 0}
                onClick={() => setPages(pages.slice(0, -1))}>
                Newer
              </Button>
              <Button type="button" variant="ghost" disabled={!hasMore || !nextCursor}
                onClick={() => setPages([...pages, String(nextCursor)])}>
                Older
              </Button>
              <span className="text-2xs text-text-subtle">
                {rows.length} entries{pages.length > 0 ? `, page ${pages.length + 1}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      </PageBody>
    </AppShell>
  );
}

/**
 * What actually changed, when the entry carries it.
 *
 * Only the fields that differ. Printing the whole before and after state
 * makes every row a wall of JSON, and the one field somebody is looking for
 * is buried in forty that did not move.
 */
function Change({ row }: { row: Row }) {
  const before = (row.before_state ?? {}) as Record<string, unknown>;
  const after = (row.after_state ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .slice(0, 4);

  if (keys.length === 0) return <span className="text-text-subtle">—</span>;

  return (
    <span>
      {keys.map((k) => (
        <span key={k} className="mr-2">
          <span className="text-text-subtle">{k}</span>{' '}
          {k in before ? <span className="line-through">{show(before[k])}</span> : null}
          {k in after ? <span className="text-text"> {show(after[k])}</span> : null}
        </span>
      ))}
    </span>
  );
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Destructive actions read differently from routine ones, at a glance. */
function tone(action: string): 'danger' | 'warning' | 'neutral' {
  if (/delete|revoke|disable|exit|write_off|lost/i.test(action)) return 'danger';
  if (/update|transfer|release|move|reset|password|mfa/i.test(action)) return 'warning';
  return 'neutral';
}

function when(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  // The reader's own clock, which is the one they are comparing against.
  // One format across the application (lib/finance): DD-MMM-YYYY HH:MM.
  return dayTime(d);
}

/**
 * Who has been looking through whose eyes (§075).
 *
 * Kept collapsed, because on most days it is empty and an empty table above
 * the trail is noise. The count in the summary is the thing worth seeing
 * without opening it.
 */
function ViewAsRegister() {
  const register = useQuery({
    queryKey: ['audit', 'view-as'],
    queryFn: async () =>
      (await apiRequestRaw('/api/v1/audit/view-as?limit=50')).body as Row,
  });
  const rows: Row[] = register.data?.data ?? [];
  const live = rows.filter((r) => r.live).length;

  if (register.isLoading || rows.length === 0) return null;

  return (
    <details className="rounded-md border border-border bg-surface">
      <summary className="cursor-pointer px-4 py-2 text-sm text-text">
        View-as sessions
        <span className="ml-2 text-xs text-text-muted">
          {rows.length} recorded
          {live > 0 ? <span className="text-warning"> · {live} open now</span> : null}
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted">
              <th className="px-4 py-2">Started</th>
              <th className="px-4 py-2">Who</th>
              <th className="px-4 py-2">Viewed as</th>
              <th className="px-4 py-2">Why</th>
              <th className="px-4 py-2">Changes made</th>
              <th className="px-4 py-2">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="border-b border-border align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-2 text-text-muted tabular-nums">
                  {when(r.started_at)}
                </td>
                <td className="px-4 py-2 text-text">{String(r.actor_username)}</td>
                <td className="px-4 py-2 text-text">{String(r.subject_username)}</td>
                <td className="px-4 py-2 text-2xs text-text-muted">{String(r.reason ?? '—')}</td>
                <td className="px-4 py-2 tabular-nums">
                  {/* A session that looked and left is ordinary. One that
                      changed things is the one to ask about. */}
                  {Number(r.writes) > 0
                    ? <Badge tone="warning">{String(r.writes)}</Badge>
                    : <span className="text-text-subtle">none</span>}
                </td>
                <td className="px-4 py-2 text-2xs">
                  {r.live
                    ? <Badge tone="warning">open now</Badge>
                    : <span className="text-text-subtle">
                        {r.ended_at ? `ended ${when(r.ended_at)}` : 'expired'}
                      </span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/finance/Primitives';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';

/**
 * Who is locked out, and one place to let them back in (§note 16).
 *
 * Resetting a password was already possible and nobody could find it: you had
 * to know to click a row in the Users table before the panel holding it
 * appeared. Meanwhile the requests from people who could not sign in were
 * recorded, notified, and then lived nowhere anybody could look — an alert
 * scrolls out of an inbox, and "I raised it on Tuesday" needs somewhere to
 * check.
 *
 * Setting the password here closes the request, because the thing they asked
 * for has happened and a queue that never empties stops being believed.
 */
type Row = Record<string, unknown>;

export function PasswordResetQueue() {
  const qc = useQueryClient();
  const toast = useToast();
  const [openFor, setOpenFor] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState('');
  const [askThemToChange, setAskThemToChange] = React.useState(true);

  const queue = useQuery({
    queryKey: ['password-reset-requests'],
    refetchInterval: 120_000,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/admin/password-reset-requests'))
        .body as { data: Row[] }).data,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['password-reset-requests'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  const reset = useMutation({
    mutationFn: async (r: Row) => apiRequest(`/api/v1/admin/users/${r.user_id}`, {
      method: 'PATCH',
      body: { password, must_change_password: askThemToChange },
    }),
    onError: (e) => toast.error('The password was not changed', messageOf(e)),
    onSuccess: (_d, r) => {
      toast.success(
        `New password set for ${String(r.name)}`,
        askThemToChange
          ? 'Tell them what it is — they will be asked to choose their own on the way in.'
          : 'Tell them what it is. Their other sessions have been signed out.',
      );
      setOpenFor(null);
      setPassword('');
      refresh();
    },
  });

  const dismiss = useMutation({
    mutationFn: async ({ id, resolution }: { id: string; resolution: string }) =>
      apiRequest(`/api/v1/admin/password-reset-requests/${id}/resolve`, {
        method: 'POST', body: { resolution },
      }),
    onError: (e) => toast.error('The request was not closed', messageOf(e)),
    onSuccess: () => { toast.success('Closed'); refresh(); },
  });

  const rows = queue.data ?? [];
  const field = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Locked out and waiting</h2>
        {rows.length > 0 ? <Badge tone="warning">{rows.length}</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-text-muted">
        People who asked for their password to be reset. Set a new one here and tell them
        what it is — there is no email in the field, so somebody has to say it out loud.
      </p>

      {queue.isLoading ? <Skeleton className="mt-3 h-24" /> : null}
      {queue.isError ? (
        <div className="mt-3">
          <ErrorCard error={queue.error} onRetry={() => queue.refetch()} />
        </div>
      ) : null}

      {queue.isSuccess && rows.length === 0 ? (
        <div className="mt-3">
          <EmptyState title="Nobody is waiting" description="Nothing to do here." />
        </div>
      ) : null}

      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li key={String(r.id)} className="rounded-md border border-border bg-surface-sunken p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium text-text">{String(r.name)}</span>
              {r.emp_no ? (
                <span className="font-mono text-2xs text-text-subtle">{String(r.emp_no)}</span>
              ) : null}
              <span className="text-2xs text-text-subtle">
                signed in as {String(r.username)}
                {r.phone ? ` · ${String(r.phone)}` : ''}
              </span>
              <span className="ml-auto text-2xs text-text-subtle">
                asked {when(r.requested_at)}
              </span>
            </div>
            {r.reports_to_name ? (
              <p className="mt-0.5 text-2xs text-text-subtle">
                {/* Nearest first: they are most likely to know it is genuine. */}
                Reports to {String(r.reports_to_name)}
              </p>
            ) : null}

            {openFor === String(r.id) ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-2xs text-text-muted">
                  New password (12 characters or more)
                  <input className={field} type="text" value={password} minLength={12}
                    onChange={(e) => setPassword(e.target.value)} />
                </label>
                <label className="flex items-center gap-1.5 text-2xs text-text-muted">
                  <input type="checkbox" checked={askThemToChange}
                    onChange={(e) => setAskThemToChange(e.target.checked)} />
                  Ask them to choose their own on the way in
                </label>
                <Button type="button" disabled={password.length < 12 || reset.isPending}
                  onClick={() => reset.mutate(r)}>
                  Set it
                </Button>
                <Button type="button" variant="ghost" onClick={() => { setOpenFor(null); setPassword(''); }}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="secondary"
                  onClick={() => { setOpenFor(String(r.id)); setPassword(''); }}>
                  Reset their password
                </Button>
                {/* Not every request is genuine, and not every one still
                    matters by the time somebody reads it. */}
                <Button type="button" variant="ghost" disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate({ id: String(r.id), resolution: 'STALE' })}>
                  Already sorted
                </Button>
                <Button type="button" variant="ghost" disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate({ id: String(r.id), resolution: 'DECLINED' })}>
                  Not them
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {rows.length > 0 ? (
        <div className="mt-3">
          <Notice tone="info" title="A password set here is one you know">
            Hand it over in person or by phone, and leave the box above ticked so they
            replace it with something only they know.
          </Notice>
        </div>
      ) : null}
    </section>
  );
}

function when(value: unknown): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

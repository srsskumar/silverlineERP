'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/finance/Primitives';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';

/**
 * Who sees the whole organisation, and who sees their own work (§note 17).
 *
 * The machinery to restrict somebody has always been there — a role
 * assignment carries a scope and every list honours it. What was missing was
 * a default: a role row with no scope meant the whole organisation, so the
 * safe setting was the one somebody had to remember to apply.
 *
 * Configurable because the answer differs. A contractor running one district
 * wants its project managers to see everything; one running six does not.
 */
type Row = Record<string, unknown>;

export function RoleVisibility() {
  const qc = useQueryClient();
  const toast = useToast();

  const roles = useQuery({
    queryKey: ['role-visibility'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/admin/role-visibility')).body as { data: Row[] }).data,
  });

  const change = useMutation({
    mutationFn: async ({ code, scope }: { code: string; scope: string }) =>
      apiRequest(`/api/v1/admin/role-visibility/${code}`, {
        method: 'PUT', body: { default_scope: scope },
      }),
    onError: (e) => toast.error('The setting was not changed', messageOf(e)),
    onSuccess: (_d, v) => {
      toast.success(
        v.scope === 'ASSIGNED'
          ? `${v.code} now sees only their own work`
          : `${v.code} now sees the whole organisation`,
        'Anybody holding that role has been signed out, so the change takes effect the next '
        + 'time they sign in rather than tomorrow.',
      );
      void qc.invalidateQueries({ queryKey: ['role-visibility'] });
    },
  });

  const rows = roles.data ?? [];

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-text">What each role can see</h2>
      <p className="mt-1 text-xs text-text-muted">
        Applies to the projects and tasks that appear in lists. What somebody may then do to
        one is decided by the permissions their role holds, not by this.
      </p>

      {roles.isLoading ? <Skeleton className="mt-3 h-40" /> : null}
      {roles.isError ? (
        <div className="mt-3"><ErrorCard error={roles.error} onRetry={() => roles.refetch()} /></div>
      ) : null}

      <ul className="mt-3 divide-y divide-border">
        {rows.map((r) => {
          const assigned = String(r.default_scope) === 'ASSIGNED';
          const code = String(r.code);
          return (
            <li key={code} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="text-sm text-text">{String(r.name ?? code)}</span>
                <span className="ml-2 font-mono text-2xs text-text-subtle">{code}</span>
                <span className="block text-2xs text-text-subtle">
                  {Number(r.accounts)} account(s)
                  {Number(r.individually_scoped) > 0
                    ? `, ${Number(r.individually_scoped)} with a scope set individually — those are left alone`
                    : ''}
                </span>
              </span>
              <Badge tone={assigned ? 'warning' : 'neutral'}>
                {assigned ? 'Their own work' : 'Whole organisation'}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={change.isPending}
                onClick={() => change.mutate({
                  code, scope: assigned ? 'GLOBAL' : 'ASSIGNED',
                })}
              >
                {assigned ? 'Let them see everything' : 'Restrict to their own work'}
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3">
        <Notice tone="info" title="Their own work means more than the tasks assigned to them">
          A person sees a task assigned to them, one they were added to help with, one they
          were mentioned in, and every task on a project they manage. Otherwise a project
          manager restricted to their own work would see the one task somebody happened to
          assign them and none of the project they run.
        </Notice>
      </div>
    </section>
  );
}

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
 * Which screens a role sees, on top of what its permissions already allow
 * (owner request, 2026-09-24: "let admin/superadmin decide what to be
 * visible for field employees based on their role").
 *
 * This is display only, laid on top of the real permission system, never a
 * replacement for it. Hiding "Billing" here never removes rabill.read from
 * a role that holds it -- the API route stays exactly as guarded as it
 * always was, and calling it directly still answers normally. What changes
 * is only whether the web and mobile shells offer the link.
 */
type Row = Record<string, unknown>;
interface ModuleVisibilityData {
  roles: Row[];
  modules: Row[];
  cells: Row[];
}

export function ModuleVisibility() {
  const qc = useQueryClient();
  const toast = useToast();
  const [roleCode, setRoleCode] = React.useState<string>('');

  const query = useQuery({
    queryKey: ['module-visibility'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/admin/module-visibility')).body as { data: ModuleVisibilityData }).data,
  });

  const change = useMutation({
    mutationFn: async (v: { role_code: string; module_code: string; visible: boolean | null }) =>
      apiRequest('/api/v1/admin/module-visibility', { method: 'PUT', body: v }),
    onError: (e) => toast.error('The setting was not changed', messageOf(e)),
    onSuccess: (_d, v) => {
      toast.success(
        v.visible === null
          ? `${v.module_code} now follows its default for ${v.role_code}`
          : `${v.module_code} is now ${v.visible ? 'shown' : 'hidden'} for ${v.role_code}`,
      );
      void qc.invalidateQueries({ queryKey: ['module-visibility'] });
    },
  });

  const roles = query.data?.roles ?? [];
  const modules = query.data?.modules ?? [];
  const cells = query.data?.cells ?? [];
  const activeRole = roleCode || String(roles[0]?.code ?? '');

  const rows = modules.map((m) => {
    const cell = cells.find((c) => c.role_code === activeRole && c.module_code === m.code);
    return { ...m, ...cell };
  });

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-text">Which screens each role sees</h2>
      <p className="mt-1 text-xs text-text-muted">
        A screen hidden here is a link the app stops offering, nothing more. A role that still
        holds the permission a hidden screen is named after keeps that permission everywhere
        else -- this only decides what the sidebar shows.
      </p>

      {query.isLoading ? <Skeleton className="mt-3 h-40" /> : null}
      {query.isError ? (
        <div className="mt-3"><ErrorCard error={query.error} onRetry={() => query.refetch()} /></div>
      ) : null}

      {roles.length ? (
        <div className="mt-3">
          <label className="text-xs text-text-muted" htmlFor="module-visibility-role">Role</label>
          <select
            id="module-visibility-role"
            className="ml-2 rounded border border-border bg-surface px-2 py-1 text-sm text-text"
            value={activeRole}
            onChange={(e) => setRoleCode(e.target.value)}
          >
            {roles.map((r) => (
              <option key={String(r.code)} value={String(r.code)}>
                {String(r.name ?? r.code)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <ul className="mt-3 divide-y divide-border">
        {rows.map((row) => {
          const code = String(row.code);
          const visible = Boolean(row.visible);
          const isOverride = row.source === 'override';
          return (
            <li key={code} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="text-sm text-text">{String(row.label ?? code)}</span>
                <span className="ml-2 font-mono text-2xs text-text-subtle">{code}</span>
                <span className="block text-2xs text-text-subtle">
                  {String(row.group ?? '')}
                  {isOverride
                    ? ` · manually ${visible ? 'shown' : 'hidden'}`
                    : row.permission
                      ? ` · ${visible ? 'on' : 'off'} by default via ${String(row.permission)}`
                      : ' · always shown once signed in'}
                </span>
              </span>
              <Badge tone={visible ? 'neutral' : 'warning'}>{visible ? 'Visible' : 'Hidden'}</Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={change.isPending || !activeRole}
                onClick={() => change.mutate({ role_code: activeRole, module_code: code, visible: !visible })}
              >
                {visible ? 'Hide' : 'Show'}
              </Button>
              {isOverride ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={change.isPending || !activeRole}
                  onClick={() => change.mutate({ role_code: activeRole, module_code: code, visible: null })}
                >
                  Revert to default
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="mt-3">
        <Notice tone="info" title="This is a display setting, not a permission">
          Hiding a screen never takes away what a role can do -- it only stops the app offering
          the link. Whether somebody may act is still decided entirely by the permissions their
          role holds and the scope those permissions run in.
        </Notice>
      </div>
    </section>
  );
}

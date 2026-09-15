'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { listProjects } from '@/lib/projects';
import { listWorkspaces } from '@/lib/projects';
import { queryKeys } from '@/lib/query-keys';
import { PROJECT_STATUSES } from '@/lib/validation';
import { ProjectStatusBadge } from '@/components/ProjectStatusBadge';
import { Badge } from '@/components/ui/Badge';
import { moneyIndian } from '@/lib/finance';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

export default function ProjectsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PROJECT_READ}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-text">Projects</h1>
            <p className="mt-1 text-sm text-text-muted">Delivery projects grouped by workspace.</p>
          </div>
          <NewProjectLink />
        </div>
        <div className="mt-6">
          <ProjectsTable />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

function NewProjectLink() {
  const { session } = useAuth();
  if (!hasPermission({ permissions: session?.permissions }, PERMISSIONS.PROJECT_CREATE)) return null;
  return (
    <Link href="/projects/new">
      <Button>+ New project</Button>
    </Link>
  );
}

function ProjectsTable() {
  const { session } = useAuth();
  const canReadWorkspaces = hasPermission({ permissions: session?.permissions }, PERMISSIONS.WORKSPACE_READ);
  const [status, setStatus] = React.useState('');
  const [workspaceId, setWorkspaceId] = React.useState('');
  const [q, setQ] = React.useState('');

  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspaces.list({}),
    queryFn: listWorkspaces,
    staleTime: 10 * 60_000,
    enabled: canReadWorkspaces,
    retry: false,
  });

  const params = React.useMemo(
    () => ({
      status: status || undefined,
      workspace_id: workspaceId || undefined,
      q: q.trim() || undefined,
    }),
    [status, workspaceId, q],
  );

  const listQuery = useQuery({
    queryKey: queryKeys.projects.list(params),
    queryFn: () => listProjects(params),
    staleTime: 30_000,
  });

  const rows = listQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-end">
        <div>
          <label htmlFor="projects-status" className="text-sm font-medium text-text-muted">Status</label>
          <select id="projects-status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        {canReadWorkspaces && (
          <div>
            <label htmlFor="projects-workspace" className="text-sm font-medium text-text-muted">Workspace</label>
            <select
              id="projects-workspace"
              className={inputClass}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              <option value="">All</option>
              {(workspacesQuery.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex-1">
          <label htmlFor="projects-q" className="text-sm font-medium text-text-muted">Search</label>
          <input
            id="projects-q"
            className={inputClass}
            placeholder="Code or name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load projects" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No projects" description="Nothing matches these filters yet — create the first project to get started." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border bg-surface text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Code</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Name</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Track</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Status</th>
                <th className="px-3 py-2 text-right font-medium text-text-muted">Contract value</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Priority</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-mono text-xs text-text">{p.code}</td>
                  <td className="px-3 py-2 text-text">{p.name}</td>
                  <td className="px-3 py-2">
                    <ProjectKindBadge kind={p.project_kind as string | null} tenderId={p.tender_id as string | null} />
                  </td>
                  <td className="px-3 py-2">
                    <ProjectStatusBadge status={String(p.status)} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-muted">
                    {moneyIndian(p.contract_value)}
                  </td>
                  <td className="px-3 py-2 text-text-muted">{p.priority ? String(p.priority) : '—'}</td>
                  <td className="px-3 py-2">
                    <Link href={`/projects/${p.id}`} className="text-primary hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!listQuery.isLoading && !listQuery.isError && (
        <p className="text-xs text-text-muted">{rows.length} project{rows.length === 1 ? '' : 's'} shown.</p>
      )}
    </div>
  );
}

/**
 * Government or private (§8, §8.8).
 *
 * A project converted from a tender is marked as such: it is the difference
 * between a job with a work order and statutory deductions behind it and one
 * negotiated directly, and it decides which documents anybody should expect
 * to find attached.
 */
function ProjectKindBadge({ kind, tenderId }: { kind: string | null; tenderId: string | null }) {
  if (!kind) return <span className="text-xs text-text-subtle">—</span>;
  return (
    <span className="flex items-center gap-1.5">
      <Badge tone={kind === 'GOVERNMENT' ? 'info' : 'neutral'} size="sm">
        {kind === 'GOVERNMENT' ? 'Government' : 'Private'}
      </Badge>
      {tenderId ? <span className="text-2xs text-text-subtle">tendered</span> : null}
    </span>
  );
}

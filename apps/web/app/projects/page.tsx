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
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

export default function ProjectsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PROJECT_READ}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Projects</h1>
            <p className="mt-1 text-sm text-slate-500">Delivery projects grouped by workspace.</p>
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
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-end">
        <div>
          <label htmlFor="projects-status" className="text-sm font-medium text-slate-700">Status</label>
          <select id="projects-status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        {canReadWorkspaces && (
          <div>
            <label htmlFor="projects-workspace" className="text-sm font-medium text-slate-700">Workspace</label>
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
          <label htmlFor="projects-q" className="text-sm font-medium text-slate-700">Search</label>
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
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Code</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Name</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Priority</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-800">{p.code}</td>
                  <td className="px-3 py-2 text-slate-800">{p.name}</td>
                  <td className="px-3 py-2">
                    <ProjectStatusBadge status={String(p.status)} />
                  </td>
                  <td className="px-3 py-2 text-slate-700">{p.priority ? String(p.priority) : '—'}</td>
                  <td className="px-3 py-2">
                    <Link href={`/projects/${p.id}`} className="text-brand-600 hover:underline">
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
        <p className="text-xs text-slate-500">{rows.length} project{rows.length === 1 ? '' : 's'} shown.</p>
      )}
    </div>
  );
}

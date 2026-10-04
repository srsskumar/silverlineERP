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
import { Input } from '@/components/ui/Input';
import { NativeSelect } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, TableWrap, THead, TBody, TR, TH, TD, SortableTH } from '@/components/ui/Table';
import { useSort } from '@/lib/useSort';

export const dynamic = 'force-static';

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
  type ProjectSortKey = 'code' | 'name' | 'track' | 'status' | 'value' | 'priority';
  const { sorted: sortedRows, sort, onSort } = useSort<(typeof rows)[number], ProjectSortKey>(rows, (p, key) => {
    if (key === 'code') return p.code;
    if (key === 'name') return p.name;
    if (key === 'track') return p.project_kind as string | null;
    if (key === 'status') return p.status as string;
    if (key === 'value') return p.contract_value as unknown as number | string | null;
    return p.priority as string | null;
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-end">
        <div>
          <label htmlFor="projects-status" className="text-sm font-medium text-text-muted">Status</label>
          <NativeSelect id="projects-status" className="w-full" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </NativeSelect>
        </div>
        {canReadWorkspaces && (
          <div>
            <label htmlFor="projects-workspace" className="text-sm font-medium text-text-muted">Workspace</label>
            <NativeSelect
              id="projects-workspace"
              className="w-full"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              <option value="">All</option>
              {(workspacesQuery.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="flex-1">
          <label htmlFor="projects-q" className="text-sm font-medium text-text-muted">Search</label>
          <Input
            id="projects-q"
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
        <div className="rounded-lg border border-border">
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <SortableTH<ProjectSortKey> sortKey="code" sort={sort} onSort={onSort}>Code</SortableTH>
                  <SortableTH<ProjectSortKey> sortKey="name" sort={sort} onSort={onSort}>Name</SortableTH>
                  <SortableTH<ProjectSortKey> sortKey="track" sort={sort} onSort={onSort}>Track</SortableTH>
                  <SortableTH<ProjectSortKey> sortKey="status" sort={sort} onSort={onSort}>Status</SortableTH>
                  <SortableTH<ProjectSortKey> sortKey="value" sort={sort} onSort={onSort} align="right">Contract value</SortableTH>
                  <SortableTH<ProjectSortKey> sortKey="priority" sort={sort} onSort={onSort}>Priority</SortableTH>
                  <TH>Action</TH>
                </TR>
              </THead>
              <TBody>
                {sortedRows.map((p) => (
                  <TR key={p.id}>
                    <TD mono className="text-xs">{p.code}</TD>
                    <TD>{p.name}</TD>
                    <TD>
                      <ProjectKindBadge kind={p.project_kind as string | null} tenderId={p.tender_id as string | null} />
                    </TD>
                    <TD>
                      <ProjectStatusBadge status={String(p.status)} />
                    </TD>
                    <TD align="right" className="tabular-nums text-text-muted">
                      {moneyIndian(p.contract_value)}
                    </TD>
                    <TD tone="muted">{p.priority ? String(p.priority) : '—'}</TD>
                    <TD>
                      <Link href={`/projects/${p.id}`} className="text-primary hover:underline">
                        View
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
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

'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getProject, patchProject } from '@/lib/projects';
import { listTasksPage, type Task } from '@/lib/tasks';
import { queryKeys } from '@/lib/query-keys';
import { PROJECT_STATUSES } from '@/lib/validation';
import { shortUserId } from '@/components/ApprovalTimeline';
import { CloseProjectDialog } from '@/components/CloseProjectDialog';
import { ConflictDialog, useConflict } from '@/components/ConflictDialog';
import { FilterBar } from '@/components/FilterBar';
import { LabelPill } from '@/components/LabelPill';
import { ProjectStatusBadge } from '@/components/ProjectStatusBadge';
import { ProjectTabs } from '@/components/ProjectTabs';
import { QuickAddTask } from '@/components/QuickAddTask';
import { SlaBadge } from '@/components/SlaBadge';
import { TaskStatusBadge } from '@/components/TaskStatusBadge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiClientError } from '@/lib/apiClient';
import { isConflictError, requestIdOf } from '@/lib/form-errors';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value}</dd>
    </div>
  );
}

export function ProjectDetailView({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canUpdate = hasPermission(holder, PERMISSIONS.PROJECT_UPDATE);
  const canClose = hasPermission(holder, PERMISSIONS.PROJECT_CLOSE);
  const canCreateTask = hasPermission(holder, PERMISSIONS.TASK_CREATE);

  const [closeOpen, setCloseOpen] = React.useState(false);
  const conflict = useConflict();

  const detailQuery = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => getProject(id),
  });

  const refetchAll = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects.list() });
  }, [queryClient, id]);

  if (detailQuery.isLoading) {
    return (
      <AppShell>
        <Skeleton className="h-96 w-full" />
      </AppShell>
    );
  }
  if (detailQuery.isError) {
    return (
      <AppShell>
        <ErrorCard title="Could not load project" error={detailQuery.error} onRetry={() => detailQuery.refetch()} />
      </AppShell>
    );
  }
  const detail = detailQuery.data;
  if (!detail) {
    return (
      <AppShell>
        <EmptyState title="Project not found" />
      </AppShell>
    );
  }
  const { project, counts } = detail;

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PROJECT_READ}>
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  <span className="font-mono text-base">{project.code}</span>{' '}
                  <span className="text-lg font-semibold">{project.name}</span>
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ProjectStatusBadge status={String(project.status)} />
                  {project.priority ? (
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                      {String(project.priority)}
                    </span>
                  ) : null}
                  <span className="text-xs text-slate-500">v{project.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/projects" className="text-sm text-brand-600 hover:underline">
                  Back to projects
                </Link>
                {canClose && <Button variant="danger" onClick={() => setCloseOpen(true)}>Close project…</Button>}
              </div>
            </div>
            <div className="mt-4 border-t border-slate-100 pt-4">
              <ProjectTabs projectId={project.id} active="overview" />
            </div>
            <dl className="mt-4 divide-y divide-slate-100">
              <DetailRow label="Project ID" value={<span className="font-mono text-xs">{project.id}</span>} />
              <DetailRow label="Workspace" value={<span className="font-mono text-xs">{String(project.workspace_id)}</span>} />
              {project.project_type_id ? (
                <DetailRow label="Type" value={<span className="font-mono text-xs">{String(project.project_type_id)}</span>} />
              ) : null}
              <DetailRow
                label="Manager"
                value={
                  project.project_manager_id ? (
                    <span className="font-mono text-xs" title={String(project.project_manager_id)}>
                      {shortUserId(String(project.project_manager_id))}
                      <span className="ml-2 text-slate-400">(user id — no users directory in S4)</span>
                    </span>
                  ) : (
                    '—'
                  )
                }
              />
              <DetailRow label="Description" value={project.description ? String(project.description) : '—'} />
            </dl>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <CountCard label="Total tasks" value={counts.total} />
            <CountCard label="Open tasks" value={counts.open} tone={counts.open > 0 ? 'warning' : 'neutral'} />
            <CountCard label="Done tasks" value={counts.done} tone="success" />
          </div>

          {canUpdate && (
            <ProjectStatusPanel
              projectId={project.id}
              current={String(project.status)}
              version={project.version}
              onReload={refetchAll}
              conflictShow={conflict.show}
            />
          )}

          <section aria-label="Tasks" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Tasks</h2>
            <div className="mt-3">
              <ProjectTasksTable projectId={project.id} canCreateTask={canCreateTask} />
            </div>
          </section>
        </div>

        <CloseProjectDialog
          projectId={project.id}
          open={closeOpen}
          onClose={() => setCloseOpen(false)}
          onClosed={refetchAll}
        />
        <ConflictDialog
          open={conflict.open}
          message={conflict.conflict?.message}
          requestId={conflict.conflict?.requestId}
          onReload={refetchAll}
          onClose={conflict.hide}
        />
      </RequirePermission>
    </AppShell>
  );
}

function CountCard({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'warning' | 'success' }) {
  const toneClass = tone === 'warning' ? 'text-amber-700' : tone === 'success' ? 'text-green-700' : 'text-slate-900';
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}

/**
 * Project status change via PATCH + If-Match. The allowed matrix is
 * server-side (project-type workflow) — failures surface the server message.
 */
function ProjectStatusPanel({
  projectId,
  current,
  version,
  onReload,
  conflictShow,
}: {
  projectId: string;
  current: string;
  version: number | string;
  onReload: () => void;
  conflictShow: (message?: string, requestId?: string) => void;
}) {
  const [next, setNext] = React.useState(current);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => setNext(current), [current]);

  const mutation = useMutation({
    mutationFn: (status: string) => patchProject(projectId, { status }, version),
    onSuccess: () => {
      setError(null);
      onReload();
    },
    onError: (err) => {
      if (isConflictError(err)) {
        conflictShow(err instanceof Error ? err.message : undefined, requestIdOf(err));
        return;
      }
      setError(err);
    },
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
      <h2 className="text-sm font-semibold text-slate-900">Change status</h2>
      <p className="mt-1 text-xs text-slate-500">Allowed transitions are enforced by the server (project-type workflow).</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          aria-label="Project status"
          className={`${inputClass} sm:max-w-xs`}
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
            setError(null);
          }}
        >
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <Button disabled={next === current} loading={mutation.isPending} onClick={() => mutation.mutate(next)}>
          Save status (v{String(version)})
        </Button>
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorCard
            title={error instanceof ApiClientError ? `Could not change status (${error.code})` : 'Could not change status'}
            error={error}
          />
        </div>
      ) : null}
    </div>
  );
}

function ProjectTasksTable({ projectId, canCreateTask }: { projectId: string; canCreateTask: boolean }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState('');
  const [q, setQ] = React.useState('');
  const [mineOnly, setMineOnly] = React.useState(false);
  const [labelIds, setLabelIds] = React.useState<string[]>([]);
  const [sla, setSla] = React.useState('');
  const [extra, setExtra] = React.useState<import('@/lib/tasks').ListTasksParams>({});
  const [prepended, setPrepended] = React.useState<Task[]>([]);

  const params = React.useMemo(
    () => ({
      ...extra,
      project_id: projectId,
      status: status || undefined,
      q: q.trim() || undefined,
      assignee_me: mineOnly ? 'true' : undefined,
      label_ids: labelIds.length > 0 ? [...labelIds] : undefined,
      sla: sla || undefined,
    }),
    [projectId, status, q, mineOnly, labelIds, sla, extra],
  );

  const tasksQuery = useInfiniteQuery({
    queryKey: queryKeys.projects.projectTasks(projectId, params),
    queryFn: ({pageParam}) => listTasksPage({...params,limit:100,cursor:pageParam}),
    initialPageParam: undefined as string|undefined,
    getNextPageParam: last=>last.has_more?last.next_cursor??undefined:undefined,
    staleTime: 30_000,
  });

  React.useEffect(() => setPrepended([]), [projectId, status, q, mineOnly, labelIds, sla, extra]);

  const serverRows = tasksQuery.data?.pages.flatMap(p=>p.tasks) ?? [];
  const prependedFresh = prepended.filter((t) => !serverRows.some((s) => s.id === t.id));
  const rows = [...prependedFresh, ...serverRows];

  return (
    <div className="flex flex-col gap-4">
      {canCreateTask && (
        <QuickAddTask
          projectId={projectId}
          onCreated={(task) => {
            // Prepend immediately for a snappy UI; the invalidation below
            // reconciles with the server list (deduped by id).
            setPrepended((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]));
            void queryClient.invalidateQueries({ queryKey: queryKeys.projects.projectTasks(projectId) });
          }}
        />
      )}
      <FilterBar
        projectId={projectId}
        status={status}
        setStatus={setStatus}
        q={q}
        setQ={setQ}
        mineOnly={mineOnly}
        setMineOnly={setMineOnly}
        labelIds={labelIds}
        setLabelIds={setLabelIds}
        sla={sla}
        setSla={setSla}
        extra={extra}
        setExtra={setExtra}
        idPrefix={`pt-${projectId}`}
      />

      {tasksQuery.hasNextPage?<Button variant="secondary" loading={tasksQuery.isFetchingNextPage} onClick={()=>void tasksQuery.fetchNextPage()}>Load more tasks ({rows.length} shown)</Button>:null}
      {tasksQuery.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : tasksQuery.isError ? (
        <ErrorCard title="Could not load tasks" error={tasksQuery.error} onRetry={() => tasksQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No tasks" description="Use the quick-add bar above to create the first task." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Title</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">SLA</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Labels</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Assignee</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="max-w-xs truncate px-3 py-2 text-slate-800">
                    {t.parent_id ? <span className="mr-1 text-xs text-slate-400">↳</span> : null}
                    {t.title}
                  </td>
                  <td className="px-3 py-2">
                    <TaskStatusBadge status={String(t.status)} />
                  </td>
                  <td className="px-3 py-2">
                    <SlaBadge status={t.sla_status} />
                  </td>
                  <td className="px-3 py-2">
                    {(t.labels ?? []).length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {(t.labels ?? []).map((l) => (
                          <LabelPill key={l.id} label={l} />
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">
                    {t.assignee_id ? (
                      <span title={String(t.assignee_id)}>{shortUserId(String(t.assignee_id))}</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/projects/${projectId}/tasks/${t.id}`} className="text-brand-600 hover:underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


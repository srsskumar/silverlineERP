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
import { PROJECT_STATUS_TRANSITIONS } from '@silverline/shared';
import { statusLabel } from '@/lib/board-visuals';
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
import { Badge } from '@/components/ui/Badge';
import { money } from '@/lib/finance';
import { contractValueBreakdown, amountInWords } from '@silverline/shared';
import { isConflictError, requestIdOf } from '@/lib/form-errors';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm text-text">{value}</dd>
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
          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-text">
                  <span className="font-mono text-base">{project.code}</span>{' '}
                  <span className="text-lg font-semibold">{project.name}</span>
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ProjectStatusBadge status={String(project.status)} />
                  {project.project_kind ? (
                    <Badge tone={project.project_kind === 'GOVERNMENT' ? 'info' : 'neutral'} size="sm">
                      {project.project_kind === 'GOVERNMENT' ? 'Government' : 'Private'}
                    </Badge>
                  ) : null}
                  {project.priority ? (
                    <span className="rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text-muted">
                      {String(project.priority)}
                    </span>
                  ) : null}
                  <span className="text-xs text-text-muted">v{project.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/projects" className="text-sm text-primary hover:underline">
                  Back to projects
                </Link>
                {canUpdate && (
                  <Link
                    href={`/projects/edit?id=${project.id}`}
                    className="inline-flex h-8 items-center rounded border border-border bg-surface px-3 text-sm font-medium text-text shadow-sm hover:bg-surface-sunken"
                  >
                    Edit
                  </Link>
                )}
                {canClose && <Button variant="danger" onClick={() => setCloseOpen(true)}>Close project…</Button>}
              </div>
            </div>
            <div className="mt-4 border-t border-border pt-4">
              <ProjectTabs projectId={project.id} active="overview" />
            </div>
            <dl className="mt-4 divide-y divide-border">
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
                      <span className="ml-2 text-text-subtle">(user id — no users directory in S4)</span>
                    </span>
                  ) : (
                    '—'
                  )
                }
              />
              <DetailRow label="Description" value={project.description ? String(project.description) : '—'} />

              {/*
                The commercial facts (§8, §15.1). A project converted from a
                tender carries these across; one keyed in directly now can too.
                Without them the margin report at /billing has nothing to
                measure cost against.
              */}
              <DetailRow
                label="Track"
                value={
                  project.project_kind
                    ? (project.project_kind === 'GOVERNMENT' ? 'Government' : 'Private')
                    : <span className="text-text-subtle">Not set</span>
                }
              />
              <DetailRow
                label="Contract value"
                value={<ContractValue project={project as Record<string, unknown>} />}
              />
              {project.work_order_number ? (
                <DetailRow label="Work order" value={<span className="font-mono text-xs">{String(project.work_order_number)}</span>} />
              ) : null}
              {project.tender_id ? (
                <DetailRow
                  label="Won on tender"
                  value={
                    <Link href={`/tenders?open=${project.tender_id}`} className="text-primary hover:underline">
                      Open the tender
                    </Link>
                  }
                />
              ) : null}
              {project.contract_value ? (
                <DetailRow
                  label="Finance"
                  value={
                    <Link href="/billing" className="text-primary hover:underline">
                      Bills, retention and budget versus actual
                    </Link>
                  }
                />
              ) : null}
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

          <section aria-label="Tasks" className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Tasks</h2>
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
  const toneClass = tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-text';
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
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
  // Only the moves the workflow actually permits (§12.1). The dropdown used
  // to list every status, so a DRAFT project offered "Completed pending
  // close" — the server refused it, correctly, and the user saw an error for
  // a choice the screen had invited them to make.
  const allowed = PROJECT_STATUS_TRANSITIONS[current as keyof typeof PROJECT_STATUS_TRANSITIONS] ?? [];
  const [next, setNext] = React.useState<string>(allowed[0] ?? current);
  const [error, setError] = React.useState<unknown>(null);
  // The version the server last confirmed. Taken from the mutation response so
  // a second change in a row does not send the stale one and collide with the
  // write that just succeeded.
  const [liveVersion, setLiveVersion] = React.useState<number | string>(version);

  React.useEffect(() => {
    setNext(allowed[0] ?? current);
    setLiveVersion(version);
  }, [current, version]);

  const mutation = useMutation({
    mutationFn: (status: string) => patchProject(projectId, { status }, liveVersion),
    onSuccess: (updated) => {
      setError(null);
      if (updated && typeof updated.version === 'number') setLiveVersion(updated.version);
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
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
      <h2 className="text-sm font-semibold text-text">Change status</h2>
      <p className="mt-1 text-xs text-text-muted">Allowed transitions are enforced by the server (project-type workflow).</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          aria-label="Project status"
          className={`${inputClass} sm:max-w-xs`}
          value={next}
          disabled={allowed.length === 0}
          onChange={(e) => {
            setNext(e.target.value);
            setError(null);
          }}
        >
          {allowed.map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <Button
          disabled={allowed.length === 0 || next === current}
          loading={mutation.isPending}
          onClick={() => mutation.mutate(next)}
        >
          Save status
        </Button>
      </div>
      {allowed.length === 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          {statusLabel(current)} is a final state — there is nowhere further to move this project.
        </p>
      ) : null}
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
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border bg-surface text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Title</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Status</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">SLA</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Labels</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Assignee</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="max-w-xs truncate px-3 py-2 text-text">
                    {t.parent_id ? <span className="mr-1 text-xs text-text-subtle">↳</span> : null}
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
                      <span className="text-text-subtle">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {(t.labels ?? []).map((l) => (
                          <LabelPill key={l.id} label={l} />
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-text-muted">
                    {t.assignee_id ? (
                      <span title={String(t.assignee_id)}>{shortUserId(String(t.assignee_id))}</span>
                    ) : (
                      <span className="text-text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/projects/${projectId}/tasks/${t.id}`} className="text-primary hover:underline">
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

/**
 * The contract value, and what it is once GST is accounted for.
 *
 * Shown split because the figure on the order and the project's revenue are
 * different numbers whenever the quote was GST-inclusive, and the margin at
 * /billing is measured on the revenue.
 */
function ContractValue({ project }: { project: Record<string, unknown> }) {
  const amount = project.contract_value;
  if (amount === null || amount === undefined) {
    return <span className="text-text-subtle">Not recorded</span>;
  }
  const included = project.contract_gst_included;
  const rate = project.contract_gst_rate;
  if (included === null || included === undefined || rate === null || rate === undefined) {
    return (
      <span>
        <span className="tabular-nums">{money(amount)}</span>
        <span className="ml-2 text-2xs text-warning">GST treatment not stated</span>
      </span>
    );
  }
  const b = contractValueBreakdown({
    amount: Number(amount),
    gstIncluded: Boolean(included),
    ratePct: Number(rate),
  });
  return (
    <span className="block">
      <span className="tabular-nums">{money(b.gross)}</span>
      <span className="ml-2 text-2xs text-text-subtle">
        {money(b.net)} + {money(b.gst)} GST at {b.ratePct}%
      </span>
      <span className="mt-0.5 block text-2xs text-text-muted">{amountInWords(b.gross)}</span>
    </span>
  );
}

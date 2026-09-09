'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getTask, patchTask } from '@/lib/tasks';
import { queryKeys } from '@/lib/query-keys';
import { taskPatchSchema, type TaskPatchInput } from '@/lib/validation';
import { shortUserId } from '@/components/ApprovalTimeline';
import { AssignDialog } from '@/components/AssignDialog';
import { CommentThread } from '@/components/CommentThread';
import { ConflictDialog, useConflict } from '@/components/ConflictDialog';
import { DependencyManager } from '@/components/DependencyManager';
import { EvidenceList } from '@/components/EvidenceList';
import { LabelPill } from '@/components/LabelPill';
import { QuickAddTask } from '@/components/QuickAddTask';
import { SlaBadge } from '@/components/SlaBadge';
import { StatusTransitionSelect } from '@/components/StatusTransitionSelect';
import { TaskLabelToggle } from '@/components/TaskLabelToggle';
import { TaskStatusBadge } from '@/components/TaskStatusBadge';
import { WorkflowStepper } from '@/components/WorkflowStepper';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { applyFieldErrors, isConflictError, requestIdOf } from '@/lib/form-errors';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value}</dd>
    </div>
  );
}

export function TaskDetailView({ projectId, taskId }: { projectId: string; taskId: string }) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canUpdate = hasPermission(holder, PERMISSIONS.TASK_UPDATE);
  const canTransition = hasPermission(holder, PERMISSIONS.TASK_TRANSITION);
  const canAssign = hasPermission(holder, PERMISSIONS.TASK_ASSIGN);
  const canCreateTask = hasPermission(holder, PERMISSIONS.TASK_CREATE);
  const canComment = hasPermission(holder, PERMISSIONS.TASK_COMMENT);

  const [assignOpen, setAssignOpen] = React.useState(false);
  const conflict = useConflict();

  const detailQuery = useQuery({
    queryKey: queryKeys.tasks.detail(taskId),
    queryFn: () => getTask(taskId),
  });

  const refetchAll = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects.projectTasks(projectId) });
  }, [queryClient, taskId, projectId]);

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
        <ErrorCard title="Could not load task" error={detailQuery.error} onRetry={() => detailQuery.refetch()} />
      </AppShell>
    );
  }
  const detail = detailQuery.data;
  if (!detail) {
    return (
      <AppShell>
        <EmptyState title="Task not found" />
      </AppShell>
    );
  }
  const { task, subtasks, dependencies, allowed_next } = detail;

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.TASK_READ}>
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-slate-900">{task.title}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <TaskStatusBadge status={String(task.status)} />
                  <SlaBadge status={task.sla_status} />
                  {(task.labels ?? []).map((l) => (
                    <LabelPill key={l.id} label={l} />
                  ))}
                  {task.priority ? (
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                      {String(task.priority)}
                    </span>
                  ) : null}
                  <span className="text-xs text-slate-500">v{task.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/projects/${projectId}`} className="text-sm text-brand-600 hover:underline">
                  Back to project
                </Link>
                {canAssign && (
                  <Button variant="secondary" onClick={() => setAssignOpen(true)}>
                    Assign…
                  </Button>
                )}
              </div>
            </div>
            <dl className="mt-4 divide-y divide-slate-100">
              <DetailRow label="Task ID" value={<span className="font-mono text-xs">{task.id}</span>} />
              <DetailRow
                label="Assignee"
                value={
                  task.assignee_id ? (
                    <span className="font-mono text-xs" title={String(task.assignee_id)}>
                      {shortUserId(String(task.assignee_id))}
                      <span className="ml-2 text-slate-400">(user id — no users directory in S4)</span>
                    </span>
                  ) : (
                    'Unassigned'
                  )
                }
              />
              <DetailRow label="Description" value={task.description ? String(task.description) : '—'} />
            </dl>
            <div className="mt-4 border-t border-slate-100 pt-4">
              <WorkflowStepper status={String(task.status)} />
            </div>
          </div>

          {canTransition && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
              <h2 className="text-sm font-semibold text-slate-900">Change status</h2>
              <div className="mt-3 max-w-xl">
                <StatusTransitionSelect
                  taskId={task.id}
                  current={String(task.status)}
                  allowedNext={allowed_next}
                  version={task.version}
                  onTransitioned={refetchAll}
                />
              </div>
            </div>
          )}

          {canUpdate && (
            <EditTaskFields
              key={`${task.id}-v${task.version}`}
              taskId={task.id}
              version={task.version}
              defaults={{
                title: task.title,
                description: task.description ? String(task.description) : '',
                priority: task.priority ? String(task.priority) : '',
              }}
              onReload={refetchAll}
              conflictShow={conflict.show}
            />
          )}

          <section aria-label="Subtasks" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Subtasks ({subtasks.length})</h2>
            {subtasks.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No subtasks yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {subtasks.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-slate-800">{s.title}</span>
                    <span className="flex shrink-0 items-center gap-3">
                      <TaskStatusBadge status={String(s.status)} />
                      <Link href={`/projects/${projectId}/tasks/${s.id}`} className="text-brand-600 hover:underline">
                        Open
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canCreateTask && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <QuickAddTask
                  projectId={task.project_id}
                  parentId={task.id}
                  idPrefix={`subtask-${task.id}`}
                  onCreated={refetchAll}
                />
              </div>
            )}
          </section>

          <section aria-label="Dependencies" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Dependencies</h2>
            <div className="mt-3">
              <DependencyManager
                taskId={task.id}
                blockedBy={dependencies.blocked_by}
                blocking={dependencies.blocking}
                onChanged={refetchAll}
              />
            </div>
          </section>

          <EvidenceList taskId={task.id} canUpload={canUpdate} />
          <section aria-label="Labels" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Labels</h2>
            {(task.labels ?? []).length === 0 && !canUpdate ? (
              <p className="mt-2 text-sm text-slate-500">No labels on this task.</p>
            ) : null}
            {(task.labels ?? []).length > 0 && !canUpdate ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {(task.labels ?? []).map((l) => (
                  <LabelPill key={l.id} label={l} />
                ))}
              </div>
            ) : null}
            {canUpdate ? (
              <div className="mt-3">
                <TaskLabelToggle
                  taskId={task.id}
                  projectId={task.project_id}
                  attached={task.labels ?? []}
                  onChanged={refetchAll}
                />
              </div>
            ) : null}
          </section>
          <CommentThread taskId={task.id} canComment={canComment} />
        </div>

        <AssignDialog
          taskId={task.id}
          currentAssigneeId={task.assignee_id}
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          onAssigned={refetchAll}
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

/**
 * Edit title/description/priority via PATCH + If-Match (status is excluded —
 * use the transition control). 409s open the ConflictDialog.
 */
function EditTaskFields({
  taskId,
  version,
  defaults,
  onReload,
  conflictShow,
}: {
  taskId: string;
  version: number | string;
  defaults: { title: string; description: string; priority: string };
  onReload: () => void;
  conflictShow: (message?: string, requestId?: string) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<TaskPatchInput>({
    resolver: zodResolver(taskPatchSchema),
    defaultValues: defaults,
  });

  const mutation = useMutation({
    mutationFn: (v: TaskPatchInput) =>
      patchTask(
        taskId,
        {
          ...(v.title?.trim() ? { title: v.title.trim() } : {}),
          ...(v.description !== undefined ? { description: v.description?.trim() || null } : {}),
          ...(v.priority !== undefined ? { priority: v.priority?.trim() || null } : {}),
        },
        version,
      ),
    onSuccess: () => {
      setSubmitError(null);
      onReload();
    },
    onError: (err) => {
      if (isConflictError(err)) {
        conflictShow(err instanceof Error ? err.message : undefined, requestIdOf(err));
        return;
      }
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof TaskPatchInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
      <h2 className="text-sm font-semibold text-slate-900">Edit details</h2>
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-3 flex max-w-xl flex-col gap-4" noValidate>
        <FormField label="Title" htmlFor={`task-title-${taskId}`} error={errors.title?.message}>
          <Input id={`task-title-${taskId}`} invalid={!!errors.title} {...register('title')} />
        </FormField>
        <FormField label="Description" htmlFor={`task-desc-${taskId}`} error={errors.description?.message}>
          <textarea id={`task-desc-${taskId}`} rows={3} className={inputClass} {...register('description')} />
        </FormField>
        <FormField label="Priority" htmlFor={`task-priority-${taskId}`} error={errors.priority?.message}>
          <Input id={`task-priority-${taskId}`} placeholder="e.g. HIGH" {...register('priority')} />
        </FormField>
        {submitError ? <ErrorCard title="Could not save task" error={submitError} /> : null}
        <div>
          <Button type="submit" loading={mutation.isPending}>
            Save (v{String(version)})
          </Button>
        </div>
      </form>
    </div>
  );
}

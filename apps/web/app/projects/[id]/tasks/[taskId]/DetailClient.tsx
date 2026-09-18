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
import { listPeople, peopleIndex, personLabel } from '@/lib/people';
import { TaskCollaborators, type Collaborator } from '@/components/TaskCollaborators';
import { PRIORITIES } from '@/components/projects/ProjectFields';
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
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm text-text">{value}</dd>
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

  // The assignee is shown by name, from the employee directory.
  const peopleQuery = useQuery({ queryKey: ['people'], queryFn: listPeople, staleTime: 300_000 });
  const people = React.useMemo(() => peopleIndex(peopleQuery.data ?? []), [peopleQuery.data]);

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
          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-text">{task.title}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <TaskStatusBadge status={String(task.status)} />
                  <SlaBadge status={task.sla_status} />
                  {(task.labels ?? []).map((l) => (
                    <LabelPill key={l.id} label={l} />
                  ))}
                  {task.priority ? (
                    <span className="rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text-muted">
                      {String(task.priority)}
                    </span>
                  ) : null}
                  <span className="text-xs text-text-muted">v{task.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/projects/${projectId}`} className="text-sm text-primary hover:underline">
                  Back to project
                </Link>
                {canAssign && (
                  <Button variant="secondary" onClick={() => setAssignOpen(true)}>
                    Assign…
                  </Button>
                )}
              </div>
            </div>
            <dl className="mt-4 divide-y divide-border">
              <DetailRow label="Task ID" value={<span className="font-mono text-xs">{task.id}</span>} />
              <DetailRow
                label="Owner"
                value={
                  task.assignee_id
                    ? <span title={String(task.assignee_id)}>{personLabel(people, String(task.assignee_id))}</span>
                    : <span className="text-text-subtle">Unassigned</span>
                }
              />
              {/*
                * Everybody else on it (§note 13).
                *
                * The owner answers for the task; these are the people working
                * it with them. Shown and edited together, because "who is on
                * this" is one question and reading half the answer is how
                * somebody gets missed off a handover.
                */}
              <DetailRow
                label="Also working on it"
                value={
                  <TaskCollaborators
                    taskId={String(task.id)}
                    ownerId={task.assignee_id ? String(task.assignee_id) : null}
                    collaborators={(task.collaborators as Collaborator[] | undefined) ?? []}
                    canEdit={canAssign}
                    onChanged={refetchAll}
                  />
                }
              />
              {/*
                * When it was promised, and when it actually happened.
                *
                * The actual pair was stamped by the status trigger from the
                * beginning and shown nowhere, so every question about what a
                * month produced was answered off the plan. A plan is not a
                * record, and on a government contract the difference between
                * them is what a delay notice is argued over.
                */}
              <DetailRow
                label="Planned"
                value={task.planned_start_date || task.planned_end_date
                  ? `${task.planned_start_date ? String(task.planned_start_date) : '—'} to ${
                    task.planned_end_date ? String(task.planned_end_date) : '—'}`
                  : <span className="text-text-subtle">No dates set</span>}
              />
              <DetailRow
                label="Actually"
                value={task.actual_start_on
                  ? `${String(task.actual_start_on)} to ${
                    task.actual_end_on ? String(task.actual_end_on) : 'still running'}`
                  : <span className="text-text-subtle">Not started yet</span>}
              />
              <DetailRow label="Description" value={task.description ? String(task.description) : '—'} />
            </dl>
            <div className="mt-4 border-t border-border pt-4">
              <WorkflowStepper status={String(task.status)} />
            </div>
          </div>

          {canTransition && (
            <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
              <h2 className="text-sm font-semibold text-text">Change status</h2>
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

          <section aria-label="Subtasks" className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Subtasks ({subtasks.length})</h2>
            {subtasks.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No subtasks yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {subtasks.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="text-text">{s.title}</span>
                      <span className="ml-2 text-2xs text-text-subtle">
                        {personLabel(people, s.assignee_id as string | null)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <TaskStatusBadge status={String(s.status)} />
                      {/* A subtask is a task: opening it gives the same edit,
                          assign and status controls as any other. */}
                      <Link href={`/projects/${projectId}/tasks/${s.id}`} className="text-primary hover:underline">
                        Edit
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canCreateTask && (
              <div className="mt-4 border-t border-border pt-4">
                <QuickAddTask
                  projectId={task.project_id}
                  parentId={task.id}
                  idPrefix={`subtask-${task.id}`}
                  onCreated={refetchAll}
                />
              </div>
            )}
          </section>

          <section aria-label="Dependencies" className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Dependencies</h2>
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
          <section aria-label="Labels" className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Labels</h2>
            {(task.labels ?? []).length === 0 && !canUpdate ? (
              <p className="mt-2 text-sm text-text-muted">No labels on this task.</p>
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
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
      <h2 className="text-sm font-semibold text-text">Edit details</h2>
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-3 flex max-w-xl flex-col gap-4" noValidate>
        <FormField label="Title" htmlFor={`task-title-${taskId}`} error={errors.title?.message}>
          <Input id={`task-title-${taskId}`} invalid={!!errors.title} {...register('title')} />
        </FormField>
        <FormField label="Description" htmlFor={`task-desc-${taskId}`} error={errors.description?.message}>
          <textarea id={`task-desc-${taskId}`} rows={3} className={inputClass} {...register('description')} />
        </FormField>
        <FormField label="Priority" htmlFor={`task-priority-${taskId}`} error={errors.priority?.message}>
          {/* A dropdown, not free text: the server accepts four values and
              typing produced "high", "Hi" and "URGENT!" against them. */}
          <select id={`task-priority-${taskId}`} className={inputClass} {...register('priority')}>
            <option value="">Unset</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>
            ))}
          </select>
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

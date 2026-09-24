'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import {
  boardColumnsOrFallback,
  groupTasksByColumn,
  optimisticMoveTask,
  optimisticReorderColumn,
  restoreGroups,
  snapshotGroups,
  wipTone,
  type BoardDetailData,
  type KanbanGroups,
} from '@/lib/boards';
import { isConflictError, requestIdOf } from '@/lib/form-errors';
import { canMoveTaskTo, listTasksPage, patchTaskBoardPosition, parseInvalidTransition, transitionTask, type Task } from '@/lib/tasks';
import {BoardToolbar} from './board/BoardToolbar';
import {useRows} from './v2/Workbench';
import {useAuth} from './AuthProvider';
import {hasPermission,PERMISSIONS} from '@/lib/permissions';
import {
  avatarHue,
  checklistProgress,
  columnColor,
  dueState,
  initialsOf,
  isDoneLike,
  priorityPips,
  priorityTone,
  relativeTime,
  shortRef,
  statusLabel,
} from '@/lib/board-visuals';
import type {ListTasksParams} from '@/lib/tasks';
import {applySavedFilter,normalizeFilterQuery} from '@/lib/filters';
import { queryKeys } from '@/lib/query-keys';
import { boardViewHref } from '@/lib/routes';
import { LabelPill } from './LabelPill';
import { SlaBadge } from './SlaBadge';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { ErrorCard } from './ui/ErrorCard';
import { Skeleton } from './ui/Skeleton';
import { Spinner } from './ui/Spinner';

const PAGE_LIMIT = 100;
const COLUMN_CAP = 100;

function columnStatusCodes(columns: BoardDetailData['columns']): string[] {
  return columns.map((c) => c.status_code);
}

/**
 * Kanban board: DndContext + per-column SortableContext. Columns come from
 * the board config, falling back to the project workflow statuses when the
 * board has no columns yet. Dragging across columns calls the status endpoint
 * (optimistic move + snapshot rollback on INVALID_TRANSITION with a
 * shake-back highlight + allowed-list toast); reordering within a column
 * calls the board-position endpoint (If-Match, 409 → refetch).
 */
export function KanbanBoard({
  projectId,
  board,
  workflowStatuses,
  assigneeMe = false,
}: {
  projectId: string;
  board: BoardDetailData;
  workflowStatuses: string[];
  /** When true, the board shows only tasks assigned to the viewer ("my board"). */
  assigneeMe?: boolean;
}) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  // Terminal columns are collapsed away by default on a busy board; DONE
  // accumulates without bound and pushes the live columns off-screen.
  // Task rows carry only assignee_id, so avatars would otherwise be initialled
  // from a UUID. One lookup per board beats one request per card.
  // GET /projects/:id/people is gated on task.read (planning/routes.ts) --
  // gate the fetch on that exact permission, not on a role-name check. A
  // role-name check (`roles.every(r => r === 'CLIENT_VIEWER')`) only ever
  // catches the one role it was written for: CLIENT_VIEWER has task.read so
  // this would have kept fetching for it anyway, and any other role that
  // lacks task.read (e.g. GOVT_OBSERVER, which holds nothing) sailed straight
  // past the check and still threw a console 403 on every dashboard load.
  const people = useRows(`projects/${projectId}/people?limit=100`, !!projectId && hasPermission(session, PERMISSIONS.TASK_READ));
  const nameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const row of people.data?.rows ?? []) {
      if (row?.id) map.set(String(row.id), String(row.name ?? row.username ?? ''));
    }
    return map;
  }, [people.data]);
  // Task creation lives on the project page; the board links there rather than
  // duplicating the form.
  const canCreateTask = hasPermission({ permissions: session?.permissions }, PERMISSIONS.TASK_CREATE);
  const [hideDone, setHideDone] = React.useState(false);
  const [filters,setFilters]=React.useState<ListTasksParams>(()=>({...applySavedFilter({id:board.board.id,name:'',version:1,query:normalizeFilterQuery(board.board.filter_config)}),...(assigneeMe?{assignee_me:'true'}:{})}));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const columns = React.useMemo(
    () => boardColumnsOrFallback(board.columns, workflowStatuses),
    [board.columns, workflowStatuses],
  );
  const statusCodes = React.useMemo(() => columnStatusCodes(columns), [columns]);

  const tasksQuery = useInfiniteQuery({
    queryKey: queryKeys.projects.projectTasks(projectId, {
      board: board.board.id,
      ...filters,
      limit: PAGE_LIMIT,

    }),
    queryFn: ({ pageParam }) =>
      listTasksPage({
        project_id: projectId,
        limit: PAGE_LIMIT,
        ...filters,
        cursor: pageParam as string | undefined,
      }),
    initialPageParam: undefined as unknown as string | undefined,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    staleTime: 30_000,
  });

  const allTasks: Task[] = React.useMemo(
    () => (tasksQuery.data?.pages ?? []).flatMap((p) => p.tasks),
    [tasksQuery.data],
  );

  const [groups, setGroups] = React.useState<KanbanGroups>({});
  React.useEffect(() => {
    setGroups(groupTasksByColumn(allTasks, statusCodes));
  }, [allTasks, statusCodes]);

  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [transitionError, setTransitionError] = React.useState<{
    message: string;
    allowed: string[];
    requestId?: string;
    /**
     * False when the board refused the move locally, so nothing was sent and
     * nothing moved. Saying "rolled back" in that case describes an undo the
     * user never saw.
     */
    rolledBack: boolean;
  } | null>(null);
  const [reorderError, setReorderError] = React.useState<unknown>(null);
  const [shakeId, setShakeId] = React.useState<string | null>(null);

  const invalidateTasks = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects.projectTasks(projectId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
  }, [queryClient, projectId]);

  const transitionMutation = useMutation({
    mutationFn: ({
      taskId,
      toStatus,
      version,
    }: {
      taskId: string;
      toStatus: string;
      version?: number | string;
      snapshot: KanbanGroups;
    }) => transitionTask(taskId, toStatus, version),
    onSuccess: () => {
      setTransitionError(null);
      void invalidateTasks();
    },
    onError: (err, vars) => {
      // Roll back the optimistic move.
      setGroups(restoreGroups(vars.snapshot));
      if (err instanceof ApiClientError && err.code === 'INVALID_TRANSITION') {
        const allowed = parseInvalidTransition(err);
        setShakeId(vars.taskId);
        setTransitionError({
          message: err.message || 'That transition is not allowed from the current status.',
          allowed,
          requestId: requestIdOf(err),
          rolledBack: true,
        });
        return;
      }
      setTransitionError({
        message: err instanceof Error ? err.message : 'Could not move task.',
        allowed: [],
        requestId: requestIdOf(err),
        rolledBack: true,
      });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: ({
      task,
      position,
      columnId,
    }: {
      task: Task;
      position: number;
      columnId: string;
    }) =>
      patchTaskBoardPosition(
        task.id,
        { position, board_id: board.board.id, column_id: columnId },
        task.version,
      ),
    onSuccess: () => {
      setReorderError(null);
      void invalidateTasks();
    },
    onError: (err) => {
      if (isConflictError(err)) {
        // 409 → refetch authoritative order.
        void invalidateTasks();
        setReorderError(err);
        return;
      }
      setReorderError(err);
    },
  });

  const findStatus = React.useCallback(
    (taskId: string): string | null => {
      for (const [status, rows] of Object.entries(groups)) {
        if (rows.some((t) => t.id === taskId)) return status;
      }
      return null;
    },
    [groups],
  );

  const onDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setShakeId(null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activeTaskId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveId(null);
    if (!overId) return;

    const fromStatus = findStatus(activeTaskId);
    if (!fromStatus) return;
    // Over may be a task id (reorder target) or a column status code.
    const overStatus = statusCodes.includes(overId) ? overId : findStatus(overId);
    if (!overStatus) return;

    if (fromStatus === overStatus) {
      // Reorder within the column.
      const col = groups[fromStatus] ?? [];
      const oldIndex = col.findIndex((t) => t.id === activeTaskId);
      const overIndex = statusCodes.includes(overId)
        ? col.length - 1
        : col.findIndex((t) => t.id === overId);
      const newIndex = overIndex < 0 ? col.length - 1 : overIndex;
      if (oldIndex === newIndex) return;
      const task = col[oldIndex];
      if (!task) return;
      const snapshot = snapshotGroups(groups);
      void snapshot;
      setGroups(optimisticReorderColumn(groups, fromStatus, activeTaskId, newIndex));
      const columnId = columns.find((c) => c.status_code === fromStatus)?.id ?? fromStatus;
      reorderMutation.mutate({ task, position: newIndex, columnId });
      return;
    }

    const moving = (groups[fromStatus] ?? []).find((t) => t.id === activeTaskId);

    // Refuse a transition the workflow forbids before touching the server.
    // See canMoveTaskTo for why the board cannot rely on the server alone.
    const check = moving ? canMoveTaskTo(moving, overStatus) : ({ allowed: true } as const);
    if (!check.allowed) {
      setShakeId(activeTaskId);
      setTransitionError({
        message: check.reason,
        allowed: check.allowedNext,
        rolledBack: false,
      });
      return;
    }

    // Move across columns → status transition (optimistic + rollback).
    const snapshot = snapshotGroups(groups);
    setGroups(optimisticMoveTask(groups, activeTaskId, overStatus));
    setTransitionError(null);
    transitionMutation.mutate({ taskId: activeTaskId, toStatus: overStatus, version: moving?.version, snapshot });
  };

  const onDragCancel = () => setActiveId(null);

  if (tasksQuery.isLoading) return <Skeleton className="h-96 w-full" />;
  if (tasksQuery.isError) {
    return (
      <ErrorCard title="Could not load tasks" error={tasksQuery.error} onRetry={() => tasksQuery.refetch()} />
    );
  }

  const activeTask = activeId ? allTasks.find((t) => t.id === activeId) ?? null : null;
  // Extra statuses present on tasks but missing from the column config render
  // as trailing read-only-ish columns (still droppable) so no card is hidden.
  const extraStatuses = Object.keys(groups).filter((s) => !statusCodes.includes(s));
  // Plain computation, not useMemo: this sits after the loading/error early
  // returns above, so a hook here would be called conditionally.
  const allCodes = [...statusCodes, ...extraStatuses];
  const renderCodes = hideDone ? allCodes.filter((code) => !isDoneLike(code)) : allCodes;

  return (
    <div className="flex flex-col gap-4">
      <BoardToolbar
        projectId={projectId}
        value={filters}
        onChange={setFilters}
        view="board"
        onViewChange={(v) => {
          if (v === 'list') window.location.assign(boardViewHref(projectId, 'list'));
        }}
        hideDone={hideDone}
        onHideDoneChange={setHideDone}
        taskCount={allTasks.length}
        right={
          canCreateTask ? (
            <Link
              href={`/projects/${projectId}`}
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-fg hover:bg-primary-hover"
            >
              <span aria-hidden="true">+</span> New task
            </Link>
          ) : null
        }
      />
      {transitionError ? (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
          <p className="font-medium">
            {transitionError.rolledBack ? 'Could not move task — rolled back.' : 'That move is not allowed.'}
          </p>
          <p className="mt-1">{transitionError.message}</p>
          {transitionError.allowed.length > 0 ? (
            <p className="mt-1">
              Allowed next: <span className="font-mono text-xs">{transitionError.allowed.join(', ')}</span>
            </p>
          ) : null}
          {transitionError.requestId ? (
            <p className="mt-1 text-xs opacity-75">Request ID: {transitionError.requestId}</p>
          ) : null}
          <div className="mt-2">
            <Button variant="secondary" onClick={() => setTransitionError(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
      {reorderError ? (
        <div className="flex flex-col gap-2">
          <ErrorCard
            title={
              isConflictError(reorderError)
                ? 'Order changed elsewhere — reloaded the latest order'
                : 'Could not save new order'
            }
            error={reorderError}
            onRetry={() => void invalidateTasks()}
          />
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="grid auto-cols-[280px] grid-flow-col gap-4 overflow-x-auto pb-2">
          {renderCodes.map((code) => {
            const col = columns.find((c) => c.status_code === code);
            const rows = groups[code] ?? [];
            const shown = rows.slice(0, COLUMN_CAP);
            const hidden = rows.length - shown.length;
            return (
              <KanbanColumn
                key={code}
                statusCode={code}
                // A column whose configured name is just its status code has no
                // real name — that is the code leaking through, so render it as
                // prose. A genuinely named column is left exactly as authored.
                name={col?.name && col.name !== code ? col.name : statusLabel(code)}
                color={col?.color ?? null}
                count={rows.length}
                wipLimit={col?.wip_limit ?? null}
                taskIds={shown.map((t) => t.id)}
              >
                {shown.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    projectId={projectId}
                    shake={shakeId === t.id}
                    assigneeName={t.assignee_id ? (nameById.get(String(t.assignee_id)) ?? null) : null}
                  />
                ))}
                {rows.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-subtle">
                    Drop tasks here
                  </p>
                ) : null}
                {hidden > 0 ? (
                  <p className="text-xs text-text-muted">
                    +{hidden} more in this column (capped at {COLUMN_CAP}) — use Load more below.
                  </p>
                ) : null}
              </KanbanColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeTask ? (
            <div className="rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-lg">
              {activeTask.title}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="flex items-center gap-3">
        {tasksQuery.hasNextPage ? (
          <Button
            variant="secondary"
            loading={tasksQuery.isFetchingNextPage}
            onClick={() => tasksQuery.fetchNextPage()}
          >
            Load more tasks
          </Button>
        ) : (
          <p className="text-xs text-text-muted">
            {allTasks.length} task{allTasks.length === 1 ? '' : 's'} on this board.
          </p>
        )}
        {tasksQuery.isFetching && !tasksQuery.isFetchingNextPage ? <Spinner size="sm" /> : null}
      </div>
      {allTasks.length === 0 ? (
        <EmptyState
          title="No tasks on this board"
          description="Create tasks from the project List view — they appear here grouped by status."
        />
      ) : null}
    </div>
  );
}

function KanbanColumn({
  statusCode,
  name,
  color,
  count,
  wipLimit,
  taskIds,
  children,
}: {
  statusCode: string;
  name: string;
  color: string | null;
  count: number;
  wipLimit: number | null;
  taskIds: string[];
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: statusCode, data: { status: statusCode } });
  const tone = wipTone(count, wipLimit);
  // The column hue is published as a custom property so the header dot, the
  // count pill and every card rail inside read from one source.
  const style = { '--col': columnColor(statusCode, color) } as React.CSSProperties;
  const overLimit = tone === 'danger' || tone === 'warning';
  return (
    <section
      aria-label={`Column ${name}`}
      data-column={statusCode}
      ref={setNodeRef}
      style={style}
      className={`flex min-h-[140px] flex-col rounded-xl border bg-surface-sunken/70 transition-colors ${
        isOver ? 'border-primary ring-2 ring-primary/20' : 'border-border'
      }`}
    >
      <header className="flex items-center gap-2 px-3 pb-2 pt-2.5">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: 'var(--col)' }}
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
          {name}
        </h3>
        <span
          className={`rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums ${
            overLimit
              ? tone === 'danger'
                ? 'bg-danger-subtle text-danger'
                : 'bg-warning-subtle text-warning'
              : 'bg-surface text-text-muted'
          }`}
          title={wipLimit ? `WIP ${count}/${wipLimit}` : `${count} tasks`}
        >
          {wipLimit ? `${count}/${wipLimit}` : count}
        </span>
      </header>
      {/* The hue reads as a rule under the header rather than a full border,
          so a row of columns stays calm while each keeps its identity. */}
      <div aria-hidden="true" className="mx-3 h-px" style={{ backgroundColor: 'var(--col)', opacity: 0.45 }} />
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2 p-2">{children}</div>
      </SortableContext>
    </section>
  );
}

/** Assignee bubble: deterministic hue from the id, initials from any label. */
function Avatar({ id, label }: { id: string | null | undefined; label?: string | null }) {
  if (!id) {
    return (
      <span
        title="Unassigned"
        aria-label="Unassigned"
        className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-border-strong text-2xs text-text-subtle"
      >
        ?
      </span>
    );
  }
  const hue = avatarHue(id);
  const named = Boolean(label && String(label).trim());
  return (
    <span
      title={named ? String(label) : `Assignee ${shortRef(id)}`}
      aria-label={named ? `Assigned to ${label}` : 'Assigned'}
      className="flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold"
      style={{ backgroundColor: `hsl(${hue} 58% 42%)`, color: 'hsl(0 0% 100%)' }}
    >
      {/* Initialling a raw UUID reads as noise ("69"), so an unresolved
          assignee keeps the identifying hue but drops the fake initials. */}
      {named ? initialsOf(label) : <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-white/80" />}
    </span>
  );
}

/** Priority as pips — three slots, filled left to right. LOW fills none. */
function PriorityPips({ priority }: { priority: unknown }) {
  const filled = priorityPips(priority as string);
  if (filled === 0) return null;
  const tone = priorityTone(priority as string);
  const color =
    tone === 'danger' ? 'hsl(var(--danger))' : tone === 'warning' ? 'hsl(var(--warning))' : 'hsl(var(--text-subtle))';
  return (
    <span className="flex items-center gap-0.5" title={`Priority: ${statusLabel(String(priority))}`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: i < filled ? color : 'hsl(var(--border-strong))' }}
        />
      ))}
      <span className="sr-only">Priority {String(priority)}</span>
    </span>
  );
}

const TaskCard = React.memo(function TaskCard({
  task,
  projectId,
  shake,
  assigneeName,
}: {
  task: Task;
  projectId: string;
  shake: boolean;
  /** Resolved from the board's people lookup; null when unknown. */
  assigneeName?: string | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { status: String(task.status) },
  });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };
  const done = isDoneLike(String(task.status));
  const due = dueState(task.planned_end_date as string | null, String(task.status));
  const checklist = checklistProgress(task.checklist);
  const labels = task.labels ?? [];
  const assigneeLabel = assigneeName ?? null;

  return (
    <article
      ref={setNodeRef}
      style={style}
      data-task-id={task.id}
      {...attributes}
      {...listeners}
      className={`group relative overflow-hidden rounded-lg border bg-surface shadow-sm transition-colors hover:border-border-strong ${
        shake ? 'border-danger ring-2 ring-danger/30' : 'border-border'
      }`}
    >
      {/* Column hue as a rail along the card's top edge. */}
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: 'var(--col)' }} />

      <div className="px-2.5 pb-2 pt-2.5">
        <Link
          href={`/projects/${projectId}/tasks/${task.id}`}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
          className={`block text-sm font-medium leading-snug hover:underline ${
            done ? 'text-text-muted line-through decoration-text-subtle' : 'text-text'
          }`}
        >
          {task.title}
        </Link>

        <p className="mt-1 text-2xs text-text-subtle">{relativeTime(task.created_at as string)}</p>

        {labels.length > 0 || task.sla_status ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <SlaBadge status={task.sla_status} />
            {labels.slice(0, 3).map((l) => (
              <LabelPill key={l.id} label={l} />
            ))}
            {labels.length > 3 ? (
              <span className="text-2xs text-text-subtle">+{labels.length - 3}</span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-2 flex items-center gap-2 text-2xs text-text-subtle">
          <PriorityPips priority={task.priority} />
          <span className="font-mono tracking-tight" title={String(task.id)}>
            {shortRef(task.id)}
          </span>
          {checklist ? (
            <span className="tabular-nums" title={`${checklist.done} of ${checklist.total} checklist items done`}>
              {checklist.done}/{checklist.total}
            </span>
          ) : null}
          {due ? (
            <span className={due.overdue ? 'font-medium text-danger' : ''} title={due.overdue ? 'Overdue' : 'Due'}>
              {due.overdue ? `Overdue · ${due.label}` : due.label}
            </span>
          ) : null}
          <span className="ml-auto">
            <Avatar id={task.assignee_id as string | null} label={assigneeLabel} />
          </span>
        </div>
      </div>
    </article>
  );
});


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
import { listTasksPage, patchTaskBoardPosition, parseInvalidTransition, transitionTask, type Task } from '@/lib/tasks';
import {TaskFilters} from './v2/TaskFilters';
import type {ListTasksParams} from '@/lib/tasks';
import {applySavedFilter,normalizeFilterQuery} from '@/lib/filters';
import { queryKeys } from '@/lib/query-keys';
import { shortUserId } from './ApprovalTimeline';
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
        });
        return;
      }
      setTransitionError({
        message: err instanceof Error ? err.message : 'Could not move task.',
        allowed: [],
        requestId: requestIdOf(err),
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

    // Move across columns → status transition (optimistic + rollback).
    const snapshot = snapshotGroups(groups);
    setGroups(optimisticMoveTask(groups, activeTaskId, overStatus));
    setTransitionError(null);
    const moving = (groups[fromStatus] ?? []).find((t) => t.id === activeTaskId);
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
  const renderCodes = [...statusCodes, ...extraStatuses];

  return (
    <div className="flex flex-col gap-4">
      <TaskFilters project={projectId} value={filters} onChange={setFilters}/>
      {transitionError ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Could not move task — rolled back.</p>
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
                name={col?.name ?? code}
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
                  />
                ))}
                {rows.length === 0 ? (
                  <p className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
                    Drop tasks here
                  </p>
                ) : null}
                {hidden > 0 ? (
                  <p className="text-xs text-slate-500">
                    +{hidden} more in this column (capped at {COLUMN_CAP}) — use Load more below.
                  </p>
                ) : null}
              </KanbanColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeTask ? (
            <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-lg">
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
          <p className="text-xs text-slate-500">
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
  const badgeClass =
    tone === 'danger'
      ? 'bg-red-100 text-red-700'
      : tone === 'warning'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-600';
  return (
    <section
      aria-label={`Column ${name}`}
      data-column={statusCode}
      ref={setNodeRef}
      className={`flex min-h-[200px] flex-col gap-2 rounded-lg border bg-slate-50 p-3 ${
        isOver ? 'border-brand-500 ring-2 ring-brand-100' : 'border-slate-200'
      }`}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
          {color ? (
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          ) : null}
          <span className="truncate">{name}</span>
        </h3>
        <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${badgeClass}`} title={wipLimit ? `WIP ${count}/${wipLimit}` : `${count} tasks`}>
          {wipLimit ? `${count}/${wipLimit}` : count}
        </span>
      </header>
      <p className="font-mono text-[11px] text-slate-400">{statusCode}</p>
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">{children}</div>
      </SortableContext>
    </section>
  );
}

const TaskCard = React.memo(function TaskCard({
  task,
  projectId,
  shake,
}: {
  task: Task;
  projectId: string;
  shake: boolean;
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
  return (
    <article
      ref={setNodeRef}
      style={style}
      data-task-id={task.id}
      {...attributes}
      {...listeners}
      className={`rounded-lg border bg-white px-3 py-2 shadow-sm ${
        shake ? 'border-red-500 ring-2 ring-red-200' : 'border-slate-200'
      }`}
    >
      <p className="text-sm font-medium text-slate-900">{task.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <SlaBadge status={task.sla_status} />
        {(task.labels ?? []).slice(0, 4).map((l) => (
          <LabelPill key={l.id} label={l} />
        ))}
        {(task.labels ?? []).length > 4 ? (
          <span className="text-[11px] text-slate-400">+{(task.labels ?? []).length - 4}</span>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="font-mono text-slate-500" title={task.assignee_id ? String(task.assignee_id) : undefined}>
          {task.assignee_id ? shortUserId(String(task.assignee_id)) : 'unassigned'}
        </span>
        <Link
          href={`/projects/${projectId}/tasks/${task.id}`}
          className="text-brand-600 hover:underline"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          Open
        </Link>
      </div>
    </article>
  );
});

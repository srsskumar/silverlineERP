'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getProject } from '@/lib/projects';
import {
  createBoard,
  deleteBoard,
  getBoard,
  listBoards,
  replaceBoardColumns,
  type BoardColumn,
} from '@/lib/boards';
import { queryKeys } from '@/lib/query-keys';
import {
  TASK_STATUSES,
  boardColumnsSchema,
  boardSchema,
  type BoardColumnsFormInput,
  type BoardFormInput,
} from '@/lib/validation';
import { KanbanBoard } from '@/components/KanbanBoard';
import { ProjectTabs } from '@/components/ProjectTabs';
import { WorkforceStrip } from '@/components/WorkforceStrip';
import { ConflictDialog, useConflict } from '@/components/ConflictDialog';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { applyFieldErrors, isConflictError, requestIdOf } from '@/lib/form-errors';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

export function BoardView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [manageOpen, setManageOpen] = React.useState(false);
  const [mineOnly, setMineOnly] = React.useState(false);
  const conflict = useConflict();

  const boardsQuery = useQuery({
    queryKey: queryKeys.boards.list({ project_id: projectId }),
    queryFn: () => listBoards(projectId),
    staleTime: 30_000,
  });

  const boards = boardsQuery.data ?? [];
  React.useEffect(() => {
    if (!selectedId && boards.length > 0) setSelectedId(boards[0].id);
    if (selectedId && boards.length > 0 && !boards.some((b) => b.id === selectedId)) {
      setSelectedId(boards[0].id);
    }
  }, [boards, selectedId]);

  const boardQuery = useQuery({
    queryKey: selectedId ? queryKeys.boards.detail(selectedId) : ['boards', 'detail', 'none'],
    queryFn: () => getBoard(selectedId as string),
    enabled: !!selectedId,
    staleTime: 30_000,
  });

  const projectQuery = useQuery({
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: () => getProject(projectId),
    staleTime: 30_000,
  });

  const workflowStatuses: string[] = React.useMemo(() => {
    const wf = projectQuery.data?.workflow as { statuses?: unknown } | undefined;
    if (wf && Array.isArray(wf.statuses)) {
      const list = wf.statuses.filter((s): s is string => typeof s === 'string');
      if (list.length > 0) return list;
    }
    return [...TASK_STATUSES];
  }, [projectQuery.data]);

  const refetchBoard = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.boards.all });
  }, [queryClient]);

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.BOARD_READ}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Board</h1>
            <p className="mt-1 text-sm text-slate-500">
              Kanban grouped by status — dragging across columns changes task status; reordering saves position.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <BoardActions
              projectId={projectId}
              hasBoard={!!selectedId}
              onNew={() => setNewOpen(true)}
              onManage={() => setManageOpen(true)}
            />
          </div>
        </div>

        <div className="mt-4">
          <ProjectTabs projectId={projectId} active="board" />
        </div>

        <div className="mt-4">
          <WorkforceStrip />
        </div>

        <div className="mt-4 flex flex-col gap-4">
          {boardsQuery.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : boardsQuery.isError ? (
            <ErrorCard title="Could not load boards" error={boardsQuery.error} onRetry={() => boardsQuery.refetch()} />
          ) : boards.length === 0 ? (
            <EmptyState
              title="No boards yet"
              description="Create the first board for this project (LIST or KANBAN)."
              action={
                <Button onClick={() => setNewOpen(true)}>New board</Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="board-select" className="text-sm font-medium text-slate-700">
                Board
              </label>
              <select
                id="board-select"
                className={`${inputClass} sm:max-w-sm`}
                value={selectedId ?? ''}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({String(b.view_type)})
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedId && boardQuery.isLoading ? <Skeleton className="h-96 w-full" /> : null}
          {selectedId && boardQuery.isError ? (
            <ErrorCard title="Could not load board" error={boardQuery.error} onRetry={() => boardQuery.refetch()} />
          ) : null}
          {selectedId && boardQuery.data ? (
            <>
              <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={mineOnly}
                  onChange={(e) => setMineOnly(e.target.checked)}
                />
                Only mine
              </label>
              <KanbanBoard
                projectId={projectId}
                board={boardQuery.data}
                workflowStatuses={workflowStatuses}
                assigneeMe={mineOnly}
              />
            </>
          ) : null}
        </div>

        <NewBoardDialog projectId={projectId} open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => { setSelectedId(id); setNewOpen(false); void refetchBoard(); }} />
        {selectedId && boardQuery.data ? (
          <ManageColumnsDialog
            projectId={projectId}
            boardId={selectedId}
            version={Number(boardQuery.data.board.version)}
            columns={boardQuery.data.columns}
            workflowStatuses={workflowStatuses}
            open={manageOpen}
            onClose={() => setManageOpen(false)}
            onSaved={() => { setManageOpen(false); void refetchBoard(); }}
            conflictShow={conflict.show}
          />
        ) : null}
        <ConflictDialog
          open={conflict.open}
          message={conflict.conflict?.message}
          requestId={conflict.conflict?.requestId}
          onReload={() => void refetchBoard()}
          onClose={conflict.hide}
        />
      </RequirePermission>
    </AppShell>
  );
}

function BoardActions({
  projectId: _projectId,
  hasBoard,
  onNew,
  onManage,
}: {
  projectId: string;
  hasBoard: boolean;
  onNew: () => void;
  onManage: () => void;
}) {
  void _projectId;
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canManage = hasPermission(holder, PERMISSIONS.BOARD_MANAGE);
  return (
    <>
      {canManage ? <Button onClick={onNew}>New board</Button> : null}
      {canManage && hasBoard ? (
        <Button variant="secondary" onClick={onManage}>
          Manage columns…
        </Button>
      ) : null}
    </>
  );
}

function NewBoardDialog({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<BoardFormInput>({
    resolver: zodResolver(boardSchema),
    defaultValues: { project_id: projectId, name: '', view_type: 'KANBAN' },
  });

  React.useEffect(() => {
    if (open) {
      reset({ project_id: projectId, name: '', view_type: 'KANBAN' });
      setSubmitError(null);
    }
  }, [open, projectId, reset]);

  const mutation = useMutation({
    mutationFn: (v: BoardFormInput) =>
      createBoard({ project_id: projectId, name: v.name.trim(), view_type: v.view_type }),
    onSuccess: (board) => {
      setSubmitError(null);
      onCreated(board.id);
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof BoardFormInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="New board" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">New board</h2>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Name" htmlFor="new-board-name" error={errors.name?.message}>
            <Input id="new-board-name" placeholder="e.g. Sprint board" invalid={!!errors.name} {...register('name')} />
          </FormField>
          <FormField label="View type" htmlFor="new-board-view" error={errors.view_type?.message}>
            <select id="new-board-view" className={inputClass} {...register('view_type')}>
              <option value="KANBAN">KANBAN</option>
              <option value="LIST">LIST</option>
            </select>
          </FormField>
          {submitError ? <ErrorCard title="Could not create board" error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DraftColumn {
  status_code: string;
  name: string;
  position: number;
  wip_limit: string;
  color: string;
}

function ManageColumnsDialog({
  projectId,
  boardId,
  version,
  columns,
  workflowStatuses,
  open,
  onClose,
  onSaved,
  conflictShow,
}: {
  projectId: string;
  boardId: string;
  version: number;
  columns: BoardColumn[];
  workflowStatuses: string[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  conflictShow: (message?: string, requestId?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<DraftColumn[]>([]);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [addStatus, setAddStatus] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setDraft(
        [...columns]
          .sort((a, b) => a.position - b.position)
          .map((c, i) => ({
            status_code: c.status_code,
            name: c.name,
            position: i,
            wip_limit: c.wip_limit != null ? String(c.wip_limit) : '',
            color: c.color ?? '',
          })),
      );
      setSubmitError(null);
      setAddStatus('');
    }
  }, [open, columns]);

  const available = workflowStatuses.filter((s) => !draft.some((d) => d.status_code === s));

  const setRow = (index: number, patch: Partial<DraftColumn>) => {
    setDraft((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const parsed: BoardColumnsFormInput = boardColumnsSchema.parse({
        columns: draft.map((d, i) => ({
          status_code: d.status_code,
          name: d.name.trim() || d.status_code,
          position: i,
          wip_limit: d.wip_limit.trim() === '' ? null : Number(d.wip_limit),
          color: d.color.trim() === '' ? null : d.color.trim(),
        })),
      });
      return replaceBoardColumns(
        boardId,
        parsed.columns.map((c) => ({
          status_code: c.status_code,
          name: c.name,
          position: c.position,
          wip_limit: c.wip_limit ?? null,
          color: c.color ?? null,
        })),
        version,
      );
    },
    onSuccess: async () => {
      setSubmitError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.boards.all });
      onSaved();
    },
    onError: (err) => {
      if (isConflictError(err)) {
        conflictShow(err instanceof Error ? err.message : undefined, requestIdOf(err));
        return;
      }
      setSubmitError(err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteBoard(boardId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.boards.all });
      onClose();
      if (typeof window !== 'undefined') window.location.assign(`/projects/${projectId}`);
    },
    onError: (err) => setSubmitError(err),
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Manage columns" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">Manage columns (v{version})</h2>
        <p className="mt-1 text-xs text-slate-500">
          Config only — editing columns never changes tasks. Add/remove status columns from the project workflow list.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {draft.map((d, i) => (
            <div key={d.status_code} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-4">
              <div>
                <span className="text-xs font-medium text-slate-500">Status</span>
                <p className="font-mono text-sm text-slate-900">{d.status_code}</p>
              </div>
              <div>
                <label htmlFor={`col-name-${i}`} className="text-xs font-medium text-slate-500">Display name</label>
                <Input id={`col-name-${i}`} value={d.name} onChange={(e) => setRow(i, { name: e.target.value })} />
              </div>
              <div>
                <label htmlFor={`col-wip-${i}`} className="text-xs font-medium text-slate-500">WIP limit</label>
                <Input
                  id={`col-wip-${i}`}
                  inputMode="numeric"
                  placeholder="—"
                  value={d.wip_limit}
                  onChange={(e) => setRow(i, { wip_limit: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`col-color-${i}`} className="text-xs font-medium text-slate-500">Color</label>
                <div className="flex gap-2">
                  <Input
                    id={`col-color-${i}`}
                    placeholder="#rrggbb"
                    className="font-mono"
                    value={d.color}
                    onChange={(e) => setRow(i, { color: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 text-xs text-red-600 hover:underline"
                    aria-label={`Remove column ${d.status_code}`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
          {draft.length === 0 ? <p className="text-sm text-slate-500">No columns — add at least one.</p> : null}
          {available.length > 0 ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label htmlFor="col-add" className="text-sm font-medium text-slate-700">Add status column</label>
                <select id="col-add" className={inputClass} value={addStatus} onChange={(e) => setAddStatus(e.target.value)}>
                  <option value="">Pick a workflow status…</option>
                  {available.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <Button
                variant="secondary"
                disabled={!addStatus}
                onClick={() => {
                  if (!addStatus) return;
                  setDraft((prev) => [
                    ...prev,
                    { status_code: addStatus, name: addStatus, position: prev.length, wip_limit: '', color: '' },
                  ]);
                  setAddStatus('');
                }}
              >
                Add
              </Button>
            </div>
          ) : (
            <p className="text-xs text-slate-500">All workflow statuses are already columns.</p>
          )}
        </div>
        {submitError ? (
          <div className="mt-3">
            <ErrorCard title="Could not save columns" error={submitError} />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-between gap-2">
          <Button
            variant="danger"
            loading={deleteMutation.isPending}
            onClick={() => {
              if (window.confirm('Delete this board? Tasks are kept; only the board config is removed.')) {
                deleteMutation.mutate();
              }
            }}
          >
            Delete board
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              Save columns (v{version})
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

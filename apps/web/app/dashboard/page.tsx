'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { KanbanBoard } from '@/components/KanbanBoard';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { WorkforceStrip } from '@/components/WorkforceStrip';
import { PERMISSIONS } from '@/lib/permissions';
import { getProject, listProjects } from '@/lib/projects';
import { getBoard, listBoards } from '@/lib/boards';
import { TASK_STATUSES } from '@/lib/validation';
import { queryKeys } from '@/lib/query-keys';

export const dynamic = 'force-static';

const selectClass =
  'rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/**
 * Board-first landing page (Jira-style): pick a project, pick one of its
 * boards, work the Kanban. Dragging across columns changes task status;
 * reordering saves position. Role widgets live on only in lib/dashboards
 * (used by /my-work); this page is boards, end to end.
 */
export default function DashboardPage() {
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [boardId, setBoardId] = React.useState<string | null>(null);
  const [mineOnly, setMineOnly] = React.useState(false);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(),
    queryFn: () => listProjects(),
    staleTime: 60_000,
  });
  const projects = projectsQuery.data ?? [];
  React.useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0].id);
    if (projectId && projects.length > 0 && !projects.some((p) => p.id === projectId)) {
      setProjectId(projects[0].id);
      setBoardId(null);
    }
  }, [projects, projectId]);

  const boardsQuery = useQuery({
    queryKey: projectId ? queryKeys.boards.list({ project_id: projectId }) : ['boards', 'list', 'none'],
    queryFn: () => listBoards(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  const boards = boardsQuery.data ?? [];
  React.useEffect(() => {
    if (!boardId && boards.length > 0) setBoardId(boards[0].id);
    if (boardId && boards.length > 0 && !boards.some((b) => b.id === boardId)) {
      setBoardId(boards[0].id);
    }
  }, [boards, boardId]);

  const boardQuery = useQuery({
    queryKey: boardId ? queryKeys.boards.detail(boardId) : ['boards', 'detail', 'none'],
    queryFn: () => getBoard(boardId as string),
    enabled: !!boardId,
    staleTime: 30_000,
  });

  const projectQuery = useQuery({
    queryKey: projectId ? queryKeys.projects.detail(projectId) : ['projects', 'detail', 'none'],
    queryFn: () => getProject(projectId as string),
    enabled: !!projectId,
    staleTime: 60_000,
  });
  const workflowStatuses: string[] = React.useMemo(() => {
    const wf = projectQuery.data?.workflow as { statuses?: unknown } | undefined;
    if (wf && Array.isArray(wf.statuses)) {
      const list = wf.statuses.filter((s): s is string => typeof s === 'string');
      if (list.length > 0) return list;
    }
    return [...TASK_STATUSES];
  }, [projectQuery.data]);

  return (
    <AppShell>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-text">Board</h1>
          <p className="hidden text-xs text-text-subtle sm:block">
            Drag cards across columns to change status.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {projectsQuery.isLoading ? (
            <Skeleton className="h-9 w-56" />
          ) : (
            <label className="flex items-center gap-2 text-sm text-text-muted">
              Project
              <select
                aria-label="Project"
                className={`${selectClass} max-w-64`}
                value={projectId ?? ''}
                onChange={(e) => {
                  setProjectId(e.target.value || null);
                  setBoardId(null);
                }}
                disabled={projects.length === 0}
              >
                {projects.length === 0 ? <option value="">No projects</option> : null}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {boardsQuery.isLoading ? (
            <Skeleton className="h-9 w-44" />
          ) : boards.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-text-muted">
              Board
              <select
                aria-label="Board"
                className={`${selectClass} max-w-52`}
                value={boardId ?? ''}
                onChange={(e) => setBoardId(e.target.value || null)}
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {projectId ? (
            <Link href={`/projects/${projectId}`} className="text-sm text-primary hover:underline">
              Project overview →
            </Link>
          ) : null}
          <label className="flex items-center gap-2 text-sm font-medium text-text-muted">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            Only mine
          </label>
        </div>
      </div>

      <div className="mt-3">
        <WorkforceStrip dense />
      </div>

      <div className="mt-3">
        {projectsQuery.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : projectsQuery.isError ? (
          <ErrorCard title="Could not load projects" error={projectsQuery.error} onRetry={() => projectsQuery.refetch()} />
        ) : projects.length === 0 ? (
          <EmptyState
            title="No projects visible"
            description="No projects are shared with your account yet — ask your project manager for access, or create one under Projects."
          />
        ) : boardsQuery.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : boardsQuery.isError ? (
          <ErrorCard title="Could not load boards" error={boardsQuery.error} onRetry={() => boardsQuery.refetch()} />
        ) : boards.length === 0 ? (
          <EmptyState
            title="This project has no boards yet"
            description="Create the first Kanban board from the project's Board tab."
            action={
              projectId ? (
                <Link
                  href={`/projects/${projectId}/board`}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover"
                >
                  Open Board tab
                </Link>
              ) : undefined
            }
          />
        ) : boardQuery.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : boardQuery.isError ? (
          <ErrorCard title="Could not load board" error={boardQuery.error} onRetry={() => boardQuery.refetch()} />
        ) : boardQuery.data ? (
          <RequirePermission code={PERMISSIONS.BOARD_READ}>
            {mineOnly ? (
              <p className="mb-2 text-xs text-text-muted">
                Showing only tasks assigned to you — managers still see everything on their own boards.
              </p>
            ) : null}
            <KanbanBoard
              projectId={projectId as string}
              board={boardQuery.data}
              workflowStatuses={workflowStatuses}
              assigneeMe={mineOnly}
            />
          </RequirePermission>
        ) : null}
      </div>
    </AppShell>
  );
}

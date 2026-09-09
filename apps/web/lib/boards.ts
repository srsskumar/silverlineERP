import { apiRequest } from './apiClient';
import type { Task } from './tasks';

/**
 * S5 boards client (frozen contract).
 *
 *   POST /api/v1/boards {project_id,name,view_type:LIST|KANBAN,column_config?,filter_config?} → 201 bare
 *   GET  /api/v1/boards?project_id= → {data:[...]}
 *   GET  /api/v1/boards/:id → {board, columns:[{id,status_code,name,position,wip_limit,color}]}
 *   PATCH /api/v1/boards/:id + If-Match (config only)
 *   PUT  /api/v1/boards/:id/columns {columns:[...]} + If-Match
 *   DELETE /api/v1/boards/:id → 204
 *
 * Board config never mutates tasks: drag-across-columns uses the existing
 * PATCH /tasks/:id/status endpoint (transitionTask) and reorder-within-column
 * uses PATCH /tasks/:id/board-position (see lib/tasks.ts patchTaskBoardPosition).
 * Perms: board.read / board.manage.
 */

export type BoardViewType = 'LIST' | 'KANBAN';

export interface Board {
  id: string;
  project_id: string;
  name: string;
  view_type: BoardViewType | string;
  column_config?: unknown;
  filter_config?: unknown;
  version: number;
  [key: string]: unknown;
}

export interface BoardColumn {
  id: string;
  status_code: string;
  name: string;
  position: number;
  wip_limit?: number | null;
  color?: string | null;
  [key: string]: unknown;
}

export interface BoardDetailData {
  board: Board;
  columns: BoardColumn[];
}

export interface CreateBoardInput {
  project_id: string;
  name: string;
  view_type: BoardViewType;
  column_config?: unknown;
  filter_config?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip one `{data:...}` envelope level when the apiClient has not already done so. */
function denest(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return (body as { data: unknown }).data;
  return body;
}

function asArray(body: unknown): unknown[] {
  const raw = denest(body);
  return Array.isArray(raw) ? raw : [];
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeBoardsPage(body: unknown): Board[] {
  return asArray(body) as Board[];
}

/** Normalize a single board payload (bare object, possibly enveloped). */
export function normalizeBoard(body: unknown): Board {
  const raw = denest(body);
  if (isRecord(raw) && typeof raw.id === 'string') return raw as unknown as Board;
  throw new Error('Unrecognized board shape');
}

function toColumn(raw: unknown, fallbackPosition: number): BoardColumn | null {
  if (!isRecord(raw)) return null;
  const statusCode =
    typeof raw.status_code === 'string'
      ? raw.status_code
      : typeof raw.status === 'string'
        ? raw.status
        : null;
  if (typeof raw.id !== 'string' || !statusCode) return null;
  const pos = typeof raw.position === 'number' && Number.isFinite(raw.position) ? raw.position : fallbackPosition;
  return {
    ...raw,
    id: raw.id,
    status_code: statusCode,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : statusCode,
    position: pos,
  } as unknown as BoardColumn;
}

/** Tolerate `{data:[...]}` envelopes and bare arrays; skip unparseable rows. */
export function normalizeBoardColumns(body: unknown): BoardColumn[] {
  const out: BoardColumn[] = [];
  asArray(body).forEach((row, i) => {
    const col = toColumn(row, i);
    if (col) out.push(col);
  });
  return out.sort((a, b) => a.position - b.position);
}

/**
 * Normalize GET /boards/:id. The contract nests the row under `board` with a
 * `columns[]` sibling; tolerate one `{data:...}` envelope level and a flat
 * shape (board fields + columns sibling).
 */
export function normalizeBoardDetail(body: unknown): BoardDetailData {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized board-detail shape');
  const boardRaw = isRecord(raw.board) ? raw.board : raw;
  if (!isRecord(boardRaw) || typeof boardRaw.id !== 'string') {
    throw new Error('Unrecognized board-detail shape');
  }
  const columnsRaw = 'columns' in raw ? (raw as Record<string, unknown>).columns : [];
  return {
    board: boardRaw as unknown as Board,
    columns: normalizeBoardColumns(columnsRaw),
  };
}

export function buildBoardsQuery(params: { project_id?: string } = {}): string {
  const search = new URLSearchParams();
  if (params.project_id) search.set('project_id', params.project_id);
  const qs = search.toString();
  return `/api/v1/boards${qs ? `?${qs}` : ''}`;
}

export async function listBoards(projectId?: string): Promise<Board[]> {
  const { data } = await apiRequest<unknown>(buildBoardsQuery({ project_id: projectId }), {
    method: 'GET',
  });
  return normalizeBoardsPage(data);
}

export async function createBoard(input: CreateBoardInput): Promise<Board> {
  const { data } = await apiRequest<unknown>('/api/v1/boards', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizeBoard(data);
}

export async function getBoard(id: string): Promise<BoardDetailData> {
  const { data } = await apiRequest<unknown>(`/api/v1/boards/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return normalizeBoardDetail(data);
}

/** PATCH board config only (name/view_type/column_config/filter_config) + If-Match. */
export async function patchBoard(
  id: string,
  patch: Record<string, unknown>,
  version: number | string,
): Promise<Board> {
  const { data } = await apiRequest<unknown>(`/api/v1/boards/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: patch,
  });
  return normalizeBoard(data);
}

/** PUT full column replacement + If-Match. Returns the normalized columns. */
export async function replaceBoardColumns(
  id: string,
  columns: Array<Partial<BoardColumn> & { status_code: string }>,
  version: number | string,
): Promise<BoardColumn[]> {
  const { data } = await apiRequest<unknown>(`/api/v1/boards/${encodeURIComponent(id)}/columns`, {
    method: 'PUT',
    headers: { 'If-Match': String(version) },
    body: { columns },
  });
  // Server may return the column list bare/enveloped, or the board detail.
  try {
    const detail = normalizeBoardDetail(data);
    if (detail.columns.length > 0) return detail.columns;
  } catch {
    /* fall through to bare-list parse */
  }
  return normalizeBoardColumns(data);
}

export async function deleteBoard(id: string): Promise<void> {
  await apiRequest<unknown>(`/api/v1/boards/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Pure kanban helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Columns for the board: the board's own columns when present (sorted by
 * position), else a fallback derived from the project workflow statuses so
 * the kanban still renders before any column config exists.
 */
export function boardColumnsOrFallback(
  columns: BoardColumn[],
  workflowStatuses: string[],
): BoardColumn[] {
  if (columns.length > 0) return [...columns].sort((a, b) => a.position - b.position);
  return workflowStatuses.map((status, i) => ({
    id: status,
    status_code: status,
    name: status,
    position: i,
    wip_limit: null,
    color: null,
  }));
}

/** Warn display only — never blocks a drop. At capacity counts as warn. */
export function isWipWarn(count: number, wipLimit: number | null | undefined): boolean {
  return typeof wipLimit === 'number' && Number.isFinite(wipLimit) && wipLimit > 0 && count >= wipLimit;
}

export function wipTone(
  count: number,
  wipLimit: number | null | undefined,
): 'danger' | 'warning' | 'neutral' {
  if (typeof wipLimit !== 'number' || !Number.isFinite(wipLimit) || wipLimit <= 0) return 'neutral';
  if (count > wipLimit) return 'danger';
  if (count >= wipLimit) return 'warning';
  return 'neutral';
}

/** Status-code → tasks grouping used by the kanban (pure, unit-tested). */
export type KanbanGroups = Record<string, Task[]>;

export function groupTasksByColumn(tasks: Task[], statusCodes: string[]): KanbanGroups {
  const groups: KanbanGroups = {};
  for (const code of statusCodes) groups[code] = [];
  for (const t of tasks) {
    const key = String(t.status);
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  return groups;
}

/** Deep-clone a groups map (snapshot before an optimistic move). */
export function snapshotGroups(groups: KanbanGroups): KanbanGroups {
  const out: KanbanGroups = {};
  for (const [k, v] of Object.entries(groups)) out[k] = v.map((t) => ({ ...t }));
  return out;
}

/** Restore a previously snapshotted groups map (rollback — returns a fresh clone). */
export function restoreGroups(snapshot: KanbanGroups): KanbanGroups {
  return snapshotGroups(snapshot);
}

/**
 * Pure optimistic move: relocate `taskId` into `toStatus` (appended at the
 * end) with its `status` field updated. Returns the next groups map; the
 * caller keeps the pre-move snapshot for rollback on INVALID_TRANSITION.
 * No-op (same content) when the task id is unknown.
 */
export function optimisticMoveTask(
  groups: KanbanGroups,
  taskId: string,
  toStatus: string,
): KanbanGroups {
  let found: Task | null = null;
  const next: KanbanGroups = {};
  for (const [k, v] of Object.entries(groups)) {
    next[k] = [];
    for (const t of v) {
      if (t.id === taskId) {
        found = { ...t, status: toStatus };
      } else {
        next[k].push(t);
      }
    }
  }
  if (!found) return snapshotGroups(groups);
  if (!next[toStatus]) next[toStatus] = [];
  next[toStatus].push(found);
  return next;
}

/**
 * Pure optimistic reorder within one column: move `taskId` to `toIndex`
 * (clamped). No-op clone when the column or task is unknown.
 */
export function optimisticReorderColumn(
  groups: KanbanGroups,
  status: string,
  taskId: string,
  toIndex: number,
): KanbanGroups {
  const next = snapshotGroups(groups);
  const col = next[status];
  if (!col) return next;
  const from = col.findIndex((t) => t.id === taskId);
  if (from < 0) return next;
  const [row] = col.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, col.length));
  col.splice(clamped, 0, row);
  return next;
}

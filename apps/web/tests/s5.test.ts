import { describe, expect, it } from 'vitest';
import {
  applySavedFilter,
  buildFilterQuery,
  definitionToQuery,
  filterQueryToDefinition,
  normalizeFilterQuery,
  normalizeSavedFilter,
  normalizeSavedFiltersPage,
} from '../lib/filters';
import {
  boardColumnsOrFallback,
  groupTasksByColumn,
  isWipWarn,
  normalizeBoardColumns,
  normalizeBoardDetail,
  normalizeBoardsPage,
  optimisticMoveTask,
  optimisticReorderColumn,
  restoreGroups,
  snapshotGroups,
  wipTone,
} from '../lib/boards';
import { dependencyEdgeKey } from '../lib/tasks';
import { buildTasksQuery, normalizeTasksCursorPage } from '../lib/tasks';
import {
  SLA_BADGE_LABEL,
  isAttention,
  isOverdue,
  slaFilterToStatus,
  slaLabel,
  slaToFilter,
  toneForSla,
} from '../lib/sla';
import {
  hasUnreadDot,
  inboxEntityHref,
  isUnread,
  normalizeInboxPage,
  unreadDotVisible,
} from '../lib/notifications';
import { normalizeLabels } from '../lib/labels';
import { queryKeys } from '../lib/query-keys';
import { PERMISSIONS } from '../lib/permissions';
import {
  boardColumnsSchema,
  boardSchema,
  isLabelColorValid,
  LABEL_HEX_RE,
  labelSchema,
  savedFilterSchema,
} from '../lib/validation';

const TASK = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: 'pr_1',
  title: `task ${id}`,
  status,
  version: 1,
  ...extra,
});

describe('saved-filter query roundtrip (build↔apply)', () => {
  it('round-trips status/q/assignee_me/label_ids/sla through definition bytes', () => {
    const query = buildFilterQuery({
      status: 'IN_PROGRESS',
      q: 'pump',
      assignee_me: true,
      label_ids: ['l_1', 'l_2'],
      sla: 'overdue',
    });
    const definition = filterQueryToDefinition(query);
    const back = definitionToQuery(definition);
    expect(back).toMatchObject({
      status: 'IN_PROGRESS',
      q: 'pump',
      assignee_me: 'true',
      label_ids: ['l_1', 'l_2'],
      sla: 'overdue',
    });
  });

  it('applies a saved filter to task-list params', () => {
    const filter = normalizeSavedFilter({
      id: 'f_1',
      name: 'mine',
      project_id: 'pr_1',
      query_definition: { status: 'TO_DO', q: 'road', assignee_me: 'true', label_ids: ['l_9'], sla: 'at_risk' },
      version: 2,
    });
    expect(applySavedFilter(filter)).toMatchObject({
      status: 'TO_DO',
      q: 'road',
      assignee_me: 'true',
      label_ids: ['l_9'],
      sla: 'at_risk',
    });
  });

  it('tolerates the `labels` alias and comma-joined strings', () => {
    expect(normalizeFilterQuery({ labels: ['a', 'b'] }).label_ids).toEqual(['a', 'b']);
    expect(normalizeFilterQuery({ label_ids: 'a,b' }).label_ids).toEqual(['a', 'b']);
    expect(normalizeSavedFiltersPage([{ id: 'f_1', name: 'x', query_definition: { q: 'hi' } }])).toHaveLength(1);
  });
});

describe('board column fallback from workflow statuses', () => {
  it('uses board columns (position-sorted) when present', () => {
    const cols = normalizeBoardColumns([
      { id: 'c2', status_code: 'DONE', name: 'Done', position: 1 },
      { id: 'c1', status_code: 'TO_DO', name: 'Todo', position: 0 },
    ]);
    const out = boardColumnsOrFallback(cols, ['TO_DO', 'DONE']);
    expect(out.map((c) => c.status_code)).toEqual(['TO_DO', 'DONE']);
  });

  it('falls back to workflow statuses when the board has no columns', () => {
    const out = boardColumnsOrFallback([], ['TO_DO', 'IN_PROGRESS', 'DONE']);
    expect(out.map((c) => c.status_code)).toEqual(['TO_DO', 'IN_PROGRESS', 'DONE']);
    expect(out[0]).toMatchObject({ id: 'TO_DO', name: 'TO_DO', position: 0 });
  });

  it('normalizes board list/detail envelopes', () => {
    const b = { id: 'b_1', project_id: 'pr_1', name: 'Sprint', view_type: 'KANBAN', version: 1 };
    expect(normalizeBoardsPage({ data: [b] })).toHaveLength(1);
    expect(normalizeBoardsPage([b])).toHaveLength(1);
    const d = normalizeBoardDetail({ board: b, columns: [{ id: 'c1', status_code: 'TO_DO', name: 'Todo', position: 0 }] });
    expect(d.board.id).toBe('b_1');
    expect(d.columns).toHaveLength(1);
    expect(normalizeBoardDetail({ data: { board: b, columns: [] } }).board.id).toBe('b_1');
  });
});

describe('WIP warn helper (display only)', () => {
  it('warns at capacity, danger over, neutral otherwise', () => {
    expect(isWipWarn(3, 3)).toBe(true);
    expect(isWipWarn(4, 3)).toBe(true);
    expect(isWipWarn(2, 3)).toBe(false);
    expect(isWipWarn(5, null)).toBe(false);
    expect(isWipWarn(5, undefined)).toBe(false);
    expect(wipTone(2, 3)).toBe('neutral');
    expect(wipTone(3, 3)).toBe('warning');
    expect(wipTone(4, 3)).toBe('danger');
    expect(wipTone(9, null)).toBe('neutral');
  });
});

describe('dependencyEdgeKey untouched (S5 regression guard)', () => {
  it('still prefers dependency_id over task ids', () => {
    expect(dependencyEdgeKey({ id: 't_0', dependency_id: 'd_1', predecessor_id: 't_0' })).toBe('d_1');
    expect(dependencyEdgeKey({ predecessor_id: 't_0' })).toBe('t_0');
    expect(dependencyEdgeKey({})).toBe('');
  });
});

describe('sla tone/attention helpers', () => {
  it('maps the frozen SLA vocabulary to tones with neutral fallback', () => {
    expect(toneForSla('ON_SCHEDULE')).toBe('success');
    expect(toneForSla('AT_RISK')).toBe('warning');
    expect(toneForSla('OVERDUE')).toBe('danger');
    expect(toneForSla('SOMETHING_NEW')).toBe('neutral');
    expect(toneForSla(null)).toBe('neutral');
  });

  it('labels badges and flags attention/overdue', () => {
    expect(slaLabel('OVERDUE')).toBe('Overdue');
    expect(slaLabel('AT_RISK')).toBe('At risk');
    expect(slaLabel('ON_SCHEDULE')).toBe('On schedule');
    expect(SLA_BADGE_LABEL.OVERDUE).toBe('Overdue');
    expect(isAttention('AT_RISK')).toBe(true);
    expect(isAttention('OVERDUE')).toBe(true);
    expect(isAttention('ON_SCHEDULE')).toBe(false);
    expect(isOverdue('OVERDUE')).toBe(true);
    expect(isOverdue('AT_RISK')).toBe(false);
  });

  it('maps stored statuses to lowercase sla= filter values and back', () => {
    expect(slaToFilter('OVERDUE')).toBe('overdue');
    expect(slaToFilter('AT_RISK')).toBe('at_risk');
    expect(slaToFilter('ON_SCHEDULE')).toBe('on_schedule');
    expect(slaFilterToStatus('overdue')).toBe('OVERDUE');
    expect(slaFilterToStatus('nope')).toBeUndefined();
  });
});

describe('inbox unread-dot helper', () => {
  it('shows the dot when any row or has_more is present (never a count)', () => {
    expect(unreadDotVisible(1, false)).toBe(true);
    expect(unreadDotVisible(0, true)).toBe(true);
    expect(unreadDotVisible(0, false)).toBe(false);
    expect(hasUnreadDot({ items: [{ id: 'n_1' } as never], has_more: false })).toBe(true);
    expect(hasUnreadDot({ items: [], has_more: false })).toBe(false);
    expect(isUnread({ read_at: null })).toBe(true);
    expect(isUnread({ read_at: '2026-09-01' })).toBe(false);
  });

  it('normalizes inbox pages (envelope / bare) and links leave entities', () => {
    const item = { id: 'n_1', type: 'MENTION', title: 'hi', entity_type: 'LEAVE', entity_id: 'lr_1', read_at: null };
    expect(normalizeInboxPage({ data: [item], has_more: false, next_cursor: null }).items).toHaveLength(1);
    expect(normalizeInboxPage([item]).items).toHaveLength(1);
    expect(inboxEntityHref({ entity_type: 'LEAVE', entity_id: 'lr_1' })).toBe('/leave/lr_1');
    expect(inboxEntityHref({ entity_type: 'TASK', entity_id: 't_1' })).toBeNull();
    expect(inboxEntityHref({ entity_type: 'TASK', entity_id: null })).toBeNull();
  });
});

describe('label color validation', () => {
  it('accepts #RRGGBB and rejects the rest', () => {
    expect(LABEL_HEX_RE.test('#2f5bff')).toBe(true);
    expect(isLabelColorValid('#2f5bff')).toBe(true);
    expect(isLabelColorValid('red')).toBe(false);
    expect(isLabelColorValid('#fff')).toBe(false);
    expect(isLabelColorValid(null)).toBe(false);
    expect(labelSchema.safeParse({ name: 'frontend', color: '#2f5bff' }).success).toBe(true);
    expect(labelSchema.safeParse({ name: 'frontend', color: 'blue' }).success).toBe(false);
    expect(labelSchema.safeParse({ name: '', color: '#2f5bff' }).success).toBe(false);
    expect(normalizeLabels({ data: [{ id: 'l_1', name: 'fe', color: '#fff' }] })).toHaveLength(1);
  });
});

describe('transition-rollback cache-snapshot pure helper', () => {
  it('snapshots/restores groups and rolls back an optimistic move', () => {
    const groups = groupTasksByColumn(
      [TASK('t_1', 'TO_DO'), TASK('t_2', 'TO_DO'), TASK('t_3', 'DONE')],
      ['TO_DO', 'DONE'],
    );
    const snapshot = snapshotGroups(groups);
    const moved = optimisticMoveTask(groups, 't_1', 'DONE');
    expect(moved.TO_DO.map((t) => t.id)).toEqual(['t_2']);
    expect(moved.DONE.map((t) => t.id)).toEqual(['t_3', 't_1']);
    expect(moved.DONE.find((t) => t.id === 't_1')?.status).toBe('DONE');
    // Original untouched; restore brings the snapshot back.
    expect(groups.TO_DO).toHaveLength(2);
    expect(restoreGroups(snapshot).TO_DO.map((t) => t.id)).toEqual(['t_1', 't_2']);
  });

  it('reorders within a column without touching other columns', () => {
    const groups = groupTasksByColumn(
      [TASK('t_1', 'TO_DO'), TASK('t_2', 'TO_DO'), TASK('t_3', 'TO_DO')],
      ['TO_DO'],
    );
    const next = optimisticReorderColumn(groups, 'TO_DO', 't_1', 2);
    expect(next.TO_DO.map((t) => t.id)).toEqual(['t_2', 't_3', 't_1']);
    expect(groups.TO_DO.map((t) => t.id)).toEqual(['t_1', 't_2', 't_3']);
  });
});

describe('S5 task query extensions', () => {
  it('serializes sla + label_ids alongside legacy params', () => {
    const qs = buildTasksQuery({ project_id: 'pr_1', sla: 'overdue', label_ids: ['l_1', 'l_2'] });
    expect(qs).toContain('sla=overdue');
    expect(qs).toContain('label_ids=');
    expect(qs).toContain('project_id=pr_1');
    expect(buildTasksQuery({})).toBe('/api/v1/tasks');
  });

  it('normalizes cursor pages (envelope / bare)', () => {
    const t = { id: 't_1', project_id: 'pr_1', title: 'x', status: 'TO_DO', version: 1 };
    const page = normalizeTasksCursorPage({ data: [t], next_cursor: 'c1', has_more: true });
    expect(page.tasks).toHaveLength(1);
    expect(page.next_cursor).toBe('c1');
    expect(page.has_more).toBe(true);
    expect(normalizeTasksCursorPage([t]).tasks).toHaveLength(1);
  });
});

describe('S5 validation + keys + permissions', () => {
  it('validates board payloads (name + view_type enum)', () => {
    expect(boardSchema.safeParse({ project_id: 'pr_1', name: 'Sprint', view_type: 'KANBAN' }).success).toBe(true);
    expect(boardSchema.safeParse({ project_id: 'pr_1', name: '', view_type: 'KANBAN' }).success).toBe(false);
    expect(boardSchema.safeParse({ project_id: 'pr_1', name: 'x', view_type: 'GRID' }).success).toBe(false);
    expect(boardColumnsSchema.safeParse({ columns: [] }).success).toBe(false);
    expect(
      boardColumnsSchema.safeParse({
        columns: [{ status_code: 'TO_DO', name: 'Todo', position: 0, wip_limit: 3, color: '#ffffff' }],
      }).success,
    ).toBe(true);
  });

  it('validates saved filters (name + query passthrough)', () => {
    expect(savedFilterSchema.safeParse({ name: 'mine', query_definition: { q: 'hi', unknown_key: 1 } }).success).toBe(true);
    expect(savedFilterSchema.safeParse({ name: '', query_definition: {} }).success).toBe(false);
  });

  it('exposes S5 query keys and permission codes', () => {
    expect(queryKeys.boards.list({ project_id: 'pr_1' })[0]).toBe('boards');
    expect(queryKeys.board.detail('b_1')).toContain('b_1');
    expect(queryKeys.labels.list({})[0]).toBe('labels');
    expect(queryKeys.savedFilters.list({})[0]).toBe('savedFilters');
    expect(queryKeys.notifications.inboxList({})[0]).toBe('notifications');
    expect(PERMISSIONS.BOARD_READ).toBe('board.read');
    expect(PERMISSIONS.BOARD_MANAGE).toBe('board.manage');
    expect(PERMISSIONS.FILTER_READ).toBe('filter.read');
    expect(PERMISSIONS.FILTER_MANAGE).toBe('filter.manage');
    expect(PERMISSIONS.LABEL_READ).toBe('label.read');
    expect(PERMISSIONS.LABEL_MANAGE).toBe('label.manage');
  });
});

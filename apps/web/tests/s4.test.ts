import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../lib/apiClient';
import {
  buildProjectsQuery,
  isTerminalProjectStatus,
  normalizeProject,
  normalizeProjectDetail,
  normalizeProjectsPage,
  normalizeProjectTypes,
  normalizeWorkspace,
  normalizeWorkspaces,
  parseProjectOpenTasks,
  projectStatusBadgeTone,
  toneForProjectStatus,
} from '../lib/projects';
import {
  buildTasksQuery,
  dependencyEdgeKey,
  dependencyEdgeLabel,
  isTerminalTaskStatus,
  normalizeComments,
  normalizeEvidenceList,
  normalizePostCommentResponse,
  normalizeTask,
  normalizeTaskDetail,
  normalizeTasksPage,
  parseDependencyBlocked,
  parseInvalidTransition,
  taskStatusBadgeTone,
  toneForTaskStatus,
} from '../lib/tasks';
import { PERMISSIONS } from '../lib/permissions';
import {
  assignSchema,
  checkEvidenceFile,
  commentSchema,
  dependencySchema,
  evidenceExtensionOk,
  evidenceSchema,
  EVIDENCE_ALLOWED_EXTENSIONS,
  MAX_TASK_EVIDENCE_BYTES,
  MENTION_HINT_TEXT,
  PROJECT_STATUSES,
  projectSchema,
  statusSchema,
  taskPatchSchema,
  taskQuickAddSchema,
  TASK_STATUSES,
  workspaceSchema,
} from '../lib/validation';

const WS = { id: 'ws_1', name: 'North', description: 'Northern region', status: 'ACTIVE' };
const PTYPE = {
  id: 'pt_1',
  code: 'ROAD',
  name: 'Road works',
  workflow: { statuses: ['DRAFT', 'ACTIVE', 'CLOSED'], allowed_transitions: { DRAFT: ['ACTIVE'] } },
};
const PROJ = {
  id: 'pr_1', workspace_id: 'ws_1', code: 'HYD-01', name: 'Ring road',
  project_type_id: 'pt_1', description: 'Phase 1', project_manager_id: '123e4567-e89b-12d3-a456-426614174000',
  priority: 'HIGH', status: 'DRAFT', version: 1,
};
const TASK = {
  id: 't_1', project_id: 'pr_1', parent_id: null, title: 'Survey',
  description: 'Topo survey', status: 'TO_DO', assignee_id: null, priority: 'HIGH', version: 3,
};
const DETAIL = {
  task: TASK,
  subtasks: [{ ...TASK, id: 't_2', title: 'Sub survey', parent_id: 't_1' }],
  dependencies: {
    blocked_by: [{ id: 'd_1', predecessor_id: 't_0', title: 'Clear site', status: 'DONE' }],
    blocking: [{ id: 'd_2', successor_id: 't_9' }],
  },
  allowed_next: ['IN_PROGRESS', 'BLOCKED'],
};

describe('taskQuickAddSchema (title-only valid, empty invalid)', () => {
  it('accepts a title-only payload', () => {
    expect(taskQuickAddSchema.safeParse({ title: 'Survey chainage 0-5' }).success).toBe(true);
  });

  it('rejects empty / blank titles', () => {
    expect(taskQuickAddSchema.safeParse({ title: '' }).success).toBe(false);
    expect(taskQuickAddSchema.safeParse({ title: '   ' }).success).toBe(false);
  });
});

describe('assignSchema (reason required, UUID assignee)', () => {
  const UUID = '123e4567-e89b-12d3-a456-426614174000';

  it('accepts a UUID assignee with a reason', () => {
    expect(assignSchema.safeParse({ assignee_id: UUID, reason: 'Owns the survey crew' }).success).toBe(true);
  });

  it('rejects a missing/blank reason', () => {
    expect(assignSchema.safeParse({ assignee_id: UUID, reason: '' }).success).toBe(false);
    expect(assignSchema.safeParse({ assignee_id: UUID }).success).toBe(false);
  });

  it('rejects a non-UUID assignee', () => {
    const res = assignSchema.safeParse({ assignee_id: 'usr_9', reason: 'x' });
    expect(res.success).toBe(false);
  });
});

describe('task transition/close error parsers', () => {
  it('parses INVALID_TRANSITION allowed_next', () => {
    const err = new ApiClientError(422, {
      code: 'INVALID_TRANSITION', message: 'bad move', details: { allowed_next: ['IN_PROGRESS', 'BLOCKED'] },
    });
    expect(parseInvalidTransition(err)).toEqual(['IN_PROGRESS', 'BLOCKED']);
    expect(parseInvalidTransition(new ApiClientError(422, { code: 'INVALID_TRANSITION', message: 'x' }))).toEqual([]);
  });

  it('reads allowed_next nested under details.extra (server shape)', () => {
    const err = new ApiClientError(422, {
      code: 'INVALID_TRANSITION', message: 'x', details: { extra: { allowed_next: ['DONE'] } },
    });
    expect(parseInvalidTransition(err)).toEqual(['DONE']);
  });

  it('parses DEPENDENCY_BLOCKED blocking ids', () => {
    const err = new ApiClientError(422, {
      code: 'DEPENDENCY_BLOCKED', message: 'blocked', details: { blocking: ['t_0', 't_7'] },
    });
    expect(parseDependencyBlocked(err)).toEqual(['t_0', 't_7']);
    expect(parseDependencyBlocked(new ApiClientError(422, { code: 'DEPENDENCY_BLOCKED', message: 'x' }))).toEqual([]);
  });

  it('parses PROJECT_HAS_OPEN_TASKS open_count', () => {
    const err = new ApiClientError(422, {
      code: 'PROJECT_HAS_OPEN_TASKS', message: 'open remain', details: { open_count: 4 },
    });
    expect(parseProjectOpenTasks(err)).toBe(4);
    const nested = new ApiClientError(422, {
      code: 'PROJECT_HAS_OPEN_TASKS', message: 'x', details: { extra: { open_count: '2' } },
    });
    expect(parseProjectOpenTasks(nested)).toBe(2);
    expect(parseProjectOpenTasks(new ApiClientError(422, { code: 'PROJECT_HAS_OPEN_TASKS', message: 'x' }))).toBeNull();
  });
});

describe('task normalizers (envelope / bare)', () => {
  it('normalizes task lists from envelope and bare arrays', () => {
    expect(normalizeTasksPage({ data: [TASK] })).toHaveLength(1);
    expect(normalizeTasksPage([TASK])).toHaveLength(1);
    expect(normalizeTasksPage(null)).toEqual([]);
  });

  it('normalizes a single task bare or enveloped', () => {
    expect(normalizeTask(TASK).id).toBe('t_1');
    expect(normalizeTask({ data: TASK }).id).toBe('t_1');
    expect(() => normalizeTask(null)).toThrow();
  });

  it('normalizes task detail incl. allowed_next/subtasks/dependencies', () => {
    const d = normalizeTaskDetail(DETAIL);
    expect(d.task.id).toBe('t_1');
    expect(d.subtasks).toHaveLength(1);
    expect(d.subtasks[0].id).toBe('t_2');
    expect(d.dependencies.blocked_by).toHaveLength(1);
    expect(d.dependencies.blocking).toHaveLength(1);
    expect(d.allowed_next).toEqual(['IN_PROGRESS', 'BLOCKED']);
  });

  it('tolerates an enveloped detail and missing keys (defaults to [])', () => {
    const d = normalizeTaskDetail({ data: { task: TASK } });
    expect(d.task.id).toBe('t_1');
    expect(d.subtasks).toEqual([]);
    expect(d.dependencies).toEqual({ blocked_by: [], blocking: [] });
    expect(d.allowed_next).toEqual([]);
    expect(() => normalizeTaskDetail(null)).toThrow();
  });

  it('normalizes comments and evidence lists (envelope / bare)', () => {
    const c = { id: 'c_1', author_user_id: 'u_1', author_username: 'rani', body: 'hi @ravi', created_at: '2026-09-01' };
    expect(normalizeComments([c])).toHaveLength(1);
    expect(normalizeComments({ data: [c] })).toHaveLength(1);
    const e = { id: 'e_1', evidence_type: 'PHOTO', file_name: 'site.png' };
    expect(normalizeEvidenceList([e])).toHaveLength(1);
    expect(normalizeEvidenceList({ data: [e] })).toHaveLength(1);
  });

  it('normalizes post-comment responses incl. mentioned_usernames', () => {
    const c = { id: 'c_1', author_user_id: 'u_1', author_username: 'rani', body: 'hi @ravi', created_at: 'x' };
    const res = normalizePostCommentResponse({ comment: c, mentioned_usernames: ['ravi'] });
    expect(res.comment.id).toBe('c_1');
    expect(res.mentioned_usernames).toEqual(['ravi']);
    const bare = normalizePostCommentResponse({ data: { comment: c } });
    expect(bare.mentioned_usernames).toEqual([]);
    expect(() => normalizePostCommentResponse(null)).toThrow();
  });
});

describe('project normalizers (envelope / bare)', () => {
  it('normalizes workspaces, types, and project lists (envelope / bare)', () => {
    expect(normalizeWorkspaces({ data: [WS] })).toHaveLength(1);
    expect(normalizeWorkspaces([WS])).toHaveLength(1);
    expect(normalizeProjectTypes({ data: [PTYPE] })).toHaveLength(1);
    expect(normalizeProjectTypes([PTYPE])).toHaveLength(1);
    expect(normalizeProjectsPage({ data: [PROJ] })).toHaveLength(1);
    expect(normalizeProjectsPage([PROJ])).toHaveLength(1);
  });

  it('normalizes a workspace single (bare / enveloped)', () => {
    expect(normalizeWorkspace(WS).id).toBe('ws_1');
    expect(normalizeWorkspace({ data: WS }).id).toBe('ws_1');
  });

  it('normalizes project detail with workflow + counts', () => {
    const d = normalizeProjectDetail({ project: PROJ, workflow: PTYPE.workflow, counts: { total: 5, open: 2, done: 3 } });
    expect(d.project.id).toBe('pr_1');
    expect(d.counts).toMatchObject({ total: 5, open: 2, done: 3 });
    expect(normalizeProject(PROJ).code).toBe('HYD-01');
  });

  it('defaults missing counts to zeros and tolerates flat/enveloped shapes', () => {
    const flat = normalizeProjectDetail({ ...PROJ });
    expect(flat.project.id).toBe('pr_1');
    expect(flat.counts).toMatchObject({ total: 0, open: 0, done: 0 });
    expect(normalizeProjectDetail({ data: { project: PROJ } }).counts.total).toBe(0);
    expect(() => normalizeProjectDetail(null)).toThrow();
  });
});

describe('terminal-state helpers + tone maps', () => {
  it('flags terminal task states (DONE/CANCELLED)', () => {
    expect(isTerminalTaskStatus('DONE')).toBe(true);
    expect(isTerminalTaskStatus('CANCELLED')).toBe(true);
    expect(isTerminalTaskStatus('IN_PROGRESS')).toBe(false);
    expect(isTerminalTaskStatus('BLOCKED')).toBe(false);
    expect(isTerminalTaskStatus('TO_DO')).toBe(false);
  });

  it('flags terminal project states (CLOSED/CANCELLED)', () => {
    expect(isTerminalProjectStatus('CLOSED')).toBe(true);
    expect(isTerminalProjectStatus('CANCELLED')).toBe(true);
    expect(isTerminalProjectStatus('ACTIVE')).toBe(false);
    expect(isTerminalProjectStatus('COMPLETED_PENDING_CLOSE')).toBe(false);
  });

  it('maps frozen status vocabularies to tones with neutral fallback', () => {
    expect(taskStatusBadgeTone.TO_DO).toBe('neutral');
    expect(taskStatusBadgeTone.IN_PROGRESS).toBe('info');
    expect(taskStatusBadgeTone.IN_REVIEW).toBe('warning');
    expect(taskStatusBadgeTone.DONE).toBe('success');
    expect(taskStatusBadgeTone.BLOCKED).toBe('danger');
    expect(taskStatusBadgeTone.CANCELLED).toBe('neutral');
    expect(toneForTaskStatus('SOMETHING_NEW')).toBe('neutral');
    expect(projectStatusBadgeTone.DRAFT).toBe('neutral');
    expect(projectStatusBadgeTone.ACTIVE).toBe('info');
    expect(projectStatusBadgeTone.CLOSED).toBe('success');
    expect(projectStatusBadgeTone.CANCELLED).toBe('danger');
    expect(toneForProjectStatus('SOMETHING_NEW')).toBe('neutral');
    expect(TASK_STATUSES).toEqual(['TO_DO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED']);
    expect(PROJECT_STATUSES).toEqual(['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED_PENDING_CLOSE', 'CLOSED', 'CANCELLED']);
  });
});

describe('dependency edge helpers', () => {
  it('prefers dependency_id, then predecessor/task/successor keys (id is the task, not the edge)', () => {
    expect(dependencyEdgeKey({ id: 't_0', dependency_id: 'd_1', predecessor_id: 't_0' })).toBe('d_1');
    expect(dependencyEdgeKey({ id: 'd_1', predecessor_id: 't_0' })).toBe('t_0');
    expect(dependencyEdgeKey({ predecessor_id: 't_0' })).toBe('t_0');
    expect(dependencyEdgeKey({ task_id: 't_5' })).toBe('t_5');
    expect(dependencyEdgeKey({})).toBe('');
    expect(dependencyEdgeLabel({ title: 'Clear site', predecessor_id: 't_0' })).toBe('Clear site');
    expect(dependencyEdgeLabel({ predecessor_id: 't_0' })).toBe('t_0');
  });

  it('validates predecessor ids as UUIDs', () => {
    expect(dependencySchema.safeParse({ predecessor_id: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
    expect(dependencySchema.safeParse({ predecessor_id: 't_0' }).success).toBe(false);
    expect(dependencySchema.safeParse({ predecessor_id: '' }).success).toBe(false);
  });
});

describe('evidence + comment schemas', () => {
  it('enforces the 5MB cap and extension allowlist', () => {
    expect(MAX_TASK_EVIDENCE_BYTES).toBe(5 * 1024 * 1024);
    expect(EVIDENCE_ALLOWED_EXTENSIONS).toContain('png');
    expect(EVIDENCE_ALLOWED_EXTENSIONS).toContain('pdf');
    expect(checkEvidenceFile({ size: 1024, name: 'site.png' })).toBeNull();
    expect(checkEvidenceFile({ size: 1024, name: 'SITE.PDF' })).toBeNull();
    expect(checkEvidenceFile({ size: 6 * 1024 * 1024, name: 'big.png' })).toMatch(/5MB/);
    expect(checkEvidenceFile({ size: 1024, name: 'run.exe' })).toMatch(/not accepted/);
    expect(checkEvidenceFile({ size: 1024, name: 'noext' })).toMatch(/not accepted/);
    expect(evidenceExtensionOk('a.jpg')).toBe(true);
    expect(evidenceExtensionOk('a.exe')).toBe(false);
  });

  it('validates the evidence payload shape', () => {
    expect(evidenceSchema.safeParse({ evidence_type: 'PHOTO', file_name: 'a.png', content_base64: 'abc' }).success).toBe(true);
    expect(evidenceSchema.safeParse({ evidence_type: '', file_name: 'a.png', content_base64: 'abc' }).success).toBe(false);
  });

  it('requires a non-empty comment body and ships a @mention hint', () => {
    expect(commentSchema.safeParse({ body: 'Done @ravi please verify' }).success).toBe(true);
    expect(commentSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(MENTION_HINT_TEXT).toMatch(/@username/);
  });

  it('validates status + patch payloads (status excluded from patch)', () => {
    expect(statusSchema.safeParse({ status: 'IN_PROGRESS' }).success).toBe(true);
    expect(statusSchema.safeParse({ status: 'invalid status' }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ title: 'New title' }).success).toBe(true);
    expect(taskPatchSchema.safeParse({}).success).toBe(true);
    expect(taskPatchSchema.safeParse({ status: 'DONE' }).success).toBe(false);
  });
});

describe('workspace + project schemas', () => {
  it('requires workspace name, allows optional description', () => {
    expect(workspaceSchema.safeParse({ name: 'North' }).success).toBe(true);
    expect(workspaceSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('requires project workspace/code/name and validates optional UUID/dates', () => {
    const base = { workspace_id: 'ws_1', code: 'HYD-01', name: 'Ring road' };
    expect(projectSchema.safeParse(base).success).toBe(true);
    expect(projectSchema.safeParse({ ...base, code: '' }).success).toBe(false);
    expect(projectSchema.safeParse({ ...base, project_manager_id: 'not-a-uuid' }).success).toBe(false);
    expect(projectSchema.safeParse({
      ...base,
      project_manager_id: '123e4567-e89b-12d3-a456-426614174000',
      planned_start_date: '2026-10-01',
      planned_end_date: '2026-09-01',
    }).success).toBe(false);
    expect(projectSchema.safeParse({ ...base, planned_start_date: '2026-09-01', planned_end_date: '2026-10-01' }).success).toBe(true);
  });
});

describe('query builders', () => {
  it('builds project/task query strings with supported params', () => {
    const pq = buildProjectsQuery({ status: 'ACTIVE', workspace_id: 'ws_1', q: 'road' });
    expect(pq).toContain('/api/v1/projects?');
    expect(pq).toContain('status=ACTIVE');
    expect(pq).toContain('workspace_id=ws_1');
    expect(pq).toContain('q=road');
    const tq = buildTasksQuery({ project_id: 'pr_1', status: 'TO_DO', assignee_me: 'true' });
    expect(tq).toContain('/api/v1/tasks?');
    expect(tq).toContain('project_id=pr_1');
    expect(tq).toContain('assignee_me=true');
    expect(buildTasksQuery({})).toBe('/api/v1/tasks');
  });
});

describe('S4 permission gating codes (exact values)', () => {
  it('exposes the frozen S4 dot-style codes', () => {
    expect(PERMISSIONS.WORKSPACE_READ).toBe('workspace.read');
    expect(PERMISSIONS.WORKSPACE_MANAGE).toBe('workspace.manage');
    expect(PERMISSIONS.PROJECT_CREATE).toBe('project.create');
    expect(PERMISSIONS.PROJECT_READ).toBe('project.read');
    expect(PERMISSIONS.PROJECT_UPDATE).toBe('project.update');
    expect(PERMISSIONS.PROJECT_CLOSE).toBe('project.close');
    expect(PERMISSIONS.TASK_CREATE).toBe('task.create');
    expect(PERMISSIONS.TASK_READ).toBe('task.read');
    expect(PERMISSIONS.TASK_UPDATE).toBe('task.update');
    expect(PERMISSIONS.TASK_TRANSITION).toBe('task.transition');
    expect(PERMISSIONS.TASK_ASSIGN).toBe('task.assign');
    expect(PERMISSIONS.TASK_COMMENT).toBe('task.comment');
    expect(PERMISSIONS.TASK_REORDER).toBe('task.reorder');
  });
});

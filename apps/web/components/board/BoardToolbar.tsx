'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { apiRequest } from '@/lib/apiClient';
import { listLabels } from '@/lib/labels';
import { listSavedFilters, applySavedFilter } from '@/lib/filters';
import { queryKeys } from '@/lib/query-keys';
import { TASK_STATUSES } from '@/lib/validation';
import { SLA_FILTER_VALUES } from '@/lib/sla';
import { statusLabel } from '@/lib/board-visuals';
import type { ListTasksParams } from '@/lib/tasks';
import { AdvancedTaskFilters } from '../v2/AdvancedTaskFilters';
import { FilterChip, SegmentedControl, ToggleChip } from './FilterChip';
import { Input } from '../ui/Input';

/** Filter keys the dedicated chips own; anything else belongs to "More". */
const CHIPPED_KEYS = new Set(['status', 'q', 'assignee_me', 'label_ids', 'sla', 'limit', 'cursor']);

function countExtra(value: ListTasksParams): number {
  return Object.entries(value).filter(([k, v]) => {
    if (CHIPPED_KEYS.has(k)) return false;
    if (v === undefined || v === '' || v === null) return false;
    if (k === 'custom_fields') return Object.keys(v as object).length > 0;
    return true;
  }).length;
}

/**
 * The board's single control row: view switch, filter chips, and the create
 * action — everything that used to occupy roughly half the viewport as stacked
 * form rows.
 *
 * Every control here is the same one the old inline bar exposed and writes to
 * the same `ListTasksParams`; only the presentation changed. Permission gates
 * carry over unchanged — a viewer without `label.read` gets no Labels chip
 * rather than a chip that opens onto an error.
 */
export function BoardToolbar({
  projectId,
  value,
  onChange,
  view,
  onViewChange,
  hideDone,
  onHideDoneChange,
  taskCount,
  right,
}: {
  projectId: string;
  value: ListTasksParams;
  onChange: (v: ListTasksParams) => void;
  view: 'board' | 'list';
  onViewChange: (v: 'board' | 'list') => void;
  hideDone: boolean;
  onHideDoneChange: (v: boolean) => void;
  taskCount: number;
  /** Trailing slot for page-level actions (e.g. "New task"). */
  right?: React.ReactNode;
}) {
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canReadLabels = hasPermission(holder, PERMISSIONS.LABEL_READ);
  const canReadFilters = hasPermission(holder, PERMISSIONS.FILTER_READ);

  const set = (patch: Partial<ListTasksParams>) => onChange({ ...value, ...patch });

  const workflow = useQuery({
    queryKey: ['workflow', projectId],
    queryFn: async () =>
      (await apiRequest<{ statuses: string[] }>(`/api/v1/projects/${projectId}/workflow`)).data,
    enabled: !!projectId,
  });
  const labelsQuery = useQuery({
    queryKey: queryKeys.labels.list({ project_id: projectId }),
    queryFn: () => listLabels(projectId),
    staleTime: 30_000,
    retry: false,
    enabled: canReadLabels && !!projectId,
  });
  const savedQuery = useQuery({
    queryKey: queryKeys.savedFilters.list({ project_id: projectId }),
    queryFn: () => listSavedFilters(projectId),
    staleTime: 30_000,
    retry: false,
    enabled: canReadFilters && !!projectId,
  });

  const labels = labelsQuery.data ?? [];
  const savedFilters = savedQuery.data ?? [];
  const selectedLabels: string[] = Array.isArray(value.label_ids)
    ? value.label_ids
    : typeof value.label_ids === 'string' && value.label_ids
      ? value.label_ids.split(',')
      : [];
  const extraCount = countExtra(value);

  const toggleLabel = (id: string) => {
    const next = selectedLabels.includes(id)
      ? selectedLabels.filter((l) => l !== id)
      : [...selectedLabels, id];
    set({ label_ids: next.length ? next : undefined });
  };

  const labelSummary =
    selectedLabels.length === 0
      ? null
      : selectedLabels.length === 1
        ? (labels.find((l) => l.id === selectedLabels[0])?.name ?? '1 selected')
        : `${selectedLabels.length} selected`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        label="View"
        value={view}
        onChange={onViewChange}
        options={[
          { value: 'board', label: 'Board', icon: <BoardIcon /> },
          { value: 'list', label: 'List', icon: <ListIcon /> },
        ]}
      />

      <div className="h-5 w-px bg-border" aria-hidden="true" />

      {/* Search reads as a field rather than a chip: it is the one control
          people type into directly instead of picking from a set. */}
      <div className="relative w-52">
        <SearchIcon />
        <Input
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={value.q ?? ''}
          onChange={(e) => set({ q: e.target.value || undefined })}
          className="!h-8 !pl-7 !text-xs"
        />
      </div>

      <FilterChip
        label="Status"
        value={value.status ? statusLabel(String(value.status)) : null}
        onClear={() => set({ status: undefined })}
      >
        <div className="flex flex-col gap-1">
          {(workflow.data?.statuses ?? TASK_STATUSES).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set({ status: value.status === s ? undefined : s })}
              className={`rounded px-2 py-1 text-left text-xs ${
                value.status === s ? 'bg-primary-subtle text-primary' : 'text-text-muted hover:bg-surface-sunken'
              }`}
            >
              {statusLabel(s)}
            </button>
          ))}
        </div>
      </FilterChip>

      <FilterChip
        label="SLA"
        value={value.sla ? statusLabel(String(value.sla)) : null}
        onClear={() => set({ sla: undefined })}
      >
        <div className="flex flex-col gap-1">
          {SLA_FILTER_VALUES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set({ sla: value.sla === s ? undefined : s })}
              className={`rounded px-2 py-1 text-left text-xs ${
                value.sla === s ? 'bg-primary-subtle text-primary' : 'text-text-muted hover:bg-surface-sunken'
              }`}
            >
              {statusLabel(s)}
            </button>
          ))}
        </div>
      </FilterChip>

      {canReadLabels ? (
        <FilterChip
          label="Labels"
          value={labelSummary}
          onClear={() => set({ label_ids: undefined })}
        >
          {labelsQuery.isLoading ? (
            <p className="text-xs text-text-muted">Loading labels…</p>
          ) : labels.length === 0 ? (
            <p className="text-xs text-text-muted">No labels in this project yet.</p>
          ) : (
            <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {labels.map((l) => (
                <label
                  key={l.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-text-muted hover:bg-surface-sunken"
                >
                  <input
                    type="checkbox"
                    checked={selectedLabels.includes(l.id)}
                    onChange={() => toggleLabel(l.id)}
                  />
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-border"
                    style={{ backgroundColor: l.color ?? 'hsl(var(--status-neutral))' }}
                  />
                  <span className="truncate">{l.name}</span>
                </label>
              ))}
            </div>
          )}
        </FilterChip>
      ) : null}

      <FilterChip
        label="More"
        value={extraCount ? `${extraCount}` : null}
        onClear={() => {
          const next: ListTasksParams = {};
          for (const [k, v] of Object.entries(value)) {
            if (CHIPPED_KEYS.has(k)) (next as Record<string, unknown>)[k] = v;
          }
          onChange(next);
        }}
      >
        <div className="max-h-80 w-72 overflow-y-auto">
          <AdvancedTaskFilters
            project={projectId}
            value={value}
            onChange={(next) => onChange(next)}
          />
        </div>
      </FilterChip>

      {canReadFilters && savedFilters.length > 0 ? (
        <FilterChip label="Saved">
          <div className="flex flex-col gap-1">
            {savedFilters.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onChange(applySavedFilter(f))}
                className="rounded px-2 py-1 text-left text-xs text-text-muted hover:bg-surface-sunken"
              >
                {f.name}
              </button>
            ))}
          </div>
        </FilterChip>
      ) : null}

      <ToggleChip
        label="Assigned to me"
        pressed={value.assignee_me === 'true'}
        onChange={(v) => set({ assignee_me: v ? 'true' : undefined })}
      />
      <ToggleChip label="Hide done" pressed={hideDone} onChange={onHideDoneChange} />

      <span className="flex items-center gap-3 sm:ml-auto">
        <span className="text-xs tabular-nums text-text-subtle">
          {taskCount} task{taskCount === 1 ? '' : 's'}
        </span>
        {right}
      </span>
    </div>
  );
}

function BoardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" className="h-3 w-3">
      <rect x="1" y="2" width="3.5" height="10" rx="1" fill="currentColor" />
      <rect x="5.25" y="2" width="3.5" height="7" rx="1" fill="currentColor" />
      <rect x="9.5" y="2" width="3.5" height="9" rx="1" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" className="h-3 w-3">
      <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-subtle"
    >
      <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { apiRequest } from '@/lib/apiClient';
import type { ListTasksParams } from '@/lib/tasks';
import { AdvancedTaskFilters } from './v2/AdvancedTaskFilters';
import { listLabels } from '@/lib/labels';
import { queryKeys } from '@/lib/query-keys';
import {
  applySavedFilter,
  buildFilterQuery,
  createSavedFilter,
  deleteSavedFilter,
  listSavedFilters,
} from '@/lib/filters';
import { TASK_STATUSES } from '@/lib/validation';
import { SLA_FILTER_VALUES } from '@/lib/sla';
import { applyFieldErrors } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { Input } from './ui/Input';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

const saveSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
});
type SaveInput = z.infer<typeof saveSchema>;

/**
 * Extended task-list filter bar: status + search + assignee-me (lifted from
 * the list page) plus S5 label multi-select, SLA select, saved-filter apply
 * dropdown and save-filter dialog. All values stay lifted in the parent —
 * this component only renders controls.
 */
export function FilterBar({
  projectId,
  status,
  setStatus,
  q,
  setQ,
  mineOnly,
  setMineOnly,
  labelIds,
  setLabelIds,
  sla,
  setSla,
  extra = {},
  setExtra,
  idPrefix = 'filter',
}: {
  projectId: string;
  status: string;
  setStatus: (v: string) => void;
  q: string;
  setQ: (v: string) => void;
  mineOnly: boolean;
  setMineOnly: (v: boolean) => void;
  labelIds: string[];
  setLabelIds: (v: string[]) => void;
  sla: string;
  setSla: (v: string) => void;
  extra?: ListTasksParams;
  setExtra?: (v: ListTasksParams) => void;
  idPrefix?: string;
}) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canReadFilters = hasPermission(holder, PERMISSIONS.FILTER_READ);
  const canManageFilters = hasPermission(holder, PERMISSIONS.FILTER_MANAGE);
  const canReadLabels = hasPermission(holder, PERMISSIONS.LABEL_READ);

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [selectedFilter, setSelectedFilter] = React.useState('');
  const [actionError, setActionError] = React.useState<unknown>(null);
  const [savedNote, setSavedNote] = React.useState<string | null>(null);

  const labelsQuery = useQuery({
    queryKey: queryKeys.labels.list({ project_id: projectId }),
    queryFn: () => listLabels(projectId),
    staleTime: 30_000,
    retry: false,
    enabled: canReadLabels,
  });

  const filtersQuery = useQuery({
    queryKey: queryKeys.savedFilters.list({ project_id: projectId }),
    queryFn: () => listSavedFilters(projectId),
    staleTime: 30_000,
    retry: false,
    enabled: canReadFilters,
  });

  const workflow = useQuery({queryKey:['workflow',projectId], queryFn:async()=>(await apiRequest<{statuses:string[]}>(`/api/v1/projects/${projectId}/workflow`)).data, enabled:!!projectId});
  const savedFilters = filtersQuery.data ?? [];
  const labels = labelsQuery.data ?? [];

  const toggleLabel = (id: string) => {
    setLabelIds(labelIds.includes(id) ? labelIds.filter((l) => l !== id) : [...labelIds, id]);
  };

  const applySelected = () => {
    const found = savedFilters.find((f) => f.id === selectedFilter);
    if (!found) return;
    const params = applySavedFilter(found);
    setStatus(typeof params.status === 'string' ? params.status : '');
    setQ(typeof params.q === 'string' ? params.q : '');
    setMineOnly(params.assignee_me === 'true');
    setLabelIds(Array.isArray(params.label_ids) ? [...params.label_ids] : []);
    setSla(typeof params.sla === 'string' ? params.sla : '');
    const {status: _status,q: _q,assignee_me: _mine,label_ids: _labels,sla: _sla,...rest}=params;
    setExtra?.(rest);
    setSavedNote(`Applied “${found.name}”.`);
  };

  const deleteSelected = async () => {
    const found = savedFilters.find((f) => f.id === selectedFilter);
    if (!found) return;
    setActionError(null);
    try {
      await deleteSavedFilter(found.id);
      setSelectedFilter('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.savedFilters.all });
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div>
          <label htmlFor={`${idPrefix}-status`} className="text-sm font-medium text-text-muted">
            Status
          </label>
          <select id={`${idPrefix}-status`} className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {(workflow.data?.statuses ?? TASK_STATUSES).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label htmlFor={`${idPrefix}-q`} className="text-sm font-medium text-text-muted">
            Search
          </label>
          <Input id={`${idPrefix}-q`} placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-muted">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          Assigned to me
        </label>
        <div>
          <label htmlFor={`${idPrefix}-sla`} className="text-sm font-medium text-text-muted">
            SLA
          </label>
          <select id={`${idPrefix}-sla`} className={inputClass} value={sla} onChange={(e) => setSla(e.target.value)}>
            <option value="">All</option>
            {SLA_FILTER_VALUES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {setExtra ? <AdvancedTaskFilters project={projectId} value={extra} onChange={setExtra} /> : null}
      {canReadLabels ? (
        <fieldset>
          <legend className="text-sm font-medium text-text-muted">Labels</legend>
          {labelsQuery.isLoading ? (
            <p className="mt-1 text-sm text-text-muted">Loading labels…</p>
          ) : labelsQuery.isError ? (
            <p className="mt-1 text-sm text-text-muted">Labels unavailable.</p>
          ) : labels.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">No labels in this project yet.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-3">
              {labels.map((l) => (
                <label key={l.id} className="flex items-center gap-1.5 text-sm text-text-muted">
                  <input
                    type="checkbox"
                    checked={labelIds.includes(l.id)}
                    onChange={() => toggleLabel(l.id)}
                  />
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-border"
                    style={{ backgroundColor: l.color ?? '#cbd5e1' }}
                  />
                  {l.name}
                </label>
              ))}
              {labelIds.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setLabelIds([])}
                  className="text-xs text-primary hover:underline"
                >
                  Clear labels
                </button>
              ) : null}
            </div>
          )}
        </fieldset>
      ) : null}

      {canReadFilters ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor={`${idPrefix}-saved`} className="text-sm font-medium text-text-muted">
              Saved filters
            </label>
            <select
              id={`${idPrefix}-saved`}
              className={inputClass}
              value={selectedFilter}
              onChange={(e) => {
                setSelectedFilter(e.target.value);
                setSavedNote(null);
                setActionError(null);
              }}
            >
              <option value="">Pick a saved filter…</option>
              {savedFilters.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!selectedFilter} onClick={applySelected}>
              Apply
            </Button>
            {canManageFilters ? (
              <>
                <Button variant="secondary" onClick={() => setSaveOpen((v) => !v)}>
                  {saveOpen ? 'Close' : 'Save current…'}
                </Button>
                {selectedFilter ? (
                  <Button variant="secondary" onClick={() => void deleteSelected()}>
                    Delete
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {savedNote ? (
        <p role="status" className="text-sm text-success">
          {savedNote}
        </p>
      ) : null}
      {actionError ? <ErrorCard title="Saved-filter action failed" error={actionError} /> : null}
      {saveOpen && canManageFilters ? (
        <SaveFilterDialog
          projectId={projectId}
          status={status}
          q={q}
          mineOnly={mineOnly}
          labelIds={labelIds}
          sla={sla}
          extra={extra}
          onSaved={(name) => {
            setSavedNote(`Saved “${name}”.`);
            setSaveOpen(false);
          }}
          onClose={() => setSaveOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SaveFilterDialog({
  projectId,
  status,
  q,
  mineOnly,
  labelIds,
  sla,
  extra,
  onSaved,
  onClose,
}: {
  projectId: string;
  status: string;
  q: string;
  mineOnly: boolean;
  labelIds: string[];
  sla: string;
  extra: ListTasksParams;
  onSaved: (name: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [shared, setShared] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<SaveInput>({
    resolver: zodResolver(saveSchema),
    defaultValues: { name: '' },
  });

  const mutation = useMutation({
    mutationFn: (v: SaveInput) =>
      createSavedFilter({
        project_id: projectId,
        name: v.name.trim(),
        shared,
        query_definition: buildFilterQuery({
          extra,
          status: status || undefined,
          q: q.trim() || undefined,
          assignee_me: mineOnly,
          label_ids: labelIds,
          sla: sla || undefined,
        }),
      }),
    onSuccess: async (row) => {
      setSubmitError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.savedFilters.all });
      onSaved(row.name);
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof SaveInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  return (
    <form
      onSubmit={handleSubmit((v) => mutation.mutate(v))}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
      noValidate
    >
      <label htmlFor="save-filter-name" className="text-sm font-medium text-text-muted">
        Save current filters as
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <Input
            id="save-filter-name"
            placeholder="e.g. My overdue frontend bugs"
            invalid={!!errors.name}
            {...register('name')}
          />
          {errors.name?.message ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {errors.name.message}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={mutation.isPending}>
            Save
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
      <label className="text-sm"><input type="checkbox" checked={shared} onChange={e=>setShared(e.target.checked)} /> Share with this project</label>
      {submitError ? <ErrorCard title="Could not save filter" error={submitError} /> : null}
    </form>
  );
}

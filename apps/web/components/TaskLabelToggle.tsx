'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attachTaskLabel, detachTaskLabel, listLabels, type Label } from '@/lib/labels';
import type { TaskLabelRef } from '@/lib/tasks';
import { queryKeys } from '@/lib/query-keys';
import { ErrorCard } from './ui/ErrorCard';
import { Spinner } from './ui/Spinner';

/**
 * Task label toggle on the task detail page: checkbox list of all project
 * labels; attach/detach per box. `attached` comes from the task detail's
 * `labels[]`; `onChanged` refetches the detail.
 */
export function TaskLabelToggle({
  taskId,
  projectId,
  attached,
  onChanged,
}: {
  taskId: string;
  projectId?: string;
  attached: TaskLabelRef[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = React.useState<unknown>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  const labelsQuery = useQuery({
    queryKey: queryKeys.labels.list({ project_id: projectId ?? '' }),
    queryFn: () => listLabels(projectId),
    staleTime: 30_000,
    retry: false,
  });

  const attachedIds = React.useMemo(() => new Set(attached.map((l) => l.id)), [attached]);

  const toggleMutation = useMutation({
    mutationFn: async ({ label, on }: { label: Label; on: boolean }) => {
      setPendingId(label.id);
      try {
        if (on) await attachTaskLabel(taskId, label.id);
        else await detachTaskLabel(taskId, label.id);
      } finally {
        setPendingId(null);
      }
    },
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      onChanged();
    },
    onError: (err) => setActionError(err),
  });

  const rows = labelsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      {labelsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner size="sm" /> Loading labels…
        </div>
      ) : labelsQuery.isError ? (
        <ErrorCard title="Could not load labels" error={labelsQuery.error} onRetry={() => labelsQuery.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No labels in this project yet — create one in the Board view.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((l) => {
            const on = attachedIds.has(l.id);
            const pending = pendingId === l.id || toggleMutation.isPending;
            return (
              <li key={l.id} className="flex items-center gap-3 text-sm">
                <input
                  id={`task-label-${taskId}-${l.id}`}
                  type="checkbox"
                  checked={on}
                  disabled={pending && pendingId === l.id}
                  onChange={(e) => toggleMutation.mutate({ label: l, on: e.target.checked })}
                />
                <label htmlFor={`task-label-${taskId}-${l.id}`} className="flex items-center gap-2 text-slate-800">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-slate-300"
                    style={{ backgroundColor: l.color ?? '#cbd5e1' }}
                  />
                  <span className="font-medium">{l.name}</span>
                  {l.color ? <span className="font-mono text-xs text-slate-400">{l.color}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {actionError ? <ErrorCard title="Could not update task labels" error={actionError} /> : null}
    </div>
  );
}

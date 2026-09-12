'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import {
  addDependency,
  dependencyEdgeKey,
  dependencyEdgeLabel,
  removeDependency,
  type DependencyEdge,
} from '@/lib/tasks';
import { dependencySchema, type DependencyFormInput } from '@/lib/validation';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { Input } from './ui/Input';
import { Spinner } from './ui/Spinner';

/**
 * Task dependency manager. `blocked_by` = predecessors this task waits on;
 * `blocking` = successors waiting on this task. Add by predecessor task-ID
 * (UUID); remove by edge key (edge id preferred — see dependencyEdgeKey).
 */
export function DependencyManager({
  taskId,
  blockedBy,
  blocking,
  onChanged,
}: {
  taskId: string;
  blockedBy: DependencyEdge[];
  blocking: DependencyEdge[];
  onChanged: () => void;
}) {
  const [actionError, setActionError] = React.useState<unknown>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DependencyFormInput>({
    resolver: zodResolver(dependencySchema),
    defaultValues: { predecessor_id: '' },
  });

  const addMutation = useMutation({
    mutationFn: (v: DependencyFormInput) => addDependency(taskId, v.predecessor_id.trim()),
    onSuccess: () => {
      setActionError(null);
      reset({ predecessor_id: '' });
      onChanged();
    },
    onError: (err) => setActionError(err),
  });

  const onRemove = async (edge: DependencyEdge) => {
    const key = dependencyEdgeKey(edge);
    if (!key) {
      setActionError(new Error('Could not determine the dependency id for removal.'));
      return;
    }
    setRemoving(key);
    setActionError(null);
    try {
      await removeDependency(taskId, key);
      onChanged();
    } catch (err) {
      setActionError(err);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <EdgeList
          title={`Blocked by (${blockedBy.length})`}
          description="Predecessors that must finish first."
          edges={blockedBy}
          removing={removing}
          onRemove={onRemove}
        />
        <EdgeList
          title={`Blocking (${blocking.length})`}
          description="Successors waiting on this task."
          edges={blocking}
          removing={removing}
          onRemove={onRemove}
        />
      </div>
      <form onSubmit={handleSubmit((v) => addMutation.mutate(v))} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
        <div className="flex-1">
          <label htmlFor={`dep-add-${taskId}`} className="text-sm font-medium text-text-muted">
            Add predecessor (task ID)
          </label>
          <Input
            id={`dep-add-${taskId}`}
            placeholder="Paste predecessor task ID (UUID)…"
            className="mt-1 font-mono"
            invalid={!!errors.predecessor_id}
            {...register('predecessor_id')}
          />
          {errors.predecessor_id?.message ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {errors.predecessor_id.message}
            </p>
          ) : null}
        </div>
        <div className="pt-0 sm:pt-6">
          <Button type="submit" variant="secondary" loading={addMutation.isPending}>
            Add dependency
          </Button>
        </div>
      </form>
      {actionError ? <ErrorCard title="Dependency update failed" error={actionError} /> : null}
    </div>
  );
}

function EdgeList({
  title,
  description,
  edges,
  removing,
  onRemove,
}: {
  title: string;
  description: string;
  edges: DependencyEdge[];
  removing: string | null;
  onRemove: (edge: DependencyEdge) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <p className="text-xs text-text-muted">{description}</p>
      {edges.length === 0 ? (
        <p className="mt-2 text-sm text-text-subtle">None.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {edges.map((e, i) => {
            const key = dependencyEdgeKey(e) || `edge-${i}`;
            return (
              <li key={key} className="flex items-center justify-between gap-2 rounded-md bg-surface-sunken px-2 py-1.5 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-text">{dependencyEdgeLabel(e)}</span>
                  {e.status ? <span className="font-mono text-xs text-text-muted">{String(e.status)}</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(e)}
                  disabled={removing === key}
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-danger hover:underline disabled:opacity-50"
                >
                  {removing === key ? <Spinner size="sm" /> : null}
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

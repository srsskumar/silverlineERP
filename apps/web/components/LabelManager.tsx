'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import { createLabel, listLabels } from '@/lib/labels';
import { queryKeys } from '@/lib/query-keys';
import { labelSchema, type LabelFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { LabelPill } from './LabelPill';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { Spinner } from './ui/Spinner';

/**
 * Project label manager: lists labels (label.read) + creates new ones
 * (label.manage). 409 LABEL_EXISTS surfaces the server message inline.
 */
export function LabelManager({
  projectId,
  canManage,
}: {
  projectId?: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [conflictNote, setConflictNote] = React.useState<string | null>(null);

  const labelsQuery = useQuery({
    queryKey: queryKeys.labels.list({ project_id: projectId ?? '' }),
    queryFn: () => listLabels(projectId),
    staleTime: 30_000,
    retry: false,
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<LabelFormInput>({
    resolver: zodResolver(labelSchema),
    defaultValues: { name: '', color: '', project_id: projectId ?? '' },
  });

  React.useEffect(() => {
    reset({ name: '', color: '', project_id: projectId ?? '' });
  }, [projectId, reset]);

  const createMutation = useMutation({
    mutationFn: (v: LabelFormInput) =>
      createLabel({
        ...(projectId ? { project_id: projectId } : {}),
        name: v.name.trim(),
        ...(v.color?.trim() ? { color: v.color.trim() } : {}),
      }),
    onSuccess: async () => {
      setSubmitError(null);
      setConflictNote(null);
      reset({ name: '', color: '', project_id: projectId ?? '' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.labels.all });
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof LabelFormInput, e));
      if (err instanceof ApiClientError && (err.code === 'LABEL_EXISTS' || err.status === 409)) {
        setConflictNote(err.message || 'A label with this name already exists in this scope.');
        return;
      }
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  const rows = labelsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      {labelsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Spinner size="sm" /> Loading labels…
        </div>
      ) : labelsQuery.isError ? (
        <ErrorCard title="Could not load labels" error={labelsQuery.error} onRetry={() => labelsQuery.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">No labels yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rows.map((l) => (
            <LabelPill key={l.id} label={l} />
          ))}
        </div>
      )}
      {canManage ? (
        <form onSubmit={handleSubmit((v) => createMutation.mutate(v))} className="flex flex-col gap-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="New label name" htmlFor="label-name" error={errors.name?.message}>
              <Input id="label-name" placeholder="e.g. frontend" invalid={!!errors.name} {...register('name')} />
            </FormField>
            <FormField label="Color (#RRGGBB, optional)" htmlFor="label-color" error={errors.color?.message}>
              <Input
                id="label-color"
                placeholder="#2f5bff"
                className="font-mono"
                invalid={!!errors.color}
                {...register('color')}
              />
            </FormField>
          </div>
          {conflictNote ? (
            <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-2 text-sm text-warning">
              {conflictNote}
            </div>
          ) : null}
          {submitError ? <ErrorCard title="Could not create label" error={submitError} /> : null}
          <div>
            <Button type="submit" variant="secondary" loading={createMutation.isPending}>
              Create label
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

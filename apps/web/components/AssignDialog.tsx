'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { assignTask, type Task } from '@/lib/tasks';
import { assignSchema, type AssignFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { shortUserId } from './ApprovalTimeline';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';

/**
 * Assign a task to a user. There is NO users endpoint in S4, so the assignee
 * is a user-ID (UUID) text field — paste the id. `reason` is required
 * server-side and enforced here client-side too.
 */
export function AssignDialog({
  taskId,
  currentAssigneeId,
  open,
  onClose,
  onAssigned,
}: {
  taskId: string;
  currentAssigneeId?: string | null;
  open: boolean;
  onClose: () => void;
  onAssigned: (task: Task) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<AssignFormInput>({
    resolver: zodResolver(assignSchema),
    defaultValues: { assignee_id: '', reason: '' },
  });

  React.useEffect(() => {
    if (open) {
      reset({ assignee_id: '', reason: '' });
      setSubmitError(null);
    }
  }, [open, reset]);

  const mutation = useMutation({
    mutationFn: (v: AssignFormInput) =>
      assignTask(taskId, { assignee_id: v.assignee_id.trim(), reason: v.reason.trim() }),
    onSuccess: (task) => {
      setSubmitError(null);
      onAssigned(task);
      onClose();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof AssignFormInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Assign task" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">Assign task</h2>
        <p className="mt-1 text-xs text-text-muted">
          {currentAssigneeId ? (
            <>
              Currently assigned to <span className="font-mono" title={String(currentAssigneeId)}>{shortUserId(String(currentAssigneeId))}</span>.
            </>
          ) : (
            'Currently unassigned.'
          )}{' '}
          S4 has no users directory — paste the user ID (UUID).
        </p>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Assignee user ID (UUID) *" htmlFor="assign-user" error={errors.assignee_id?.message}>
            <Input
              id="assign-user"
              placeholder="e.g. 123e4567-e89b-12d3-a456-426614174000"
              className="font-mono"
              invalid={!!errors.assignee_id}
              {...register('assignee_id')}
            />
          </FormField>
          <FormField label="Reason *" htmlFor="assign-reason" error={errors.reason?.message}>
            <textarea
              id="assign-reason"
              rows={2}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
              placeholder="Why is this person the right owner? (required)"
              {...register('reason')}
            />
          </FormField>
          {submitError ? <ErrorCard title="Could not assign task" error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Assign
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

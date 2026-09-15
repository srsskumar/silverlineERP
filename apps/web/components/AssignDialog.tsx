'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { assignTask, type Task } from '@/lib/tasks';
import { assignSchema, type AssignFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { listPeople, peopleIndex, personLabel } from '@/lib/people';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';

/**
 * Assign a task to somebody, by name.
 *
 * This used to ask for a user UUID, on the premise that there was no users
 * directory. There is one now, and it reports the name from the employee
 * record — which is how everybody actually refers to a colleague. Pasting an
 * identifier found in another screen was never a reasonable thing to ask.
 *
 * `reason` stays required: reassigning somebody else's work is a decision that
 * should be explainable afterwards.
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

  const people = useQuery({
    queryKey: ['people'],
    queryFn: listPeople,
    staleTime: 300_000,
    enabled: open,
  });
  const index = React.useMemo(() => peopleIndex(people.data ?? []), [people.data]);

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
          {currentAssigneeId
            ? <>Currently assigned to <span className="font-medium text-text">{personLabel(index, currentAssigneeId)}</span>.</>
            : 'Currently unassigned.'}
        </p>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Assign to *" htmlFor="assign-user" error={errors.assignee_id?.message}>
            <select
              id="assign-user"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
              disabled={people.isLoading}
              {...register('assignee_id')}
            >
              <option value="">{people.isLoading ? 'Loading people…' : 'Choose a person…'}</option>
              {(people.data ?? [])
                .filter((p) => p.id !== currentAssigneeId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.emp_no ? ` · ${p.emp_no}` : ''}
                  </option>
                ))}
            </select>
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

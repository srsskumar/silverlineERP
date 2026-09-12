'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { createTask, type Task } from '@/lib/tasks';
import { taskQuickAddSchema, type TaskQuickAddInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { Input } from './ui/Input';

/**
 * Title-only quick-add for tasks. The project is fixed by context; pass
 * `parentId` to create a subtask. On success the form resets and the parent
 * prepends the returned task via `onCreated`.
 */
export function QuickAddTask({
  projectId,
  parentId,
  onCreated,
  idPrefix = 'quick-add',
}: {
  projectId: string;
  parentId?: string;
  onCreated?: (task: Task) => void;
  idPrefix?: string;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<TaskQuickAddInput>({
    resolver: zodResolver(taskQuickAddSchema),
    defaultValues: { title: '' },
  });

  const mutation = useMutation({
    mutationFn: (v: TaskQuickAddInput) =>
      createTask({
        project_id: projectId,
        title: v.title.trim(),
        // Server field is parent_task_id (contract); parentId prop stays generic.
        ...(parentId ? { parent_task_id: parentId } : {}),
      }),
    onSuccess: (task) => {
      setSubmitError(null);
      reset({ title: '' });
      onCreated?.(task);
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof TaskQuickAddInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  const inputId = `${idPrefix}-title`;

  return (
    <div className="flex flex-col gap-2">
      <form
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        className="flex flex-col gap-2 sm:flex-row"
        noValidate
      >
        <div className="flex-1">
          <label htmlFor={inputId} className="sr-only">
            {parentId ? 'New subtask title' : 'New task title'}
          </label>
          <Input
            id={inputId}
            placeholder={parentId ? 'New subtask title…' : 'New task title… (title-only quick add)'}
            invalid={!!errors.title}
            {...register('title')}
          />
          {errors.title?.message ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {errors.title.message}
            </p>
          ) : null}
        </div>
        <Button type="submit" loading={mutation.isPending}>
          {parentId ? 'Add subtask' : 'Add task'}
        </Button>
      </form>
      {submitError ? <ErrorCard title="Could not create task" error={submitError} /> : null}
    </div>
  );
}

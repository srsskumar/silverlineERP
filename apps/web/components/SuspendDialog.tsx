'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeSuspendSchema, type EmployeeSuspendInput } from '@/lib/validation';
import { suspendEmployee } from '@/lib/employees';
import { queryKeys } from '@/lib/query-keys';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';

/**
 * A-010: the counterpart to Exit that was never wired up on web. Suspension
 * is a reversible pause (reactivate brings them back) as distinct from exit,
 * carrying the same authority (`employee.exit`) per the API comment.
 */
export function SuspendDialog({
  employeeId,
  employeeName,
  open,
  onClose,
  onSuccess,
}: {
  employeeId: string;
  employeeName?: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeSuspendInput>({ resolver: zodResolver(employeeSuspendSchema) });

  React.useEffect(() => {
    if (open) {
      reset({ reason: '' });
      setSubmitError(null);
    }
  }, [open, reset]);

  const mutation = useMutation({
    mutationFn: (values: EmployeeSuspendInput) => suspendEmployee(employeeId, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.employees.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.employee.all });
      onSuccess();
      onClose();
    },
    onError: (err) => setSubmitError(err),
  });

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Suspend employee" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">
          Suspend{employeeName ? ` ${employeeName}` : ' employee'}
        </h2>
        <p className="mt-1 text-sm text-text-muted">A reversible pause — history is preserved and Reactivate brings them back. A reason is required.</p>
        <form
          onSubmit={handleSubmit((v) => mutation.mutate(v))}
          className="mt-4 flex flex-col gap-4"
          noValidate
        >
          <FormField label="Reason" htmlFor="suspend-reason" error={errors.reason?.message}>
            <textarea
              id="suspend-reason"
              rows={3}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('reason')}
            />
          </FormField>
          {submitError ? <ErrorCard title="Could not suspend employee" error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={isSubmitting || mutation.isPending}>
              Confirm suspend
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

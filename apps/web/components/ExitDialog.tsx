'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import { employeeExitSchema, type EmployeeExitInput } from '@/lib/validation';
import { exitEmployee } from '@/lib/employees';
import { queryKeys } from '@/lib/query-keys';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';

export function ExitDialog({
  employeeId,
  employeeName,
  dateOfJoining,
  open,
  onClose,
  onSuccess,
}: {
  employeeId: string;
  employeeName?: string;
  dateOfJoining?: string;
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
  } = useForm<EmployeeExitInput>({
    resolver: zodResolver(employeeExitSchema),
    defaultValues: { exit_date: '', reason: '', date_of_joining: dateOfJoining },
  });

  React.useEffect(() => {
    if (open) {
      reset({ exit_date: '', reason: '', date_of_joining: dateOfJoining });
      setSubmitError(null);
    }
  }, [open, dateOfJoining, reset]);

  const mutation = useMutation({
    mutationFn: (values: EmployeeExitInput) =>
      exitEmployee(employeeId, { exit_date: values.exit_date, reason: values.reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.employees.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.employee.all });
      onSuccess();
      onClose();
    },
    onError: (err) => setSubmitError(err),
  });

  if (!open) return null;
  const onSubmit = (values: EmployeeExitInput) => mutation.mutate(values);

  return (
    <div role="dialog" aria-modal="true" aria-label="Exit employee" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">
          Exit{employeeName ? ` ${employeeName}` : ' employee'}
        </h2>
        <p className="mt-1 text-sm text-slate-500">This marks the employee as exited. A reason is required.</p>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Exit date" htmlFor="exit-date" error={errors.exit_date?.message}>
            <Input id="exit-date" type="date" invalid={!!errors.exit_date} {...register('exit_date')} />
          </FormField>
          <FormField label="Reason" htmlFor="exit-reason" error={errors.reason?.message}>
            <textarea
              id="exit-reason"
              rows={3}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              {...register('reason')}
            />
          </FormField>
          {submitError ? (
            <ErrorCard
              title="Could not exit employee"
              error={submitError instanceof ApiClientError ? submitError : submitError}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={isSubmitting || mutation.isPending}>
              Confirm exit
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

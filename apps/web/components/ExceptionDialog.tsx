'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { fileException, type AttendanceException } from '@/lib/attendance';
import { exceptionSchema, EXCEPTION_TYPES, type ExceptionFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { Badge } from './ui/Badge';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/**
 * File an attendance exception (type + reason + optional record link).
 * On success shows the filed exception id + version (the id feeds the
 * decide flow, since the contract has no exceptions list endpoint).
 */
export function ExceptionDialog({
  open,
  onClose,
  defaultEmployeeId,
  defaultRecordId,
  onFiled,
}: {
  open: boolean;
  onClose: () => void;
  defaultEmployeeId?: string;
  defaultRecordId?: string;
  onFiled?: (ex: AttendanceException) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [filed, setFiled] = React.useState<AttendanceException | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ExceptionFormInput>({
    resolver: zodResolver(exceptionSchema),
    defaultValues: {
      employee_id: defaultEmployeeId ?? '',
      attendance_record_id: defaultRecordId ?? '',
      exception_type: 'MISSED_PUNCH',
      reason: '',
      document_id: '',
    },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        employee_id: defaultEmployeeId ?? '',
        attendance_record_id: defaultRecordId ?? '',
        exception_type: 'MISSED_PUNCH',
        reason: '',
        document_id: '',
      });
      setSubmitError(null);
      setFiled(null);
    }
  }, [open, defaultEmployeeId, defaultRecordId, reset]);

  const mutation = useMutation({
    mutationFn: (v: ExceptionFormInput) =>
      fileException({
        employee_id: v.employee_id,
        attendance_record_id: v.attendance_record_id || undefined,
        exception_type: v.exception_type,
        reason: v.reason,
        document_id: v.document_id || undefined,
      }),
    onSuccess: (ex) => {
      setFiled(ex);
      setSubmitError(null);
      onFiled?.(ex);
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof ExceptionFormInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="File exception" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">File exception</h2>
        {filed ? (
          <div className="mt-4 flex flex-col gap-3">
            <div className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success">
              Exception filed. Use this id in the decide step (there is no server-side
              exceptions list in S2).
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs text-text">{filed.id}</span>
              <Badge tone="info">v{filed.version}</Badge>
              <Badge>{String((filed as { status?: unknown }).status ?? 'PENDING')}</Badge>
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
            <FormField label="Employee ID *" htmlFor="ex-employee" error={errors.employee_id?.message}>
              <Input id="ex-employee" invalid={!!errors.employee_id} {...register('employee_id')} />
            </FormField>
            <FormField label="Attendance record ID (optional)" htmlFor="ex-record" error={errors.attendance_record_id?.message}>
              <Input id="ex-record" placeholder="Link to a record…" {...register('attendance_record_id')} />
            </FormField>
            <FormField label="Exception type *" htmlFor="ex-type" error={errors.exception_type?.message}>
              <select id="ex-type" className={inputClass} {...register('exception_type')}>
                {EXCEPTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Reason *" htmlFor="ex-reason" error={errors.reason?.message}>
              <textarea id="ex-reason" rows={3} className={inputClass} {...register('reason')} />
            </FormField>
            <FormField label="Document ID (optional)" htmlFor="ex-doc" error={errors.document_id?.message}>
              <Input id="ex-doc" placeholder="Supporting document id…" {...register('document_id')} />
            </FormField>
            {submitError ? <ErrorCard title="Could not file exception" error={submitError} /> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={isSubmitting || mutation.isPending}>
                File exception
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

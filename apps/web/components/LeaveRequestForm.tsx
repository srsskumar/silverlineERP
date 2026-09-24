'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  fileRequest,
  findBalanceForType,
  formatDays,
  isUnpaidType,
  parseAttendanceConflictDates,
  parseInsufficientBalance,
  parseOverlapIds,
  previewLeave,
  type FileRequestResult,
  type LeaveBalance,
  type LeaveType,
} from '@/lib/leave';
import { leaveRequestSchema, type LeaveRequestFormInput } from '@/lib/validation';
import { ApiClientError } from '@/lib/apiClient';
import { applyFieldErrors, requestIdOf } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { Badge } from './ui/Badge';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/**
 * File a leave request. Shows a live inclusive-day count, a balance preview
 * for the selected paid type (skipped for LOP/unpaid), and maps server error
 * codes to targeted banners:
 *   INSUFFICIENT_BALANCE → banner with available days
 *   LEAVE_OVERLAP        → banner listing conflicting request ids
 *   ATTENDANCE_CONFLICT  → banner listing conflicting dates
 *   NO_APPROVER          → contact-admin message
 */
export function LeaveRequestForm({
  types,
  balances = [],
  onSuccess,
}: {
  types: LeaveType[];
  balances?: LeaveBalance[];
  onSuccess?: (result: FileRequestResult) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LeaveRequestFormInput>({
    resolver: zodResolver(leaveRequestSchema),
    defaultValues: { leave_type_id: '', from_date: '', to_date: '', reason: '' },
  });

  const leaveTypeId = watch('leave_type_id');
  const fromDate = watch('from_date');
  const toDate = watch('to_date');
  const selectedType = types.find((t) => t.id === leaveTypeId);
  const unpaidSelected = selectedType ? isUnpaidType(selectedType) : false;
  const balancePreview = findBalanceForType(balances, selectedType ?? null);
  const datesOrdered = !!fromDate && !!toDate && toDate >= fromDate;

  /*
   * Fix round 1, item 2: the "N days" preview used to count calendar days
   * client-side, which overstated a paid request under the sandwich rule
   * (D-012) -- a Fri-Mon range read "4 days" and was charged 3, or fewer.
   * This asks the server for exactly what filing would charge, from
   * filing's own day-counting function, instead of a second guess of it.
   */
  const previewQuery = useQuery({
    queryKey: ['leave-preview', leaveTypeId, fromDate, toDate],
    queryFn: () => previewLeave({ leave_type_id: leaveTypeId, from_date: fromDate, to_date: toDate }),
    enabled: !!leaveTypeId && datesOrdered,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (v: LeaveRequestFormInput) =>
      fileRequest({
        leave_type_id: v.leave_type_id,
        from_date: v.from_date,
        to_date: v.to_date,
        reason: v.reason?.trim() ? v.reason.trim() : undefined,
      }),
    onSuccess: (result) => {
      setSubmitError(null);
      onSuccess?.(result);
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof LeaveRequestFormInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4" noValidate>
      <FormField label="Leave type *" htmlFor="leave-type" error={errors.leave_type_id?.message}>
        <select id="leave-type" className={inputClass} {...register('leave_type_id')}>
          <option value="">Pick a leave type…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.code} — {t.name} ({t.is_paid ? 'paid' : 'unpaid'})
            </option>
          ))}
        </select>
      </FormField>

      {selectedType && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {unpaidSelected ? (
            <span className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-text-muted">
              {selectedType.code} is unpaid — no balance is checked.
            </span>
          ) : balancePreview ? (
            <span className="rounded-md border border-primary/30 bg-primary-subtle px-3 py-2 text-text-muted">
              Available balance: <strong>{Number(balancePreview.current_balance) || 0} days</strong>{' '}
              <span className="font-mono text-text-muted">({balancePreview.leave_code})</span>
            </span>
          ) : balances.length > 0 ? (
            <span className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-warning">
              No {selectedType.code} balance row found for this year.
            </span>
          ) : null}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="From (YYYY-MM-DD) *" htmlFor="leave-from" error={errors.from_date?.message}>
          <Input id="leave-from" type="date" invalid={!!errors.from_date} {...register('from_date')} />
        </FormField>
        <FormField label="To (YYYY-MM-DD) *" htmlFor="leave-to" error={errors.to_date?.message}>
          <Input id="leave-to" type="date" invalid={!!errors.to_date} {...register('to_date')} />
        </FormField>
      </div>

      <div className="flex items-center gap-2 text-sm text-text-muted" aria-live="polite">
        <span>Total:</span>
        {!leaveTypeId || !fromDate || !toDate ? (
          <span className="text-text-subtle">— pick a leave type and valid dates</span>
        ) : !datesOrdered ? (
          <span className="text-danger">To date must be on or after from date</span>
        ) : previewQuery.isLoading ? (
          <span className="text-text-subtle">Checking…</span>
        ) : previewQuery.isError ? (
          <span className="text-danger">Could not preview this range</span>
        ) : previewQuery.data ? (
          previewQuery.data.total_days === 0 ? (
            <span className="text-danger">Every day in this range is a Sunday or a holiday</span>
          ) : (
            <Badge tone="info">
              {formatDays(previewQuery.data.total_days)}
              {previewQuery.data.is_paid ? '' : ' (calendar days, unpaid)'}
            </Badge>
          )
        ) : null}
      </div>

      <FormField label="Reason" htmlFor="leave-reason" error={errors.reason?.message}>
        <textarea
          id="leave-reason"
          rows={3}
          className={inputClass}
          placeholder="Required for backdated leave (server re-validates)…"
          {...register('reason')}
        />
      </FormField>

      {submitError ? <LeaveSubmitError error={submitError} /> : null}

      <div>
        <Button type="submit" loading={isSubmitting || mutation.isPending}>
          File leave request
        </Button>
      </div>
    </form>
  );
}

function LeaveSubmitError({ error }: { error: unknown }) {
  const code = error instanceof ApiClientError ? error.code : undefined;
  const requestId = requestIdOf(error);

  if (code === 'INSUFFICIENT_BALANCE') {
    const available = parseInsufficientBalance(error);
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">Insufficient leave balance{available !== null ? ` (available: ${available} days)` : ''}.</p>
        <p className="mt-1">Shorten the range, pick another leave type, or contact your administrator for a balance adjustment.</p>
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  if (code === 'LEAVE_OVERLAP') {
    const ids = parseOverlapIds(error);
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">This range overlaps an existing leave request.</p>
        {ids.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {ids.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">Adjust the dates so they do not overlap.</p>
        )}
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  if (code === 'ATTENDANCE_CONFLICT') {
    const dates = parseAttendanceConflictDates(error);
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">These dates conflict with attendance records.</p>
        {dates.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {dates.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">Regularize the attendance records first, then re-file.</p>
        )}
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  if (code === 'NO_APPROVER') {
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">No approver is configured for your reporting chain.</p>
        <p className="mt-1">Contact your administrator to set up an approver, then file again.</p>
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  return <ErrorCard title={code ? `Could not file request (${code})` : 'Could not file request'} error={error} />;
}

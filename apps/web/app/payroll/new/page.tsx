'use client';

import { staticHref } from '@/lib/routes';
import * as React from 'react';
import Link from '@/components/AppLink';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { createRun, isOverlappingRun, isPeriodTooLong, periodSpanDays } from '@/lib/payroll';
import { queryKeys } from '@/lib/query-keys';
import { PERMISSIONS } from '@/lib/permissions';
import { payrollPeriodSchema, type PayrollPeriodInput } from '@/lib/validation';
import { applyFieldErrors, requestIdOf } from '@/lib/form-errors';
import { PeriodPicker } from '@/components/PeriodPicker';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';

export const dynamic = 'force-static';

/**
 * Create a payroll run (POST /payroll/runs → 201 OPEN).
 * Client-side span preview comes from PeriodPicker; the schema enforces
 * start ≤ end + the 62-day cap, and the server re-validates
 * (PERIOD_TOO_LONG / OVERLAPPING_RUN surface as targeted banners).
 */
function NewRunForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PayrollPeriodInput>({
    resolver: zodResolver(payrollPeriodSchema),
    defaultValues: { period_start: '', period_end: '' },
  });

  // Register both fields (inputs render inside PeriodPicker) and mirror
  // their values into RHF state on change.
  React.useEffect(() => {
    register('period_start');
    register('period_end');
  }, [register]);

  const start = watch('period_start') ?? '';
  const end = watch('period_end') ?? '';
  const span = periodSpanDays(start, end);

  const mutation = useMutation({
    mutationFn: (v: PayrollPeriodInput) =>
      createRun({ period_start: v.period_start, period_end: v.period_end }),
    onSuccess: async (detail) => {
      setSubmitError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.payroll.runs() });
      router.push(staticHref(`/payroll/${detail.run.id}`));
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof PayrollPeriodInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  const overlapping = isOverlappingRun(submitError);
  const tooLong = isPeriodTooLong(submitError);

  return (
    <form
      onSubmit={handleSubmit((v) => {
        setSubmitError(null);
        mutation.mutate(v);
      })}
      className="flex max-w-2xl flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:p-6"
      noValidate
    >
      <PeriodPicker
        start={start}
        end={end}
        onStartChange={(v) => setValue('period_start', v, { shouldValidate: true })}
        onEndChange={(v) => setValue('period_end', v, { shouldValidate: true })}
        startError={errors.period_start?.message}
        endError={errors.period_end?.message}
      />

      {overlapping && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">Overlapping run (OVERLAPPING_RUN)</p>
          <p className="mt-1 text-sm text-amber-700">
            This period overlaps an existing run. Pick a non-overlapping period or open the existing run from the
            runs list.
          </p>
          {requestIdOf(submitError) && (
            <p className="mt-1 text-xs text-amber-600">Request ID: {requestIdOf(submitError)}</p>
          )}
        </div>
      )}
      {tooLong && !overlapping && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">Period too long (PERIOD_TOO_LONG)</p>
          <p className="mt-1 text-sm text-amber-700">
            The server caps a run at 62 days{span ? ` — this range spans ${span} days` : ''}. Split it into
            shorter runs.
          </p>
          {requestIdOf(submitError) && (
            <p className="mt-1 text-xs text-amber-600">Request ID: {requestIdOf(submitError)}</p>
          )}
        </div>
      )}
      {submitError && !overlapping && !tooLong ? (
        <ErrorCard title="Could not create run" error={submitError} />
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={isSubmitting || mutation.isPending}>
          Create run
        </Button>
        <Link href="/payroll" className="text-sm text-brand-600 hover:underline">
          Back to runs
        </Link>
      </div>
    </form>
  );
}

export default function NewPayrollRunPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PAYROLL_GENERATE}>
        <h1 className="text-xl font-bold text-slate-900">New payroll run</h1>
        <p className="mt-1 text-sm text-slate-500">
          Pick a pay period (≤ 62 days) — the run opens in OPEN and is calculated on its detail page.
        </p>
        <div className="mt-6">
          <NewRunForm />
        </div>
      </RequirePermission>
    </AppShell>
  );
}

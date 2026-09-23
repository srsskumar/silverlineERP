'use client';

import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from './AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { punchEvent, type PunchResult } from '@/lib/attendance';
import { punchFormSchema, type PunchFormInput } from '@/lib/validation';
import { ApiClientError } from '@/lib/apiClient';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { DecisionBadge } from './DecisionBadge';
import { EmployeePicker } from './EmployeePicker';
import { day } from '@/lib/finance';

function nowLocalInput(): string {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/**
 * What the red box is headed, for the refusals a person can do something
 * about. A device clock ahead of the server is the one that kept coming
 * back: "Punch rejected (FUTURE_PUNCH)" told the supervisor a code, not
 * that the fix was on the machine in front of them.
 */
export function punchErrorTitle(error: unknown): string {
  if (!(error instanceof ApiClientError) || !error.code) return 'Punch failed';
  switch (error.code) {
    case 'FUTURE_PUNCH': return 'Punch rejected: this device’s clock is ahead';
    case 'DUPLICATE_CHECKIN': return 'Punch rejected: already checked in today';
    case 'CHECKOUT_WITHOUT_CHECKIN': return 'Punch rejected: no check-in to close';
    case 'RECORD_CLOSED': return 'Punch rejected: the day is already closed';
    case 'EMPLOYEE_INACTIVE': return 'Punch rejected: employee is not active';
    default: return `Punch rejected (${error.code})`;
  }
}

/**
 * Punch on behalf of somebody else. Gated by attendance.punch (and, for
 * anybody but yourself, attendance.decide on the server).
 * Renders the 201 / 200 / 202 outcomes distinctly; 422 codes surface inline.
 */
export function PunchPanel({ onPunched }: { onPunched?: (r: PunchResult) => void }) {
  const { session } = useAuth();
  const canPunch = hasPermission({ permissions: session?.permissions }, PERMISSIONS.ATTENDANCE_PUNCH);
  const [result, setResult] = React.useState<PunchResult | null>(null);
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PunchFormInput>({
    resolver: zodResolver(punchFormSchema),
    defaultValues: { employee_id: '', event_type: 'CHECK_IN', latitude: undefined, longitude: undefined, gps_accuracy: undefined },
  });
  const eventType = watch('event_type');

  const mutation = useMutation({
    mutationFn: (v: PunchFormInput) =>
      punchEvent({
        employee_id: v.employee_id,
        event_type: v.event_type,
        client_timestamp: new Date().toISOString(),
        latitude: v.latitude,
        longitude: v.longitude,
        gps_accuracy: v.gps_accuracy,
      }),
    onSuccess: (r) => {
      setResult(r);
      setSubmitError(null);
      onPunched?.(r);
    },
    onError: (err) => setSubmitError(err),
  });

  if (!canPunch) {
    return (
      <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-text-muted">
        Manual punch needs the <span className="font-mono">attendance.punch</span> permission.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Employee *" htmlFor="punch-employee" error={errors.employee_id?.message}>
            {/* By name: the owner's example of a box that wanted a pasted UUID. */}
            <Controller
              control={control}
              name="employee_id"
              render={({ field }) => (
                <EmployeePicker id="punch-employee" value={field.value ?? ''} onChange={field.onChange} />
              )}
            />
          </FormField>
          <FormField label="Event *" htmlFor="punch-type">
            <div className="flex gap-2" role="radiogroup" aria-label="Event type">
              {(['CHECK_IN', 'CHECK_OUT'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={eventType === t}
                  onClick={() => setValue('event_type', t)}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ring-1 ${
                    eventType === t ? 'bg-primary text-primary-fg ring-primary' : 'bg-surface text-text-muted ring-border'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Latitude" htmlFor="punch-lat" error={errors.latitude?.message}>
            <Input id="punch-lat" inputMode="decimal" placeholder="17.44" {...register('latitude')} />
          </FormField>
          <FormField label="Longitude" htmlFor="punch-lng" error={errors.longitude?.message}>
            <Input id="punch-lng" inputMode="decimal" placeholder="78.34" {...register('longitude')} />
          </FormField>
          <FormField label="GPS accuracy (m)" htmlFor="punch-acc" error={errors.gps_accuracy?.message}>
            <Input id="punch-acc" inputMode="decimal" placeholder="25" {...register('gps_accuracy')} />
          </FormField>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" loading={isSubmitting || mutation.isPending}>
            Punch {eventType === 'CHECK_IN' ? 'in' : 'out'} now
          </Button>
          <span className="text-xs text-text-muted">Client time {nowLocalInput()} · fresh Idempotency-Key per attempt</span>
        </div>
      </form>

      {submitError ? (
        <ErrorCard title={punchErrorTitle(submitError)} error={submitError} />
      ) : null}

      {result && !submitError ? (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            result.kind === 'accepted'
              ? 'border-success/30 bg-success-subtle text-success'
              : result.kind === 'applied'
                ? 'border-primary/30 bg-primary-subtle text-text'
                : 'border-warning/30 bg-warning-subtle text-warning'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <DecisionBadge result={result} />
            {result.kind === 'accepted' && <span>Punch recorded.</span>}
            {result.kind === 'applied' && <span>Duplicate key — original punch replayed, no double count.</span>}
            {result.kind === 'review' && (
              <span>
                Routed to review: {result.message}{' '}
                {result.exception_id && (
                  <>
                    Exception <span className="font-mono text-xs">{result.exception_id}</span>
                  </>
                )}
              </span>
            )}
          </div>
          {result.kind !== 'review' && (
            <p className="mt-1 font-mono text-xs opacity-75">
              event {result.event.id} · record {result.record.id} · {day(result.record.work_date)}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

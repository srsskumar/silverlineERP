'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from './AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { punchEvent, type PunchResult } from '@/lib/attendance';
import { listEmployees } from '@/lib/employees';
import { punchFormSchema, type PunchFormInput } from '@/lib/validation';
import { ApiClientError } from '@/lib/apiClient';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { DecisionBadge } from './DecisionBadge';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

function nowLocalInput(): string {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/**
 * Manual web punch (testing/admin). Gated by attendance.punch.
 * Renders the 201 / 200 / 202 outcomes distinctly; 422 codes surface inline.
 */
export function PunchPanel({ onPunched }: { onPunched?: (r: PunchResult) => void }) {
  const { session } = useAuth();
  const canPunch = hasPermission({ permissions: session?.permissions }, PERMISSIONS.ATTENDANCE_PUNCH);
  const [result, setResult] = React.useState<PunchResult | null>(null);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [empSearch, setEmpSearch] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PunchFormInput>({
    resolver: zodResolver(punchFormSchema),
    defaultValues: { employee_id: '', event_type: 'CHECK_IN', latitude: undefined, longitude: undefined, gps_accuracy: undefined },
  });
  const employeeId = watch('employee_id');
  const eventType = watch('event_type');

  const searchQuery = useQuery({
    queryKey: ['employees', 'punch-search', empSearch.trim()],
    queryFn: () => listEmployees({ q: empSearch.trim(), limit: 8 }),
    enabled: pickerOpen && empSearch.trim().length > 0,
    staleTime: 30_000,
  });

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

  const candidates = searchQuery.data?.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Employee *" htmlFor="punch-employee" error={errors.employee_id?.message}>
            <div className="flex flex-col gap-1">
              <Input
                id="punch-employee"
                placeholder="Employee ID…"
                invalid={!!errors.employee_id}
                value={employeeId}
                onChange={(e) => {
                  setValue('employee_id', e.target.value, { shouldValidate: true });
                  setEmpSearch(e.target.value);
                  setPickerOpen(true);
                }}
                onFocus={() => setPickerOpen(true)}
              />
              {pickerOpen && empSearch.trim().length > 0 && (
                <div className="rounded-md border border-border bg-surface shadow-sm">
                  {searchQuery.isLoading ? (
                    <p className="px-3 py-2 text-xs text-text-muted">Searching…</p>
                  ) : candidates.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-text-muted">No matches — you can still punch a raw ID.</p>
                  ) : (
                    candidates.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="block w-full px-3 py-1.5 text-left text-xs hover:bg-surface-sunken"
                        onClick={() => {
                          setValue('employee_id', c.id, { shouldValidate: true });
                          setEmpSearch('');
                          setPickerOpen(false);
                        }}
                      >
                        <span className="font-medium text-text">
                          {String(c.first_name)} {c.last_name ? String(c.last_name) : ''}
                        </span>{' '}
                        <span className="font-mono text-text-muted">{c.emp_no}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
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
        <ErrorCard
          title={
            submitError instanceof ApiClientError && submitError.code
              ? `Punch rejected (${submitError.code})`
              : 'Punch failed'
          }
          error={submitError}
        />
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
              event {result.event.id} · record {result.record.id} · {result.record.work_date}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

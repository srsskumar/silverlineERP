'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createHoliday, updateHoliday, holidayEditPatchBody, type Holiday } from '@/lib/holidays';
import { queryKeys } from '@/lib/query-keys';
import {
  holidaySchema, holidayEditSchema, holidayStatusChangeSchema,
  HOLIDAY_TYPES, HOLIDAY_TYPE_LABELS, ORG_UNIT_TYPES,
  type HolidayInput, type HolidayEditInput, type HolidayStatusChangeInput,
} from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';

/**
 * Dialogs for `/org/holidays` (S1's holiday calendar).
 *
 * Kept out of the page module because a Next.js `page.tsx` may only export
 * a small fixed set of names (`default`, `metadata`, route config, ...) —
 * anything else fails the route's own type check. Components importable
 * from elsewhere (this file, `ActivateDialog`) live beside the other
 * `components/`.
 */

export function CreateHolidayDialog({ open, year, onClose }: { open: boolean; year: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<HolidayInput>({
    resolver: zodResolver(holidaySchema),
    defaultValues: { date: `${year}-01-01`, name: '', type: 'national' },
  });

  React.useEffect(() => {
    if (open) {
      reset({ date: `${year}-01-01`, name: '', type: 'national' });
      setSubmitError(null);
    }
  }, [open, year, reset]);

  const mutation = useMutation({
    mutationFn: (v: HolidayInput) =>
      createHoliday({ date: v.date, name: v.name, type: v.type, scope_type: v.scope_type, scope_id: v.scope_id || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.holidays.all });
      onClose();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof HolidayInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Create holiday" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">New holiday</h2>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Date *" htmlFor="hol-date" error={errors.date?.message}>
            <Input id="hol-date" type="date" invalid={!!errors.date} {...register('date')} />
          </FormField>
          <FormField label="Name *" htmlFor="hol-name" error={errors.name?.message}>
            <Input id="hol-name" invalid={!!errors.name} {...register('name')} />
          </FormField>
          <FormField label="Type *" htmlFor="hol-type" error={errors.type?.message}>
            <select id="hol-type" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" {...register('type')}>
              {HOLIDAY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {HOLIDAY_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Scope type" htmlFor="hol-scope-type" error={errors.scope_type?.message}>
              <select id="hol-scope-type" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" {...register('scope_type')}>
                <option value="">Org-wide</option>
                {ORG_UNIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Scope ID" htmlFor="hol-scope-id" error={errors.scope_id?.message}>
              <Input id="hol-scope-id" placeholder="optional" {...register('scope_id')} />
            </FormField>
          </div>
          {submitError ? <ErrorCard title="Could not create holiday" error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting || mutation.isPending}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * A-012: date/name/type — the same three fields the create dialog collects —
 * plus a reason, which PATCH /holidays/:id always requires. Scope is not in
 * `holidayPatchSchema` (packages/shared/src/s1.ts), so it is not editable
 * here; only date/name/type/active can ever change after creation.
 */
export function EditHolidayDialog({ open, holiday, onClose }: { open: boolean; holiday: Holiday | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<HolidayEditInput>({ resolver: zodResolver(holidayEditSchema) });

  React.useEffect(() => {
    if (open && holiday) {
      reset({ date: holiday.date, name: holiday.name, type: holiday.type as HolidayEditInput['type'], reason: '' });
      setSubmitError(null);
    }
  }, [open, holiday, reset]);

  const mutation = useMutation({
    mutationFn: (v: HolidayEditInput) => {
      if (!holiday) throw new Error('No holiday selected');
      // Only what actually changed goes over the wire, alongside the reason
      // — never a field re-sent just because the form happened to hold it.
      const original = { date: holiday.date, name: holiday.name, type: holiday.type };
      const body = holidayEditPatchBody(original, v);
      return updateHoliday(holiday.id, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.holidays.all });
      onClose();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof HolidayEditInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open || !holiday) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Edit holiday" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">Edit holiday</h2>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Date *" htmlFor="hol-edit-date" error={errors.date?.message}>
            <Input id="hol-edit-date" type="date" invalid={!!errors.date} {...register('date')} />
          </FormField>
          <FormField label="Name *" htmlFor="hol-edit-name" error={errors.name?.message}>
            <Input id="hol-edit-name" invalid={!!errors.name} {...register('name')} />
          </FormField>
          <FormField label="Type *" htmlFor="hol-edit-type" error={errors.type?.message}>
            <select id="hol-edit-type" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" {...register('type')}>
              {HOLIDAY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {HOLIDAY_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Reason for this change *" htmlFor="hol-edit-reason" error={errors.reason?.message}>
            <textarea
              id="hol-edit-reason"
              rows={3}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('reason')}
            />
          </FormField>
          {submitError ? <ErrorCard title="Could not update holiday" error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting || mutation.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** A-012: withdraw (active=false) or restore (active=true) a holiday, with a required reason. */
export function HolidayStatusDialog({
  open, holiday, targetActive, onClose,
}: { open: boolean; holiday: Holiday | null; targetActive: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<HolidayStatusChangeInput>({ resolver: zodResolver(holidayStatusChangeSchema) });

  React.useEffect(() => {
    if (open) {
      reset({ reason: '' });
      setSubmitError(null);
    }
  }, [open, reset]);

  const mutation = useMutation({
    mutationFn: (v: HolidayStatusChangeInput) => {
      if (!holiday) throw new Error('No holiday selected');
      return updateHoliday(holiday.id, { active: targetActive, reason: v.reason });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.holidays.all });
      onClose();
    },
    onError: (err) => setSubmitError(err),
  });

  if (!open || !holiday) return null;
  const verb = targetActive ? 'Reactivate' : 'Deactivate';
  return (
    <div role="dialog" aria-modal="true" aria-label={`${verb} holiday`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">{verb} {holiday.name}</h2>
        <p className="mt-1 text-sm text-text-muted">
          {targetActive
            ? 'Puts this holiday back on the calendar. A reason is required for the audit trail.'
            : 'Removes this holiday from the calendar without deleting it — it can be reactivated later. A reason is required for the audit trail.'}
        </p>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Reason" htmlFor="hol-status-reason" error={errors.reason?.message}>
            <textarea
              id="hol-status-reason"
              rows={3}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('reason')}
            />
          </FormField>
          {submitError ? <ErrorCard title={`Could not ${verb.toLowerCase()} holiday`} error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting || mutation.isPending}>
              Confirm {verb.toLowerCase()}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

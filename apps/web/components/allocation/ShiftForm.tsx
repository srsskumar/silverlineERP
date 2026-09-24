'use client';

import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { createShift, updateShift, type Shift } from '@/lib/shifts';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet } from '@/components/finance/Primitives';
import { applyFieldErrors } from '@/lib/form-errors';
import { shiftFormSchema, WEEKDAYS, type ShiftFormInput } from '@/lib/validation';

/**
 * Create, or (given `initial`) edit, a shift (§47). A standalone component,
 * not inlined in app/shifts/page.tsx (an app-router page file may only
 * export the page itself).
 */
export function ShiftForm({
  initial, onClose, onSaved,
}: {
  initial?: Shift | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register, control, handleSubmit, setError, formState: { errors },
  } = useForm<ShiftFormInput>({
    resolver: zodResolver(shiftFormSchema),
    defaultValues: {
      code: initial?.code ?? '',
      name: initial?.name ?? '',
      starts_at: initial?.starts_at?.slice(0, 5) ?? '09:00',
      ends_at: initial?.ends_at?.slice(0, 5) ?? '18:00',
      break_minutes: initial?.break_minutes ?? 60,
      rest_days: (initial?.rest_days as ShiftFormInput['rest_days']) ?? [],
      daily_threshold_hours: initial?.daily_threshold_hours ?? 8,
      overtime_multiplier: initial?.overtime_multiplier ?? 1.5,
      effective_from: initial?.effective_from?.slice(0, 10) ?? '',
      effective_to: initial?.effective_to?.slice(0, 10) ?? '',
      active: initial?.active ?? true,
    } as unknown as ShiftFormInput,
  });

  const save = useMutation({
    mutationFn: (v: ShiftFormInput) =>
      initial
        ? updateShift(initial.id, initial.version, {
            name: v.name, starts_at: v.starts_at, ends_at: v.ends_at, break_minutes: v.break_minutes,
            rest_days: v.rest_days, daily_threshold_hours: v.daily_threshold_hours,
            overtime_multiplier: v.overtime_multiplier, effective_from: v.effective_from,
            active: v.active,
            // Explicit null when the box was cleared, so the API actually
            // clears effective_to rather than leaving it untouched (a PATCH
            // that omits a nullable field is COALESCEd away server-side).
            effective_to: v.effective_to || null,
          })
        : createShift(v),
    onSuccess: onSaved,
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof ShiftFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} title={initial ? 'Edit shift' : 'New shift'} subtitle="§47 — the window a roster entry books an employee into.">
      <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-muted">
          Code
          <input className="mt-1 w-full" maxLength={30} readOnly={Boolean(initial)} {...register('code')} />
          <FieldError message={errors.code?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Name
          <input className="mt-1 w-full" maxLength={100} {...register('name')} />
          <FieldError message={errors.name?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Starts at
          <input type="time" className="mt-1 w-full" {...register('starts_at')} />
          <FieldError message={errors.starts_at?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Ends at
          <input type="time" className="mt-1 w-full" {...register('ends_at')} />
          <FieldError message={errors.ends_at?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Break (minutes)
          <input type="number" min="0" max="480" className="mt-1 w-full" {...register('break_minutes')} />
          <FieldError message={errors.break_minutes?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Daily threshold hours
          <input type="number" min="0" max="24" step="0.5" className="mt-1 w-full" {...register('daily_threshold_hours')} />
          <FieldError message={errors.daily_threshold_hours?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Overtime multiplier
          <input type="number" min="1" max="4" step="0.1" className="mt-1 w-full" {...register('overtime_multiplier')} />
          <FieldError message={errors.overtime_multiplier?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Effective from
          <input type="date" className="mt-1 w-full" {...register('effective_from')} />
          <FieldError message={errors.effective_from?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Effective to (optional)
          <input type="date" className="mt-1 w-full" {...register('effective_to')} />
          <FieldError message={errors.effective_to?.message} />
        </label>
        <label className="mt-1 flex items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" {...register('active')} />
          Active
        </label>

        <fieldset className="sm:col-span-2">
          <legend className="text-2xs uppercase tracking-wide text-text-subtle">Rest days</legend>
          <Controller
            control={control}
            name="rest_days"
            render={({ field }) => (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => {
                  const on = (field.value ?? []).includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => field.onChange(on ? field.value.filter((v: string) => v !== d) : [...(field.value ?? []), d])}
                      className={`rounded border px-2 py-0.5 text-2xs font-medium transition-colors ${
                        on ? 'border-primary bg-primary text-primary-fg' : 'border-border bg-surface text-text-muted hover:text-text'
                      }`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            )}
          />
        </fieldset>

        {submitError ? <ErrorCard title="Could not save the shift" error={submitError} className="sm:col-span-2" /> : null}

        <div className="mt-1 flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

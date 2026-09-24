'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { createCostHead, updateCostHead, type CostHead } from '@/lib/cost-heads';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet } from '@/components/finance/Primitives';
import { applyFieldErrors } from '@/lib/form-errors';
import { costHeadFormSchema, COST_HEAD_KINDS, type CostHeadFormInput } from '@/lib/validation';

/**
 * Create, or (given `initial`) edit, a cost head (§15.6) — the fixed list a
 * site P&L is actually read against. A standalone component, not inlined in
 * app/cost-heads/page.tsx (an app-router page file may only export the page
 * itself).
 */
export function CostHeadForm({
  initial, onClose, onSaved,
}: {
  initial?: CostHead | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register, handleSubmit, setError, formState: { errors },
  } = useForm<CostHeadFormInput>({
    resolver: zodResolver(costHeadFormSchema),
    defaultValues: {
      code: initial?.code ?? '',
      name: initial?.name ?? '',
      kind: (initial?.kind as CostHeadFormInput['kind']) ?? COST_HEAD_KINDS[0],
      description: initial?.description ?? '',
      active: initial?.active ?? true,
    },
  });

  const save = useMutation({
    mutationFn: (v: CostHeadFormInput) =>
      initial
        ? updateCostHead(initial.id, initial.version, { name: v.name, kind: v.kind, description: v.description ?? undefined, active: v.active })
        : createCostHead(v),
    onSuccess: onSaved,
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof CostHeadFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} title={initial ? 'Edit cost head' : 'New cost head'} subtitle="§15.6 — the fixed set a site P&L is read against.">
      <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-muted">
          Code
          {/* readOnly, not disabled: a disabled input is excluded from the
              submitted form data, and the API's PATCH schema is `.partial()`
              anyway — this field never travels on an edit either way, but
              readOnly keeps its value in the form state for the eye to see. */}
          <input className="mt-1 w-full" maxLength={30} readOnly={Boolean(initial)} {...register('code')} />
          <FieldError message={errors.code?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Name
          <input className="mt-1 w-full" maxLength={120} {...register('name')} />
          <FieldError message={errors.name?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Kind
          <select className="mt-1 w-full" {...register('kind')}>
            {COST_HEAD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <FieldError message={errors.kind?.message} />
        </label>
        <label className="mt-1 flex items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" {...register('active')} />
          Active
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">
          Description (optional)
          <textarea rows={2} className="mt-1 w-full" maxLength={500} {...register('description')} />
        </label>

        {submitError ? <ErrorCard title="Could not save the cost head" error={submitError} className="sm:col-span-2" /> : null}

        <div className="mt-1 flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

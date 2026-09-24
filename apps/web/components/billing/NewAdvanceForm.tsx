'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet } from '@/components/finance/Primitives';
import { businessToday } from '@/lib/finance';
import { useToast } from '@/components/ui/Toast';
import { applyFieldErrors } from '@/lib/form-errors';
import { advanceSchema, type AdvanceFormInput, ADVANCE_TYPES } from '@/lib/validation';

type Row = Record<string, any>;

/**
 * New advance (B-007).
 *
 * Fields mirror `advanceSchema`. There is no `GET` route for advances today
 * (§15's RA-bill draw reads outstanding ones internally, at
 * `apps/api/src/modules/billing/routes.ts:236`) so this is create-only — a
 * recorded advance surfaces later as a deduction line on whichever bill
 * recovers it.
 *
 * A standalone component for the same reason as `NewRaBillForm`.
 */
export function NewAdvance({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const defaults: AdvanceFormInput = {
    project_id: projectId,
    advance_type: 'MOBILISATION',
    amount: 0,
    paid_on: businessToday(),
    recovery_pct: 10,
  };

  const {
    register, handleSubmit, setError, reset, formState: { errors },
  } = useForm<AdvanceFormInput>({
    resolver: zodResolver(advanceSchema),
    defaultValues: defaults,
  });

  const create = useMutation({
    mutationFn: (v: AdvanceFormInput) => apiRequest<Row>('/api/v1/advances', { method: 'POST', body: v }),
    onSuccess: () => {
      toast.success('Advance recorded', 'It will be recovered against future RA bills at the rate given.');
      reset(defaults);
      onClose();
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof AdvanceFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} title="New advance" subtitle="Recovered from future bills at the recovery rate given here.">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            Advance type
            <select className="mt-1 w-full" {...register('advance_type')}>
              {ADVANCE_TYPES.map((t) => (
                <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Paid on
            <input type="date" className="mt-1 w-full" {...register('paid_on')} />
            <FieldError message={errors.paid_on?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Amount
            <input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('amount')} />
            <FieldError message={errors.amount?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Recovery % (of each bill's gross)
            <input type="number" min="0.01" max="100" step="0.01" className="mt-1 w-full" {...register('recovery_pct')} />
            <FieldError message={errors.recovery_pct?.message} />
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Bank guarantee ID (optional)
            <input className="mt-1 w-full" placeholder="UUID, if this advance is secured by one" {...register('bank_guarantee_id')} />
            <FieldError message={errors.bank_guarantee_id?.message} />
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Remarks (optional)
            <textarea rows={2} className="mt-1 w-full" maxLength={1000} {...register('remarks')} />
          </label>
        </div>

        {submitError ? <div className="mt-4"><ErrorCard error={submitError} /></div> : null}

        <div className="mt-5 flex gap-2">
          <Button type="submit" loading={create.isPending}>Record advance</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

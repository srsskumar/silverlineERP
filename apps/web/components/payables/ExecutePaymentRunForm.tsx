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
import { paymentRunExecuteSchema, type PaymentRunExecuteFormInput } from '@/lib/validation';
import { PAYMENT_MODES } from '@/lib/finance';

/**
 * Execute an approved payment run (B-002).
 *
 * A standalone component for the same reason as the procurement/billing "New
 * X" forms: a form exported from a page.tsx breaks the Next.js build, so this
 * lives under components/ and the page only imports it.
 */
export function ExecutePaymentRunForm({
  runId, version, onClose, onDone,
}: {
  runId: string;
  version: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const defaults: PaymentRunExecuteFormInput = {
    paid_on: businessToday(),
    bank_reference: '',
    payment_mode: 'NEFT',
    note: undefined,
  };

  const {
    register, handleSubmit, setError, formState: { errors },
  } = useForm<PaymentRunExecuteFormInput>({
    resolver: zodResolver(paymentRunExecuteSchema),
    defaultValues: defaults,
  });

  const execute = useMutation({
    mutationFn: (v: PaymentRunExecuteFormInput) =>
      apiRequest(`/api/v1/payment-runs/${runId}/execute`, {
        method: 'POST',
        headers: { 'If-Match': String(version) },
        body: {
          paid_on: v.paid_on, bank_reference: v.bank_reference,
          payment_mode: v.payment_mode, note: v.note,
        },
      }),
    onSuccess: () => {
      toast.success('Payment run executed', 'The run is now paid, and every line has been settled.');
      onDone();
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof PaymentRunExecuteFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet
      open
      onClose={onClose}
      title="Execute payment"
      subtitle="Moves this run to paid and settles every invoice on it. This cannot be undone."
    >
      <form onSubmit={handleSubmit((v) => execute.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            Paid on
            <input type="date" className="mt-1 w-full" {...register('paid_on')} />
            <FieldError message={errors.paid_on?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Bank reference
            <input className="mt-1 w-full" placeholder="UTR / cheque number" {...register('bank_reference')} />
            <FieldError message={errors.bank_reference?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Payment mode
            <select className="mt-1 w-full" {...register('payment_mode')}>
              {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <FieldError message={errors.payment_mode?.message} />
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Note (optional)
            <textarea rows={2} className="mt-1 w-full" maxLength={1000} {...register('note')} />
          </label>
        </div>

        {submitError ? <div className="mt-4"><ErrorCard error={submitError} /></div> : null}

        <div className="mt-5 flex gap-2">
          <Button type="submit" loading={execute.isPending}>Execute payment</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

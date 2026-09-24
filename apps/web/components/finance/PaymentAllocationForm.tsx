'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { allocatePayment } from '@/lib/payments';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, Section } from '@/components/finance/Primitives';
import { applyFieldErrors } from '@/lib/form-errors';
import { paymentAllocationFormSchema, type PaymentAllocationFormInput } from '@/lib/validation';

/**
 * Settle a document against a payment already recorded (§45.3).
 *
 * A standalone component so it can be exercised directly against a stubbed
 * fetch, and so the payment detail page (app/payments/[id]/page.tsx) stays a
 * default export with no extras — an app-router page file may only export
 * the page itself.
 */
export function PaymentAllocationForm({
  paymentId, onAllocated,
}: {
  paymentId: string;
  onAllocated: () => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register, handleSubmit, reset, setError, formState: { errors },
  } = useForm<PaymentAllocationFormInput>({
    resolver: zodResolver(paymentAllocationFormSchema),
    defaultValues: {
      document_type: 'RA_BILL', document_id: '', amount: '' as unknown as number,
      tds_amount: '', retention_amount: '', advance_adjusted: '', other_deduction: '', deduction_reason: '',
    } as unknown as PaymentAllocationFormInput,
  });

  const allocate = useMutation({
    mutationFn: (v: PaymentAllocationFormInput) => allocatePayment(paymentId, v),
    onSuccess: () => {
      reset({
        document_type: 'RA_BILL', document_id: '', amount: '' as unknown as number,
        tds_amount: '', retention_amount: '', advance_adjusted: '', other_deduction: '', deduction_reason: '',
      } as unknown as PaymentAllocationFormInput);
      setSubmitError(null);
      onAllocated();
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof PaymentAllocationFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <Section title="Allocate to a document">
      <form onSubmit={handleSubmit((v) => allocate.mutate(v))} noValidate className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-text-muted">
          Document type
          <select className="mt-1 w-full" {...register('document_type')}>
            <option value="RA_BILL">RA bill</option>
            <option value="VENDOR_INVOICE">Vendor invoice</option>
            <option value="EXPENSE_CLAIM">Expense claim</option>
            <option value="ADVANCE">Advance</option>
          </select>
          <FieldError message={errors.document_type?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Document ID
          <input className="mt-1 w-full" placeholder="UUID" {...register('document_id')} />
          <FieldError message={errors.document_id?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Amount
          <input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('amount')} />
          <FieldError message={errors.amount?.message} />
        </label>
        <label className="text-xs text-text-muted">
          TDS (optional)
          <input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('tds_amount')} />
          <FieldError message={errors.tds_amount?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Retention (optional)
          <input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('retention_amount')} />
          <FieldError message={errors.retention_amount?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Advance adjusted (optional)
          <input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('advance_adjusted')} />
          <FieldError message={errors.advance_adjusted?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Other deduction (optional)
          <input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('other_deduction')} />
          <FieldError message={errors.other_deduction?.message} />
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">
          Deduction reason (required if a deduction was withheld)
          <input className="mt-1 w-full" maxLength={500} {...register('deduction_reason')} />
          <FieldError message={errors.deduction_reason?.message} />
        </label>
        {submitError ? <ErrorCard title="Could not allocate the payment" error={submitError} className="sm:col-span-3" /> : null}
        <div className="sm:col-span-3">
          <Button type="submit" loading={allocate.isPending}>Allocate</Button>
        </div>
      </form>
    </Section>
  );
}

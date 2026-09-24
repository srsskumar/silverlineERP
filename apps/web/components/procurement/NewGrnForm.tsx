'use client';

import * as React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet, Section } from '@/components/finance/Primitives';
import { businessToday } from '@/lib/finance';
import { useToast } from '@/components/ui/Toast';
import { applyFieldErrors } from '@/lib/form-errors';
import { grnSchema, type GrnFormInput } from '@/lib/validation';

type Row = Record<string, any>;

/**
 * Record goods receipt (B-005).
 *
 * Fields mirror `grnSchema`. `over_receipt_reason` is not part of that zod
 * schema — the route reads it straight off the raw request body — but it
 * travels in the same JSON object, so it is validated and sent alongside
 * the rest rather than bolted on separately.
 *
 * A standalone component for the same reason as `NewRequisitionForm`.
 */
export function NewGrn({
  purchaseOrderId, poNumber, lines: poLines, onClose, onCreated,
}: {
  purchaseOrderId: string;
  poNumber?: string;
  lines: Row[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const receivableLines = poLines.filter((l) => Number(l.pendingQuantity ?? l.quantity) > 0);

  const {
    register, control, handleSubmit, setError, formState: { errors },
  } = useForm<GrnFormInput>({
    resolver: zodResolver(grnSchema),
    defaultValues: {
      grn_no: `GRN-${Date.now().toString().slice(-6)}`,
      purchase_order_id: purchaseOrderId,
      received_date: businessToday(),
      lines: (receivableLines.length ? receivableLines : poLines).slice(0, 1).map((l) => ({
        po_line_id: String(l.id),
        received_quantity: Number(l.pendingQuantity ?? l.quantity),
        accepted_quantity: Number(l.pendingQuantity ?? l.quantity),
      })),
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  const create = useMutation({
    mutationFn: (v: GrnFormInput) => apiRequest<Row>('/api/v1/grns', { method: 'POST', body: v }),
    onSuccess: () => {
      toast.success('Receipt recorded', 'The order was updated from what arrived.');
      onCreated();
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof GrnFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} title="Record goods receipt" subtitle={poNumber ? `Against ${poNumber}` : undefined}>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            Receipt number
            <input className="mt-1 w-full" maxLength={50} {...register('grn_no')} />
            <FieldError message={errors.grn_no?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Received date
            <input type="date" className="mt-1 w-full" {...register('received_date')} />
            <FieldError message={errors.received_date?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Challan no (optional)
            <input className="mt-1 w-full" maxLength={50} {...register('challan_no')} />
          </label>
          <label className="text-xs text-text-muted">
            Vehicle no (optional)
            <input className="mt-1 w-full" maxLength={20} {...register('vehicle_no')} />
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Over-receipt reason (only needed if a line arrives beyond what was ordered)
            <input className="mt-1 w-full" maxLength={1000} {...register('over_receipt_reason')} />
          </label>
        </div>

        <Section
          title="Lines"
          action={
            <Button
              type="button" variant="secondary" size="sm"
              onClick={() => append({ po_line_id: '', received_quantity: 0, accepted_quantity: 0 })}
            >
              Add line
            </Button>
          }
        >
          <div className="space-y-3">
            {fields.map((f, i) => (
              <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                <div className="grid gap-2 sm:grid-cols-4">
                  <select className="sm:col-span-2" {...register(`lines.${i}.po_line_id`)}>
                    <option value="">Pick an order line</option>
                    {poLines.map((l) => (
                      <option key={String(l.id)} value={String(l.id)}>
                        {l.description} — {Number(l.pendingQuantity ?? l.quantity)} pending
                      </option>
                    ))}
                  </select>
                  <input type="number" min="0" step="any" placeholder="Received quantity" {...register(`lines.${i}.received_quantity`)} />
                  <input type="number" min="0" step="any" placeholder="Accepted quantity" {...register(`lines.${i}.accepted_quantity`)} />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <input placeholder="Rejection reason (needed if any was rejected)" maxLength={500} {...register(`lines.${i}.rejection_reason`)} />
                  <input placeholder="Remarks (optional)" maxLength={500} {...register(`lines.${i}.remarks`)} />
                </div>
                {fields.length > 1 ? (
                  <div className="mt-2 flex justify-end">
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>Remove</Button>
                  </div>
                ) : null}
                {errors.lines?.[i] ? (
                  <p className="mt-1 text-2xs text-danger">
                    {Object.values(errors.lines[i] as Record<string, { message?: string } | undefined>)
                      .map((e) => e?.message).filter(Boolean).join(' · ')}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {typeof errors.lines?.message === 'string' ? (
            <p className="mt-2 text-2xs text-danger">{errors.lines.message}</p>
          ) : null}
        </Section>

        {submitError ? <div className="mt-4"><ErrorCard error={submitError} /></div> : null}

        <div className="mt-5 flex gap-2">
          <Button type="submit" loading={create.isPending}>Record receipt</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

'use client';

import * as React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { FieldError, RecordSheet, Section } from '@/components/finance/Primitives';
import { businessToday } from '@/lib/finance';
import { useToast } from '@/components/ui/Toast';
import { applyFieldErrors } from '@/lib/form-errors';
import { raBillSchema, type RaBillFormInput, RA_BILL_DEDUCTION_HEADS } from '@/lib/validation';

type Row = Record<string, any>;

/** Only the heads a fixed deduction can carry — the ledger's other heads (retention, TDS, advances) are computed, never picked here. */
const DEDUCTION_LABELS: Record<string, string> = {
  LIQUIDATED_DAMAGES: 'Liquidated damages',
  PENALTY: 'Penalty',
  OTHER: 'Other',
};

/**
 * New RA bill (B-007).
 *
 * Fields mirror `raBillSchema` (packages/shared/src/ra-billing.ts) exactly.
 * The server computes the increment, every deduction and the net payable
 * from the cumulative measurement given here — the form never sends a
 * computed total, matching what `POST /ra-bills` actually accepts.
 *
 * A standalone component (not inlined in `app/billing/page.tsx`) because a
 * Next.js app-router page file may only export the page itself plus a small
 * set of reserved names — an extra named export fails the production build
 * with "is not a valid Page export field". Extracting it also lets it be
 * exercised directly in tests-dom against a stubbed fetch.
 */
export function NewRaBill({
  projectId, onClose, onCreated,
}: { projectId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const boq = useQuery({
    queryKey: ['boq', projectId],
    queryFn: async () => (await apiRequest<Row[]>(`/api/v1/projects/${projectId}/boq`)).data,
    staleTime: 60_000,
  });

  const {
    register, control, handleSubmit, setError, formState: { errors },
  } = useForm<RaBillFormInput>({
    resolver: zodResolver(raBillSchema),
    defaultValues: {
      project_id: projectId,
      bill_type: 'RA',
      period_from: businessToday(),
      period_to: businessToday(),
      lines: [{ boq_item_id: '', cumulative_quantity: 0 }],
      fixed_deductions: [],
    },
  });
  const lineArray = useFieldArray({ control, name: 'lines' });
  const deductionArray = useFieldArray({ control, name: 'fixed_deductions' });

  const create = useMutation({
    mutationFn: (v: RaBillFormInput) => apiRequest<Row>('/api/v1/ra-bills', { method: 'POST', body: v }),
    onSuccess: (res) => {
      toast.success('Bill drawn', res.data.bill_type === 'FINAL' ? 'The final bill was created.' : `RA-${res.data.bill_no} was created.`);
      onCreated(String(res.data.id));
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof RaBillFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet
      open onClose={onClose} wide
      title="New RA bill"
      subtitle="States what was measured; the server derives the increment and every deduction."
    >
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            Bill type
            <select className="mt-1 w-full" {...register('bill_type')}>
              <option value="RA">RA (interim)</option>
              <option value="FINAL">Final</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Measurement book ref (optional)
            <input className="mt-1 w-full" maxLength={100} {...register('measurement_book_ref')} />
          </label>
          <label className="text-xs text-text-muted">
            Period from
            <input type="date" className="mt-1 w-full" {...register('period_from')} />
            <FieldError message={errors.period_from?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Period to
            <input type="date" className="mt-1 w-full" {...register('period_to')} />
            <FieldError message={errors.period_to?.message} />
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Remarks (optional)
            <textarea rows={2} className="mt-1 w-full" maxLength={4000} {...register('remarks')} />
          </label>
        </div>

        <Section
          title="Measured items"
          action={
            <Button
              type="button" variant="secondary" size="sm"
              onClick={() => lineArray.append({ boq_item_id: '', cumulative_quantity: 0 })}
            >
              Add item
            </Button>
          }
        >
          {boq.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (boq.data ?? []).length === 0 ? (
            <p className="text-sm text-text-muted">No active BOQ on this project — nothing to measure against.</p>
          ) : (
            <div className="space-y-3">
              {lineArray.fields.map((f, i) => (
                <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                  <div className="grid gap-2 sm:grid-cols-4">
                    <select className="sm:col-span-2" {...register(`lines.${i}.boq_item_id`)}>
                      <option value="">Pick a BOQ item</option>
                      {(boq.data ?? []).map((b) => (
                        <option key={String(b.id)} value={String(b.id)}>{b.item_code} — {b.description}</option>
                      ))}
                    </select>
                    <input type="number" min="0" step="any" placeholder="Cumulative quantity to date" {...register(`lines.${i}.cumulative_quantity`)} />
                    <input placeholder="Remarks (optional)" maxLength={500} {...register(`lines.${i}.remarks`)} />
                  </div>
                  {lineArray.fields.length > 1 ? (
                    <div className="mt-2 flex justify-end">
                      <Button type="button" variant="ghost" size="sm" onClick={() => lineArray.remove(i)}>Remove</Button>
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
          )}
          {typeof errors.lines?.message === 'string' ? (
            <p className="mt-2 text-2xs text-danger">{errors.lines.message}</p>
          ) : null}
        </Section>

        <Section
          title="Fixed deductions (optional)"
          action={
            <Button
              type="button" variant="secondary" size="sm"
              onClick={() => deductionArray.append({ head: 'OTHER', label: '', amount: 0, reason: '' })}
            >
              Add deduction
            </Button>
          }
        >
          {deductionArray.fields.length === 0 ? (
            <p className="text-sm text-text-muted">None — liquidated damages or a penalty can be added here.</p>
          ) : (
            <div className="space-y-2">
              {deductionArray.fields.map((f, i) => (
                <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                  <div className="grid gap-2 sm:grid-cols-4">
                    <select {...register(`fixed_deductions.${i}.head`)}>
                      {RA_BILL_DEDUCTION_HEADS.map((h) => (
                        <option key={h} value={h}>{DEDUCTION_LABELS[h] ?? h}</option>
                      ))}
                    </select>
                    <input placeholder="Label" maxLength={150} {...register(`fixed_deductions.${i}.label`)} />
                    <input type="number" min="0" step="0.01" placeholder="Amount" {...register(`fixed_deductions.${i}.amount`)} />
                    <input placeholder="Reason" maxLength={1000} {...register(`fixed_deductions.${i}.reason`)} />
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button type="button" variant="ghost" size="sm" onClick={() => deductionArray.remove(i)}>Remove</Button>
                  </div>
                  {errors.fixed_deductions?.[i] ? (
                    <p className="mt-1 text-2xs text-danger">
                      {Object.values(errors.fixed_deductions[i] as Record<string, { message?: string } | undefined>)
                        .map((e) => e?.message).filter(Boolean).join(' · ')}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Section>

        {submitError ? <div className="mt-4"><ErrorCard error={submitError} /></div> : null}

        <div className="mt-5 flex gap-2">
          <Button type="submit" loading={create.isPending}>Draw bill</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

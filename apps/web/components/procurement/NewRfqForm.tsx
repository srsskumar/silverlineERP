'use client';

import * as React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet, Section } from '@/components/finance/Primitives';
import { businessToday } from '@/lib/finance';
import { useToast } from '@/components/ui/Toast';
import { applyFieldErrors } from '@/lib/form-errors';
import { rfqSchema, type RfqFormInput } from '@/lib/validation';

type Row = Record<string, any>;

/**
 * New RFQ (B-005). Fields mirror `rfqSchema` — competitive sourcing needs at
 * least two invited vendors, matching the shared schema's own minimum.
 *
 * A standalone component for the same reason as `NewRequisitionForm`.
 */
export function NewRfq({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const vendors = useQuery({
    queryKey: ['vendors', 'for-procurement'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/vendors?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });
  const projects = useQuery({
    queryKey: ['projects', 'for-procurement'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });
  const requisitions = useQuery({
    queryKey: ['requisitions', 'for-rfq'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/requisitions?limit=100')).body as { data: Row[] }).data,
    staleTime: 30_000,
  });
  const items = useQuery({
    queryKey: ['inventory-items', 'for-procurement'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/inventory/items?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const {
    register, control, handleSubmit, setError, formState: { errors },
  } = useForm<RfqFormInput>({
    resolver: zodResolver(rfqSchema),
    defaultValues: {
      rfq_no: `RFQ-${Date.now().toString().slice(-6)}`,
      due_date: businessToday(),
      vendor_ids: [],
      lines: [{ description: '', unit: '', quantity: 1 }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  const create = useMutation({
    mutationFn: (v: RfqFormInput) => apiRequest<Row>('/api/v1/rfqs', { method: 'POST', body: v }),
    onSuccess: (res) => {
      toast.success('RFQ raised', `${res.data.rfq_no} was created.`);
      onCreated(String(res.data.id));
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof RfqFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} wide title="New RFQ" subtitle="Invites several vendors to quote on the same lines.">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            RFQ number
            <input className="mt-1 w-full" maxLength={50} {...register('rfq_no')} />
            <FieldError message={errors.rfq_no?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Due date
            <input type="date" className="mt-1 w-full" {...register('due_date')} />
            <FieldError message={errors.due_date?.message} />
          </label>
          <label className="text-xs text-text-muted">
            From a requisition (optional)
            <select className="mt-1 w-full" {...register('requisition_id')}>
              <option value="">Not from a requisition</option>
              {(requisitions.data ?? []).map((r) => (
                <option key={String(r.id)} value={String(r.id)}>{r.requisition_no}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Project (optional)
            <select className="mt-1 w-full" {...register('project_id')}>
              <option value="">Not tied to a project</option>
              {(projects.data ?? []).map((p) => (
                <option key={String(p.id)} value={String(p.id)}>{p.code} — {p.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Scope (optional)
            <textarea rows={2} className="mt-1 w-full" maxLength={4000} {...register('scope')} />
          </label>
        </div>

        <Section title="Invited vendors (at least two)">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {(vendors.data ?? []).map((v) => (
              <label key={String(v.id)} className="flex items-center gap-1.5 text-xs text-text-muted">
                <input type="checkbox" value={String(v.id)} {...register('vendor_ids')} />
                {v.name}
              </label>
            ))}
          </div>
          <FieldError message={errors.vendor_ids?.message as string | undefined} />
        </Section>

        <Section
          title="Lines"
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => append({ description: '', unit: '', quantity: 1 })}>
              Add line
            </Button>
          }
        >
          <div className="space-y-3">
            {fields.map((f, i) => (
              <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                <div className="grid gap-2 sm:grid-cols-4">
                  <select {...register(`lines.${i}.item_id`)}>
                    <option value="">Not in inventory</option>
                    {(items.data ?? []).map((it) => (
                      <option key={String(it.id)} value={String(it.id)}>{it.code} — {it.name}</option>
                    ))}
                  </select>
                  <input className="sm:col-span-2" placeholder="Description" maxLength={255} {...register(`lines.${i}.description`)} />
                  <input placeholder="Unit" maxLength={20} {...register(`lines.${i}.unit`)} />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-4">
                  <input type="number" min="0" step="any" placeholder="Quantity" {...register(`lines.${i}.quantity`)} />
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
          <Button type="submit" loading={create.isPending}>Send RFQ</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

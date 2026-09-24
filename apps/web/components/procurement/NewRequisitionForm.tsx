'use client';

import * as React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet, Section } from '@/components/finance/Primitives';
import { useToast } from '@/components/ui/Toast';
import { applyFieldErrors } from '@/lib/form-errors';
import { requisitionSchema, type RequisitionFormInput } from '@/lib/validation';

type Row = Record<string, any>;

/**
 * New requisition (B-005).
 *
 * Fields mirror `requisitionSchema` (packages/shared/src/procurement.ts)
 * exactly — a line's item, description, unit, quantity and estimated rate,
 * nothing more — so nothing typed here is silently dropped by the route's
 * own `parse(requisitionSchema, req.body)`.
 *
 * A standalone component (not inlined in `app/procurement/page.tsx`)
 * because a Next.js app-router page file may only export the page itself
 * plus a small set of reserved names — an extra named export fails the
 * production build with "is not a valid Page export field". Extracting it
 * also lets it be exercised directly in tests-dom against a stubbed fetch.
 */
export function NewRequisition({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const projects = useQuery({
    queryKey: ['projects', 'for-procurement'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });
  const items = useQuery({
    queryKey: ['inventory-items', 'for-procurement'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/inventory/items?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const {
    register, control, handleSubmit, setError, formState: { errors },
  } = useForm<RequisitionFormInput>({
    resolver: zodResolver(requisitionSchema),
    defaultValues: {
      requisition_no: `REQ-${Date.now().toString().slice(-6)}`,
      justification: '',
      lines: [{ description: '', unit: '', quantity: 1 }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  const create = useMutation({
    mutationFn: (v: RequisitionFormInput) => apiRequest<Row>('/api/v1/requisitions', { method: 'POST', body: v }),
    onSuccess: (res) => {
      toast.success('Requisition raised', `${res.data.requisition_no} was created.`);
      onCreated(String(res.data.id));
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof RequisitionFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet
      open onClose={onClose} wide
      title="New requisition"
      subtitle="Raised for approval before anything is ordered against it."
    >
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            Requisition number
            <input className="mt-1 w-full" maxLength={50} {...register('requisition_no')} />
            <FieldError message={errors.requisition_no?.message} />
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
          <label className="text-xs text-text-muted">
            Required by (optional)
            <input type="date" className="mt-1 w-full" {...register('required_by')} />
            <FieldError message={errors.required_by?.message} />
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Justification
            <textarea rows={2} className="mt-1 w-full" maxLength={2000} {...register('justification')} />
            <FieldError message={errors.justification?.message} />
          </label>
        </div>

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
                <div className="grid gap-2 sm:grid-cols-5">
                  <select {...register(`lines.${i}.item_id`)}>
                    <option value="">Not in inventory</option>
                    {(items.data ?? []).map((it) => (
                      <option key={String(it.id)} value={String(it.id)}>{it.code} — {it.name}</option>
                    ))}
                  </select>
                  <input className="sm:col-span-2" placeholder="Description" maxLength={255} {...register(`lines.${i}.description`)} />
                  <input placeholder="Unit" maxLength={20} {...register(`lines.${i}.unit`)} />
                  <input type="number" min="0" step="any" placeholder="Quantity" {...register(`lines.${i}.quantity`)} />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input type="number" min="0" step="0.01" placeholder="Estimated rate (optional)" {...register(`lines.${i}.estimated_rate`)} />
                  <input className="sm:col-span-2" placeholder="Remarks (optional)" maxLength={500} {...register(`lines.${i}.remarks`)} />
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
          <Button type="submit" loading={create.isPending}>Raise requisition</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

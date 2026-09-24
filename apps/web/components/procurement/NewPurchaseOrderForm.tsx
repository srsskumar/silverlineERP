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
import { purchaseOrderSchema, type PurchaseOrderFormInput } from '@/lib/validation';

type Row = Record<string, any>;

/**
 * New purchase order (B-005).
 *
 * Fields mirror `purchaseOrderSchema`. Picking an approved requisition
 * (`prefillRequisitionId`, or chosen here) carries its lines over via
 * `requisition_line_id`; going beyond them needs `scope_override_reason` —
 * the route 422s with `EXCEEDS_REQUISITION` otherwise, so the field is
 * always on the form once a requisition is attached, not hidden until a
 * failed submit.
 *
 * A standalone component for the same reason as `NewRequisitionForm`: a
 * Next.js page file can't carry an extra named export.
 */
export function NewPurchaseOrder({
  prefillRequisitionId, onClose, onCreated,
}: {
  prefillRequisitionId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [requisitionId, setRequisitionId] = React.useState(prefillRequisitionId ?? '');

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
  const approvedRequisitions = useQuery({
    queryKey: ['requisitions', 'approved-for-po'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/requisitions?status=APPROVED&limit=100')).body as { data: Row[] }).data,
    staleTime: 30_000,
  });
  const items = useQuery({
    queryKey: ['inventory-items', 'for-procurement'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/inventory/items?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });
  const requisitionDetail = useQuery({
    queryKey: ['requisition-for-po', requisitionId],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/requisitions/${requisitionId}`)).data,
    enabled: Boolean(requisitionId),
  });

  const {
    register, control, handleSubmit, setError, setValue, formState: { errors },
  } = useForm<PurchaseOrderFormInput>({
    resolver: zodResolver(purchaseOrderSchema),
    defaultValues: {
      po_number: `PO-${Date.now().toString().slice(-6)}`,
      vendor_id: '',
      requisition_id: prefillRequisitionId,
      po_date: businessToday(),
      lines: [{ description: '', unit: '', quantity: 1, unit_rate: 0, gst_rate_pct: 0 }],
    },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'lines' });

  React.useEffect(() => {
    if (!requisitionDetail.data) return;
    const rLines = (requisitionDetail.data.lines ?? []) as Row[];
    if (rLines.length) {
      replace(rLines.map((l) => ({
        item_id: l.item_id ? String(l.item_id) : undefined,
        requisition_line_id: String(l.id),
        description: String(l.description),
        unit: String(l.unit),
        quantity: Number(l.quantity),
        unit_rate: l.estimated_rate != null ? Number(l.estimated_rate) : 0,
        gst_rate_pct: 0,
      })));
    }
    if (requisitionDetail.data.project_id) setValue('project_id', String(requisitionDetail.data.project_id));
    setValue('requisition_id', requisitionId);
    // Only when the fetched requisition changes — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requisitionDetail.data]);

  const create = useMutation({
    mutationFn: (v: PurchaseOrderFormInput) => apiRequest<Row>('/api/v1/purchase-orders', { method: 'POST', body: v }),
    onSuccess: (res) => {
      toast.success('Order raised', `${res.data.po_number} was created.`);
      onCreated(String(res.data.id));
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof PurchaseOrderFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} wide title="New purchase order" subtitle="Optionally raised against an approved requisition.">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            Order number
            <input className="mt-1 w-full" maxLength={50} {...register('po_number')} />
            <FieldError message={errors.po_number?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Vendor
            <select className="mt-1 w-full" {...register('vendor_id')}>
              <option value="">Choose a vendor</option>
              {(vendors.data ?? []).map((v) => (
                <option key={String(v.id)} value={String(v.id)}>{v.name}</option>
              ))}
            </select>
            <FieldError message={errors.vendor_id?.message} />
          </label>
          <label className="text-xs text-text-muted">
            From an approved requisition (optional)
            <select
              className="mt-1 w-full"
              value={requisitionId}
              onChange={(e) => { setRequisitionId(e.target.value); setValue('requisition_id', e.target.value || undefined); }}
            >
              <option value="">Not from a requisition</option>
              {(approvedRequisitions.data ?? []).map((r) => (
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
          <label className="text-xs text-text-muted">
            Order date
            <input type="date" className="mt-1 w-full" {...register('po_date')} />
            <FieldError message={errors.po_date?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Delivery date (optional)
            <input type="date" className="mt-1 w-full" {...register('delivery_date')} />
            <FieldError message={errors.delivery_date?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Payment terms (optional)
            <input className="mt-1 w-full" maxLength={200} placeholder="Net 30" {...register('payment_terms')} />
          </label>
          <label className="text-xs text-text-muted">
            Place of supply (optional, two-digit state code)
            <input className="mt-1 w-full" maxLength={2} placeholder="36" {...register('place_of_supply')} />
            <FieldError message={errors.place_of_supply?.message} />
          </label>
          <label className="text-xs text-text-muted sm:col-span-2">
            Delivery address (optional)
            <textarea rows={2} className="mt-1 w-full" maxLength={1000} {...register('delivery_address')} />
          </label>
          {requisitionId ? (
            <label className="text-xs text-text-muted sm:col-span-2">
              Override reason (only needed if this order goes beyond the requisition)
              <input className="mt-1 w-full" maxLength={1000} {...register('scope_override_reason')} />
              <FieldError message={errors.scope_override_reason?.message} />
            </label>
          ) : null}
        </div>

        <Section
          title="Lines"
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => append({ description: '', unit: '', quantity: 1, unit_rate: 0, gst_rate_pct: 0 })}>
              Add line
            </Button>
          }
        >
          <div className="space-y-3">
            {fields.map((f, i) => (
              <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                <div className="grid gap-2 sm:grid-cols-6">
                  <select {...register(`lines.${i}.item_id`)}>
                    <option value="">Not in inventory</option>
                    {(items.data ?? []).map((it) => (
                      <option key={String(it.id)} value={String(it.id)}>{it.code} — {it.name}</option>
                    ))}
                  </select>
                  <input className="sm:col-span-2" placeholder="Description" maxLength={255} {...register(`lines.${i}.description`)} />
                  <input placeholder="HSN/SAC (optional)" maxLength={8} {...register(`lines.${i}.hsn_sac`)} />
                  <input placeholder="Unit" maxLength={20} {...register(`lines.${i}.unit`)} />
                  <input type="number" min="0" step="any" placeholder="Quantity" {...register(`lines.${i}.quantity`)} />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-4">
                  <input type="number" min="0" step="0.01" placeholder="Unit rate" {...register(`lines.${i}.unit_rate`)} />
                  <input type="number" min="0" max="28" step="0.01" placeholder="GST %" {...register(`lines.${i}.gst_rate_pct`)} />
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
          <Button type="submit" loading={create.isPending}>Raise order</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

'use client';

import * as React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payableDue } from '@silverline/shared';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Field, Notice, RecordSheet, Section } from '@/components/finance/Primitives';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { useToast } from '@/components/ui/Toast';
import { applyFieldErrors } from '@/lib/form-errors';
import { money, day } from '@/lib/finance';
import { invoiceLinesUpdateSchema, type InvoiceLinesUpdateFormInput } from '@/lib/validation';

type Row = Record<string, any>;

const emptyLine = { description: '', hsn_sac: '', quantity: 1, unit_rate: 0, gst_rate_pct: 0 };

/**
 * A vendor invoice's lines, and the three-way match against its purchase
 * order (§6.6, §13.2, task 5c / finding B-004).
 *
 * `invoice_lines` and a working match route already existed; nothing could
 * ever write a line to it, so the match always ran against zero of them.
 * This is that missing write path — a line editor pre-filled from the linked
 * order, and the match itself, run and overridden from the same place.
 *
 * A standalone component under components/, not a named export from
 * page.tsx, for the same reason as every other procurement form here.
 */
export function VendorInvoiceLines({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canManage = hasPermission(perms, 'invoice.manage');
  const canReadMatch = hasPermission(perms, 'match.read');
  const canOverride = hasPermission(perms, 'match.override');
  const qc = useQueryClient();
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [overrideReason, setOverrideReason] = React.useState('');

  const invoiceQuery = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: async () => ((await apiRequestRaw(`/api/v1/invoices/${invoiceId}`)).body as { data: Row }).data,
  });
  const invoice = invoiceQuery.data;
  const purchaseOrderId = invoice?.purchase_order_id ? String(invoice.purchase_order_id) : null;

  const poQuery = useQuery({
    queryKey: ['purchase-order-for-invoice', purchaseOrderId],
    enabled: Boolean(purchaseOrderId),
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/purchase-orders/${purchaseOrderId}`)).body as { data: Row }).data,
  });
  const poLines: Row[] = poQuery.data?.lines ?? [];

  const matchQuery = useQuery({
    queryKey: ['invoice-match', invoiceId],
    enabled: canReadMatch,
    queryFn: async () => ((await apiRequestRaw(`/api/v1/invoices/${invoiceId}/match`)).body as { data: Row[] }).data,
  });
  const lastMatch = matchQuery.data?.[0];

  const editable = Boolean(
    invoice && invoice.match_status === 'UNMATCHED' &&
    !['APPROVED', 'CANCELLED'].includes(String(invoice.lifecycle_status)),
  );

  const linesFromInvoice = (line: Row) => ({
    item_id: line.item_id ?? undefined,
    po_line_id: line.po_line_id ?? undefined,
    description: line.description,
    hsn_sac: line.hsn_sac,
    quantity: Number(line.quantity),
    unit_rate: Number(line.unit_rate),
    gst_rate_pct: Number(line.gst_rate_pct),
  });

  const {
    register, control, handleSubmit, reset, setError, formState: { errors },
  } = useForm<InvoiceLinesUpdateFormInput>({
    resolver: zodResolver(invoiceLinesUpdateSchema),
    defaultValues: { lines: [emptyLine] },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'lines' });

  // The form starts empty while the invoice is still loading; re-seed it
  // once the real lines arrive, and again if a different invoice is opened.
  React.useEffect(() => {
    if (!invoice) return;
    const existing = (invoice.lines ?? []).map(linesFromInvoice);
    reset({ lines: existing.length ? existing : [emptyLine] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id]);

  const prefillFromOrder = () => {
    replace(poLines.map((l) => ({
      item_id: l.item_id ?? undefined,
      po_line_id: String(l.id),
      description: l.description,
      hsn_sac: l.hsn_sac ?? '',
      quantity: Number(l.pendingQuantity ?? l.quantity),
      unit_rate: Number(l.unit_rate),
      gst_rate_pct: Number(l.gst_rate_pct ?? 0),
    })));
  };

  const save = useMutation({
    mutationFn: (v: InvoiceLinesUpdateFormInput) =>
      apiRequest(`/api/v1/invoices/${invoiceId}/lines`, { method: 'PATCH', body: v }),
    onSuccess: () => {
      toast.success('Lines saved', 'The invoice was re-priced from its lines.');
      setSubmitError(null);
      void qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof InvoiceLinesUpdateFormInput, e));
      setSubmitError(err);
    },
  });

  const runMatch = useMutation({
    mutationFn: (reason?: string) =>
      apiRequest(`/api/v1/invoices/${invoiceId}/match`, {
        method: 'POST', body: reason ? { override_reason: reason } : {},
      }),
    onSuccess: () => {
      setSubmitError(null);
      setOverrideReason('');
      void qc.invalidateQueries({ queryKey: ['invoice-match', invoiceId] });
      void qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (err) => setSubmitError(err),
  });

  const msme = invoice && invoice.vendor_msme_category && invoice.vendor_udyam_number
    ? payableDue({
        party: {
          udyamNumber: invoice.vendor_udyam_number, msmeCategory: invoice.vendor_msme_category,
          hasWrittenAgreement: invoice.vendor_has_written_agreement, msmeRegistered: invoice.vendor_msme_registered,
        },
        acceptanceDate: invoice.accepted_on ?? invoice.invoice_date ?? null,
        contractualDueDate: invoice.due_date ?? null,
        asOf: new Date().toISOString().slice(0, 10),
      })
    : null;

  return (
    <RecordSheet
      open onClose={onClose} wide
      title={invoice ? `Invoice ${invoice.serial_number}` : 'Vendor invoice'}
      subtitle={invoice ? `${invoice.vendor_name ?? 'Vendor'} · ${money(invoice.total)}` : undefined}
    >
      {invoiceQuery.isLoading ? <Skeleton className="h-40" /> : null}
      {invoiceQuery.isError ? <ErrorCard error={invoiceQuery.error} onRetry={() => invoiceQuery.refetch()} /> : null}

      {invoice ? (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Vendor" value={invoice.vendor_name ?? '—'} />
            <Field
              label="Match status"
              value={
                <Badge tone={
                  invoice.match_status === 'MATCHED' ? 'success'
                    : invoice.match_status === 'UNMATCHED' ? 'neutral' : 'warning'
                }>
                  {String(invoice.match_status).toLowerCase()}
                </Badge>
              }
            />
            <Field label="Subtotal" value={money(invoice.subtotal)} />
            <Field label="Total" value={money(invoice.total)} />
          </div>

          {msme?.isMsme ? (
            <Notice
              tone={msme.effectiveDueDate && msme.daysOverdue > 0 ? 'danger' : 'info'}
              title="MSME supplier — statutory due date applies"
            >
              Statutory due {day(msme.statutoryDueDate)}
              {msme.contractualDueDate ? ` (contract due ${day(msme.contractualDueDate)})` : ''}.
              {msme.daysOverdue > 0 ? ` ${msme.daysOverdue} days overdue.` : ''}
            </Notice>
          ) : null}

          <Section
            title="Lines"
            action={editable && canManage ? (
              <div className="flex gap-2">
                {purchaseOrderId ? (
                  <Button type="button" variant="secondary" size="sm" onClick={prefillFromOrder} disabled={poQuery.isLoading}>
                    Prefill from order
                  </Button>
                ) : null}
                <Button type="button" variant="secondary" size="sm" onClick={() => append(emptyLine)}>
                  Add line
                </Button>
              </div>
            ) : null}
          >
            {!editable ? (
              <p className="mb-2 text-2xs text-text-subtle">
                Lines cannot be changed once the invoice has been matched, approved or cancelled.
              </p>
            ) : null}
            <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate>
              <div className="space-y-3">
                {fields.map((f, i) => (
                  <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                    <div className="grid gap-2 sm:grid-cols-6">
                      {purchaseOrderId ? (
                        <select className="sm:col-span-2" disabled={!editable} {...register(`lines.${i}.po_line_id`)}>
                          <option value="">No order line</option>
                          {poLines.map((l) => (
                            <option key={String(l.id)} value={String(l.id)}>{l.description}</option>
                          ))}
                        </select>
                      ) : null}
                      <input
                        placeholder="Description" disabled={!editable}
                        className={purchaseOrderId ? 'sm:col-span-2' : 'sm:col-span-3'}
                        {...register(`lines.${i}.description`)}
                      />
                      <input placeholder="HSN/SAC" maxLength={8} disabled={!editable} {...register(`lines.${i}.hsn_sac`)} />
                      <input type="number" min="0" step="any" placeholder="Qty" disabled={!editable} {...register(`lines.${i}.quantity`)} />
                      <input type="number" min="0" step="any" placeholder="Rate" disabled={!editable} {...register(`lines.${i}.unit_rate`)} />
                      <input type="number" min="0" step="any" placeholder="GST %" disabled={!editable} {...register(`lines.${i}.gst_rate_pct`)} />
                    </div>
                    {editable && fields.length > 1 ? (
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
              {editable && canManage ? (
                <div className="mt-3 flex gap-2">
                  <Button type="submit" loading={save.isPending}>Save lines</Button>
                </div>
              ) : null}
            </form>
          </Section>

          <Section
            title="Three-way match"
            action={canManage ? (
              <Button
                type="button" variant="secondary" size="sm"
                loading={runMatch.isPending && !overrideReason}
                onClick={() => runMatch.mutate(undefined)}
              >
                Run three-way match
              </Button>
            ) : null}
          >
            {matchQuery.isLoading ? <Skeleton className="h-16" /> : null}
            {lastMatch ? (
              <div className="space-y-2">
                <Notice
                  tone={lastMatch.matched ? 'info' : 'danger'}
                  title={
                    lastMatch.matched ? 'Matched'
                      : lastMatch.override_by ? 'Overridden — released despite exceptions'
                        : 'Exceptions found'
                  }
                >
                  Ordered {money(lastMatch.orderedValue ?? lastMatch.ordered_value)} · Received{' '}
                  {money(lastMatch.receivedValue ?? lastMatch.received_value)} · Invoiced{' '}
                  {money(lastMatch.invoicedValue ?? lastMatch.invoiced_value)}
                </Notice>
                {Array.isArray(lastMatch.exceptions) && lastMatch.exceptions.length ? (
                  <ul className="ml-4 list-disc text-xs text-text-muted">
                    {lastMatch.exceptions.map((e: Row, idx: number) => (
                      <li key={idx}>{e.message}</li>
                    ))}
                  </ul>
                ) : null}
                {!lastMatch.matched && !lastMatch.override_by && canOverride ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Reason for overriding the mismatch"
                      className="w-64 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
                    />
                    <Button
                      type="button" variant="secondary" size="sm"
                      disabled={overrideReason.trim().length < 3 || runMatch.isPending}
                      onClick={() => runMatch.mutate(overrideReason.trim())}
                    >
                      Override and record
                    </Button>
                  </div>
                ) : null}
                {!lastMatch.matched && !lastMatch.override_by && !canOverride ? (
                  <p className="text-2xs text-text-subtle">
                    Releasing payment against this needs the match.override permission.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-2xs text-text-subtle">No match has been run yet.</p>
            )}
          </Section>

          {submitError ? <div className="mt-4"><ErrorCard error={submitError} /></div> : null}
        </>
      ) : null}
    </RecordSheet>
  );
}

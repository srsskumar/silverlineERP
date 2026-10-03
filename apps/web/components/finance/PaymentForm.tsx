'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';
import { createPayment, type Payment } from '@/lib/payments';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { NativeSelect } from '@/components/ui/Select';
import { Input, Textarea } from '@/components/ui/Input';
import { FieldError, RecordSheet } from '@/components/finance/Primitives';
import { applyFieldErrors } from '@/lib/form-errors';
import { paymentFormSchema, PAYMENT_DIRECTIONS, PAYMENT_MODES, type PaymentFormInput } from '@/lib/validation';
import { fullName } from '@/lib/people';

type Row = Record<string, any>;

/**
 * New payment (§45.3) — money that actually moved, distinct from the
 * documents it will later be allocated against.
 *
 * A standalone component (not inlined in app/payments/page.tsx — an
 * app-router page file may only export the page itself).
 */
export function PaymentForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const projects = useQuery({
    queryKey: ['projects', 'for-payment'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const {
    register, handleSubmit, setError, watch, formState: { errors },
  } = useForm<PaymentFormInput>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      direction: 'RECEIVABLE', payment_no: '', paid_on: '', amount: '' as unknown as number,
      mode: 'NEFT', reference: '', party_type: undefined, party_id: '', project_id: '',
      bank_account: '', notes: '',
    } as unknown as PaymentFormInput,
  });

  /*
   * Named, not typed in.
   *
   * The field used to ask for a raw UUID with nothing to look one up
   * against -- the only way to fill it correctly was already knowing the
   * id, which defeats the point of a form. Each party type reads from its
   * own list, the same way Project does a few fields down.
   */
  const partyType = watch('party_type');
  const clients = useQuery({
    queryKey: ['clients', 'for-payment'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/clients?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
    enabled: partyType === 'CLIENT',
  });
  const vendors = useQuery({
    queryKey: ['vendors', 'for-payment'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/vendors?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
    enabled: partyType === 'VENDOR',
  });
  const employees = useQuery({
    queryKey: ['employees', 'for-payment'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/employees?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
    enabled: partyType === 'EMPLOYEE',
  });
  const partyOptions: Row[] =
    partyType === 'CLIENT' ? (clients.data ?? [])
    : partyType === 'VENDOR' ? (vendors.data ?? [])
    : partyType === 'EMPLOYEE' ? (employees.data ?? [])
    : [];

  const create = useMutation({
    mutationFn: (v: PaymentFormInput) => createPayment(v),
    onSuccess: (row: Payment) => onCreated(String(row.id)),
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof PaymentFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} title="New payment" subtitle="Money in or out; allocate it to documents afterwards.">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-muted">
          Direction
          <NativeSelect className="mt-1 w-full" {...register('direction')}>
            {PAYMENT_DIRECTIONS.map((d) => (
              <option key={d} value={d}>{d === 'RECEIVABLE' ? 'Receivable — money in' : 'Payable — money out'}</option>
            ))}
          </NativeSelect>
          <FieldError message={errors.direction?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Payment number
          <Input className="mt-1 w-full" maxLength={50} {...register('payment_no')} />
          <FieldError message={errors.payment_no?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Paid on
          <Input type="date" className="mt-1 w-full" {...register('paid_on')} />
          <FieldError message={errors.paid_on?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Amount
          <Input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('amount')} />
          <FieldError message={errors.amount?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Mode
          <NativeSelect className="mt-1 w-full" {...register('mode')}>
            {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </NativeSelect>
          <FieldError message={errors.mode?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Reference (optional)
          <Input className="mt-1 w-full" maxLength={100} {...register('reference')} />
        </label>
        <label className="text-xs text-text-muted">
          Party type (optional)
          <NativeSelect className="mt-1 w-full" {...register('party_type')}>
            <option value="">Not specified</option>
            <option value="CLIENT">Client</option>
            <option value="VENDOR">Vendor</option>
            <option value="EMPLOYEE">Employee</option>
          </NativeSelect>
        </label>
        <label className="text-xs text-text-muted">
          {partyType === 'CLIENT' ? 'Client (optional)'
            : partyType === 'VENDOR' ? 'Vendor (optional)'
            : partyType === 'EMPLOYEE' ? 'Employee (optional)'
            : 'Party (optional)'}
          <NativeSelect className="mt-1 w-full" disabled={!partyType} {...register('party_id')}>
            <option value="">{partyType ? 'Not specified' : 'Choose a party type first'}</option>
            {partyOptions.map((p) => (
              <option key={String(p.id)} value={String(p.id)}>
                {partyType === 'EMPLOYEE' ? fullName(p) : String(p.name ?? p.id)}
              </option>
            ))}
          </NativeSelect>
          <FieldError message={errors.party_id?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Project (optional)
          <NativeSelect className="mt-1 w-full" {...register('project_id')}>
            <option value="">Not tied to a project</option>
            {(projects.data ?? []).map((p) => (
              <option key={String(p.id)} value={String(p.id)}>{p.code} — {p.name}</option>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs text-text-muted">
          Bank account (optional)
          <Input className="mt-1 w-full" maxLength={50} {...register('bank_account')} />
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">
          Notes (optional)
          <Textarea rows={2} className="mt-1 w-full" maxLength={1000} {...register('notes')} />
        </label>

        {submitError ? <ErrorCard title="Could not create the payment" error={submitError} className="sm:col-span-2" /> : null}

        <div className="mt-1 flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Create payment</Button>
        </div>
      </form>
    </RecordSheet>
  );
}

'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { createInstrument, type Instrument } from '@/lib/instruments';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, Section } from '@/components/finance/Primitives';
import { applyFieldErrors } from '@/lib/form-errors';
import { instrumentFormSchema, INSTRUMENT_TYPES, type InstrumentFormInput } from '@/lib/validation';

/**
 * New EMD/BG instrument against a tender (§8.4/§22.2). A standalone
 * component so it can be exercised directly against a stubbed fetch.
 */
export function InstrumentForm({
  tenderId, onCreated,
}: {
  tenderId: string;
  onCreated: (row: Instrument) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const {
    register, handleSubmit, reset, setError, formState: { errors },
  } = useForm<InstrumentFormInput>({
    resolver: zodResolver(instrumentFormSchema),
    defaultValues: {
      instrument_type: INSTRUMENT_TYPES[0], issuing_bank: '', instrument_number: '',
      amount: '' as unknown as number, issue_date: '', expiry_date: '',
      tender_id: tenderId, project_id: '', notes: '',
    } as unknown as InstrumentFormInput,
  });

  const create = useMutation({
    mutationFn: (v: InstrumentFormInput) => createInstrument(v),
    onSuccess: (row) => {
      reset({
        instrument_type: INSTRUMENT_TYPES[0], issuing_bank: '', instrument_number: '',
        amount: '' as unknown as number, issue_date: '', expiry_date: '',
        tender_id: tenderId, project_id: '', notes: '',
      } as unknown as InstrumentFormInput);
      setSubmitError(null);
      onCreated(row);
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof InstrumentFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <Section title="New instrument">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate className="grid gap-3 sm:grid-cols-3">
        <input type="hidden" {...register('tender_id')} />
        <label className="text-xs text-text-muted">
          Type
          <select className="mt-1 w-full" {...register('instrument_type')}>
            {INSTRUMENT_TYPES.map((t) => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}
          </select>
          <FieldError message={errors.instrument_type?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Issuing bank
          <input className="mt-1 w-full" {...register('issuing_bank')} />
          <FieldError message={errors.issuing_bank?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Instrument number
          <input className="mt-1 w-full" maxLength={100} {...register('instrument_number')} />
          <FieldError message={errors.instrument_number?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Amount
          <input type="number" min="0" step="0.01" className="mt-1 w-full" {...register('amount')} />
          <FieldError message={errors.amount?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Issue date
          <input type="date" className="mt-1 w-full" {...register('issue_date')} />
          <FieldError message={errors.issue_date?.message} />
        </label>
        <label className="text-xs text-text-muted">
          Expiry date
          <input type="date" className="mt-1 w-full" {...register('expiry_date')} />
          <FieldError message={errors.expiry_date?.message} />
        </label>
        <label className="text-xs text-text-muted sm:col-span-3">
          Notes (optional)
          <input className="mt-1 w-full" {...register('notes')} />
        </label>

        {submitError ? <ErrorCard title="Could not save the instrument" error={submitError} className="sm:col-span-3" /> : null}

        <div className="sm:col-span-3">
          <Button type="submit" loading={create.isPending}>Add instrument</Button>
        </div>
      </form>
    </Section>
  );
}

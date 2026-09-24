'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { listPayments } from '@/lib/payments';
import { Combobox, type ComboOption } from '@/components/ui/Combobox';
import { day, money } from '@/lib/finance';

/**
 * A payment, chosen by number, amount or date rather than pasted as a raw
 * UUID (fix round 1 item 7 — bank reconciliation's ReconcileRow used to ask
 * for one directly).
 *
 * Loads up to 100 payments once and lets Combobox's own client-side filter
 * match against the label (the payment number) or the hint (amount and
 * date) — the same "type anywhere in the label or hint" search UserPicker
 * already gives the staff directory. The API has no free-text search on
 * GET /api/v1/payments, so this is what "search by number, amount or date"
 * means without a new server endpoint: narrow the same 100 rows the list
 * screen already shows, not query the server per keystroke.
 */
export function PaymentPicker({
  value, onChange, id, placeholder, exclude,
}: {
  value: string;
  onChange: (paymentId: string) => void;
  id?: string;
  placeholder?: string;
  /** Ids never offered — a payment already reversed, say. */
  exclude?: string[];
}) {
  const payments = useQuery({
    queryKey: ['payments', 'picker'],
    queryFn: () => listPayments({ limit: 100 }),
    staleTime: 60_000,
  });

  const excluded = new Set(exclude ?? []);
  const options: ComboOption[] = (payments.data ?? [])
    .filter((p) => !excluded.has(String(p.id)))
    .map((p) => ({
      id: String(p.id),
      label: p.payment_no,
      hint: `${money(p.amount)} · ${day(p.paid_on)}`,
    }));

  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      isLoading={payments.isLoading}
      placeholder={placeholder ?? 'Search by number, amount or date…'}
    />
  );
}

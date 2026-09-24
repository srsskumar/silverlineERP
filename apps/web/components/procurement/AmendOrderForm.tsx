'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { RecordSheet, Section } from '@/components/finance/Primitives';

type Row = Record<string, any>;

/**
 * Amend an issued order (§43.2).
 *
 * POST /api/v1/purchase-orders/:id/amend has existed since it closed "the
 * gap where po_amendments was a table with no endpoint" (procurement/
 * routes.ts) -- gated on po.amend, and the order detail screen already
 * shows the amendment history it writes. Nothing ever called it: there was
 * no way to start an amendment from the web app at all, only to read about
 * one that had already happened via some other client. Found live during
 * the round-2 deep walk (projects/procurement).
 *
 * Only a reason is required; a quantity, rate or delivery-date change is
 * optional per line, matching the route's body shape. Leaving every line
 * untouched still amends the order (e.g. delivery date alone) as long as a
 * reason is given, same as the server allows.
 */
export function AmendOrder({
  po, onClose, onDone,
}: {
  po: Row; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [deliveryDate, setDeliveryDate] = React.useState('');
  const [lineEdits, setLineEdits] = React.useState<Record<string, { quantity: string; unit_rate: string }>>({});

  const lines: Row[] = po.lines ?? [];

  const setLineEdit = (lineId: string, patch: Partial<{ quantity: string; unit_rate: string }>) => {
    const current = lineEdits[lineId] ?? { quantity: '', unit_rate: '' };
    setLineEdits({ ...lineEdits, [lineId]: { ...current, ...patch } });
  };

  const amend = useMutation({
    mutationFn: async () => {
      const changedLines = lines
        .map((l) => {
          const edit = lineEdits[String(l.id)];
          if (!edit) return null;
          const out: Row = { po_line_id: String(l.id) };
          let changed = false;
          if (edit.quantity !== '' && Number(edit.quantity) !== Number(l.quantity)) {
            out.quantity = Number(edit.quantity); changed = true;
          }
          if (edit.unit_rate !== '' && Number(edit.unit_rate) !== Number(l.unit_rate)) {
            out.unit_rate = Number(edit.unit_rate); changed = true;
          }
          return changed ? out : null;
        })
        .filter((x): x is Row => x !== null);
      return apiRequest(`/api/v1/purchase-orders/${po.id}/amend`, {
        method: 'POST',
        headers: { 'If-Match': String(po.version) },
        body: {
          reason: reason.trim(),
          delivery_date: deliveryDate || undefined,
          lines: changedLines.length ? changedLines : undefined,
        },
      });
    },
    onSuccess: onDone,
  });

  const ready = reason.trim().length > 0;

  return (
    <RecordSheet open onClose={onClose} title={`Amend ${po.po_number ?? ''}`}
      subtitle="A change that moves the approved value re-routes it through approval again.">
      <div className="space-y-4">
        <label className="block text-xs text-text-muted">
          Reason *
          <textarea aria-label="Amendment reason" className="mt-1 w-full rounded border border-border bg-surface p-2 text-sm text-text"
            value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="block text-xs text-text-muted">
          New delivery date (optional)
          <input type="date" className="mt-1 w-full rounded border border-border bg-surface p-2 text-sm text-text"
            value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
        </label>

        <Section title="Lines — change quantity or rate where needed, leave the rest blank">
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={String(l.id)} className="grid gap-2 rounded-lg border border-border bg-surface-sunken p-3 sm:grid-cols-3">
                <span className="text-sm text-text">{l.description}</span>
                <input type="number" min="0" step="any" aria-label={`Quantity for ${l.description}`}
                  placeholder={`Qty (currently ${Number(l.quantity)})`}
                  value={lineEdits[String(l.id)]?.quantity ?? ''}
                  onChange={(e) => setLineEdit(String(l.id), { quantity: e.target.value })} />
                <input type="number" min="0" step="any" aria-label={`Rate for ${l.description}`}
                  placeholder={`Rate (currently ${Number(l.unit_rate)})`}
                  value={lineEdits[String(l.id)]?.unit_rate ?? ''}
                  onChange={(e) => setLineEdit(String(l.id), { unit_rate: e.target.value })} />
              </div>
            ))}
          </div>
        </Section>

        {amend.isError ? <ErrorCard error={amend.error} /> : null}

        <div className="flex gap-2">
          <Button loading={amend.isPending} disabled={!ready} onClick={() => amend.mutate()}>
            Submit amendment
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </RecordSheet>
  );
}

'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listInstruments, setInstrumentStatus, type Instrument } from '@/lib/instruments';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Section } from '@/components/finance/Primitives';
import { day, money } from '@/lib/finance';
import { InstrumentForm } from './InstrumentForm';

const TERMINAL = new Set(['RELEASED', 'CLAIMED']);

/** How urgently this instrument's expiry needs attention (§8.4/§22.2). */
function expiryTone(expiryDate: string, status: string): 'danger' | 'warning' | 'neutral' {
  if (TERMINAL.has(status)) return 'neutral';
  const days = Math.floor((Date.parse(`${expiryDate}T00:00:00Z`) - Date.now()) / 86_400_000);
  if (days < 0 || status === 'EXPIRED') return 'danger';
  if (days <= 30) return 'warning';
  return 'neutral';
}

function StatusAction({ row, onDone }: { row: Instrument; onDone: () => void }) {
  const [open, setOpen] = React.useState<'RELEASED' | 'CLAIMED' | null>(null);
  const [reason, setReason] = React.useState('');

  const change = useMutation({
    mutationFn: (status: 'RELEASED' | 'CLAIMED') => setInstrumentStatus(row.id, row.version, status, reason.trim() || undefined),
    onSuccess: () => { setOpen(null); setReason(''); onDone(); },
  });

  if (TERMINAL.has(row.instrument_status)) return null;

  if (open) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-1.5">
          <input className="w-40 text-2xs" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button variant="secondary" size="sm" onClick={() => setOpen(null)}>Cancel</Button>
          <Button size="sm" loading={change.isPending} onClick={() => change.mutate(open)}>
            Confirm {open === 'RELEASED' ? 'release' : 'forfeit'}
          </Button>
        </div>
        {change.isError ? <ErrorCard error={change.error} className="max-w-xs" /> : null}
      </div>
    );
  }
  return (
    <div className="flex justify-end gap-1.5">
      <Button variant="secondary" size="sm" onClick={() => setOpen('RELEASED')}>Release</Button>
      <Button variant="ghost" size="sm" onClick={() => setOpen('CLAIMED')}>Forfeit</Button>
    </div>
  );
}

/**
 * EMD/BG instruments on a tender (§8.4/§22.2): amount, bank, instrument no.,
 * validity, release/forfeit status, with expiry highlighting. A standalone
 * component on the tender detail page (app/tenders/page.tsx already renders
 * TenderDetail inline; this replaces that page's read-only instrument list).
 */
export function TenderInstruments({ tenderId }: { tenderId: string }) {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, 'instrument.manage');
  const client = useQueryClient();

  const list = useQuery({
    queryKey: ['instruments', tenderId],
    queryFn: () => listInstruments({ tender_id: tenderId }),
    staleTime: 15_000,
  });

  const refresh = () => void client.invalidateQueries({ queryKey: ['instruments', tenderId] });
  const rows = list.data ?? [];

  return (
    <Section title="EMD and guarantees">
      {list.isError ? (
        <ErrorCard title="Could not load instruments" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No instruments recorded" description="Nothing has been added against this tender yet." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Type</TH>
                <TH>Bank</TH>
                <TH>Instrument no.</TH>
                <TH className="text-right">Amount</TH>
                <TH>Valid until</TH>
                <TH>State</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((i) => (
                <TR key={i.id}>
                  <TD tone="muted">{i.instrument_type.replaceAll('_', ' ')}</TD>
                  <TD className="text-text">{i.issuing_bank}</TD>
                  <TD mono>{i.instrument_number}</TD>
                  <TD className="text-right tabular-nums">{money(i.amount)}</TD>
                  <TD>
                    <Badge tone={expiryTone(i.expiry_date, i.instrument_status)} size="sm">
                      {day(i.expiry_date)}
                    </Badge>
                  </TD>
                  <TD tone="muted">{i.instrument_status}</TD>
                  <TD align="right">
                    {canManage ? <StatusAction row={i} onDone={refresh} /> : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}

      {canManage ? (
        <div className="mt-4">
          <InstrumentForm tenderId={tenderId} onCreated={refresh} />
        </div>
      ) : null}
    </Section>
  );
}

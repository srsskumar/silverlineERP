'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listBankTransactions, reconcileBankTransaction, type BankTransaction } from '@/lib/bank-transactions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { day, money } from '@/lib/finance';
import { BankImportForm } from './BankImportForm';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  RECONCILED: 'success', PARTIALLY_MATCHED: 'warning', EXCEPTION: 'danger', UNMATCHED: 'neutral',
};

function ReconcileRow({ row, onDone }: { row: BankTransaction; onDone: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [paymentId, setPaymentId] = React.useState('');
  const [note, setNote] = React.useState('');

  const reconcile = useMutation({
    mutationFn: () => reconcileBankTransaction(row.id, row.version, paymentId.trim(), note.trim() || undefined),
    onSuccess: () => { setOpen(false); setPaymentId(''); setNote(''); onDone(); },
  });

  if (!open) {
    return <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Reconcile</Button>;
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <input className="w-40 text-2xs" placeholder="Payment ID (UUID)" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} />
        <input className="w-28 text-2xs" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" loading={reconcile.isPending} disabled={!paymentId.trim()} onClick={() => reconcile.mutate()}>
          Confirm
        </Button>
      </div>
      {reconcile.isError ? <ErrorCard error={reconcile.error} className="max-w-xs" /> : null}
    </div>
  );
}

/** Bank statement reconciliation (§45.4). */
export function BankReconciliationManager() {
  const client = useQueryClient();
  const [status, setStatus] = React.useState('');

  const list = useQuery({
    queryKey: ['bank-transactions', status],
    queryFn: () => listBankTransactions(status ? { status } : {}),
    staleTime: 15_000,
  });

  const refresh = () => void client.invalidateQueries({ queryKey: ['bank-transactions'] });
  const rows = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <BankImportForm onImported={refresh} />
      </Card>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <label className="text-xs text-text-muted">
          Status
          <select className="mt-1 w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="UNMATCHED">Unmatched</option>
            <option value="RECONCILED">Reconciled</option>
            <option value="PARTIALLY_MATCHED">Partially matched</option>
            <option value="EXCEPTION">Exception</option>
          </select>
        </label>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <ErrorCard title="Could not load bank transactions" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No bank transactions" description="Import a statement to get started." />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Reference</TH>
                  <TH>Value date</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Bank account</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD mono>{r.statement_ref}</TD>
                    <TD tone="muted">{day(r.value_date)}</TD>
                    <TD className="text-right tabular-nums">{money(r.amount)}</TD>
                    <TD tone="muted">{r.bank_account ?? '—'}</TD>
                    <TD>
                      <Badge tone={STATUS_TONE[r.reconciliation_status] ?? 'neutral'} size="sm">{r.reconciliation_status}</Badge>
                      {r.exception_note ? <p className="mt-0.5 text-2xs text-danger">{r.exception_note}</p> : null}
                    </TD>
                    <TD align="right">
                      {r.reconciliation_status === 'UNMATCHED' || r.reconciliation_status === 'EXCEPTION' ? (
                        <ReconcileRow row={r} onDone={refresh} />
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}

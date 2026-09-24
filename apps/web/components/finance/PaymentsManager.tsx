'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { listPayments } from '@/lib/payments';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { day, money } from '@/lib/finance';
import { PaymentForm } from './PaymentForm';

/** Payments list (§45.3) — money that actually moved, in or out. */
export function PaymentsManager() {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, PERMISSIONS.PAYMENT_MANAGE);
  const [direction, setDirection] = React.useState('');
  const [unallocatedOnly, setUnallocatedOnly] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);

  const list = useQuery({
    queryKey: ['payments', direction, unallocatedOnly],
    queryFn: () => listPayments({ direction: direction || undefined, unallocated: unallocatedOnly }),
    staleTime: 15_000,
  });

  const rows = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <label className="text-xs text-text-muted">
          Direction
          <select className="mt-1 w-48" value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="">All</option>
            <option value="RECEIVABLE">Receivable</option>
            <option value="PAYABLE">Payable</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" checked={unallocatedOnly} onChange={(e) => setUnallocatedOnly(e.target.checked)} />
          Unallocated only
        </label>
        <div className="ml-auto">
          {canManage ? <Button onClick={() => setCreateOpen(true)}>New payment</Button> : null}
        </div>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <ErrorCard title="Could not load payments" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No payments" description="Nothing recorded yet." />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Payment</TH>
                  <TH>Direction</TH>
                  <TH>Paid on</TH>
                  <TH className="text-right">Amount</TH>
                  <TH className="text-right">Unallocated</TH>
                  <TH>Mode</TH>
                  <TH>State</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((p) => (
                  <TR key={p.id}>
                    <TD mono className="text-text">{p.payment_no}</TD>
                    <TD tone="muted">{p.direction}</TD>
                    <TD tone="muted">{day(p.paid_on)}</TD>
                    <TD className="text-right tabular-nums font-semibold">{money(p.amount)}</TD>
                    <TD className="text-right tabular-nums">
                      <span className={p.unallocated_amount > 0.005 ? 'font-semibold text-warning' : 'text-text-subtle'}>
                        {money(p.unallocated_amount)}
                      </span>
                    </TD>
                    <TD tone="muted">{p.mode}</TD>
                    <TD>
                      {p.reversed_at ? (<Badge tone="danger" size="sm">Reversed</Badge>) : (<Badge tone="success" size="sm">Live</Badge>)}
                    </TD>
                    <TD align="right">
                      <Link href={`/payments/${p.id}`} className="text-xs font-medium text-primary underline">
                        Open
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}

      {createOpen && canManage ? (
        <PaymentForm
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void list.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

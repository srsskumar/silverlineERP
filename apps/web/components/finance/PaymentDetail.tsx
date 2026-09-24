'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPayment, reversePayment } from '@/lib/payments';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Field, Notice, Section } from '@/components/finance/Primitives';
import { day, money } from '@/lib/finance';
import { PaymentAllocationForm } from './PaymentAllocationForm';

/**
 * One payment: what it is, what it has settled, and what is still free to
 * allocate (§45.3). Route-adjacent client component, not exported from
 * app/payments/[id]/page.tsx itself (a Next.js page file may only export
 * the page and a small set of reserved names).
 */
export function PaymentDetail({ id }: { id: string }) {
  const { session } = useAuth();
  const canAllocate = hasPermission({ permissions: session?.permissions }, PERMISSIONS.PAYMENT_ALLOCATE);
  const canManage = hasPermission({ permissions: session?.permissions }, PERMISSIONS.PAYMENT_MANAGE);
  const client = useQueryClient();
  const [reversing, setReversing] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const payment = useQuery({
    queryKey: ['payment', id],
    queryFn: () => getPayment(id),
    enabled: Boolean(id) && id !== '__placeholder__',
  });

  const reverse = useMutation({
    mutationFn: () => reversePayment(id, payment.data!.version, reason.trim()),
    onSuccess: () => {
      setReversing(false);
      setReason('');
      void client.invalidateQueries({ queryKey: ['payment', id] });
    },
  });

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PAYMENT_READ}>
      <PageHeader title="Payment" description="What it is, what it has settled, and what is still free to allocate." />
      <PageBody>
        {payment.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : payment.isError ? (
          <ErrorCard title="Could not load this payment" error={payment.error} onRetry={() => payment.refetch()} />
        ) : payment.data ? (
          <div className="flex flex-col gap-4">
            <Card className="p-4">
              <div className="flex items-start justify-between gap-3">
                <dl className="grid flex-1 gap-3 sm:grid-cols-4">
                  <Field label="Payment no" value={payment.data.payment_no} mono />
                  <Field label="Direction" value={payment.data.direction} />
                  <Field label="Paid on" value={day(payment.data.paid_on)} />
                  <Field label="Amount" value={money(payment.data.amount)} />
                  <Field label="Mode" value={payment.data.mode} />
                  <Field label="Reference" value={payment.data.reference ?? '—'} />
                  <Field label="Unallocated" value={money(payment.data.unallocated_amount)} tone={payment.data.unallocated_amount > 0.005 ? 'danger' : 'success'} />
                  <Field
                    label="State"
                    value={payment.data.reversed_at
                      ? <Badge tone="danger" size="sm">Reversed</Badge>
                      : <Badge tone="success" size="sm">Live</Badge>}
                  />
                </dl>
                {canManage && !payment.data.reversed_at ? (
                  reversing ? (
                    <div className="flex items-center gap-2">
                      <input
                        className="w-56"
                        placeholder="Reason for reversal"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <Button variant="secondary" size="sm" onClick={() => { setReversing(false); setReason(''); }}>Cancel</Button>
                      <Button
                        size="sm" loading={reverse.isPending} disabled={!reason.trim()}
                        onClick={() => reverse.mutate()}
                      >
                        Confirm reverse
                      </Button>
                    </div>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setReversing(true)}>Reverse</Button>
                  )
                ) : null}
              </div>
              {payment.data.reversed_at ? (
                <div className="mt-3">
                  <Notice tone="danger" title="This payment is reversed">
                    {payment.data.reversal_reason}
                  </Notice>
                </div>
              ) : null}
              {reverse.isError ? <ErrorCard title="Could not reverse this payment" error={reverse.error} className="mt-3" /> : null}
            </Card>

            <Section title="Allocations">
              {(payment.data.allocations ?? []).length === 0 ? (
                <EmptyState title="Nothing allocated yet" description="This payment has not been matched to any document." />
              ) : (
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Document</TH>
                        <TH className="text-right">Amount</TH>
                        <TH className="text-right">TDS</TH>
                        <TH className="text-right">Retention</TH>
                        <TH>State</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {(payment.data.allocations as Record<string, any>[]).map((a) => (
                        <TR key={String(a.id)}>
                          <TD mono>{a.document_type} · {String(a.document_id).slice(0, 8)}…</TD>
                          <TD className="text-right tabular-nums">{money(a.amount)}</TD>
                          <TD className="text-right tabular-nums">{money(a.tds_amount)}</TD>
                          <TD className="text-right tabular-nums">{money(a.retention_amount)}</TD>
                          <TD>{a.reversed_at ? <Badge tone="neutral" size="sm">Reversed</Badge> : <Badge tone="success" size="sm">Live</Badge>}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              )}
            </Section>

            {canAllocate && !payment.data.reversed_at ? (
              <Card className="p-4">
                <PaymentAllocationForm paymentId={id} onAllocated={() => void payment.refetch()} />
              </Card>
            ) : null}
          </div>
        ) : null}
      </PageBody>
      </RequirePermission>
    </AppShell>
  );
}

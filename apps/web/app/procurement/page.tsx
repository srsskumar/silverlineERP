'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Field, Notice, RecordSheet, Section, StatusBadge, Stat } from '@/components/finance/Primitives';
import { day, money, financialTone, requisitionTone, poTone } from '@/lib/finance';
import { NewRequisition } from '@/components/procurement/NewRequisitionForm';
import { NewPurchaseOrder } from '@/components/procurement/NewPurchaseOrderForm';
import { NewGrn } from '@/components/procurement/NewGrnForm';
import { NewRfq } from '@/components/procurement/NewRfqForm';
import { AmendOrder } from '@/components/procurement/AmendOrderForm';

type Row = Record<string, any>;
type Tab = 'requisitions' | 'orders' | 'rfqs' | 'returns';

/**
 * Procurement (§13.2, §43).
 *
 * The chain exists to answer one question before money leaves: did we order
 * this, did it arrive, and does the bill match. The tabs follow that order,
 * and every list leads with where a document sits in it rather than with when
 * it was created.
 */
export default function ProcurementPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const [tab, setTab] = React.useState<Tab>('requisitions');
  const [selected, setSelected] = React.useState<{ kind: Tab; id: string } | null>(null);
  const [status, setStatus] = React.useState('');
  const [creatingRequisition, setCreatingRequisition] = React.useState(false);
  const [orderPrefill, setOrderPrefill] = React.useState<{ requisitionId: string } | null>(null);
  const [creatingOrder, setCreatingOrder] = React.useState(false);
  const [creatingRfq, setCreatingRfq] = React.useState(false);
  const client = useQueryClient();

  const canManageRequisition = hasPermission(perms, 'requisition.manage');
  const canManagePo = hasPermission(perms, 'po.manage');
  const canManageRfq = hasPermission(perms, 'rfq.manage');

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const open = params.get('open');
    const kind = params.get('kind') as Tab | null;
    if (open) {
      setSelected({ kind: kind ?? 'requisitions', id: open });
      if (kind) setTab(kind);
    }
  }, []);

  const endpoint: Record<Tab, string> = {
    requisitions: '/api/v1/requisitions',
    orders: '/api/v1/purchase-orders',
    rfqs: '/api/v1/rfqs',
    returns: '/api/v1/vendor-returns',
  };

  const list = useQuery({
    queryKey: ['procurement', tab, status],
    queryFn: async () =>
      ((await apiRequestRaw(
        `${endpoint[tab]}?limit=100${status ? `&status=${status}` : ''}`,
      )).body as { data: Row[] }).data,
    staleTime: 20_000,
  });

  const rows = list.data ?? [];
  const refresh = () => void client.invalidateQueries({ queryKey: ['procurement'] });

  const ALL_TABS: { key: Tab; label: string; permission: string }[] = [
    { key: 'requisitions', label: 'Requisitions', permission: 'requisition.read' },
    { key: 'orders', label: 'Purchase orders', permission: 'po.read' },
    { key: 'rfqs', label: 'RFQs', permission: 'rfq.read' },
    { key: 'returns', label: 'Returns', permission: 'return.read' },
  ];
  const tabs = ALL_TABS.filter((t) => hasPermission(perms, t.permission));

  return (
    <AppShell>
      <PageHeader
        title="Procurement"
        description="Requisition to order to receipt, and the bill checked against both."
        actions={
          <>
            {canManageRequisition ? (
              <Button onClick={() => setCreatingRequisition(true)}>New requisition</Button>
            ) : null}
            {canManagePo ? (
              <Button variant="secondary" onClick={() => { setOrderPrefill(null); setCreatingOrder(true); }}>
                New order
              </Button>
            ) : null}
            {canManageRfq ? (
              <Button variant="secondary" onClick={() => setCreatingRfq(true)}>New RFQ</Button>
            ) : null}
          </>
        }
      />

      <PageBody>
        <Toolbar>
          <div className="flex rounded-md border border-border bg-surface p-0.5">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => { setTab(t.key); setStatus(''); }}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  tab === t.key ? 'bg-primary text-primary-fg' : 'text-text-muted hover:text-text'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'requisitions' || tab === 'orders' ? (
            <select
              aria-label="Status"
              className="max-w-48"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              {(tab === 'requisitions'
                ? ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED']
                : ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']
              ).map((s) => (
                <option key={s} value={s}>{s.replaceAll('_', ' ').toLowerCase()}</option>
              ))}
            </select>
          ) : null}
        </Toolbar>

        {list.error ? <ErrorCard error={list.error} onRetry={() => void list.refetch()} /> : null}

        {list.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={`No ${tab}`}
            description={
              tab === 'rfqs'
                ? 'An RFQ invites several vendors to quote, and ranks them on landed cost rather than unit rate.'
                : 'Documents appear here as the chain progresses.'
            }
          />
        ) : (
          <Card>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    {tab === 'requisitions' ? (
                      <>
                        <TH>Requisition</TH><TH>Project</TH><TH>Raised by</TH>
                        <TH align="right">Estimated</TH><TH>Status</TH><TH />
                      </>
                    ) : tab === 'orders' ? (
                      <>
                        <TH>Order</TH><TH>Vendor</TH><TH>Delivery</TH>
                        <TH align="right">Value</TH><TH>Status</TH><TH />
                      </>
                    ) : tab === 'rfqs' ? (
                      <>
                        <TH>RFQ</TH><TH>Due</TH><TH align="right">Vendors</TH>
                        <TH align="right">Quotes in</TH><TH>Status</TH><TH />
                      </>
                    ) : (
                      <>
                        <TH>Return</TH><TH>Reason</TH><TH>Resolution</TH>
                        <TH>Date</TH><TH /><TH />
                      </>
                    )}
                  </TR>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={String(r.id)}>
                      {tab === 'requisitions' ? (
                        <>
                          <TD>
                            <span className="font-mono text-xs font-medium text-text">{r.requisition_no}</span>
                            <p className="truncate text-2xs text-text-subtle">{r.justification}</p>
                          </TD>
                          <TD tone="subtle">{r.project_code ?? '—'}</TD>
                          <TD tone="muted">{r.requested_by_username ?? '—'}</TD>
                          <TD align="right" className="text-text-muted">{money(r.estimated_value)}</TD>
                          <TD><StatusBadge status={r.status} tone={requisitionTone(r.status)} /></TD>
                        </>
                      ) : tab === 'orders' ? (
                        <>
                          <TD>
                            <span className="font-mono text-xs font-medium text-text">{r.po_number}</span>
                            {r.acknowledged_on ? (
                              <p className="text-2xs text-success">Acknowledged {day(r.acknowledged_on)}</p>
                            ) : null}
                          </TD>
                          <TD tone="muted">{r.vendor_name ?? '—'}</TD>
                          <TD tone="subtle">
                            {day(r.promised_delivery_date ?? r.delivery_date)}
                          </TD>
                          <TD align="right" className="text-text-muted">{money(r.total_value)}</TD>
                          <TD><StatusBadge status={r.status} tone={poTone(r.status)} /></TD>
                        </>
                      ) : tab === 'rfqs' ? (
                        <>
                          <TD>
                            <span className="font-mono text-xs font-medium text-text">{r.rfq_no}</span>
                            <p className="truncate text-2xs text-text-subtle">{r.scope ?? ''}</p>
                          </TD>
                          <TD tone="subtle">{day(r.due_date)}</TD>
                          <TD align="right" className="text-text-muted">{r.invited_count ?? '—'}</TD>
                          <TD align="right" className="text-text-muted">{r.quote_count ?? 0}</TD>
                          <TD><StatusBadge status={r.status} /></TD>
                        </>
                      ) : (
                        <>
                          <TD>
                            <span className="font-mono text-xs text-text">{r.return_no}</span>
                            <p className="text-2xs text-text-subtle">against {r.grn_no}</p>
                          </TD>
                          <TD tone="muted">
                            {String(r.reason ?? '').replaceAll('_', ' ').toLowerCase()}
                          </TD>
                          <TD>
                            <Badge tone={r.resolution === 'PENDING' ? 'warning' : 'success'} size="sm">
                              {String(r.resolution ?? '').replaceAll('_', ' ').toLowerCase()}
                            </Badge>
                          </TD>
                          <TD tone="subtle">{day(r.return_date)}</TD>
                          <TD />
                        </>
                      )}
                      <TD align="right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setSelected({ kind: tab, id: String(r.id) })}
                        >
                          Open
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </Card>
        )}
      </PageBody>

      {selected?.kind === 'requisitions' ? (
        <RequisitionDetail
          id={selected.id}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onCreateOrder={canManagePo ? (requisitionId) => {
            setSelected(null);
            setOrderPrefill({ requisitionId });
            setCreatingOrder(true);
          } : undefined}
        />
      ) : null}
      {selected?.kind === 'orders' ? (
        <OrderDetail
          id={selected.id}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      ) : null}
      {selected?.kind === 'rfqs' ? (
        <RfqDetail id={selected.id} onClose={() => setSelected(null)} onChanged={refresh} />
      ) : null}

      {creatingRequisition ? (
        <NewRequisition
          onClose={() => setCreatingRequisition(false)}
          onCreated={(id) => { refresh(); setCreatingRequisition(false); setSelected({ kind: 'requisitions', id }); }}
        />
      ) : null}
      {creatingOrder ? (
        <NewPurchaseOrder
          prefillRequisitionId={orderPrefill?.requisitionId}
          onClose={() => { setCreatingOrder(false); setOrderPrefill(null); }}
          onCreated={(id) => {
            refresh(); setCreatingOrder(false); setOrderPrefill(null);
            setTab('orders'); setSelected({ kind: 'orders', id });
          }}
        />
      ) : null}
      {creatingRfq ? (
        <NewRfq
          onClose={() => setCreatingRfq(false)}
          onCreated={(id) => { refresh(); setCreatingRfq(false); setTab('rfqs'); setSelected({ kind: 'rfqs', id }); }}
        />
      ) : null}
    </AppShell>
  );
}

/* ----------------------------------------------------------- requisition */

function RequisitionDetail({
  id, onClose, onChanged, onCreateOrder,
}: {
  id: string; onClose: () => void; onChanged: () => void; onCreateOrder?: (requisitionId: string) => void;
}) {
  const [error, setError] = React.useState<unknown>(null);
  const detail = useQuery({
    queryKey: ['requisition', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/requisitions/${id}`)).data,
  });
  const r = detail.data;

  const submit = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/requisitions/${id}/submit`, {
        method: 'POST', headers: { 'If-Match': String(r!.version) }, body: {},
      }),
    onSuccess: () => { setError(null); void detail.refetch(); onChanged(); },
    onError: setError,
  });

  const lines: Row[] = r?.lines ?? [];
  const orders: Row[] = r?.purchase_orders ?? [];

  return (
    <RecordSheet
      open onClose={onClose} wide
      title={r?.requisition_no ?? 'Requisition'}
      subtitle={r ? `${money(r.estimated_value)} · raised ${day(r.created_at)}` : undefined}
    >
      {detail.isLoading || !r ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Field label="Status" value={<StatusBadge status={r.status} tone={requisitionTone(r.status)} size="md" />} />
            <Field label="Estimated" value={money(r.estimated_value)} />
            <Field label="Required by" value={day(r.required_by)} />
            <Field label="Project" value={r.project_code ?? '—'} />
          </dl>

          <div className="mt-3 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-muted">
            {r.justification}
          </div>

          {r.rejection_reason ? (
            <div className="mt-4"><Notice tone="danger" title="Rejected">{r.rejection_reason}</Notice></div>
          ) : null}

          <Section title="Lines">
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Item</TH><TH align="right">Quantity</TH><TH align="right">Rate</TH><TH align="right">Value</TH>
                  </TR>
                </THead>
                <TBody>
                  {lines.map((l) => (
                    <TR key={String(l.id)}>
                      <TD className="text-text">{l.description}</TD>
                      <TD align="right" className="text-text-muted">{Number(l.quantity)} {l.unit}</TD>
                      <TD align="right" className="text-text-muted">{l.estimated_rate ? money(l.estimated_rate) : '—'}</TD>
                      <TD align="right" className="text-text">
                        {l.estimated_rate ? money(Number(l.quantity) * Number(l.estimated_rate)) : '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </Section>

          {orders.length > 0 ? (
            <Section title="Orders raised">
              <ul className="space-y-1.5 text-sm">
                {orders.map((o) => (
                  <li key={String(o.id)} className="flex items-center justify-between gap-2">
                    <a
                      href={`/procurement?kind=orders&open=${o.id}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {o.po_number}
                    </a>
                    <span className="flex items-center gap-2">
                      <span className="text-text-muted">{money(o.total_value)}</span>
                      <StatusBadge status={o.status} tone={poTone(o.status)} />
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {r.approval_id ? (
            <Section title="Approval">
              <a
                href={`/approvals?open=${r.approval_id}`}
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                Open the ladder →
              </a>
            </Section>
          ) : null}

          {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

          {(r.allowed_statuses ?? []).includes('SUBMITTED') ? (
            <Section title="Actions">
              <Button loading={submit.isPending} onClick={() => submit.mutate()}>
                Submit for approval
              </Button>
              <p className="mt-1.5 text-2xs text-text-subtle">
                Maker-checker means whoever raised this cannot also approve it.
              </p>
            </Section>
          ) : null}

          {onCreateOrder && r.status === 'APPROVED' ? (
            <Section title="Actions">
              <Button onClick={() => onCreateOrder(id)}>Create order from this requisition</Button>
              <p className="mt-1.5 text-2xs text-text-subtle">
                Its lines are carried over; an order that goes beyond them needs an override reason.
              </p>
            </Section>
          ) : null}
        </>
      )}
    </RecordSheet>
  );
}

/* ----------------------------------------------------------------- order */

function OrderDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, 'po.manage');
  const canManageGrn = hasPermission({ permissions: session?.permissions }, 'grn.manage');
  const canAmend = hasPermission({ permissions: session?.permissions }, 'po.amend');
  const [error, setError] = React.useState<unknown>(null);
  const [recordingGrn, setRecordingGrn] = React.useState(false);
  const [amending, setAmending] = React.useState(false);

  const detail = useQuery({
    queryKey: ['purchase-order', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/purchase-orders/${id}`)).data,
  });
  const po = detail.data;

  const grns = useQuery({
    queryKey: ['purchase-order-grns', id],
    queryFn: async () => (await apiRequest<Row[]>(`/api/v1/purchase-orders/${id}/grns`)).data,
    enabled: Boolean(po),
  });

  const after = () => { setError(null); void detail.refetch(); void grns.refetch(); onChanged(); };

  const move = useMutation({
    mutationFn: async (status: string) =>
      apiRequest(`/api/v1/purchase-orders/${id}/status`, {
        method: 'POST', headers: { 'If-Match': String(po!.version) }, body: { status },
      }),
    onSuccess: after, onError: setError,
  });

  const submit = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/purchase-orders/${id}/submit`, {
        method: 'POST', headers: { 'If-Match': String(po!.version) }, body: {},
      }),
    onSuccess: after, onError: setError,
  });

  const lines: Row[] = po?.lines ?? [];
  const amendments: Row[] = po?.amendments ?? [];
  const received = lines.filter((l) => l.status === 'COMPLETE').length;
  const overReceived = lines.filter((l) => l.status === 'OVER_RECEIVED');

  return (
    <RecordSheet
      open onClose={onClose} wide
      title={po?.po_number ?? 'Purchase order'}
      subtitle={po ? `${po.vendor_name ?? ''} · ${money(po.total_value)}` : undefined}
    >
      {detail.isLoading || !po ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Field label="Status" value={<StatusBadge status={po.status} tone={poTone(po.status)} size="md" />} />
            <Field label="Value" value={money(po.total_value)} />
            <Field label="Delivery" value={day(po.promised_delivery_date ?? po.delivery_date)} />
            <Field
              label="Acknowledged"
              value={po.acknowledged_on ? day(po.acknowledged_on) : 'Not yet'}
              tone={po.acknowledged_on ? 'success' : 'muted'}
            />
          </dl>

          {po.acknowledgement_exceptions ? (
            <div className="mt-4">
              <Notice tone="warning" title="The vendor flagged exceptions">
                {po.acknowledgement_exceptions}
              </Notice>
            </div>
          ) : null}

          {overReceived.length > 0 ? (
            <div className="mt-4">
              <Notice tone="warning" title="More arrived than was ordered">
                {overReceived.length} line{overReceived.length === 1 ? '' : 's'} over-received. The material is on
                site either way — whether to accept the excess is a commercial decision.
              </Notice>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-3 gap-3">
            <Stat label="Lines" value={lines.length} />
            <Stat label="Fully received" value={`${received} / ${lines.length}`} />
            <Stat label="Receipts" value={(grns.data ?? []).length} />
          </div>

          <Section title="Lines">
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Item</TH>
                    <TH align="right">Ordered</TH>
                    <TH align="right">Accepted</TH>
                    <TH align="right">Pending</TH>
                    <TH>Position</TH>
                  </TR>
                </THead>
                <TBody>
                  {lines.map((l) => (
                    <TR key={String(l.id)}>
                      <TD>
                        <span className="text-text">{l.description}</span>
                        <p className="text-2xs text-text-subtle">{money(l.unit_rate)} per {l.unit}</p>
                      </TD>
                      <TD align="right" className="text-text-muted">{Number(l.quantity)}</TD>
                      <TD align="right" className="text-text">{Number(l.receivedQuantity ?? 0)}</TD>
                      <TD align="right" className="text-text-muted">{Number(l.pendingQuantity ?? 0)}</TD>
                      <TD>
                        <Badge tone={financialTone(l.status === 'COMPLETE' ? 'RECEIVED' : l.status === 'OVER_RECEIVED' ? 'MISMATCH' : l.status === 'PARTIAL' ? 'PARTIALLY_RECEIVED' : 'PENDING')} size="sm">
                          {String(l.status ?? '').replaceAll('_', ' ').toLowerCase()}
                        </Badge>
                        {Number(l.rejectedQuantity ?? 0) > 0 ? (
                          <p className="text-2xs text-danger">{Number(l.rejectedQuantity)} rejected</p>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </Section>

          {(grns.data ?? []).length > 0 ? (
            <Section title="Receipts">
              <ul className="space-y-1.5 text-sm">
                {(grns.data ?? []).map((g) => (
                  <li key={String(g.id)} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-text">{g.grn_no}</span>
                    <span className="flex items-center gap-2 text-2xs text-text-subtle">
                      {day(g.received_date)}
                      <StatusBadge status={g.status} />
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {amendments.length > 0 ? (
            <Section title="Amendments">
              <ol className="space-y-2">
                {amendments.map((a) => (
                  <li key={String(a.id)} className="border-l-2 border-border pl-3 text-sm">
                    <p className="text-xs font-medium text-text">
                      Revision {a.revision} · {day(a.created_at)}
                      {a.approval_id ? (
                        <Badge tone="warning" size="sm" className="ml-2">Re-approved</Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-text-muted">{a.reason}</p>
                    <p className="mt-0.5 text-2xs text-text-subtle">
                      {money(a.previous_total)} → {money(a.new_total)}
                    </p>
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          {po.approval_id ? (
            <Section title="Approval">
              <a
                href={`/approvals?open=${po.approval_id}`}
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                Open the ladder →
              </a>
            </Section>
          ) : null}

          {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

          {canManageGrn && ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(String(po.status)) ? (
            <Section title="Receipt">
              <Button variant="secondary" onClick={() => setRecordingGrn(true)}>Record goods receipt</Button>
              <p className="mt-1.5 text-2xs text-text-subtle">
                Received quantity is always summed from GRNs — nothing here keeps a running total on the line.
              </p>
            </Section>
          ) : null}

          {canAmend && !['CLOSED', 'CANCELLED', 'FULLY_RECEIVED'].includes(String(po.status)) ? (
            <Section title="Amend">
              <Button variant="secondary" onClick={() => setAmending(true)}>Amend this order</Button>
              <p className="mt-1.5 text-2xs text-text-subtle">
                Changes quantity, rate or delivery date on an issued order. A change that moves the value
                materially sends it back through approval.
              </p>
            </Section>
          ) : null}

          {canManage ? (
            <Section title="Move to">
              <div className="flex flex-wrap gap-2">
                {po.status === 'DRAFT' ? (
                  <Button loading={submit.isPending} onClick={() => submit.mutate()}>
                    Submit for approval
                  </Button>
                ) : null}
                {(po.allowed_statuses ?? [])
                  .filter((s: string) => s !== 'PENDING_APPROVAL')
                  .map((s: string) => (
                    <Button key={s} variant="secondary" loading={move.isPending} onClick={() => move.mutate(s)}>
                      {s.replaceAll('_', ' ').toLowerCase()}
                    </Button>
                  ))}
              </div>
              <p className="mt-1.5 text-2xs text-text-subtle">
                An order reaches approved only when its ladder says so, never by moving it here.
              </p>
            </Section>
          ) : null}
        </>
      )}

      {recordingGrn && po ? (
        <NewGrn
          purchaseOrderId={id}
          poNumber={po.po_number}
          lines={lines}
          onClose={() => setRecordingGrn(false)}
          onCreated={() => { setRecordingGrn(false); after(); }}
        />
      ) : null}

      {amending && po ? (
        <AmendOrder
          po={po}
          onClose={() => setAmending(false)}
          onDone={() => { setAmending(false); after(); }}
        />
      ) : null}
    </RecordSheet>
  );
}

/* ------------------------------------------------------------------- RFQ */

/**
 * Quote comparison (§43.1).
 *
 * The table ranks on landed cost and shows the workings, because the whole
 * point of the screen is that the cheapest rate is often not the cheapest
 * purchase. Freight, and tax that cannot be recovered, are what move the
 * ranking — so both get their own column rather than being folded into a
 * single total nobody can argue with.
 */
function RfqDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, 'rfq.manage');
  const [error, setError] = React.useState<unknown>(null);
  const [awardTo, setAwardTo] = React.useState('');
  const [reason, setReason] = React.useState('');

  const detail = useQuery({
    queryKey: ['rfq', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/rfqs/${id}`)).data,
  });
  const comparison = useQuery({
    queryKey: ['rfq-comparison', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/rfqs/${id}/comparison`)).data,
  });

  const award = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/rfqs/${id}/award`, {
        method: 'POST', body: { vendor_id: awardTo, reason: reason.trim() },
      }),
    onSuccess: () => {
      setError(null); setReason(''); setAwardTo('');
      void detail.refetch(); void comparison.refetch(); onChanged();
    },
    onError: setError,
  });

  const rfq = detail.data;
  const evaluations: Row[] = comparison.data?.evaluations ?? [];
  const recommended = comparison.data?.recommended ?? null;
  const notQuoted: Row[] = rfq?.awaiting ?? [];

  return (
    <RecordSheet
      open onClose={onClose} wide
      title={rfq?.rfq_no ?? 'RFQ'}
      subtitle={rfq ? `Due ${day(rfq.due_date)}` : undefined}
    >
      {detail.isLoading || !rfq ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Field label="Status" value={<StatusBadge status={rfq.status} size="md" />} />
            <Field label="Due" value={day(rfq.due_date)} />
            <Field label="Quotes in" value={evaluations.length} />
            <Field label="Project" value={rfq.project_code ?? '—'} />
          </dl>

          {rfq.scope ? (
            <div className="mt-3 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-muted">
              {rfq.scope}
            </div>
          ) : null}

          <Section title="Comparison">
            {comparison.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : evaluations.length === 0 ? (
              <p className="text-sm text-text-muted">No quotes received yet.</p>
            ) : (
              <>
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Vendor</TH>
                        <TH align="right">Taxable</TH>
                        <TH align="right">Freight</TH>
                        <TH align="right">Unrecoverable tax</TH>
                        <TH align="right">Landed cost</TH>
                        <TH>Rank</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {evaluations.map((e) => (
                        <TR key={String(e.vendorId)}>
                          <TD>
                            <span className="text-text">{e.vendorName}</span>
                            {e.deliveryDays !== null && e.deliveryDays !== undefined ? (
                              <p className="text-2xs text-text-subtle">{e.deliveryDays} days</p>
                            ) : null}
                          </TD>
                          <TD align="right" className="text-text-muted">{money(e.taxableValue)}</TD>
                          <TD align="right" className="text-text-muted">{money(e.freight)}</TD>
                          <TD align="right" className={Number(e.irrecoverableTax) > 0 ? 'text-warning' : 'text-text-subtle'}>
                            {Number(e.irrecoverableTax) > 0 ? money(e.irrecoverableTax) : '—'}
                          </TD>
                          <TD align="right" className="font-medium text-text">{money(e.landedCost)}</TD>
                          <TD>
                            {!e.technicallyQualified ? (
                              <Badge tone="neutral" size="sm">Not qualified</Badge>
                            ) : e.rank === 1 ? (
                              <Badge tone="success" size="sm">L1</Badge>
                            ) : (
                              <span className="text-2xs text-text-subtle">L{e.rank}</span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>

                <p className="mt-2 text-2xs text-text-subtle">
                  Ranked on what the purchase actually costs — freight included, recoverable tax excluded.
                  A vendor quoting a lower rate can still be dearer delivered.
                </p>

                {evaluations.some((e) => !e.technicallyQualified) ? (
                  <div className="mt-3">
                    <Notice tone="info" title="Unqualified quotes are shown but never ranked">
                      The sheet has to record what every invited vendor offered, but L1 is always somebody
                      who could actually do the work.
                    </Notice>
                  </div>
                ) : null}
              </>
            )}
          </Section>

          {notQuoted.length > 0 ? (
            <Section title="Yet to quote">
              <p className="text-sm text-text-muted">
                {notQuoted.map((v: Row) => v.vendor_name).filter(Boolean).join(', ')}
              </p>
            </Section>
          ) : null}

          {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

          {canManage && rfq.status !== 'AWARDED' && evaluations.length > 0 ? (
            <Section title="Award">
              <div className="grid gap-2 sm:grid-cols-2">
                <select value={awardTo} onChange={(e) => setAwardTo(e.target.value)}>
                  <option value="">Choose the vendor</option>
                  {evaluations.filter((e) => e.technicallyQualified).map((e) => (
                    <option key={String(e.vendorId)} value={String(e.vendorId)}>
                      {e.vendorName} — {money(e.landedCost)}{e.rank === 1 ? ' (L1)' : ''}
                    </option>
                  ))}
                </select>
                <input
                  placeholder="Justification"
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Button
                  loading={award.isPending}
                  disabled={!awardTo || !reason.trim()}
                  onClick={() => award.mutate()}
                >
                  Award
                </Button>
                {awardTo && recommended && String(recommended.vendorId) !== awardTo ? (
                  <p className="text-2xs text-warning">
                    Not the lowest landed cost — the justification will be kept with the award.
                  </p>
                ) : (
                  <p className="text-2xs text-text-subtle">
                    Every award carries a reason, L1 included.
                  </p>
                )}
              </div>
            </Section>
          ) : null}
        </>
      )}
    </RecordSheet>
  );
}


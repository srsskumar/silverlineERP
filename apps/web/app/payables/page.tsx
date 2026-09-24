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
import { Notice, Section, Stat } from '@/components/finance/Primitives';
import { AgeingBar, AgeingBuckets, BucketCells, OutsideBuckets } from '@/components/finance/Ageing';
import { day, money, businessToday, payableFlagTone } from '@/lib/finance';
import { AGEING_BUCKETS, BUCKET_LABELS, msmeNote, type AgeingSummary } from '@/lib/ledgers';
import { ExecutePaymentRunForm } from '@/components/payables/ExecutePaymentRunForm';
import { VendorInvoiceLines } from '@/components/procurement/VendorInvoiceLines';

type Row = Record<string, any>;

/**
 * Payables (section 58.3).
 *
 * Two things make this different from a plain bill register. The first is that
 * a supplier registered under the MSMED Act has a statutory due date that
 * overrides whatever the purchase order said — 45 days with a written
 * agreement, 15 without — and interest runs from it automatically. The second
 * is that ageing on the contractual date alone hides exactly that: an MSME
 * invoice at 40 days looks comfortable inside a 60-day bucket while it is in
 * fact days from accruing non-deductible interest.
 *
 * So the ageing here is on the effective due date, and the statutory position
 * is stated on the page rather than left to be worked out.
 */
export default function PayablesPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canRead = hasPermission(perms, 'ap.read');
  const canHold = hasPermission(perms, 'payable.hold');
  const canReadInvoice = hasPermission(perms, 'invoice.read');
  const [tab, setTab] = React.useState<'ageing' | 'runs'>('ageing');
  const [asOf, setAsOf] = React.useState(() => businessToday());
  const [openVendor, setOpenVendor] = React.useState<string | null>(null);
  const [managingInvoice, setManagingInvoice] = React.useState<string | null>(null);
  const qc = useQueryClient();

  const ageing = useQuery({
    queryKey: ['ap-ageing', asOf],
    enabled: canRead && tab === 'ageing',
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/ap/ageing?as_of=${asOf}`)).body as { data: Row }).data,
  });

  const hold = useMutation({
    mutationFn: async (v: { id: string; on_hold: boolean; reason?: string }) =>
      apiRequest(`/api/v1/ap/invoices/${v.id}/hold`, {
        method: 'POST',
        body: { on_hold: v.on_hold, reason: v.reason },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ap-ageing'] }),
  });

  if (!canRead) {
    return (
      <AppShell>
        <PageHeader title="Payables" />
        <PageBody>
          <Notice tone="info" title="You do not have access to payables">
            This screen needs the <code>ap.read</code> permission. An administrator can grant it
            from Security &rarr; Roles.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  const data = ageing.data;
  const summary = data as AgeingSummary | undefined;
  const vendors: Row[] = data?.vendors ?? [];

  return (
    <AppShell>
      <PageHeader
        title="Payables"
        description="What is owed to suppliers, aged on the date each invoice actually falls due."
      />
      <PageBody>
        <Toolbar>
          <div className="flex gap-1">
            {(['ageing', 'runs'] as const).map((t) => (
              <Button
                key={t}
                type="button"
                variant={tab === t ? 'secondary' : 'ghost'}
                onClick={() => setTab(t)}
              >
                {t === 'ageing' ? 'Ageing' : 'Payment runs'}
              </Button>
            ))}
          </div>
          {tab === 'ageing' ? (
            <label className="flex items-center gap-2 text-xs text-text-muted">
              As at
              <input
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
              />
            </label>
          ) : null}
        </Toolbar>

        {tab === 'runs' ? <PaymentRuns perms={perms} /> : null}

        {tab === 'ageing' ? (
          <>
            {ageing.isLoading ? <Skeleton className="h-64" /> : null}
            {ageing.isError ? <ErrorCard error={ageing.error} onRetry={() => ageing.refetch()} /> : null}

            {data && summary ? (
              <div className="space-y-4">
                <Card className="space-y-3 p-4">
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Stat
                      label="Total owed"
                      value={money(summary.total)}
                      hint={`${vendors.length} supplier${vendors.length === 1 ? '' : 's'}`}
                    />
                    <Stat
                      label="Overdue"
                      value={money(summary.overdue)}
                      tone={summary.overdue > 0.005 ? 'danger' : 'success'}
                    />
                    <Stat
                      label="Owed to MSME suppliers"
                      value={money(data.msme_outstanding)}
                      hint="Statutory due dates apply"
                    />
                    <Stat
                      label="MSME interest accrued"
                      value={money(data.msme_accrued_interest)}
                      tone={data.msme_accrued_interest > 0.005 ? 'danger' : 'default'}
                      hint="Section 16. Not tax-deductible."
                    />
                  </div>

                  <AgeingBar summary={summary} />
                  <AgeingBuckets summary={summary} />
                  <OutsideBuckets summary={summary} />
                </Card>

                <Notice
                  tone={data.msme_accrued_interest > 0.005 ? 'danger' : 'info'}
                  title="MSMED Act position"
                >
                  {msmeNote(data.msme_outstanding, data.msme_accrued_interest)}
                </Notice>

                <Section title="By supplier">
                  {vendors.length === 0 ? (
                    <EmptyState
                      title="Nothing owed"
                      description="Every supplier invoice has been settled as at this date."
                    />
                  ) : (
                    <TableWrap>
                      <Table>
                        <THead>
                          <TR>
                            <TH>Supplier</TH>
                            {AGEING_BUCKETS.map((b) => (
                              <TH key={b} className="text-right">{BUCKET_LABELS[b]}</TH>
                            ))}
                            <TH className="text-right">Overdue</TH>
                            <TH className="text-right">Interest</TH>
                            <TH className="text-right">Total</TH>
                            <TH />
                          </TR>
                        </THead>
                        <TBody>
                          {vendors.map((v) => {
                            const id = String(v.vendor_id ?? 'UNASSIGNED');
                            const open = openVendor === id;
                            return (
                              <React.Fragment key={id}>
                                <TR>
                                  <TD className="font-medium text-text">{v.vendor_name}</TD>
                                  <BucketCells summary={v as AgeingSummary} />
                                  <TD className="text-right tabular-nums">
                                    <span className={v.overdue > 0.005 ? 'font-semibold text-danger' : 'text-text-subtle'}>
                                      {money(v.overdue)}
                                    </span>
                                  </TD>
                                  <TD className="text-right tabular-nums">
                                    {v.accrued_interest > 0.005 ? (
                                      <span className="font-semibold text-danger">{money(v.accrued_interest)}</span>
                                    ) : <span className="text-text-subtle">—</span>}
                                  </TD>
                                  <TD className="text-right font-semibold tabular-nums">{money(v.total)}</TD>
                                  <TD className="text-right">
                                    <Button type="button" variant="ghost" onClick={() => setOpenVendor(open ? null : id)}>
                                      {open ? 'Hide' : `${v.invoices.length} invoice${v.invoices.length === 1 ? '' : 's'}`}
                                    </Button>
                                  </TD>
                                </TR>
                                {open ? (
                                  <TR>
                                    <TD colSpan={AGEING_BUCKETS.length + 5} className="bg-surface-sunken p-0">
                                      <InvoiceDetail
                                        invoices={v.invoices}
                                        canHold={canHold}
                                        canManageInvoice={canReadInvoice}
                                        onHold={(id, on_hold, reason) => hold.mutate({ id, on_hold, reason })}
                                        onManageInvoice={setManagingInvoice}
                                        pending={hold.isPending}
                                      />
                                    </TD>
                                  </TR>
                                ) : null}
                              </React.Fragment>
                            );
                          })}
                        </TBody>
                      </Table>
                    </TableWrap>
                  )}
                </Section>
              </div>
            ) : null}
          </>
        ) : null}
      </PageBody>

      {managingInvoice ? (
        <VendorInvoiceLines invoiceId={managingInvoice} onClose={() => setManagingInvoice(null)} />
      ) : null}
    </AppShell>
  );
}

/**
 * One supplier's invoices.
 *
 * Both due dates are shown side by side wherever they differ, because the
 * whole point is that the one in the contract is not always the one that
 * governs. A row where the statutory date is earlier is the row somebody
 * needs to look at.
 */
function InvoiceDetail({
  invoices, canHold, canManageInvoice, onHold, onManageInvoice, pending,
}: {
  invoices: Row[];
  canHold: boolean;
  canManageInvoice: boolean;
  onHold: (id: string, onHold: boolean, reason?: string) => void;
  onManageInvoice: (id: string) => void;
  pending: boolean;
}) {
  return (
    <div className="p-3">
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Invoice</TH>
              <TH>Contract due</TH>
              <TH>Statutory due</TH>
              <TH className="text-right">Overdue by</TH>
              <TH className="text-right">Outstanding</TH>
              <TH className="text-right">Interest</TH>
              <TH>State</TH>
              {canHold || canManageInvoice ? <TH /> : null}
            </TR>
          </THead>
          <TBody>
            {invoices.map((i) => (
              <TR key={String(i.invoice_id)}>
                <TD mono>{i.serial_number}</TD>
                <TD>{day(i.contractual_due_date)}</TD>
                <TD>
                  {i.is_msme ? (
                    <span className={i.statutory_due_date < i.contractual_due_date ? 'font-semibold text-warning' : ''}>
                      {day(i.statutory_due_date)}
                    </span>
                  ) : <span className="text-text-subtle">Not MSME</span>}
                </TD>
                <TD className="text-right tabular-nums">
                  {i.days_overdue > 0
                    ? <span className="font-semibold text-danger">{i.days_overdue} days</span>
                    : <span className="text-text-subtle">—</span>}
                </TD>
                <TD className="text-right font-semibold tabular-nums">{money(i.outstanding)}</TD>
                <TD className="text-right tabular-nums">
                  {i.accrued_interest > 0.005
                    ? <span className="text-danger">{money(i.accrued_interest)}</span>
                    : <span className="text-text-subtle">—</span>}
                </TD>
                <TD className="space-x-1">
                  {i.is_msme ? <Badge tone="info">MSME</Badge> : null}
                  {i.disputed ? <Badge tone={payableFlagTone('disputed')}>Disputed</Badge> : null}
                  {i.on_hold ? <Badge tone={payableFlagTone('on_hold')}>On hold</Badge> : null}
                  {i.match_status && i.match_status !== 'MATCHED' && i.match_status !== 'OVERRIDDEN' ? (
                    <Badge tone="warning">{String(i.match_status).toLowerCase()}</Badge>
                  ) : null}
                </TD>
                {canHold || canManageInvoice ? (
                  <TD className="space-x-1 text-right">
                    {canManageInvoice ? (
                      <Button type="button" variant="ghost" onClick={() => onManageInvoice(String(i.invoice_id))}>
                        Lines &amp; match
                      </Button>
                    ) : null}
                    {canHold ? <HoldButton invoice={i} onHold={onHold} pending={pending} /> : null}
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
      <p className="mt-2 text-2xs text-text-subtle">
        A hold keeps an invoice out of payment runs. It does not stop statutory interest, which
        accrues on an MSME invoice regardless of any internal decision to withhold payment.
      </p>
    </div>
  );
}

function HoldButton({
  invoice, onHold, pending,
}: {
  invoice: Row;
  onHold: (id: string, onHold: boolean, reason?: string) => void;
  pending: boolean;
}) {
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState('');

  if (invoice.on_hold) {
    return (
      <div className="text-right">
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => onHold(String(invoice.invoice_id), false)}
        >
          Release
        </Button>
        {invoice.hold_reason ? (
          <p className="text-2xs text-text-subtle">{invoice.hold_reason}</p>
        ) : null}
      </div>
    );
  }

  if (!asking) {
    return (
      <Button type="button" variant="ghost" onClick={() => setAsking(true)}>Hold</Button>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {/* A hold with no stated reason is indistinguishable from an oversight
          when somebody looks at it three weeks later. */}
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is it being held?"
        className="w-44 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
      />
      <Button
        type="button"
        variant="secondary"
        disabled={pending || reason.trim().length < 3}
        onClick={() => { onHold(String(invoice.invoice_id), true, reason.trim()); setAsking(false); setReason(''); }}
      >
        Hold
      </Button>
      <Button type="button" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
    </div>
  );
}

/**
 * Payment runs (section 58.3.4).
 *
 * A run is built by one person and released by another. The API refuses
 * self-approval outright, so the screen says so up front rather than letting
 * somebody build a batch and discover at the release step that they cannot
 * finish it.
 */
function PaymentRuns({ perms }: { perms: { permissions?: string[] } }) {
  const qc = useQueryClient();
  const canManage = hasPermission(perms, 'paymentrun.manage');
  const canApprove = hasPermission(perms, 'paymentrun.approve');
  const [open, setOpen] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [executing, setExecuting] = React.useState<Row | null>(null);

  const runs = useQuery({
    queryKey: ['payment-runs'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/payment-runs?limit=50')).body as { data: Row[] }).data,
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; version: number; action: 'APPROVE' | 'CANCEL'; reason?: string }) =>
      apiRequest(`/api/v1/payment-runs/${v.id}/decision`, {
        method: 'POST',
        headers: { 'If-Match': String(v.version) },
        body: { action: v.action, reason: v.reason },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payment-runs'] }),
  });

  return (
    <div className="space-y-4">
      {canManage ? (
        <div>
          <Button type="button" variant="primary" onClick={() => setCreating((c) => !c)}>
            {creating ? 'Cancel' : 'Build a run'}
          </Button>
          {creating ? <RunForm onDone={() => { setCreating(false); runs.refetch(); }} /> : null}
        </div>
      ) : null}

      {runs.isLoading ? <Skeleton className="h-40" /> : null}
      {runs.isError ? <ErrorCard error={runs.error} onRetry={() => runs.refetch()} /> : null}

      {runs.data?.length === 0 ? (
        <EmptyState
          title="No payment runs yet"
          description="A run gathers everything due through a date, skipping anything disputed, on hold, or that has not passed its three-way match."
        />
      ) : null}

      {runs.data?.length ? (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Run</TH>
                <TH>Date</TH>
                <TH>Due through</TH>
                <TH className="text-right">Lines</TH>
                <TH className="text-right">Amount</TH>
                <TH>Status</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {runs.data.map((r) => (
                <React.Fragment key={String(r.id)}>
                  <TR>
                    <TD mono>{r.run_no}</TD>
                    <TD>{day(r.run_date)}</TD>
                    <TD>{day(r.due_through)}</TD>
                    <TD className="text-right tabular-nums">{r.line_count}</TD>
                    <TD className="text-right font-semibold tabular-nums">{money(r.total_amount)}</TD>
                    <TD>
                      <Badge tone={
                        r.status === 'PAID' ? 'success'
                          : r.status === 'APPROVED' ? 'success'
                            : r.status === 'CANCELLED' ? 'neutral' : 'warning'
                      }>
                        {String(r.status).toLowerCase()}
                      </Badge>
                      {r.approved_by_username ? (
                        <span className="ml-1 text-2xs text-text-subtle">by {r.approved_by_username}</span>
                      ) : null}
                      {r.status === 'PAID' ? (
                        <div className="mt-0.5 text-2xs text-text-subtle">
                          {day(r.paid_on)} &middot; ref {r.bank_reference}
                        </div>
                      ) : null}
                    </TD>
                    <TD className="space-x-1 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setOpen(open === String(r.id) ? null : String(r.id))}
                      >
                        {open === String(r.id) ? 'Hide' : 'Lines'}
                      </Button>
                      {canApprove && r.status === 'DRAFT' ? (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: String(r.id), version: r.version, action: 'APPROVE' })}
                        >
                          Release
                        </Button>
                      ) : null}
                      {canApprove && r.status === 'APPROVED' ? (
                        <Button type="button" variant="secondary" onClick={() => setExecuting(r)}>
                          Execute payment
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                  {open === String(r.id) ? (
                    <TR>
                      <TD colSpan={7} className="bg-surface-sunken p-0">
                        <RunLines id={String(r.id)} />
                      </TD>
                    </TR>
                  ) : null}
                </React.Fragment>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      ) : null}

      {decide.isError ? <ErrorCard error={decide.error} /> : null}

      {canManage && !canApprove ? (
        <Notice tone="info" title="You can build a run but not release it">
          Releasing needs <code>paymentrun.approve</code>, and in any case the person who built a
          run cannot release it. Somebody else has to look at the batch before the money leaves.
        </Notice>
      ) : null}

      {executing ? (
        <ExecutePaymentRunForm
          runId={String(executing.id)}
          version={Number(executing.version)}
          onClose={() => setExecuting(null)}
          onDone={() => { setExecuting(null); void qc.invalidateQueries({ queryKey: ['payment-runs'] }); }}
        />
      ) : null}
    </div>
  );
}

function RunLines({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['payment-run', id],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/payment-runs/${id}`)).body as { data: Row }).data,
  });
  if (q.isLoading) return <Skeleton className="m-3 h-24" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const lines: Row[] = q.data?.lines ?? [];
  return (
    <div className="p-3">
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Supplier</TH>
              <TH>Invoice</TH>
              <TH>Due</TH>
              <TH className="text-right">Amount</TH>
              <TH className="text-right">Interest</TH>
            </TR>
          </THead>
          <TBody>
            {lines.map((l) => (
              <TR key={String(l.id)}>
                <TD>{l.vendor_name}</TD>
                <TD mono>{l.serial_number}</TD>
                <TD>
                  {day(l.statutory_due_date ?? l.contractual_due_date)}
                  {l.is_msme ? <Badge tone="info" className="ml-1">MSME</Badge> : null}
                </TD>
                <TD className="text-right font-semibold tabular-nums">{money(l.amount)}</TD>
                <TD className="text-right tabular-nums">
                  {Number(l.accrued_interest) > 0.005 ? money(l.accrued_interest) : '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
      <p className="mt-2 text-2xs text-text-subtle">
        Statutory obligations are listed first. They accrue interest; paying a non-MSME supplier
        late costs goodwill and nothing else.
      </p>
    </div>
  );
}

/** Building a run: a date to pay through, and what to include. */
function RunForm({ onDone }: { onDone: () => void }) {
  const today = businessToday();
  const [form, setForm] = React.useState({
    run_no: '', run_date: today, due_through: today,
    bank_account: '', notes: '', include_not_yet_due: false,
  });
  const [excluded, setExcluded] = React.useState<Row[] | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      apiRequest('/api/v1/payment-runs', {
        method: 'POST',
        body: {
          run_no: form.run_no,
          run_date: form.run_date,
          due_through: form.due_through,
          bank_account: form.bank_account || undefined,
          notes: form.notes || undefined,
          include_not_yet_due: form.include_not_yet_due,
        },
      }),
    onSuccess: (res: any) => { setExcluded(res?.data?.excluded ?? []); onDone(); },
  });

  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <Card className="mt-3 space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Run number</span>
          <input
            className={field}
            value={form.run_no}
            onChange={(e) => setForm({ ...form, run_no: e.target.value })}
            placeholder="PR-2026-09-01"
          />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Run date</span>
          <input type="date" className={field} value={form.run_date}
            onChange={(e) => setForm({ ...form, run_date: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Pay everything due through</span>
          <input type="date" className={field} value={form.due_through}
            onChange={(e) => setForm({ ...form, due_through: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Bank account</span>
          <input className={field} value={form.bank_account}
            onChange={(e) => setForm({ ...form, bank_account: e.target.value })} />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Notes</span>
          <input className={field} value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-text-muted">
        <input
          type="checkbox"
          checked={form.include_not_yet_due}
          onChange={(e) => setForm({ ...form, include_not_yet_due: e.target.checked })}
        />
        Include invoices that are not yet due
      </label>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          loading={create.isPending}
          disabled={!form.run_no.trim()}
          onClick={() => create.mutate()}
        >
          Build the run
        </Button>
      </div>

      {create.isError ? <ErrorCard error={create.error} /> : null}

      {excluded?.length ? (
        <Notice tone="warning" title={`${excluded.length} invoice${excluded.length === 1 ? ' was' : 's were'} left out`}>
          {/* Silently dropping these is how a supplier goes unpaid for a month
              with nobody able to say why. */}
          <ul className="ml-4 list-disc">
            {excluded.map((e, i) => (
              <li key={i}>{e.documentId}: {e.reason}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </Card>
  );
}

'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';
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
import { day, money, percent, businessToday } from '@/lib/finance';
import { AGEING_BUCKETS, BUCKET_LABELS, dsoNote, type AgeingSummary } from '@/lib/ledgers';

type Row = Record<string, any>;

/**
 * Receivables (section 58.2).
 *
 * The question this screen answers is "who owes us, and how late is it" — in
 * that order, because a collections call is made to a client, not to an
 * invoice. The bill-level detail is one click down for when the client asks
 * which one.
 *
 * Retention sits outside the buckets throughout. It is money the client holds
 * by agreement until defects liability ends; ageing it turns every completed
 * project into a fictional overdue balance and buries the real ones.
 */
export default function ReceivablesPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canRead = hasPermission(perms, 'ar.read');

  const [asOf, setAsOf] = React.useState(() => businessToday());
  const [periodDays, setPeriodDays] = React.useState(90);
  const [openClient, setOpenClient] = React.useState<string | null>(null);

  const ageing = useQuery({
    queryKey: ['ar-ageing', asOf, periodDays],
    enabled: canRead,
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/ar/ageing?as_of=${asOf}&period_days=${periodDays}`,
      )).body as { data: Row }).data,
  });

  if (!canRead) {
    return (
      <AppShell>
        <PageHeader title="Receivables" />
        <PageBody>
          <Notice tone="info" title="You do not have access to receivables">
            This screen needs the <code>ar.read</code> permission. An administrator can grant it
            from Security &rarr; Roles.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  const data = ageing.data;
  const summary = data as AgeingSummary | undefined;
  const clients: Row[] = data?.clients ?? [];
  const breached = clients.filter((c) => c.credit?.breached);

  return (
    <AppShell>
      <PageHeader
        title="Receivables"
        description="What clients owe, aged from the date each bill fell due."
      />
      <PageBody>
        <Toolbar>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            As at
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            DSO window
            <select
              value={periodDays}
              onChange={(e) => setPeriodDays(Number(e.target.value))}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>365 days</option>
            </select>
          </label>
        </Toolbar>

        {ageing.isLoading ? <Skeleton className="h-64" /> : null}
        {ageing.isError ? <ErrorCard error={ageing.error} onRetry={() => ageing.refetch()} /> : null}

        {data && summary ? (
          <div className="space-y-4">
            <Card className="space-y-3 p-4">
              <div className="grid gap-2 sm:grid-cols-4">
                <Stat
                  label="Total outstanding"
                  value={money(summary.total)}
                  hint={`${clients.length} client${clients.length === 1 ? '' : 's'}`}
                />
                <Stat
                  label="Overdue"
                  value={money(summary.overdue)}
                  tone={summary.overdue > 0.005 ? 'danger' : 'success'}
                  hint={
                    summary.total > 0.005
                      ? `${percent((summary.overdue / summary.total) * 100)} of the book`
                      : undefined
                  }
                />
                <Stat
                  label="Retention held"
                  value={money(summary.retention)}
                  hint="Not overdue. Released on defects liability."
                />
                <Stat
                  label="Days sales outstanding"
                  value={data.dso === null ? '—' : `${Math.round(data.dso)} days`}
                  // The request takes period_days and the response returns
                  // periodDays -- it comes straight out of the shared
                  // calculation, which is camelCase throughout. Reading the
                  // snake_case spelling here renders "over undefined days".
                  hint={`over ${data.periodDays} days`}
                />
              </div>

              <AgeingBar summary={summary} />
              <AgeingBuckets summary={summary} />
              <p className="text-2xs text-text-subtle">{dsoNote(data.dso, data.periodDays)}</p>
              <OutsideBuckets summary={summary} />
            </Card>

            {breached.length ? (
              <Notice tone="danger" title={`${breached.length} client${breached.length === 1 ? ' is' : 's are'} over their credit limit`}>
                {breached.map((c) => (
                  <p key={String(c.client_id)}>
                    {c.client_name}: {money(c.credit.exposure)} against a limit of{' '}
                    {money(c.credit.limit)} — {money(Math.abs(c.credit.headroom))} over.
                  </p>
                ))}
                <p className="mt-1">
                  Further work for these clients should be authorised deliberately, not by default.
                </p>
              </Notice>
            ) : null}

            <Section title="By client">
              {clients.length === 0 ? (
                <EmptyState
                  title="Nothing outstanding"
                  description="Every certified bill has been settled as at this date."
                />
              ) : (
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Client</TH>
                        {AGEING_BUCKETS.map((b) => (
                          <TH key={b} className="text-right">{BUCKET_LABELS[b]}</TH>
                        ))}
                        <TH className="text-right">Overdue</TH>
                        <TH className="text-right">Total</TH>
                        <TH className="text-right">Credit</TH>
                        <TH />
                      </TR>
                    </THead>
                    <TBody>
                      {clients.map((c) => {
                        const id = String(c.client_id ?? 'UNASSIGNED');
                        const open = openClient === id;
                        return (
                          <React.Fragment key={id}>
                            <TR>
                              <TD>
                                <span className="font-medium text-text">{c.client_name}</span>
                                {c.retention > 0.005 ? (
                                  <span className="ml-2 text-2xs text-text-subtle">
                                    incl. {money(c.retention)} retention
                                  </span>
                                ) : null}
                              </TD>
                              <BucketCells summary={c as AgeingSummary} />
                              <TD className="text-right tabular-nums">
                                <span className={c.overdue > 0.005 ? 'font-semibold text-danger' : 'text-text-subtle'}>
                                  {money(c.overdue)}
                                </span>
                              </TD>
                              <TD className="text-right font-semibold tabular-nums">{money(c.total)}</TD>
                              <TD className="text-right">
                                {c.credit?.limit === null ? (
                                  <span className="text-2xs text-text-subtle">No limit set</span>
                                ) : (
                                  <Badge tone={c.credit.breached ? 'danger' : c.credit.utilisationPct > 80 ? 'warning' : 'neutral'}>
                                    {percent(c.credit.utilisationPct)} of {money(c.credit.limit)}
                                  </Badge>
                                )}
                              </TD>
                              <TD className="text-right">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  onClick={() => setOpenClient(open ? null : id)}
                                >
                                  {open ? 'Hide bills' : `${c.bills.length} bill${c.bills.length === 1 ? '' : 's'}`}
                                </Button>
                              </TD>
                            </TR>
                            {open ? (
                              <TR>
                                <TD colSpan={AGEING_BUCKETS.length + 5} className="bg-surface-sunken p-0">
                                  <BillDetail bills={c.bills} clientId={c.client_id} asOf={asOf} />
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
      </PageBody>
    </AppShell>
  );
}

/** One client's bills, plus the statement they would be sent. */
function BillDetail({ bills, clientId, asOf }: { bills: Row[]; clientId: string | null; asOf: string }) {
  const [statement, setStatement] = React.useState(false);
  return (
    <div className="space-y-3 p-3">
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Bill</TH>
              <TH>Project</TH>
              <TH>Certified</TH>
              <TH>Due</TH>
              <TH className="text-right">Billed</TH>
              <TH className="text-right">Settled</TH>
              <TH className="text-right">Outstanding</TH>
            </TR>
          </THead>
          <TBody>
            {bills.map((b) => (
              <TR key={String(b.bill_id)}>
                <TD mono>{b.bill_no}</TD>
                <TD>
                  <span className="text-text">{b.project_name}</span>
                  <span className="ml-1 text-2xs text-text-subtle">{b.project_code}</span>
                </TD>
                <TD>{day(b.certified_at)}</TD>
                <TD>{day(b.due_date)}</TD>
                <TD className="text-right tabular-nums">{money(b.billed)}</TD>
                <TD className="text-right tabular-nums">{money(b.settled)}</TD>
                <TD className="text-right font-semibold tabular-nums">{money(b.outstanding)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>

      {clientId ? (
        <div>
          <Button type="button" variant="secondary" onClick={() => setStatement((s) => !s)}>
            {statement ? 'Hide statement' : 'Statement of account'}
          </Button>
          {statement ? <Statement clientId={clientId} to={asOf} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The statement of account, which is what actually gets sent to a client.
 *
 * It opens with the balance brought forward. Without that the statement does
 * not reconcile to the ledger, and reconciling is the entire reason it is
 * sent.
 */
function Statement({ clientId, to }: { clientId: string; to: string }) {
  const q = useQuery({
    queryKey: ['ar-statement', clientId, to],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/ar/statement/${clientId}?to=${to}`)).body as { data: Row }).data,
  });

  if (q.isLoading) return <Skeleton className="mt-3 h-40" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  if (!d) return null;

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-text">{d.client_name ?? 'Statement'}</p>
        <p className="text-2xs text-text-subtle">to {day(d.to)}</p>
      </div>
      <TableWrap className="mt-2">
        <Table>
          <THead>
            <TR>
              <TH>Date</TH>
              <TH>Particulars</TH>
              <TH className="text-right">Debit</TH>
              <TH className="text-right">Credit</TH>
              <TH className="text-right">Balance</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD />
              <TD tone="muted" className="italic">Balance brought forward</TD>
              <TD />
              <TD />
              <TD className="text-right font-semibold tabular-nums">{money(d.opening)}</TD>
            </TR>
            {(d.entries ?? []).map((e: Row, i: number) => (
              <TR key={`${e.id}-${i}`}>
                <TD>{day(e.on_date)}</TD>
                <TD>
                  {e.kind === 'BILL'
                    ? `RA bill ${e.bill_no}${e.project_code ? ` (${e.project_code})` : ''}`
                    : `Receipt ${e.payment_no}${e.mode ? ` by ${e.mode}` : ''}${e.reference ? ` — ${e.reference}` : ''}`}
                </TD>
                <TD className="text-right tabular-nums">{e.debit > 0 ? money(e.debit) : '—'}</TD>
                <TD className="text-right tabular-nums">{e.credit > 0 ? money(e.credit) : '—'}</TD>
                <TD className="text-right tabular-nums">{money(e.balance)}</TD>
              </TR>
            ))}
            <TR>
              <TD />
              <TD className="font-semibold text-text">Balance carried forward</TD>
              <TD />
              <TD />
              <TD className="text-right font-semibold tabular-nums">{money(d.closing)}</TD>
            </TR>
          </TBody>
        </Table>
      </TableWrap>
    </div>
  );
}

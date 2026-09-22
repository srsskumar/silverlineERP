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
import { day, money, moneyIndian, percent, utilisationWidth } from '@/lib/finance';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { RequireDestination } from '@/components/RequirePermission';

type Row = Record<string, any>;
type Tab = 'bills' | 'boq' | 'measured' | 'retention' | 'cost';

const DEDUCTION_LABELS: Record<string, string> = {
  RETENTION: 'Retention',
  SECURITY_DEPOSIT: 'Security deposit',
  LABOUR_CESS: 'Labour cess',
  TDS_INCOME_TAX: 'TDS (income tax)',
  TDS_GST: 'TDS (GST)',
  MOBILISATION_ADVANCE: 'Mobilisation advance',
  MATERIAL_ADVANCE: 'Material advance',
  LIQUIDATED_DAMAGES: 'Liquidated damages',
  PENALTY: 'Penalty',
  OTHER: 'Other',
};

/**
 * Project finance (§15).
 *
 * Everything about one project's money in one place: what has been billed,
 * what is being held back, what the job is costing, and whether it is still
 * making anything. Splitting these across separate screens is how a site ends
 * up with a healthy-looking bill register and an overrun nobody spotted.
 */
export default function BillingPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const [projectId, setProjectId] = React.useState('');
  const [tab, setTab] = React.useState<Tab>('bills');
  const [selectedBill, setSelectedBill] = React.useState<string | null>(null);

  const projects = useQuery({
    queryKey: ['projects', 'for-billing'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  React.useEffect(() => {
    const open = new URLSearchParams(window.location.search).get('open');
    if (open) setSelectedBill(open);
  }, []);

  React.useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(String(projects.data[0].id));
  }, [projects.data, projectId]);

  const tabs: { key: Tab; label: string; permission: string }[] = [
    { key: 'bills', label: 'RA bills', permission: 'rabill.read' },
    { key: 'boq', label: 'BOQ', permission: 'boq.read' },
    { key: 'measured', label: 'From the field', permission: 'rabill.read' },
    { key: 'retention', label: 'Retention', permission: 'retention.read' },
    { key: 'cost', label: 'Budget vs actual', permission: 'cost.read' },
  ];
  const visible = tabs.filter((t) => hasPermission(perms, t.permission));

  return (
    <AppShell>
      <PageHeader
        title="Project finance"
        description="Billed, withheld, spent — and whether the job is still making anything."
      />

      <PageBody>
        <RequireDestination href="/billing">
        <Toolbar>
          <select
            aria-label="Project"
            className="max-w-80"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {(projects.data ?? []).map((p) => (
              <option key={String(p.id)} value={String(p.id)}>{p.code} — {p.name}</option>
            ))}
          </select>

          <div className="flex rounded-md border border-border bg-surface p-0.5">
            {visible.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  tab === t.key ? 'bg-primary text-primary-fg' : 'text-text-muted hover:text-text'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Toolbar>

        {!projectId ? (
          <EmptyState title="Choose a project" description="Financial records are held per project." />
        ) : tab === 'bills' ? (
          <RaBills projectId={projectId} onOpen={setSelectedBill} />
        ) : tab === 'boq' ? (
          <Boq projectId={projectId} />
        ) : tab === 'measured' ? (
          <MeasuredProposal projectId={projectId} />
        ) : tab === 'retention' ? (
          <Retention projectId={projectId} />
        ) : (
          <CostPosition projectId={projectId} />
        )}
        </RequireDestination>
      </PageBody>

      {selectedBill ? (
        <BillDetail id={selectedBill} onClose={() => setSelectedBill(null)} />
      ) : null}
    </AppShell>
  );
}

/* ------------------------------------------------------------- RA bills */

function RaBills({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const bills = useQuery({
    queryKey: ['ra-bills', projectId],
    queryFn: async () => (await apiRequest<Row[]>(`/api/v1/projects/${projectId}/ra-bills`)).data,
    staleTime: 20_000,
  });

  const rows = bills.data ?? [];
  const certified = rows.filter((b) => ['CERTIFIED', 'PAID'].includes(String(b.status)));
  const billed = certified.reduce((t, b) => t + Number(b.certified_amount ?? b.gross_value), 0);
  const withheld = certified.reduce((t, b) => t + Number(b.total_deductions ?? 0), 0);
  const paid = rows.filter((b) => b.status === 'PAID').reduce((t, b) => t + Number(b.net_payable), 0);

  if (bills.isLoading) return <Skeleton className="h-64 w-full" />;
  if (bills.error) return <ErrorCard error={bills.error} onRetry={() => void bills.refetch()} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No bills"
        description="A running-account bill states the cumulative measurement; the increment is derived from the last one."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Bills" value={rows.length} />
        <Stat label="Certified" value={money(billed)} />
        <Stat label="Deducted" value={money(withheld)} hint="Retention, cess, TDS and advances" />
        <Stat
          label="Received"
          value={money(paid)}
          hint={billed - paid > 0 ? `${money(billed - paid)} outstanding` : 'Fully received'}
          tone={billed - paid > 0 ? 'warning' : 'success'}
        />
      </div>

      <Card>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Bill</TH>
                <TH>Period</TH>
                <TH align="right">Cumulative</TH>
                <TH align="right">This bill</TH>
                <TH align="right">Deductions</TH>
                <TH align="right">Net payable</TH>
                <TH>Status</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((b) => (
                <TR key={String(b.id)}>
                  <TD>
                    <span className="font-medium text-text">
                      {b.bill_type === 'FINAL' ? 'Final' : `RA-${b.bill_no}`}
                    </span>
                    {b.measurement_book_ref ? (
                      <p className="font-mono text-2xs text-text-subtle">{b.measurement_book_ref}</p>
                    ) : null}
                  </TD>
                  <TD tone="subtle">
                    {day(b.period_from)} → {day(b.period_to)}
                  </TD>
                  <TD align="right" className="text-text-muted">{money(b.cumulative_value)}</TD>
                  <TD align="right" className="text-text">{money(b.gross_value)}</TD>
                  <TD align="right" className="text-text-muted">{money(b.total_deductions)}</TD>
                  <TD align="right" className="font-medium text-text">{money(b.net_payable)}</TD>
                  <TD><StatusBadge status={b.status} /></TD>
                  <TD align="right">
                    <Button variant="secondary" size="sm" onClick={() => onOpen(String(b.id))}>Open</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      </Card>
    </>
  );
}

function BillDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, 'rabill.manage');
  const canCertify = hasPermission({ permissions: session?.permissions }, 'rabill.certify');
  const [error, setError] = React.useState<unknown>(null);
  const client = useQueryClient();

  const detail = useQuery({
    queryKey: ['ra-bill', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/ra-bills/${id}`)).data,
  });
  const b = detail.data;

  const move = useMutation({
    mutationFn: async (status: string) =>
      apiRequest(`/api/v1/ra-bills/${id}/status`, {
        method: 'POST', headers: { 'If-Match': String(b!.version) }, body: { status },
      }),
    onSuccess: () => {
      setError(null); void detail.refetch();
      void client.invalidateQueries({ queryKey: ['ra-bills'] });
    },
    onError: setError,
  });

  const items: Row[] = b?.items ?? [];
  const deductions: Row[] = b?.deductions ?? [];
  const deviations = items.filter((i) => Number(i.excess_quantity ?? 0) > 0);

  return (
    <RecordSheet
      open onClose={onClose} wide
      title={b ? (b.bill_type === 'FINAL' ? 'Final bill' : `RA-${b.bill_no}`) : 'Bill'}
      subtitle={b ? `${day(b.period_from)} → ${day(b.period_to)}` : undefined}
    >
      {detail.isLoading || !b ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Field label="Status" value={<StatusBadge status={b.status} size="md" />} />
            <Field label="This bill" value={money(b.gross_value)} />
            <Field label="Deductions" value={money(b.total_deductions)} />
            <Field label="Net payable" value={money(b.net_payable)} />
          </dl>

          <div className="mt-3 rounded-lg border border-border bg-surface-sunken p-3 text-xs text-text-muted">
            Cumulative to date {money(b.cumulative_value)}, less {money(b.previous_value)} billed
            previously. The increment is derived, never keyed — which is what stops the same work being
            billed twice across two bills.
          </div>

          {deviations.length > 0 ? (
            <div className="mt-4">
              <Notice tone="warning" title={`${deviations.length} line beyond the BOQ provision`}>
                Executing more than the bill of quantities provided for needs a deviation order before it
                can be certified.
              </Notice>
            </div>
          ) : null}

          <Section title="Measured items">
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Item</TH>
                    <TH align="right">Cumulative</TH>
                    <TH align="right">Previous</TH>
                    <TH align="right">This bill</TH>
                    <TH align="right">Value</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((i) => (
                    <TR key={String(i.id)}>
                      <TD>
                        <span className="font-mono text-2xs text-text-subtle">{i.item_code}</span>
                        <p className="truncate text-text">{i.description}</p>
                        {Number(i.excess_quantity ?? 0) > 0 ? (
                          <Badge tone="warning" size="sm">
                            {Number(i.excess_quantity)} {i.unit} over BOQ
                          </Badge>
                        ) : null}
                      </TD>
                      <TD align="right" className="text-text-muted">{Number(i.cumulative_quantity)}</TD>
                      <TD align="right" className="text-text-subtle">{Number(i.previous_quantity)}</TD>
                      <TD align="right" className="text-text">
                        {Number(i.cumulative_quantity) - Number(i.previous_quantity)}
                      </TD>
                      <TD align="right" className="text-text">{money(i.this_amount)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </Section>

          {deductions.length > 0 ? (
            <Section title="Deductions">
              <ul className="space-y-1.5 text-sm">
                {deductions.map((d) => (
                  <li key={String(d.id)} className="flex items-start justify-between gap-2">
                    <span>
                      <span className="text-text">{DEDUCTION_LABELS[String(d.head)] ?? d.label}</span>
                      {d.rate_pct ? (
                        <span className="ml-1.5 text-2xs text-text-subtle">{percent(d.rate_pct, 2)}</span>
                      ) : null}
                      {d.reason ? <p className="text-2xs text-text-muted">{d.reason}</p> : null}
                    </span>
                    <span className="tabular-nums text-text-muted">{money(d.amount)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

          {(b.allowed_statuses ?? []).length > 0 && (canManage || canCertify) ? (
            <Section title="Move to">
              <div className="flex flex-wrap gap-2">
                {(b.allowed_statuses as string[]).map((s) => (
                  <Button
                    key={s}
                    variant="secondary"
                    loading={move.isPending}
                    disabled={s === 'CERTIFIED' && !canCertify}
                    onClick={() => move.mutate(s)}
                  >
                    {s.charAt(0) + s.slice(1).toLowerCase()}
                  </Button>
                ))}
              </div>
              <p className="mt-1.5 text-2xs text-text-subtle">
                Certifying freezes the figures: a bill must not move because somebody edited a policy
                percentage afterwards.
              </p>
            </Section>
          ) : null}
        </>
      )}
    </RecordSheet>
  );
}

/* ------------------------------------------------------------------ BOQ */

function Boq({ projectId }: { projectId: string }) {
  const boq = useQuery({
    queryKey: ['boq', projectId],
    queryFn: async () => (await apiRequest<Row[]>(`/api/v1/projects/${projectId}/boq`)).data,
    staleTime: 60_000,
  });

  const rows = boq.data ?? [];
  const value = rows.reduce((t, i) => t + Number(i.quantity) * Number(i.rate), 0);

  if (boq.isLoading) return <Skeleton className="h-64 w-full" />;
  if (boq.error) return <ErrorCard error={boq.error} onRetry={() => void boq.refetch()} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No bill of quantities"
        description="The BOQ is what every RA bill measures against — without it there is nothing to bill."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Items" value={rows.length} />
        <Stat label="Contract value" value={moneyIndian(value)} hint={money(value)} />
        <Stat label="Heads" value={new Set(rows.map((r) => r.category).filter(Boolean)).size || '—'} />
      </div>

      <Card>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Code</TH><TH>Description</TH>
                <TH align="right">Quantity</TH><TH align="right">Rate</TH><TH align="right">Value</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((i) => (
                <TR key={String(i.id)}>
                  <TD mono tone="subtle">{i.item_code}</TD>
                  <TD className="text-text">{i.description}</TD>
                  <TD align="right" className="text-text-muted">{Number(i.quantity)} {i.unit}</TD>
                  <TD align="right" className="text-text-muted">{money(i.rate)}</TD>
                  <TD align="right" className="text-text">{money(Number(i.quantity) * Number(i.rate))}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------ retention */

function Retention({ projectId }: { projectId: string }) {
  const { session } = useAuth();
  const canRelease = hasPermission({ permissions: session?.permissions }, 'retention.release');
  const [error, setError] = React.useState<unknown>(null);
  const [amount, setAmount] = React.useState('');
  const [reason, setReason] = React.useState('');
  const client = useQueryClient();

  const retention = useQuery({
    queryKey: ['retention', projectId],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/projects/${projectId}/retention`)).data,
    staleTime: 30_000,
  });

  const release = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/projects/${projectId}/retention/release`, {
        method: 'POST', body: { amount: Number(amount), reason: reason.trim() },
      }),
    onSuccess: () => {
      setError(null); setAmount(''); setReason('');
      void client.invalidateQueries({ queryKey: ['retention'] });
    },
    onError: setError,
  });

  if (retention.isLoading) return <Skeleton className="h-64 w-full" />;
  if (retention.error) return <ErrorCard error={retention.error} onRetry={() => void retention.refetch()} />;

  const r = retention.data!;
  const ledger: Row[] = r.ledger ?? [];
  const releasable = Number(r.releasable ?? 0);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Held" value={money(r.held)} />
        <Stat
          label="Eligible for release"
          value={money(releasable)}
          tone={releasable > 0 ? 'success' : undefined}
        />
        <Stat label="Still withheld" value={money(r.withheld ?? 0)} />
      </div>

      {r.reason ? (
        <Notice tone="info" title="Not yet releasable">{r.reason}</Notice>
      ) : null}

      {error ? <ErrorCard error={error} /> : null}

      {canRelease && releasable > 0 ? (
        <Card className="p-4">
          <Section title="Release">
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                type="number" min="0" max={releasable} step="0.01" placeholder="Amount"
                value={amount} onChange={(e) => setAmount(e.target.value)}
              />
              <input
                className="sm:col-span-2" placeholder="Reason"
                value={reason} onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <Button
              className="mt-2"
              loading={release.isPending}
              disabled={!Number(amount) || Number(amount) > releasable}
              onClick={() => release.mutate()}
            >
              Release {amount ? money(Number(amount)) : ''}
            </Button>
            <p className="mt-1.5 text-2xs text-text-subtle">
              Retention becomes eligible only once the defect liability period has ended.
            </p>
          </Section>
        </Card>
      ) : null}

      {ledger.length === 0 ? (
        <EmptyState title="Nothing withheld" description="Retention accrues as bills are certified." />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR><TH>Entry</TH><TH>Date</TH><TH>Reason</TH><TH align="right">Amount</TH></TR>
              </THead>
              <TBody>
                {ledger.map((e) => (
                  <TR key={String(e.id)}>
                    <TD>
                      <Badge tone={e.entry_type === 'WITHHELD' ? 'warning' : 'success'} size="sm">
                        {String(e.entry_type).toLowerCase()}
                      </Badge>
                    </TD>
                    <TD tone="subtle">{day(e.created_at)}</TD>
                    <TD tone="muted">{e.reason ?? '—'}</TD>
                    <TD align="right" className="text-text">{money(e.amount)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}
    </>
  );
}

/* --------------------------------------------------------- cost position */

/**
 * Budget against actual, by cost head (§15.6).
 *
 * The bar shows the forecast — actual plus open commitments — not the actual
 * alone. A head at 80% spent with a signed order for the other 40% is already
 * over, and a bar showing 80% would say the opposite.
 */
function CostPosition({ projectId }: { projectId: string }) {
  const position = useQuery({
    queryKey: ['cost-position', projectId],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/projects/${projectId}/cost-position`)).data,
    staleTime: 30_000,
  });

  const entries = useQuery({
    queryKey: ['cost-entries', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/projects/${projectId}/cost-entries?limit=50`)).body as { data: Row[] }).data,
    staleTime: 30_000,
  });

  if (position.isLoading) return <Skeleton className="h-64 w-full" />;
  if (position.error) return <ErrorCard error={position.error} onRetry={() => void position.refetch()} />;

  const p = position.data!;
  const totals = p.totals ?? {};
  const profit = p.profitability ?? {};
  const heads: Row[] = p.heads ?? [];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Budget" value={moneyIndian(totals.budgeted)} hint={money(totals.budgeted)} />
        <Stat label="Actual" value={moneyIndian(totals.actual)} hint={money(totals.actual)} />
        <Stat
          label="Committed"
          value={moneyIndian(totals.committed)}
          hint="Ordered, not yet incurred"
          tone={Number(totals.committed) > 0 ? 'warning' : undefined}
        />
        <Stat
          label="Forecast margin"
          value={profit.forecastMarginPct === null || profit.forecastMarginPct === undefined
            ? '—'
            : percent(profit.forecastMarginPct)}
          hint={profit.marginPct !== null && profit.marginPct !== undefined
            ? `${percent(profit.marginPct)} to date`
            : 'No contract value recorded'}
          tone={profit.lossMaking ? 'danger' : 'success'}
        />
      </div>

      {profit.lossMaking ? (
        <Notice tone="danger" title="This job is forecast to lose money">
          {money(profit.contractValue)} contracted against {money(profit.forecastCost)} of cost
          incurred and committed. The margin to date still reads {percent(profit.marginPct)} — commitments
          are what turn it over.
        </Notice>
      ) : null}

      {heads.length === 0 ? (
        <EmptyState
          title="No cost recorded"
          description="Cost reaches a project when an expense claim is approved, or an order is raised against it."
        />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Cost head</TH>
                  <TH align="right">Budget</TH>
                  <TH align="right">Actual</TH>
                  <TH align="right">Committed</TH>
                  <TH align="right">Forecast</TH>
                  <TH align="right">Variance</TH>
                  <TH>Utilisation</TH>
                </TR>
              </THead>
              <TBody>
                {heads.map((h) => {
                  const width = utilisationWidth(Number(h.forecast), Number(h.budgeted));
                  return (
                    <TR key={String(h.costHeadId)}>
                      <TD>
                        <span className="text-text">{h.cost_head?.name ?? 'Unassigned'}</span>
                        {h.cost_head?.code ? (
                          <p className="font-mono text-2xs text-text-subtle">{h.cost_head.code}</p>
                        ) : null}
                      </TD>
                      <TD align="right" className="text-text-muted">
                        {Number(h.budgeted) > 0 ? money(h.budgeted) : '—'}
                      </TD>
                      <TD align="right" className="text-text">{money(h.actual)}</TD>
                      <TD align="right" className="text-text-muted">
                        {Number(h.committed) > 0 ? money(h.committed) : '—'}
                      </TD>
                      <TD align="right" className="text-text">{money(h.forecast)}</TD>
                      <TD align="right" className={h.overrun ? 'text-danger' : 'text-text-muted'}>
                        {Number(h.budgeted) > 0 ? money(h.variance) : '—'}
                      </TD>
                      <TD>
                        {width === null ? (
                          <span className="text-2xs text-warning">Unbudgeted</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken">
                              <span
                                className={`block h-full rounded-full ${h.overrun ? 'bg-danger' : 'bg-primary'}`}
                                style={{ width: `${width}%` }}
                              />
                            </span>
                            <span className="text-2xs tabular-nums text-text-subtle">
                              {percent(h.utilisationPct, 0)}
                            </span>
                          </div>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}

      {(entries.data ?? []).length > 0 ? (
        <Card>
          <div className="border-b border-border px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Recent entries
            </h3>
          </div>
          <TableWrap>
            <Table>
              <THead>
                <TR><TH>Date</TH><TH>Head</TH><TH>Source</TH><TH>Narration</TH><TH align="right">Amount</TH></TR>
              </THead>
              <TBody>
                {(entries.data ?? []).map((e) => (
                  <TR key={String(e.id)}>
                    <TD tone="subtle">{day(e.entry_date)}</TD>
                    <TD className="text-text">{e.cost_head_name}</TD>
                    <TD>
                      <Badge tone={e.nature === 'COMMITTED' ? 'warning' : 'neutral'} size="sm">
                        {String(e.source_type).replaceAll('_', ' ').toLowerCase()}
                      </Badge>
                    </TD>
                    <TD tone="muted">{e.narration ?? '—'}</TD>
                    <TD align="right" className={Number(e.amount) < 0 ? 'text-success' : 'text-text'}>
                      {money(e.amount)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      ) : null}
    </>
  );
}

/* --------------------------------------------- billing what was measured */

/**
 * What the field measured, as a bill nobody has raised yet (§note 9).
 *
 * The survey module records acres surveyed per village per day. Until now the
 * quantity on the bill was typed in from a spreadsheet kept alongside the
 * system, and two measurements of one job drift. On a government contract the
 * bill has to tie to the measurement book, and a drift is a rejected bill or a
 * dispute months later with nobody able to say which number was right.
 *
 * A proposal, never a bill. A measurement book is certified by an engineer who
 * walks the ground; a screen that raised the bill by itself would be asserting
 * something it is in no position to assert. This shows the numbers and the
 * reasons to look twice, and the person decides.
 */
function MeasuredProposal({ projectId }: { projectId: string }) {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, 'boq.manage');
  const [asOf, setAsOf] = React.useState(() => new Date().toISOString().slice(0, 10));

  const proposal = useQuery({
    queryKey: ['measured-proposal', projectId, asOf],
    queryFn: async () =>
      (await apiRequestRaw(
        `/api/v1/projects/${projectId}/measured-proposal?period_to=${asOf}`)).body as Row,
  });

  const links = useQuery({
    queryKey: ['survey-boq-links', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/projects/${projectId}/survey-boq-links`))
        .body as { data: Row[] }).data,
  });

  const lines: Row[] = proposal.data?.data?.lines ?? [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <Toolbar>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          Measured up to
          <input
            type="date"
            value={asOf}
            max={today}
            onChange={(e) => setAsOf(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
          />
        </label>
        <span className="text-2xs text-text-subtle">
          {/* Said here because it is the whole basis of the figures below. */}
          Cumulative to that date, the way a running-account bill is written.
        </span>
      </Toolbar>

      {proposal.isLoading ? <Skeleton className="h-48" /> : null}
      {proposal.isError ? (
        <ErrorCard error={proposal.error} onRetry={() => proposal.refetch()} />
      ) : null}

      {proposal.isSuccess && lines.length === 0 ? (
        <EmptyState
          title="No BOQ line is measured from the field yet"
          description={canManage
            ? 'Link a BOQ line to a survey measure below, and its quantity will come from the daily returns instead of a spreadsheet.'
            : 'Somebody with BOQ access can link a BOQ line to a survey measure, and the quantity will come from the daily returns.'}
        />
      ) : null}

      {lines.length > 0 ? (
        <Card className="p-0">
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Item</TH>
                  <TH>Measured from</TH>
                  <TH className="text-right">Measured</TH>
                  <TH className="text-right">Cumulative</TH>
                  <TH className="text-right">Already certified</TH>
                  <TH className="text-right">This bill</TH>
                  <TH className="text-right">Value</TH>
                </TR>
              </THead>
              <TBody>
                {lines.map((l) => (
                  <TR key={String(l.boq_item_id)}>
                    <TD>
                      <div className="text-text">{String(l.item_code)}</div>
                      <div className="text-2xs text-text-subtle">{String(l.description)}</div>
                    </TD>
                    <TD tone="muted">
                      {String(l.measure_label ?? l.measure_code)}
                      {l.stage_label ? (
                        <div className="text-2xs text-text-subtle">
                          once {String(l.stage_label).toLowerCase()} is finished
                        </div>
                      ) : null}
                      {Number(l.factor) !== 1 ? (
                        <div className="text-2xs text-text-subtle">
                          × {Number(l.factor)} to convert {String(l.measure_unit)} into {String(l.boq_unit)}
                        </div>
                      ) : null}
                    </TD>
                    <TD tone="muted" className="text-right tabular-nums">
                      {Number(l.measured_quantity).toLocaleString('en-IN')} {String(l.measure_unit)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {Number(l.cumulativeQuantity).toLocaleString('en-IN')} {String(l.boq_unit)}
                    </TD>
                    <TD tone="muted" className="text-right tabular-nums">
                      {Number(l.previousQuantity).toLocaleString('en-IN')}
                    </TD>
                    <TD className="text-right tabular-nums font-medium">
                      {Number(l.thisQuantity).toLocaleString('en-IN')}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {money(Number(l.thisQuantity) * Number(l.rate))}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      ) : null}

      {/* Every reason to look again before raising anything. */}
      {lines.flatMap((l) => (l.flags as string[] ?? []).map((f) => ({ line: l, flag: f })))
        .map(({ line, flag }, i) => (
          <Notice
            key={`${line.boq_item_id}:${flag}:${i}`}
            tone={flag === 'NOTHING_NEW' ? 'info' : 'warning'}
            title={`${String(line.item_code)} — ${flagTitle(flag)}`}
          >
            {flagAdvice(flag, line)}
          </Notice>
        ))}

      {lines.length > 0 ? (
        <Notice tone="info" title="Nothing here raises a bill">
          These are the field&apos;s own figures, for you to check against the measurement
          book. Raise the bill from the RA bills tab and enter the certified quantities
          there — this screen never writes one.
        </Notice>
      ) : null}

      {canManage ? <BoqLinks projectId={projectId} links={links} /> : null}
    </div>
  );
}

function flagTitle(flag: string): string {
  if (flag === 'EXCEEDS_BOQ') return 'more than the BOQ allows';
  if (flag === 'BELOW_CERTIFIED') return 'less than was already certified';
  if (flag === 'NOTHING_NEW') return 'nothing new measured';
  if (flag === 'UNDATED_COMPLETIONS') return 'some villages could not be counted';
  return flag;
}

function flagAdvice(flag: string, line: Row): React.ReactNode {
  if (flag === 'EXCEEDS_BOQ') {
    return `The field has measured ${Number(line.cumulativeQuantity).toLocaleString('en-IN')} `
      + `${String(line.boq_unit)} against a BOQ of ${Number(line.boq_quantity).toLocaleString('en-IN')}. `
      + 'The ground may hold more than the tender estimated. Billing the excess needs a '
      + 'variation approved first, so raise the bill up to the BOQ quantity and take the rest separately.';
  }
  if (flag === 'BELOW_CERTIFIED') {
    return 'A re-measure has found less than an earlier bill already certified. Check the '
      + 'returns for a correction before raising anything — a downward revision has to be '
      + 'agreed, not slipped into the next bill.';
  }
  if (flag === 'NOTHING_NEW') {
    return 'No further work has been measured on this item since the last certified bill. '
      + 'There is nothing to claim for it in this period.';
  }
  if (flag === 'UNDATED_COMPLETIONS') {
    return `${Number(line.undated_villages)} village(s) have finished this stage with no `
      + `completion date, so ${Number(line.undated_quantity).toLocaleString('en-IN')} `
      + `${String(line.measure_unit)} are not counted above. A bill is a claim as at a date, `
      + 'and an undated completion cannot be placed either side of it. Set the dates on the '
      + 'village or its task and they will be included.';
  }
  return null;
}

/** Which BOQ lines draw their quantity from a field measure, and how. */
function BoqLinks({
  projectId, links,
}: {
  projectId: string;
  links: ReturnType<typeof useQuery<Row[]>>;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = React.useState({ boq_item_id: '', measure_id: '', stage_id: '', factor: '1' });

  const boq = useQuery({
    queryKey: ['boq', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/projects/${projectId}/boq`)).body as { data: Row[] }).data,
  });
  /*
   * One call for both lists, from billing's own endpoint.
   *
   * Whoever sets up a link is a commercial person who may hold no survey
   * permission at all, so asking the survey module for its lists would have
   * rendered two empty dropdowns and explained neither.
   */
  const options = useQuery({
    queryKey: ['survey-measure-options', projectId],
    staleTime: 300_000,
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/projects/${projectId}/survey-measure-options`))
        .body as { data: { measures: Row[]; stages: Row[]; programme: Row | null } }).data,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['survey-boq-links', projectId] });
    void qc.invalidateQueries({ queryKey: ['measured-proposal', projectId] });
  };

  const add = useMutation({
    mutationFn: async () => apiRequest(`/api/v1/projects/${projectId}/survey-boq-links`, {
      method: 'POST',
      body: {
        boq_item_id: form.boq_item_id,
        measure_id: form.measure_id,
        stage_id: form.stage_id || null,
        factor: Number(form.factor) || 1,
      },
    }),
    onError: (e) => toast.error('The line was not linked', messageOf(e)),
    onSuccess: () => {
      toast.success('Linked', 'Its quantity now comes from the daily returns.');
      setForm({ boq_item_id: '', measure_id: '', stage_id: '', factor: '1' });
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      apiRequest(`/api/v1/survey-boq-links/${id}`, { method: 'DELETE', body: {} }),
    onError: (e) => toast.error('The link was not removed', messageOf(e)),
    onSuccess: () => {
      toast.success('Unlinked', 'That line is back to a quantity you enter by hand.');
      refresh();
    },
  });

  const field = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';
  const linked = new Set((links.data ?? []).map((l) => String(l.boq_item_id)));

  return (
    <Section title="Which BOQ lines are measured from the field">
      {(links.data ?? []).length > 0 ? (
        <ul className="mb-3 space-y-1">
          {(links.data ?? []).map((l) => (
            <li key={String(l.id)} className="flex items-center gap-2 text-sm">
              <span className="text-text">{String(l.item_code)}</span>
              <span className="text-text-subtle">←</span>
              <span className="text-text-muted">{String(l.measure_label ?? l.measure_code)}</span>
              {l.stage_label ? (
                <Badge tone="neutral">once {String(l.stage_label).toLowerCase()}</Badge>
              ) : null}
              {Number(l.factor) !== 1 ? (
                <span className="text-2xs text-text-subtle">× {Number(l.factor)}</span>
              ) : null}
              <Button type="button" variant="ghost" size="sm" className="ml-auto"
                disabled={remove.isPending}
                onClick={() => remove.mutate(String(l.id))}>
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          BOQ line
          <select className={field} value={form.boq_item_id}
            onChange={(e) => setForm({ ...form, boq_item_id: e.target.value })}>
            <option value="">Choose a line…</option>
            {(boq.data ?? [])
              .filter((b) => !linked.has(String(b.id)))
              .map((b) => (
                <option key={String(b.id)} value={String(b.id)}>
                  {String(b.item_code)} — {String(b.description)} ({String(b.unit)})
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Measured by
          <select className={field} value={form.measure_id}
            onChange={(e) => setForm({ ...form, measure_id: e.target.value })}>
            <option value="">Choose a measure…</option>
            {(options.data?.measures ?? []).map((m) => (
              <option key={String(m.id)} value={String(m.id)}>
                {String(m.label)} ({String(m.unit)})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Only once finished
          <select className={field} value={form.stage_id}
            onChange={(e) => setForm({ ...form, stage_id: e.target.value })}>
            <option value="">Count it as soon as it is measured</option>
            {(options.data?.stages ?? []).map((s) => (
              <option key={String(s.id)} value={String(s.id)}>{String(s.label)}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Conversion
          <input className={`${field} w-24`} value={form.factor} inputMode="decimal"
            onChange={(e) => setForm({ ...form, factor: e.target.value })} />
        </label>
        <Button type="button"
          disabled={!form.boq_item_id || !form.measure_id || add.isPending}
          onClick={() => add.mutate()}>
          Link
        </Button>
      </div>
      <p className="mt-2 text-2xs text-text-subtle">
        Leave the conversion at 1 unless the contract is written in a different unit from the
        one the field records — hectares against acres, say.
      </p>
    </Section>
  );
}

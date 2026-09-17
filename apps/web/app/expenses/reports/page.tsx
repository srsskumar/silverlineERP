'use client';

import Link from 'next/link';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Stat } from '@/components/finance/Primitives';
import { categoryLabel, day, money } from '@/lib/finance';

type Row = Record<string, any>;

type View = 'employee' | 'project' | 'category' | 'aging' | 'exception';

const VIEWS: { key: View; label: string; blurb: string }[] = [
  { key: 'employee', label: 'By employee', blurb: 'Who is spending, and how much of it policy bears.' },
  { key: 'project', label: 'By project', blurb: 'Field spend charged to each site.' },
  { key: 'category', label: 'By category', blurb: 'Where the money goes — travel, lodging, fuel, petty material.' },
  { key: 'aging', label: 'Pending aging', blurb: 'Claims waiting on approval, counted from submission.' },
  { key: 'exception', label: 'Policy exceptions', blurb: 'What was paid above policy, by whom, and on what stated reason.' },
];

/**
 * Expense reporting (§16.5).
 *
 * The five views the specification asks for, from one endpoint. They are kept
 * as separate views rather than one table with a grouping dropdown buried in a
 * filter bar, because "who approved spend above policy" and "what did the
 * Hyderabad site cost" are questions asked by different people for different
 * reasons.
 */
export default function ExpenseReportsPage() {
  const [view, setView] = React.useState<View>('employee');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  const report = useQuery({
    queryKey: ['expense-report', view, from, to],
    queryFn: async () =>
      (await apiRequest<Row[]>(
        `/api/v1/expense-reports?group_by=${view}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`,
      )).data,
    staleTime: 30_000,
  });

  const rows = report.data ?? [];
  const current = VIEWS.find((v) => v.key === view)!;

  return (
    <AppShell>
      <PageHeader
        title="Expense reports"
        description={current.blurb}
        breadcrumb={<Link href="/expenses" className="hover:underline">Expenses</Link>}
      />

      <PageBody>
        <Toolbar>
          <div className="flex flex-wrap rounded-md border border-border bg-surface p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  view === v.key ? 'bg-primary text-primary-fg' : 'text-text-muted hover:text-text'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          {view !== 'aging' ? (
            <>
              <input
                type="date" aria-label="From" className="max-w-40"
                value={from} onChange={(e) => setFrom(e.target.value)}
              />
              <input
                type="date" aria-label="To" className="max-w-40"
                value={to} onChange={(e) => setTo(e.target.value)}
              />
            </>
          ) : null}
        </Toolbar>

        {report.error ? <ErrorCard error={report.error} onRetry={() => void report.refetch()} /> : null}

        {report.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing to report"
            description={
              view === 'exception'
                ? 'No claim has been paid above policy in this window — which is the result you want.'
                : 'No claims match this window.'
            }
          />
        ) : view === 'aging' ? (
          <AgingTable rows={rows} />
        ) : view === 'exception' ? (
          <ExceptionTable rows={rows} />
        ) : (
          <GroupedTable rows={rows} view={view} />
        )}
      </PageBody>
    </AppShell>
  );
}

function GroupedTable({ rows, view }: { rows: Row[]; view: View }) {
  const claimed = rows.reduce((t, r) => t + Number(r.claimed ?? 0), 0);
  const allowed = rows.reduce((t, r) => t + Number(r.allowed ?? 0), 0);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Claimed" value={money(claimed)} />
        <Stat label="Policy allows" value={money(allowed)} />
        <Stat
          label="Above policy"
          value={money(claimed - allowed)}
          tone={claimed - allowed > 0 ? 'warning' : 'success'}
        />
      </div>

      <Card>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>{view === 'category' ? 'Category' : view === 'project' ? 'Project' : 'Employee'}</TH>
                <TH align="right">Claims</TH>
                <TH align="right">Claimed</TH>
                <TH align="right">Allowed</TH>
                <TH align="right">Share</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r, i) => {
                const value = Number(r.claimed ?? 0);
                const share = claimed > 0 ? (value / claimed) * 100 : 0;
                return (
                  <TR key={String(r.key ?? i)}>
                    <TD className="text-text">
                      {view === 'category' ? categoryLabel(r.label) : (r.label ?? 'Unassigned')}
                    </TD>
                    <TD align="right" className="text-text-muted">{r.claims}</TD>
                    <TD align="right" className="text-text-muted">{money(r.claimed)}</TD>
                    <TD align="right" className="text-text">{money(r.allowed)}</TD>
                    <TD align="right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-2xs text-text-subtle">{share.toFixed(0)}%</span>
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${Math.min(100, share)}%` }}
                          />
                        </span>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      </Card>
    </>
  );
}

/**
 * Pending claims by age.
 *
 * Counted from submission, not from the expense date: an employee who sat on a
 * receipt for a month has not created an approval backlog, and colouring their
 * claim red would send finance chasing the wrong person.
 */
function AgingTable({ rows }: { rows: Row[] }) {
  const bucket = (days: number) =>
    days >= 14 ? { tone: 'danger' as const, label: '14 days+' }
      : days >= 7 ? { tone: 'warning' as const, label: '7–13 days' }
        : days >= 3 ? { tone: 'info' as const, label: '3–6 days' }
          : { tone: 'neutral' as const, label: 'Under 3 days' };

  const stale = rows.filter((r) => Number(r.days_pending) >= 7).length;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Awaiting approval" value={rows.length} />
        <Stat label="A week or older" value={stale} tone={stale > 0 ? 'warning' : undefined} />
        <Stat label="Value held up" value={money(rows.reduce((t, r) => t + Number(r.total_claimed ?? 0), 0))} />
      </div>

      <Card>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Claim</TH>
                <TH>Claimant</TH>
                <TH align="right">Amount</TH>
                <TH>Submitted</TH>
                <TH>Waiting</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => {
                const days = Number(r.days_pending ?? 0);
                const b = bucket(days);
                return (
                  <TR key={String(r.id)}>
                    <TD>
                      <a href={`/expenses?open=${r.id}`} className="font-mono text-xs text-primary hover:underline">
                        {r.claim_no}
                      </a>
                    </TD>
                    <TD className="text-text-muted">{r.claimant_username ?? '—'}</TD>
                    <TD align="right" className="text-text-muted">{money(r.total_claimed)}</TD>
                    <TD className="text-2xs text-text-subtle">{day(r.submitted_at)}</TD>
                    <TD>
                      <Badge tone={b.tone} size="sm">{days} day{days === 1 ? '' : 's'}</Badge>
                      <span className="ml-1.5 text-2xs text-text-subtle">{b.label}</span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      </Card>
    </>
  );
}

/**
 * What was paid above policy.
 *
 * This report exists only because the reason is captured at the moment of
 * override rather than reconstructed afterwards — which is why every row can
 * name both the person and their stated justification.
 */
function ExceptionTable({ rows }: { rows: Row[] }) {
  const excess = rows.reduce((t, r) => t + Number(r.total_excess ?? 0), 0);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Exceptions" value={rows.length} />
        <Stat label="Paid above policy" value={money(excess)} tone="warning" />
        <Stat
          label="Approvers involved"
          value={new Set(rows.map((r) => r.override_by_username).filter(Boolean)).size}
        />
      </div>

      <Card>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Claim</TH>
                <TH>Claimant</TH>
                <TH align="right">Policy allowed</TH>
                <TH align="right">Paid</TH>
                <TH align="right">Excess</TH>
                <TH>Allowed by</TH>
                <TH>Reason</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={String(r.id)}>
                  <TD>
                    <a href={`/expenses?open=${r.id}`} className="font-mono text-xs text-primary hover:underline">
                      {r.claim_no}
                    </a>
                    <p className="text-2xs text-text-subtle">{day(r.decided_at)}</p>
                  </TD>
                  <TD className="text-text-muted">{r.claimant_username ?? '—'}</TD>
                  <TD align="right" className="text-text-muted">{money(r.total_allowed)}</TD>
                  <TD align="right" className="text-text">{money(r.approved_amount)}</TD>
                  <TD align="right" className="text-warning">{money(r.total_excess)}</TD>
                  <TD className="text-text">{r.override_by_username ?? '—'}</TD>
                  <TD className="max-w-64 whitespace-normal text-2xs text-text-muted">
                    {r.override_reason ?? '—'}
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

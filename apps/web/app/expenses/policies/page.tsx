'use client';

import Link from 'next/link';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Notice, Section } from '@/components/finance/Primitives';
import { categoryLabel, day, money, EXPENSE_CATEGORY_LABELS, businessToday } from '@/lib/finance';

type Row = Record<string, any>;

/**
 * Expense policy (§16.1).
 *
 * Policies are effective-dated and never edited in place: a June claim is
 * measured against June's rule, so raising a limit in August must not
 * retroactively legitimise June's overspend. Creating a policy closes the
 * standing one the day before the new one starts, which is why the form asks
 * only for a start date.
 */
export default function ExpensePoliciesPage() {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, 'expense.policy.manage');
  const client = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);

  const list = useQuery({
    queryKey: ['expense-policies'],
    queryFn: async () => (await apiRequest<Row[]>('/api/v1/expense-policies')).data,
    staleTime: 60_000,
  });

  const [form, setForm] = React.useState({
    category: 'TRAVEL',
    effective_from: businessToday(),
    per_line_limit: '',
    per_claim_limit: '',
    unit_rate: '',
    requires_receipt_above: '',
    applies_to_grade: '',
  });
  const isEntitlement = form.category === 'PER_DIEM';

  const create = useMutation({
    mutationFn: async () =>
      apiRequest('/api/v1/expense-policies', {
        method: 'POST',
        body: {
          category: form.category,
          effective_from: form.effective_from,
          ...(form.per_line_limit ? { per_line_limit: Number(form.per_line_limit) } : {}),
          ...(form.per_claim_limit ? { per_claim_limit: Number(form.per_claim_limit) } : {}),
          ...(form.unit_rate ? { unit_rate: Number(form.unit_rate) } : {}),
          ...(form.requires_receipt_above ? { requires_receipt_above: Number(form.requires_receipt_above) } : {}),
          ...(form.applies_to_grade.trim() ? { applies_to_grade: form.applies_to_grade.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setError(null);
      setForm((f) => ({ ...f, per_line_limit: '', per_claim_limit: '', unit_rate: '', requires_receipt_above: '' }));
      void client.invalidateQueries({ queryKey: ['expense-policies'] });
    },
    onError: setError,
  });

  const rows = list.data ?? [];
  const today = businessToday();
  const ready = form.effective_from && (!isEntitlement || Number(form.unit_rate) > 0);

  return (
    <AppShell>
      <PageHeader
        title="Expense policy"
        description="Limits as they stood on the date of the expense, not as they stand today."
        breadcrumb={<Link href="/expenses" className="hover:underline">Expenses</Link>}
      />

      <PageBody>
        {error ? <ErrorCard error={error} /> : null}

        {canManage ? (
          <Card className="p-4">
            <Section title="New policy">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                <label className="text-xs text-text-muted">
                  Category
                  <select
                    className="mt-1 w-full"
                    value={form.category}
                    onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  >
                    {Object.entries(EXPENSE_CATEGORY_LABELS).map(([code, label]) => (
                      <option key={code} value={code}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-text-muted">
                  Effective from
                  <input
                    type="date"
                    className="mt-1 w-full"
                    value={form.effective_from}
                    onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))}
                  />
                </label>

                {isEntitlement ? (
                  <label className="text-xs text-text-muted">
                    Rate per day
                    <input
                      type="number" min="0" step="0.01" className="mt-1 w-full"
                      value={form.unit_rate}
                      onChange={(e) => setForm((f) => ({ ...f, unit_rate: e.target.value }))}
                    />
                  </label>
                ) : (
                  <>
                    <label className="text-xs text-text-muted">
                      Per line limit
                      <input
                        type="number" min="0" step="0.01" className="mt-1 w-full" placeholder="No cap"
                        value={form.per_line_limit}
                        onChange={(e) => setForm((f) => ({ ...f, per_line_limit: e.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-text-muted">
                      Per claim limit
                      <input
                        type="number" min="0" step="0.01" className="mt-1 w-full" placeholder="No cap"
                        value={form.per_claim_limit}
                        onChange={(e) => setForm((f) => ({ ...f, per_claim_limit: e.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-text-muted">
                      Receipt required above
                      <input
                        type="number" min="0" step="0.01" className="mt-1 w-full" placeholder="Always"
                        value={form.requires_receipt_above}
                        onChange={(e) => setForm((f) => ({ ...f, requires_receipt_above: e.target.value }))}
                      />
                    </label>
                  </>
                )}

                <label className="text-xs text-text-muted">
                  Grade (optional)
                  <input
                    className="mt-1 w-full" maxLength={50} placeholder="Applies to everyone"
                    value={form.applies_to_grade}
                    onChange={(e) => setForm((f) => ({ ...f, applies_to_grade: e.target.value }))}
                  />
                </label>
              </div>

              {isEntitlement ? (
                <div className="mt-3">
                  <Notice tone="info" title="A per-diem is an entitlement, not a cap">
                    It is valued as days × rate and needs no receipt. Three days at ₹800 is ₹2,400 —
                    a per-claim limit would measure it against a figure written per day.
                  </Notice>
                </div>
              ) : null}

              <div className="mt-3 flex items-center gap-3">
                <Button loading={create.isPending} disabled={!ready} onClick={() => create.mutate()}>
                  Create policy
                </Button>
                <p className="text-2xs text-text-subtle">
                  The current policy for this category closes the day before this one starts.
                </p>
              </div>
            </Section>
          </Card>
        ) : (
          <Notice title="Read only">Changing policy needs the expense.policy.manage permission.</Notice>
        )}

        {list.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No policies"
            description="Without a policy every claim is flagged for a decision, because nothing covers it."
          />
        ) : (
          <Card>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Category</TH>
                    <TH>Window</TH>
                    <TH>Grade</TH>
                    <TH align="right">Per line</TH>
                    <TH align="right">Per claim</TH>
                    <TH align="right">Day rate</TH>
                    <TH align="right">Receipt above</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {rows.map((p) => {
                    const from = String(p.effective_from).slice(0, 10);
                    const to = p.effective_to ? String(p.effective_to).slice(0, 10) : null;
                    const standing = !to;
                    const live = from <= today && (!to || to >= today);
                    return (
                      <TR key={String(p.id)}>
                        <TD className="text-text">{categoryLabel(p.category)}</TD>
                        <TD tone="muted">
                          {day(from)} → {to ? day(to) : 'open'}
                        </TD>
                        <TD tone="subtle">{p.applies_to_grade ?? 'Everyone'}</TD>
                        <TD align="right" className="text-text-muted">{p.per_line_limit ? money(p.per_line_limit) : '—'}</TD>
                        <TD align="right" className="text-text-muted">{p.per_claim_limit ? money(p.per_claim_limit) : '—'}</TD>
                        <TD align="right" className="text-text-muted">{p.unit_rate ? money(p.unit_rate) : '—'}</TD>
                        <TD align="right" className="text-text-muted">
                          {p.requires_receipt_above === null || p.requires_receipt_above === undefined
                            ? 'Always'
                            : money(p.requires_receipt_above)}
                        </TD>
                        <TD align="right">
                          <Badge tone={live ? (standing ? 'success' : 'info') : 'neutral'} size="sm">
                            {live ? (standing ? 'Standing' : 'In force') : to && to < today ? 'Superseded' : 'Scheduled'}
                          </Badge>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
          </Card>
        )}
      </PageBody>
    </AppShell>
  );
}

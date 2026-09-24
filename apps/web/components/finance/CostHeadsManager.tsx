'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listCostHeads, type CostHead } from '@/lib/cost-heads';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { CostHeadForm } from './CostHeadForm';

/** Cost head master list (§15.6): the fixed set a site P&L is read against. */
export function CostHeadsManager() {
  const client = useQueryClient();
  const [kind, setKind] = React.useState('');
  const [formOpen, setFormOpen] = React.useState<'new' | CostHead | null>(null);

  const list = useQuery({
    queryKey: ['cost-heads', kind],
    queryFn: () => listCostHeads(kind ? { kind } : {}),
    staleTime: 15_000,
  });

  const rows = list.data ?? [];
  const refresh = () => void client.invalidateQueries({ queryKey: ['cost-heads'] });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <label className="text-xs text-text-muted">
          Kind
          <select className="mt-1 w-48" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option>
            <option value="LABOUR">Labour</option>
            <option value="MATERIAL">Material</option>
            <option value="SUBCONTRACT">Subcontract</option>
            <option value="EQUIPMENT">Equipment</option>
            <option value="OVERHEAD">Overhead</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <div className="ml-auto">
          <Button onClick={() => setFormOpen('new')}>New cost head</Button>
        </div>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <ErrorCard title="Could not load cost heads" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No cost heads" description="Nothing defined yet — a project budget needs at least one." />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Name</TH>
                  <TH>Kind</TH>
                  <TH>State</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((h) => (
                  <TR key={h.id}>
                    <TD mono className="text-text">{h.code}</TD>
                    <TD className="text-text">{h.name}</TD>
                    <TD tone="muted">{h.kind}</TD>
                    <TD><Badge tone={h.active ? 'success' : 'neutral'} size="sm">{h.active ? 'Active' : 'Retired'}</Badge></TD>
                    <TD align="right">
                      <Button variant="secondary" size="sm" onClick={() => setFormOpen(h)}>Edit</Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}

      {formOpen ? (
        <CostHeadForm
          initial={formOpen === 'new' ? null : formOpen}
          onClose={() => setFormOpen(null)}
          onSaved={() => { setFormOpen(null); refresh(); }}
        />
      ) : null}
    </div>
  );
}

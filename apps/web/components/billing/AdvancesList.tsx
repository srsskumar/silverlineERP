'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { StatusBadge } from '@/components/finance/Primitives';
import { day, money, percent } from '@/lib/finance';

type Row = Record<string, any>;

/** Mirrors ADVANCE_TYPES (lib/validation.ts): MOBILISATION, MATERIAL, PLANT. */
const ADVANCE_TYPE_LABELS: Record<string, string> = {
  MOBILISATION: 'Mobilisation', MATERIAL: 'Material', PLANT: 'Plant',
};

/**
 * Item 6 (final QA fix wave): "New advance" on the billing page had no list
 * beside it, and no `GET /api/v1/advances` to back one — the only way to
 * confirm an advance had actually been recorded was to query the database
 * directly. This shows every advance on the current project, newest first.
 *
 * A standalone component for the same reason as `NewAdvanceForm`: a
 * component exported from a page.tsx breaks the Next.js build.
 */
export function AdvancesList({ projectId }: { projectId: string }) {
  const advances = useQuery({
    queryKey: ['advances', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/advances?project_id=${projectId}`)).body as { data: Row[] }).data,
    staleTime: 20_000,
  });

  const rows = advances.data ?? [];

  if (advances.isLoading) return <Skeleton className="h-32 w-full" />;
  if (advances.error) return <ErrorCard error={advances.error} onRetry={() => void advances.refetch()} />;
  if (rows.length === 0) return null;

  return (
    <Card>
      <p className="mb-2 text-sm font-medium text-text">Advances</p>
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Type</TH>
              <TH>Paid on</TH>
              <TH align="right">Amount</TH>
              <TH align="right">Recovery %</TH>
              <TH align="right">Recovered</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((a) => (
              <TR key={String(a.id)}>
                <TD>{ADVANCE_TYPE_LABELS[a.advance_type] ?? a.advance_type}</TD>
                <TD tone="subtle">{day(a.paid_on)}</TD>
                <TD align="right" className="text-text">{money(a.amount)}</TD>
                <TD align="right" className="text-text-muted">{percent(a.recovery_pct)}</TD>
                <TD align="right" className="text-text-muted">{money(a.recovered_amount)}</TD>
                <TD><StatusBadge status={a.status} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </Card>
  );
}

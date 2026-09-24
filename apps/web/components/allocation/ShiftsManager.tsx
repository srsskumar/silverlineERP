'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listShifts, type Shift } from '@/lib/shifts';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { ShiftForm } from './ShiftForm';

/** "09:00 → 18:00" — starts_at/ends_at are a wall-clock TIME, not a calendar
 *  date, so this is not what day()/dayTime() are for; named and pulled out
 *  of the JSX so it reads as a formatter, not a raw field access. */
function shiftWindow(s: Shift): string {
  return `${String(s.starts_at).slice(0, 5)} → ${String(s.ends_at).slice(0, 5)}`;
}

/** Shift definitions (§47) — the windows a roster entry books an employee into. */
export function ShiftsManager() {
  const client = useQueryClient();
  const [formOpen, setFormOpen] = React.useState<'new' | Shift | null>(null);

  const list = useQuery({ queryKey: ['shifts'], queryFn: listShifts, staleTime: 15_000 });
  const rows = list.data ?? [];
  const refresh = () => void client.invalidateQueries({ queryKey: ['shifts'] });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setFormOpen('new')}>New shift</Button>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <ErrorCard title="Could not load shifts" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No shifts" description="Nothing defined yet — a roster entry needs a shift to book against." />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Name</TH>
                  <TH>Window</TH>
                  <TH className="text-right">Hours</TH>
                  <TH>Rest days</TH>
                  <TH>State</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((s) => (
                  <TR key={s.id}>
                    <TD mono className="text-text">{s.code}</TD>
                    <TD className="text-text">{s.name}</TD>
                    <TD tone="muted">{shiftWindow(s)}</TD>
                    <TD className="text-right tabular-nums">{s.shift_hours}</TD>
                    <TD tone="subtle">{s.rest_days.length ? s.rest_days.join(', ') : '—'}</TD>
                    <TD><Badge tone={s.active ? 'success' : 'neutral'} size="sm">{s.active ? 'Active' : 'Inactive'}</Badge></TD>
                    <TD align="right">
                      <Button variant="secondary" size="sm" onClick={() => setFormOpen(s)}>Edit</Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}

      {formOpen ? (
        <ShiftForm
          initial={formOpen === 'new' ? null : formOpen}
          onClose={() => setFormOpen(null)}
          onSaved={() => { setFormOpen(null); refresh(); }}
        />
      ) : null}
    </div>
  );
}

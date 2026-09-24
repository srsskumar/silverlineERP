'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Section } from '@/components/finance/Primitives';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { day } from '@/lib/finance';

interface DueRow {
  id: string;
  title: string;
  type_label: string;
  category: string;
  owner_type: string;
  retain_until: string | null;
}

/**
 * What purge actually does, said plainly everywhere the action is offered
 * (controller ruling, fix round 1 item 1). The owner decides in the
 * morning whether purge should ever reach into source content; until then
 * it only ever removes the register row.
 */
const REGISTER_ONLY_NOTICE =
  "This removes the register entry only. The underlying file stays with its "
  + "source record (e.g. the employee's documents) until deleted there.";

/**
 * "Due for purge" (owner decision 2026-09-24 #3): no scheduled deletion
 * exists anywhere in this product. The only way a document is ever removed
 * for retention is here — an admin reviews this report, picks specific
 * rows, gives a reason, and confirms. The server refuses the whole
 * selection if anything in it is on legal hold or not yet past retention,
 * so a mixed selection cannot half-succeed.
 */
export function DueForPurgePanel() {
  const qc = useQueryClient();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [reason, setReason] = React.useState('');

  const query = useQuery({
    queryKey: ['documents', 'due-for-purge'],
    queryFn: async () => (await apiRequestRaw('/api/v1/documents/due-for-purge')).body as { data: DueRow[] },
  });

  const purge = useMutation({
    mutationFn: () =>
      apiRequest('/api/v1/documents/purge', {
        method: 'POST',
        body: { ids: Array.from(selected), reason: reason.trim() },
      }),
    onSuccess: () => {
      setSelected(new Set());
      setReason('');
      qc.invalidateQueries({ queryKey: ['documents'] });
      query.refetch();
    },
  });

  if (query.isLoading) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorCard error={query.error} onRetry={() => query.refetch()} />;

  const items = query.data?.data ?? [];
  const allChosen = items.length > 0 && items.every((d) => selected.has(d.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allChosen ? new Set() : new Set(items.map((d) => d.id)));
  }

  const ready = selected.size > 0 && reason.trim().length >= 3;

  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <EmptyState
          title="Nothing is due for purge"
          description="Every document is either still inside its retention period, under legal hold, or superseded by a later revision that still needs it."
        />
      ) : (
        <Section title={`${items.length} document(s) past retention`}>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH className="w-8">
                    <input type="checkbox" aria-label="Select all" checked={allChosen} onChange={toggleAll} />
                  </TH>
                  <TH>Document</TH>
                  <TH>Attached to</TH>
                  <TH>Retainable until</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((d) => (
                  <TR key={d.id}>
                    <TD>
                      <input
                        type="checkbox"
                        aria-label={`Select ${d.title}`}
                        checked={selected.has(d.id)}
                        onChange={() => toggle(d.id)}
                      />
                    </TD>
                    <TD>
                      <div className="font-medium text-text">{d.title}</div>
                      <div className="text-2xs text-text-subtle">{d.type_label}</div>
                    </TD>
                    <TD tone="muted">{d.owner_type}</TD>
                    <TD>{day(d.retain_until)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Section>
      )}

      {items.length > 0 ? (
        <Card className="space-y-3 p-4">
          <p className="text-xs text-text-subtle">
            {REGISTER_ONLY_NOTICE}
          </p>
          <label className="block text-xs font-medium text-text-muted" htmlFor="purge-reason">
            Reason for purging {selected.size || 0} selected document(s)
          </label>
          <textarea
            id="purge-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why these are being purged now"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
          />
          <Button
            type="button"
            variant="danger"
            disabled={!ready}
            loading={purge.isPending}
            onClick={() => {
              if (window.confirm(
                `Permanently purge ${selected.size} document(s)? This cannot be undone.\n\n${REGISTER_ONLY_NOTICE}`,
              )) {
                purge.mutate();
              }
            }}
          >
            Purge selected
          </Button>
          {purge.isError ? <ErrorCard title="Could not purge the selection" error={purge.error} /> : null}
        </Card>
      ) : null}
    </div>
  );
}

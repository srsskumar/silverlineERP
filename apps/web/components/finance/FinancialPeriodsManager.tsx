'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listFinancialPeriods, createFinancialPeriod, setPeriodClosure, type FinancialPeriod,
} from '@/lib/financial-periods';
import { financialPeriodFormSchema, type FinancialPeriodFormInput } from '@/lib/validation';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { FieldError, Section } from '@/components/finance/Primitives';
import { applyFieldErrors } from '@/lib/form-errors';
import { day } from '@/lib/finance';

/**
 * Financial periods (§45.2): the calendar an org's books close month by
 * month. Once a period is closed, nothing dated inside it can be posted
 * (payments, allocations, bank reconciliation) until it is reopened.
 */
export function FinancialPeriodsManager() {
  const client = useQueryClient();
  const [reopening, setReopening] = React.useState<FinancialPeriod | null>(null);
  const [reason, setReason] = React.useState('');
  const [actionError, setActionError] = React.useState<unknown>(null);

  const list = useQuery({
    queryKey: ['financial-periods'],
    queryFn: listFinancialPeriods,
    staleTime: 15_000,
  });

  const {
    register, handleSubmit, reset, setError, formState: { errors, isSubmitting },
  } = useForm<FinancialPeriodFormInput>({
    resolver: zodResolver(financialPeriodFormSchema),
    defaultValues: { code: '', starts_on: '', ends_on: '' },
  });
  const [createError, setCreateError] = React.useState<unknown>(null);

  const create = useMutation({
    mutationFn: (v: FinancialPeriodFormInput) => createFinancialPeriod(v),
    onSuccess: () => {
      reset({ code: '', starts_on: '', ends_on: '' });
      setCreateError(null);
      void client.invalidateQueries({ queryKey: ['financial-periods'] });
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof FinancialPeriodFormInput, e));
      setCreateError(err);
    },
  });

  const close = useMutation({
    mutationFn: (row: FinancialPeriod) => setPeriodClosure(row.id, row.version, 'CLOSE'),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['financial-periods'] }),
    onError: setActionError,
  });

  const reopen = useMutation({
    mutationFn: () => setPeriodClosure(reopening!.id, reopening!.version, 'REOPEN', reason.trim()),
    onSuccess: () => {
      setReopening(null);
      setReason('');
      void client.invalidateQueries({ queryKey: ['financial-periods'] });
    },
    onError: setActionError,
  });

  const rows = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <Section title="New period">
          <form
            onSubmit={handleSubmit((v) => create.mutate(v))}
            noValidate
            className="grid gap-3 sm:grid-cols-4 sm:items-end"
          >
            <label className="text-xs text-text-muted">
              Code
              <input className="mt-1 w-full" maxLength={30} placeholder="2026-10" {...register('code')} />
              <FieldError message={errors.code?.message} />
            </label>
            <label className="text-xs text-text-muted">
              Starts on
              <input type="date" className="mt-1 w-full" {...register('starts_on')} />
              <FieldError message={errors.starts_on?.message} />
            </label>
            <label className="text-xs text-text-muted">
              Ends on
              <input type="date" className="mt-1 w-full" {...register('ends_on')} />
              <FieldError message={errors.ends_on?.message} />
            </label>
            <Button type="submit" loading={isSubmitting || create.isPending}>Create period</Button>
          </form>
          {createError ? <ErrorCard title="Could not create the period" error={createError} className="mt-3" /> : null}
        </Section>
      </Card>

      {actionError ? <ErrorCard title="Could not change the period's state" error={actionError} /> : null}

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <ErrorCard title="Could not load financial periods" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No financial periods" description="Nothing has been defined yet." />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Window</TH>
                  <TH>State</TH>
                  <TH>History</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((p) => (
                  <TR key={p.id}>
                    <TD className="text-text" mono>{p.code}</TD>
                    <TD tone="muted">{day(p.starts_on)} → {day(p.ends_on)}</TD>
                    <TD>
                      <Badge tone={p.status === 'CLOSED' ? 'neutral' : 'success'} size="sm">{p.status}</Badge>
                    </TD>
                    <TD tone="subtle" className="text-2xs">
                      {p.status === 'CLOSED' && p.closed_at
                        ? `Closed ${day(p.closed_at)}${p.closed_by_username ? ` by ${p.closed_by_username}` : ''}`
                        : p.reopened_at
                          ? `Reopened ${day(p.reopened_at)}${p.reopened_by_username ? ` by ${p.reopened_by_username}` : ''}`
                          : '—'}
                    </TD>
                    <TD align="right">
                      {p.status === 'OPEN' ? (
                        <Button
                          variant="secondary" size="sm"
                          loading={close.isPending}
                          onClick={() => {
                            if (window.confirm(`Close period ${p.code}? Nothing dated inside it can be posted until it is reopened.`)) {
                              close.mutate(p);
                            }
                          }}
                        >
                          Close
                        </Button>
                      ) : reopening?.id === p.id ? (
                        <div className="flex items-center justify-end gap-2">
                          <input
                            className="w-48"
                            placeholder="Reason for reopening"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          />
                          <Button variant="secondary" size="sm" onClick={() => { setReopening(null); setReason(''); }}>
                            Cancel
                          </Button>
                          <Button
                            size="sm" loading={reopen.isPending}
                            disabled={!reason.trim()}
                            onClick={() => reopen.mutate()}
                          >
                            Confirm reopen
                          </Button>
                        </div>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => { setReopening(p); setReason(''); }}>
                          Reopen
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}

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
import { PageHeader, PageBody } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { listPeople } from '@/lib/people';
import { Notice, Section } from '@/components/finance/Primitives';
import { day, DOCUMENT_TYPE_LABELS } from '@/lib/finance';

type Row = Record<string, any>;

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Delegation of approval authority (§41.3).
 *
 * A manager going on leave hands their authority to somebody for a date range,
 * never permanently — which is why the form has no "no end date" option. The
 * window is the control.
 */
export default function DelegationsPage() {
  const { session } = useAuth();
  const canDelegate = hasPermission({ permissions: session?.permissions }, 'approval.delegate');
  const client = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);

  const list = useQuery({
    queryKey: ['approval-delegations'],
    queryFn: async () => (await apiRequest<Row[]>('/api/v1/approval-delegations')).data,
    staleTime: 30_000,
  });

  const users = useQuery({
    queryKey: ['users', 'for-delegation'],
    queryFn: listPeople,
    enabled: canDelegate,
    staleTime: 300_000,
  });

  const [toUserId, setToUserId] = React.useState('');
  const [validFrom, setValidFrom] = React.useState(todayIso());
  const [validTo, setValidTo] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [documentTypes, setDocumentTypes] = React.useState<string[]>([]);

  const create = useMutation({
    mutationFn: async () =>
      apiRequest('/api/v1/approval-delegations', {
        method: 'POST',
        body: {
          to_user_id: toUserId,
          valid_from: validFrom,
          valid_to: validTo,
          document_types: documentTypes,
          reason: reason.trim(),
        },
      }),
    onSuccess: () => {
      setError(null); setToUserId(''); setValidTo(''); setReason(''); setDocumentTypes([]);
      void client.invalidateQueries({ queryKey: ['approval-delegations'] });
    },
    onError: setError,
  });

  const revoke = useMutation({
    mutationFn: async (id: string) =>
      apiRequest(`/api/v1/approval-delegations/${id}/revoke`, { method: 'POST', body: {} }),
    onSuccess: () => {
      setError(null);
      void client.invalidateQueries({ queryKey: ['approval-delegations'] });
    },
    onError: setError,
  });

  const rows = list.data ?? [];
  const ready = toUserId && validFrom && validTo && reason.trim() && validTo >= validFrom;

  return (
    <AppShell>
      <PageHeader
        title="Delegations"
        description="Authority handed to somebody else for a fixed window."
        breadcrumb={<a href="/approvals" className="hover:underline">Approvals</a>}
      />

      <PageBody>
        {error ? <ErrorCard error={error} /> : null}

        {canDelegate ? (
          <Card className="p-4">
            <Section title="Delegate your authority">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs text-text-muted">
                  To
                  <select
                    className="mt-1 w-full"
                    value={toUserId}
                    onChange={(e) => setToUserId(e.target.value)}
                  >
                    <option value="">Choose a person</option>
                    {(users.data ?? [])
                      .filter((u) => String(u.id) !== session?.user?.id)
                      .map((u) => (
                        <option key={String(u.id)} value={String(u.id)}>{u.name ?? u.username}</option>
                      ))}
                  </select>
                </label>
                <label className="text-xs text-text-muted">
                  From
                  <input
                    type="date"
                    className="mt-1 w-full"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                  />
                </label>
                <label className="text-xs text-text-muted">
                  Until
                  <input
                    type="date"
                    className="mt-1 w-full"
                    min={validFrom}
                    value={validTo}
                    onChange={(e) => setValidTo(e.target.value)}
                  />
                </label>
                <label className="text-xs text-text-muted">
                  Reason
                  <input
                    className="mt-1 w-full"
                    maxLength={500}
                    placeholder="Annual leave"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
              </div>

              <fieldset className="mt-3">
                <legend className="text-2xs uppercase tracking-wide text-text-subtle">
                  Limit to document types (optional)
                </legend>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {Object.entries(DOCUMENT_TYPE_LABELS).map(([code, label]) => {
                    const on = documentTypes.includes(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() =>
                          setDocumentTypes((prev) =>
                            on ? prev.filter((c) => c !== code) : [...prev, code])
                        }
                        className={`rounded border px-2 py-0.5 text-2xs font-medium transition-colors ${
                          on
                            ? 'border-primary bg-primary text-primary-fg'
                            : 'border-border bg-surface text-text-muted hover:text-text'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-2xs text-text-subtle">
                  Leave every type unselected to delegate all of them.
                </p>
              </fieldset>

              <div className="mt-3 flex items-center gap-3">
                <Button loading={create.isPending} disabled={!ready} onClick={() => create.mutate()}>
                  Delegate
                </Button>
                <p className="text-2xs text-text-subtle">
                  A delegation always has an end date, and the audit trail records that an act
                  was taken on delegated authority.
                </p>
              </div>
            </Section>
          </Card>
        ) : (
          <Notice title="You cannot delegate">
            Handing over approval authority needs the approval.delegate permission.
          </Notice>
        )}

        {list.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No delegations"
            description="Authority stays with the people the policy names until somebody delegates it."
          />
        ) : (
          <Card>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>From</TH>
                    <TH>To</TH>
                    <TH>Window</TH>
                    <TH>Scope</TH>
                    <TH>State</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {rows.map((d) => {
                    const today = todayIso();
                    const from = String(d.valid_from).slice(0, 10);
                    const to = String(d.valid_to).slice(0, 10);
                    const revoked = Boolean(d.revoked_at);
                    const live = !revoked && from <= today && today <= to;
                    const types: string[] = Array.isArray(d.document_types) ? d.document_types : [];
                    return (
                      <TR key={String(d.id)}>
                        <TD className="text-text">{d.from_username}</TD>
                        <TD className="text-text">{d.to_username}</TD>
                        <TD className="text-text-muted">{day(from)} → {day(to)}</TD>
                        <TD className="text-2xs text-text-subtle">
                          {types.length === 0
                            ? 'All documents'
                            : types.map((t) => DOCUMENT_TYPE_LABELS[t] ?? t).join(', ')}
                        </TD>
                        <TD>
                          <Badge tone={revoked ? 'neutral' : live ? 'success' : 'info'} size="sm">
                            {revoked ? 'Revoked' : live ? 'Active' : to < today ? 'Expired' : 'Scheduled'}
                          </Badge>
                        </TD>
                        <TD align="right">
                          {!revoked && String(d.from_user_id) === session?.user?.id ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={revoke.isPending}
                              onClick={() => revoke.mutate(String(d.id))}
                            >
                              Revoke
                            </Button>
                          ) : null}
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

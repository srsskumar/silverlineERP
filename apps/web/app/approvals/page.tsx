'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { statusLabel } from '@/lib/board-visuals';
import { Field, Notice, RecordSheet, Section, StatusBadge, Stat } from '@/components/finance/Primitives';
import {
  day, documentHref, documentTypeLabel, money, slaState, DOCUMENT_TYPE_LABELS,
} from '@/lib/finance';

type Row = Record<string, any>;

/**
 * Approvals (§41).
 *
 * This is the screen every other financial module depends on: requisitions,
 * orders, expense claims and RA bills all route here, and without it a
 * document can be raised but never decided.
 *
 * Two views, because they answer different questions. "To decide" is a work
 * queue — what is waiting on me, oldest first, with the SLA clock visible.
 * "Raised by me" is a tracking view — where has my request got to. Mixing them
 * produces a list where the urgent and the merely interesting look alike.
 */
export default function ApprovalsPage() {
  const { session } = useAuth();
  const canAct = hasPermission({ permissions: session?.permissions }, 'approval.act');
  const canReadAll = hasPermission({ permissions: session?.permissions }, 'approval.read_all');

  const [tab, setTab] = React.useState<'inbox' | 'mine' | 'all'>(canAct ? 'inbox' : 'mine');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [documentType, setDocumentType] = React.useState('');
  const client = useQueryClient();

  React.useEffect(() => {
    // Deep link from a document screen: /approvals?open=<id>
    const open = new URLSearchParams(window.location.search).get('open');
    if (open) setSelected(open);
  }, []);

  const inbox = useQuery({
    queryKey: ['approvals', 'inbox'],
    queryFn: async () => (await apiRequest<Row[]>('/api/v1/approvals/inbox')).data,
    enabled: canAct && tab === 'inbox',
    staleTime: 15_000,
  });

  const list = useQuery({
    queryKey: ['approvals', 'list', tab, documentType],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/approvals?limit=100${tab === 'mine' ? '&mine=true' : ''}${documentType ? `&document_type=${documentType}` : ''}`,
      )).body as { data: Row[] }).data,
    enabled: tab !== 'inbox',
    staleTime: 15_000,
  });

  const refreshAll = () => {
    void client.invalidateQueries({ queryKey: ['approvals'] });
  };

  const rows = tab === 'inbox' ? (inbox.data ?? []) : (list.data ?? []);
  const active = tab === 'inbox' ? inbox : list;
  const breached = (inbox.data ?? []).filter((r) => slaState(r.pending_since, r.sla_hours).breached).length;

  return (
    <AppShell>
      <PageHeader
        title="Approvals"
        description="The authority ladder every financial document climbs."
        actions={
          <a
            href="/approvals/delegations"
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text hover:bg-surface-sunken"
          >
            Delegations
          </a>
        }
      />

      <PageBody>
        {canAct && (inbox.data?.length ?? 0) > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Waiting on you" value={inbox.data!.length} />
            <Stat
              label="Past SLA"
              value={breached}
              tone={breached > 0 ? 'danger' : undefined}
              hint={breached > 0 ? 'Escalation is due' : 'All within target'}
            />
            <Stat
              label="Value in queue"
              value={money(inbox.data!.reduce((t, r) => t + Number(r.amount ?? 0), 0))}
            />
          </div>
        ) : null}

        <Toolbar>
          <div className="flex rounded-md border border-border bg-surface p-0.5">
            {([
              ...(canAct ? [['inbox', 'To decide'] as const] : []),
              ['mine', 'Raised by me'] as const,
              ...(canReadAll ? [['all', 'Everything'] as const] : []),
            ]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  tab === key ? 'bg-primary text-primary-fg' : 'text-text-muted hover:text-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab !== 'inbox' ? (
            <select
              aria-label="Document type"
              className="max-w-48"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
            >
              <option value="">All documents</option>
              {Object.entries(DOCUMENT_TYPE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          ) : null}
        </Toolbar>

        {active.error ? <ErrorCard error={active.error} onRetry={() => void active.refetch()} /> : null}

        {active.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={tab === 'inbox' ? 'Nothing waiting on you' : 'No requests'}
            description={
              tab === 'inbox'
                ? 'Requests appear here when your level is the next to decide. You never see your own.'
                : 'Documents you submit for approval will be tracked here.'
            }
          />
        ) : (
          <Card>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Document</TH>
                    <TH>Raised by</TH>
                    <TH align="right">Amount</TH>
                    <TH>{tab === 'inbox' ? 'Waiting' : 'Status'}</TH>
                    <TH>Level</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {rows.map((r) => {
                    const sla = slaState(r.pending_since, r.sla_hours);
                    return (
                      <TR key={String(r.id)}>
                        <TD>
                          <span className="font-medium text-text">{documentTypeLabel(r.document_type)}</span>
                          {r.project_code ? (
                            <p className="text-2xs text-text-subtle">{r.project_code}</p>
                          ) : null}
                        </TD>
                        <TD tone="muted">{r.requested_by_username ?? '—'}</TD>
                        <TD align="right" className="text-text-muted">{money(r.amount)}</TD>
                        <TD>
                          {tab === 'inbox' ? (
                            <Badge tone={sla.tone} size="sm">
                              <Clock className="size-3" />
                              {sla.label}
                            </Badge>
                          ) : (
                            <StatusBadge status={r.status} />
                          )}
                        </TD>
                        <TD tone="subtle">
                          {r.sequence ?? r.current_sequence
                            ? `Level ${r.sequence ?? r.current_sequence}`
                            : '—'}
                        </TD>
                        <TD align="right">
                          <Button variant="secondary" size="sm" onClick={() => setSelected(String(r.id))}>
                            Open
                          </Button>
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

      {selected ? (
        <ApprovalDetail id={selected} onClose={() => setSelected(null)} onChanged={refreshAll} />
      ) : null}
    </AppShell>
  );
}

function ApprovalDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { session } = useAuth();
  const canAct = hasPermission({ permissions: session?.permissions }, 'approval.act');
  const [comments, setComments] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);

  const detail = useQuery({
    queryKey: ['approval', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/approvals/${id}`)).data,
  });
  const a = detail.data;

  const decide = useMutation({
    mutationFn: async (decision: 'APPROVE' | 'REJECT') =>
      apiRequest(`/api/v1/approvals/${id}/decision`, {
        method: 'POST',
        headers: { 'If-Match': String(a!.version) },
        body: { decision, ...(comments.trim() ? { comments: comments.trim() } : {}) },
      }),
    onSuccess: () => { setError(null); setComments(''); void detail.refetch(); onChanged(); },
    onError: setError,
  });

  const recall = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/approvals/${id}/recall`, {
        method: 'POST',
        headers: { 'If-Match': String(a!.version) },
        body: { reason: comments.trim() || 'Withdrawn by the requester' },
      }),
    onSuccess: () => { setError(null); setComments(''); void detail.refetch(); onChanged(); },
    onError: setError,
  });

  const steps: Row[] = a?.steps ?? [];
  const nextStep = a?.next_step ?? null;
  const isRequester = a && String(a.requested_by) === session?.user?.id;
  // The engine refuses a self-approval, so saying so up front saves a round
  // trip and explains a button that would otherwise just look broken.
  const selfApproval = Boolean(isRequester);
  const canDecideNow = canAct && a?.status === 'PENDING' && !selfApproval;
  const href = documentHref(a?.document_type, a?.document_id);

  return (
    <RecordSheet
      open
      onClose={onClose}
      title={documentTypeLabel(a?.document_type)}
      subtitle={a ? `${money(a.amount)} · raised ${day(a.created_at)}` : undefined}
    >
      {detail.isLoading || !a ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Field label="Status" value={<StatusBadge status={a.status} size="md" />} />
            <Field label="Amount" value={money(a.amount)} />
            <Field label="Raised by" value={a.requested_by_username ?? '—'} />
            <Field label="Policy" value={a.policy_name ?? '—'} />
          </dl>

          {href ? (
            <a
              href={href}
              className="mt-3 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Open the {documentTypeLabel(a.document_type).toLowerCase()} →
            </a>
          ) : null}

          {a.rejection_reason ? (
            <div className="mt-4">
              <Notice tone="danger" title="Rejected">{a.rejection_reason}</Notice>
            </div>
          ) : null}
          {a.superseded_reason ? (
            <div className="mt-4">
              <Notice tone="info" title="Superseded">
                {a.superseded_reason} — the document changed materially and climbed the ladder again.
              </Notice>
            </div>
          ) : null}

          <Section title="Ladder">
            <ol className="space-y-0">
              {steps.map((s, i) => {
                const isNext = nextStep && Number(nextStep.sequence) === Number(s.sequence);
                const sla = slaState(s.pending_since, s.sla_hours);
                return (
                  <li key={String(s.id)} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < steps.length - 1 ? (
                      <span className="absolute left-[7px] top-5 h-full w-px bg-border" aria-hidden />
                    ) : null}
                    <span className="relative z-10 mt-1 shrink-0">
                      {s.status === 'APPROVED' ? (
                        <CheckCircle2 className="size-4 text-success" />
                      ) : s.status === 'REJECTED' ? (
                        <XCircle className="size-4 text-danger" />
                      ) : (
                        <span
                          className={`block size-4 rounded-full border-2 ${
                            isNext ? 'border-warning bg-warning-subtle' : 'border-border bg-surface'
                          }`}
                        />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-medium text-text">
                          Level {s.sequence} · {statusLabel(String(s.approver_role ?? 'Named approver'))}
                        </span>
                        <StatusBadge status={s.status} />
                        {isNext && s.status === 'PENDING' ? (
                          <Badge tone={sla.tone} size="sm">{sla.label}</Badge>
                        ) : null}
                      </div>
                      {s.acted_by_username ? (
                        <p className="mt-0.5 text-2xs text-text-subtle">
                          {s.status === 'APPROVED' ? 'Approved' : 'Decided'} by {s.acted_by_username}
                          {/* §41.3: an act taken under delegation says so, or the
                              audit trail claims the principal did it themselves. */}
                          {s.acted_on_behalf_of_username
                            ? ` on behalf of ${s.acted_on_behalf_of_username}`
                            : ''}
                          {s.acted_at ? ` · ${day(s.acted_at)}` : ''}
                        </p>
                      ) : null}
                      {s.comments ? <p className="mt-1 text-xs text-text-muted">{s.comments}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </Section>

          {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

          {a.status === 'PENDING' ? (
            <Section title="Decide">
              {selfApproval ? (
                <Notice title="This is your own request">
                  Maker-checker means the person who raised a document cannot approve it. Somebody else at
                  level {nextStep?.sequence ?? 1} has to decide.
                </Notice>
              ) : !canAct ? (
                <Notice title="You can view this but not decide">
                  Acting on an approval needs the approval.act permission.
                </Notice>
              ) : null}

              <textarea
                className="mt-2 w-full rounded-md border border-border bg-surface p-2 text-sm"
                rows={2}
                maxLength={2000}
                placeholder={canDecideNow ? 'Comments (required when rejecting)' : 'Reason for withdrawing'}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
              />

              <div className="mt-2 flex flex-wrap gap-2">
                {canDecideNow ? (
                  <>
                    <Button loading={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
                      Approve level {nextStep?.sequence ?? ''}
                    </Button>
                    <Button
                      variant="danger"
                      loading={decide.isPending}
                      disabled={!comments.trim()}
                      onClick={() => decide.mutate('REJECT')}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
                {isRequester ? (
                  <Button variant="secondary" loading={recall.isPending} onClick={() => recall.mutate()}>
                    Withdraw
                  </Button>
                ) : null}
              </div>
              {canDecideNow && !comments.trim() ? (
                <p className="mt-1.5 text-2xs text-text-subtle">
                  A rejection needs a reason — the requester has to know what to change.
                </p>
              ) : null}
            </Section>
          ) : null}
        </>
      )}
    </RecordSheet>
  );
}

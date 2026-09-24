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
import { Combobox } from '@/components/ui/Combobox';
import { OwnerPicker } from '@/components/OwnerPicker';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Notice, Section, Stat } from '@/components/finance/Primitives';
import { day } from '@/lib/finance';
import {
  CATEGORY_LABELS, OWNER_LABELS, STATE_LABELS, consequence, deadlineLabel,
  registerHeadline, retentionNote, stateTone, type DocumentState,
} from '@/lib/document-register';
import { DeleteDocumentButton } from '@/components/documents/DeleteDocumentButton';

type Row = Record<string, any>;

/**
 * The document register (§46).
 *
 * Opens on what needs renewing rather than on a list of everything, because
 * the register exists to answer one question — what is about to expire, and
 * what stops if it does — and a screen that opens on an alphabetical list
 * makes the reader go and find that out for themselves.
 */
export default function DocumentsPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canRead = hasPermission(perms, 'document.read');
  const canManage = hasPermission(perms, 'document.manage');
  const canDelete = hasPermission(perms, 'document.delete');

  const [tab, setTab] = React.useState<'renewals' | 'register'>('renewals');
  const [within, setWithin] = React.useState(60);
  const [filters, setFilters] = React.useState({ category: '', owner_type: '', state: '' });
  const [adding, setAdding] = React.useState(false);

  const renewals = useQuery({
    queryKey: ['documents', 'renewals', within],
    enabled: canRead && tab === 'renewals',
    queryFn: async () =>
      (await apiRequestRaw(`/api/v1/documents/renewals?within_days=${within}`)).body as Row,
  });

  const register = useQuery({
    queryKey: ['documents', 'register', filters],
    enabled: canRead && tab === 'register',
    queryFn: async () => {
      const q = new URLSearchParams({ limit: '100' });
      for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
      return (await apiRequestRaw(`/api/v1/documents?${q}`)).body as Row;
    },
  });

  if (!canRead) {
    return (
      <AppShell>
        <PageHeader title="Documents" />
        <PageBody>
          <Notice tone="info" title="You do not have access to the document register">
            This screen needs the <code>document.read</code> permission. An administrator can grant
            it from Security &rarr; Roles.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  const summary = register.data?.summary;

  return (
    <AppShell>
      <PageHeader
        title="Documents"
        description="Licences, policies, certificates and agreements — and when each one runs out."
      />
      <PageBody>
        <Toolbar>
          <div className="flex gap-1">
            <Button type="button" variant={tab === 'renewals' ? 'secondary' : 'ghost'}
              onClick={() => setTab('renewals')}>
              Renewals
            </Button>
            <Button type="button" variant={tab === 'register' ? 'secondary' : 'ghost'}
              onClick={() => setTab('register')}>
              The register
            </Button>
          </div>
          {tab === 'renewals' ? (
            <label className="flex items-center gap-2 text-xs text-text-muted">
              Looking ahead
              <select
                value={within}
                onChange={(e) => setWithin(Number(e.target.value))}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
              >
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>a year</option>
              </select>
            </label>
          ) : null}
          {canManage ? (
            <Button type="button" variant="primary" onClick={() => setAdding((a) => !a)}>
              {adding ? 'Cancel' : 'Add a document'}
            </Button>
          ) : null}
        </Toolbar>

        {adding ? <AddDocument onDone={() => { setAdding(false); renewals.refetch(); register.refetch(); }} /> : null}

        {tab === 'renewals' ? (
          <Renewals query={renewals} canManage={canManage} within={within} />
        ) : (
          <Register
            query={register} filters={filters} setFilters={setFilters} summary={summary}
            canDelete={canDelete} onDeleted={() => register.refetch()}
          />
        )}
      </PageBody>
    </AppShell>
  );
}

/* --------------------------------------------------------------- renewals */

function Renewals({
  query, canManage, within,
}: {
  query: any; canManage: boolean; within: number;
}) {
  const qc = useQueryClient();
  const [renewing, setRenewing] = React.useState<Row | null>(null);

  if (query.isLoading) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorCard error={query.error} onRetry={() => query.refetch()} />;

  const data = query.data;
  const items: Row[] = data?.data ?? [];
  const blocking = items.filter((d) => d.blocks_operations && d.state === 'EXPIRED');

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label="Due for renewal" value={items.length} hint={`within ${within} days`} />
        <Stat
          label="Lapsed, and work depends on it"
          value={data?.blocking ?? 0}
          tone={(data?.blocking ?? 0) > 0 ? 'danger' : 'success'}
        />
        <Stat
          label="Lapsing soon, and work depends on it"
          value={data?.blocking_soon ?? 0}
          tone={(data?.blocking_soon ?? 0) > 0 ? 'warning' : 'default'}
        />
      </div>

      {blocking.length ? (
        <Notice tone="danger" title="Work should not continue on these">
          {/* The whole point of separating these: a lapsed labour licence is
              not the same kind of problem as a stale scan of a PAN card. */}
          <ul className="ml-4 list-disc space-y-1">
            {blocking.map((d) => (
              <li key={d.id}>
                <span className="font-medium">{d.type_label}</span> — {d.title}, expired{' '}
                {day(d.expires_on)}. {d.basis ? <span className="text-text-subtle">{d.basis}.</span> : null}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="Nothing needs renewing"
          description={`No document on the register expires in the next ${within} days.`}
        />
      ) : (
        <Section title="Most urgent first">
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Document</TH>
                  <TH>Attached to</TH>
                  <TH>Expires</TH>
                  <TH>Deadline</TH>
                  <TH>State</TH>
                  {canManage ? <TH /> : null}
                </TR>
              </THead>
              <TBody>
                {items.map((d) => (
                  <TR key={d.id}>
                    <TD>
                      <div className="font-medium text-text">{d.title}</div>
                      <div className="text-2xs text-text-subtle">{d.type_label}</div>
                      {consequence(d) ? (
                        <div className="mt-0.5 text-2xs text-warning">{consequence(d)}</div>
                      ) : null}
                    </TD>
                    <TD tone="muted">{OWNER_LABELS[d.owner_type] ?? d.owner_type}</TD>
                    <TD>{day(d.expires_on)}</TD>
                    <TD>
                      <span className={
                        d.days_remaining < 0 ? 'font-semibold text-danger'
                          : d.days_remaining <= 14 ? 'text-warning' : 'text-text-muted'
                      }>
                        {deadlineLabel(d.days_remaining)}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={stateTone(d.state as DocumentState)}>
                        {STATE_LABELS[d.state as DocumentState] ?? d.state}
                      </Badge>
                    </TD>
                    {canManage ? (
                      <TD className="text-right">
                        <Button type="button" variant="secondary" onClick={() => setRenewing(d)}>
                          Renew
                        </Button>
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Section>
      )}

      {renewing ? (
        <RenewDialog
          document={renewing}
          onClose={() => setRenewing(null)}
          onDone={() => {
            setRenewing(null);
            qc.invalidateQueries({ queryKey: ['documents'] });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Renewing records a new document rather than editing the old one's date.
 *
 * The dialog says so, because to somebody looking at an expiry field the
 * obvious action is to type a later date over it — and that would destroy the
 * only record that the organisation was covered last year.
 */
function RenewDialog({
  document, onClose, onDone,
}: {
  document: Row; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = React.useState({
    expires_on: '', issued_on: '', reference_number: '', notes: '',
  });

  const renew = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/documents/${document.id}/renew`, {
        method: 'POST',
        body: {
          expires_on: form.expires_on,
          issued_on: form.issued_on || undefined,
          reference_number: form.reference_number || undefined,
          notes: form.notes || undefined,
        },
      }),
    onSuccess: onDone,
  });

  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-semibold text-text">Renew {document.title}</h3>
        <p className="mt-0.5 text-xs text-text-muted">
          This records a new document that supersedes the current one. The old certificate stays on
          the register and stays readable — an inspector may ask for it.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">New expiry date</span>
          <input type="date" className={field} value={form.expires_on}
            onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Issued on</span>
          <input type="date" className={field} value={form.issued_on}
            onChange={(e) => setForm({ ...form, issued_on: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">New reference</span>
          <input className={field} value={form.reference_number}
            placeholder={document.reference_number ?? 'Unchanged'}
            onChange={(e) => setForm({ ...form, reference_number: e.target.value })} />
        </label>
      </div>

      {renew.isError ? <ErrorCard error={renew.error} /> : null}

      <div className="flex gap-2">
        <Button type="button" variant="primary" loading={renew.isPending}
          disabled={!form.expires_on} onClick={() => renew.mutate()}>
          Record the renewal
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- register */

function Register({
  query, filters, setFilters, summary, canDelete, onDeleted,
}: {
  query: any;
  filters: { category: string; owner_type: string; state: string };
  setFilters: (f: { category: string; owner_type: string; state: string }) => void;
  summary: Row | undefined;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  if (query.isLoading) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorCard error={query.error} onRetry={() => query.refetch()} />;

  const items: Row[] = query.data?.data ?? [];
  const select = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-text">{registerHeadline(summary as any)}</p>
        <div className="grid gap-2 sm:grid-cols-5">
          <Stat label="On the register" value={summary?.total ?? 0} />
          <Stat label="In force" value={summary?.valid ?? 0} tone="success" />
          <Stat label="Expiring" value={summary?.expiring ?? 0}
            tone={(summary?.expiring ?? 0) > 0 ? 'warning' : 'default'} />
          <Stat label="Expired" value={summary?.expired ?? 0}
            tone={(summary?.expired ?? 0) > 0 ? 'danger' : 'default'} />
          <Stat label="Superseded" value={summary?.superseded ?? 0}
            hint="Renewed, and kept for the record" />
        </div>
      </Card>

      <Toolbar>
        <select className={select} value={filters.category}
          onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
          <option value="">Every category</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={select} value={filters.owner_type}
          onChange={(e) => setFilters({ ...filters, owner_type: e.target.value })}>
          <option value="">Attached to anything</option>
          {Object.entries(OWNER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={select} value={filters.state}
          onChange={(e) => setFilters({ ...filters, state: e.target.value })}>
          <option value="">Any state</option>
          {Object.entries(STATE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Toolbar>

      {items.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description="No document on the register matches those filters."
        />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Document</TH>
                <TH>Category</TH>
                <TH>Attached to</TH>
                <TH>Reference</TH>
                <TH>Expires</TH>
                <TH>State</TH>
                {canDelete ? <TH /> : null}
              </TR>
            </THead>
            <TBody>
              {items.map((d) => (
                <TR key={d.id}>
                  <TD>
                    <div className="font-medium text-text">{d.title}</div>
                    <div className="text-2xs text-text-subtle">{d.type_label}</div>
                    {retentionNote(d.retention) ? (
                      <div className="mt-0.5 text-2xs text-text-subtle">{retentionNote(d.retention)}</div>
                    ) : null}
                  </TD>
                  <TD tone="muted">
                    {CATEGORY_LABELS[d.category] ?? d.category}
                  </TD>
                  <TD tone="muted">
                    {OWNER_LABELS[d.owner_type] ?? d.owner_type}
                  </TD>
                  <TD mono>
                    {d.restricted ? (
                      // Listed so its expiry can still be chased; the detail is
                      // withheld rather than the whole row hidden.
                      <span className="text-text-subtle">Restricted</span>
                    ) : (d.reference_number ?? '—')}
                  </TD>
                  <TD>
                    <div>{d.expires_on ? day(d.expires_on) : '—'}</div>
                    <div className="text-2xs text-text-subtle">{deadlineLabel(d.days_remaining)}</div>
                  </TD>
                  <TD className="space-x-1">
                    <Badge tone={stateTone(d.state as DocumentState)}>
                      {STATE_LABELS[d.state as DocumentState] ?? d.state}
                    </Badge>
                    {d.legal_hold ? <Badge tone="warning">Legal hold</Badge> : null}
                  </TD>
                  {canDelete ? (
                    <TD align="right">
                      <DeleteDocumentButton
                        id={String(d.id)} title={String(d.title)} version={Number(d.version)}
                        retention={d.retention} onDeleted={onDeleted}
                      />
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- add */

function AddDocument({ onDone }: { onDone: () => void }) {
  const [form, setForm] = React.useState({
    type_code: '', owner_type: 'organization', owner_id: '', title: '',
    reference_number: '', issuing_authority: '', issued_on: '', expires_on: '',
  });

  const types = useQuery({
    queryKey: ['document-types'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/document-types')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const chosen = types.data?.find((t) => t.code === form.type_code);

  const create = useMutation({
    mutationFn: async () =>
      apiRequest('/api/v1/documents', {
        method: 'POST',
        body: {
          type_code: form.type_code,
          owner_type: form.owner_type,
          owner_id: form.owner_id || undefined,
          title: form.title,
          reference_number: form.reference_number || undefined,
          issuing_authority: form.issuing_authority || undefined,
          issued_on: form.issued_on || undefined,
          expires_on: form.expires_on || undefined,
        },
      }),
    onSuccess: onDone,
  });

  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';
  // The owners a type will accept, so the picker cannot offer a combination
  // the server is going to refuse.
  const owners: string[] = chosen?.owners?.length ? chosen.owners : Object.keys(OWNER_LABELS);

  React.useEffect(() => {
    if (chosen?.owners?.length && !chosen.owners.includes(form.owner_type)) {
      setForm((f) => ({ ...f, owner_type: chosen.owners[0], owner_id: '' }));
    }
  }, [chosen, form.owner_type]);

  return (
    <Card className="mb-4 space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Type</span>
          <Combobox
            value={form.type_code}
            onChange={(code) => setForm({ ...form, type_code: code })}
            isLoading={types.isLoading}
            placeholder="Labour licence, insurance, drawing…"
            options={(types.data ?? []).map((t) => ({
              id: t.code,
              label: t.label,
              hint: CATEGORY_LABELS[t.category] ?? t.category,
            }))}
          />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Title</span>
          <input className={field} value={form.title}
            placeholder="Labour licence — Ameerpet stretch"
            onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Attached to</span>
          <select className={field} value={form.owner_type}
            onChange={(e) => setForm({ ...form, owner_type: e.target.value, owner_id: '' })}>
            {owners.map((o) => <option key={o} value={o}>{OWNER_LABELS[o] ?? o}</option>)}
          </select>
        </label>
        {form.owner_type !== 'organization' ? (
          <label className="space-y-1">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">
              {OWNER_LABELS[form.owner_type]}
            </span>
            <OwnerPicker
              ownerType={form.owner_type}
              value={form.owner_id}
              onChange={(owner_id) => setForm({ ...form, owner_id })}
            />
          </label>
        ) : null}
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Reference number</span>
          <input className={field} value={form.reference_number}
            onChange={(e) => setForm({ ...form, reference_number: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Issuing authority</span>
          <input className={field} value={form.issuing_authority}
            placeholder="Labour Commissioner, Telangana"
            onChange={(e) => setForm({ ...form, issuing_authority: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Issued on</span>
          <input type="date" className={field} value={form.issued_on}
            onChange={(e) => setForm({ ...form, issued_on: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">
            Expires on {chosen?.expiry_required ? <span className="text-danger">(required)</span> : null}
          </span>
          <input type="date" className={field} value={form.expires_on}
            onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
        </label>
      </div>

      {chosen?.blocks_operations ? (
        <Notice tone="warning" title="Work depends on this one">
          {chosen.basis
            ? `${chosen.basis}. It is renewed with ${chosen.notice_days} days of warning.`
            : `Its lapse stops the work it covers. It is renewed with ${chosen.notice_days} days of warning.`}
        </Notice>
      ) : null}

      {create.isError ? <ErrorCard error={create.error} /> : null}

      <Button type="button" variant="primary" loading={create.isPending}
        disabled={!form.type_code || !form.title.trim()} onClick={() => create.mutate()}>
        Add to the register
      </Button>
    </Card>
  );
}

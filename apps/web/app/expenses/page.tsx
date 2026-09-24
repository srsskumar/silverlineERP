'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar, ToolbarSpacer } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Field, Notice, RecordSheet, Section, StatusBadge, Stat } from '@/components/finance/Primitives';
import { DownloadButton } from '@/components/DownloadButton';
import {
  categoryLabel, creditBlockLabel, day, money, percent, PAYMENT_MODES,
  EXPENSE_CATEGORY_LABELS, businessToday } from '@/lib/finance';

/** image/jpeg, image/png, application/pdf — matches ALLOWED_RECEIPT_EXTENSIONS. */
const RECEIPT_ACCEPT = 'image/jpeg,image/png,application/pdf';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/** A File to the base64 body the upload route wants, stripped of its data: prefix. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Row = Record<string, any>;

/**
 * Expense claims (§16).
 *
 * The list leads with what policy allowed rather than what was claimed,
 * because the gap between the two is the only number an approver actually has
 * to decide about. A claim inside policy needs no thought; one above it needs
 * a name against the excess.
 */
export default function ExpensesPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canManage = hasPermission(perms, 'expense.manage');
  const canReadAll = hasPermission(perms, 'expense.read_all');

  const [status, setStatus] = React.useState('');
  const [exceptionsOnly, setExceptionsOnly] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const client = useQueryClient();

  React.useEffect(() => {
    const open = new URLSearchParams(window.location.search).get('open');
    if (open) setSelected(open);
  }, []);

  const list = useQuery({
    queryKey: ['expense-claims', status, exceptionsOnly],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/expense-claims?limit=100${status ? `&status=${status}` : ''}${exceptionsOnly ? '&policy_exception=true' : ''}`,
      )).body as { data: Row[] }).data,
    staleTime: 20_000,
  });

  const refresh = () => void client.invalidateQueries({ queryKey: ['expense-claims'] });
  const rows = list.data ?? [];

  const pending = rows.filter((r) => r.status === 'SUBMITTED');
  const owed = rows
    .filter((r) => r.status === 'APPROVED')
    .reduce((t, r) => t + (Number(r.approved_amount ?? r.total_allowed) - Number(r.reimbursed_amount ?? 0)), 0);

  return (
    <AppShell>
      <PageHeader
        title="Expenses"
        description="Claims, what policy allows, and what is still owed."
        actions={
          <>
            <a
              href="/expenses/policies"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text hover:bg-surface-sunken"
            >
              Policies
            </a>
            {canReadAll ? (
              <a
                href="/expenses/reports"
                className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text hover:bg-surface-sunken"
              >
                Reports
              </a>
            ) : null}
            {canManage ? (
              <Button onClick={() => setCreating(true)}>New claim</Button>
            ) : null}
          </>
        }
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Claims" value={rows.length} />
          <Stat
            label="Awaiting approval"
            value={pending.length}
            hint={pending.length ? money(pending.reduce((t, r) => t + Number(r.total_claimed), 0)) : undefined}
          />
          <Stat
            label="Owed to staff"
            value={money(owed)}
            hint="Approved and not yet paid"
            tone={owed > 0 ? 'warning' : undefined}
          />
          <Stat
            label="Above policy"
            value={rows.filter((r) => Number(r.total_excess) > 0).length}
            tone={rows.some((r) => Number(r.total_excess) > 0) ? 'warning' : undefined}
          />
        </div>

        <Toolbar>
          <select
            aria-label="Status"
            className="max-w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'REIMBURSED'].map((s) => (
              <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={exceptionsOnly}
              onChange={(e) => setExceptionsOnly(e.target.checked)}
            />
            Policy exceptions only
          </label>
          <ToolbarSpacer />
        </Toolbar>

        {list.error ? <ErrorCard error={list.error} onRetry={() => void list.refetch()} /> : null}

        {list.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No claims"
            description={canManage
              ? 'Raise a claim for travel, lodging, fuel or petty site spend.'
              : 'Claims raised by your team will appear here.'}
          />
        ) : (
          <Card>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Claim</TH>
                    <TH>Claimant</TH>
                    <TH>Project</TH>
                    <TH align="right">Claimed</TH>
                    <TH align="right">Allowed</TH>
                    <TH>Status</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {rows.map((c) => {
                    const excess = Number(c.total_excess ?? 0);
                    return (
                      <TR key={String(c.id)}>
                        <TD>
                          <span className="font-mono text-xs font-medium text-text">{c.claim_no}</span>
                          <p className="truncate text-2xs text-text-subtle">{c.purpose}</p>
                        </TD>
                        <TD tone="muted">{c.claimant_username ?? '—'}</TD>
                        <TD tone="subtle">{c.project_code ?? '—'}</TD>
                        <TD align="right" className="text-text-muted">{money(c.total_claimed)}</TD>
                        <TD align="right">
                          <span className={excess > 0 ? 'text-warning' : 'text-text'}>
                            {money(c.approved_amount ?? c.total_allowed)}
                          </span>
                          {excess > 0 ? (
                            <p className="text-2xs text-warning">{money(excess)} over</p>
                          ) : null}
                        </TD>
                        <TD>
                          <StatusBadge status={c.status} />
                          {c.status === 'APPROVED' && Number(c.reimbursed_amount ?? 0) > 0 ? (
                            <p className="text-2xs text-text-subtle">
                              {money(c.reimbursed_amount)} paid
                            </p>
                          ) : null}
                        </TD>
                        <TD align="right">
                          <Button variant="secondary" size="sm" onClick={() => setSelected(String(c.id))}>
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
        <ClaimDetail id={selected} onClose={() => setSelected(null)} onChanged={refresh} />
      ) : null}
      {creating ? (
        <NewClaim onClose={() => setCreating(false)} onCreated={(id) => { refresh(); setCreating(false); setSelected(id); }} />
      ) : null}
    </AppShell>
  );
}

/* ------------------------------------------------------------------ detail */

function ClaimDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canOverride = hasPermission(perms, 'expense.override');
  const canReimburse = hasPermission(perms, 'expense.reimburse');

  const [error, setError] = React.useState<unknown>(null);
  const [reason, setReason] = React.useState('');
  const [overrideReason, setOverrideReason] = React.useState('');
  const [payment, setPayment] = React.useState({ amount: '', paid_on: businessToday(), mode: 'NEFT', reference: '' });
  const [receiptError, setReceiptError] = React.useState<unknown>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const detail = useQuery({
    queryKey: ['expense-claim', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/expense-claims/${id}`)).data,
  });
  const c = detail.data;
  const version = () => ({ 'If-Match': String(c!.version) });
  const after = () => { setError(null); setReason(''); setOverrideReason(''); void detail.refetch(); onChanged(); };

  const receipts = useQuery({
    queryKey: ['expense-claim-receipts', id],
    queryFn: async () => (await apiRequest<Row[]>(`/api/v1/expense-claims/${id}/receipts`)).data,
  });

  const uploadReceipt = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_RECEIPT_BYTES) throw new Error('File exceeds the 10MB limit');
      const content_base64 = await readFileAsBase64(file);
      return apiRequest(`/api/v1/expense-claims/${id}/receipts`, {
        method: 'POST', body: { file_name: file.name, content_base64 },
      });
    },
    onSuccess: () => { setReceiptError(null); void receipts.refetch(); },
    onError: setReceiptError,
  });

  const removeReceipt = useMutation({
    mutationFn: async (receiptId: string) =>
      apiRequest(`/api/v1/expense-claims/${id}/receipts/${receiptId}`, { method: 'DELETE' }),
    onSuccess: () => { setReceiptError(null); void receipts.refetch(); },
    onError: setReceiptError,
  });

  const submit = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/expense-claims/${id}/submit`, { method: 'POST', headers: version(), body: {} }),
    onSuccess: after, onError: setError,
  });
  const withdraw = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/expense-claims/${id}/withdraw`, { method: 'POST', headers: version(), body: { reason: reason.trim() } }),
    onSuccess: after, onError: setError,
  });
  const decide = useMutation({
    mutationFn: async (status: 'APPROVED' | 'REJECTED') =>
      apiRequest(`/api/v1/expense-claims/${id}/decision`, {
        method: 'POST', headers: version(),
        body: {
          status,
          ...(status === 'REJECTED' ? { reason: reason.trim() } : {}),
          ...(overrideReason.trim() ? { override_reason: overrideReason.trim() } : {}),
        },
      }),
    onSuccess: after, onError: setError,
  });
  const reimburse = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/expense-claims/${id}/reimburse`, {
        method: 'POST',
        body: {
          amount: Number(payment.amount), paid_on: payment.paid_on,
          mode: payment.mode, ...(payment.reference.trim() ? { reference: payment.reference.trim() } : {}),
        },
      }),
    onSuccess: () => { setPayment((p) => ({ ...p, amount: '', reference: '' })); after(); },
    onError: setError,
  });

  const lines: Row[] = c?.lines ?? [];
  const payments: Row[] = c?.reimbursements ?? [];
  const excess = Number(c?.total_excess ?? 0);
  const isOwn = c && (String(c.claimant_user_id) === session?.user?.id || String(c.requested_by) === session?.user?.id);
  const allowed: string[] = c?.allowed_statuses ?? [];
  const approvalPending = c?.approval && c.approval.status !== 'APPROVED';

  return (
    <RecordSheet
      open
      onClose={onClose}
      wide
      title={c?.claim_no ?? 'Claim'}
      subtitle={c ? `${c.purpose} · ${day(c.claim_date)}` : undefined}
    >
      {detail.isLoading || !c ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Field label="Status" value={<StatusBadge status={c.status} size="md" />} />
            <Field label="Claimed" value={money(c.total_claimed)} />
            <Field
              label="Allowed"
              value={money(c.approved_amount ?? c.total_allowed)}
              tone={excess > 0 ? 'danger' : undefined}
            />
            <Field label="Claimant" value={c.claimant_username ?? '—'} />
          </dl>

          {excess > 0 ? (
            <div className="mt-4">
              <Notice
                tone={c.status === 'APPROVED' ? 'info' : 'warning'}
                title={`${money(excess)} above policy`}
              >
                {c.override_reason ? (
                  <>
                    Allowed by {c.override_by_username ?? 'an administrator'}: “{c.override_reason}”
                  </>
                ) : (
                  <>Approving this needs the expense override permission and a stated reason, which is recorded on the claim.</>
                )}
              </Notice>
            </div>
          ) : null}

          {c.rejection_reason ? (
            <div className="mt-4"><Notice tone="danger" title="Rejected">{c.rejection_reason}</Notice></div>
          ) : null}
          {c.withdrawn_reason ? (
            <div className="mt-4"><Notice tone="info" title="Withdrawn">{c.withdrawn_reason}</Notice></div>
          ) : null}

          <Section title="Lines">
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Category</TH>
                    <TH>Date</TH>
                    <TH align="right">Claimed</TH>
                    <TH align="right">Allowed</TH>
                    <TH>Tax</TH>
                    <TH>Notes</TH>
                  </TR>
                </THead>
                <TBody>
                  {lines.map((l) => {
                    const block = creditBlockLabel(l.credit_block_reason);
                    return (
                      <TR key={String(l.id)}>
                        <TD>
                          <span className="text-text">{categoryLabel(l.category)}</span>
                          <p className="truncate text-2xs text-text-subtle">{l.description}</p>
                          {l.billable_to_client ? (
                            <Badge tone="info" size="sm">Billable</Badge>
                          ) : null}
                        </TD>
                        <TD tone="muted">
                          {day(l.expense_date)}
                          {l.units ? <p className="text-text-subtle">{Number(l.units)} days</p> : null}
                        </TD>
                        <TD align="right" className="text-text-muted">{money(l.amount)}</TD>
                        <TD align="right" className={Number(l.excess_amount) > 0 ? 'text-warning' : ''}>
                          {money(l.allowed_amount)}
                        </TD>
                        <TD>
                          {l.gst_amount ? (
                            <>
                              <span className="text-text-muted">{money(l.gst_amount)}</span>
                              <p className={l.gst_creditable ? 'text-success' : 'text-text-subtle'}>
                                {l.gst_creditable ? 'Creditable' : block ?? 'Not creditable'}
                              </p>
                            </>
                          ) : (
                            <span className="text-text-subtle">—</span>
                          )}
                        </TD>
                        <TD tone="warning" className="max-w-56">
                          {l.exception_notes ? (
                            <span className="flex items-start gap-1">
                              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                              <span className="whitespace-normal">{l.exception_notes}</span>
                            </span>
                          ) : null}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
          </Section>

          <Section title="Receipts">
            {receipts.isLoading ? <Skeleton className="h-10 w-full" /> : null}
            {receipts.data?.length ? (
              <ul className="space-y-1.5 text-xs">
                {receipts.data.map((r) => (
                  <li key={String(r.id)} className="flex items-center justify-between gap-2">
                    <span className="text-text-muted">
                      {r.file_name}
                      <span className="ml-1 text-2xs text-text-subtle">{formatBytes(Number(r.file_size))}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <DownloadButton
                        path={`/api/v1/expense-claims/${id}/receipts/${r.id}/download`}
                        name={r.file_name}
                        label="View"
                      />
                      {['DRAFT', 'SUBMITTED'].includes(String(c.status)) && isOwn ? (
                        <Button
                          variant="ghost"
                          loading={removeReceipt.isPending}
                          onClick={() => removeReceipt.mutate(String(r.id))}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-subtle">No receipts attached yet.</p>
            )}

            {['DRAFT', 'SUBMITTED'].includes(String(c.status)) && isOwn ? (
              <div className="mt-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={RECEIPT_ACCEPT}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadReceipt.mutate(file);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                />
                <p className="mt-1 text-2xs text-text-subtle">
                  JPEG, PNG or PDF, up to 10MB each, at most 5 receipts per claim.
                </p>
                {uploadReceipt.isPending ? <p className="text-2xs text-text-subtle">Uploading…</p> : null}
              </div>
            ) : null}

            {receiptError ? <div className="mt-2"><ErrorCard error={receiptError} /></div> : null}
          </Section>

          {c.approval ? (
            <Section title="Approval">
              <div className="flex items-center gap-2 text-sm">
                <StatusBadge status={c.approval.status} />
                <a
                  href={`/approvals?open=${c.approval.id}`}
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  Open the ladder →
                </a>
              </div>
            </Section>
          ) : null}

          {c.status === 'APPROVED' || payments.length > 0 ? (
            <Section title="Reimbursement">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Approved" value={money(c.approved_amount ?? c.total_allowed)} />
                <Stat label="Paid" value={money(c.reimbursement?.paid ?? 0)} />
                <Stat
                  label="Outstanding"
                  value={money(c.reimbursement?.outstanding ?? 0)}
                  tone={Number(c.reimbursement?.outstanding ?? 0) > 0 ? 'warning' : 'success'}
                />
              </div>

              {payments.length > 0 ? (
                <ul className="mt-3 space-y-1.5 text-xs">
                  {payments.map((p) => (
                    <li key={String(p.id)} className="flex items-center justify-between gap-2">
                      <span className="text-text-muted">
                        {money(p.amount)} · {p.mode}
                        {p.reference ? <span className="ml-1 font-mono text-text-subtle">{p.reference}</span> : null}
                      </span>
                      <span className="text-text-subtle">{day(p.paid_on)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {canReimburse && c.status === 'APPROVED' ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-5">
                  <input
                    className="sm:col-span-1"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Amount"
                    value={payment.amount}
                    onChange={(e) => setPayment((p) => ({ ...p, amount: e.target.value }))}
                  />
                  <input
                    type="date"
                    value={payment.paid_on}
                    onChange={(e) => setPayment((p) => ({ ...p, paid_on: e.target.value }))}
                  />
                  <select value={payment.mode} onChange={(e) => setPayment((p) => ({ ...p, mode: e.target.value }))}>
                    {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input
                    placeholder="UTR / cheque no"
                    value={payment.reference}
                    onChange={(e) => setPayment((p) => ({ ...p, reference: e.target.value }))}
                  />
                  <Button
                    loading={reimburse.isPending}
                    disabled={!Number(payment.amount)}
                    onClick={() => reimburse.mutate()}
                  >
                    Record payment
                  </Button>
                </div>
              ) : null}
              <p className="mt-2 text-2xs text-text-subtle">
                A claim closes only when the balance reaches zero, so a part payment leaves it approved.
              </p>
            </Section>
          ) : null}

          {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

          {['DRAFT', 'SUBMITTED', 'REJECTED'].includes(String(c.status)) ? (
            <Section title="Actions">
              <textarea
                className="w-full rounded-md border border-border bg-surface p-2 text-sm"
                rows={2}
                maxLength={1000}
                placeholder="Reason — required to reject or withdraw"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {excess > 0 && canOverride && c.status === 'SUBMITTED' ? (
                <input
                  className="mt-2 w-full"
                  maxLength={1000}
                  placeholder="Why the excess is allowed (recorded against your name)"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              ) : null}

              <div className="mt-2 flex flex-wrap gap-2">
                {allowed.includes('SUBMITTED') && isOwn ? (
                  <Button loading={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>
                ) : null}
                {c.status === 'SUBMITTED' ? (
                  <>
                    <Button
                      loading={decide.isPending}
                      disabled={approvalPending || (excess > 0 && (!canOverride || !overrideReason.trim()))}
                      onClick={() => decide.mutate('APPROVED')}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="danger"
                      loading={decide.isPending}
                      disabled={!reason.trim()}
                      onClick={() => decide.mutate('REJECTED')}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
                {allowed.includes('WITHDRAWN') && isOwn ? (
                  <Button variant="secondary" loading={withdraw.isPending} disabled={!reason.trim()} onClick={() => withdraw.mutate()}>
                    Withdraw
                  </Button>
                ) : null}
              </div>

              {approvalPending ? (
                <p className="mt-1.5 text-2xs text-text-subtle">
                  Every level of the ladder has to decide before the claim itself can be approved.
                </p>
              ) : null}
            </Section>
          ) : null}
        </>
      )}
    </RecordSheet>
  );
}

/* --------------------------------------------------------------- new claim */

interface DraftLine {
  category: string;
  expense_date: string;
  description: string;
  amount: string;
  units: string;
  vendor_name: string;
  invoice_no: string;
  vendor_gstin: string;
  gst_amount: string;
  billable_to_client: boolean;
}

const emptyLine = (): DraftLine => ({
  category: 'TRAVEL',
  expense_date: businessToday(),
  description: '',
  amount: '',
  units: '',
  vendor_name: '',
  invoice_no: '',
  vendor_gstin: '',
  gst_amount: '',
  billable_to_client: false,
});

/**
 * Raising a claim, with the policy verdict shown while it is still being typed.
 *
 * §16.2 asks for quick capture so field staff are not blocked by a long form.
 * The more useful half of that is telling them a bill is over the limit at the
 * counter rather than a week later when finance rejects it, so every edit
 * re-evaluates against the policies in force on the line's own date.
 */
function NewClaim({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [claimNo, setClaimNo] = React.useState(`EXP-${Date.now().toString().slice(-6)}`);
  const [claimDate, setClaimDate] = React.useState(businessToday());
  const [purpose, setPurpose] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = React.useState<unknown>(null);

  const projects = useQuery({
    queryKey: ['projects', 'for-expense'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const payloadLines = lines
    .filter((l) => l.description.trim() && Number(l.amount) > 0)
    .map((l) => ({
      category: l.category,
      expense_date: l.expense_date,
      description: l.description.trim(),
      amount: Number(l.amount),
      ...(l.units ? { units: Number(l.units) } : {}),
      ...(l.vendor_name.trim() ? { vendor_name: l.vendor_name.trim() } : {}),
      ...(l.invoice_no.trim() ? { invoice_no: l.invoice_no.trim() } : {}),
      ...(l.vendor_gstin.trim() ? { vendor_gstin: l.vendor_gstin.trim().toUpperCase() } : {}),
      ...(l.gst_amount ? { gst_amount: Number(l.gst_amount) } : {}),
      billable_to_client: l.billable_to_client,
    }));

  // Debounced so a five-line claim does not fire a request per keystroke.
  const [evalKey, setEvalKey] = React.useState('');
  React.useEffect(() => {
    const body = JSON.stringify(payloadLines);
    const t = setTimeout(() => setEvalKey(body), 400);
    return () => clearTimeout(t);
  }, [JSON.stringify(payloadLines)]);

  const evaluation = useQuery({
    queryKey: ['expense-evaluate', evalKey],
    queryFn: async () =>
      (await apiRequest<Row>('/api/v1/expense-claims/evaluate', {
        method: 'POST', body: { lines: JSON.parse(evalKey) },
      })).data,
    enabled: evalKey.length > 2 && JSON.parse(evalKey || '[]').length > 0,
  });

  const create = useMutation({
    mutationFn: async () =>
      apiRequest<Row>('/api/v1/expense-claims', {
        method: 'POST',
        body: {
          claim_no: claimNo.trim(),
          claim_date: claimDate,
          purpose: purpose.trim(),
          ...(projectId ? { project_id: projectId } : {}),
          lines: payloadLines,
        },
      }),
    onSuccess: (res) => onCreated(String(res.data.id)),
    onError: setError,
  });

  const set = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const ready = claimNo.trim() && purpose.trim() && payloadLines.length > 0;
  const billableWithoutProject = payloadLines.some((l) => l.billable_to_client) && !projectId;

  return (
    <RecordSheet open onClose={onClose} wide title="New expense claim" subtitle="Policy is checked as you type.">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-muted">
          Claim number
          <input className="mt-1 w-full" value={claimNo} maxLength={50} onChange={(e) => setClaimNo(e.target.value)} />
        </label>
        <label className="text-xs text-text-muted">
          Claim date
          <input type="date" className="mt-1 w-full" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} />
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">
          Purpose
          <input
            className="mt-1 w-full"
            maxLength={1000}
            placeholder="Site visit to the Mandal office"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">
          Project (needed for any billable line)
          <select className="mt-1 w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Not charged to a project</option>
            {(projects.data ?? []).map((p) => (
              <option key={String(p.id)} value={String(p.id)}>{p.code} — {p.name}</option>
            ))}
          </select>
        </label>
      </div>

      <Section
        title="Lines"
        action={
          <Button variant="secondary" size="sm" onClick={() => setLines((p) => [...p, emptyLine()])}>
            Add line
          </Button>
        }
      >
        <div className="space-y-3">
          {lines.map((l, i) => {
            const verdict = evaluation.data?.lines?.[i];
            const isPerDiem = l.category === 'PER_DIEM';
            return (
              <div key={i} className="rounded-lg border border-border bg-surface-sunken p-3">
                <div className="grid gap-2 sm:grid-cols-4">
                  <select value={l.category} onChange={(e) => set(i, { category: e.target.value })}>
                    {Object.entries(EXPENSE_CATEGORY_LABELS).map(([code, label]) => (
                      <option key={code} value={code}>{label}</option>
                    ))}
                  </select>
                  <input type="date" value={l.expense_date} onChange={(e) => set(i, { expense_date: e.target.value })} />
                  <input
                    className="sm:col-span-2"
                    placeholder="Description"
                    maxLength={500}
                    value={l.description}
                    onChange={(e) => set(i, { description: e.target.value })}
                  />
                  <input
                    type="number" min="0" step="0.01" placeholder="Amount"
                    value={l.amount}
                    onChange={(e) => set(i, { amount: e.target.value })}
                  />
                  {isPerDiem ? (
                    <input
                      type="number" min="0" step="1" placeholder="Days"
                      value={l.units}
                      onChange={(e) => set(i, { units: e.target.value })}
                    />
                  ) : (
                    <>
                      <input
                        placeholder="Vendor"
                        value={l.vendor_name}
                        onChange={(e) => set(i, { vendor_name: e.target.value })}
                      />
                      <input
                        placeholder="Invoice no"
                        value={l.invoice_no}
                        onChange={(e) => set(i, { invoice_no: e.target.value })}
                      />
                      <input
                        placeholder="Vendor GSTIN"
                        maxLength={15}
                        value={l.vendor_gstin}
                        onChange={(e) => set(i, { vendor_gstin: e.target.value })}
                      />
                    </>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {!isPerDiem ? (
                    <input
                      className="max-w-32"
                      type="number" min="0" step="0.01" placeholder="GST amount"
                      value={l.gst_amount}
                      onChange={(e) => set(i, { gst_amount: e.target.value })}
                    />
                  ) : null}
                  <label className="flex items-center gap-1.5 text-xs text-text-muted">
                    <input
                      type="checkbox"
                      checked={l.billable_to_client}
                      onChange={(e) => set(i, { billable_to_client: e.target.checked })}
                    />
                    Charge to the project
                  </label>
                  {lines.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>

                {verdict ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs">
                    <Badge tone={verdict.policyException ? 'warning' : 'success'} size="sm">
                      {verdict.policyException ? 'Needs an override' : 'Within policy'}
                    </Badge>
                    <span className="text-text-muted">Allowed {money(verdict.allowedAmount)}</span>
                    {Number(verdict.excessAmount) > 0 ? (
                      <span className="text-warning">{money(verdict.excessAmount)} over</span>
                    ) : null}
                    {(verdict.exceptions ?? []).map((x: string, k: number) => (
                      <span key={k} className="w-full text-warning">{x}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Section>

      {evaluation.data ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Claimed" value={money(evaluation.data.totalClaimed)} />
          <Stat
            label="Policy allows"
            value={money(evaluation.data.totalAllowed)}
            tone={Number(evaluation.data.totalExcess) > 0 ? 'warning' : 'success'}
          />
          <Stat
            label="Input credit"
            value={money(evaluation.data.creditableGst)}
            hint={Number(evaluation.data.blockedGst) > 0 ? `${money(evaluation.data.blockedGst)} blocked` : undefined}
          />
          <Stat label="To the project" value={money(evaluation.data.billableToProject)} />
        </div>
      ) : null}

      {billableWithoutProject ? (
        <div className="mt-4">
          <Notice title="A billable line needs a project">
            Choose the project that bears the cost, or clear the billable flag.
          </Notice>
        </div>
      ) : null}

      {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

      <div className="mt-5 flex gap-2">
        <Button loading={create.isPending} disabled={!ready || billableWithoutProject} onClick={() => create.mutate()}>
          Create draft
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
      <p className="mt-2 text-2xs text-text-subtle">
        A draft is saved first so receipts can be attached and the figures checked before it goes for approval.
      </p>
    </RecordSheet>
  );
}

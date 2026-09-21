'use client';

import Link from 'next/link';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { statusLabel } from '@/lib/board-visuals';
import { day } from '@/lib/finance';

type Row = Record<string, any>;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? inr.format(Number(v)) : '—');

/** Status → tone. Only the outcomes get colour; the working states stay quiet. */
function statusTone(status: string): string {
  if (status === 'AWARDED') return 'bg-success-subtle text-success';
  if (status === 'REJECTED' || status === 'CANCELLED') return 'bg-danger-subtle text-danger';
  if (status === 'SUBMITTED' || status === 'UNDER_EVALUATION') return 'bg-info-subtle text-info';
  if (status === 'SELECTED') return 'bg-warning-subtle text-warning';
  return 'bg-surface-sunken text-text-muted';
}

export default function TendersPage() {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState('');
  const client = useQueryClient();

  const list = useQuery({
    queryKey: ['tenders', status],
    queryFn: async () =>
      (await apiRequestRaw(`/api/v1/tenders?limit=100&sort=closing${status ? `&status=${status}` : ''}`)).body as { data: Row[] },
    staleTime: 30_000,
  });
  const rows = list.data?.data ?? [];

  return (
    <AppShell>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-text">Tenders</h1>
          <p className="hidden text-xs text-text-subtle sm:block">Bids in flight, by closing date.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Status"
            className="max-w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {['DRAFT','PUBLISHED','IN_PROGRESS','SUBMITTED','UNDER_EVALUATION','CLARIFICATION_REQUIRED','SELECTED','REJECTED','AWARDED','CANCELLED']
              .map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <Link href="/tenders/new" className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-fg hover:bg-primary-hover">
            + New tender
          </Link>
        </div>
      </div>

      {list.error ? <div className="mt-3"><ErrorCard error={list.error} onRetry={() => void list.refetch()} /></div> : null}

      {list.isLoading ? (
        <Skeleton className="mt-3 h-80 w-full" />
      ) : rows.length === 0 ? (
        <div className="mt-3"><EmptyState title="No tenders" description="Tenders created here convert into projects once awarded." /></div>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-wide text-text-subtle">
                <th className="p-3 font-medium">Tender</th>
                <th className="p-3 font-medium">Client</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Closing</th>
                <th className="p-3 text-right font-medium">Value</th>
                <th className="p-3 font-medium">Eligibility</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const outstanding = Number(t.outstanding_required ?? 0);
                const closingSoon =
                  t.closing_date &&
                  !['AWARDED','REJECTED','CANCELLED'].includes(String(t.status)) &&
                  new Date(String(t.closing_date)).getTime() - Date.now() < 7 * 86_400_000;
                return (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-sunken">
                    <td className="p-3">
                      <span className="font-medium text-text">{t.tender_no}</span>
                      {t.reference_number ? <span className="ml-2 font-mono text-2xs text-text-subtle">{t.reference_number}</span> : null}
                      {t.department ? <p className="text-2xs text-text-subtle">{t.department}</p> : null}
                    </td>
                    <td className="p-3 text-text-muted">{t.client_name ?? '—'}</td>
                    <td className="p-3">
                      <span className={`rounded px-1.5 py-0.5 text-2xs font-semibold ${statusTone(String(t.status))}`}>
                        {statusLabel(String(t.status))}
                      </span>
                    </td>
                    <td className={`p-3 tabular-nums ${closingSoon ? 'font-medium text-danger' : 'text-text-muted'}`}>
                      {day(t.closing_date)}
                    </td>
                    <td className="p-3 text-right tabular-nums text-text-muted">{money(t.bid_value ?? t.estimated_value)}</td>
                    <td className="p-3">
                      {outstanding > 0 ? (
                        <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-2xs font-semibold text-warning">
                          {outstanding} outstanding
                        </span>
                      ) : (
                        <span className="text-2xs text-text-subtle">Complete</span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <Button variant="secondary" onClick={() => setSelected(String(t.id))}>Open</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <TenderDetail
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={() => void client.invalidateQueries({ queryKey: ['tenders'] })}
        />
      ) : null}
    </AppShell>
  );
}

function TenderDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { session } = useAuth();
  const canOverride = hasPermission({ permissions: session?.permissions }, 'tender.override');
  const canConvert = hasPermission({ permissions: session?.permissions }, 'tender.convert');

  const detail = useQuery({
    queryKey: ['tender', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/tenders/${id}`)).data,
  });
  const [error, setError] = React.useState<unknown>(null);
  const [overrideReason, setOverrideReason] = React.useState('');

  const move = useMutation({
    mutationFn: async (status: string) =>
      apiRequest(`/api/v1/tenders/${id}/status`, {
        method: 'POST',
        headers: { 'If-Match': String(detail.data!.version) },
        body: { status, ...(overrideReason.trim() ? { override_reason: overrideReason.trim() } : {}) },
      }),
    onSuccess: () => { setError(null); setOverrideReason(''); void detail.refetch(); onChanged(); },
    onError: setError,
  });

  const t = detail.data;
  const allowed: string[] = t?.allowed_statuses ?? [];
  const outstanding = Number(t?.outstanding_required ?? 0);
  // The gate applies to these two moves only (§8.6, §8.11).
  const gated = (status: string) => ['SUBMITTED', 'AWARDED'].includes(status) && outstanding > 0;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Tender detail"
        className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-surface p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {detail.isLoading || !t ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-text">{t.tender_no}</h2>
                <p className="mt-0.5 text-2xs text-text-subtle">{t.department ?? t.client_name ?? ''}</p>
              </div>
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <F label="Status" value={statusLabel(String(t.status))} />
              <F label="Type" value={statusLabel(String(t.tender_type))} />
              <F label="Estimated" value={money(t.estimated_value)} />
              <F label="Bid" value={money(t.bid_value)} />
              <F label="Closing" value={day(t.closing_date)} />
              <F label="Submission" value={day(t.submission_date)} />
            </dl>

            {/* §8.3 the project's status is shown, never derived from the tender. */}
            {t.project ? (
              <p className="mt-4 rounded-lg border border-border bg-surface-sunken p-3 text-sm">
                Linked project <span className="font-medium">{t.project.code}</span> — {t.project.name}
                <span className="ml-2 text-2xs text-text-subtle">({statusLabel(String(t.project.status))})</span>
              </p>
            ) : null}

            {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

            <Section title="Eligibility">
              {(t.eligibility ?? []).length === 0 ? (
                <p className="text-sm text-text-muted">No checklist items recorded.</p>
              ) : (
                <ul className="space-y-1.5">
                  {(t.eligibility as Row[]).map((item) => {
                    const done = ['READY', 'SUBMITTED'].includes(String(item.item_status));
                    return (
                      <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className={done ? 'text-text-muted line-through' : 'text-text'}>
                          {item.requirement_name}
                          {item.is_required ? <span className="ml-1 text-danger">*</span> : null}
                        </span>
                        <span className={`rounded px-1.5 py-0.5 text-2xs font-semibold ${done ? 'bg-success-subtle text-success' : 'bg-warning-subtle text-warning'}`}>
                          {statusLabel(String(item.item_status))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>

            {(t.corrigenda ?? []).length > 0 ? (
              <Section title="Corrigenda">
                <ol className="space-y-2">
                  {(t.corrigenda as Row[]).map((c) => (
                    <li key={c.id} className="border-l-2 border-border pl-3 text-sm">
                      <p className="text-xs font-medium text-text">{c.corrigendum_no} · {day(c.date_issued)}</p>
                      <p className="mt-0.5 text-text-muted">{c.summary}</p>
                      {/* §8.5: the prior value is kept, so show what actually moved. */}
                      {Object.keys(c.prior_values ?? {}).length > 0 ? (
                        <p className="mt-1 text-2xs text-text-subtle">
                          Was: {Object.entries(c.prior_values as Record<string, unknown>)
                            .map(([k, v]) => `${k.replaceAll('_', ' ')} ${v ? String(v).slice(0, 10) : '—'}`)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Section>
            ) : null}

            {(t.instruments ?? []).length > 0 ? (
              <Section title="EMD and guarantees">
                <ul className="space-y-1.5 text-sm">
                  {(t.instruments as Row[]).map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2">
                      <span className="text-text">{statusLabel(String(i.instrument_type))} · {money(i.amount)}</span>
                      <span className="text-2xs text-text-subtle">expires {day(i.expiry_date)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {allowed.length > 0 ? (
              <Section title="Move to">
                {allowed.some(gated) ? (
                  <div className="mb-2 rounded-lg border border-warning/40 bg-warning-subtle p-3">
                    <p className="text-xs text-warning">
                      {outstanding} required eligibility item{outstanding === 1 ? '' : 's'} outstanding.
                      {canOverride
                        ? ' Submitting or awarding needs an override reason, which is recorded on the tender.'
                        : ' Complete them first — overriding needs a permission you do not hold.'}
                    </p>
                    {canOverride ? (
                      <input
                        className="mt-2 w-full rounded-md border border-border p-2 text-sm"
                        placeholder="Override reason"
                        value={overrideReason}
                        maxLength={2000}
                        onChange={(e) => setOverrideReason(e.target.value)}
                      />
                    ) : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {allowed.map((status) => (
                    <Button
                      key={status}
                      variant="secondary"
                      loading={move.isPending}
                      disabled={gated(status) && (!canOverride || !overrideReason.trim())}
                      onClick={() => move.mutate(status)}
                    >
                      {statusLabel(status)}
                    </Button>
                  ))}
                </div>
              </Section>
            ) : null}

            {/* §8.7 the single hand-off point into the project domain. */}
            {t.status === 'AWARDED' && !t.project && canConvert ? (
              <Section title="Create the project">
                <p className="mb-2 text-sm text-text-muted">
                  Carries the client, contract value and work order across, and keeps the tender linked for traceability.
                </p>
                <a
                  href={`/tenders/convert?id=${id}`}
                  className="inline-block rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover"
                >
                  Convert to project
                </a>
              </Section>
            ) : null}
          </>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

function F({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className="mt-0.5 tabular-nums text-text">{value}</dd>
    </div>
  );
}

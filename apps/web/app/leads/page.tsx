'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { statusLabel } from '@/lib/board-visuals';

type Row = Record<string, any>;

/**
 * §7.2 pipeline stages, in the order the spec lists them. Terminal stages sit
 * after the live ones so the board reads left to right as work progressing.
 */
const STAGES = [
  { code: 'NEW', hue: 'var(--status-neutral)' },
  { code: 'CONTACTED', hue: 'var(--status-todo)' },
  { code: 'QUALIFIED', hue: 'var(--status-progress)' },
  { code: 'TENDER_IDENTIFIED', hue: 'var(--status-review)' },
  { code: 'CONVERTED', hue: 'var(--status-done)' },
  { code: 'LOST', hue: 'var(--status-blocked)' },
  { code: 'DISQUALIFIED', hue: 'var(--status-neutral)' },
] as const;

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? inr.format(n) : '—';
}

export default function LeadsPage() {
  const client = useQueryClient();
  const [selected, setSelected] = React.useState<string | null>(null);

  const leads = useQuery({
    queryKey: ['leads'],
    queryFn: async () => (await apiRequestRaw('/api/v1/leads?limit=100')).body as { data: Row[] },
    staleTime: 30_000,
  });
  const pipeline = useQuery({
    queryKey: ['leads', 'pipeline'],
    queryFn: async () => (await apiRequest<Row[]>('/api/v1/leads/pipeline')).data,
    staleTime: 30_000,
  });

  const rows = leads.data?.data ?? [];
  const byStage = React.useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const s of STAGES) map.set(s.code, []);
    for (const r of rows) {
      const list = map.get(String(r.stage));
      if (list) list.push(r);
    }
    return map;
  }, [rows]);

  const totals = React.useMemo(() => {
    const map = new Map<string, { count: number; value: number }>();
    for (const r of pipeline.data ?? []) {
      map.set(String(r.stage), { count: Number(r.count), value: Number(r.value) });
    }
    return map;
  }, [pipeline.data]);

  return (
    <AppShell>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-text">Pipeline</h1>
          <p className="hidden text-xs text-text-subtle sm:block">
            Leads from first contact through to a tender or proposal.
          </p>
        </div>
        <a href="/leads/new" className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-fg hover:bg-primary-hover">
          + New lead
        </a>
      </div>

      {leads.error ? <div className="mt-3"><ErrorCard error={leads.error} onRetry={() => void leads.refetch()} /></div> : null}

      {leads.isLoading ? (
        <Skeleton className="mt-3 h-96 w-full" />
      ) : rows.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No leads yet"
            description="A lead is the first record in the chain — it becomes an opportunity, then a tender or proposal, then a project."
          />
        </div>
      ) : (
        <div className="mt-3 grid auto-cols-[260px] grid-flow-col gap-3 overflow-x-auto pb-2">
          {STAGES.map(({ code, hue }) => {
            const list = byStage.get(code) ?? [];
            const total = totals.get(code);
            return (
              <section
                key={code}
                aria-label={`Stage ${statusLabel(code)}`}
                style={{ ['--col' as string]: hue }}
                className="flex min-h-[140px] flex-col rounded-xl border border-border bg-surface-sunken/70"
              >
                <header className="flex items-center gap-2 px-3 pb-2 pt-2.5">
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: 'var(--col)' }} />
                  <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{statusLabel(code)}</h2>
                  <span className="rounded-full bg-surface px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-text-muted">
                    {list.length}
                  </span>
                </header>
                {/* Stage value is the number the §7.5 pipeline report is built on. */}
                <p className="px-3 pb-1.5 text-2xs tabular-nums text-text-subtle">
                  {total && total.value > 0 ? money(total.value) : '—'}
                </p>
                <div aria-hidden="true" className="mx-3 h-px" style={{ backgroundColor: 'var(--col)', opacity: 0.45 }} />
                <div className="flex flex-col gap-2 p-2">
                  {list.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} onOpen={() => setSelected(lead.id)} />
                  ))}
                  {list.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-2xs text-text-subtle">
                      Nothing here
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {selected ? (
        <LeadDetail
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { void client.invalidateQueries({ queryKey: ['leads'] }); }}
        />
      ) : null}
    </AppShell>
  );
}

function LeadCard({ lead, onOpen }: { lead: Row; onOpen: () => void }) {
  const overdue =
    lead.next_follow_up_date &&
    new Date(String(lead.next_follow_up_date)) < new Date(new Date().toDateString());
  return (
    <article className="group relative overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-colors hover:border-border-strong">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: 'var(--col)' }} />
      <button type="button" onClick={onOpen} className="block w-full px-2.5 pb-2 pt-2.5 text-left">
        <p className="text-sm font-medium leading-snug text-text">{lead.organization_name}</p>
        <p className="mt-0.5 font-mono text-2xs text-text-subtle">{lead.lead_no}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-text-subtle">
          <span className="rounded bg-surface-sunken px-1.5 py-0.5">{statusLabel(String(lead.lead_type))}</span>
          <span className="tabular-nums">{money(lead.estimated_value)}</span>
          {lead.owner_username ? <span className="truncate">{lead.owner_username}</span> : null}
          {lead.next_follow_up_date ? (
            <span className={overdue ? 'font-medium text-danger' : ''}>
              {overdue ? 'Follow-up due ' : 'Follow up '}
              {new Date(String(lead.next_follow_up_date)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          ) : null}
        </div>
      </button>
    </article>
  );
}

/** Detail drawer: timeline, stage moves and opportunity promotion. */
function LeadDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/leads/${id}`)).data,
  });
  const [error, setError] = React.useState<unknown>(null);
  const [lostReason, setLostReason] = React.useState('');

  const move = useMutation({
    mutationFn: async (stage: string) => {
      const lead = detail.data!;
      return apiRequest(`/api/v1/leads/${id}/stage`, {
        method: 'POST',
        headers: { 'If-Match': String(lead.version) },
        body: { stage, ...(['LOST', 'DISQUALIFIED'].includes(stage) ? { lost_reason: lostReason } : {}) },
      });
    },
    onSuccess: () => { setError(null); void detail.refetch(); onChanged(); },
    onError: setError,
  });

  const lead = detail.data;
  const allowed: string[] = lead?.allowed_stages ?? [];
  const needsReason = (stage: string) => ['LOST', 'DISQUALIFIED'].includes(stage);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Lead detail"
        className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-surface p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {detail.isLoading || !lead ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-text">{lead.organization_name}</h2>
                <p className="mt-0.5 font-mono text-2xs text-text-subtle">{lead.lead_no}</p>
              </div>
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label="Stage" value={statusLabel(String(lead.stage))} />
              <Field label="Type" value={statusLabel(String(lead.lead_type))} />
              <Field label="Source" value={statusLabel(String(lead.source))} />
              <Field label="Estimated value" value={money(lead.estimated_value)} />
              {lead.lost_reason ? <Field label="Reason" value={String(lead.lost_reason)} wide /> : null}
            </dl>

            {error ? <div className="mt-4"><ErrorCard error={error} /></div> : null}

            {allowed.length > 0 ? (
              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Move to</h3>
                {allowed.some(needsReason) ? (
                  <input
                    className="mt-2 w-full rounded-md border border-border p-2 text-sm"
                    placeholder="Reason (required to mark lost or disqualified)"
                    value={lostReason}
                    maxLength={2000}
                    onChange={(e) => setLostReason(e.target.value)}
                  />
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {allowed.map((stage) => (
                    <Button
                      key={stage}
                      variant="secondary"
                      loading={move.isPending}
                      disabled={needsReason(stage) && !lostReason.trim()}
                      onClick={() => move.mutate(stage)}
                    >
                      {statusLabel(stage)}
                    </Button>
                  ))}
                </div>
              </section>
            ) : (
              <p className="mt-5 text-sm text-text-muted">
                {lead.stage === 'CONVERTED'
                  ? 'This lead became a tender or proposal. Its history stays here for pipeline analysis.'
                  : 'This lead has reached a final stage.'}
              </p>
            )}

            <section className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Activity</h3>
              {(lead.timeline ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-text-muted">No calls, meetings or visits logged yet.</p>
              ) : (
                <ol className="mt-2 space-y-3">
                  {(lead.timeline as Row[]).map((entry) => (
                    <li key={entry.id} className="border-l-2 border-border pl-3">
                      <p className="text-xs font-medium text-text">
                        {statusLabel(String(entry.interaction_type))}
                        <span className="ml-2 font-normal text-text-subtle">
                          {new Date(String(entry.occurred_at)).toLocaleString()}
                        </span>
                      </p>
                      <p className="mt-0.5 text-sm text-text-muted">{entry.summary}</p>
                      {entry.logged_by_username ? (
                        <p className="mt-0.5 text-2xs text-text-subtle">{entry.logged_by_username}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function Field({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <dt className="text-2xs uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className="mt-0.5 text-text">{value}</dd>
    </div>
  );
}

'use client';

import Link from 'next/link';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Combobox } from '@/components/ui/Combobox';
import { Notice } from '@/components/finance/Primitives';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { apiRequestRaw } from '@/lib/apiClient';
import { ASSET_CONDITIONS } from '@silverline/shared';

/**
 * Where equipment has been (§note 7).
 *
 * The general audit trail answers "which row changed" — an action name, two
 * identifiers and a JSON diff. That is the right answer to a different
 * question. Nobody chasing a rover wants asset.transfer; they want to read
 * down a page and watch the thing leave one pair of hands and arrive in
 * another, with the state it was in each time.
 *
 * Built from asset_assignments, which is the record itself rather than a log
 * written alongside it. A log can disagree with the thing it describes; this
 * cannot.
 */

type Row = Record<string, any>;

export default function MovementsPage() {
  const { session } = useAuth();
  const canRead = hasPermission({ permissions: session?.permissions }, 'asset.read');

  const [assetId, setAssetId] = React.useState('');
  const [employeeId, setEmployeeId] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [offset, setOffset] = React.useState(0);

  const moves = useQuery({
    queryKey: ['asset-movements', assetId, employeeId, from, to, offset],
    enabled: canRead,
    queryFn: async () => {
      const q = new URLSearchParams({ limit: '50', offset: String(offset) });
      if (assetId) q.set('asset_id', assetId);
      if (employeeId) q.set('employee_id', employeeId);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      return (await apiRequestRaw(`/api/v1/assets/movements?${q}`)).body as Row;
    },
  });

  const assets = useQuery({
    queryKey: ['assets', 'picker'], enabled: canRead, staleTime: 300_000,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/assets?limit=100')).body as { data: Row[] }).data,
  });
  const people = useQuery({
    queryKey: ['assets', 'eligible-employees'], enabled: canRead, staleTime: 300_000,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/assets/eligible-employees')).body as { data: Row[] }).data,
  });

  if (!canRead) {
    return (
      <AppShell>
        <PageHeader title="Asset movements" />
        <PageBody>
          <Notice tone="info" title="You do not have access to the asset register">
            This screen needs the <code>asset.read</code> permission.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  const rows: Row[] = moves.data?.data ?? [];
  const change = (fn: () => void) => { fn(); setOffset(0); };

  return (
    <AppShell>
      <PageHeader
        title="Asset movements"
        description="Every time a piece of equipment changed hands, and the state it was in."
        breadcrumb={<Link href="/assets" className="hover:underline">Assets</Link>}
      />
      <PageBody>
        <div className="space-y-4">
          <Toolbar>
            <div className="min-w-[16rem]">
              <Combobox
                value={assetId}
                onChange={(id) => change(() => setAssetId(id))}
                isLoading={assets.isLoading}
                placeholder="Any equipment — type a serial or code…"
                options={(assets.data ?? []).map((a) => ({
                  id: String(a.id),
                  label: String(a.picker_label ?? a.name ?? a.asset_code),
                }))}
              />
            </div>
            <div className="min-w-[14rem]">
              <Combobox
                value={employeeId}
                onChange={(id) => change(() => setEmployeeId(id))}
                isLoading={people.isLoading}
                placeholder="Anybody — search the directory…"
                options={(people.data ?? []).map((e) => ({
                  id: String(e.id),
                  label: [e.first_name, e.last_name].filter(Boolean).join(' ')
                    || String(e.emp_no),
                  hint: String(e.emp_no ?? ''),
                }))}
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              From
              <input type="date" value={from} onChange={(e) => change(() => setFrom(e.target.value))}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              to
              <input type="date" value={to} onChange={(e) => change(() => setTo(e.target.value))}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
            </label>
            {(assetId || employeeId || from || to) ? (
              <Button type="button" variant="ghost" onClick={() => change(() => {
                setAssetId(''); setEmployeeId(''); setFrom(''); setTo('');
              })}>Clear</Button>
            ) : null}
          </Toolbar>

          <p className="text-xs text-text-muted">
            {/* Why this is not the same thing as the audit trail. */}
            Searching by person finds both what they took and what they handed back — the two
            ends of a handover are the same record.
          </p>

          {moves.isLoading ? <Skeleton className="h-64" /> : null}
          {moves.isError ? <ErrorCard error={moves.error} onRetry={() => moves.refetch()} /> : null}

          {moves.isSuccess && rows.length === 0 ? (
            <EmptyState
              title="No movements"
              description="Nothing has changed hands within these filters."
            />
          ) : null}

          {rows.length > 0 ? (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="px-4 py-2">When</th>
                    <th className="px-4 py-2">Equipment</th>
                    <th className="px-4 py-2">Movement</th>
                    <th className="px-4 py-2">From</th>
                    <th className="px-4 py-2">To</th>
                    <th className="px-4 py-2">Condition</th>
                    <th className="px-4 py-2">For</th>
                    <th className="px-4 py-2">Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.allocation_id}:${r.movement}:${i}`}
                      className="border-b border-border align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-text-muted tabular-nums">
                        {when(r.at)}
                      </td>
                      <td className="px-4 py-2">
                        <div className="text-text">{String(r.type_label ?? r.asset_name)}</div>
                        <div className="text-2xs text-text-subtle">
                          {[r.serial_number, r.asset_code].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={r.movement === 'ISSUED' ? 'warning' : 'success'}>
                          {r.movement === 'ISSUED' ? 'Went out' : 'Came back'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-text-muted">
                        {r.from_name ? String(r.from_name) : <span className="text-text-subtle">the store</span>}
                      </td>
                      <td className="px-4 py-2">
                        <div className="text-text">
                          {r.to_name ? String(r.to_name) : <span className="text-text-subtle">the store</span>}
                        </div>
                        {r.to_phone ? (
                          <div className="text-2xs text-text-subtle">{String(r.to_phone)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-text-muted">{condition(r.condition)}</td>
                      <td className="px-4 py-2 text-2xs text-text-muted">
                        {r.project_name ? String(r.project_name) : '—'}
                        {r.reason ? <div className="text-text-subtle">{String(r.reason)}</div> : null}
                      </td>
                      <td className="px-4 py-2 text-2xs text-text-subtle">
                        {String(r.recorded_by_username ?? '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}

          {rows.length > 0 ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</Button>
              <Button type="button" variant="ghost" disabled={!moves.data?.has_more}
                onClick={() => setOffset(offset + 50)}>Older</Button>
              <span className="text-2xs text-text-subtle">{rows.length} movements</span>
            </div>
          ) : null}
        </div>
      </PageBody>
    </AppShell>
  );
}

/** A condition code as words, including ones the register held before. */
function condition(code: unknown): string {
  if (!code) return '—';
  const known = ASSET_CONDITIONS.find((c) => c.code === code);
  if (known) return known.label;
  const raw = String(code);
  return raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, ' ');
}

function when(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

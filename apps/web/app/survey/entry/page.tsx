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
import { Combobox } from '@/components/ui/Combobox';
import { Badge } from '@/components/ui/Badge';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Notice, Stat } from '@/components/finance/Primitives';
import { day } from '@/lib/finance';
import {
  VILLAGE_STATE_LABELS, acres, count, groupMeasures, pct, stateTone,
} from '@/lib/survey';

type Row = Record<string, any>;

/**
 * Record a day's progress (§59.4).
 *
 * Laid out the way the sheet it replaces is laid out — measures under the
 * headings they already sit under — so somebody who has filled the workbook
 * in for a year recognises the form.
 *
 * What is deliberately absent is the cumulative column. The running total is
 * shown beside each field as context, read-only, derived from the entries
 * already recorded. It is the one thing nobody should be typing.
 */
export default function SurveyEntryPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canEnter = hasPermission(perms, 'survey.enter');
  const qc = useQueryClient();

  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [projectId, setProjectId] = React.useState('');
  const [villageId, setVillageId] = React.useState('');
  const [date, setDate] = React.useState(today);
  const [deployed, setDeployed] = React.useState({ teams: 0, base: 0, rovers: 0 });
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState('');
  const [saved, setSaved] = React.useState<string | null>(null);

  const projects = useQuery({
    queryKey: ['survey-projects'],
    enabled: canEnter,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/survey/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const catalogue = useQuery({
    queryKey: ['survey-measures'],
    enabled: canEnter,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/survey/measures')).body as { data: Row }).data,
    staleTime: 300_000,
  });

  const villages = useQuery({
    queryKey: ['survey-villages', projectId],
    enabled: canEnter && !!projectId,
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/villages`)).body as { data: Row[] }).data,
  });

  React.useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(String(projects.data[0].id));
  }, [projects.data, projectId]);

  const village = villages.data?.find((v) => String(v.id) === villageId);
  const measures: Row[] = catalogue.data?.measures ?? [];
  const groups = groupMeasures(measures as Array<{ code: string; group_label?: string | null; label: string }>);

  // Prefill the crew and instruments from the village's allotment: the same
  // numbers most days, and retyping them is how they end up wrong.
  React.useEffect(() => {
    if (village) {
      setDeployed({
        teams: Number(village.teams ?? 0),
        base: Number(village.dgps_base ?? 0),
        rovers: Number(village.dgps_rovers ?? 0),
      });
    }
  }, [villageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: async () => {
      const numeric: Record<string, number> = {};
      for (const [code, raw] of Object.entries(values)) {
        const n = Number(raw);
        if (raw !== '' && Number.isFinite(n) && n !== 0) numeric[code] = n;
      }
      return apiRequest('/api/v1/survey/entries', {
        method: 'POST',
        body: {
          survey_village_id: villageId,
          entry_date: date,
          teams_deployed: deployed.teams,
          dgps_base: deployed.base,
          dgps_rovers: deployed.rovers,
          notes: notes || undefined,
          values: numeric,
        },
      });
    },
    onSuccess: () => {
      setSaved(`${village?.village_name ?? 'Village'} — ${day(date)}`);
      setValues({});
      setNotes('');
      qc.invalidateQueries({ queryKey: ['survey-villages'] });
      qc.invalidateQueries({ queryKey: ['survey-progress'] });
    },
  });

  if (!canEnter) {
    return (
      <AppShell>
        <PageHeader title="Record survey progress" />
        <PageBody>
          <Notice tone="info" title="You do not have access to record progress">
            This screen needs the <code>survey.enter</code> permission.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <AppShell>
      <PageHeader
        title="Record survey progress"
        description="Today’s figures only. The running total is worked out from the days already recorded."
      />
      <PageBody>
        <Toolbar>
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setVillageId(''); }}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Date
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
          </label>
          {date < today ? (
            // Entering a missed day is normal and correct here; saying so
            // stops somebody assuming they have to backfill in order.
            <span className="text-2xs text-text-subtle">
              Recording a past day. Every total above it corrects itself.
            </span>
          ) : null}
          <a href="/survey" className="ml-auto">
            <Button type="button" variant="ghost">Back to progress</Button>
          </a>
        </Toolbar>

        {saved ? (
          <Notice tone="info" title="Recorded">
            {saved} is saved. The cumulative figures and every roll-up above them now include it.
          </Notice>
        ) : null}

        <Card className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-2xs uppercase tracking-wide text-text-subtle">Village</span>
              <Combobox
                value={villageId}
                onChange={setVillageId}
                isLoading={villages.isLoading}
                placeholder="Search by village or mandal…"
                options={(villages.data ?? []).map((v) => ({
                  id: String(v.id),
                  label: String(v.village_name),
                  hint: [v.mandal_name, v.village_code].filter(Boolean).join(' · '),
                }))}
                emptyHint="The villages listed in this programme"
              />
            </label>

            {village ? (
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Extent" value={acres(village.total_extent_ac)} />
                <Stat label="Surveyed so far"
                  value={acres((village.done?.GOVT_LAND_EXTENT_AC ?? 0) + (village.done?.PRIVATE_LAND_EXTENT_AC ?? 0))} />
                <Stat label="State" value={
                  <Badge tone={stateTone(village.state)}>
                    {VILLAGE_STATE_LABELS[village.state] ?? village.state}
                  </Badge>
                } />
              </div>
            ) : null}
          </div>

          {village ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1">
                  <span className="text-2xs uppercase tracking-wide text-text-subtle">Teams on site</span>
                  <input type="number" min={0} className={field} value={deployed.teams}
                    onChange={(e) => setDeployed({ ...deployed, teams: Number(e.target.value) })} />
                </label>
                <label className="space-y-1">
                  <span className="text-2xs uppercase tracking-wide text-text-subtle">DGPS base</span>
                  <input type="number" min={0} className={field} value={deployed.base}
                    onChange={(e) => setDeployed({ ...deployed, base: Number(e.target.value) })} />
                </label>
                <label className="space-y-1">
                  <span className="text-2xs uppercase tracking-wide text-text-subtle">Moving rovers</span>
                  <input type="number" min={0} className={field} value={deployed.rovers}
                    onChange={(e) => setDeployed({ ...deployed, rovers: Number(e.target.value) })} />
                </label>
              </div>

              {groups.map((g) => (
                <section key={g.group} className="rounded-lg border border-border bg-surface-sunken p-3">
                  <h3 className="text-xs font-semibold text-text">{g.group}</h3>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    {g.items.map((m) => {
                      const done = village.done?.[m.code] ?? 0;
                      const position = village.measures?.[m.code];
                      return (
                        <label key={m.code} className="space-y-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="text-2xs uppercase tracking-wide text-text-subtle">
                              {m.label}
                            </span>
                            {/* The cumulative, read-only. It is the column the
                                workbook asks somebody to type, and the one
                                thing nobody should be typing. */}
                            <span className="text-2xs text-text-subtle" title="Worked out from the days already recorded">
                              so far {count(done)}{position && position.pct !== null ? ` · ${pct(position.pct)}` : ''}
                            </span>
                          </span>
                          <input
                            type="number" min={0} step="any" className={field}
                            placeholder="0"
                            value={values[m.code] ?? ''}
                            onChange={(e) => setValues({ ...values, [m.code]: e.target.value })}
                          />
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))}

              <label className="space-y-1">
                <span className="text-2xs uppercase tracking-wide text-text-subtle">Notes</span>
                <input className={field} value={notes} placeholder="Rain stopped work after noon"
                  onChange={(e) => setNotes(e.target.value)} />
              </label>

              {save.isError ? <ErrorCard error={save.error} /> : null}

              <div className="flex items-center gap-3">
                <Button type="button" variant="primary" loading={save.isPending}
                  disabled={!villageId} onClick={() => save.mutate()}>
                  Save today’s progress
                </Button>
                <span className="text-2xs text-text-subtle">
                  One entry per village per day. To correct a day already recorded, open it below.
                </span>
              </div>
            </>
          ) : (
            <EmptyState title="Choose a village"
              description="Pick the village this day’s work was done in." />
          )}
        </Card>

        {villageId ? <RecentEntries villageId={villageId} /> : null}
      </PageBody>
    </AppShell>
  );
}

/**
 * What has already been recorded for this village.
 *
 * Shown under the form so a duplicate entry is obvious before it is
 * attempted, and so a wrong figure can be found and corrected.
 */
function RecentEntries({ villageId }: { villageId: string }) {
  const q = useQuery({
    queryKey: ['survey-entries', villageId],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/entries?survey_village_id=${villageId}&limit=30`)).body as { data: Row[] }).data,
  });

  if (q.isLoading) return <Skeleton className="mt-4 h-32" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const rows: Row[] = q.data ?? [];
  if (rows.length === 0) {
    return (
      <p className="mt-4 text-xs text-text-subtle">
        Nothing recorded for this village yet.
      </p>
    );
  }

  const codes = [...new Set(rows.flatMap((r) => Object.keys(r.values ?? {})))];

  return (
    <section className="mt-4">
      <h3 className="mb-2 text-sm font-semibold text-text">Already recorded</h3>
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Date</TH>
              <TH className="text-right">Teams</TH>
              {codes.map((c) => (
                <TH key={c} className="text-right">{c.replaceAll('_', ' ').toLowerCase()}</TH>
              ))}
              <TH>Recorded by</TH>
              <TH>Notes</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD>{day(r.entry_date)}</TD>
                <TD className="text-right tabular-nums">{r.teams_deployed}</TD>
                {codes.map((c) => (
                  <TD key={c} className="text-right tabular-nums">
                    {r.values?.[c] ? count(Number(r.values[c])) : '—'}
                  </TD>
                ))}
                {/* The employee name, not the sign-in name. */}
                <TD className="text-xs text-text-muted">{r.recorded_by_name ?? r.recorded_by}</TD>
                <TD className="text-2xs text-text-subtle">{r.notes ?? ''}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </section>
  );
}

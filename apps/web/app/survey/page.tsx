'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Notice, Section, Stat } from '@/components/finance/Primitives';
import { day } from '@/lib/finance';
import {
  GRAINS, LEVEL_LABELS, REPORT_LEVELS, STAGE_STATE_LABELS, VILLAGE_STATE_LABELS,
  acres, barWidth, count, financialYearToDate, groupMeasures, hasPct, pct, pctTone,
  progressHeadline, sqKm, stateTone, type ReportLevel,
} from '@/lib/survey';

type Row = Record<string, any>;
type Tab = 'progress' | 'timeline' | 'summary';

/**
 * Land survey progress (§59).
 *
 * Opens on the roll-up rather than on the entry form, because the question
 * this replaces a workbook to answer is "how much is done" — and the answer
 * has to be visible before anybody drills into a village.
 */
export default function SurveyPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canRead = hasPermission(perms, 'survey.read');
  const canEnter = hasPermission(perms, 'survey.enter');

  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const fy = React.useMemo(() => financialYearToDate(today), [today]);

  const [tab, setTab] = React.useState<Tab>('progress');
  const [projectId, setProjectId] = React.useState('');
  const [level, setLevel] = React.useState<ReportLevel>('mandal');
  const [range, setRange] = React.useState(fy);
  const [grain, setGrain] = React.useState<'DAY' | 'WEEK' | 'MONTH' | 'YEAR'>('MONTH');

  const projects = useQuery({
    queryKey: ['survey-projects'],
    enabled: canRead,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/survey/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  React.useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(String(projects.data[0].id));
  }, [projects.data, projectId]);

  const progress = useQuery({
    queryKey: ['survey-progress', projectId, level, range],
    enabled: canRead && !!projectId && tab === 'progress',
    queryFn: async () => {
      const q = new URLSearchParams({ level, from: range.from, to: range.to });
      return ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/progress?${q}`)).body as { data: Row }).data;
    },
  });

  if (!canRead) {
    return (
      <AppShell>
        <PageHeader title="Land survey" />
        <PageBody>
          <Notice tone="info" title="You do not have access to survey progress">
            This screen needs the <code>survey.read</code> permission. An administrator can grant
            it from Security &rarr; Roles.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Land survey"
        description="Daily progress, rolled up by village, mandal, division and district."
      />
      <PageBody>
        <Toolbar>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
          >
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.village_count} villages)</option>
            ))}
          </select>

          <div className="flex gap-1">
            {(['progress', 'timeline', 'summary'] as const).map((t) => (
              <Button key={t} type="button" variant={tab === t ? 'secondary' : 'ghost'}
                onClick={() => setTab(t)}>
                {t === 'progress' ? 'Progress' : t === 'timeline' ? 'Over time' : 'Summary'}
              </Button>
            ))}
          </div>

          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            From
            <input type="date" value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            to
            <input type="date" value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
          </label>
          <Button type="button" variant="ghost" onClick={() => setRange(fy)}>
            This financial year
          </Button>

          {canEnter ? (
            <a href="/survey/entry" className="ml-auto">
              <Button type="button" variant="primary">Record today’s progress</Button>
            </a>
          ) : null}
        </Toolbar>

        {projects.isLoading ? <Skeleton className="h-64" /> : null}
        {projects.isError ? <ErrorCard error={projects.error} onRetry={() => projects.refetch()} /> : null}
        {projects.isSuccess && (projects.data ?? []).length === 0 ? (
          <EmptyState
            title="No survey programme yet"
            description="A programme holds the villages to be surveyed and everything recorded against them."
          />
        ) : null}

        {projectId && tab === 'progress' ? (
          <Progress query={progress} level={level} setLevel={setLevel} range={range} />
        ) : null}
        {projectId && tab === 'timeline' ? (
          <Timeline projectId={projectId} range={range} grain={grain} setGrain={setGrain} />
        ) : null}
        {projectId && tab === 'summary' ? <Summary projectId={projectId} /> : null}
      </PageBody>
    </AppShell>
  );
}

/* --------------------------------------------------------------- progress */

function Progress({
  query, level, setLevel, range,
}: {
  query: any; level: ReportLevel; setLevel: (l: ReportLevel) => void;
  range: { from: string; to: string };
}) {
  if (query.isLoading) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorCard error={query.error} onRetry={() => query.refetch()} />;
  const data = query.data;
  if (!data) return null;

  const total = data.total;
  const rows: Row[] = data.rows ?? [];
  const measures: Row[] = data.measures ?? [];
  // Only the measures that express progress get a percentage column; the rest
  // are counts and are shown as counts.
  const scored = measures.filter((m) => m.basis !== 'NONE');

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-text">{progressHeadline(total)}</p>
        <div className="grid gap-2 sm:grid-cols-5">
          <Stat label="Extent to survey" value={acres(total.extentAc)} hint={sqKm(total.extentSqKm)} />
          <Stat label="Surveyed" value={acres(total.surveyedAc)}
            tone={hasPct(total.overallPct) && total.overallPct >= 100 ? 'success' : undefined} />
          <Stat label="Completion" value={pct(total.overallPct)} tone={pctTone(total.overallPct)} />
          <Stat label="Villages finished" value={`${total.completed} of ${total.villages}`}
            tone={total.completed === total.villages && total.villages > 0 ? 'success' : undefined} />
          <Stat label="Not started" value={total.notStarted}
            tone={total.notStarted > 0 ? 'warning' : 'success'}
            hint="Nobody has visited these" />
        </div>
        {total.unweighted > 0 ? (
          <Notice tone="warning" title={`${total.unweighted} village${total.unweighted === 1 ? '' : 's'} with no extent recorded`}>
            {/* Giving a missing extent a weight of one would distort every
                figure above it, and nothing on screen would say so. */}
            They are counted in the village totals and left out of the percentage, because
            there is nothing to weigh them by. Add the extent from the master list to include them.
          </Notice>
        ) : null}
      </Card>

      <Toolbar>
        <span className="text-xs text-text-muted">Roll up by</span>
        <div className="flex gap-1">
          {REPORT_LEVELS.filter((l) => l !== 'programme').map((l) => (
            <Button key={l} type="button" variant={level === l ? 'secondary' : 'ghost'}
              onClick={() => setLevel(l)}>
              {LEVEL_LABELS[l]}
            </Button>
          ))}
        </div>
      </Toolbar>

      {rows.length === 0 ? (
        <EmptyState title="Nothing to report" description="No villages are listed in this programme." />
      ) : (
        <Section title={`By ${LEVEL_LABELS[level].toLowerCase()}`}>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>{LEVEL_LABELS[level]}</TH>
                  <TH className="text-right">Villages</TH>
                  <TH className="text-right">Extent</TH>
                  <TH className="text-right">Surveyed</TH>
                  <TH>Completion</TH>
                  <TH className="text-right">Not started</TH>
                  {scored.map((m) => (
                    <TH key={m.code} className="text-right">
                      {m.group_label ? `${m.group_label} — ` : ''}{m.label}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id ?? r.name}>
                    <TD>
                      <span className="font-medium text-text">{r.name}</span>
                      {r.id === null ? (
                        // A hole in the master data, shown rather than filed
                        // somewhere plausible.
                        <span className="ml-1 text-2xs text-warning">geography incomplete</span>
                      ) : null}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {r.completed}/{r.villages}
                    </TD>
                    <TD className="text-right tabular-nums">{acres(r.extentAc)}</TD>
                    <TD className="text-right tabular-nums">{acres(r.surveyedAc)}</TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-sunken">
                          <div
                            className={
                              pctTone(r.overallPct) === 'success' ? 'h-full bg-success'
                                : pctTone(r.overallPct) === 'warning' ? 'h-full bg-warning'
                                  : 'h-full bg-primary'
                            }
                            style={{ width: `${barWidth(r.overallPct)}%` }}
                          />
                        </div>
                        <span className={hasPct(r.overallPct) ? 'text-xs tabular-nums text-text' : 'text-2xs text-text-subtle'}>
                          {pct(r.overallPct)}
                        </span>
                      </div>
                    </TD>
                    <TD className="text-right tabular-nums">
                      <span className={r.notStarted > 0 ? 'text-warning' : 'text-text-subtle'}>
                        {r.notStarted}
                      </span>
                    </TD>
                    {scored.map((m) => (
                      <TD key={m.code} className="text-right text-xs tabular-nums">
                        <div>{count(r.measures?.[m.code]?.done)}</div>
                        <div className="text-2xs text-text-subtle">
                          {pct(r.measures?.[m.code]?.pct)}
                        </div>
                        {r.period_done ? (
                          <div className="text-2xs text-primary">
                            +{count(r.period_done[m.code])} in period
                          </div>
                        ) : null}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
          <p className="mt-2 text-2xs text-text-subtle">
            Percentages are weighted by extent, not averaged across villages — a five-acre village
            cannot count as much as a five-hundred-acre one. Completion is as at {day(range.to)};
            the “in period” figures are what was done between {day(range.from)} and {day(range.to)}.
          </p>
        </Section>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- timeline */

function Timeline({
  projectId, range, grain, setGrain,
}: {
  projectId: string; range: { from: string; to: string };
  grain: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  setGrain: (g: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR') => void;
}) {
  const q = useQuery({
    queryKey: ['survey-timeline', projectId, range, grain],
    queryFn: async () => {
      const params = new URLSearchParams({ from: range.from, to: range.to, grain });
      return ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/timeline?${params}`)).body as { data: Row }).data;
    },
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  if (!data) return null;

  const periods: Row[] = data.periods ?? [];
  // Only measures that anybody actually recorded in the window, so a wide
  // table does not fill with empty columns.
  const active = Object.keys(periods[0]?.measures ?? {})
    .filter((code) => periods.some((p) => (p.measures[code] ?? 0) > 0));
  const peak = Math.max(1, ...periods.flatMap((p) => active.map((c) => p.measures[c] ?? 0)));

  return (
    <div className="space-y-4">
      <Toolbar>
        <span className="text-xs text-text-muted">Grouped</span>
        <div className="flex gap-1">
          {GRAINS.map((g) => (
            <Button key={g.value} type="button" variant={grain === g.value ? 'secondary' : 'ghost'}
              onClick={() => setGrain(g.value)}>
              {g.label}
            </Button>
          ))}
        </div>
        <span className="ml-auto text-2xs text-text-subtle">
          Financial year {data.financial_year?.label}
        </span>
      </Toolbar>

      {periods.length === 0 || active.length === 0 ? (
        <EmptyState
          title="Nothing recorded in this window"
          description="No daily progress falls between these dates."
        />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Period</TH>
                <TH className="text-right">Villages worked</TH>
                {active.map((c) => <TH key={c} className="text-right">{c.replaceAll('_', ' ').toLowerCase()}</TH>)}
              </TR>
            </THead>
            <TBody>
              {periods.map((p) => (
                <TR key={`${p.from}-${p.to}`}>
                  <TD>
                    <div className="font-medium text-text">{p.label}</div>
                    <div className="text-2xs text-text-subtle">{day(p.from)} – {day(p.to)}</div>
                  </TD>
                  <TD className="text-right tabular-nums">{p.villages || '—'}</TD>
                  {active.map((c) => (
                    <TD key={c} className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-surface-sunken">
                          <div className="h-full bg-primary"
                            style={{ width: `${((p.measures[c] ?? 0) / peak) * 100}%` }} />
                        </div>
                        <span className="text-xs tabular-nums">{count(p.measures[c])}</span>
                      </div>
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- summary */

function Summary({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: ['survey-summary', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/survey/projects/${projectId}/summary`)).body as { data: Row[] }).data,
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const rows: Row[] = q.data ?? [];

  if (rows.length === 0) {
    return <EmptyState title="No villages listed" description="Add the villages to be surveyed first." />;
  }

  return (
    <TableWrap>
      <Table>
        <THead>
          <TR>
            <TH>Mandal</TH>
            <TH>Village</TH>
            <TH className="text-right">Extent</TH>
            <TH className="text-right">In km²</TH>
            <TH>Ground truthing</TH>
            <TH>Vectorization</TH>
            <TH className="text-right">Points</TH>
            <TH className="text-right">LPMs</TH>
            <TH className="text-right">Actual extent</TH>
            <TH>GT dates</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={`${r.village}-${i}`}>
              <TD className="text-xs text-text-muted">{r.mandal ?? '—'}</TD>
              <TD className="font-medium text-text">{r.village}</TD>
              <TD className="text-right tabular-nums">{acres(r.extent_ac)}</TD>
              <TD className="text-right tabular-nums">{sqKm(r.extent_sq_km)}</TD>
              <TD>
                <Badge tone={stateTone(r.gt_status)}>
                  {STAGE_STATE_LABELS[r.gt_status] ?? r.gt_status}
                </Badge>
              </TD>
              <TD>
                <Badge tone={stateTone(r.vectorization_status)}>
                  {STAGE_STATE_LABELS[r.vectorization_status] ?? r.vectorization_status}
                </Badge>
              </TD>
              <TD className="text-right tabular-nums">{count(r.points)}</TD>
              <TD className="text-right tabular-nums">{count(r.lpms)}</TD>
              <TD className="text-right tabular-nums">
                {acres(r.actual_extent_ac)}
                {/* The gap between planned and actual is the point of the
                    column, so it is stated rather than left to be worked out. */}
                {r.extent_ac && r.actual_extent_ac > 0 ? (
                  <div className="text-2xs text-text-subtle">
                    {r.actual_extent_ac > r.extent_ac ? '+' : ''}
                    {(r.actual_extent_ac - r.extent_ac).toFixed(2)} vs planned
                  </div>
                ) : null}
              </TD>
              <TD className="text-2xs text-text-subtle">
                {r.gt_started_on ? day(r.gt_started_on) : '—'}
                {r.gt_completed_on ? ` → ${day(r.gt_completed_on)}` : ''}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}

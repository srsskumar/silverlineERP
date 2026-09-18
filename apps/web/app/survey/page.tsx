'use client';

import Link from 'next/link';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { ExportMenu, cellNum, cellText } from '@/components/ui/ExportMenu';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Notice, Section, Stat } from '@/components/finance/Primitives';
import { GLOSSARY } from '@/components/ui/InfoHint';
import { day, businessToday } from '@/lib/finance';
import {
  GRAINS, LEVEL_LABELS, REPORT_LEVELS, STAGE_STATE_LABELS, TALLY_LABELS, TALLY_ORDER,
  VILLAGE_STATE_LABELS, acres, barWidth, count, financialYearToDate, groupMeasures,
  hasPct, paceNote, pct, pctTone, progressHeadline, roverNote, sqKm, stageLabel,
  stateTone, tallyTone, stageStateOf, surveyedExtent, TALLY_STATES,
  stepPeriod, PERIOD_NOUNS, matchesBillingFilter, BILLING_FILTERS, type ReportLevel,
  BOTTLENECK_LABELS, VILLAGE_STATUS_LABELS, forecastNote, villageStatusTone,
  reasonLabel, changeHint, periodNote,
} from '@/lib/survey';
import { VillageDetail } from '@/components/survey/VillageDetail';
import { LineChart, BarChart, StackBar } from '@/components/survey/Charts';

type Row = Record<string, any>;

/** One decimal, which is as fine as an acre figure is ever read on a chart. */
const round1 = (n: number) => Math.round(n * 10) / 10;
type Tab = 'progress' | 'report' | 'villages' | 'people' | 'deployment' | 'bottlenecks' | 'timeline' | 'summary';

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
  const canManage = hasPermission(perms, 'survey.manage');
  // Management information. The specification is explicit that a GT user
  // does not see forecasting.
  const canForecast = hasPermission(perms, 'survey.forecast');

  const today = React.useMemo(() => businessToday(), []);
  const fy = React.useMemo(() => financialYearToDate(today), [today]);

  const [tab, setTab] = React.useState<Tab>('progress');
  const [projectId, setProjectId] = React.useState('');
  /**
   * A village another screen sent us to, opened on arrival.
   *
   * Read on mount rather than in the initial state, because this page is
   * prerendered: deriving state from the URL during the first render makes
   * the server and client disagree about what to draw.
   */
  const [openVillage, setOpenVillage] = React.useState<string | null>(null);
  /*
   * A filter handed over from somewhere else on this screen.
   *
   * A count in the roll-up and a row in the summary are both questions whose
   * answer is a list of villages. Carrying the filter across means the reader
   * does not rebuild it by hand and get a different list.
   */
  const [stageDrill, setStageDrill] =
    React.useState<{ stage: string; state: string } | null>(null);
  const [geoDrill, setGeoDrill] =
    React.useState<{ level: ReportLevel; name: string } | null>(null);
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const wanted = q.get('tab');
    if (wanted && (['progress', 'report', 'villages', 'people', 'deployment', 'bottlenecks', 'timeline', 'summary'] as string[])
      .includes(wanted)) setTab(wanted as Tab);
    const village = q.get('village');
    if (village) { setTab('villages'); setOpenVillage(village); }
    const project = q.get('project');
    if (project) setProjectId(project);
  }, []);
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

          {/*
            * Eight tabs do not fit across a phone, and a row that does not fit
            * drags the whole page sideways with it — every screen below scrolls
            * horizontally because of a strip at the top. Scrolls within itself
            * instead.
            */}
          <div className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1">
            {(['progress', 'report', 'villages', 'people', 'deployment', 'bottlenecks', 'timeline', 'summary'] as const).map((t) => (
              <Button key={t} type="button" variant={tab === t ? 'secondary' : 'ghost'}
                onClick={() => setTab(t)}>
                {t === 'progress' ? 'Progress'
                  : t === 'report' ? 'Report'
                    : t === 'villages' ? 'Villages'
                      : t === 'people' ? 'Crew & rovers'
                        : t === 'deployment' ? 'Deployment'
                        : t === 'bottlenecks' ? 'Bottlenecks'
                          : t === 'timeline' ? 'Trend' : 'Summary'}
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

          <div className="ml-auto flex gap-2">
            {canManage ? (
              <Link href="/survey/setup">
                <Button type="button" variant="secondary">Setup</Button>
              </Link>
            ) : null}
            {canEnter ? (
              <Link href="/survey/entry">
                <Button type="button" variant="primary">Record today’s progress</Button>
              </Link>
            ) : null}
          </div>
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
          <Progress
            query={progress} level={level} setLevel={setLevel} range={range}
            onDrillDown={(stageCode, state) => {
              setStageDrill({ stage: stageCode, state });
              setTab('villages');
            }}
            onOpenRow={(lvl, id, name) => {
              if (lvl === 'village') { setOpenVillage(id); setTab('villages'); return; }
              // A mandal or district opens the villages inside it.
              setGeoDrill({ level: lvl, name });
              setTab('villages');
            }}
          />
        ) : null}
        {projectId && tab === 'report' ? (
          <PeriodReport projectId={projectId} level={level} setLevel={setLevel} />
        ) : null}
        {projectId && tab === 'villages' ? (
          <Villages projectId={projectId} canManage={canManage} canEnter={canEnter}
            openVillage={openVillage}
            stageDrill={stageDrill} geoDrill={geoDrill}
            onDrillConsumed={() => { setStageDrill(null); setGeoDrill(null); }} />
        ) : null}
        {projectId && tab === 'people' ? (
          <CrewAndRovers projectId={projectId} range={range} />
        ) : null}
        {projectId && tab === 'deployment' ? (
          <Deployment projectId={projectId} level={level} setLevel={setLevel} />
        ) : null}
        {projectId && tab === 'bottlenecks' ? (
          <Bottlenecks projectId={projectId} canForecast={canForecast} />
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
  query, level, setLevel, range, onDrillDown, onOpenRow,
}: {
  query: any; level: ReportLevel; setLevel: (l: ReportLevel) => void;
  range: { from: string; to: string };
  /** A stage tally was clicked: show those villages. */
  onDrillDown?: (stageCode: string, state: string) => void;
  /** A roll-up row was clicked: open the village, or the mandal's villages. */
  onOpenRow?: (level: ReportLevel, id: string, name: string) => void;
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
          <Stat label="Extent to survey" value={acres(total.extentAc)} hint={sqKm(total.extentSqKm)}
            explain={GLOSSARY.extent} />
          <Stat label="Surveyed" value={acres(total.surveyedAc)}
            tone={hasPct(total.overallPct) && total.overallPct >= 100 ? 'success' : undefined} />
          <Stat label="Completion" value={pct(total.overallPct)} tone={pctTone(total.overallPct)}
            explain={GLOSSARY.completion} />
          <Stat label="Villages finished" value={`${total.completed} of ${total.villages}`}
            tone={total.completed === total.villages && total.villages > 0 ? 'success' : undefined} />
          <Stat label="Not started" value={total.notStarted}
            tone={total.notStarted > 0 ? 'warning' : 'success'}
            hint="Nobody has visited these" />
        </div>
        <p className="text-2xs text-text-subtle">{paceNote(data.pace)}</p>
      </Card>

      {/* The question asked at any moment: how many villages are yet to
          start, how many have GT in progress, how many are waiting on QC.
          The overall village state cannot answer it. */}
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">Villages at each stage</h3>
          <span className="text-2xs text-text-subtle">{roverNote(data.rovers)}</span>
        </div>
        {/* Where the programme sits, before the grid of numbers behind it
            (§39). "Most of it has not been started" is a sentence somebody
            reads off this in a second and has to add up from the table. */}
        <StackBar
          title="Every village in the programme, by where it has reached"
          segments={[
            { key: 'notStarted', label: VILLAGE_STATE_LABELS.NOT_STARTED ?? 'Not started',
              value: data.total?.notStarted ?? 0 },
            { key: 'inProgress', label: VILLAGE_STATE_LABELS.IN_PROGRESS ?? 'In progress',
              value: data.total?.inProgress ?? 0 },
            { key: 'completed', label: VILLAGE_STATE_LABELS.COMPLETED ?? 'Completed',
              value: data.total?.completed ?? 0 },
          ]}
        />
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Stage</TH>
                {TALLY_ORDER.map((k) => <TH key={k} className="text-right">{TALLY_LABELS[k]}</TH>)}
              </TR>
            </THead>
            <TBody>
              {(data.pipeline ?? []).map((stage: Row) => {
                const t = data.by_stage?.[String(stage.code)];
                if (!t) return null;
                return (
                  <TR key={String(stage.code)}>
                    <TD>
                      <span className="text-text">{stage.label}</span>
                      {stage.tracks_daily_progress ? (
                        <span className="ml-1 text-2xs text-text-subtle">daily</span>
                      ) : null}
                    </TD>
                    {/*
                      * Every count opens the villages behind it.
                      *
                      * "Eleven villages on hold at vectorisation" is the start
                      * of a question, not the end of one, and the only way to
                      * answer it was to go to another tab and rebuild the
                      * filter by hand.
                      */}
                    {TALLY_ORDER.map((k) => (
                      <TD key={k} className="text-right tabular-nums">
                        {t[k] === 0 ? (
                          <span className="text-text-subtle">0</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onDrillDown?.(String(stage.code), TALLY_STATES[k])}
                            title={`Show the ${t[k]} village(s) ${
                              TALLY_LABELS[k].toLowerCase()} at ${String(stage.label).toLowerCase()}`}
                            className={`rounded underline-offset-2 hover:underline ${
                              tallyTone(k) === 'danger' ? 'font-semibold text-danger'
                                : tallyTone(k) === 'success' ? 'text-success'
                                  : tallyTone(k) === 'warning' ? 'text-warning' : 'text-text'
                            }`}
                          >
                            {t[k]}
                          </button>
                        )}
                      </TD>
                    ))}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold text-text">Equipment and pace</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="Rovers allocated" value={data.rovers?.allocated ?? 0}
            explain={GLOSSARY.dgps} />
          <Stat label="In use" value={data.rovers?.used ?? 0}
            tone={data.rovers?.overUsed ? 'danger' : undefined} />
          <Stat label="Idle" value={data.rovers?.idle ?? 0}
            tone={(data.rovers?.idle ?? 0) > 0 ? 'warning' : 'success'}
            hint={pct(data.rovers?.utilisationPct)}
            explain={GLOSSARY.idleRovers} />
          <Stat label="Projected finish"
            value={data.pace?.projectedFinish ? day(data.pace.projectedFinish) : '—'}
            hint={data.pace?.daysToFinish ? `${data.pace.daysToFinish} days at this rate` : undefined}
            explain={GLOSSARY.projectedFinish} />
        </div>
        {data.rovers?.overUsed ? (
          <Notice tone="danger" title="More rovers reported in use than allocated">
            Something is being run that is not on the books. Check the allocations against what
            the crews reported.
          </Notice>
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
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
                      {/*
                        * The name opens what it names.
                        *
                        * A row in a roll-up is a question — which villages are
                        * these, what is holding this mandal up — and answering
                        * it meant going to another tab and rebuilding the
                        * filter by hand.
                        */}
                      {r.id !== null && onOpenRow ? (
                        <button
                          type="button"
                          onClick={() => onOpenRow(level, String(r.id), String(r.name))}
                          className="text-left font-medium text-text underline-offset-2 hover:text-primary hover:underline"
                          title={level === 'village'
                            ? 'Open this village'
                            : `Show the villages in ${String(r.name)}`}
                        >
                          {r.name}
                        </button>
                      ) : (
                        <span className="font-medium text-text">{r.name}</span>
                      )}
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

/* ------------------------------------------------------------ bottlenecks */

/**
 * Where the work has stalled, and the forecast beside it.
 *
 * The two belong together: a projection that says the programme finishes a
 * fortnight late is a number, and the list of villages causing it is what
 * somebody does about it.
 */
/* ----------------------------------------------------------- period report */

/**
 * The daily, weekly and monthly report (§23).
 *
 * A figure on its own is not a report. "Four hundred acres this week" means
 * nothing until it sits beside last week's, and the comparison is the part
 * anybody acts on — so every number here carries its predecessor.
 */
function PeriodReport({
  projectId, level, setLevel,
}: {
  projectId: string; level: ReportLevel; setLevel: (l: ReportLevel) => void;
}) {
  const [grain, setGrain] = React.useState<'DAY' | 'WEEK' | 'MONTH'>('WEEK');
  const [asOf, setAsOf] = React.useState(() => businessToday());

  const report = useQuery({
    queryKey: ['survey-report', projectId, grain, level, asOf],
    queryFn: async () => {
      const q = new URLSearchParams({ grain, level, as_of: asOf });
      return ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/report?${q}`)).body as { data: Row }).data;
    },
  });

  if (report.isLoading) return <Skeleton className="h-64" />;
  if (report.isError) {
    return <ErrorCard error={report.error} onRetry={() => report.refetch()} />;
  }
  const d = report.data as Row;
  const units: Row[] = d?.units ?? [];

  const noun = PERIOD_NOUNS[grain] ?? 'period';
  // Stepping forward past today would report on a period nobody has worked.
  const atLatest = stepPeriod(asOf, grain, 1) > businessToday();

  /*
   * The table on screen, as a file.
   *
   * Built from the same rows the table renders rather than re-fetched, so a
   * download can never contain more than what was checked on screen.
   */
  const sheet = {
    name: `${LEVEL_LABELS[level]} ${String(d?.period?.label ?? '')}`.slice(0, 31),
    columns: [
      { header: LEVEL_LABELS[level], width: 28 },
      { header: 'Villages', width: 10 },
      { header: `This ${noun} (Ac)`, width: 16 },
      { header: `Previous ${noun} (Ac)`, width: 18 },
      { header: 'Cumulative (Ac)', width: 16 },
      { header: 'Complete (%)', width: 14 },
    ],
    rows: units.map((u) => [
      cellText(u.name),
      cellNum(u.villages),
      cellNum(periodTotal(u.period)),
      cellNum(periodTotal(u.previous)),
      cellNum(u.cumulative?.doneAc),
      cellNum(u.cumulative?.pct),
    ]),
  };

  return (
    <div className="space-y-4">
      {/*
        * What you are looking at, said once, at the top.
        *
        * The controls used to be three unlabelled boxes — a grain, a bare
        * date field marked "Covering", and a level — and between them they
        * decide what the whole page means. Reading the page meant inferring
        * it. Now the sentence states the report and the controls sit under
        * it, each with a label saying what it changes.
        */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-text">
              {grain === 'DAY' ? 'Daily' : grain === 'WEEK' ? 'Weekly' : 'Monthly'} report
              {' — '}{d?.period?.label}
            </h3>
            <p className="text-xs text-text-muted">
              {day(d?.period?.from)} to {day(d?.period?.to)}, broken down by{' '}
              {LEVEL_LABELS[level].toLowerCase()}, compared against{' '}
              {d?.previous_period?.label ?? `the previous ${noun}`}.
            </p>
          </div>
          <ExportMenu
            sheet={sheet}
            fileName={`survey-report-${grain.toLowerCase()}-${String(d?.period?.from ?? asOf)}`}
            note={`${units.length} ${LEVEL_LABELS[level].toLowerCase()}${units.length === 1 ? '' : 's'}`}
          />
        </div>

        <div className="flex flex-wrap items-end gap-4 border-t border-border pt-3">
          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">Report on</span>
            <div className="flex gap-1">
              {([['DAY', 'A day'], ['WEEK', 'A week'], ['MONTH', 'A month']] as const).map(
                ([g, label]) => (
                  <Button key={g} type="button" variant={grain === g ? 'secondary' : 'ghost'}
                    onClick={() => setGrain(g)}>{label}</Button>
                ))}
            </div>
          </label>

          <div className="text-2xs text-text-subtle">
            <span className="mb-1 block">Which {noun}</span>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost"
                title={`The ${noun} before this one`}
                onClick={() => setAsOf(stepPeriod(asOf, grain, -1))}>← Previous</Button>
              <input type="date" value={asOf} max={businessToday()}
                onChange={(e) => setAsOf(e.target.value)}
                title="Any day inside the period you want reported"
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
              <Button type="button" variant="ghost" disabled={atLatest}
                title={atLatest ? 'This is the current period' : `The ${noun} after this one`}
                onClick={() => setAsOf(stepPeriod(asOf, grain, 1))}>Next →</Button>
              {asOf !== businessToday() ? (
                <Button type="button" variant="ghost"
                  onClick={() => setAsOf(businessToday())}>Today</Button>
              ) : null}
            </div>
          </div>

          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">Break down by</span>
            <select value={level} onChange={(e) => setLevel(e.target.value as ReportLevel)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
              {REPORT_LEVELS.map((l) => (
                <option key={l} value={l}>{LEVEL_LABELS[l]}</option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <p className="text-sm text-text">{periodNote(d)}</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="Surveyed this period" value={`${acres(d?.area?.current)}`}
            hint={changeHint(d?.area)}
            tone={d?.area?.direction === 'DOWN' ? 'warning'
              : d?.area?.direction === 'UP' ? 'success' : undefined} />
          <Stat label="Days worked"
            value={`${d?.effort?.active_days ?? 0} of ${d?.effort?.calendar_days ?? 0}`}
            hint="Calendar days that produced a return"
            explain={GLOSSARY.daysWorked} />
          <Stat label="Per working day"
            value={d?.effort?.area_per_active_day === null
              ? '—' : `${acres(d?.effort?.area_per_active_day)}/day`}
            hint="Divided by days worked, not days on the calendar"
            explain={GLOSSARY.pace} />
          <Stat label="Villages worked" value={count(d?.effort?.villages_worked)}
            explain={GLOSSARY.daysWorked} />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Stat label="Rovers used" value={count(d?.rovers?.utilised)}
            explain={GLOSSARY.utilisation} />
          <Stat label="Rover days idle" value={count(d?.rovers?.idle)}
            explain={GLOSSARY.idleRovers}
            tone={(d?.rovers?.idle ?? 0) > 0 ? 'warning' : undefined}
            hint={(d?.rovers?.idle_reasons ?? []).map((r: string) => reasonLabel(r)).join(', ')
              || 'Nothing idle'} />
          <Stat label="Team days" value={count(d?.effort?.team_days)}
            explain={GLOSSARY.teamDays} />
        </div>
      </Card>

      {(d?.stage_movements ?? []).length > 0 ? (
        <Card className="space-y-2 p-4">
          <h3 className="text-sm font-semibold text-text">Stages that moved</h3>
          <p className="text-xs text-text-muted">
            No measure total shows that four villages finished ground truthing, and it is
            usually the first thing anybody asks.
          </p>
          <div className="flex flex-wrap gap-2">
            {(d.stage_movements as Row[]).map((mv, i) => (
              <Badge key={`${mv.stage_code}:${mv.to_state}:${i}`}
                tone={mv.to_state === 'COMPLETED' ? 'success'
                  : mv.to_state === 'IN_PROGRESS' ? 'warning' : 'neutral'}>
                {mv.villages} × {mv.stage_label} → {STAGE_STATE_LABELS[String(mv.to_state)]
                  ?? String(mv.to_state)}
              </Badge>
            ))}
          </div>
        </Card>
      ) : null}

      {units.length > 0 ? (
        <Card className="p-4">
          {/* Which units carried the period, ranked. The table below is
              alphabetical because people look things up in it; this answers
              "who did the work" without reading every row. */}
          <BarChart
            title={`Extent surveyed this period, by ${LEVEL_LABELS[level].toLowerCase()}`}
            unit="Ac"
            points={[...units]
              .map((u) => ({ label: String(u.name), value: round1(periodTotal(u.period)) }))
              .filter((u) => u.value > 0)
              .sort((a, b) => b.value - a.value)
              .slice(0, 12)}
          />
        </Card>
      ) : null}

      {units.length === 0 ? (
        <EmptyState title="Nothing recorded in this period"
          description="No day's return falls inside these dates." />
      ) : (
        <Card className="p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2">
            <h3 className="text-sm font-semibold text-text">
              Every {LEVEL_LABELS[level].toLowerCase()}, in full
            </h3>
            <span className="text-2xs text-text-subtle">
              Alphabetical, so a place can be looked up. The chart above ranks them.
            </span>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="px-4 py-2">{LEVEL_LABELS[level]}</th>
                <th className="px-4 py-2 text-right">Villages</th>
                <th className="px-4 py-2 text-right">This {noun}</th>
                <th className="px-4 py-2 text-right">Previous {noun}</th>
                <th className="px-4 py-2 text-right">Cumulative</th>
                <th className="px-4 py-2 text-right">Complete</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => {
                const here = periodTotal(u.period);
                const before = periodTotal(u.previous);
                return (
                  <tr key={String(u.id ?? u.name)} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-text">{String(u.name)}</td>
                    <td className="px-4 py-2 text-right text-text-muted">{count(u.villages)}</td>
                    <td className="px-4 py-2 text-right text-text">{acres(here)}</td>
                    <td className="px-4 py-2 text-right text-text-muted">{acres(before)}</td>
                    <td className="px-4 py-2 text-right text-text-muted">
                      {acres(u.cumulative?.doneAc)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className={pctTone(u.cumulative?.pct) === 'danger'
                        ? 'text-danger' : 'text-text'}>
                        {pct(u.cumulative?.pct)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <p className="border-t border-border px-4 py-2 text-2xs text-text-subtle">
            “This {noun}” and “previous {noun}” are extents surveyed inside those dates.
            Cumulative is everything recorded since the programme began, and complete is
            that against the extent to survey.
          </p>
        </Card>
      )}
    </div>
  );
}

/** Extent measures added up, which is what "surveyed" means on this table. */
function periodTotal(values: Record<string, number> | undefined): number {
  if (!values) return 0;
  return Object.values(values).reduce((t, v) => t + Number(v ?? 0), 0);
}

/* ------------------------------------------------------------ moving villages */

/**
 * Move the villages the filter is showing into another programme.
 *
 * Deliberately tied to the filter rather than offering a thousand tick
 * boxes: the reason to move villages is almost always "this district" or
 * "this mandal", which is exactly what the filter above has already
 * selected. It refuses to appear when nothing is filtered, because "move
 * all 1,183" is not an action anybody should reach by accident.
 */
function MoveVillages({ projectId, villages }: { projectId: string; villages: Row[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState('');
  const [done, setDone] = React.useState<string | null>(null);

  const programmes = useQuery({
    queryKey: ['survey-projects'],
    enabled: open,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/survey/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const move = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/projects/${projectId}/villages/move`, {
        method: 'POST',
        body: { village_ids: villages.map((v) => String(v.id)), to_project_id: target },
        // A district's worth of villages, each carrying its returns.
        timeoutMs: 180_000,
      }),
    onSuccess: (res: any) => {
      const d = res?.data ?? {};
      setDone(`${d.moved} moved to ${d.to}`
        + (d.already_there ? `; ${d.already_there} already listed there` : ''));
      setTarget('');
      qc.invalidateQueries({ queryKey: ['survey-villages'] });
      qc.invalidateQueries({ queryKey: ['survey-projects'] });
      qc.invalidateQueries({ queryKey: ['survey-progress'] });
    },
  });

  if (!open) {
    return (
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
        Move these {villages.length} to another programme
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-text-muted">
        Move {villages.length} village{villages.length === 1 ? '' : 's'} to
      </span>
      <select value={target} onChange={(e) => setTarget(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
        <option value="">Choose a programme…</option>
        {(programmes.data ?? [])
          .filter((p) => String(p.id) !== projectId)
          .map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>)}
      </select>
      <Button type="button" variant="primary" loading={move.isPending}
        disabled={!target} onClick={() => move.mutate()}>
        Move
      </Button>
      <Button type="button" variant="ghost" onClick={() => { setOpen(false); setDone(null); }}>
        Cancel
      </Button>
      {done ? <span className="text-2xs text-success">{done}</span> : null}
      {move.isError ? <ErrorCard error={move.error} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------- deployment */

/**
 * Who and what is on this programme, at the level being asked about
 * (§note 3).
 *
 * "Show me the people and the equipment on this project at village, mandal
 * and district level" took four screens and a spreadsheet: crew per village
 * on one, rover allocations on another, programme staff on a third, and
 * nothing joining them.
 */
function Deployment({
  projectId, level, setLevel,
}: {
  projectId: string; level: ReportLevel; setLevel: (l: ReportLevel) => void;
}) {
  const q = useQuery({
    queryKey: ['survey-deployment', projectId, level],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/deployment?level=${level}`))
        .body as { data: Row }).data,
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data as Row;
  const units: Row[] = d?.units ?? [];
  const staff: Row[] = d?.programme_staff ?? [];

  const uncrewed = Number(d?.totals?.villages_uncrewed ?? 0);
  const unequipped = Number(d?.totals?.villages_unequipped ?? 0);

  const sheet = {
    name: `Deployment by ${LEVEL_LABELS[level]}`.slice(0, 31),
    columns: [
      { header: LEVEL_LABELS[level], width: 28 },
      { header: 'Villages', width: 10 },
      { header: 'Nobody on them', width: 16 },
      { header: 'No instrument', width: 14 },
      { header: 'People', width: 10 },
      { header: 'Instruments', width: 12 },
      { header: 'Who', width: 60 },
      { header: 'What', width: 40 },
    ],
    rows: units.map((u) => [
      cellText(u.name), cellNum(u.villages),
      cellNum(u.villages_uncrewed), cellNum(u.villages_unequipped),
      cellNum(u.crew), cellNum(u.rovers_out),
      (u.people as Row[]).map((p) => String(p.name)).join('; '),
      (u.assets as Row[]).map((a) => String(a.asset_code)).join('; '),
    ]),
  };

  return (
    <div className="space-y-4">
      {/*
        * What this screen answers, said before the table.
        *
        * It used to open on a level picker and a grid of counts headed
        * "Crew / Instruments / Who / What", which is a description of the
        * data rather than of the question. The question is always the same:
        * is everything covered, and where is it not.
        */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-text">Who and what is out right now</h3>
            <p className="text-xs text-text-muted">
              People assigned to villages and instruments allocated against them, as they stand
              today — not a history. Grouped by {LEVEL_LABELS[level].toLowerCase()}.
            </p>
          </div>
          <ExportMenu sheet={sheet} fileName={`survey-deployment-${level}`}
            note={`${units.length} ${LEVEL_LABELS[level].toLowerCase()}${units.length === 1 ? '' : 's'}`} />
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="Villages covered"
            value={`${count(Number(d?.totals?.villages ?? 0) - uncrewed)} of ${count(d?.totals?.villages)}`}
            hint="Villages with at least one person assigned"
            tone={uncrewed > 0 ? 'warning' : 'success'} />
          <Stat label="People deployed" value={count(d?.totals?.crew)}
            hint={(d?.totals?.programme_staff ?? 0) > 0
              ? `plus ${count(d?.totals?.programme_staff)} on the programme itself`
              : 'Counted once, however many villages they are on'} />
          <Stat label="Instruments out" value={count(d?.totals?.assets)}
            hint="Allocated and not yet returned" />
          <Stat label="Crewed with no instrument" value={count(unequipped)}
            tone={unequipped > 0 ? 'warning' : 'success'}
            hint="People on the ground with nothing to survey with" />
        </div>

        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">Group by</span>
            <select value={level} onChange={(e) => setLevel(e.target.value as ReportLevel)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
              {REPORT_LEVELS.map((l) => (
                <option key={l} value={l}>{LEVEL_LABELS[l]}</option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {uncrewed > 0 ? (
        <Notice tone="warning"
          title={`${uncrewed} village${uncrewed === 1 ? ' has' : 's have'} nobody assigned`}>
          {/* A count of crew says how many are deployed, never where nobody
              is. Four people in a mandal of eleven villages reads as coverage
              until you notice they are all on one village. */}
          They will record no progress until somebody is put on them. The list below shows which{' '}
          {LEVEL_LABELS[level].toLowerCase()}s they sit in; open a village from the Villages tab
          to assign crew.
        </Notice>
      ) : null}

      {staff.length > 0 ? (
        <Card className="space-y-2 p-4">
          <h3 className="text-sm font-semibold text-text">On the programme</h3>
          <p className="text-xs text-text-muted">
            {/* Dividing these between mandals would invent a posting nobody
                made; leaving them out understates a district that has a
                manager and no crew yet. */}
            Assigned to the programme rather than to one village, so they belong to every
            level of it.
          </p>
          <div className="flex flex-wrap gap-2">
            {staff.map((p) => (
              <Badge key={String(p.employee_id)} tone="neutral">
                {String(p.name)} · {String(p.project_role).replaceAll('_', ' ').toLowerCase()}
              </Badge>
            ))}
          </div>
        </Card>
      ) : null}

      {units.length === 0 ? (
        <EmptyState title="Nothing deployed yet"
          description="Assign crew and allocate rovers to villages and they appear here." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="px-4 py-2">{LEVEL_LABELS[level]}</th>
                <th className="px-4 py-2 text-right">Villages</th>
                {/* The gap, beside the coverage, rather than left to be
                    worked out from two counts that do not subtract. */}
                <th className="px-4 py-2 text-right">Nobody on them</th>
                <th className="px-4 py-2 text-right">People</th>
                <th className="px-4 py-2 text-right">Instruments</th>
                <th className="px-4 py-2">Who is there</th>
                <th className="px-4 py-2">What they have</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={String(u.id ?? u.name)} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-2 text-text">{String(u.name)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{count(u.villages)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className={Number(u.villages_uncrewed ?? 0) > 0
                      ? 'font-semibold text-warning' : 'text-text-subtle'}>
                      {count(u.villages_uncrewed)}
                    </span>
                    {Number(u.villages_unequipped ?? 0) > 0 ? (
                      <div className="text-2xs text-text-subtle">
                        {count(u.villages_unequipped)} without an instrument
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{count(u.crew)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{count(u.rovers_out)}</td>
                  <td className="px-4 py-2">
                    {/* Names, not a count: knowing which four is what the
                        question is actually for. Long lists are trimmed with
                        the remainder stated, because a cell holding forty
                        names is unreadable and hides the row beside it. */}
                    <NameList items={(u.people as Row[]).map((p) => String(p.name))} />
                  </td>
                  <td className="px-4 py-2">
                    <NameList items={(u.assets as Row[]).map((a) => String(a.asset_code))} mono />
                  </td>
                </tr>
              ))}
            </tbody>
            {/* Totals count each person and each instrument once, however
                many units they appear in — the same rover listed under two
                mandals is one rover, and a column that adds the rows up
                would say otherwise. */}
            <tfoot>
              <tr className="border-t-2 border-border font-medium">
                <td className="px-4 py-2 text-text">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{count(d?.totals?.villages)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <span className={uncrewed > 0 ? 'text-warning' : 'text-text-subtle'}>
                    {count(uncrewed)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{count(d?.totals?.crew)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{count(d?.totals?.assets)}</td>
                <td className="px-4 py-2 text-2xs font-normal text-text-subtle" colSpan={2}>
                  Each person and instrument counted once across {count(units.length)}{' '}
                  {LEVEL_LABELS[level].toLowerCase()}
                  {units.length === 1 ? '' : 's'}
                  {(d?.totals?.programme_staff ?? 0) > 0
                    ? `, plus ${count(d?.totals?.programme_staff)} on the programme itself`
                    : ''}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  );
}

/**
 * A list of names in a table cell, trimmed before it swamps the row.
 *
 * Forty names comma-joined in a cell is not a list anybody reads, and it
 * pushes every other column off the screen. Ten, then the count of the rest,
 * with the whole list on hover for the times somebody does need it.
 */
function NameList({ items, mono }: { items: string[]; mono?: boolean }) {
  if (items.length === 0) return <span className="text-2xs text-text-subtle">—</span>;
  const shown = items.slice(0, 10);
  const rest = items.length - shown.length;
  return (
    <span className={`text-2xs text-text-muted ${mono ? 'font-mono' : ''}`}
      title={items.join(', ')}>
      {shown.join(', ')}
      {rest > 0 ? (
        <span className="text-text-subtle"> and {rest} more</span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------- crew and rovers */

/**
 * What each person and each instrument did (§38).
 *
 * Both endpoints have existed since the module was built and nothing showed
 * them, so the answer to "which rovers are earning their keep" lived in the
 * API and nowhere a supervisor could reach it.
 *
 * Two deliberate choices carried up from the API. A person's average is per
 * day they were out, not per calendar day — the days they were not working
 * are not theirs, and dividing by them ranks whoever was rostered most rather
 * than whoever did most. And idle days are broken down by reason, because
 * "three idle days" is a number while "three idle days, all rover fault" is a
 * maintenance job.
 */
function CrewAndRovers({
  projectId, range,
}: { projectId: string; range: { from: string; to: string } }) {
  const [view, setView] = React.useState<'people' | 'rovers'>('people');

  const people = useQuery({
    queryKey: ['survey-employee-productivity', projectId, range],
    enabled: view === 'people',
    queryFn: async () => {
      const q = new URLSearchParams({ from: range.from, to: range.to });
      return ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/employee-productivity?${q}`))
        .body as { data: Row }).data;
    },
  });

  const rovers = useQuery({
    queryKey: ['survey-rover-productivity', projectId, range],
    enabled: view === 'rovers',
    queryFn: async () => {
      const q = new URLSearchParams({ from: range.from, to: range.to });
      return ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/rover-productivity?${q}`))
        .body as { data: Row }).data;
    },
  });

  const active = view === 'people' ? people : rovers;
  const crew: Row[] = people.data?.employees ?? [];
  const fleet: Row[] = rovers.data?.rovers ?? [];

  return (
    <div className="space-y-4">
      <Toolbar>
        <div className="flex gap-1">
          <Button type="button" variant={view === 'people' ? 'secondary' : 'ghost'}
            onClick={() => setView('people')}>People</Button>
          <Button type="button" variant={view === 'rovers' ? 'secondary' : 'ghost'}
            onClick={() => setView('rovers')}>Rovers</Button>
        </div>
        <span className="ml-auto text-2xs text-text-subtle">
          {day(range.from)} to {day(range.to)}
        </span>
      </Toolbar>

      {active.isLoading ? <Skeleton className="h-64" /> : null}
      {active.isError ? (
        <ErrorCard error={active.error} onRetry={() => active.refetch()} />
      ) : null}

      {view === 'people' && people.isSuccess ? (
        crew.length === 0 ? (
          <EmptyState title="Nobody has been recorded against a rover yet"
            description="Per-person figures come from the rovers named on each day's return." />
        ) : (
          <>
            <Card className="p-4">
              <BarChart
                title="Extent surveyed in this range, by person"
                unit="Ac"
                points={crew.filter((c) => Number(c.area_ac) > 0).slice(0, 12)
                  .map((c) => ({
                    label: String(c.employee_name), value: round1(Number(c.area_ac)),
                  }))}
              />
            </Card>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Person</TH>
                    <TH className="text-right">Days out</TH>
                    <TH className="text-right">Villages</TH>
                    <TH className="text-right">Surveyed</TH>
                    <TH className="text-right">Per day out</TH>
                    <TH className="text-right">Rover use</TH>
                    <TH className="text-right">Thin days</TH>
                  </TR>
                </THead>
                <TBody>
                  {crew.map((c) => (
                    <TR key={String(c.employee_id)}>
                      <TD>
                        <div className="font-medium text-text">{String(c.employee_name)}</div>
                        <div className="text-2xs text-text-subtle">{String(c.emp_no)}</div>
                      </TD>
                      <TD className="text-right tabular-nums">{count(c.days_worked)}</TD>
                      <TD className="text-right tabular-nums">{count(c.villages_worked)}</TD>
                      <TD className="text-right tabular-nums">{acres(c.area_ac)}</TD>
                      {/* Per day they were out. The days they were not are
                          not theirs, and dividing by them ranks whoever was
                          rostered most rather than whoever did most. */}
                      <TD className="text-right tabular-nums">
                        {c.avg_daily_ac === null ? '—' : acres(c.avg_daily_ac)}
                      </TD>
                      <TD className="text-right">
                        {c.rover_utilisation_pct === null ? '—' : (
                          <Badge tone={pctTone(c.rover_utilisation_pct) === 'danger'
                            ? 'danger' : 'neutral'}>
                            {pct(c.rover_utilisation_pct)}
                          </Badge>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {Number(c.low_progress_days) > 0 ? (
                          <span className="text-warning">{count(c.low_progress_days)}</span>
                        ) : '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
            <p className="text-2xs text-text-subtle">
              “Thin days” are days that fell below this programme’s threshold and carried a
              reason. They are context, not a verdict — weather and access account for most.
            </p>
          </>
        )
      ) : null}

      {view === 'rovers' && rovers.isSuccess ? (
        fleet.length === 0 ? (
          <EmptyState title="No rover has been recorded on a return yet"
            description="Allocate rovers to a village and account for them on the day’s return." />
        ) : (
          <>
            <Card className="p-4">
              {/* Ordered by idle days by the API: the instruments costing
                  money and doing nothing come first, which is the list
                  somebody acts on. */}
              <StackBar
                title="Rover days across this range"
                segments={[
                  { key: 'used', label: 'Utilised',
                    value: fleet.reduce((t, r) => t + Number(r.utilized_days ?? 0), 0) },
                  { key: 'idle', label: 'Idle',
                    value: fleet.reduce((t, r) => t + Number(r.idle_days ?? 0), 0) },
                ]}
              />
            </Card>
            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Rover</TH>
                    <TH className="text-right">Days assigned</TH>
                    <TH className="text-right">Used</TH>
                    <TH className="text-right">Idle</TH>
                    <TH className="text-right">Utilisation</TH>
                    <TH className="text-right">Surveyed</TH>
                    <TH>Why it sat</TH>
                  </TR>
                </THead>
                <TBody>
                  {fleet.map((r) => (
                    <TR key={String(r.asset_id)}>
                      <TD>
                        <div className="font-medium text-text">{String(r.asset_code)}</div>
                        <div className="text-2xs text-text-subtle">
                          {String(r.asset_name)}
                          {r.serial_number ? ` · ${String(r.serial_number)}` : ''}
                        </div>
                      </TD>
                      <TD className="text-right tabular-nums">{count(r.assigned_days)}</TD>
                      <TD className="text-right tabular-nums">{count(r.utilized_days)}</TD>
                      <TD className="text-right tabular-nums">
                        {Number(r.idle_days) > 0 ? (
                          <span className="text-warning">{count(r.idle_days)}</span>
                        ) : '—'}
                      </TD>
                      <TD className="text-right">
                        {r.utilisation_pct === null ? '—' : (
                          <Badge tone={pctTone(r.utilisation_pct) === 'danger'
                            ? 'danger' : pctTone(r.utilisation_pct) === 'warning'
                              ? 'warning' : 'success'}>
                            {pct(r.utilisation_pct)}
                          </Badge>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">{acres(r.area_ac)}</TD>
                      <TD>
                        {/* "Three idle days" is a number; "three idle days,
                            all rover fault" is a maintenance job. */}
                        {(r.idle_reasons ?? []).length === 0 ? (
                          <span className="text-2xs text-text-subtle">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {(r.idle_reasons as Row[]).map((ir) => (
                              <Badge key={String(ir.reason)} tone="neutral">
                                {String(ir.label)} × {ir.days}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </>
        )
      ) : null}
    </div>
  );
}

function Bottlenecks({ projectId, canForecast }: { projectId: string; canForecast: boolean }) {
  const stuck = useQuery({
    queryKey: ['survey-bottlenecks', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/bottlenecks`)).body as { data: Row }).data,
  });

  const forecast = useQuery({
    queryKey: ['survey-forecast', projectId],
    enabled: canForecast,
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/forecast`)).body as { data: Row }).data,
  });

  /*
   * Who was on site and filed nothing.
   *
   * Attendance already knows who turned up and which village for; set against
   * the returns actually filed, the difference is the list to work through
   * first. A village with nobody on it is not behind -- a village with four
   * people on it and no return is.
   */
  const unfiled = useQuery({
    queryKey: ['survey-unfiled', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/unfiled`)).body as Row),
  });

  if (stuck.isLoading) return <Skeleton className="h-64" />;
  if (stuck.isError) return <ErrorCard error={stuck.error} onRetry={() => stuck.refetch()} />;
  const rows: Row[] = stuck.data?.bottlenecks ?? [];
  const missing: Row[] = unfiled.data?.data ?? [];

  return (
    <div className="space-y-4">
      {missing.length > 0 ? (
        <Card className="space-y-3 p-4">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-text">On site, nothing filed</h3>
            <span className="text-xs text-text-muted">
              {unfiled.data?.unexplained ?? 0} unexplained
              {(unfiled.data?.accounted ?? 0) > 0
                ? `, ${unfiled.data?.accounted} accounted for` : ''}
            </span>
          </div>
          <p className="text-xs text-text-muted">
            People punched in against these villages today and no progress was recorded.
            A day with a reason stays on the list — one such day is an answer, a fortnight
            of them is a finding.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted">
                  <th className="py-1 pr-3">Village</th>
                  <th className="py-1 pr-3">Mandal</th>
                  <th className="py-1 pr-3">Who</th>
                  <th className="py-1 pr-3">Reason given</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((m, i) => (
                  <tr key={`${m.survey_village_id}:${m.emp_no}:${i}`}
                    className="border-t border-border">
                    <td className="py-1.5 pr-3 text-text">{String(m.village_name)}</td>
                    <td className="py-1.5 pr-3 text-text-muted">{String(m.mandal_name ?? '—')}</td>
                    <td className="py-1.5 pr-3 text-text-muted">{String(m.employee_name)}</td>
                    <td className="py-1.5 pr-3">
                      {m.reason ? (
                        <span className="text-text-muted">
                          {reasonLabel(String(m.reason))}
                          {m.remarks ? ` — ${String(m.remarks)}` : ''}
                        </span>
                      ) : (
                        <Badge tone="warning">Not accounted for</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {canForecast && forecast.data ? (
        <Card className="space-y-3 p-4">
          <h3 className="text-sm font-semibold text-text">Where this lands</h3>
          <p className="text-sm text-text">{forecastNote(forecast.data.forecast)}</p>
          <div className="grid gap-2 sm:grid-cols-4">
            <Stat label="Target date"
              value={forecast.data.forecast?.targetDate ? day(forecast.data.forecast.targetDate) : '—'}
              hint="What was committed to" />
            <Stat label="Projected"
              value={forecast.data.forecast?.forecastDate ? day(forecast.data.forecast.forecastDate) : '—'}
              tone={forecast.data.forecast?.state === 'BEHIND' ? 'danger'
                : forecast.data.forecast?.state === 'AHEAD' ? 'success' : undefined}
              hint="What the pace implies" />
            <Stat label="Village completion" value={pct(forecast.data.village_completion_pct)}
              explain={GLOSSARY.completion} />
            {/* Kept apart from village completion on purpose: the
                specification is explicit they are not interchangeable. */}
            <Stat label="Area completion" value={pct(forecast.data.area_completion_pct)}
              explain={GLOSSARY.completion} />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {[7, 14, 30].map((d) => (
              <Stat key={d} label={`Last ${d} days`}
                value={`${forecast.data.recent_pace?.[`last_${d}_days_ac_per_day`] ?? 0} Ac/day`}
                hint="A lifetime average hides a slowdown" />
            ))}
          </div>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing is stuck"
          description="No village is past its dates, sitting in a stage too long, silent, or holding idle rovers."
        />
      ) : (
        <Section title={`${rows.length} village${rows.length === 1 ? '' : 's'} needing attention`}>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Village</TH><TH>Mandal</TH><TH>Status</TH>
                  <TH>Stage</TH><TH>Why</TH><TH className="text-right">Days over</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((b) => (
                  <TR key={b.villageId}>
                    <TD className="font-medium text-text">{b.village}</TD>
                    <TD className="text-xs text-text-muted">{b.mandal ?? '—'}</TD>
                    <TD>
                      <Badge tone={villageStatusTone(b.status)}>
                        {VILLAGE_STATUS_LABELS[b.status] ?? b.status}
                      </Badge>
                    </TD>
                    <TD className="text-xs text-text-muted">
                      {b.currentStageCode ? stageLabel(b.currentStageCode) : '—'}
                    </TD>
                    <TD>
                      {/* Every reason, not the first: past its date *and*
                          holding idle rovers is a different conversation. */}
                      <ul className="space-y-0.5">
                        {b.kinds.map((k: string) => (
                          <li key={k} className="text-2xs text-warning">
                            {BOTTLENECK_LABELS[k] ?? k}
                          </li>
                        ))}
                      </ul>
                    </TD>
                    <TD className="text-right font-semibold tabular-nums text-danger">
                      {b.severityDays}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
          <p className="mt-2 text-2xs text-text-subtle">
            A stage counts as overdue after {stuck.data?.stage_sla_days} days.
            Severity is days past whichever threshold the village broke.
          </p>
        </Section>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- villages */

/**
 * The village list, and everything about one of them.
 *
 * Opens as a list because the question is comparative — which of these is
 * stuck — and drills into a single village for the crew, the instruments and
 * the stage remarks.
 */
function Villages({
  projectId, canManage, canEnter, openVillage, stageDrill, geoDrill, onDrillConsumed,
}: {
  projectId: string; canManage: boolean; canEnter: boolean;
  /** A village another screen linked to, opened on arrival. */
  openVillage?: string | null;
  /** A stage and state handed over from the roll-up's tally. */
  stageDrill?: { stage: string; state: string } | null;
  /** A mandal or district handed over from a roll-up row. */
  geoDrill?: { level: ReportLevel; name: string } | null;
  onDrillConsumed?: () => void;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState('');
  const [district, setDistrict] = React.useState('');
  const [mandal, setMandal] = React.useState('');
  const [stage, setStage] = React.useState('');
  // Which state of that stage: outstanding covers everything not finished.
  const [stageState, setStageState] = React.useState('OUTSTANDING');
  /*
   * Which villages to pull by what has been claimed on them (§066).
   *
   * "Everything where the first claim has gone in and the second has not" is
   * the list the office builds before every review, and it is a question
   * about two milestones at once — which is why it is one picker with named
   * answers rather than a milestone box and a claimed/unclaimed tick.
   */
  const [billing, setBilling] = React.useState('');

  /*
   * Take up a filter another part of the screen handed over.
   *
   * Consumed once, so going back to this tab later does not silently
   * reapply a filter the reader has already cleared.
   */
  React.useEffect(() => {
    if (stageDrill) {
      setStage(stageDrill.stage);
      setStageState(stageDrill.state);
      setDistrict(''); setMandal(''); setFilter('');
      onDrillConsumed?.();
    } else if (geoDrill) {
      if (geoDrill.level === 'mandal') { setMandal(geoDrill.name); setDistrict(''); }
      else if (geoDrill.level === 'district') { setDistrict(geoDrill.name); setMandal(''); }
      setStage(''); setFilter('');
      onDrillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageDrill, geoDrill]);

  // Somebody arriving from the progress form to allocate the rovers it told
  // them were missing lands on that village, not on a list to search again.
  React.useEffect(() => {
    if (openVillage) setOpen(openVillage);
  }, [openVillage]);

  const villages = useQuery({
    queryKey: ['survey-villages', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/villages`)).body as { data: Row[] }).data,
  });

  const progress = useQuery({
    queryKey: ['survey-progress', projectId, 'pipeline'],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/progress`)).body as { data: Row }).data,
    staleTime: 300_000,
  });

  if (villages.isLoading) return <Skeleton className="h-64" />;
  if (villages.isError) return <ErrorCard error={villages.error} onRetry={() => villages.refetch()} />;

  const pipeline: Row[] = progress.data?.pipeline ?? [];
  // The measure list, so the surveyed column knows which measures are acres.
  const measures: Row[] = progress.data?.measures ?? [];
  const all: Row[] = villages.data ?? [];
  const needle = filter.trim().toLowerCase();

  /*
   * The districts and mandals actually present, taken from the rows rather
   * than from a master list: a programme covering three mandals should not
   * offer a picker with two hundred, and one whose villages arrived without
   * a district should still be filterable by the ones that did.
   */
  const districts = [...new Set(all.map((v) => String(v.district_name ?? '')).filter(Boolean))].sort();
  const mandals = [...new Set(all
    .filter((v) => !district || String(v.district_name ?? '') === district)
    .map((v) => String(v.mandal_name ?? '')).filter(Boolean))].sort();

  /*
   * One question about stages, not two overlapping ones.
   *
   * It used to offer "<stage> outstanding" beside a "Not started" tick, which
   * are different ideas about different things: outstanding meant "not
   * finished" — not started, in progress and on hold all at once — while the
   * tick meant "nothing anywhere has begun". Selecting both was a correct AND
   * that read as a broken count, because 69 villages with vectorisation
   * unfinished became the 38 where nothing had started at all, and nothing on
   * screen explained why.
   *
   * Now one stage, one state. The count moves for a reason the reader chose.
   */
  const rows = all.filter((v) => {
    if (district && String(v.district_name ?? '') !== district) return false;
    if (mandal && String(v.mandal_name ?? '') !== mandal) return false;
    if (stage) {
      const at = stageStateOf(v, stage);
      if (stageState === 'OUTSTANDING' ? at === 'COMPLETED' : at !== stageState) return false;
    }
    if (!matchesBillingFilter(v.claimed_milestones ?? [], billing)) return false;
    if (!needle) return true;
    return [v.village_name, v.mandal_name, v.district_name, v.village_code]
      .some((f) => String(f ?? '').toLowerCase().includes(needle));
  });

  if (all.length === 0) {
    return (
      <EmptyState
        title="No villages in this programme"
        description="Load the village list from Setup before recording anything against it."
      />
    );
  }

  return (
    <div className="space-y-3">
      <Toolbar>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a village, code, mandal or district…"
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
        />
        <select value={district}
          onChange={(e) => { setDistrict(e.target.value); setMandal(''); }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
          <option value="">All districts</option>
          {districts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={mandal} onChange={(e) => setMandal(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
          <option value="">All mandals</option>
          {mandals.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
          <option value="">Any stage</option>
          {pipeline.map((p) => (
            <option key={String(p.code)} value={String(p.code)}>{String(p.label)}</option>
          ))}
        </select>
        <select value={billing} onChange={(e) => setBilling(e.target.value)}
          title="Pull villages by what has been submitted for billing"
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
          {BILLING_FILTERS.map((b) => (
            <option key={b.value} value={b.value}>{b.label}</option>
          ))}
        </select>
        {stage ? (
          <select value={stageState} onChange={(e) => setStageState(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
            <option value="OUTSTANDING">not finished</option>
            <option value="NOT_STARTED">still to start</option>
            <option value="IN_PROGRESS">in progress</option>
            <option value="ON_HOLD">on hold</option>
            <option value="COMPLETED">finished</option>
          </select>
        ) : null}
        {/*
          * Moving what the filter is showing.
          *
          * Programmes get split and merged — a district carved into its own
          * contract, two pilots folded together. Re-importing the list into
          * the other programme would leave the progress behind, which is the
          * whole record, so the villages move with everything recorded
          * against them.
          */}
        {canManage && rows.length > 0 && rows.length < all.length ? (
          <MoveVillages projectId={projectId} villages={rows} />
        ) : null}
        {(district || mandal || stage || filter || billing) ? (
          <Button type="button" variant="ghost" onClick={() => {
            setDistrict(''); setMandal(''); setStage('');
            setStageState('OUTSTANDING'); setFilter(''); setBilling('');
          }}>Clear</Button>
        ) : null}
        <span className="ml-auto text-2xs text-text-subtle">
          {rows.length} of {all.length} villages
          {stage ? ` · ${stageLabel(stage, pipeline as any)} ${
            stageState === 'OUTSTANDING' ? 'not finished'
              : (STAGE_STATE_LABELS[stageState] ?? stageState).toLowerCase()}` : ''}
        </span>
        {/* The filtered list, in a file. This is the table that goes out with
            a claim or a review note, and it was being retyped. */}
        <ExportMenu
          sheet={{
            name: 'Villages',
            columns: [
              { header: '#', width: 6 },
              { header: 'Village', width: 28 },
              { header: 'Code', width: 14 },
              { header: 'District', width: 20 },
              { header: 'Mandal', width: 20 },
              { header: 'Extent (Ac)', width: 14 },
              { header: 'Surveyed (Ac)', width: 14 },
              { header: 'Surveyed (%)', width: 14 },
              { header: 'Where it has got to', width: 24 },
              { header: 'Claimed (%)', width: 12 },
              { header: 'Milestones claimed', width: 20 },
              { header: 'Assigned to', width: 24 },
            ],
            rows: rows.map((v, i) => {
              const walked = surveyedExtent(v, measures as any);
              const planned = Number(v.total_extent_ac ?? 0);
              const at = pipeline.find(
                (st) => (v.stages?.[String(st.code)] ?? 'NOT_STARTED') !== 'COMPLETED');
              return [
                String(i + 1), cellText(v.village_name), cellText(v.village_code),
                cellText(v.district_name), cellText(v.mandal_name),
                cellNum(v.total_extent_ac), cellNum(walked),
                planned > 0 ? cellNum((walked / planned) * 100) : '',
                at ? `${stageLabel(String(at.code), pipeline as any)} — ${
                  (STAGE_STATE_LABELS[String(v.stages?.[String(at.code)] ?? 'NOT_STARTED')]
                    ?? '').toLowerCase()}`.trim() : 'Finished',
                cellNum(v.claimed_percent),
                (v.claimed_milestones ?? []).join(', '),
                cellText(v.assignee_name),
              ];
            }),
          }}
          fileName="survey-villages"
        />
      </Toolbar>

      <TableWrap>
        <Table>
          <THead>
            <TR>
              {/* A running number, so a row can be referred to out loud and
                  found again in a list of a thousand. It follows the filter
                  rather than the underlying record, which is what somebody
                  reading the screen is counting. */}
              <TH className="text-right">#</TH>
              <TH>Village and code</TH>
              <TH>District</TH>
              <TH>Mandal</TH>
              {/*
                * Two numbers, not one.
                *
                * The extent is what the revenue record says the village is;
                * the surveyed figure is what the crews have actually walked.
                * They differ, sometimes a lot, and that difference is the work
                * remaining — showing only one of them hides it.
                */}
              <TH className="text-right">Extent</TH>
              <TH className="text-right">Surveyed</TH>
              <TH>Where it has got to</TH>
              {/* What has been claimed, beside where the work has got to:
                  they move apart, and the gap between them is money sitting
                  unbilled on finished villages. */}
              <TH>Billed</TH>
              <TH>Assigned to</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.map((v, index) => {
              const isOpen = open === String(v.id);
              // The furthest stage not yet complete: the work waiting, which
              // is what somebody means by "where is this village".
              const at = pipeline.find((s) => (v.stages?.[String(s.code)] ?? 'NOT_STARTED') !== 'COMPLETED');
              const atState = at ? (v.stages?.[String(at.code)] ?? 'NOT_STARTED') : 'COMPLETED';
              return (
                <React.Fragment key={String(v.id)}>
                  <TR>
                    <TD className="text-right tabular-nums text-2xs text-text-subtle">
                      {index + 1}
                    </TD>
                    <TD>
                      {/* The name opens the village, because that is what
                          somebody reading a list of a thousand is trying to
                          do. */}
                      <button
                        type="button"
                        className="text-left font-medium text-text hover:text-primary hover:underline"
                        onClick={() => setOpen(isOpen ? null : String(v.id))}
                      >
                        {v.village_name}
                      </button>
                      {/*
                        * The revenue department's code, said to be one.
                        *
                        * It rendered as a bare grey string beside the name and
                        * read as noise — nobody could tell 1501041 from a row
                        * number or an internal id. Thirty-four village names in
                        * the Krishna programme belong to more than one village,
                        * and this is the only thing that tells them apart.
                        */}
                      {v.village_code ? (
                        <span
                          className="ml-1.5 whitespace-nowrap rounded bg-surface-sunken px-1 py-0.5 font-mono text-2xs text-text-subtle"
                          title="The revenue department's village code. Reconciliation is done on codes, not names — two villages with the same name in one district is ordinary."
                        >
                          {v.village_code}
                        </span>
                      ) : null}
                    </TD>
                    <TD className="text-xs text-text-muted">{v.district_name ?? '—'}</TD>
                    <TD className="text-xs text-text-muted">{v.mandal_name ?? '—'}</TD>
                    <TD className="text-right tabular-nums">{acres(v.total_extent_ac)}</TD>
                    <TD className="text-right tabular-nums">
                      {(() => {
                        const walked = surveyedExtent(v, measures as any);
                        const planned = Number(v.total_extent_ac ?? 0);
                        return (
                          <>
                            <span className={walked > 0 ? 'text-text' : 'text-text-subtle'}>
                              {acres(walked)}
                            </span>
                            {planned > 0 && walked > 0 ? (
                              <span className="ml-1 text-2xs text-text-subtle">
                                {pct((walked / planned) * 100)}
                              </span>
                            ) : null}
                          </>
                        );
                      })()}
                    </TD>
                    <TD>
                      <Badge tone={stateTone(atState)}>
                        {at ? stageLabel(String(at.code), pipeline as any) : 'Finished'}
                      </Badge>
                      {at && atState !== 'NOT_STARTED' ? (
                        <span className="ml-1 text-2xs text-text-subtle">
                          {STAGE_STATE_LABELS[atState]?.toLowerCase()}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      {(() => {
                        const claimed: number[] = v.claimed_milestones ?? [];
                        const share = Number(v.claimed_percent ?? 0);
                        if (claimed.length === 0) {
                          return <span className="text-2xs text-text-subtle">—</span>;
                        }
                        return (
                          <Badge tone={share >= 100 ? 'success' : 'neutral'}>
                            {share}%
                            <span className="ml-1 text-2xs opacity-70">
                              M{claimed.join(', M')}
                            </span>
                          </Badge>
                        );
                      })()}
                    </TD>
                    <TD className="text-xs text-text-muted">{v.assignee_name ?? '—'}</TD>
                    <TD className="text-right">
                      <Button type="button" variant="ghost"
                        onClick={() => setOpen(isOpen ? null : String(v.id))}>
                        {isOpen ? 'Hide' : 'Open'}
                      </Button>
                    </TD>
                  </TR>
                  {isOpen ? (
                    <TR>
                      <TD colSpan={10} className="bg-surface-sunken p-0">
                        <VillageDetail
                          village={v}
                          pipeline={pipeline}
                          canManage={canManage}
                          canEnter={canEnter}
                        />
                      </TD>
                    </TR>
                  ) : null}
                </React.Fragment>
              );
            })}
          </TBody>
        </Table>
      </TableWrap>
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

  // Only for the measure names. A column headed "govt land extent ac" is the
  // database's word for it, not the office's.
  const meta = useQuery({
    queryKey: ['survey-progress', projectId, 'pipeline'],
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/progress`)).body as { data: Row }).data,
    staleTime: 300_000,
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  if (!data) return null;

  const labels = new Map<string, string>(
    ((meta.data?.measures ?? []) as Row[]).map((m) => [String(m.code), String(m.label)]));
  const nameOf = (code: string) =>
    labels.get(code) ?? code.replaceAll('_', ' ').toLowerCase();

  const periods: Row[] = data.periods ?? [];
  // Only measures that anybody actually recorded in the window, so a wide
  // table does not fill with empty columns.
  const active = Object.keys(periods[0]?.measures ?? {})
    .filter((code) => periods.some((p) => (p.measures[code] ?? 0) > 0));
  const peak = Math.max(1, ...periods.flatMap((p) => active.map((c) => p.measures[c] ?? 0)));
  // Extent measures added together are what "surveyed" means on the chart;
  // counting a village tally into the same line would be adding apples to
  // acres.
  const extentCodes = active.filter((c) => /_AC$|EXTENT/.test(c));

  /*
   * Is the programme speeding up or slowing down?
   *
   * That is the only question a run of periods answers that a single figure
   * cannot, and the tab used to leave the reader to work it out off a line
   * chart. The last period against the average of the ones before it says it
   * in a sentence.
   */
  const extentOf = (p: Row) => extentCodes.reduce((t, c) => t + (p.measures[c] ?? 0), 0);
  const worked = periods.filter((p) => extentOf(p) > 0);
  const latest = worked.length ? worked[worked.length - 1] : null;
  const earlier = worked.slice(0, -1);
  const average = earlier.length
    ? earlier.reduce((t, p) => t + extentOf(p), 0) / earlier.length : null;
  const trend = latest && average !== null && average > 0
    ? (extentOf(latest) - average) / average : null;
  const nounPlural = `${PERIOD_NOUNS[grain] ?? 'period'}s`;

  const sheet = {
    name: `Trend by ${nounPlural}`.slice(0, 31),
    columns: [
      { header: 'Period', width: 22 },
      { header: 'From', width: 12 },
      { header: 'To', width: 12 },
      { header: 'Villages worked', width: 16 },
      ...active.map((c) => ({ header: nameOf(c), width: 18 })),
    ],
    rows: periods.map((p) => [
      cellText(p.label), cellText(p.from), cellText(p.to), cellNum(p.villages),
      ...active.map((c) => cellNum(p.measures[c])),
    ]),
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-text">
              Is the pace holding up?
            </h3>
            <p className="text-xs text-text-muted">
              {/* The tab was called "Over time", which names the axis rather
                  than the question, and showed a chart with no reading of it
                  anywhere on screen. */}
              Everything recorded between {day(range.from)} and {day(range.to)}, grouped into{' '}
              {nounPlural}. Change the dates in the bar at the top of the page.
            </p>
          </div>
          <ExportMenu sheet={sheet} fileName={`survey-trend-${grain.toLowerCase()}`}
            note={`${periods.length} ${nounPlural}`} />
        </div>

        {latest ? (
          <p className="text-sm text-text">
            {trend === null
              ? `${acres(extentOf(latest))} surveyed in ${latest.label} — the first ${
                PERIOD_NOUNS[grain] ?? 'period'} with anything recorded, so there is nothing yet to compare it against.`
              : trend > 0.1
                ? `Picking up: ${acres(extentOf(latest))} in ${latest.label}, ${
                  Math.round(trend * 100)}% above the ${acres(average)} averaged over the ${
                  earlier.length} earlier ${earlier.length === 1 ? (PERIOD_NOUNS[grain] ?? 'period') : nounPlural}.`
                : trend < -0.1
                  ? `Slowing: ${acres(extentOf(latest))} in ${latest.label}, ${
                    Math.round(Math.abs(trend) * 100)}% below the ${acres(average)} averaged over the ${
                    earlier.length} earlier ${earlier.length === 1 ? (PERIOD_NOUNS[grain] ?? 'period') : nounPlural}.`
                  : `Holding steady: ${acres(extentOf(latest))} in ${latest.label}, against ${
                    acres(average)} averaged over the ${earlier.length} earlier ${
                    earlier.length === 1 ? (PERIOD_NOUNS[grain] ?? 'period') : nounPlural}.`}
          </p>
        ) : null}

        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">Group into</span>
            <div className="flex gap-1">
              {GRAINS.map((g) => (
                <Button key={g.value} type="button"
                  variant={grain === g.value ? 'secondary' : 'ghost'}
                  onClick={() => setGrain(g.value)}>
                  {g.label}
                </Button>
              ))}
            </div>
          </label>
          <span className="ml-auto text-2xs text-text-subtle">
            Financial year {data.financial_year?.label}
          </span>
        </div>
      </Card>

      {periods.length === 0 || active.length === 0 ? (
        <EmptyState
          title="Nothing recorded in this window"
          description="No daily progress falls between these dates. Widen the dates in the bar at the top of the page, or record a day’s progress first."
        />
      ) : (
        <>
          {/* The shape of the work, before the numbers behind it (§39). A
              table of forty rows hides a slowdown that a line shows in a
              second; the table stays underneath for the exact figures. */}
          <Card className="space-y-4 p-4">
            <LineChart
              title="Extent surveyed each period"
              unit="Ac"
              points={periods.map((p) => ({
                label: p.label,
                value: round1(extentCodes.reduce((t, c) => t + (p.measures[c] ?? 0), 0)),
              }))}
            />
            <BarChart
              title="Villages worked each period"
              points={periods.map((p) => ({ label: p.label, value: p.villages ?? 0 }))}
            />
          </Card>
          <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Period</TH>
                <TH className="text-right">Villages worked</TH>
                {active.map((c) => <TH key={c} className="text-right">{nameOf(c)}</TH>)}
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
        </>
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
            <TH>Assigned to</TH>
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
              {/* Who is on it, by employee name. The daily entry records a
                  team count; the task records the person. */}
              <TD className="text-xs text-text-muted">{r.assignee_name ?? '—'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrap>
  );
}

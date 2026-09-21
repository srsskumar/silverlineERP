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
import { BillingBulkBar } from '@/components/survey/BillingBulkBar';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Notice, Section, Stat } from '@/components/finance/Primitives';
import { SurveyDashboard } from '@/components/survey/Dashboard';
import { GLOSSARY } from '@/components/ui/InfoHint';
import { day, businessToday } from '@/lib/finance';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import {
  staffingNote, formatCoordinate, GCP_WARNING_NOTES, checkGcp,
  extentVariancePct, extentVaries, acresToSqKm,
  VILLAGE_LADDER, villagePosition, milestoneEarned, milestoneBlockedNote,
} from '@silverline/shared';
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
type Tab = 'dashboard' | 'progress' | 'report' | 'villages' | 'people' | 'deployment'
  | 'bottlenecks' | 'timeline' | 'summary' | 'control';

/*
 * What a reader is shown, and in what order (§071).
 *
 * Nine tabs was the complaint, and the nine were not equal: the dashboard
 * answers the question almost everybody arrives with, and six of the others
 * answer questions only somebody running the programme asks. So the list is
 * now in two parts — what you see, and what you open when you need it — and
 * the deep ones are behind "More". Nothing was deleted; every tab below still
 * exists and still works.
 */
const PRIMARY_TABS: Tab[] = ['dashboard', 'progress', 'villages', 'report'];
const MORE_TABS: Tab[] = [
  'people', 'deployment', 'bottlenecks', 'timeline', 'summary', 'control',
];

const TAB_LABELS: Record<Tab, string> = {
  dashboard: 'Dashboard',
  progress: 'Progress',
  villages: 'Villages',
  report: 'Report',
  people: 'Crew & rovers',
  deployment: 'Deployment',
  bottlenecks: 'Bottlenecks',
  timeline: 'Trend',
  summary: 'Summary',
  control: 'Control points',
};

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
  /*
   * The department's own view (§071).
   *
   * An official holds survey.dashboard and nothing else. They get this page
   * with one tab on it, and every other tab is not merely hidden — the
   * queries behind them are never issued, so a mistake in the markup cannot
   * leak a crew list.
   */
  const canDashboard = hasPermission(perms, 'survey.dashboard');
  const observerOnly = canDashboard && !canRead;
  const canEnter = hasPermission(perms, 'survey.enter');
  const canManage = hasPermission(perms, 'survey.manage');
  // Management information. The specification is explicit that a GT user
  // does not see forecasting.
  const canForecast = hasPermission(perms, 'survey.forecast');
  // Closing out a finished village: team leads as well as managers, because
  // certifying what you surveyed is part of running it.
  const canCertify = hasPermission(perms, 'survey.certify');

  const today = React.useMemo(() => businessToday(), []);
  const fy = React.useMemo(() => financialYearToDate(today), [today]);

  const [tab, setTab] = React.useState<Tab>('dashboard');
  const [showMore, setShowMore] = React.useState(false);
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
    React.useState<{ stage: string; state: string; district: string; mandal: string } | null>(null);
  const [geoDrill, setGeoDrill] =
    React.useState<{ level: ReportLevel; name: string } | null>(null);
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const wanted = q.get('tab');
    if (wanted && ([...PRIMARY_TABS, ...MORE_TABS] as string[]).includes(wanted)) {
      setTab(wanted as Tab);
      if ((MORE_TABS as string[]).includes(wanted)) setShowMore(true);
    }
    const village = q.get('village');
    if (village) { setTab('villages'); setOpenVillage(village); }
    const project = q.get('project');
    if (project) setProjectId(project);
  }, []);
  const [level, setLevel] = React.useState<ReportLevel>('mandal');
  const [range, setRange] = React.useState(fy);
  const [grain, setGrain] = React.useState<'DAY' | 'WEEK' | 'MONTH' | 'YEAR'>('MONTH');

  const projects = useQuery({
    queryKey: ['survey-projects', observerOnly],
    enabled: canRead || canDashboard,
    queryFn: async () => ((await apiRequestRaw(observerOnly
      // An observer gets the three fields a picker needs and no more; the
      // full programme record is not theirs to read.
      ? '/api/v1/survey/dashboard/projects'
      : '/api/v1/survey/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  React.useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(String(projects.data[0].id));
  }, [projects.data, projectId]);

  /*
   * What part of the programme the progress screen is reporting on.
   *
   * Sent to the server rather than applied to the rows here: every figure on
   * that screen — the headline percentage, the pace, the stage tallies, the
   * rover utilisation — has to be recomputed over the filtered villages, and
   * a filter applied after the arithmetic would leave the programme's number
   * standing under a district's heading.
   */
  const [scope, setScope] = React.useState({
    district: '', mandal: '', village_id: '', stage: '', stage_state: 'OUTSTANDING',
  });

  const progress = useQuery({
    queryKey: ['survey-progress', projectId, level, range, scope],
    enabled: canRead && !!projectId && tab === 'progress',
    queryFn: async () => {
      const q = new URLSearchParams({ level, from: range.from, to: range.to });
      if (scope.district) q.set('district', scope.district);
      if (scope.mandal) q.set('mandal', scope.mandal);
      if (scope.village_id) q.set('village_id', scope.village_id);
      if (scope.stage) { q.set('stage', scope.stage); q.set('stage_state', scope.stage_state); }
      return ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/progress?${q}`)).body as { data: Row }).data;
    },
  });

  if (!canRead && !canDashboard) {
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

  /*
   * The observer's page: the programme picker and the dashboard.
   *
   * Returned before the tab bar rather than hiding tabs inside it, so there
   * is no arrangement of state in which an official is one stray click from
   * the crew list. The detailed screens are not rendered at all.
   */
  if (observerOnly) {
    return (
      <AppShell>
        <PageHeader
          title="Land survey"
          description="Programme progress, village by village."
        />
        <PageBody>
          {projects.isLoading ? <Skeleton className="h-96" /> : null}
          {(projects.data ?? []).length > 1 ? (
            <div className="mb-4">
              <label className="flex items-center gap-2 text-xs text-text-muted">
                Programme
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
                >
                  {(projects.data ?? []).map((p) => (
                    <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {projectId ? (
            <SurveyDashboard projectId={projectId} canDrill={false} />
          ) : projects.isLoading ? null : (
            <Notice tone="info" title="No active programme">
              There is no active survey programme to show yet.
            </Notice>
          )}
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
          <div className="-mx-1 flex max-w-full flex-wrap gap-1 px-1 pb-1">
            {PRIMARY_TABS.map((t) => (
              <Button key={t} type="button" variant={tab === t ? 'secondary' : 'ghost'}
                onClick={() => setTab(t)}>
                {TAB_LABELS[t]}
              </Button>
            ))}
            {/*
              * The six that only somebody running the programme opens. Kept
              * one click away rather than removed — each one answers a real
              * question, just not the question most people arrive with.
              */}
            <Button type="button" variant={showMore ? 'secondary' : 'ghost'}
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}>
              {showMore ? 'Fewer' : 'More'}
            </Button>
            {showMore ? MORE_TABS.map((t) => (
              <Button key={t} type="button" variant={tab === t ? 'secondary' : 'ghost'}
                onClick={() => setTab(t)}>
                {TAB_LABELS[t]}
              </Button>
            )) : null}
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

          {/*
            * Not on the dashboard.
            *
            * The dashboard is a reading screen and is what people outside
            * this company are shown. Setup loads the village master and
            * "record today's progress" writes a return — neither belongs
            * beside a figure somebody is reading, and a screen that reports
            * and writes in the same breath is one where looking and changing
            * look alike.
            *
            * They are unchanged on every other tab, which is where the
            * people who do those things already are.
            */}
          {tab === 'dashboard' ? null : (
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
          )}
        </Toolbar>

        {projects.isLoading ? <Skeleton className="h-64" /> : null}
        {projects.isError ? <ErrorCard error={projects.error} onRetry={() => projects.refetch()} /> : null}
        {projects.isSuccess && (projects.data ?? []).length === 0 ? (
          <EmptyState
            title="No survey programme yet"
            description="A programme holds the villages to be surveyed and everything recorded against them."
          />
        ) : null}

        {projectId && tab === 'dashboard' ? (
          <SurveyDashboard
            projectId={projectId}
            /*
             * An observer sees the dashboard and stops there. Everything it
             * links into — a village's crew, its returns, its claims — needs
             * survey.read, and offering a link that 403s is worse than
             * offering no link.
             */
            canDrill={canRead}
            canAnswer={hasPermission(perms, 'survey.answer')}
            canManage={canManage}
            onOpenVillage={(id) => { setOpenVillage(id); setTab('villages'); }}
          />
        ) : null}

        {projectId && tab === 'progress' ? (
          <Progress
            query={progress} level={level} setLevel={setLevel} range={range}
            scope={scope} setScope={setScope}
            projectName={String((projects.data ?? []).find(
              (p) => String(p.id) === projectId)?.name ?? '')}
            onDrillDown={(stageCode, state) => {
              /*
               * Carry the filter across with the question.
               *
               * The count that was clicked was a count of *these* villages.
               * Opening the whole programme's villages at that stage answers
               * a different question from the one the reader asked, and the
               * list would not match the number they clicked.
               */
              setStageDrill({
                stage: stageCode, state,
                district: scope.district, mandal: scope.mandal,
              });
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
            canCertify={canCertify}
            projectName={String((projects.data ?? []).find(
              (p) => String(p.id) === projectId)?.name ?? '')}
            openVillage={openVillage}
            stageDrill={stageDrill} geoDrill={geoDrill}
            onDrillConsumed={() => { setStageDrill(null); setGeoDrill(null); }} />
        ) : null}
        {projectId && tab === 'people' ? (
          <CrewAndRovers projectId={projectId} range={range}
            onOpenVillage={(id) => { setOpenVillage(id); setTab('villages'); }} />
        ) : null}
        {projectId && tab === 'deployment' ? (
          <Deployment projectId={projectId} level={level} setLevel={setLevel} />
        ) : null}
        {projectId && tab === 'bottlenecks' ? (
          <Bottlenecks projectId={projectId} canForecast={canForecast} />
        ) : null}
        {projectId && tab === 'timeline' ? (
          <Timeline projectId={projectId} range={range} grain={grain} setGrain={setGrain}
            projectName={String((projects.data ?? []).find(
              (p) => String(p.id) === projectId)?.name ?? '')} />
        ) : null}
        {projectId && tab === 'control' ? (
          <ControlList projectId={projectId} canManage={canManage}
            projectName={String((projects.data ?? []).find(
              (p) => String(p.id) === projectId)?.name ?? '')}
            onOpenVillage={(id) => { setOpenVillage(id); setTab('villages'); }} />
        ) : null}
        {projectId && tab === 'summary' ? (
          <Summary projectId={projectId}
            projectName={String((projects.data ?? []).find(
              (p) => String(p.id) === projectId)?.name ?? '')} />
        ) : null}
      </PageBody>
    </AppShell>
  );
}

/* --------------------------------------------------------------- progress */

type Scope = {
  district: string; mandal: string; village_id: string;
  stage: string; stage_state: string;
};

function Progress({
  query, level, setLevel, range, scope, setScope, projectName, onDrillDown, onOpenRow,
}: {
  query: any; level: ReportLevel; setLevel: (l: ReportLevel) => void;
  range: { from: string; to: string };
  projectName: string;
  /** Which part of the programme these figures cover. */
  scope: Scope; setScope: (s: Scope) => void;
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
  const options = data.options ?? { districts: [], mandals: [], villages: [] };
  const narrowed = Boolean(scope.district || scope.mandal || scope.village_id || scope.stage);
  const pipeline: Row[] = data.pipeline ?? [];

  const sel = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  /*
   * The roll-up as it stands on screen, in a file.
   *
   * Built from the rendered rows rather than re-fetched: a download holding
   * the whole programme under a heading that says one district is how two
   * versions of the same figure start circulating.
   */
  /** What the figures cover, in words, for the file name and the heading. */
  const scopeNote = [
    scope.village_id
      ? options.villages.find((v: Row) => String(v.id) === scope.village_id)?.name
      : null,
    scope.mandal || null,
    scope.district || null,
    scope.stage
      ? `${stageLabel(scope.stage, pipeline as any)} ${scope.stage_state === 'OUTSTANDING'
        ? 'not finished'
        : (STAGE_STATE_LABELS[scope.stage_state] ?? scope.stage_state).toLowerCase()}`
      : null,
  ].filter(Boolean).join(' · ');

  const sheet = {
    name: `Progress by ${LEVEL_LABELS[level]}`.slice(0, 31),
    title: {
      heading: 'Programme progress',
      project: projectName,
      period: `As at ${day(range.to)}${range.from ? `, movement from ${day(range.from)}` : ''}`,
      filters: scopeNote || `Rolled up by ${LEVEL_LABELS[level].toLowerCase()}`,
      extra: [
        ['Villages', `${data.filter?.villages ?? total.villages} of ${
          data.filter?.of_villages ?? total.villages}`],
        ['Extent surveyed', `${acres(total.surveyedAc)} of ${acres(total.extentAc)}`],
        ['Complete', String(pct(total.overallPct))],
      ] as Array<[string, string]>,
    },
    columns: [
      { header: LEVEL_LABELS[level], width: 28 },
      { header: 'Villages', width: 10 },
      { header: 'Finished', width: 10 },
      { header: 'Not started', width: 12 },
      { header: 'Extent (Ac)', width: 14 },
      { header: 'Extent (km²)', width: 14 },
      { header: 'Surveyed (Ac)', width: 14 },
      { header: 'Surveyed (km²)', width: 16 },
      { header: 'Complete (%)', width: 14 },
      ...scored.flatMap((m) => ([
        { header: `${m.group_label ? `${m.group_label} — ` : ''}${m.label}`, width: 20 },
        { header: `${m.label} (%)`, width: 12 },
      ])),
    ],
    rows: rows.map((r) => [
      cellText(r.name), cellNum(r.villages), cellNum(r.completed), cellNum(r.notStarted),
      cellNum(r.extentAc), cellNum(acresToSqKm(Number(r.extentAc ?? 0))),
      cellNum(r.surveyedAc), cellNum(acresToSqKm(Number(r.surveyedAc ?? 0))),
      cellNum(r.overallPct),
      ...scored.flatMap((m) => ([
        cellNum(r.measures?.[m.code]?.done),
        cellNum(r.measures?.[m.code]?.pct),
      ])),
    ]),
  };

  return (
    <div className="space-y-4">
      {/*
        * Which part of the programme is being reported on.
        *
        * The screen answered one question — how is the whole programme doing
        * — and the question people ask is about a district, a mandal, or the
        * villages stuck at one stage. The filter goes to the server, so
        * every figure below is recomputed over the villages it leaves.
        */}
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">District</span>
            <select className={sel} value={scope.district}
              onChange={(e) => setScope({
                ...scope, district: e.target.value, mandal: '', village_id: '',
              })}>
              <option value="">Every district</option>
              {(options.districts ?? []).map((d: string) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>

          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">Mandal</span>
            <select className={sel} value={scope.mandal}
              onChange={(e) => setScope({ ...scope, mandal: e.target.value, village_id: '' })}>
              <option value="">Every mandal</option>
              {(options.mandals ?? []).map((mm: string) => (
                <option key={mm} value={mm}>{mm}</option>
              ))}
            </select>
          </label>

          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">Village</span>
            <select className={sel} value={scope.village_id}
              onChange={(e) => setScope({ ...scope, village_id: e.target.value })}>
              <option value="">Every village</option>
              {(options.villages ?? []).map((v: Row) => (
                <option key={String(v.id)} value={String(v.id)}>{String(v.name)}</option>
              ))}
            </select>
          </label>

          <label className="text-2xs text-text-subtle">
            <span className="mb-1 block">Stage</span>
            <select className={sel} value={scope.stage}
              onChange={(e) => setScope({ ...scope, stage: e.target.value })}>
              <option value="">Any stage</option>
              {pipeline.map((st) => (
                <option key={String(st.code)} value={String(st.code)}>{String(st.label)}</option>
              ))}
            </select>
          </label>

          {scope.stage ? (
            <label className="text-2xs text-text-subtle">
              <span className="mb-1 block">Which is</span>
              <select className={sel} value={scope.stage_state}
                onChange={(e) => setScope({ ...scope, stage_state: e.target.value })}>
                <option value="OUTSTANDING">not finished</option>
                <option value="NOT_STARTED">still to start</option>
                <option value="IN_PROGRESS">in progress</option>
                <option value="ON_HOLD">on hold</option>
                <option value="COMPLETED">finished</option>
              </select>
            </label>
          ) : null}

          {narrowed ? (
            <Button type="button" variant="ghost" onClick={() => setScope({
              district: '', mandal: '', village_id: '', stage: '', stage_state: 'OUTSTANDING',
            })}>Whole programme</Button>
          ) : null}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-2xs text-text-subtle">
              {narrowed
                ? `${count(data.filter?.villages)} of ${count(data.filter?.of_villages)} villages`
                : `${count(data.filter?.of_villages ?? total.villages)} villages`}
            </span>
            <ExportMenu sheet={sheet}
              fileName={`survey-progress-${level}${narrowed ? '-filtered' : ''}`}
              note={`by ${LEVEL_LABELS[level].toLowerCase()}`} />
          </div>
        </div>

        {narrowed ? (
          <p className="text-2xs text-text-subtle">
            Every figure below covers {scopeNote} only — the percentages, the pace and the
            rover counts are all recomputed over these villages.
          </p>
        ) : null}
      </Card>

      {narrowed && total.villages === 0 ? (
        <EmptyState
          title="No villages match that"
          description="Nothing in this programme sits in that combination. Widen the filter or clear it to see the whole programme."
        />
      ) : null}

      <Card className="space-y-3 p-4">
        <p className="text-sm text-text">{progressHeadline(total)}</p>
        <div className="grid gap-2 sm:grid-cols-5">
          <Stat label="Extent to survey" value={acres(total.extentAc)} hint={sqKm(total.extentSqKm)}
            explain={GLOSSARY.extent} />
          {/* Both units, as the extent above already carries: the revenue
              record is in acres and every government letter is in km². */}
          <Stat label="Surveyed" value={acres(total.surveyedAc)}
            hint={sqKm(acresToSqKm(Number(total.surveyedAc ?? 0)))}
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
              {pipeline.map((stage: Row) => {
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
            hint={(data.rovers?.unaccounted ?? 0) > 0
              // Said plainly rather than folded into idle. Before the day's
              // returns are in, every instrument is unaccounted for, and
              // calling that "idle" is a false alarm every morning.
              ? `${data.rovers?.unaccounted} not yet reported on`
              : pct(data.rovers?.utilisationPct)}
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
                    <TD className="text-right tabular-nums">
                      {acres(r.extentAc)}
                      <div className="text-2xs text-text-subtle">
                        {sqKm(acresToSqKm(Number(r.extentAc ?? 0)))}
                      </div>
                    </TD>
                    <TD className="text-right tabular-nums">
                      {acres(r.surveyedAc)}
                      <div className="text-2xs text-text-subtle">
                        {sqKm(acresToSqKm(Number(r.surveyedAc ?? 0)))}
                      </div>
                    </TD>
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
                      <TD key={m.code} align="right" className="tabular-nums">
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
  const [grain, setGrain] = React.useState<'DAY' | 'WEEK' | 'MONTH' | 'RANGE'>('WEEK');
  const [asOf, setAsOf] = React.useState(() => businessToday());
  /*
   * A window somebody chose, rather than a calendar period.
   *
   * "The fortnight the minister's visit covered" is not a week and is not a
   * month, and reporting on it meant running four weekly reports and adding
   * them up by hand.
   */
  const [span, setSpan] = React.useState(() => {
    const to = businessToday();
    const from = new Date(`${to}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 29);
    return { from: from.toISOString().slice(0, 10), to };
  });
  const custom = grain === 'RANGE';

  const report = useQuery({
    queryKey: ['survey-report', projectId, grain, level, asOf, span],
    queryFn: async () => {
      const q = custom
        ? new URLSearchParams({ level, from: span.from, to: span.to })
        : new URLSearchParams({ grain, level, as_of: asOf });
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

  const noun = custom ? 'range' : (PERIOD_NOUNS[grain] ?? 'period');
  // Stepping forward past today would report on a period nobody has worked.
  const atLatest = custom
    || stepPeriod(asOf, grain as 'DAY' | 'WEEK' | 'MONTH', 1) > businessToday();

  /*
   * Every measure, this period against the last and against the whole
   * programme.
   *
   * "Points collected" and "extent covered" are the two things anybody asks
   * a survey report, and neither had a line on this screen: the headline
   * carried acres and the rest sat in a per-mandal table nobody reads for a
   * total. Counts and extents are kept apart because adding a boundary point
   * to an acre is adding apples to acres.
   */
  const measureRows = (d?.measures ?? {}) as Record<string, Row>;
  const measureMeta: Row[] = d?.measure_list ?? [];
  const staffing: Row = d?.staffing ?? {};

  /*
   * The table on screen, as a file.
   *
   * Built from the same rows the table renders rather than re-fetched, so a
   * download can never contain more than what was checked on screen.
   */
  const scopeNote = `${LEVEL_LABELS[level]} breakdown`;
  const sheet = {
    name: `${LEVEL_LABELS[level]} ${String(d?.period?.label ?? '')}`.slice(0, 31),
    title: {
      heading: `${custom ? 'Progress report' : `${
        grain === 'DAY' ? 'Daily' : grain === 'WEEK' ? 'Weekly' : 'Monthly'} progress report`}`,
      project: String(d?.programme?.name ?? ''),
      period: `${d?.period?.label ?? ''} (${day(d?.period?.from)} to ${day(d?.period?.to)})`,
      filters: scopeNote,
      extra: [
        ['Compared against', String(d?.previous_period?.label ?? '')],
        ['Extent surveyed', `${acres(d?.area?.current)} (previous ${acres(d?.area?.previous)})`],
        ['Days worked', `${d?.effort?.active_days ?? 0} of ${d?.effort?.calendar_days ?? 0}`],
      ] as Array<[string, string]>,
    },
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
              {custom ? 'Report' : grain === 'DAY' ? 'Daily report'
                : grain === 'WEEK' ? 'Weekly report' : 'Monthly report'}
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
              {([['DAY', 'A day'], ['WEEK', 'A week'], ['MONTH', 'A month'],
                ['RANGE', 'Dates I choose']] as const).map(
                ([g, label]) => (
                  <Button key={g} type="button" variant={grain === g ? 'secondary' : 'ghost'}
                    onClick={() => setGrain(g)}>{label}</Button>
                ))}
            </div>
          </label>

          {custom ? (
            <div className="text-2xs text-text-subtle">
              <span className="mb-1 block">Between</span>
              <div className="flex items-center gap-1">
                <input type="date" value={span.from} max={span.to}
                  onChange={(e) => setSpan({ ...span, from: e.target.value })}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
                <span className="text-text-muted">and</span>
                <input type="date" value={span.to} max={businessToday()} min={span.from}
                  onChange={(e) => setSpan({ ...span, to: e.target.value })}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
              </div>
              {/* A chosen range has no calendar predecessor, so the
                  comparison is the same number of days before it. Said out
                  loud, because comparing eleven days against thirty
                  silently would be worse than not comparing. */}
              <span className="mt-1 block">
                Compared against the {Math.round(
                  (Date.parse(`${span.to}T00:00:00Z`) - Date.parse(`${span.from}T00:00:00Z`))
                  / 86_400_000) + 1} days before it
              </span>
            </div>
          ) : (
            <div className="text-2xs text-text-subtle">
              <span className="mb-1 block">Which {noun}</span>
              <div className="flex items-center gap-1">
                <Button type="button" variant="ghost"
                  title={`The ${noun} before this one`}
                  onClick={() => setAsOf(stepPeriod(asOf, grain as 'DAY' | 'WEEK' | 'MONTH', -1))}>
                  ← Previous
                </Button>
                <input type="date" value={asOf} max={businessToday()}
                  onChange={(e) => setAsOf(e.target.value)}
                  title="Any day inside the period you want reported"
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
                <Button type="button" variant="ghost" disabled={atLatest}
                  title={atLatest ? 'This is the current period' : `The ${noun} after this one`}
                  onClick={() => setAsOf(stepPeriod(asOf, grain as 'DAY' | 'WEEK' | 'MONTH', 1))}>
                  Next →
                </Button>
                {asOf !== businessToday() ? (
                  <Button type="button" variant="ghost"
                    onClick={() => setAsOf(businessToday())}>Today</Button>
                ) : null}
              </div>
            </div>
          )}

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

      {/*
        * What was actually collected, measure by measure.
        *
        * "Points collected" and "extent covered" are the two things anybody
        * asks a survey report, and neither had a line: the headline carried
        * acres and everything else sat in a per-mandal table nobody reads
        * for a total. Counts and extents are listed together but never
        * added, because a boundary point is not an acre.
        */}
      {measureMeta.length > 0 ? (
        <Card className="space-y-2 p-4">
          <h3 className="text-sm font-semibold text-text">What was collected</h3>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Measure</TH>
                  <TH className="text-right">This {noun}</TH>
                  <TH className="text-right">Previous {noun}</TH>
                  <TH className="text-right">Change</TH>
                  <TH className="text-right">Programme to date</TH>
                </TR>
              </THead>
              <TBody>
                {measureMeta.map((mm) => {
                  const cmp = measureRows[String(mm.code)] ?? {};
                  const cum = d?.overall?.measures?.[String(mm.code)] ?? {};
                  const isExtent = mm.basis === 'EXTENT';
                  // Acres read with two decimals, counts as whole numbers.
                  const fmt = (v: unknown) => {
                    const n = v === null || v === undefined ? null : Number(v);
                    return isExtent ? acres(n) : count(n);
                  };
                  return (
                    <TR key={String(mm.code)}>
                      <TD>
                        <span className="text-text">{String(mm.label)}</span>
                        {mm.group_label ? (
                          <span className="ml-1 text-2xs text-text-subtle">
                            {String(mm.group_label)}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-right tabular-nums text-text">{fmt(cmp.current)}</TD>
                      <TD tone="muted" className="text-right tabular-nums">
                        {fmt(cmp.previous)}
                      </TD>
                      <TD className="text-right">
                        <span className={cmp.direction === 'UP' ? 'text-success'
                          : cmp.direction === 'DOWN' ? 'text-warning' : 'text-text-subtle'}>
                          {changeHint(cmp as any) || '—'}
                        </span>
                      </TD>
                      <TD tone="muted" className="text-right tabular-nums">
                        {fmt(cum.done)}
                        {cum.pct !== undefined && cum.pct !== null ? (
                          <span className="ml-1 text-2xs text-text-subtle">{pct(cum.pct)}</span>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
          <p className="text-2xs text-text-subtle">
            Extents are acres and the rest are counts; they are never added together.
            “Programme to date” is everything recorded since the programme began.
          </p>
        </Card>
      ) : null}

      {/*
        * Who was allotted and who came (§067).
        *
        * Ground truthing is walked with the department's people. The days
        * they do not come are days our crew is paid to stand in a field, and
        * that was a thing supervisors knew and no report could show.
        */}
      {Number(staffing.daysRecorded ?? 0) > 0 ? (
        <Card className="space-y-2 p-4">
          <h3 className="text-sm font-semibold text-text">Who turned up</h3>
          <p className="text-sm text-text">{staffingNote(staffing as any)}</p>
          <div className="grid gap-2 sm:grid-cols-4">
            <Stat label="Government staff-days"
              value={`${count(staffing.govtStaffDays)}${
                staffing.govtStaffExpected ? ` of ${count(staffing.govtStaffExpected)}` : ''}`}
              hint="Against the strength agreed with the mandal"
              tone={staffing.govtStaffPct !== null && Number(staffing.govtStaffPct) < 80
                ? 'warning' : undefined} />
            <Stat label="Our crew-days"
              value={`${count(staffing.crewDays)}${
                staffing.crewExpected ? ` of ${count(staffing.crewExpected)}` : ''}`} />
            <Stat label="Days the department sent nobody"
              value={count(staffing.daysWithNoGovtStaff)}
              tone={Number(staffing.daysWithNoGovtStaff ?? 0) > 0 ? 'danger' : 'success'}
              hint="Crew on site with nobody to walk the boundary with" />
            <Stat label="Days short of strength" value={count(staffing.daysShort)}
              tone={Number(staffing.daysShort ?? 0) > 0 ? 'warning' : 'success'} />
          </div>
          <p className="text-2xs text-text-subtle">
            {/* Multiplying the allocation by the calendar would charge the
                department for Sundays, and the percentage that came out
                would be an accusation rather than a measurement. */}
            Counted only over days that carry a return and a recorded allocation — never
            over the calendar.
          </p>
        </Card>
      ) : null}

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
    title: {
      heading: 'Who and what is deployed',
      period: 'As it stands today',
      filters: `Grouped by ${LEVEL_LABELS[level].toLowerCase()}`,
      extra: [
        ['Villages with nobody on them', String(d?.totals?.villages_uncrewed ?? 0)],
        ['Crewed with no instrument', String(d?.totals?.villages_unequipped ?? 0)],
      ] as Array<[string, string]>,
    },
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
              {/*
                * Two header rows, because there are two kinds of column.
                *
                * A single strip reading "Villages / Nobody on them / People /
                * Instruments" leaves the reader working out which numbers
                * belong together — "nobody on them" is a count of villages,
                * not of people, and sitting between two people-counts it
                * reads as one. Grouping says it without a footnote.
                */}
              <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-text-subtle">
                <th className="px-4 py-2" rowSpan={2}>{LEVEL_LABELS[level]}</th>
                <th className="border-l border-border px-4 py-1 text-center" colSpan={2}>
                  Villages
                </th>
                <th className="border-l border-border px-4 py-1 text-center" colSpan={2}>
                  Deployed on them
                </th>
                <th className="border-l border-border px-4 py-1 text-center" colSpan={2}>
                  Names
                </th>
              </tr>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="border-l border-border px-4 py-2 text-right">In total</th>
                {/* The gap, beside the coverage, rather than left to be
                    worked out from two counts that do not subtract. */}
                <th className="px-4 py-2 text-right">With nobody on them</th>
                <th className="border-l border-border px-4 py-2 text-right">People</th>
                <th className="px-4 py-2 text-right">Instruments</th>
                <th className="border-l border-border px-4 py-2">Who is there</th>
                <th className="px-4 py-2">What they have</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={String(u.id ?? u.name)} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-2 text-text">{String(u.name)}</td>
                  <td className="border-l border-border px-4 py-2 text-right tabular-nums">
                    {count(u.villages)}
                  </td>
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
                  <td className="border-l border-border px-4 py-2 text-right tabular-nums">
                    {count(u.crew)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{count(u.rovers_out)}</td>
                  <td className="border-l border-border px-4 py-2">
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
                <td className="border-l border-border px-4 py-2 text-right tabular-nums">
                  {count(d?.totals?.villages)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <span className={uncrewed > 0 ? 'text-warning' : 'text-text-subtle'}>
                    {count(uncrewed)}
                  </span>
                </td>
                <td className="border-l border-border px-4 py-2 text-right tabular-nums">
                  {count(d?.totals?.crew)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{count(d?.totals?.assets)}</td>
                <td className="border-l border-border px-4 py-2 text-2xs font-normal text-text-subtle"
                  colSpan={2}>
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
  projectId, range, onOpenVillage,
}: {
  projectId: string; range: { from: string; to: string };
  /** Opening the village an idle day happened in. */
  onOpenVillage?: (villageId: string) => void;
}) {
  const [view, setView] = React.useState<'people' | 'rovers'>('people');
  /*
   * Which instrument's idle days are open.
   *
   * "Eleven days idle" is a number. "Eleven days idle, nine of them in
   * Koyyuru waiting for the VRO" is a conversation with the mandal, and
   * getting from one to the other meant reading the returns village by
   * village.
   */
  const [idleFor, setIdleFor] = React.useState<string | null>(null);

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
                    <React.Fragment key={String(r.asset_id)}>
                    <TR>
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
                            all rover fault" is a maintenance job. The badges
                            open the days themselves, which carry the village
                            and the date an escalation is built on. */}
                        {(r.idle_reasons ?? []).length === 0 ? (
                          <span className="text-2xs text-text-subtle">—</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setIdleFor(
                              idleFor === String(r.asset_id) ? null : String(r.asset_id))}
                            title={`Show the ${r.idle_days} idle day(s) for ${
                              String(r.asset_code)}, with the village and the reason`}
                            className="flex flex-wrap gap-1 text-left underline-offset-2 hover:underline"
                          >
                            {(r.idle_reasons as Row[]).map((ir) => (
                              <Badge key={String(ir.reason)} tone="neutral">
                                {String(ir.label)} × {ir.days}
                              </Badge>
                            ))}
                          </button>
                        )}
                      </TD>
                    </TR>
                    {idleFor === String(r.asset_id) ? (
                      <TR>
                        <TD colSpan={7} className="bg-surface-sunken p-0">
                          <RoverIdleDays
                            projectId={projectId} assetId={String(r.asset_id)}
                            assetCode={String(r.asset_code)} range={range}
                            onOpenVillage={onOpenVillage}
                          />
                        </TD>
                      </TR>
                    ) : null}
                  </React.Fragment>
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

/**
 * Every day one instrument sat idle, with the village and the reason.
 *
 * Listed rather than summarised again: eleven rows is something somebody
 * scans, and summarising them would lose the dates, which are what an
 * escalation with the mandal is built on.
 */
function RoverIdleDays({
  projectId, assetId, assetCode, range, onOpenVillage,
}: {
  projectId: string; assetId: string; assetCode: string;
  range: { from: string; to: string };
  onOpenVillage?: (villageId: string) => void;
}) {
  const q = useQuery({
    queryKey: ['survey-rover-idle', projectId, assetId, range],
    queryFn: async () => {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      return ((await apiRequestRaw(
        `/api/v1/survey/projects/${projectId}/rovers/${assetId}/idle-days?${p}`))
        .body as { data: Row }).data;
    },
  });

  if (q.isLoading) return <Skeleton className="m-3 h-24" />;
  if (q.isError) return <div className="p-3"><ErrorCard error={q.error} onRetry={() => q.refetch()} /></div>;
  const days: Row[] = q.data?.days ?? [];

  /* The same days, in a file — this is the list that goes to the mandal. */
  const sheet = {
    name: `Idle days ${assetCode}`.slice(0, 31),
    title: {
      heading: `Idle days — ${assetCode}`,
      period: `${day(range.from)} to ${day(range.to)}`,
      filters: `Instrument ${assetCode}`,
    },
    columns: [
      { header: 'Date', width: 14 },
      { header: 'Village', width: 26 },
      { header: 'Mandal', width: 20 },
      { header: 'Reason', width: 24 },
      { header: 'Remarks', width: 40 },
      { header: 'Crew member', width: 24 },
    ],
    rows: days.map((r) => [
      cellText(r.entry_date), cellText(r.village_name), cellText(r.mandal_name),
      cellText(r.idle_reason_label), cellText(r.remarks), cellText(r.employee_name),
    ]),
  };

  return (
    <div className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          {assetCode} — {days.length} idle day{days.length === 1 ? '' : 's'}
        </h4>
        <ExportMenu sheet={sheet} fileName={`idle-days-${assetCode}`} />
      </div>

      {days.length === 0 ? (
        <p className="text-xs text-text-muted">
          Nothing idle for this instrument between these dates.
        </p>
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Village</TH>
                <TH>Why it sat</TH>
                <TH>Who had it</TH>
              </TR>
            </THead>
            <TBody>
              {days.map((r, i) => (
                <TR key={`${r.entry_date}-${r.survey_village_id}-${i}`}>
                  <TD className="tabular-nums text-text">{day(r.entry_date)}</TD>
                  <TD>
                    {/* The village opens, because "nine days in Koyyuru" is
                        the start of looking at Koyyuru. */}
                    {onOpenVillage ? (
                      <button type="button"
                        onClick={() => onOpenVillage(String(r.survey_village_id))}
                        className="text-left font-medium text-text underline-offset-2 hover:text-primary hover:underline"
                        title="Open this village">
                        {String(r.village_name)}
                      </button>
                    ) : (
                      <span className="font-medium text-text">{String(r.village_name)}</span>
                    )}
                    {r.mandal_name ? (
                      <span className="ml-1 text-2xs text-text-subtle">{String(r.mandal_name)}</span>
                    ) : null}
                  </TD>
                  <TD>
                    <Badge tone="neutral">{String(r.idle_reason_label)}</Badge>
                    {r.remarks ? (
                      <span className="ml-1 text-2xs text-text-muted">{String(r.remarks)}</span>
                    ) : null}
                  </TD>
                  <TD tone="muted">{r.employee_name ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
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
                    <TD tone="muted">{b.mandal ?? '—'}</TD>
                    <TD>
                      <Badge tone={villageStatusTone(b.status)}>
                        {VILLAGE_STATUS_LABELS[b.status] ?? b.status}
                      </Badge>
                    </TD>
                    <TD tone="muted">
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
                    <TD tone="danger" className="text-right font-semibold tabular-nums">
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
  projectId, projectName, canManage, canEnter, canCertify, openVillage, stageDrill, geoDrill,
  onDrillConsumed,
}: {
  projectId: string; projectName: string;
  canManage: boolean; canEnter: boolean; canCertify: boolean;
  /** A village another screen linked to, opened on arrival. */
  openVillage?: string | null;
  /** A stage, a state and the geography they were counted over. */
  stageDrill?: { stage: string; state: string; district: string; mandal: string } | null;
  /** A mandal or district handed over from a roll-up row. */
  geoDrill?: { level: ReportLevel; name: string } | null;
  onDrillConsumed?: () => void;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  /* Which part of the opened village to bring into view. */
  const [section, setSection] =
    React.useState<'stages' | 'crew' | 'rovers' | 'billing' | 'gcp' | null>(null);
  const [filter, setFilter] = React.useState('');
  const [district, setDistrict] = React.useState('');
  const [mandal, setMandal] = React.useState('');
  const [stage, setStage] = React.useState('');
  // Which state of that stage: outstanding covers everything not finished.
  const [stageState, setStageState] = React.useState('OUTSTANDING');
  /*
   * Where the village has got to, as the dashboard reports it (§077).
   *
   * The stage-and-state pair above answers "what is happening to vectorisation
   * across the programme"; this answers "which villages are at GT QC
   * completed", which is the same question the dashboard is read for and was
   * the one this screen could not be filtered by. Both, because they are
   * genuinely different questions.
   */
  const [position, setPosition] = React.useState('');
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
   * Which villages a bulk action would touch.
   *
   * Held as ids rather than as the filter itself: a filter re-evaluated at
   * apply time is not the list somebody read on screen, and between the
   * preview and the press it can quietly change under them.
   */
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set());

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
      // The geography the count was taken over, so the list matches the
      // number that was clicked.
      setDistrict(stageDrill.district ?? '');
      setMandal(stageDrill.mandal ?? '');
      setFilter('');
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

  /*
   * Everything below is derived unconditionally, and the early returns come
   * after it.
   *
   * React counts hooks per render and a component that returns before one of
   * them has rendered a different number each time — which is exactly what
   * happened here: the export memo sat below these returns, so the first
   * render (loading) ran one hook fewer than the second, and the whole tab
   * died with "rendered more hooks than during the previous render". Reading
   * from `?? []` while the query is in flight costs nothing and keeps the
   * hook count fixed.
   */
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
    if (position && villagePosition(v.stages ?? {}).key !== position) return false;
    if (!matchesBillingFilter(v.claimed_milestones ?? [], billing)) return false;
    if (!needle) return true;
    return [v.village_name, v.mandal_name, v.district_name, v.village_code]
      .some((f) => String(f ?? '').toLowerCase().includes(needle));
  });

  /*
   * A selection is only ever of rows the filter is showing.
   *
   * Picking forty villages, changing the filter, and claiming what is now
   * selected is how a claim goes out against villages nobody looked at. The
   * selection is intersected with the visible rows on every render, so what
   * the bar says is selected is always what is on screen.
   */
  const visibleIds = rows.map((v) => String(v.id));
  const selectedHere = visibleIds.filter((id) => picked.has(id));
  const allPicked = visibleIds.length > 0 && selectedHere.length === visibleIds.length;
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });


  /*
   * The filtered list, as a file.
   *
   * Memoised on the rows: it used to be built inside the JSX, which rebuilt
   * every cell of a thousand-village table on each keystroke in the search
   * box. Nobody noticed on a programme of two.
   */
  const villageSheet = React.useMemo(() => ({
    name: 'Villages',
    title: {
      heading: 'Village list',
      project: projectName,
      period: 'As it stands today',
      filters: [
        district ? `${district} district` : null,
        mandal ? `${mandal} mandal` : null,
        stage ? `${stageLabel(stage, pipeline as any)} ${stageState === 'OUTSTANDING'
          ? 'not finished'
          : (STAGE_STATE_LABELS[stageState] ?? stageState).toLowerCase()}` : null,
        billing ? (BILLING_FILTERS.find((b) => b.value === billing)?.label ?? billing) : null,
        needle ? `matching \u201c${filter.trim()}\u201d` : null,
      ].filter(Boolean).join(' \u00b7 '),
      extra: [['Villages listed', `${rows.length} of ${all.length}`]] as Array<[string, string]>,
    },

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
                cellNum(v.total_extent_ac), cellNum(v.total_extent_sq_km),
        cellNum(walked), cellNum(acresToSqKm(walked)),
                planned > 0 ? cellNum((walked / planned) * 100) : '',
                at ? `${stageLabel(String(at.code), pipeline as any)} — ${
                  (STAGE_STATE_LABELS[String(v.stages?.[String(at.code)] ?? 'NOT_STARTED')]
                    ?? '').toLowerCase()}`.trim() : 'Finished',
                cellNum(v.claimed_percent),
                (v.claimed_milestones ?? []).join(', '),
                cellText(v.assignee_name),
              ];
            }),
  }), [rows, measures, pipeline, projectName, district, mandal, stage, stageState,
    billing, filter, position]);
    // eslint-disable-next-line react-hooks/exhaustive-deps

  // Every hook above has now run. These are safe.
  if (villages.isLoading) return <Skeleton className="h-64" />;
  if (villages.isError) {
    return <ErrorCard error={villages.error} onRetry={() => villages.refetch()} />;
  }
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
        {/* The eleven positions the dashboard reports, so a reader can land
            on the same list the chart counted. */}
        <select value={position} onChange={(e) => setPosition(e.target.value)}
          title="Where the village has got to, as the dashboard reports it"
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
          <option value="">Any stage status</option>
          {VILLAGE_LADDER.map((r: { key: string; label: string }) => (
            <option key={r.key} value={r.key}>{r.label}</option>
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
        {(district || mandal || stage || filter || billing || position) ? (
          <Button type="button" variant="ghost" onClick={() => {
            setDistrict(''); setMandal(''); setStage(''); setPosition('');
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
          sheet={villageSheet}
          fileName="survey-villages"
        />
      </Toolbar>

      {/*
        * Claiming what the filter is showing.
        *
        * "Every village where vectorisation is finished and nothing has been
        * claimed" is one covering letter, and building it by opening forty
        * villages in turn is how two get missed.
        */}
      <BillingBulkBar
        selected={selectedHere}
        villages={rows}
        canManage={canManage}
        onDone={() => setPicked(new Set())}
        onClear={() => setPicked(new Set())}
        onKeepEligible={(ids) => setPicked(new Set(ids))}
      />

      {/* Capped height: the horizontal scrollbar for a twelve-column table
          has to be reachable without scrolling past a thousand villages. */}
      <TableWrap tall>
        <Table>
          <THead>
            <TR>
              {canManage ? (
                <TH className="w-8">
                  <input
                    type="checkbox"
                    aria-label={allPicked ? 'Clear the selection' : 'Select every village shown'}
                    title={allPicked
                      ? 'Clear the selection'
                      : `Select all ${visibleIds.length} village(s) the filter is showing`}
                    checked={allPicked}
                    /* Some but not all: the box says so rather than reading
                       as "none selected" when forty are. */
                    ref={(el) => {
                      if (el) el.indeterminate = selectedHere.length > 0 && !allPicked;
                    }}
                    onChange={() => setPicked((prev) => {
                      const next = new Set(prev);
                      if (allPicked) visibleIds.forEach((id) => next.delete(id));
                      else visibleIds.forEach((id) => next.add(id));
                      return next;
                    })}
                  />
                </TH>
              ) : null}
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
              {/* The revenue record is in acres and every government letter
                  is in square kilometres. Carrying both stops the conversion
                  being done by hand, differently each time. */}
              <TH className="text-right">Extent (km²)</TH>
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
                    {canManage ? (
                      <TD>
                        <input
                          type="checkbox"
                          aria-label={`Select ${String(v.village_name)}`}
                          checked={picked.has(String(v.id))}
                          onChange={() => toggle(String(v.id))}
                        />
                      </TD>
                    ) : null}
                    <TD tone="subtle" className="text-right tabular-nums">
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
                    <TD tone="muted">{v.district_name ?? '—'}</TD>
                    <TD tone="muted">{v.mandal_name ?? '—'}</TD>
                    <TD className="text-right tabular-nums">{acres(v.total_extent_ac)}</TD>
                    <TD tone="muted" className="text-right tabular-nums">
                      {sqKm(v.total_extent_sq_km)}
                    </TD>
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
                            {walked > 0 ? (
                              <div className="text-2xs text-text-subtle">
                                {sqKm(acresToSqKm(walked))}
                              </div>
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
                    <TD tone="muted">{v.assignee_name ?? '—'}</TD>
                    <TD className="text-right">
                      {/*
                        * The work, reachable from the list.
                        *
                        * Everything here already existed inside the expanded
                        * panel, which meant somebody who came to allocate a
                        * rover had to open a village, read past its stages
                        * and its crew, and find it. Saying what you came to
                        * do and being taken there is the whole difference.
                        */}
                      <div className="flex justify-end gap-1">
                        {canManage ? (
                          <>
                            <Button type="button" variant="ghost"
                              title={`Assign crew to ${String(v.village_name)}`}
                              onClick={() => { setOpen(String(v.id)); setSection('crew'); }}>
                              Crew
                            </Button>
                            <Button type="button" variant="ghost"
                              title={`Allocate instruments to ${String(v.village_name)}`}
                              onClick={() => { setOpen(String(v.id)); setSection('rovers'); }}>
                              Instruments
                            </Button>
                            <Button type="button" variant="ghost"
                              title={`Record the ground control point for ${String(v.village_name)}`}
                              onClick={() => { setOpen(String(v.id)); setSection('gcp'); }}>
                              GCP
                            </Button>
                          </>
                        ) : null}
                        {canEnter ? (
                          <Button type="button" variant="ghost"
                            title={at
                              ? `Start or move ${stageLabel(String(at.code), pipeline as any)}`
                              : 'Change a stage'}
                            onClick={() => { setOpen(String(v.id)); setSection('stages'); }}>
                            Stage
                          </Button>
                        ) : null}
                        <Button type="button" variant="ghost"
                          onClick={() => {
                            const next = isOpen ? null : String(v.id);
                            setOpen(next); setSection(null);
                          }}>
                          {isOpen ? 'Hide' : 'Open'}
                        </Button>
                      </div>
                    </TD>
                  </TR>
                  {isOpen ? (
                    <TR>
                      <TD colSpan={canManage ? 12 : 11} className="bg-surface-sunken p-0">
                        <VillageDetail
                          village={v}
                          pipeline={pipeline}
                          canManage={canManage}
                          canEnter={canEnter}
                          canCertify={canCertify}
                          openSection={section}
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
  projectId, projectName, range, grain, setGrain,
}: {
  projectId: string; projectName: string; range: { from: string; to: string };
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
    title: {
      heading: 'Progress over time',
      project: projectName,
      period: `${day(range.from)} to ${day(range.to)}, by ${nounPlural}`,
      filters: `Grouped into ${nounPlural}`,
    },
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

/**
 * Recording control points without leaving the list.
 *
 * This is a one-time run through a programme, done at a desk off a
 * surveyor's notebook. The form used to live five panels down inside an
 * expanded village row, which meant finding each village in another tab and
 * scrolling past everything about work that happens afterwards — an
 * afternoon's typing turned into a fortnight, and nobody could find it.
 *
 * It stays open after each save and moves to the next village that has no
 * point yet, because the job is a hundred of these in a row.
 */
function GcpRecorder({
  villages, loading, alreadyHave, onDone, onClose,
}: {
  villages: Row[];
  loading: boolean;
  /** Villages that already carry a point, so the picker can say so. */
  alreadyHave: Set<string>;
  onDone: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const blank = {
    survey_village_id: '', point_code: 'GCP-1',
    latitude: '', longitude: '', elevation_m: '',
    easting_m: '', northing_m: '', grid_zone: '',
    established_on: '', remarks: '',
  };
  const [form, setForm] = React.useState(blank);

  // The villages still owing a point, in list order. The job is worked down
  // this list, so the form offers the next one rather than the first.
  const owing = React.useMemo(
    () => villages.filter((v) => !alreadyHave.has(String(v.id))),
    [villages, alreadyHave]);

  React.useEffect(() => {
    if (!form.survey_village_id && owing.length) {
      setForm((f) => ({ ...f, survey_village_id: String(owing[0].id) }));
    }
  }, [owing, form.survey_village_id]);

  const save = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/villages/${form.survey_village_id}/gcps`, {
        method: 'POST',
        body: {
          point_code: form.point_code.trim(),
          latitude: Number(form.latitude),
          longitude: Number(form.longitude),
          elevation_m: form.elevation_m === '' ? undefined : Number(form.elevation_m),
          easting_m: form.easting_m === '' ? undefined : Number(form.easting_m),
          northing_m: form.northing_m === '' ? undefined : Number(form.northing_m),
          grid_zone: form.grid_zone.trim() || undefined,
          established_on: form.established_on || undefined,
          remarks: form.remarks.trim() || undefined,
        },
      }),
    onError: (e) => toast.error('The control point was not recorded', messageOf(e)),
    onSuccess: () => {
      const done = form.survey_village_id;
      const next = owing.find((v) => String(v.id) !== done);
      toast.success('Control point recorded',
        next ? `Moved on to ${String(next.village_name)}.` : 'Every village now has one.');
      // Kept open on the next village: the job is a hundred of these.
      setForm({ ...blank, survey_village_id: next ? String(next.id) : '' });
      qc.invalidateQueries({ queryKey: ['survey-gcps'] });
      onDone();
    },
  });

  const lat = Number(form.latitude), lng = Number(form.longitude);
  const warnings = form.latitude !== '' && form.longitude !== ''
    && Number.isFinite(lat) && Number.isFinite(lng) ? checkGcp(lat, lng) : [];
  const chosen = villages.find((v) => String(v.id) === form.survey_village_id);
  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-text">Record a control point</h3>
          <p className="text-xs text-text-muted">
            The fixed point the DGPS base was set over. Usually one per village, recorded
            once before ground truthing starts.
          </p>
        </div>
        <span className="text-2xs text-text-subtle">
          {owing.length} village{owing.length === 1 ? '' : 's'} with no point yet
        </span>
      </div>

      {loading ? <Skeleton className="h-10" /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-2xs text-text-subtle sm:col-span-2">
          Village
          <select className={field} value={form.survey_village_id}
            onChange={(e) => setForm({ ...form, survey_village_id: e.target.value })}>
            <option value="">Choose a village…</option>
            {villages.map((v) => (
              <option key={String(v.id)} value={String(v.id)}>
                {String(v.village_name)}
                {v.mandal_name ? ` — ${String(v.mandal_name)}` : ''}
                {/* Said in the picker, so a second point is a decision
                    rather than a surprise 409. */}
                {alreadyHave.has(String(v.id)) ? ' (already has one)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-2xs text-text-subtle">
          Point name
          <input className={field} value={form.point_code} placeholder="GCP-1"
            onChange={(e) => setForm({ ...form, point_code: e.target.value })} />
        </label>

        <label className="text-2xs text-text-subtle">
          Latitude (degrees)
          <input className={field} inputMode="decimal" value={form.latitude}
            placeholder="17.6868231"
            onChange={(e) => setForm({ ...form, latitude: e.target.value })} />
        </label>
        <label className="text-2xs text-text-subtle">
          Longitude (degrees)
          <input className={field} inputMode="decimal" value={form.longitude}
            placeholder="83.2184815"
            onChange={(e) => setForm({ ...form, longitude: e.target.value })} />
        </label>
        <label className="text-2xs text-text-subtle">
          Elevation (m)
          <input className={field} inputMode="decimal" value={form.elevation_m}
            placeholder="45.212"
            onChange={(e) => setForm({ ...form, elevation_m: e.target.value })} />
        </label>

        {/* The same point on a projected grid (§070): the controller gives
            both, and the drawings are in the grid. */}
        <label className="text-2xs text-text-subtle">
          Easting (m)
          <input className={field} inputMode="decimal" value={form.easting_m}
            placeholder="736412.318"
            onChange={(e) => setForm({ ...form, easting_m: e.target.value })} />
        </label>
        <label className="text-2xs text-text-subtle">
          Northing (m)
          <input className={field} inputMode="decimal" value={form.northing_m}
            placeholder="1956043.772"
            onChange={(e) => setForm({ ...form, northing_m: e.target.value })} />
        </label>
        <label className="text-2xs text-text-subtle">
          Grid zone
          <input className={field} value={form.grid_zone} placeholder="44N"
            onChange={(e) => setForm({ ...form, grid_zone: e.target.value })} />
        </label>

        <label className="text-2xs text-text-subtle">
          Established on
          <input type="date" className={field} value={form.established_on}
            max={businessToday()}
            onChange={(e) => setForm({ ...form, established_on: e.target.value })} />
        </label>
        <label className="text-2xs text-text-subtle sm:col-span-2">
          How it was fixed
          <input className={field} value={form.remarks}
            placeholder="Tied to BM 42; 45 min base observation, PDOP 1.4"
            onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </label>
      </div>

      {warnings.length > 0 ? (
        <Notice tone="warning" title="Check these coordinates">
          <ul className="space-y-0.5">
            {warnings.map((wn) => (
              <li key={wn}>{GCP_WARNING_NOTES[wn as keyof typeof GCP_WARNING_NOTES]}</li>
            ))}
          </ul>
          <p className="mt-1">You can still save them — this is a check, not a refusal.</p>
        </Notice>
      ) : null}

      {chosen && alreadyHave.has(String(chosen.id)) ? (
        <Notice tone="info" title={`${String(chosen.village_name)} already has a control point`}>
          A second one is fine on a large village — give it a different name, such as GCP-2.
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" loading={save.isPending}
          disabled={!form.survey_village_id || !form.point_code.trim()
            || form.latitude === '' || form.longitude === ''}
          onClick={() => save.mutate()}>
          Record point
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </Card>
  );
}

/* ----------------------------------------- ground control points (§069) */

/**
 * Every control point on the programme, in one list.
 *
 * The department asks for this with the final submission, and building it
 * village by village off a thousand screens is a day nobody has. It is also
 * the first thing anybody wants when a boundary is disputed two years later.
 */
function ControlList({
  projectId, projectName, canManage, onOpenVillage,
}: {
  projectId: string; projectName: string; canManage: boolean;
  onOpenVillage?: (villageId: string) => void;
}) {
  const [find, setFind] = React.useState('');
  const [onlyOdd, setOnlyOdd] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  // Control points are established mandal by mandal, and the list that goes
  // back to a mandal office is that mandal's.
  const [mandal, setMandal] = React.useState('');

  const q = useQuery({
    queryKey: ['survey-gcps', 'project', projectId],
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/projects/${projectId}/gcps`)).body as { data: Row[] }).data,
  });

  /*
   * The villages, for the picker.
   *
   * Recording control points is a one-time run through a programme, done at
   * a desk off a surveyor's notebook. Making somebody find each village in
   * another tab and expand it first turns an afternoon's typing into a
   * fortnight, which is why nobody could find where to do it.
   */
  const villages = useQuery({
    queryKey: ['survey-villages', projectId],
    enabled: adding,
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/projects/${projectId}/villages`)).body as { data: Row[] }).data,
  });

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;

  const all: Row[] = q.data ?? [];
  // Taken from the points themselves, so the picker offers only mandals that
  // actually have control points recorded.
  const mandals = [...new Set(all.map((g) => String(g.mandal_name ?? '')).filter(Boolean))].sort();
  const needle = find.trim().toLowerCase();
  const rows = all.filter((g) => {
    if (mandal && String(g.mandal_name ?? '') !== mandal) return false;
    if (onlyOdd && ((g.warnings as string[]) ?? []).length === 0) return false;
    if (!needle) return true;
    return [g.point_code, g.village_name, g.mandal_name, g.remarks]
      .some((f) => String(f ?? '').toLowerCase().includes(needle));
  });
  const flagged = all.filter((g) => ((g.warnings as string[]) ?? []).length > 0).length;

  const sheet = {
    name: 'Control points',
    title: {
      heading: 'Ground control points',
      project: projectName,
      period: 'As recorded',
      filters: [
        mandal ? `${mandal} mandal` : null,
        onlyOdd ? 'only points with a warning' : null,
        needle ? `matching \u201c${find.trim()}\u201d` : null,
      ].filter(Boolean).join(' \u00b7 '),
      extra: [['Points listed', `${rows.length} of ${all.length}`]] as Array<[string, string]>,
    },
    columns: [
      { header: 'Mandal', width: 20 },
      { header: 'Village', width: 26 },
      { header: 'Village code', width: 16 },
      { header: 'Point', width: 14 },
      { header: 'Latitude', width: 16 },
      { header: 'Longitude', width: 16 },
      { header: 'Elevation (m)', width: 14 },
      { header: 'Easting (m)', width: 16 },
      { header: 'Northing (m)', width: 16 },
      { header: 'Grid zone', width: 12 },
      { header: 'Established on', width: 16 },
      { header: 'How it was fixed', width: 50 },
    ],
    rows: rows.map((g) => [
      cellText(g.mandal_name), cellText(g.village_name), cellText(g.village_code),
      cellText(g.point_code),
      // Written in full, not rounded: a control point that loses its last
      // decimals is not a control point.
      String(Number(g.latitude).toFixed(7)),
      String(Number(g.longitude).toFixed(7)),
      cellNum(g.elevation_m),
      // Millimetres kept: a grid reference that loses its decimals is not a
      // grid reference.
      g.easting_m === null || g.easting_m === undefined
        ? '' : Number(g.easting_m).toFixed(3),
      g.northing_m === null || g.northing_m === undefined
        ? '' : Number(g.northing_m).toFixed(3),
      cellText(g.grid_zone),
      cellText(g.established_on), cellText(g.remarks),
    ]),
  };

  const recorder = canManage && adding ? (
    <GcpRecorder
      villages={villages.data ?? []}
      loading={villages.isLoading}
      alreadyHave={new Set(all.map((g) => String(g.survey_village_id)))}
      onDone={() => q.refetch()}
      onClose={() => setAdding(false)}
    />
  ) : null;

  if (all.length === 0) {
    return (
      <div className="space-y-3">
        {recorder}
        {!adding ? (
          <EmptyState
            title="No control points recorded yet"
            description="A control point is the fixed point the DGPS base was set over. Recording them is a one-time job, done before ground truthing starts — usually one point per village."
            action={canManage ? (
              <Button type="button" variant="primary" onClick={() => setAdding(true)}>
                Record a control point
              </Button>
            ) : undefined}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Toolbar>
        {canManage ? (
          <Button type="button" variant={adding ? 'secondary' : 'primary'}
            onClick={() => setAdding((a) => !a)}>
            {adding ? 'Close' : 'Record a control point'}
          </Button>
        ) : null}
        <input value={find} onChange={(e) => setFind(e.target.value)}
          placeholder="Find a point, village or mandal…"
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text" />
        <select value={mandal} onChange={(e) => setMandal(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text">
          <option value="">All mandals</option>
          {mandals.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {flagged > 0 ? (
          <label className="flex items-center gap-1.5 text-2xs text-text-muted">
            <input type="checkbox" checked={onlyOdd}
              onChange={(e) => setOnlyOdd(e.target.checked)} />
            Only the {flagged} that look wrong
          </label>
        ) : null}
        {(find || onlyOdd || mandal) ? (
          <Button type="button" variant="ghost"
            onClick={() => { setFind(''); setOnlyOdd(false); setMandal(''); }}>Clear</Button>
        ) : null}
        <span className="ml-auto text-2xs text-text-subtle">
          {rows.length} of {all.length} points
        </span>
        <ExportMenu sheet={sheet} fileName="survey-control-points" />
      </Toolbar>

      {recorder}

      {flagged > 0 && !onlyOdd ? (
        <Notice tone="warning"
          title={`${flagged} point${flagged === 1 ? '' : 's'} with coordinates that look wrong`}>
          {/* Warned, never refused: every one of these is also something a
              legitimate programme produces. */}
          Swapped latitude and longitude is the usual cause. Tick the box above to see
          only those, and open the village to correct them.
        </Notice>
      ) : null}

      <TableWrap tall>
        <Table>
          <THead>
            <TR>
              <TH>Mandal</TH>
              <TH>Village</TH>
              <TH>Point</TH>
              <TH className="text-right">Latitude</TH>
              <TH className="text-right">Longitude</TH>
              <TH className="text-right">Elevation</TH>
              <TH className="text-right">Grid (E / N)</TH>
              <TH>How it was fixed</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((g) => (
              <TR key={String(g.id)}>
                <TD tone="muted">{g.mandal_name ?? '—'}</TD>
                <TD>
                  {onOpenVillage ? (
                    <button type="button"
                      onClick={() => onOpenVillage(String(g.survey_village_id))}
                      className="text-left font-medium text-text underline-offset-2 hover:text-primary hover:underline"
                      title="Open this village">
                      {String(g.village_name)}
                    </button>
                  ) : (
                    <span className="font-medium text-text">{String(g.village_name)}</span>
                  )}
                </TD>
                <TD className="text-text">{String(g.point_code)}</TD>
                <TD mono className="text-right tabular-nums">
                  {formatCoordinate(Number(g.latitude), 'lat')}
                </TD>
                <TD mono className="text-right tabular-nums">
                  {formatCoordinate(Number(g.longitude), 'lng')}
                </TD>
                <TD className="text-right tabular-nums">
                  {g.elevation_m === null || g.elevation_m === undefined
                    ? <span className="text-text-subtle">—</span>
                    : `${Number(g.elevation_m)} m`}
                </TD>
                <TD mono className="text-right tabular-nums">
                  {g.easting_m === null || g.easting_m === undefined ? (
                    <span className="font-sans text-text-subtle">—</span>
                  ) : (
                    <>
                      <div>{Number(g.easting_m).toFixed(3)} E</div>
                      <div>{Number(g.northing_m).toFixed(3)} N</div>
                      <div className="font-sans text-text-subtle">{String(g.grid_zone ?? '')}</div>
                    </>
                  )}
                </TD>
                <TD tone="muted">
                  {g.remarks ? String(g.remarks) : '—'}
                  {((g.warnings as string[]) ?? []).map((wn) => (
                    <div key={wn} className="text-warning">
                      {GCP_WARNING_NOTES[wn as keyof typeof GCP_WARNING_NOTES]}
                    </div>
                  ))}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </div>
  );
}

/* ---------------------------------------------------------------- summary */

function Summary({ projectId, projectName }: { projectId: string; projectName: string }) {
  const q = useQuery({
    queryKey: ['survey-summary', projectId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/survey/projects/${projectId}/summary`)).body as { data: Row[] }).data,
  });

  const [find, setFind] = React.useState('');
  const [mandal, setMandal] = React.useState('');
  const [gt, setGt] = React.useState('');
  /*
   * Villages whose surveyed extent has drifted from the revenue record.
   *
   * The question after ground truthing signs off is always the same: which
   * villages did not come in at the extent the record says they are. The
   * threshold is the reader's to set, because what counts as a discrepancy
   * depends on the terrain — five per cent is alarming on flat delta land
   * and routine in the agency areas.
   */
  const [varyOn, setVaryOn] = React.useState(false);
  const [varyPct, setVaryPct] = React.useState('10');

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => q.refetch()} />;
  const all: Row[] = q.data ?? [];

  if (all.length === 0) {
    return <EmptyState title="No villages listed" description="Add the villages to be surveyed first." />;
  }

  // Mandals present on this sheet, not from a master list: a programme over
  // three mandals should not offer a picker with two hundred.
  const mandals = [...new Set(all.map((r) => String(r.mandal ?? '')).filter(Boolean))].sort();
  const needle = find.trim().toLowerCase();
  const rows = all.filter((r) => {
    if (mandal && String(r.mandal ?? '') !== mandal) return false;
    if (gt && String(r.gt_status ?? 'NOT_STARTED') !== gt) return false;
    if (varyOn) {
      // Only villages whose ground truthing is finished: a village still
      // being walked has not drifted from anything, it is simply part-done.
      if (String(r.gt_status ?? 'NOT_STARTED') !== 'COMPLETED') return false;
      if (!extentVaries(r.extent_ac, r.actual_extent_ac, Number(varyPct) || 0)) return false;
    }
    if (!needle) return true;
    return [r.village, r.mandal, r.assignee_name]
      .some((f) => String(f ?? '').toLowerCase().includes(needle));
  });

  /*
   * The sheet, as a file.
   *
   * This is the one people actually send: it carries every village on the
   * programme with where it has reached, and it was being rebuilt by hand in
   * Excel every month.
   */
  const filterNote = [
    mandal ? `${mandal} mandal` : null,
    gt ? `ground truthing ${(STAGE_STATE_LABELS[gt] ?? gt).toLowerCase()}` : null,
    needle ? `matching “${find.trim()}”` : null,
  ].filter(Boolean).join(' · ');

  const sheet = {
    name: 'Village summary',
    title: {
      heading: 'Village summary',
      project: projectName,
      period: 'As it stands today',
      filters: filterNote,
      extra: [['Villages listed', `${rows.length} of ${all.length}`]] as Array<[string, string]>,
    },
    columns: [
      { header: 'Mandal', width: 20 },
      { header: 'Village', width: 26 },
      { header: 'Extent (Ac)', width: 14 },
      { header: 'Extent (km²)', width: 14 },
      { header: 'Ground truthing', width: 18 },
      { header: 'Vectorization', width: 18 },
      { header: 'Points', width: 12 },
      { header: 'LPMs', width: 10 },
      { header: 'Actual extent (Ac)', width: 18 },
      { header: 'Actual extent (km²)', width: 20 },
      { header: 'Variance vs record (%)', width: 22 },
      { header: 'GT started', width: 14 },
      { header: 'GT completed', width: 14 },
      { header: 'Assigned to', width: 24 },
      // Ground-truthing staffing (§067): agreed, and what turned up.
      { header: 'Govt staff allotted', width: 18 },
      { header: 'Crew allotted', width: 16 },
      { header: 'Days with attendance', width: 20 },
      { header: 'Govt staff-days', width: 16 },
      { header: 'Crew-days', width: 14 },
      { header: 'Govt turnout (%)', width: 18 },
      { header: 'Days dept sent nobody', width: 22 },
      // What was out and who came (§note 19).
      { header: 'Rovers allocated', width: 18 },
      { header: 'Rover-days used', width: 18 },
      { header: 'Rover-days idle', width: 18 },
      { header: 'Rover utilisation (%)', width: 20 },
      { header: 'Crew assigned', width: 16 },
      { header: 'Return days', width: 14 },
      { header: 'Team-days', width: 14 },
    ],
    rows: rows.map((r) => [
      cellText(r.mandal), cellText(r.village),
      cellNum(r.extent_ac), cellNum(r.extent_sq_km),
      cellText(STAGE_STATE_LABELS[String(r.gt_status)] ?? r.gt_status),
      cellText(STAGE_STATE_LABELS[String(r.vectorization_status)] ?? r.vectorization_status),
      cellNum(r.points), cellNum(r.lpms), cellNum(r.actual_extent_ac),
      cellNum(r.actual_extent_sq_km), cellNum(extentVariancePct(r.extent_ac, r.actual_extent_ac)),
      cellText(r.gt_started_on), cellText(r.gt_completed_on), cellText(r.assignee_name),
      cellNum(r.gt_govt_staff_allocated), cellNum(r.gt_crew_allocated),
      cellNum(r.attendance_days), cellNum(r.govt_staff_days), cellNum(r.crew_days),
      cellNum(r.govt_staff_pct), cellNum(r.days_no_govt_staff),
      cellNum(r.rovers_allocated), cellNum(r.rover_days_used), cellNum(r.rover_days_idle),
      cellNum(r.rover_utilisation_pct), cellNum(r.crew_assigned),
      cellNum(r.return_days), cellNum(r.team_days),
    ]),
  };

  const sel = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <div className="space-y-3">
      <Toolbar>
        <input value={find} onChange={(e) => setFind(e.target.value)}
          placeholder="Find a village, mandal or person…"
          className={sel} />
        <select value={mandal} onChange={(e) => setMandal(e.target.value)} className={sel}>
          <option value="">All mandals</option>
          {mandals.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={gt} onChange={(e) => setGt(e.target.value)} className={sel}
          title="Where ground truthing has reached">
          <option value="">Any ground truthing state</option>
          {['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'].map((st) => (
            <option key={st} value={st}>{STAGE_STATE_LABELS[st] ?? st}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-2xs text-text-muted"
          title="Villages where ground truthing is finished and the surveyed extent differs from the revenue record">
          <input type="checkbox" checked={varyOn}
            onChange={(e) => setVaryOn(e.target.checked)} />
          Extent differs by
          <input className="w-14 rounded-md border border-border bg-surface px-1.5 py-1 text-sm text-text"
            inputMode="decimal" value={varyPct}
            onChange={(e) => setVaryPct(e.target.value)} />
          % or more
        </label>
        {(mandal || gt || find || varyOn) ? (
          <Button type="button" variant="ghost"
            onClick={() => {
              setMandal(''); setGt(''); setFind(''); setVaryOn(false);
            }}>Clear</Button>
        ) : null}
        <span className="ml-auto text-2xs text-text-subtle">
          {rows.length} of {all.length} villages
        </span>
        <ExportMenu sheet={sheet} fileName="survey-village-summary" />
      </Toolbar>

      {rows.length === 0 ? (
        <EmptyState title="No villages match that"
          description="Nothing on this sheet fits that combination. Widen the filter or clear it." />
      ) : (
    <TableWrap tall>
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
            {/*
              * What was out and who came (§note 19).
              *
              * A village that is behind is usually behind for one of two
              * reasons — the instruments sat idle, or the department did not
              * send anybody — and neither was on the sheet people scan.
              */}
            <TH className="text-right">Rovers</TH>
            <TH className="text-right">Crew</TH>
            <TH className="text-right">Turnout</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={`${r.village}-${i}`}>
              <TD tone="muted">{r.mandal ?? '—'}</TD>
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
                {/* Both units, because the revenue record is in acres and
                    every government letter is in square kilometres. */}
                <div className="text-2xs text-text-subtle">
                  {sqKm(r.actual_extent_sq_km)}
                </div>
                {/* The gap between planned and actual is the point of the
                    column, so it is stated rather than left to be worked out. */}
                {(() => {
                  const v = extentVariancePct(r.extent_ac, r.actual_extent_ac);
                  if (v === null) return null;
                  return (
                    <div className={Math.abs(v) >= 10 ? 'text-2xs text-warning'
                      : 'text-2xs text-text-subtle'}>
                      {v > 0 ? '+' : ''}{v}% vs record
                    </div>
                  );
                })()}
              </TD>
              <TD tone="subtle">
                {r.gt_started_on ? day(r.gt_started_on) : '—'}
                {r.gt_completed_on ? ` → ${day(r.gt_completed_on)}` : ''}
              </TD>
              {/* Who is on it, by employee name. The daily entry records a
                  team count; the task records the person. */}
              <TD tone="muted">{r.assignee_name ?? '—'}</TD>
              <TD className="text-right">
                {Number(r.rovers_allocated ?? 0) === 0
                  && Number(r.rover_days_used ?? 0) === 0 ? (
                  <span className="text-text-subtle">—</span>
                ) : (
                  <>
                    <div className="text-text">{count(r.rovers_allocated)} out</div>
                    <div className="text-text-subtle">
                      {count(r.rover_days_used)} used / {count(r.rover_days_idle)} idle
                    </div>
                    {r.rover_utilisation_pct !== null && r.rover_utilisation_pct !== undefined ? (
                      <div className={Number(r.rover_utilisation_pct) < 60
                        ? 'text-warning' : 'text-text-subtle'}>
                        {pct(r.rover_utilisation_pct)}
                      </div>
                    ) : null}
                  </>
                )}
              </TD>
              <TD className="text-right">
                <div className="text-text">{count(r.crew_assigned)}</div>
                {Number(r.return_days ?? 0) > 0 ? (
                  <div className="text-text-subtle">
                    {count(r.team_days)} team-days over {count(r.return_days)}
                  </div>
                ) : null}
              </TD>
              {/*
                * Who was allotted and who came (§067).
                *
                * On the sheet rather than only in the report, because this
                * is the page somebody scans for the village that is behind,
                * and "the department sent nobody for six days" is usually
                * the reason.
                */}
              <TD className="text-right">
                {r.gt_govt_staff_allocated == null && !r.attendance_days ? (
                  <span className="text-text-subtle">—</span>
                ) : (
                  <>
                    <div className="text-text">
                      {r.govt_staff_pct == null ? '—' : pct(r.govt_staff_pct)}
                    </div>
                    <div className="text-text-subtle">
                      {count(r.gt_govt_staff_allocated)} + {count(r.gt_crew_allocated)} allotted
                    </div>
                    {Number(r.days_no_govt_staff ?? 0) > 0 ? (
                      <div className="text-warning">
                        {count(r.days_no_govt_staff)} day(s) nobody
                      </div>
                    ) : null}
                  </>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrap>
      )}
    </div>
  );
}

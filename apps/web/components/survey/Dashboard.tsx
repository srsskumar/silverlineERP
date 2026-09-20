'use client';

/**
 * The land survey programme at a glance (§071).
 *
 * Built to be put in front of somebody from the department, which shapes
 * every decision in it: no money, no names, no equipment, no jargon, and a
 * single number per village rather than a stage matrix. Everything on it
 * drills down — a bar goes to the villages behind it, a district goes to its
 * mandals, a mandal to its villages — because the first question after any
 * figure is "which ones".
 */
import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { Stat } from '@/components/finance/Primitives';
import { ExportMenu } from '@/components/ui/ExportMenu';

interface Rung { key: string; label: string; note?: string | null }
interface Unit { id: string; name: string }

interface DashboardRow {
  id: string | null;
  name: string;
  villages: number;
  extent_ac: number;
  extent_sqkm: number;
  surveyed_ac: number;
  surveyed_sqkm: number;
  by_position: Record<string, number>;
  completed: number;
  not_started: number;
  late: number;
}

interface DashboardVillage {
  id: string;
  name: string;
  code: string | null;
  district: string | null;
  mandal: string | null;
  extent_ac: number | null;
  extent_sqkm: number;
  surveyed_ac: number;
  position: string;
  position_label: string;
  on_hold: boolean;
  in_rework: boolean;
  gt_started_on: string | null;
  gt_expected_end_on: string | null;
  gt_completed_on: string | null;
  surveyed_sqkm: number;
  stage_days: Record<string, number | null>;
  days_in_stage: number | null;
  holders?: string[];
  holder_count?: number;
  gcp_count: number;
  earned_milestones: number[];
  slip_days: number | null;
  slip_stage: string | null;
  slip_note: string | null;
  slip_reason: string | null;
  slip_needs_reason: boolean;
}

interface PositionRow {
  key: string;
  label: string;
  villages: number;
  extent_ac: number;
  extent_sqkm: number;
  surveyed_ac: number;
  surveyed_sqkm: number;
  share_pct: number;
}

interface ReasonRow { code: string; label: string; count: number; villages: number }
interface ReasonGroup {
  unit: string;
  note: string;
  total: number;
  by_reason: ReasonRow[];
}

interface DashboardData {
  project: { id: string; name: string; code: string | null };
  period: { from: string | null; to: string };
  level: string;
  filter: {
    district: string | null; mandal: string | null; position: string | null;
    reason: string | null; reason_source: string | null;
    villages: number; of_villages: number;
  };
  options: { districts: Unit[]; mandals: Unit[] };
  ladder: Rung[];
  totals: {
    villages: number;
    extent_ac: number; extent_sqkm: number;
    surveyed_ac: number; surveyed_sqkm: number;
    by_position: Record<string, number>;
    on_hold: number; in_rework: number; gcp_missing: number;
    late: number; late_unexplained: number; unplanned: number;
    positions: PositionRow[];
    earned: Record<string, number>;
    claimed_unearned: Record<string, number>;
    awaiting_sign_off: Array<{
      code: string; label: string; villages: number; signed_off_by: string | null;
    }>;
  };
  stage_days: Array<{
    code: string; label: string;
    villages_measured: number; villages_here: number;
    avg_days: number | null; median_days: number | null; max_days: number | null;
    holders?: Array<{ name: string; villages: number }>;
    unassigned?: number;
  }>;
  reasons: {
    stage_variance: ReasonGroup;
    instrument_idle: ReasonGroup;
    low_progress: ReasonGroup;
  };
  rows: DashboardRow[];
  /** The mandal roll-up, sent unless the grouping above already is mandal. */
  by_mandal: Array<DashboardRow & { district: string | null }> | null;
  villages: DashboardVillage[];
}

const nf = new Intl.NumberFormat('en-IN');
const num = (n: number | null | undefined) => nf.format(Math.round(Number(n ?? 0)));
const dec = (n: number | null | undefined) =>
  nf.format(Math.round(Number(n ?? 0) * 100) / 100);

/**
 * Colour runs cool to warm along the ladder, so a chart is readable before
 * any label is. Deliberately not red for early rungs: a village not started
 * is a village whose turn has not come, not a village in trouble.
 */
/** Whether a bar has room for its own number inside it. */
function wideEnough(count: number, max: number): boolean {
  return max > 0 && count / max > 0.14;
}

function rungTone(index: number, total: number): string {
  if (index === 0) return 'bg-neutral-400/70 dark:bg-neutral-500/70';
  const share = index / Math.max(1, total - 1);
  if (share < 0.3) return 'bg-sky-500/80';
  if (share < 0.6) return 'bg-indigo-500/80';
  if (share < 0.9) return 'bg-emerald-500/75';
  return 'bg-emerald-600';
}

/**
 * One roll-up table, drawn the same way wherever it appears.
 *
 * The district grouping and the mandal grouping are the same nine columns
 * over different rows, and they were about to be the same JSX twice — which
 * is how one of them quietly stops matching the other.
 */
function RollUp({
  title, unitHeading, note, rows, ladder, onSelect,
}: {
  title: string;
  unitHeading: string;
  note: string;
  rows: Array<DashboardRow & { district?: string | null }>;
  ladder: Rung[];
  onSelect: (row: DashboardRow) => void;
}) {
  const showsParent = rows.some(r => r.district);
  return (
    <Card className="p-0">
      <div className="flex items-baseline justify-between gap-2 px-4 py-3">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <span className="text-2xs text-text-subtle">{note}</span>
      </div>
      <TableWrap tall={rows.length > 15}>
        <Table>
          <THead>
            <TR>
              <TH>{unitHeading}</TH>
              {/* Mandal names repeat across districts; thirty bare ones read
                  as a list of nothing. */}
              {showsParent ? <TH>District</TH> : null}
              <TH className="text-right">Villages</TH>
              <TH className="text-right">Extent (Ac)</TH>
              <TH className="text-right">Extent (km²)</TH>
              <TH className="text-right">Surveyed (Ac)</TH>
              <TH className="text-right">Surveyed (km²)</TH>
              <TH className="text-right">Not started</TH>
              <TH className="text-right">Finished</TH>
              <TH className="text-right">Behind plan</TH>
              <TH>Spread</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id ?? '__none__'}>
                <TD>
                  {row.id ? (
                    <button type="button"
                      className="text-left text-primary underline-offset-2 hover:underline"
                      onClick={() => onSelect(row)}>
                      {row.name}
                    </button>
                  ) : row.name}
                </TD>
                {showsParent ? (
                  <TD className="text-text-muted">{row.district ?? '—'}</TD>
                ) : null}
                <TD className="text-right tabular-nums">{num(row.villages)}</TD>
                <TD className="text-right tabular-nums">{dec(row.extent_ac)}</TD>
                <TD className="text-right tabular-nums text-text-muted">{dec(row.extent_sqkm)}</TD>
                <TD className="text-right tabular-nums">{dec(row.surveyed_ac)}</TD>
                <TD className="text-right tabular-nums text-text-muted">{dec(row.surveyed_sqkm)}</TD>
                <TD className="text-right tabular-nums">{num(row.not_started)}</TD>
                <TD className="text-right tabular-nums">{num(row.completed)}</TD>
                <TD className={`text-right tabular-nums ${row.late > 0 ? 'text-danger' : ''}`}>
                  {num(row.late)}
                </TD>
                <TD>
                  {/* The same eleven positions, as one bar per group. */}
                  <span className="flex h-3 w-40 overflow-hidden rounded bg-surface-sunken"
                    title={ladder
                      .map((r: Rung) => `${r.label}: ${row.by_position[r.key] ?? 0}`)
                      .filter((t: string) => !t.endsWith(': 0')).join('\n')}>
                    {ladder.map((r: Rung, i: number) => {
                      const n = row.by_position[r.key] ?? 0;
                      if (!n) return null;
                      return (
                        <span key={r.key} className={rungTone(i, ladder.length)}
                          style={{ width: `${(n / Math.max(1, row.villages)) * 100}%` }} />
                      );
                    })}
                  </span>
                </TD>
              </TR>
            ))}
            {rows.length === 0 ? (
              <TR><TD colSpan={showsParent ? 11 : 10}
                className="py-6 text-center text-sm text-text-muted">
                No villages match these filters.
              </TD></TR>
            ) : null}
          </TBody>
        </Table>
      </TableWrap>
    </Card>
  );
}

export function SurveyDashboard({
  projectId, canDrill, onOpenVillage,
}: {
  projectId: string;
  /** Whether this reader may leave the dashboard for the detailed screens. */
  canDrill: boolean;
  onOpenVillage?: (villageId: string) => void;
}) {
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [level, setLevel] = React.useState('district');
  const [district, setDistrict] = React.useState('');
  const [mandal, setMandal] = React.useState('');
  const [position, setPosition] = React.useState('');
  const [reason, setReason] = React.useState<{ code: string; source: string } | null>(null);
  const sel = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  const query = useQuery({
    queryKey: ['survey', 'dashboard', projectId, from, to, level, district, mandal,
      position, reason?.code ?? '', reason?.source ?? ''],
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/projects/${projectId}/dashboard`
      + `?level=${encodeURIComponent(level)}`
      + (from ? `&from=${from}` : '') + (to ? `&to=${to}` : '')
      + (district ? `&district=${encodeURIComponent(district)}` : '')
      + (mandal ? `&mandal=${encodeURIComponent(mandal)}` : '')
      + (position ? `&position=${encodeURIComponent(position)}` : '')
      + (reason ? `&reason=${encodeURIComponent(reason.code)}`
        + `&reason_source=${encodeURIComponent(reason.source)}` : ''),
    )).body as { data: DashboardData }),
    enabled: Boolean(projectId),
  });

  const d: DashboardData | undefined = query.data?.data;
  const ladder = d?.ladder ?? [];
  const totals = d?.totals;

  // Every hook has run by here; the early returns below are safe.
  const villageSheet = React.useMemo(() => ({
    name: 'Village status',
    title: {
      heading: 'Land survey — village status',
      project: d?.project.name,
      period: d?.period.from
        ? `Movement from ${d.period.from}, as at ${d.period.to}`
        : `As at ${d?.period.to ?? ''}`,
      filters: [
        district ? d?.options.districts.find((u: Unit) => u.id === district)?.name : null,
        mandal ? d?.options.mandals.find((u: Unit) => u.id === mandal)?.name : null,
        position ? ladder.find((r: Rung) => r.key === position)?.label : null,
        reason ? `Reason: ${reason.code.replace(/_/g, ' ').toLowerCase()}` : null,
      ].filter(Boolean).join(' · ') || 'No filters applied',
      extra: [
        ['Villages', `${d?.filter.villages ?? 0} of ${d?.filter.of_villages ?? 0}`],
        ['Extent', `${dec(totals?.extent_ac)} Ac`],
        ['Surveyed', `${dec(totals?.surveyed_ac)} Ac`],
      ] as Array<[string, string]>,
    },
    columns: [
      { header: 'Village', width: 24 }, { header: 'Code', width: 12 },
      { header: 'District', width: 18 }, { header: 'Mandal', width: 18 },
      { header: 'Extent (Ac)', width: 12 }, { header: 'Extent (km²)', width: 12 },
      { header: 'Surveyed (Ac)', width: 13 }, { header: 'Surveyed (km²)', width: 14 },
      { header: 'Status', width: 28 }, { header: 'Days in stage', width: 13 },
      { header: 'Sitting with', width: 30 },
      { header: 'On hold', width: 9 }, { header: 'In rework', width: 10 },
      { header: 'Against plan', width: 16 }, { header: 'Slipping stage', width: 20 },
      { header: 'Variance reason', width: 18 },
      { header: 'GT started', width: 12 }, { header: 'GT expected end', width: 15 },
      { header: 'GT completed', width: 14 }, { header: 'Control points', width: 13 },
    ],
    rows: (d?.villages ?? []).map((v: DashboardVillage) => [
      v.name, v.code ?? '', v.district ?? '', v.mandal ?? '',
      dec(v.extent_ac), dec(v.extent_sqkm), dec(v.surveyed_ac), dec(v.surveyed_sqkm),
      v.position_label,
      v.days_in_stage === null ? '' : String(v.days_in_stage),
      (v.holders ?? []).join(', '),
      v.on_hold ? 'yes' : '', v.in_rework ? 'yes' : '',
      v.slip_note ?? 'no dates set', v.slip_stage ?? '', v.slip_reason ?? '',
      v.gt_started_on ?? '', v.gt_expected_end_on ?? '', v.gt_completed_on ?? '',
      String(v.gcp_count),
    ]),
  }), [d, totals, district, mandal, position, reason, ladder]);

  if (query.isLoading) return <Skeleton className="h-96" />;
  if (query.isError) {
    return <ErrorCard title="The dashboard could not be loaded" error={query.error} onRetry={() => query.refetch()} />;
  }
  if (!d || !totals) return <EmptyState title="Nothing to show yet" />;

  const maxRung = Math.max(1, ...ladder.map((r: Rung) => totals.by_position[r.key] ?? 0));
  /** The last row of the table, added up from the rows above it. */
  const sum = (field: keyof PositionRow): number =>
    totals.positions.reduce((t, p) => t + Number(p[field] ?? 0), 0);
  const surveyedPct = totals.extent_ac > 0
    ? Math.round((totals.surveyed_ac / totals.extent_ac) * 1000) / 10 : null;
  const finished = totals.by_position.FINAL_APPROVED ?? 0;

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------- filters */}
      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-text-subtle">
            Period from
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-text" />
          </label>
          <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-text-subtle">
            to
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-text" />
          </label>
          <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-text-subtle">
            District
            <select className={sel} value={district}
              onChange={(e) => { setDistrict(e.target.value); setMandal(''); }}>
              <option value="">All districts</option>
              {d.options.districts.map((u: Unit) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-text-subtle">
            Mandal
            <select className={sel} value={mandal} onChange={(e) => setMandal(e.target.value)}>
              <option value="">All mandals</option>
              {d.options.mandals.map((u: Unit) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-text-subtle">
            Group by
            <select className={sel} value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="district">District</option>
              <option value="division">Division</option>
              <option value="mandal">Mandal</option>
            </select>
          </label>
          {position ? (
            <Button variant="ghost" onClick={() => setPosition('')}>
              Clear “{ladder.find((r: Rung) => r.key === position)?.label ?? position}”
            </Button>
          ) : null}
          {reason ? (
            <Button variant="ghost" onClick={() => setReason(null)}>
              Clear reason
            </Button>
          ) : null}
          <div className="ml-auto">
            <ExportMenu sheet={villageSheet}
              fileName={`land-survey-${d.project.code ?? d.project.id}`}
              note={`${num(d.villages.length)} villages`} />
          </div>
        </div>
        {d.filter.villages !== d.filter.of_villages ? (
          <p className="mt-2 text-xs text-text-muted">
            Showing {num(d.filter.villages)} of {num(d.filter.of_villages)} villages.
          </p>
        ) : null}
        {/* A hover is no use to somebody who has already narrowed the screen
            to one position and wants to know what they are looking at. */}
        {position ? (
          <p className="mt-2 text-xs text-text-muted">
            <strong className="text-text">
              {ladder.find((r: Rung) => r.key === position)?.label}
            </strong>{' '}
            — {ladder.find((r: Rung) => r.key === position)?.note}
          </p>
        ) : null}
      </Card>

      {/* ------------------------------------------------------- the headline */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Villages" value={num(totals.villages)}
          explain="Every village in this programme, after the filters above." />
        <Stat label="Extent to survey" value={`${dec(totals.extent_ac)} Ac`}
          hint={`${dec(totals.extent_sqkm)} km²`}
          explain="The total extent of the villages shown. One acre is 0.00404686 km²." />
        <Stat label="Surveyed" value={`${dec(totals.surveyed_ac)} Ac`}
          hint={`${dec(totals.surveyed_sqkm)} km²${
            surveyedPct === null ? '' : ` · ${surveyedPct}% of extent`}`}
          explain={d.period.from
            ? 'Extent recorded between the two dates above.'
            : 'Extent recorded up to the date above.'} />
        <Stat label="Villages finished" value={`${num(finished)} of ${num(totals.villages)}`}
          tone={finished > 0 ? 'success' : 'default'}
          explain="Final deliverables approved by the department." />
        <Stat label="Behind plan" value={num(totals.late)}
          tone={totals.late > 0 ? 'danger' : 'success'}
          hint={totals.unplanned > 0 ? `${num(totals.unplanned)} have no dates set` : undefined}
          explain="Villages whose worst stage is past its expected finish. Work still running is measured against today, so this is a warning rather than a post-mortem." />
      </div>

      {/* ------------------------------------------------ the eleven positions */}
      <Card className="p-4">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">Where every village has got to</h3>
          <span className="text-2xs text-text-subtle">
            One village counted once. Select a row to filter everything below.
          </span>
        </div>
        {/* Named, so the bars can be addressed apart from the table of the
            same eleven rungs below them. */}
        <ul className="space-y-1" aria-label="Villages by stage, as bars">
          {ladder.map((rung: Rung, i: number) => {
            const count = totals.by_position[rung.key] ?? 0;
            const share = totals.villages > 0
              ? Math.round((count / totals.villages) * 1000) / 10 : 0;
            const selected = position === rung.key;
            return (
              <li key={rung.key}>
                <button
                  type="button"
                  aria-pressed={selected}
                  /* Every one of these labels is a term of art: "data
                     submitted" and "data approved" are days apart in the work
                     and months apart in the money. */
                  title={rung.note ?? undefined}
                  onClick={() => setPosition(selected ? '' : rung.key)}
                  className={`flex w-full items-center gap-3 rounded px-2 py-1.5 text-left transition
                    hover:bg-surface-sunken ${selected ? 'bg-surface-sunken ring-1 ring-border' : ''}`}
                >
                  <span className="w-56 shrink-0 truncate text-sm text-text">{rung.label}</span>
                  <span className="relative h-6 flex-1 overflow-hidden rounded bg-surface-sunken">
                    <span
                      className={`absolute inset-y-0 left-0 rounded ${rungTone(i, ladder.length)}`}
                      style={{ width: `${(count / maxRung) * 100}%` }}
                    />
                    {/*
                      * The count sits on its own bar.
                      *
                      * Reading a bar and then tracking across to a column of
                      * figures is two movements for one fact, and on eleven
                      * rows people lose their line. Inside the bar while it
                      * is wide enough to hold the number, just outside it
                      * when it is not — so a village count is never hidden
                      * by the thing that represents it.
                      */}
                    <span
                      className={`absolute inset-y-0 flex items-center text-2xs font-semibold tabular-nums
                        ${wideEnough(count, maxRung)
                          ? 'text-white/95 dark:text-white'
                          : 'text-text'}`}
                      style={wideEnough(count, maxRung)
                        ? { right: `calc(${100 - (count / maxRung) * 100}% + 0.5rem)` }
                        : { left: `calc(${(count / maxRung) * 100}% + 0.5rem)` }}
                    >
                      {num(count)}
                    </span>
                  </span>
                  <span className="w-16 shrink-0 text-right text-2xs tabular-nums text-text-subtle">
                    {share}%
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {/*
          * The same eleven rungs again, as figures.
          *
          * The chart answers "where is the weight" at a glance and is
          * useless for reading a number off; the table answers "how many, and
          * how much extent" and is useless for seeing the shape. Both, rather
          * than a compromise that does neither — and the reader who has to
          * put a figure in a note can take it from here without counting
          * pixels.
          *
          * The last row is summed from the rows above it rather than taken
          * from the headline. A total fetched separately is a total that can
          * disagree with what is on the screen, and nothing tells the reader
          * which of the two to believe.
          */}
        <div className="mt-4 border-t border-border pt-3">
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Stage</TH>
                  <TH className="text-right">Villages</TH>
                  <TH className="text-right">Share</TH>
                  <TH className="text-right">Extent (Ac)</TH>
                  <TH className="text-right">Extent (km²)</TH>
                  <TH className="text-right">Surveyed (Ac)</TH>
                  <TH className="text-right">Surveyed (km²)</TH>
                </TR>
              </THead>
              <TBody>
                {totals.positions.map((p: PositionRow) => {
                  const selected = position === p.key;
                  return (
                    <TR key={p.key}
                      className={selected ? 'bg-surface-sunken' : undefined}>
                      <TD>
                        <button type="button"
                          aria-pressed={selected}
                          title={ladder.find((r: Rung) => r.key === p.key)?.note ?? undefined}
                          onClick={() => setPosition(selected ? '' : p.key)}
                          className="text-left text-primary underline-offset-2 hover:underline">
                          {p.label}
                        </button>
                      </TD>
                      <TD className="text-right tabular-nums">{num(p.villages)}</TD>
                      <TD className="text-right tabular-nums text-text-muted">
                        {p.share_pct}%
                      </TD>
                      <TD className="text-right tabular-nums">{dec(p.extent_ac)}</TD>
                      <TD className="text-right tabular-nums text-text-muted">
                        {dec(p.extent_sqkm)}
                      </TD>
                      <TD className="text-right tabular-nums">{dec(p.surveyed_ac)}</TD>
                      <TD className="text-right tabular-nums text-text-muted">
                        {dec(p.surveyed_sqkm)}
                      </TD>
                    </TR>
                  );
                })}
                <TR className="border-t-2 border-border font-semibold">
                  <TD>Total</TD>
                  <TD className="text-right tabular-nums">{num(sum('villages'))}</TD>
                  <TD className="text-right tabular-nums text-text-muted">
                    {Math.round(sum('share_pct') * 10) / 10}%
                  </TD>
                  <TD className="text-right tabular-nums">{dec(sum('extent_ac'))}</TD>
                  <TD className="text-right tabular-nums text-text-muted">
                    {dec(sum('extent_sqkm'))}
                  </TD>
                  <TD className="text-right tabular-nums">{dec(sum('surveyed_ac'))}</TD>
                  <TD className="text-right tabular-nums text-text-muted">
                    {dec(sum('surveyed_sqkm'))}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </TableWrap>
        </div>

        {/*
          * Reported beside the ladder rather than as extra rungs. Each is
          * something true *about* a village at a position; making them
          * positions would mean a village counted twice, and the eleven
          * would stop adding up to the total.
          */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {totals.late > 0 ? (
            <Badge tone="danger">{num(totals.late)} behind plan</Badge>
          ) : null}
          {totals.late_unexplained > 0 ? (
            <Badge tone="warning">
              {num(totals.late_unexplained)} slipping with no reason recorded
            </Badge>
          ) : null}
          {/*
            * Never folded into "on schedule". A village with no expected date
            * is not a village running to time, and counting it as one is how
            * a programme reports itself green while nobody knows when
            * anything is due.
            */}
          {totals.unplanned > 0 ? (
            <Badge tone="neutral">{num(totals.unplanned)} with no dates set</Badge>
          ) : null}
          {totals.on_hold > 0 ? (
            <Badge tone="warning">{num(totals.on_hold)} on hold</Badge>
          ) : null}
          {totals.in_rework > 0 ? (
            <Badge tone="warning">{num(totals.in_rework)} in rework</Badge>
          ) : null}
          {totals.gcp_missing > 0 ? (
            <Badge tone="danger">
              {num(totals.gcp_missing)} started with no control point recorded
            </Badge>
          ) : null}
        </div>
      </Card>

      {/* ------------------------------------------ how long, and sitting with whom */}
      <Card className="p-0">
        <div className="flex items-baseline justify-between gap-2 px-4 py-3">
          <h3 className="text-sm font-semibold text-text">How long each stage takes</h3>
          <span className="text-2xs text-text-subtle">
            Open stages counted to today, so the figure is current rather than final
          </span>
        </div>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Stage</TH>
                <TH className="text-right">Villages here now</TH>
                <TH className="text-right">Median days</TH>
                <TH className="text-right">Average days</TH>
                <TH className="text-right">Longest</TH>
                {canDrill ? <TH>Sitting with</TH> : null}
              </TR>
            </THead>
            <TBody>
              {d.stage_days.map((st) => (
                <TR key={st.code}>
                  <TD className="font-medium">{st.label}</TD>
                  <TD className="text-right tabular-nums">{num(st.villages_here)}</TD>
                  {/*
                    * The median first, and the average beside it. A handful of
                    * villages stuck for half a year drags a mean somewhere no
                    * village actually is; "half clear in eleven days" is the
                    * sentence somebody can plan around.
                    */}
                  <TD className="text-right tabular-nums">
                    {st.median_days === null ? '—' : num(st.median_days)}
                  </TD>
                  <TD className="text-right tabular-nums text-text-muted">
                    {st.avg_days === null ? '—' : dec(st.avg_days)}
                  </TD>
                  <TD className="text-right tabular-nums text-text-muted">
                    {st.max_days === null ? '—' : num(st.max_days)}
                  </TD>
                  {canDrill ? (
                    <TD>
                      {(st.holders ?? []).length === 0 ? (
                        <span className="text-2xs text-text-subtle">
                          {st.villages_here === 0 ? '—' : 'nobody assigned'}
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {(st.holders ?? []).map((h) => (
                            <Badge key={h.name} tone="neutral" size="sm">
                              {`${h.name} · ${h.villages}`}
                            </Badge>
                          ))}
                          {(st.unassigned ?? 0) > 0 ? (
                            <Badge tone="warning" size="sm">
                              {`${num(st.unassigned ?? 0)} with nobody`}
                            </Badge>
                          ) : null}
                        </span>
                      )}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      </Card>

      {/* ------------------------------------------ finished, and not yet accepted */}
      <Card className="p-4">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">Waiting to be signed off</h3>
          <span className="text-2xs text-text-subtle">
            Finishing work and having it accepted are different events, and the
            contract pays on the second
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {totals.awaiting_sign_off.map((st) => (
            <Badge key={st.code} tone={st.villages > 0 ? 'warning' : 'neutral'}>
              {`${num(st.villages)} ${st.label.toLowerCase()} awaiting ${
                (st.signed_off_by ?? '').replace(/_/g, ' ').toLowerCase()}`}
            </Badge>
          ))}
        </div>
        {/*
          * What may actually be claimed, beside it. Counted from the same
          * rule the claim route refuses with, so a reader is never told on
          * one screen that something is billable and on the next that it is
          * not.
          */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {Object.entries(totals.earned).map(([milestone, n]) => (
            <Badge key={milestone} tone={n > 0 ? 'success' : 'neutral'}>
              {`${num(n)} eligible for milestone ${milestone}`}
            </Badge>
          ))}
        </div>
        {/*
          * Claims already with the department against work nobody has
          * accepted.
          *
          * The rule tightened and did not reach backwards, which is right —
          * a claim already sent is a fact rather than a mistake to erase.
          * But a rule enforced on new claims and silent about the old ones
          * leaves a programme quietly disagreeing with itself, and the first
          * anybody hears of it is the department asking.
          */}
        {Object.values(totals.claimed_unearned).some((n) => n > 0) ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {Object.entries(totals.claimed_unearned)
              .filter(([, n]) => n > 0)
              .map(([milestone, n]) => (
                <Badge key={milestone} tone="danger">
                  {`${num(n)} claimed at milestone ${milestone} without a sign-off`}
                </Badge>
              ))}
            <span className="text-2xs text-text-subtle">
              Raised before the rule tightened. Left exactly as they are — what
              to do about them is a decision about money.
            </span>
          </div>
        ) : null}
      </Card>

      {/* --------------------------------------------------- why work is held up */}
      <Card className="p-4">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">Why the work is held up</h3>
          <span className="text-2xs text-text-subtle">
            Select a reason to see the villages behind it
          </span>
        </div>
        {/*
          * Three lists, never one total.
          *
          * The module collects a reason at three separate moments and all
          * three draw on the same fixed vocabulary, which is what makes them
          * comparable — but a stage, an instrument-day and a short day are
          * three different units and adding them would be a number with no
          * meaning. Each says what it counts.
          */}
        <div className="grid gap-4 md:grid-cols-3">
          {([
            ['stage_variance', d.reasons.stage_variance, 'Stages that missed their date'],
            ['instrument_idle', d.reasons.instrument_idle, 'Instruments standing idle'],
            ['low_progress', d.reasons.low_progress, 'Days that fell short'],
          ] as Array<[string, ReasonGroup, string]>).map(([key, group, heading]) => {
            const top = Math.max(1, ...group.by_reason.map((r: ReasonRow) => r.count));
            return (
              <div key={key} className="min-w-0">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <h4 className="text-xs font-semibold text-text">{heading}</h4>
                  <span className="text-2xs tabular-nums text-text-subtle">
                    {num(group.total)} {group.unit}
                  </span>
                </div>
                <ul className="space-y-0.5">
                  {group.by_reason.map((r: ReasonRow) => {
                    const selected = reason?.code === r.code && reason?.source === key;
                    return (
                      <li key={r.code}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          disabled={r.count === 0}
                          onClick={() => setReason(selected ? null : { code: r.code, source: key })}
                          className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left
                            ${r.count === 0
                              ? 'cursor-default opacity-40'
                              : 'hover:bg-surface-sunken'}
                            ${selected ? 'bg-surface-sunken ring-1 ring-border' : ''}`}
                        >
                          <span className="w-32 shrink-0 truncate text-2xs text-text">
                            {r.label}
                          </span>
                          <span className="relative h-3.5 flex-1 overflow-hidden rounded bg-surface-sunken">
                            <span className="absolute inset-y-0 left-0 rounded bg-amber-500/80"
                              style={{ width: `${(r.count / top) * 100}%` }} />
                          </span>
                          <span className="w-10 shrink-0 text-right text-2xs tabular-nums text-text">
                            {num(r.count)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {/*
                  * A reason with no occurrences is still listed, greyed.
                  * "No departmental staff" being absent is a finding of its
                  * own, but only if a reader can see it was looked for.
                  */}
              </div>
            );
          })}
        </div>
        {reason ? (
          <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-text-muted">
              Showing {num(d.filter.villages)} villages where{' '}
              <strong className="text-text">
                {d.reasons[reason.source as keyof DashboardData['reasons']]
                  .by_reason.find((r: ReasonRow) => r.code === reason.code)?.label ?? reason.code}
              </strong>{' '}
              was recorded.
            </span>
            <Button variant="ghost" onClick={() => setReason(null)}>Clear</Button>
          </div>
        ) : null}
      </Card>

      {/* -------------------------------------------------------- the roll-ups */}
      <RollUp
        title={`By ${level}`}
        unitHeading={level[0].toUpperCase() + level.slice(1)}
        note={level === 'mandal'
          ? 'Select a mandal to see its villages'
          : 'Select a row to narrow everything below'}
        rows={d.rows}
        ladder={ladder}
        onSelect={(row) => {
          if (level === 'district') { setDistrict(row.id!); setLevel('mandal'); return; }
          if (level === 'mandal') setMandal(row.id!);
        }}
      />

      {/*
        * The mandal roll-up, beside whatever level was asked for.
        *
        * A district tells an official the programme is behind; the mandal
        * tells them which tahsildar to ring. It is the level the work is
        * actually organised at — crews are posted to mandals and the
        * department staffs them by mandal — so it is always here rather than
        * only when somebody thinks to change the grouping above.
        */}
      {d.by_mandal ? (
        <RollUp
          title="By mandal"
          unitHeading="Mandal"
          note="Select a mandal to narrow everything below"
          rows={d.by_mandal}
          ladder={ladder}
          onSelect={(row) => setMandal(row.id!)}
        />
      ) : null}

      {/* ------------------------------------------------------- the villages */}
      <Card className="p-0">
        <div className="flex items-baseline justify-between gap-2 px-4 py-3">
          <h3 className="text-sm font-semibold text-text">Villages</h3>
          <span className="text-2xs text-text-subtle">{num(d.villages.length)} shown</span>
        </div>
        <TableWrap tall>
          <Table>
            <THead>
              <TR>
                <TH>Village</TH>
                <TH>District</TH>
                <TH>Mandal</TH>
                <TH className="text-right">Extent (Ac)</TH>
                <TH className="text-right">Extent (km²)</TH>
                <TH className="text-right">Surveyed (Ac)</TH>
                <TH className="text-right">Surveyed (km²)</TH>
                <TH>Status</TH>
                <TH className="text-right">Days here</TH>
                {canDrill ? <TH>Sitting with</TH> : null}
                <TH>Against plan</TH>
                <TH>GT started</TH>
                <TH>GT expected end</TH>
                <TH>GT actual end</TH>
              </TR>
            </THead>
            <TBody>
              {d.villages.map((v: DashboardVillage) => (
                <TR key={v.id}>
                  <TD>
                    {canDrill && onOpenVillage ? (
                      <button type="button"
                        className="text-left text-primary underline-offset-2 hover:underline"
                        onClick={() => onOpenVillage(v.id)}>
                        {v.name}
                      </button>
                    ) : v.name}
                    {v.code ? (
                      <span className="ml-1.5 text-2xs text-text-subtle">{v.code}</span>
                    ) : null}
                  </TD>
                  <TD className="text-text-muted">{v.district ?? '—'}</TD>
                  <TD className="text-text-muted">{v.mandal ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{dec(v.extent_ac)}</TD>
                  <TD className="text-right tabular-nums text-text-muted">{dec(v.extent_sqkm)}</TD>
                  <TD className="text-right tabular-nums">{dec(v.surveyed_ac)}</TD>
                  <TD className="text-right tabular-nums text-text-muted">{dec(v.surveyed_sqkm)}</TD>
                  <TD>
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="text-sm text-text">{v.position_label}</span>
                      {v.on_hold ? <Badge tone="warning" size="sm">on hold</Badge> : null}
                      {v.in_rework ? <Badge tone="warning" size="sm">rework</Badge> : null}
                      {v.position !== 'NOT_STARTED' && v.gcp_count === 0
                        ? <Badge tone="danger" size="sm">no GCP</Badge> : null}
                    </span>
                  </TD>
                  <TD className="text-right tabular-nums">
                    {v.days_in_stage === null ? '—' : num(v.days_in_stage)}
                  </TD>
                  {canDrill ? (
                    <TD className="text-text-muted">
                      {(v.holders ?? []).length === 0
                        ? <span className="text-2xs text-text-subtle">nobody</span>
                        : (v.holders ?? []).slice(0, 2).join(', ')
                          + ((v.holders ?? []).length > 2
                            ? ` +${(v.holders ?? []).length - 2}` : '')}
                    </TD>
                  ) : null}
                  {/* Days in the stage it is at now, counted to today while open. */}
                  <TD className="text-right tabular-nums">
                    {v.days_in_stage === null ? '—' : num(v.days_in_stage)}
                  </TD>
                  {canDrill ? (
                    <TD className="text-text-muted">
                      {(v.holders ?? []).length === 0
                        ? <span className="text-2xs text-text-subtle">nobody</span>
                        : (v.holders ?? []).slice(0, 2).join(', ')
                          + ((v.holders ?? []).length > 2
                            ? ` +${(v.holders ?? []).length - 2}` : '')}
                    </TD>
                  ) : null}
                  <TD>
                    {v.slip_note === null ? (
                      <span className="text-2xs text-text-subtle">no dates set</span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">
                        <span className={`text-sm ${
                          (v.slip_days ?? 0) > 0 ? 'text-danger' : 'text-text-muted'}`}>
                          {v.slip_note}
                        </span>
                        {v.slip_stage ? (
                          <span className="text-2xs text-text-subtle">
                            ({v.slip_stage.replace(/_/g, ' ').toLowerCase()})
                          </span>
                        ) : null}
                        {v.slip_reason ? (
                          <Badge tone="neutral" size="sm">
                            {v.slip_reason.replace(/_/g, ' ').toLowerCase()}
                          </Badge>
                        ) : v.slip_needs_reason ? (
                          <Badge tone="warning" size="sm">reason not given</Badge>
                        ) : null}
                      </span>
                    )}
                  </TD>
                  <TD className="tabular-nums text-text-muted">{v.gt_started_on ?? '—'}</TD>
                  <TD className="tabular-nums text-text-muted">{v.gt_expected_end_on ?? '—'}</TD>
                  {/* What actually happened, beside what was promised. */}
                  <TD className={`tabular-nums ${
                    v.gt_completed_on && v.gt_expected_end_on
                      && v.gt_completed_on > v.gt_expected_end_on
                      ? 'text-danger' : 'text-text-muted'}`}>
                    {v.gt_completed_on ?? '—'}
                  </TD>
                  {/* What actually happened, beside what was promised. */}
                  <TD className={`tabular-nums ${
                    v.gt_completed_on && v.gt_expected_end_on
                      && v.gt_completed_on > v.gt_expected_end_on
                      ? 'text-danger' : 'text-text-muted'}`}>
                    {v.gt_completed_on ?? '—'}
                  </TD>
                </TR>
              ))}
              {d.villages.length === 0 ? (
                <TR><TD colSpan={canDrill ? 14 : 12} className="py-6 text-center text-sm text-text-muted">
                  No villages match these filters.
                </TD></TR>
              ) : null}
            </TBody>
          </Table>
        </TableWrap>
      </Card>
    </div>
  );
}

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

interface Rung { key: string; label: string }
interface Unit { id: string; name: string }

interface DashboardRow {
  id: string | null;
  name: string;
  villages: number;
  extent_ac: number;
  extent_sqkm: number;
  surveyed_ac: number;
  by_position: Record<string, number>;
  completed: number;
  not_started: number;
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
  gcp_count: number;
}

interface DashboardData {
  project: { id: string; name: string; code: string | null };
  period: { from: string | null; to: string };
  level: string;
  filter: {
    district: string | null; mandal: string | null; position: string | null;
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
  };
  rows: DashboardRow[];
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
function rungTone(index: number, total: number): string {
  if (index === 0) return 'bg-neutral-400/70 dark:bg-neutral-500/70';
  const share = index / Math.max(1, total - 1);
  if (share < 0.3) return 'bg-sky-500/80';
  if (share < 0.6) return 'bg-indigo-500/80';
  if (share < 0.9) return 'bg-emerald-500/75';
  return 'bg-emerald-600';
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
  const sel = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  const query = useQuery({
    queryKey: ['survey', 'dashboard', projectId, from, to, level, district, mandal, position],
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/projects/${projectId}/dashboard`
      + `?level=${encodeURIComponent(level)}`
      + (from ? `&from=${from}` : '') + (to ? `&to=${to}` : '')
      + (district ? `&district=${encodeURIComponent(district)}` : '')
      + (mandal ? `&mandal=${encodeURIComponent(mandal)}` : '')
      + (position ? `&position=${encodeURIComponent(position)}` : ''),
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
      { header: 'Surveyed (Ac)', width: 13 }, { header: 'Status', width: 28 },
      { header: 'On hold', width: 9 }, { header: 'In rework', width: 10 },
      { header: 'GT started', width: 12 }, { header: 'GT expected end', width: 15 },
      { header: 'Control points', width: 13 },
    ],
    rows: (d?.villages ?? []).map((v: DashboardVillage) => [
      v.name, v.code ?? '', v.district ?? '', v.mandal ?? '',
      dec(v.extent_ac), dec(v.extent_sqkm), dec(v.surveyed_ac),
      v.position_label,
      v.on_hold ? 'yes' : '', v.in_rework ? 'yes' : '',
      v.gt_started_on ?? '', v.gt_expected_end_on ?? '', String(v.gcp_count),
    ]),
  }), [d, totals, district, mandal, position, ladder]);

  if (query.isLoading) return <Skeleton className="h-96" />;
  if (query.isError) {
    return <ErrorCard title="The dashboard could not be loaded" error={query.error} onRetry={() => query.refetch()} />;
  }
  if (!d || !totals) return <EmptyState title="Nothing to show yet" />;

  const maxRung = Math.max(1, ...ladder.map((r: Rung) => totals.by_position[r.key] ?? 0));
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
      </Card>

      {/* ------------------------------------------------------- the headline */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Villages" value={num(totals.villages)}
          explain="Every village in this programme, after the filters above." />
        <Stat label="Extent to survey" value={`${dec(totals.extent_ac)} Ac`}
          hint={`${dec(totals.extent_sqkm)} km²`}
          explain="The total extent of the villages shown. One acre is 0.00404686 km²." />
        <Stat label="Surveyed" value={`${dec(totals.surveyed_ac)} Ac`}
          hint={surveyedPct === null ? undefined : `${surveyedPct}% of extent`}
          explain={d.period.from
            ? 'Extent recorded between the two dates above.'
            : 'Extent recorded up to the date above.'} />
        <Stat label="Villages finished" value={`${num(finished)} of ${num(totals.villages)}`}
          tone={finished > 0 ? 'success' : 'default'}
          explain="Final deliverables approved by the department." />
      </div>

      {/* ------------------------------------------------ the eleven positions */}
      <Card className="p-4">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">Where every village has got to</h3>
          <span className="text-2xs text-text-subtle">
            One village counted once. Select a row to filter everything below.
          </span>
        </div>
        <ul className="space-y-1">
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
                  onClick={() => setPosition(selected ? '' : rung.key)}
                  className={`flex w-full items-center gap-3 rounded px-2 py-1.5 text-left transition
                    hover:bg-surface-sunken ${selected ? 'bg-surface-sunken ring-1 ring-border' : ''}`}
                >
                  <span className="w-56 shrink-0 truncate text-sm text-text">{rung.label}</span>
                  <span className="relative h-5 flex-1 overflow-hidden rounded bg-surface-sunken">
                    <span
                      className={`absolute inset-y-0 left-0 rounded ${rungTone(i, ladder.length)}`}
                      style={{ width: `${(count / maxRung) * 100}%` }}
                    />
                  </span>
                  <span className="w-28 shrink-0 text-right text-sm tabular-nums text-text">
                    {num(count)}
                    <span className="ml-1.5 text-2xs text-text-subtle">{share}%</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {/*
          * Reported beside the ladder rather than as extra rungs. Each is
          * something true *about* a village at a position; making them
          * positions would mean a village counted twice, and the eleven
          * would stop adding up to the total.
          */}
        {(totals.on_hold > 0 || totals.in_rework > 0 || totals.gcp_missing > 0) ? (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
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
        ) : null}
      </Card>

      {/* -------------------------------------------------------- the roll-up */}
      <Card className="p-0">
        <div className="flex items-baseline justify-between gap-2 px-4 py-3">
          <h3 className="text-sm font-semibold text-text">
            By {level}
          </h3>
          <span className="text-2xs text-text-subtle">
            {level === 'mandal' ? 'Select a mandal to see its villages'
              : 'Group by mandal to go a level deeper'}
          </span>
        </div>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>{level[0].toUpperCase() + level.slice(1)}</TH>
                <TH className="text-right">Villages</TH>
                <TH className="text-right">Extent (Ac)</TH>
                <TH className="text-right">Surveyed (Ac)</TH>
                <TH className="text-right">Not started</TH>
                <TH className="text-right">Finished</TH>
                <TH>Spread</TH>
              </TR>
            </THead>
            <TBody>
              {d.rows.map((row: DashboardRow) => (
                <TR key={row.id ?? '__none__'}>
                  <TD>
                    {row.id && level !== 'mandal' ? (
                      <button type="button"
                        className="text-left text-primary underline-offset-2 hover:underline"
                        onClick={() => {
                          if (level === 'district') { setDistrict(row.id!); setLevel('mandal'); }
                        }}>
                        {row.name}
                      </button>
                    ) : row.id && level === 'mandal' ? (
                      <button type="button"
                        className="text-left text-primary underline-offset-2 hover:underline"
                        onClick={() => setMandal(row.id!)}>
                        {row.name}
                      </button>
                    ) : row.name}
                  </TD>
                  <TD className="text-right tabular-nums">{num(row.villages)}</TD>
                  <TD className="text-right tabular-nums">{dec(row.extent_ac)}</TD>
                  <TD className="text-right tabular-nums">{dec(row.surveyed_ac)}</TD>
                  <TD className="text-right tabular-nums">{num(row.not_started)}</TD>
                  <TD className="text-right tabular-nums">{num(row.completed)}</TD>
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
              {d.rows.length === 0 ? (
                <TR><TD colSpan={7} className="py-6 text-center text-sm text-text-muted">
                  No villages match these filters.
                </TD></TR>
              ) : null}
            </TBody>
          </Table>
        </TableWrap>
      </Card>

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
                <TH className="text-right">Surveyed (Ac)</TH>
                <TH>Status</TH>
                <TH>GT started</TH>
                <TH>Expected end</TH>
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
                  <TD className="text-right tabular-nums">{dec(v.surveyed_ac)}</TD>
                  <TD>
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="text-sm text-text">{v.position_label}</span>
                      {v.on_hold ? <Badge tone="warning" size="sm">on hold</Badge> : null}
                      {v.in_rework ? <Badge tone="warning" size="sm">rework</Badge> : null}
                      {v.position !== 'NOT_STARTED' && v.gcp_count === 0
                        ? <Badge tone="danger" size="sm">no GCP</Badge> : null}
                    </span>
                  </TD>
                  <TD className="tabular-nums text-text-muted">{v.gt_started_on ?? '—'}</TD>
                  <TD className="tabular-nums text-text-muted">{v.gt_expected_end_on ?? '—'}</TD>
                </TR>
              ))}
              {d.villages.length === 0 ? (
                <TR><TD colSpan={8} className="py-6 text-center text-sm text-text-muted">
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

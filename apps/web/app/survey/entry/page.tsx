'use client';

import Link from 'next/link';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { stageTracksStaffing } from '@silverline/shared';
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
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { day, businessToday } from '@/lib/finance';
import {
  DELAY_REASON_OPTIONS, VILLAGE_STATE_LABELS, acres, count, groupMeasures, pct, stateTone,
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

  const today = React.useMemo(() => businessToday(), []);
  const [projectId, setProjectId] = React.useState('');
  const [villageId, setVillageId] = React.useState('');
  const [date, setDate] = React.useState(today);
  const [deployed, setDeployed] = React.useState({ teams: 0, base: 0, rovers: 0 });
  /*
   * Who was actually in the village today (§067).
   *
   * Ground truthing is walked with the department's people, and the days
   * they do not come are days our crew is paid to stand in a field. Held as
   * strings rather than numbers so that blank stays blank: nobody was asked
   * and nobody came are different answers, and only one of them is a finding.
   */
  const [attendance, setAttendance] = React.useState({ govt: '', crew: '' });
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState('');
  // One row per rover allocated to this village. The specification asks for
  // the update to be against each rover, and an idle one must say why.
  const [roverDays, setRoverDays] = React.useState<Record<string, {
    status: 'UTILIZED' | 'IDLE'; idle_reason: string; remarks: string;
  }>>({});
  const [lowReason, setLowReason] = React.useState('');
  /*
   * Why ground truthing has run past its date (§081).
   *
   * The server refuses the day until somebody says. Asked here rather than
   * discovered through a rejection, because whoever is filing the day knows
   * the answer and is already at the keyboard.
   */
  const [gtReason, setGtReason] = React.useState('');
  const [gtRemarks, setGtRemarks] = React.useState('');
  const [lowRemarks, setLowRemarks] = React.useState('');
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

  // The instruments out on this village, so the form lists the real ones
  // rather than asking somebody to remember which.
  const rovers = useQuery({
    queryKey: ['survey-rovers', villageId],
    enabled: canEnter && !!villageId,
    queryFn: async () =>
      ((await apiRequestRaw(
        `/api/v1/survey/villages/${villageId}/rovers`)).body as { data: Row[] }).data,
  });
  /*
   * Only the survey instruments, not everything the crew is carrying.
   *
   * Kit follows the person it is issued to, so a village's allocation picks
   * up tripods, radios, laptops and — on this data — a welding set. Asking a
   * crew to mark a welding set "in use or idle" every evening is noise that
   * teaches them to click through the whole section.
   */
  const outToday: Row[] = (rovers.data ?? [])
    .filter((r) => r.out && String(r.category ?? '').toUpperCase() === 'SURVEY');
  const otherKitOut = (rovers.data ?? [])
    .filter((r) => r.out && String(r.category ?? '').toUpperCase() !== 'SURVEY').length;

  React.useEffect(() => {
    // Default every allocated rover to "in use". The common day is that they
    // all worked, and a form that starts with everything idle trains people
    // to click past it.
    const next: typeof roverDays = {};
    for (const r of outToday) {
      next[String(r.asset_id)] = roverDays[String(r.asset_id)]
        ?? { status: 'UTILIZED', idle_reason: '', remarks: '' };
    }
    setRoverDays(next);
  }, [villageId, rovers.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const measures: Row[] = catalogue.data?.measures ?? [];
  const groups = groupMeasures(measures as Array<{ code: string; group_label?: string | null; label: string }>);

  /**
   * What the total becomes once today is filed.
   *
   * The form used to show only what was already recorded, so somebody typing
   * today's figure had to add it up in their head to know where the village
   * would stand — which is exactly the sum the workbook asked them to do and
   * the reason it was so often wrong. Still derived, still not typed: the
   * number moves as they type and is never sent.
   */
  const cumulativeOf = React.useCallback((code: string): number => {
    const before = Number(village?.done?.[code] ?? 0);
    const today = Number(values[code]);
    return before + (Number.isFinite(today) ? today : 0);
  }, [village, values]);

  /**
   * Every extent measure added together, cumulative.
   *
   * The village's own headline: acres surveyed across government land,
   * private land and the rest. Each measure answers for its own category and
   * nobody could see the one figure the programme is actually reported on.
   */
  const extentSurveyed = React.useMemo(() => {
    return measures
      .filter((m) => String(m.basis) === 'EXTENT')
      .reduce((total, m) => total + cumulativeOf(String(m.code)), 0);
  }, [measures, cumulativeOf]);

  const extentTarget = Number(village?.total_extent_ac ?? 0);

  /*
   * The day's acres used to be counted twice — once per rover and once in the
   * measures — and the two were compared here.
   *
   * The per-rover figure is gone. One return covers a village-day and
   * several instruments work it together, so nobody ever knew which rover
   * had covered which acres: the split was invented at the keyboard and then
   * carried downstream as though it had been measured. A cross-check against
   * a number somebody made up is not a cross-check.
   */

  // Prefill the crew and instruments from the village's allotment: the same
  // numbers most days, and retyping them is how they end up wrong.
  React.useEffect(() => {
    if (village) {
      // Rovers are not prefilled from the work list: they are counted from
      // the allocations below. Setting them here as well would clobber that
      // count whenever the village record happened to arrive second.
      setDeployed((d) => ({
        ...d,
        teams: Number(village.teams ?? 0),
        base: Number(village.dgps_base ?? 0),
      }));
    }
  }, [villageId]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * The rover count is the rovers assigned to this village.
   *
   * The village record carries a planned figure from the work list, and the
   * allocations carry what is actually out there. Where they disagree the
   * allocations are right — they are the instruments this return is about to
   * account for, one by one, below. Reporting a different number alongside
   * them makes the utilisation figures answer a question nobody asked.
   */
  const roverCountTouched = React.useRef(false);
  React.useEffect(() => {
    // Prefill, once per village. Re-running it on every render of the
    // allocation list would overwrite a number somebody had just typed.
    roverCountTouched.current = false;
  }, [villageId]);
  React.useEffect(() => {
    if (roverCountTouched.current) return;
    setDeployed((d) => (d.rovers === outToday.length ? d : { ...d, rovers: outToday.length }));
  }, [villageId, rovers.data, outToday.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
          rovers: Object.entries(roverDays).map(([asset_id, r]) => ({
            asset_id,
            status: r.status,
            idle_reason: r.status === 'IDLE' ? (r.idle_reason || undefined) : undefined,
            remarks: r.remarks || undefined,
            // Not collected any more: one return covers the village-day and
            // several instruments work it together.
          })),
          low_progress_reason: lowReason || undefined,
          gt_variance_reason: gtReason || undefined,
          gt_variance_remarks: gtReason && gtRemarks.trim() ? gtRemarks.trim() : undefined,
          low_progress_remarks: lowRemarks || undefined,
          // Blank stays blank. Sending 0 for "not asked" would manufacture
          // an absence out of a question nobody put.
          govt_staff_present: attendance.govt === '' ? undefined : Number(attendance.govt),
          crew_present: attendance.crew === '' ? undefined : Number(attendance.crew),
        },
      });
    },
    onSuccess: () => {
      setSaved(`${village?.village_name ?? 'Village'} — ${day(date)}`);
      setValues({});
      setNotes('');
      setAttendance({ govt: '', crew: '' });
      setLowReason('');
      setLowRemarks('');
      qc.invalidateQueries({ queryKey: ['survey-villages'] });
      qc.invalidateQueries({ queryKey: ['survey-progress'] });
      /*
       * And the list of what is already recorded.
       *
       * It was left stale, so a day just filed did not appear below and the
       * screen looked as though nothing had happened — which is why people
       * pressed Save again and got told the day was already recorded. The
       * entry was there the whole time; the page had simply not looked.
       */
      qc.invalidateQueries({ queryKey: ['survey-entries', villageId] });
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
          <Link href="/survey" className="ml-auto">
            <Button type="button" variant="ghost">Back to progress</Button>
          </Link>
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

          {/*
            * Who turned up, on both sides (§067).
            *
            * Only while ground truthing is running: no other stage is walked
            * with the department, and asking on the rest collects figures
            * that mean nothing. The allocation sits beside the box so the
            * number being typed has something to be measured against.
            */}
          {village && stageTracksStaffing('GROUND_TRUTHING')
            && String(village.stages?.GROUND_TRUTHING ?? 'NOT_STARTED') === 'IN_PROGRESS' ? (
            <Card className="space-y-2 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-text">Who was in the village today</h3>
                <span className="text-2xs text-text-subtle">
                  Agreed with the mandal:{' '}
                  {village.gt_govt_staff_allocated ?? '—'} government staff,{' '}
                  {village.gt_crew_allocated ?? '—'} of our crew
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-2xs uppercase tracking-wide text-text-subtle">
                    Government staff present
                  </span>
                  <input type="number" min={0} className={field} value={attendance.govt}
                    placeholder={village.gt_govt_staff_allocated != null
                      ? String(village.gt_govt_staff_allocated) : ''}
                    onChange={(e) => setAttendance({ ...attendance, govt: e.target.value })} />
                </label>
                <label className="space-y-1">
                  <span className="text-2xs uppercase tracking-wide text-text-subtle">
                    Our crew present
                  </span>
                  <input type="number" min={0} className={field} value={attendance.crew}
                    placeholder={village.gt_crew_allocated != null
                      ? String(village.gt_crew_allocated) : ''}
                    onChange={(e) => setAttendance({ ...attendance, crew: e.target.value })} />
                </label>
              </div>
              {attendance.govt !== '' && village.gt_govt_staff_allocated != null
                && Number(attendance.govt) < Number(village.gt_govt_staff_allocated) ? (
                <Notice tone="warning"
                  title={Number(attendance.govt) === 0
                    ? 'The department sent nobody today'
                    : `${Number(village.gt_govt_staff_allocated) - Number(attendance.govt)} short of the agreed strength`}>
                  {/* The number on its own reads as neutral. Said plainly it
                      is what a supervisor raises with the mandal, and it is
                      what the month's report will total up. */}
                  Recorded and counted. If it held up the day’s work, say so in the
                  reason below so the two sit together on the record.
                </Notice>
              ) : null}
              <p className="text-2xs text-text-subtle">
                Leave blank if nobody was counted. Zero means nobody came, which is a
                different thing and is reported as one.
              </p>
            </Card>
          ) : null}

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
                {/*
                  * Rovers on the day's return are the rovers allocated to this
                  * village, not a number somebody types.
                  *
                  * It used to be typed, and a typed count drifts from the
                  * allocation the moment either changes — which makes the
                  * utilisation figures answer a question nobody asked. The
                  * instruments are named one by one below; this is how many
                  * of them there are.
                  */}
                {/*
                  * Counted from the allocations, and still editable.
                  *
                  * The count is prefilled from the instruments actually out on
                  * this village, because that is right almost every day and
                  * retyping it is how it goes wrong. But the field has to give:
                  * an instrument arrives late, one goes back early, and a form
                  * that refuses to record what happened sends the correction
                  * into a spreadsheet instead. It says when it no longer agrees
                  * with the allocations rather than quietly disagreeing.
                  */}
                <label className="space-y-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-2xs uppercase tracking-wide text-text-subtle">
                      Rovers out today
                    </span>
                    <span className="text-2xs text-text-subtle"
                      title="Prefilled from the rovers allocated to this village. Change it if the day was different.">
                      {deployed.rovers === outToday.length
                        ? 'from the allocations'
                        : `allocated: ${outToday.length}`}
                    </span>
                  </span>
                  <input
                    type="number" min={0} className={field} value={deployed.rovers}
                    onChange={(e) => {
                      roverCountTouched.current = true;
                      setDeployed({
                        ...deployed, rovers: Math.max(0, Number(e.target.value) || 0),
                      });
                    }}
                  />
                </label>
              </div>

              {outToday.length > 0 ? (
                <section className="rounded-lg border border-border bg-surface-sunken p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-xs font-semibold text-text">
                      Rovers out on this village
                    </h3>
                    <span className="text-2xs text-text-subtle">
                      An idle rover has to say why — that is what makes the idle count useful.
                    </span>
                    {/*
                      * What was covered is entered once, in the measures
                      * below, for the whole village-day. Splitting it per
                      * rover asked for a number nobody has: one return
                      * covers the day and several instruments worked it
                      * together, so the split was invented at the keyboard
                      * and then reported as if it had been measured.
                      */}
                    {otherKitOut > 0 ? (
                      <span className="w-full text-2xs text-text-subtle">
                        {otherKitOut} other item(s) of kit are out on this village and are
                        not accounted for here — only survey instruments are.
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 space-y-2">
                    {outToday.map((r) => {
                      const key = String(r.asset_id);
                      const row = roverDays[key] ?? {
                        status: 'UTILIZED' as const, idle_reason: '', remarks: '',
                      };
                      const set = (patch: Partial<typeof row>) =>
                        setRoverDays({ ...roverDays, [key]: { ...row, ...patch } });
                      return (
                        <div key={key}
                          className="rounded-md border border-border bg-surface px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {/* The instrument opens its own record: "which
                                rover is AST-114 again" is a question asked in
                                the middle of filing a return. */}
                            <Link href={`/assets?q=${encodeURIComponent(String(r.asset_code))}`}
                              className="text-sm font-medium text-text underline-offset-2 hover:text-primary hover:underline">
                              {r.asset_name}
                            </Link>
                            <span className="font-mono text-2xs text-text-subtle">
                              {r.asset_code}
                            </span>
                            <div className="ml-auto flex gap-1">
                              {(['UTILIZED', 'IDLE'] as const).map((st) => (
                                <Button key={st} type="button"
                                  variant={row.status === st ? 'secondary' : 'ghost'}
                                  onClick={() => set({
                                    status: st,
                                    // Clearing the reason on the way back to
                                    // "in use": a rover in use carrying an
                                    // idle reason is refused by the server.
                                    idle_reason: st === 'UTILIZED' ? '' : row.idle_reason,
                                  })}>
                                  {st === 'UTILIZED' ? 'In use' : 'Idle'}
                                </Button>
                              ))}
                            </div>
                          </div>

                          {row.status === 'UTILIZED' ? null : (
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <select
                                className={field}
                                value={row.idle_reason}
                                onChange={(e) => set({ idle_reason: e.target.value })}>
                                <option value="">Why was it idle?</option>
                                {DELAY_REASON_OPTIONS.map((o) => (
                                  <option key={o.code} value={o.code}>{o.label}</option>
                                ))}
                              </select>
                              {row.idle_reason === 'OTHER' ? (
                                <input className={field} value={row.remarks}
                                  placeholder="What happened?"
                                  onChange={(e) => set({ remarks: e.target.value })} />
                              ) : null}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <p className="text-2xs text-text-subtle">
                  No rovers are allocated to this village, so there is nothing to account for.
                  Allocate them from the{' '}
                  {/* Straight to this village, not to a list they would have
                      to search again — they are here because of this one. */}
                  <a
                    className="font-medium text-primary underline underline-offset-2 hover:no-underline"
                    href={`/survey?tab=villages&project=${projectId}&village=${villageId}`}
                  >
                    village screen
                  </a>.
                </p>
              )}

              {/*
                * Where the village stands once today is filed.
                *
                * Every extent measure added together against the extent the
                * village has to cover. Each measure answers for its own
                * category; this is the one figure the programme is actually
                * reported on, and nobody could see it while entering.
                */}
              <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
                <span className="text-2xs uppercase tracking-wide text-text-subtle">
                  Extent surveyed
                </span>
                <span className="text-lg font-semibold tabular-nums text-text">
                  {acres(extentSurveyed)}
                  {extentTarget > 0 ? (
                    <span className="ml-1 text-2xs font-normal text-text-subtle">
                      of {acres(extentTarget)} · {pct((extentSurveyed / extentTarget) * 100)}
                    </span>
                  ) : null}
                </span>
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
                                thing nobody should be typing. Includes what
                                is in the box, so the figure on screen is where
                                the village stands once today is filed. */}
                            <span
                              className="text-2xs text-text-subtle"
                              title={`${count(done)} recorded before today, plus what you enter here`}
                            >
                              cumulative {count(cumulativeOf(m.code))}
                              {position && position.pct !== null ? ` · ${pct(position.pct)}` : ''}
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

              {/*
                * Demanded, not offered, and only while it is owed.
                *
                * Ground truthing past its date has to say why before another
                * day goes on it. Once the reason is on the stage this
                * disappears: the point is to get the explanation on file,
                * not to make somebody retype it every evening.
                */}
              {(() => {
                const gt = (village?.stage_dates as Record<string, Record<string, string | null>>
                  | undefined)?.GROUND_TRUTHING;
                return gt?.expectedEnd && !gt.varianceReason && !gt.completed
                  && String(gt.expectedEnd) < today;
              })() ? (
                  <div className="rounded-md border border-warning/40 bg-warning-subtle p-3">
                    <p className="text-sm font-medium text-text">
                      Ground truthing was due on {day(String(
                        (village?.stage_dates as Record<string, Record<string, string>>)
                          ?.GROUND_TRUTHING?.expectedEnd))}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      Say why before recording another day on this village. Asked once.
                    </p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <select className={field} value={gtReason}
                        onChange={(e) => setGtReason(e.target.value)}>
                        <option value="">Choose a reason…</option>
                        {DELAY_REASON_OPTIONS.map((o) => (
                          <option key={o.code} value={o.code}>{o.label}</option>
                        ))}
                      </select>
                      {gtReason === 'OTHER' ? (
                        <input className={field} value={gtRemarks}
                          placeholder="What happened?"
                          onChange={(e) => setGtRemarks(e.target.value)} />
                      ) : null}
                    </div>
                  </div>
                ) : null}

              {/* Offered rather than forced: the server decides whether the
                  day is below the programme's threshold, and says so if it
                  refuses. Asking here saves the round trip. */}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-2xs uppercase tracking-wide text-text-subtle">
                    If today was thin, why?
                  </span>
                  <select className={field} value={lowReason}
                    onChange={(e) => setLowReason(e.target.value)}>
                    <option value="">Not a low day</option>
                    {DELAY_REASON_OPTIONS.map((o) => (
                      <option key={o.code} value={o.code}>{o.label}</option>
                    ))}
                  </select>
                </label>
                {lowReason === 'OTHER' ? (
                  <label className="space-y-1">
                    <span className="text-2xs uppercase tracking-wide text-text-subtle">
                      What happened?
                    </span>
                    <input className={field} value={lowRemarks}
                      onChange={(e) => setLowRemarks(e.target.value)} />
                  </label>
                ) : null}
              </div>

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
  const [amending, setAmending] = React.useState<string | null>(null);
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
              {/* What the instruments did, not just how many were out. A day
                  where every rover sat idle read the same as a day they were
                  all working. */}
              <TH className="text-right">Rovers out</TH>
              <TH className="text-right">Used</TH>
              <TH className="text-right">Idle</TH>
              {codes.map((c) => (
                <TH key={c} className="text-right">{c.replaceAll('_', ' ').toLowerCase()}</TH>
              ))}
              <TH>Recorded by</TH>
              <TH>Notes</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD>{day(r.entry_date)}</TD>
                <TD className="text-right tabular-nums">{r.teams_deployed}</TD>
                <TD className="text-right tabular-nums">{count(Number(r.dgps_rovers ?? 0))}</TD>
                <TD className="text-right tabular-nums">{count(Number(r.rovers_used ?? 0))}</TD>
                <TD className={`text-right tabular-nums ${
                  Number(r.rovers_idle ?? 0) > 0 ? 'text-warning' : 'text-text-muted'}`}>
                  {count(Number(r.rovers_idle ?? 0))}
                </TD>
                {codes.map((c) => (
                  <TD key={c} className="text-right tabular-nums">
                    {r.values?.[c] ? count(Number(r.values[c])) : '—'}
                  </TD>
                ))}
                {/* The employee name, not the sign-in name. */}
                <TD tone="muted">{r.recorded_by_name ?? r.recorded_by}</TD>
                <TD tone="subtle">{r.notes ?? ''}</TD>
                <TD className="text-right">
                  <Button type="button" variant="ghost" size="sm"
                    onClick={() => setAmending(amending === String(r.id) ? null : String(r.id))}>
                    {amending === String(r.id) ? 'Close' : 'Amend'}
                  </Button>
                </TD>
              </TR>
            ))}
            {rows.filter((r) => String(r.id) === amending).map((r) => (
              <TR key={`amend-${r.id}`}>
                <TD colSpan={codes.length + 8}>
                  <AmendEntry
                    entry={r}
                    villageId={villageId}
                    onDone={() => setAmending(null)}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </section>
  );
}

/**
 * Correct a day already recorded (§note 15).
 *
 * A figure that cannot be corrected gets corrected anyway — in a spreadsheet
 * beside the system, which is where the two versions start to disagree. So
 * the correction happens here, and everything about it is written down: what
 * it was, what it became, who changed it and why.
 *
 * Today's return may be corrected by whoever recorded it. An earlier day
 * needs a programme manager, because by then the figure has been rolled up,
 * reported on and possibly billed.
 */
function AmendEntry({
  entry, villageId, onDone,
}: {
  entry: Row;
  villageId: string;
  onDone: () => void;
}) {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, 'survey.manage');
  const qc = useQueryClient();
  const toast = useToast();
  const isToday = String(entry.entry_date).slice(0, 10) === businessToday();
  const mayAmend = isToday || canManage;

  const existing = (entry.values ?? {}) as Record<string, number>;
  const [values, setValues] = React.useState<Record<string, string>>(
    Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, String(v)])),
  );
  const [teams, setTeams] = React.useState(String(entry.teams_deployed ?? 0));
  const [rovers, setRovers] = React.useState(String(entry.dgps_rovers ?? 0));
  const [notes, setNotes] = React.useState(String(entry.notes ?? ''));
  const [reason, setReason] = React.useState('');

  const amend = useMutation({
    mutationFn: async () => {
      const numeric: Record<string, number> = {};
      // Every measure is sent, including the ones set to nothing: a zero is
      // how the server is told to remove a figure that should not be there.
      for (const code of new Set([...Object.keys(existing), ...Object.keys(values)])) {
        const n = Number(values[code]);
        numeric[code] = Number.isFinite(n) ? n : 0;
      }
      return apiRequest(`/api/v1/survey/entries/${entry.id}`, {
        method: 'PATCH',
        headers: { 'X-Record-Version': String(entry.version ?? 1) },
        body: {
          teams_deployed: Number(teams) || 0,
          dgps_rovers: Number(rovers) || 0,
          notes: notes || null,
          values: numeric,
          amendment_reason: reason || undefined,
        },
      });
    },
    onError: (e) => toast.error('The day was not changed', messageOf(e)),
    onSuccess: () => {
      toast.success(`${day(entry.entry_date)} corrected`,
        'The change is on the audit trail with what it was before.');
      void qc.invalidateQueries({ queryKey: ['survey-entries', villageId] });
      void qc.invalidateQueries({ queryKey: ['survey-villages'] });
      void qc.invalidateQueries({ queryKey: ['survey-progress'] });
      onDone();
    },
  });

  const field = 'w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm text-text';

  if (!mayAmend) {
    return (
      <Notice tone="info" title="This day needs a programme manager">
        {day(entry.entry_date)} has already been rolled up and reported on. Correcting an
        earlier day is a decision about the record rather than a typo, so it is theirs to
        make — ask them, or record the difference on today.
      </Notice>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-3">
      <p className="text-xs text-text-muted">
        Correcting {day(entry.entry_date)}. What it was, what it becomes and who changed it
        are kept, so the figure can be answered for later.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Teams
          <input className={field} type="number" min={0} value={teams}
            onChange={(e) => setTeams(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Rovers out
          <input className={field} type="number" min={0} value={rovers}
            onChange={(e) => setRovers(e.target.value)} />
        </label>
        {Object.keys(existing).map((code) => (
          <label key={code} className="flex flex-col gap-1 text-2xs text-text-muted">
            {code.replaceAll('_', ' ').toLowerCase()}
            <input className={field} type="number" min={0} step="any"
              value={values[code] ?? ''}
              onChange={(e) => setValues({ ...values, [code]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 text-2xs text-text-muted">
          Notes
          <input className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-2xs text-text-muted">
          Why it changed
          <input
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
            placeholder="Miskeyed, re-measured, wrong village…"
            value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <Button type="button" disabled={amend.isPending} onClick={() => amend.mutate()}>
          Save the correction
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

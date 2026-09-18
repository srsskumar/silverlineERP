'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Combobox } from '@/components/ui/Combobox';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Notice } from '@/components/finance/Primitives';
import { day, businessToday } from '@/lib/finance';
import { STAGE_STATE_LABELS, stageLabel, stateTone } from '@/lib/survey';
import {
  MILESTONE_PERCENT, MILESTONE_LABELS, BILLING_STATUS_LABELS,
  billingDecisionRequired, stageTracksStaffing, milestoneEarned, milestoneBlockedNote,
  staffingNote, checkGcp, GCP_WARNING_NOTES, formatCoordinate,
  type BillingStatus, type GcpWarning,
} from '@silverline/shared';
import { ExportMenu } from '@/components/ui/ExportMenu';

type Row = Record<string, any>;

const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

const PAGE = 100;
const MAX_PAGES = 20;

/** The whole asset register, a page at a time. */
async function fetchAllAssets(): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0, offset = 0; page < MAX_PAGES; page += 1, offset += PAGE) {
    const body = (await apiRequestRaw(`/api/v1/assets?limit=${PAGE}&offset=${offset}`)).body as {
      data?: Row[]; has_more?: boolean;
    };
    out.push(...(body?.data ?? []));
    if (!body?.has_more) break;
  }
  return out;
}

/**
 * Everything about one village: its stages, its crew and its instruments.
 *
 * Opened from the village list rather than given its own route, because the
 * work is comparative — the question is nearly always "which of these is
 * stuck", and answering it means keeping the others on screen.
 */
export function VillageDetail({
  village, pipeline, canManage, canEnter, canCertify, openSection,
}: {
  village: Row;
  pipeline: Row[];
  canManage: boolean;
  canEnter: boolean;
  /** Closing out a finished village: team leads as well as managers. */
  canCertify: boolean;
  /**
   * Which part to bring into view on arrival.
   *
   * Somebody who picked "Assign crew" from the list has already said what
   * they came to do; making them find it again in an expanded panel is a
   * step that exists only because the software could not be bothered.
   */
  openSection?: 'stages' | 'crew' | 'rovers' | 'billing' | 'gcp' | null;
}) {
  const focus = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!openSection) return;
    // Waits a frame: the panel is being expanded in the same render, and
    // scrolling to an element that has not been laid out lands nowhere.
    const t = setTimeout(() => {
      focus.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
    return () => clearTimeout(t);
  }, [openSection]);

  const mark = (name: string) => (openSection === name
    ? { ref: focus, className: 'rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-surface-sunken' }
    : {});

  return (
    <div className="space-y-4 p-3">
      <div {...mark('stages')}>
        <StagePipeline village={village} pipeline={pipeline} canEnter={canEnter} />
      </div>
      {/*
        * Control points first (§069).
        *
        * Establishing them is the one-time job done *before* ground truthing
        * starts, so it belongs above the five panels about work that comes
        * after it. It was at the bottom and people could not find it.
        */}
      <div {...mark('gcp')}>
        <ControlPoints village={village} canManage={canManage} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div {...mark('crew')}>
          <Crew villageId={String(village.id)} pipeline={pipeline} canManage={canManage} />
        </div>
        <div {...mark('rovers')}>
          <Rovers villageId={String(village.id)} canManage={canManage} />
        </div>
        <CrewAssets villageId={String(village.id)} />
        <div {...mark('billing')}>
          <Billing village={village} pipeline={pipeline} canManage={canManage} />
        </div>
        <CertifiedTotals village={village} canCertify={canCertify} />
      </div>
      <DailySheet village={village} />
    </div>
  );
}

/* ---------------------------------------------------------------- stages */

/**
 * The stages in the order the work runs, with the remarks that explain them.
 *
 * A stage whose predecessor is unfinished is shown as blocked rather than
 * merely disabled: "waiting on ground truthing" is the answer to the question
 * somebody is actually asking.
 */
function StagePipeline({
  village, pipeline, canEnter,
}: {
  village: Row; pipeline: Row[]; canEnter: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<string | null>(null);
  const stages: Record<string, string> = village.stages ?? {};
  const dates: Record<string, Row> = village.stage_dates ?? {};

  const toast = useToast();
  const move = useMutation({
    mutationFn: async (v: Row) =>
      apiRequest(`/api/v1/survey/villages/${village.id}/stage`, { method: 'POST', body: v }),
    onError: (e) => toast.error('The stage was not changed', messageOf(e)),
    onSuccess: (_res, v: Row) => {
      toast.success(
        `${village.village_name ?? 'The village'} moved to ${String(v.stage_code ?? '').replace(/_/g, ' ').toLowerCase()}`,
        'The board and every roll-up above it now show the new stage.',
      );
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['survey-villages'] });
      qc.invalidateQueries({ queryKey: ['survey-progress'] });
      qc.invalidateQueries({ queryKey: ['survey-summary'] });
    },
  });

  const linked = Boolean(village.task_id);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Stages</h4>
        {linked ? (
          <span className="text-2xs text-text-subtle">
            On the task board — move the cards to change these.
          </span>
        ) : null}
      </div>

      <div className="mt-2 space-y-1.5">
        {pipeline.map((stage) => {
          const code = String(stage.code);
          const state = stages[code] ?? 'NOT_STARTED';
          const d = dates[code] ?? {};
          const blockedBy = stage.requires && stages[String(stage.requires)] !== 'COMPLETED'
            ? String(stage.requires) : null;

          return (
            <div key={code} className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={stateTone(state)}>{STAGE_STATE_LABELS[state] ?? state}</Badge>
                <span className="text-sm font-medium text-text">{stage.label}</span>
                {stage.tracks_daily_progress ? (
                  <span className="text-2xs text-text-subtle">daily progress recorded here</span>
                ) : null}

                {d.started || d.completed ? (
                  <span className="text-2xs text-text-subtle">
                    {d.started ? day(d.started) : '—'}
                    {d.completed ? ` → ${day(d.completed)}` : ''}
                  </span>
                ) : null}

                {blockedBy && state === 'NOT_STARTED' ? (
                  <span className="text-2xs text-warning">
                    waiting on {stageLabel(blockedBy, pipeline as any)}
                  </span>
                ) : null}

                {canEnter && !linked ? (
                  <Button type="button" variant="ghost" className="ml-auto"
                    onClick={() => setEditing(editing === code ? null : code)}>
                    {editing === code ? 'Cancel' : 'Update'}
                  </Button>
                ) : null}
              </div>

              {d.remarks ? (
                <p className="mt-1 text-xs text-text-muted">{d.remarks}</p>
              ) : null}

              {editing === code ? (
                <StageForm
                  stage={stage}
                  state={state}
                  dates={d}
                  village={village}
                  onSubmit={(v) => move.mutate({ stage_code: code, ...v })}
                  pending={move.isPending}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {move.isError ? <div className="mt-2"><ErrorCard error={move.error} /></div> : null}
    </section>
  );
}

function StageForm({
  stage, state, dates, village, onSubmit, pending,
}: {
  stage: Row; state: string; dates: Row; village: Row;
  onSubmit: (v: Row) => void; pending: boolean;
}) {
  const [form, setForm] = React.useState({
    state,
    started_on: dates.started ?? '',
    completed_on: dates.completed ?? '',
    remarks: dates.remarks ?? '',
    gt_govt_staff_allocated: village.gt_govt_staff_allocated != null
      ? String(village.gt_govt_staff_allocated) : '',
    gt_crew_allocated: village.gt_crew_allocated != null
      ? String(village.gt_crew_allocated) : '',
  });

  /*
   * Starting ground truthing means saying how it is staffed (§067).
   *
   * The one moment anybody knows the answer is now — the mandal has just
   * said how many of their people we get. Every day's attendance is measured
   * against these two numbers, and a village that started without them can
   * never show the days the department sent nobody.
   *
   * Asked only when starting, and only while the village has no figures: a
   * stage corrected six weeks later should not re-open a settled question.
   */
  const asksStaffing = stageTracksStaffing(String(stage.code))
    && form.state === 'IN_PROGRESS'
    && (village.gt_govt_staff_allocated == null || village.gt_crew_allocated == null);
  const staffingMissing = asksStaffing
    && (form.gt_govt_staff_allocated === '' || form.gt_crew_allocated === '');

  return (
    <div className="mt-2 grid gap-2 border-t border-border pt-2 sm:grid-cols-4">
      <label className="space-y-1">
        <span className="text-2xs uppercase tracking-wide text-text-subtle">State</span>
        <select className={field} value={form.state}
          onChange={(e) => setForm({ ...form, state: e.target.value })}>
          {Object.entries(STAGE_STATE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-2xs uppercase tracking-wide text-text-subtle">Started</span>
        <input type="date" className={field} value={form.started_on}
          onChange={(e) => setForm({ ...form, started_on: e.target.value })} />
      </label>
      <label className="space-y-1">
        <span className="text-2xs uppercase tracking-wide text-text-subtle">
          Completed {form.state === 'COMPLETED' ? <span className="text-danger">*</span> : null}
        </span>
        <input type="date" className={field} value={form.completed_on}
          onChange={(e) => setForm({ ...form, completed_on: e.target.value })} />
      </label>
      <label className="space-y-1 sm:col-span-4">
        <span className="text-2xs uppercase tracking-wide text-text-subtle">Remarks</span>
        {/* Why a village is stuck. "Two parcels disputed" is the reason it
            sits here for three weeks, and it belongs on the record. */}
        <input className={field} value={form.remarks} placeholder="Two parcels disputed"
          onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
      </label>
      {asksStaffing ? (
        <>
          <div className="sm:col-span-4">
            <Notice tone="info" title="How is this village staffed?">
              Ground truthing is walked with the department’s people. Recording what was
              agreed now is what lets every day’s attendance be measured against it — and
              what shows the days nobody from the mandal turned up.
            </Notice>
          </div>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">
              Government staff allotted <span className="text-danger">*</span>
            </span>
            <input type="number" min={0} className={field}
              value={form.gt_govt_staff_allocated} placeholder="2"
              onChange={(e) => setForm({ ...form, gt_govt_staff_allocated: e.target.value })} />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">
              Our crew allotted <span className="text-danger">*</span>
            </span>
            <input type="number" min={0} className={field}
              value={form.gt_crew_allocated} placeholder="4"
              onChange={(e) => setForm({ ...form, gt_crew_allocated: e.target.value })} />
          </label>
        </>
      ) : null}

      <div className="sm:col-span-4">
        <Button type="button" variant="primary" loading={pending}
          disabled={(form.state === 'COMPLETED' && !form.completed_on) || staffingMissing}
          onClick={() => onSubmit({
            state: form.state,
            started_on: form.started_on || undefined,
            completed_on: form.completed_on || undefined,
            remarks: form.remarks || undefined,
            ...(asksStaffing ? {
              gt_govt_staff_allocated: Number(form.gt_govt_staff_allocated),
              gt_crew_allocated: Number(form.gt_crew_allocated),
            } : {}),
          })}>
          Save {stage.label}
        </Button>
        {staffingMissing ? (
          <span className="ml-2 text-2xs text-text-subtle">
            Both staffing figures are needed to start ground truthing.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ crew */

/**
 * Who is on this village, by stage.
 *
 * Several people to one stage — the reason this is not the task's assignee.
 * Released members stay listed, faded: who surveyed a village last season is
 * a question somebody asks.
 */
function Crew({
  villageId, pipeline, canManage,
}: {
  villageId: string; pipeline: Row[]; canManage: boolean;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState({ employee_id: '', stage_code: '' });

  const crew = useQuery({
    queryKey: ['survey-crew', villageId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/survey/villages/${villageId}/crew`)).body as { data: Row[] }).data,
  });

  const people = useQuery({
    queryKey: ['employees', 'for-crew', 'active'],
    enabled: adding,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/employees?limit=100&status=ACTIVE')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  /*
   * Several people at once.
   *
   * A crew is four or five, and assigning them one form at a time is how the
   * fifth gets forgotten. Names are gathered into a basket first so the whole
   * crew goes on in one action, and somebody already on the stage is reported
   * rather than failing the rest.
   */
  const [basket, setBasket] = React.useState<Array<{ id: string; label: string }>>([]);
  const [outcome, setOutcome] = React.useState<string | null>(null);

  const toast = useToast();
  const assign = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/villages/${villageId}/crew/bulk`, {
        method: 'POST',
        body: { employee_ids: basket.map((b) => b.id), stage_code: form.stage_code },
      }),
    onSuccess: (res: any) => {
      const d = res?.data ?? {};
      setOutcome([
        d.assigned ? `${d.assigned} assigned` : '',
        d.already_assigned ? `${d.already_assigned} already on this stage` : '',
        d.refused ? `${d.refused} not active` : '',
        // Said out loud: somebody who expected to allocate the rovers needs
        // to know it has already happened.
        d.rovers_brought?.length
          ? `${d.rovers_brought.length} instrument(s) came with them`
          : '',
        d.rovers_left_elsewhere?.length
          ? `${d.rovers_left_elsewhere.length} left where they are, still out on another village`
          : '',
      ].filter(Boolean).join(', ') || 'Nothing to do');
      setBasket([]);
      setForm({ employee_id: '', stage_code: form.stage_code });
      qc.invalidateQueries({ queryKey: ['survey-crew', villageId] });
    },
  });

  const release = useMutation({
    mutationFn: async (id: string) =>
      apiRequest(`/api/v1/survey/crew/${id}/release`, { method: 'POST', body: {} }),
    onError: (e) => toast.error('They were not taken off the crew', messageOf(e)),
    onSuccess: () => {
      toast.success('Taken off this village',
        'Their earlier work on it stays on the record.');
      qc.invalidateQueries({ queryKey: ['survey-crew', villageId] });
    },
  });

  const rows: Row[] = crew.data ?? [];

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Crew</h4>
        {canManage ? (
          <Button type="button" variant="ghost" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Assign someone'}
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Combobox
              value=""
              onChange={(id) => {
                const person = (people.data ?? []).find((e) => String(e.id) === id);
                if (!person || basket.some((b) => b.id === id)) return;
                setBasket([...basket, {
                  id,
                  label: [person.first_name, person.last_name].filter(Boolean).join(' ')
                    || String(person.emp_no),
                }]);
                setOutcome(null);
              }}
              isLoading={people.isLoading}
              placeholder="Search the directory — add as many as you need…"
              options={(people.data ?? [])
                .filter((e) => !basket.some((b) => b.id === String(e.id)))
                .map((e) => ({
                  id: String(e.id),
                  label: [e.first_name, e.last_name].filter(Boolean).join(' ') || String(e.emp_no),
                  hint: String(e.emp_no ?? ''),
                }))}
            />
            {basket.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {basket.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBasket(basket.filter((x) => x.id !== b.id))}
                    className="rounded-full border border-border bg-surface px-2 py-0.5
                      text-2xs text-text hover:border-danger hover:text-danger"
                    title="Remove"
                  >
                    {b.label} ×
                  </button>
                ))}
              </div>
            ) : null}
            {outcome ? (
              <p className="mt-2 text-2xs text-text-muted">{outcome}</p>
            ) : null}
          </div>
          <select className={field} value={form.stage_code}
            onChange={(e) => setForm({ ...form, stage_code: e.target.value })}>
            <option value="">Which stage…</option>
            {pipeline.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
          <div className="sm:col-span-3">
            <Button type="button" variant="primary" loading={assign.isPending}
              disabled={basket.length === 0 || !form.stage_code}
              onClick={() => assign.mutate()}>
              {basket.length > 1
                ? `Add ${basket.length} to the crew`
                : 'Add to the crew'}
            </Button>
          </div>
          {assign.isError ? <div className="sm:col-span-3"><ErrorCard error={assign.error} /></div> : null}
        </div>
      ) : null}

      {crew.isLoading ? <Skeleton className="mt-2 h-16" /> : null}
      {rows.length === 0 && !crew.isLoading ? (
        <p className="mt-2 text-xs text-text-subtle">Nobody is assigned to this village yet.</p>
      ) : null}

      {rows.length ? (
        <ul className="mt-2 space-y-1">
          {rows.map((c) => (
            <li key={c.id}
              className={`flex flex-wrap items-center gap-2 text-xs ${c.active ? 'text-text' : 'text-text-subtle'}`}>
              <span className="font-medium">{c.employee_name}</span>
              {c.emp_no ? <span className="text-2xs text-text-subtle">{c.emp_no}</span> : null}
              <span className="text-2xs">{c.stage_label}</span>
              {c.active ? null : <Badge tone="neutral">released {day(c.released_on)}</Badge>}
              {canManage && c.active ? (
                <Button type="button" variant="ghost" className="ml-auto"
                  disabled={release.isPending} onClick={() => release.mutate(String(c.id))}>
                  Release
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------- equipment via the crew */

/**
 * Equipment that reached this village through the people working it.
 *
 * Two ways a thing can be here: allocated to the village — that is the rover
 * list, and what the daily return accounts for — or issued to somebody who is
 * on the crew, which is how a tripod, a radio and a battery usually travel:
 * signed out to a surveyor, not to a place.
 *
 * Shown apart from the allocations rather than merged into them, because the
 * distinction is real. Releasing the person from the village does not take
 * the equipment off them, and a daily return that counted these would be
 * counting instruments nobody allocated here.
 */
function CrewAssets({ villageId }: { villageId: string }) {
  const held = useQuery({
    queryKey: ['survey-crew-assets', villageId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/survey/villages/${villageId}/crew-assets`))
        .body as { data: Row[] }).data,
  });

  const rows: Row[] = held.data ?? [];
  if (rows.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Carried by the crew
      </h4>
      <p className="mt-1 text-2xs text-text-subtle">
        Issued to people working here, rather than allocated to the village. The daily return
        does not account for these — allocate one to the village if it should.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-2xs text-text-subtle">
              <th className="py-1 pr-3">Equipment</th>
              <th className="py-1 pr-3">Assigned to</th>
              <th className="py-1 pr-3">Phone</th>
              <th className="py-1 pr-3">Assigned on</th>
              <th className="py-1 pr-3">On stage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.assignment_id)} className="border-t border-border">
                <td className="py-1.5 pr-3 text-text">
                  {String(r.asset_code)}
                  <span className="ml-1 text-2xs text-text-subtle">
                    {String(r.type_label ?? r.asset_name ?? '')}
                  </span>
                  {r.also_allocated ? (
                    <span className="ml-1 text-2xs text-success">· also allocated here</span>
                  ) : null}
                </td>
                <td className="py-1.5 pr-3 text-text-muted">{String(r.employee_name)}</td>
                <td className="py-1.5 pr-3 text-text-muted">{String(r.phone ?? '—')}</td>
                <td className="py-1.5 pr-3 text-text-muted">{String(r.issued_at ?? '—')}</td>
                <td className="py-1.5 pr-3 text-text-muted">{String(r.stage_label ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- rovers */

/**
 * Which instruments are out on this village.
 *
 * Named from the asset register rather than counted, which is what makes the
 * idle figure on the dashboard something somebody can act on.
 */
function Rovers({ villageId, canManage }: { villageId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const today = businessToday();
  const [form, setForm] = React.useState({ asset_id: '', allocated_on: today });

  const rovers = useQuery({
    queryKey: ['survey-rovers', villageId],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/survey/villages/${villageId}/rovers`)).body as { data: Row[] }).data,
  });

  const assets = useQuery({
    queryKey: ['assets', 'survey'],
    enabled: adding,
    // Paged rather than asked for in one go: the server caps a page at 100,
    // and a picker that silently stops at the cap makes every instrument
    // after it unallocatable with nothing on screen to say so.
    queryFn: () => fetchAllAssets(),
    staleTime: 300_000,
  });

  /*
   * Several instruments at once.
   *
   * The kit goes out together — four rovers, a base, the radios — and doing
   * that one form at a time is four chances to stop after three. One already
   * out elsewhere is named and the rest still go: refusing the whole request
   * because one instrument is busy means redoing the others by hand.
   */
  const [basket, setBasket] = React.useState<Array<{ id: string; label: string }>>([]);
  const [clashes, setClashes] = React.useState<Array<Record<string, string>>>([]);

  const toast = useToast();
  const allocate = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/villages/${villageId}/rovers/bulk`, {
        method: 'POST',
        body: { asset_ids: basket.map((b) => b.id), allocated_on: form.allocated_on },
      }),
    onSuccess: (res: any) => {
      setClashes(res?.data?.clashes ?? []);
      setBasket([]);
      setForm({ asset_id: '', allocated_on: today });
      qc.invalidateQueries({ queryKey: ['survey-rovers', villageId] });
      qc.invalidateQueries({ queryKey: ['survey-progress'] });
    },
  });

  const release = useMutation({
    // Closes the existing allocation. Writing a second row with a release
    // date would double the instrument in the allocated total.
    mutationFn: async (row: Row) =>
      apiRequest(`/api/v1/survey/rovers/${row.id}/release`, {
        method: 'POST', body: { released_on: today },
      }),
    onError: (e) => toast.error('The equipment was not released', messageOf(e)),
    onSuccess: () => {
      toast.success('Released back to the store',
        'It is free to allocate to another village from today.');
      qc.invalidateQueries({ queryKey: ['survey-rovers', villageId] });
      qc.invalidateQueries({ queryKey: ['survey-progress'] });
    },
  });

  const rows: Row[] = rovers.data ?? [];
  // Survey instruments first; the register holds laptops and safety gear too.
  const candidates = (assets.data ?? []).filter(
    (a) => String(a.category ?? '').toUpperCase() === 'SURVEY');

  /*
   * Kit this village's crew hold that is somewhere else (§note 18).
   *
   * A rover follows the person it is issued to, so putting crew on a village
   * usually brings their instruments. Usually — one person is crew on
   * several villages at once and an instrument can only be in one place, so
   * the carry silently skips.
   *
   * The result was a village with four people on it and nothing allocated,
   * and nothing anywhere explaining why. The answer is never "the software
   * forgot"; it is "that rover is in Koyyuru until Thursday".
   */
  const gap = useQuery({
    queryKey: ['survey-kit-gap', villageId],
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/villages/${villageId}/kit-gap`)).body as { data: Row[] }).data,
  });
  const missing: Row[] = gap.data ?? [];

  const claim = useMutation({
    mutationFn: async (assetIds: string[]) =>
      apiRequest(`/api/v1/survey/villages/${villageId}/rovers/claim`, {
        method: 'POST', body: { asset_ids: assetIds },
      }),
    onError: (e) => toast.error('The instrument was not moved', messageOf(e)),
    onSuccess: (res: unknown) => {
      const d = ((res as { data?: Row }).data ?? {}) as Row;
      const late = (d.arriving as Row[] ?? []);
      toast.success(
        `${Number(d.brought)} instrument(s) moved here`,
        late.length > 0
          // A rover cannot leave a village before it got there, so one that
          // arrived this morning reaches the next village tomorrow.
          ? `${late.map((a) => `${String(a.asset_code)} arrives ${day(String(a.on))}`).join(', ')}`
          : 'Released from where it was, as of yesterday.',
      );
      qc.invalidateQueries({ queryKey: ['survey-rovers', villageId] });
      qc.invalidateQueries({ queryKey: ['survey-kit-gap'] });
      qc.invalidateQueries({ queryKey: ['survey-villages'] });
    },
  });

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Rovers and instruments
        </h4>
        {canManage ? (
          <Button type="button" variant="ghost" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Allocate instruments'}
          </Button>
        ) : null}
      </div>

      {missing.length > 0 ? (
        <div className="mt-2">
          <Notice tone={rows.length === 0 ? 'warning' : 'info'}
            title={rows.length === 0
              ? 'This village has crew but no instruments'
              : `${missing.length} more instrument(s) belong to this crew`}>
            <div className="space-y-1">
              <p>
                {/* Named, because "some kit is elsewhere" is not something
                    anybody can act on. */}
                An instrument follows the person it is issued to, and these are out
                on another village — one rover cannot be in two places.
              </p>
              <ul className="space-y-0.5">
                {missing.map((k) => (
                  <li key={String(k.asset_id)} className="flex flex-wrap items-center gap-1">
                    <span className="font-mono text-2xs">{String(k.asset_code)}</span>
                    <span className="text-2xs">
                      issued to {String(k.employee_name)} ·{' '}
                      {k.held_by_village_name
                        ? `with ${String(k.held_by_village_name)} since ${day(String(k.held_since))}`
                        : 'not allocated anywhere'}
                    </span>
                    {canManage ? (
                      <Button type="button" variant="ghost" loading={claim.isPending}
                        title={k.held_by_village_name
                          ? `Release it from ${String(k.held_by_village_name)} and bring it here`
                          : 'Allocate it to this village'}
                        onClick={() => claim.mutate([String(k.asset_id)])}>
                        Bring it here
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {canManage && missing.length > 1 ? (
                <Button type="button" variant="secondary" loading={claim.isPending}
                  onClick={() => claim.mutate(missing.map((k) => String(k.asset_id)))}>
                  Bring all {missing.length} here
                </Button>
              ) : null}
            </div>
          </Notice>
        </div>
      ) : null}


      {adding ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Combobox
              value=""
              onChange={(id) => {
                const a = (assets.data ?? []).find((x) => String(x.id) === id);
                if (!a || basket.some((b) => b.id === id)) return;
                setBasket([...basket, { id, label: String(a.name ?? a.asset_code) }]);
                setClashes([]);
              }}
              isLoading={assets.isLoading}
              placeholder="Search survey equipment — add as many as you need…"
              options={(candidates.length ? candidates : assets.data ?? [])
                .filter((a) => !basket.some((b) => b.id === String(a.id)))
                .map((a) => ({
                  id: String(a.id),
                  label: String(a.name ?? a.asset_code),
                  /* Where it already is, on the option itself: an instrument
                     that is out elsewhere can then be recognised before it is
                     picked, rather than after the server refuses it. */
                  hint: [
                    a.asset_code,
                    a.serial_number,
                    a.location === 'IN_FIELD' && a.held_by
                      ? `out with ${a.held_by}${a.held_for_project ? ` · ${a.held_for_project}` : ''}`
                      : '',
                  ].filter(Boolean).join(' · '),
                }))}
              emptyHint="Instruments in the asset register, category SURVEY"
            />
            {basket.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {basket.map((b) => (
                  <button key={b.id} type="button"
                    onClick={() => setBasket(basket.filter((x) => x.id !== b.id))}
                    className="rounded-full border border-border bg-surface px-2 py-0.5
                      text-2xs text-text hover:border-danger hover:text-danger"
                    title="Remove">
                    {b.label} ×
                  </button>
                ))}
              </div>
            ) : null}
            {clashes.length > 0 ? (
              <p className="mt-2 text-2xs text-warning">
                {clashes.map((c) => `${c.asset_code} is already out on ${c.with_village}`)
                  .join('; ')}. The rest were allocated.
              </p>
            ) : null}
          </div>
          <input type="date" className={field} value={form.allocated_on}
            onChange={(e) => setForm({ ...form, allocated_on: e.target.value })} />
          <div className="sm:col-span-3">
            <Button type="button" variant="primary" loading={allocate.isPending}
              disabled={basket.length === 0} onClick={() => allocate.mutate()}>
              {basket.length > 1 ? `Allocate ${basket.length}` : 'Allocate'}
            </Button>
          </div>
          {allocate.isError ? (
            <div className="sm:col-span-3">
              {/* The server refuses an instrument already out elsewhere, and
                  says which action clears it. */}
              <ErrorCard error={allocate.error} />
            </div>
          ) : null}
        </div>
      ) : null}

      {rovers.isLoading ? <Skeleton className="mt-2 h-16" /> : null}
      {rows.length === 0 && !rovers.isLoading ? (
        <p className="mt-2 text-xs text-text-subtle">
          No instruments allocated. Without them the idle count on the dashboard has nothing to
          measure against.
        </p>
      ) : null}

      {rows.length ? (
        <TableWrap className="mt-2">
          <Table>
            <THead>
              <TR><TH>Instrument</TH><TH>Out</TH><TH>Back</TH>{canManage ? <TH /> : null}</TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <span className="text-text">{r.asset_name}</span>
                    <span className="ml-1 text-2xs text-text-subtle">{r.asset_code}</span>
                  </TD>
                  <TD className="text-xs">{day(r.allocated_on)}</TD>
                  <TD className="text-xs">
                    {r.released_on ? day(r.released_on) : <Badge tone="warning">still out</Badge>}
                  </TD>
                  {canManage ? (
                    <TD className="text-right">
                      {r.out ? (
                        <Button type="button" variant="ghost" disabled={release.isPending}
                          onClick={() => release.mutate(r)}>
                          Mark returned
                        </Button>
                      ) : null}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      ) : null}
    </section>
  );
}


/* ---------------------------------------------------------------- billing */

/**
 * What has been claimed against this village (§066).
 *
 * The contract releases a village's value in three claims — half at ground
 * truthing, thirty per cent at records, the rest on final submission — and
 * which villages sit at which claim is the question the office asks before
 * every review. It was answered out of a spreadsheet kept beside the system.
 *
 * A claim is a record of something somebody did: a covering letter that went
 * to the department on a date under a file number. It is not inferred from
 * the stages, because a village can be finished for weeks before anybody
 * raises the claim, and pretending otherwise would bill work that has not
 * been submitted.
 */
function Billing({
  village, pipeline, canManage,
}: { village: Row; pipeline: Row[]; canManage: boolean }) {
  const villageId = String(village.id);
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const blank = {
    milestone: '1', submitted_on: businessToday(), reference_no: '', extent_ac: '', remarks: '',
  };
  const [form, setForm] = React.useState(blank);

  const claims = useQuery({
    queryKey: ['survey-billing', villageId],
    queryFn: async () => (await apiRequestRaw(
      `/api/v1/survey/villages/${villageId}/billing`)).body as { data: Row[]; meta?: Row },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['survey-billing', villageId] });
    // The village list carries the claimed share, so it goes stale too.
    qc.invalidateQueries({ queryKey: ['survey-villages'] });
  };

  const submit = useMutation({
    mutationFn: async () => apiRequest(`/api/v1/survey/villages/${villageId}/billing`, {
      method: 'POST',
      body: {
        milestone: Number(form.milestone),
        submitted_on: form.submitted_on || undefined,
        reference_no: form.reference_no.trim() || undefined,
        extent_ac: form.extent_ac === '' ? undefined : Number(form.extent_ac),
        remarks: form.remarks.trim() || undefined,
      },
    }),
    onError: (e) => toast.error('The claim was not recorded', messageOf(e)),
    onSuccess: () => {
      toast.success('Recorded as submitted for billing',
        'It now appears in the billing list for this programme.');
      setForm(blank); setAdding(false); refresh();
    },
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; version: number; status: BillingStatus }) =>
      apiRequest(`/api/v1/survey/billing/${v.id}`, {
        method: 'PATCH',
        headers: { 'If-Match': String(v.version) },
        body: {
          status: v.status,
          // A decided claim carries the day it was decided, or it cannot be
          // aged — and ageing them is why they are tracked. Undoing one
          // clears the date, so no decision date outlives its decision.
          ...(billingDecisionRequired(v.status)
            ? { decided_on: businessToday() }
            : { decided_on: null }),
        },
      }),
    onError: (e) => toast.error('The claim was not updated', messageOf(e)),
    onSuccess: () => { toast.success('Claim updated'); refresh(); },
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      apiRequest(`/api/v1/survey/billing/${id}`, { method: 'DELETE' }),
    onError: (e) => toast.error('The claim was not removed', messageOf(e)),
    onSuccess: () => {
      toast.success('Claim removed', 'Nothing else about the village changed.');
      refresh();
    },
  });

  const rows: Row[] = claims.data?.data ?? [];
  const claimed = Number(claims.data?.meta?.claimed_percent ?? 0);
  // The milestones left to claim, so the picker does not offer one twice.
  const taken = new Set(rows.filter((r) => r.status !== 'REJECTED').map((r) => Number(r.milestone)));
  const stages: Record<string, string> = village.stages ?? {};
  const labelOf = (code: string) =>
    String(pipeline.find((p) => String(p.code) === code)?.label ?? code.replace(/_/g, ' '));
  /*
   * Only what the village has earned (§note 17).
   *
   * The contract releases the first claim when ground-truthing QC signs the
   * village off, the second at vectorisation QC, the third when the
   * deliverables have gone in. The server refuses the rest; offering them
   * here and letting somebody find out afterwards is the same rule wearing
   * worse manners.
   */
  const unclaimed = [1, 2, 3].filter((m) => !taken.has(m));
  const open = unclaimed.filter((m) => milestoneEarned(m, stages));
  const notYet = unclaimed
    .map((m) => ({ m, why: milestoneBlockedNote(m, stages, labelOf) }))
    .filter((x) => x.why);

  React.useEffect(() => {
    // Default to the next claim due rather than to the first.
    if (open.length && !open.includes(Number(form.milestone))) {
      setForm((f) => ({ ...f, milestone: String(open[0]) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Submitted for billing
        </h4>
        {canManage && open.length > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Record a submission'}
          </Button>
        ) : null}
      </div>

      <p className="mt-1 text-2xs text-text-subtle">
        {claimed >= 100
          ? 'The whole value of this village has been claimed.'
          : `${claimed}% of this village\u2019s value claimed so far\u00a0\u00b7 ${
            open.length === 0
              ? 'nothing left to claim'
              : `next due: ${MILESTONE_LABELS[open[0]]} (${MILESTONE_PERCENT[open[0]]}%)`}`}
      </p>

      {claims.isLoading ? <Skeleton className="mt-2 h-16" /> : null}
      {claims.isError ? (
        <ErrorCard error={claims.error} onRetry={() => claims.refetch()} />
      ) : null}

      {/*
        * What cannot be claimed yet, and what would earn it.
        *
        * Leaving these out of the picker without saying why turns a contract
        * rule into a missing option, and somebody goes looking for a setting.
        */}
      {notYet.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {notYet.map((x) => (
            <li key={x.m} className="text-2xs text-text-subtle">
              <span className="text-text-muted">{MILESTONE_LABELS[x.m]}:</span> {x.why}
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-2xs text-text-subtle">
            Milestone
            <select className={field} value={form.milestone}
              onChange={(e) => setForm({ ...form, milestone: e.target.value })}>
              {open.map((m) => (
                <option key={m} value={m}>
                  {MILESTONE_LABELS[m]} — {MILESTONE_PERCENT[m]}%
                </option>
              ))}
            </select>
          </label>
          <label className="text-2xs text-text-subtle">
            Submitted on
            <input type="date" className={field} value={form.submitted_on}
              max={businessToday()}
              onChange={(e) => setForm({ ...form, submitted_on: e.target.value })} />
          </label>
          <label className="text-2xs text-text-subtle">
            Department reference
            <input className={field} value={form.reference_no} placeholder="RC/2026/114"
              onChange={(e) => setForm({ ...form, reference_no: e.target.value })} />
          </label>
          <label className="text-2xs text-text-subtle">
            Extent claimed (Ac)
            <input className={field} inputMode="decimal" value={form.extent_ac}
              placeholder={village.total_extent_ac ? String(village.total_extent_ac) : ''}
              onChange={(e) => setForm({ ...form, extent_ac: e.target.value })} />
            <span className="mt-0.5 block text-2xs text-text-subtle">
              What was surveyed, which need not equal the revenue record.
            </span>
          </label>
          <label className="text-2xs text-text-subtle sm:col-span-2">
            Remarks
            <input className={field} value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </label>
          <div className="sm:col-span-2">
            <Button type="button" variant="primary" disabled={submit.isPending}
              onClick={() => submit.mutate()}>
              {submit.isPending ? 'Recording…' : 'Record submission'}
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 && !claims.isLoading ? (
        <p className="mt-2 text-xs text-text-muted">
          Nothing has been submitted for billing on this village yet.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <TableWrap className="mt-2">
          <Table>
            <THead>
              <TR>
                <TH>Milestone</TH>
                <TH className="text-right">Share</TH>
                <TH>Submitted</TH>
                <TH>Reference</TH>
                <TH>Status</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((c) => {
                const status = String(c.status) as BillingStatus;
                return (
                  <React.Fragment key={String(c.id)}>
                  <TR>
                    <TD className="text-text">
                      {MILESTONE_LABELS[Number(c.milestone)] ?? `Milestone ${c.milestone}`}
                    </TD>
                    <TD className="text-right tabular-nums">{Number(c.percent)}%</TD>
                    <TD className="text-xs text-text-muted">
                      {day(c.submitted_on)}
                      {c.extent_ac ? (
                        <span className="ml-1 text-2xs text-text-subtle">
                          {Number(c.extent_ac)} Ac
                        </span>
                      ) : null}
                    </TD>
                    <TD className="font-mono text-2xs text-text-muted">
                      {c.reference_no || '—'}
                    </TD>
                    <TD>
                      <Badge tone={status === 'PAID' ? 'success'
                        : status === 'APPROVED' ? 'success'
                          : status === 'REJECTED' ? 'danger' : 'neutral'}>
                        {BILLING_STATUS_LABELS[status] ?? status}
                      </Badge>
                      {c.decided_on ? (
                        <span className="ml-1 text-2xs text-text-subtle">{day(c.decided_on)}</span>
                      ) : null}
                    </TD>
                    <TD className="text-right">
                      {canManage ? (
                        <div className="flex justify-end gap-1">
                          {status === 'SUBMITTED' ? (
                            <>
                              <Button type="button" variant="ghost"
                                onClick={() => decide.mutate({
                                  id: String(c.id), version: Number(c.version), status: 'APPROVED',
                                })}>Approved</Button>
                              <Button type="button" variant="ghost"
                                onClick={() => decide.mutate({
                                  id: String(c.id), version: Number(c.version), status: 'REJECTED',
                                })}>Returned</Button>
                            </>
                          ) : null}
                          {status === 'APPROVED' ? (
                            <Button type="button" variant="ghost"
                              onClick={() => decide.mutate({
                                id: String(c.id), version: Number(c.version), status: 'PAID',
                              })}>Paid</Button>
                          ) : null}
                          {/*
                            * Putting a decision back.
                            *
                            * Somebody presses "Approved" on the wrong row, or
                            * the department's letter turns out to be about a
                            * different village. Without this the only way back
                            * was to delete the claim and lose when it was
                            * submitted, which is the part that matters.
                            */}
                          {status !== 'SUBMITTED' ? (
                            <Button type="button" variant="ghost"
                              title="Undo the decision and leave it as submitted"
                              onClick={() => decide.mutate({
                                id: String(c.id), version: Number(c.version),
                                status: 'SUBMITTED',
                              })}>Undo decision</Button>
                          ) : null}
                          <Button type="button" variant="ghost"
                            onClick={() => setEditing(
                              editing === String(c.id) ? null : String(c.id))}>
                            {editing === String(c.id) ? 'Cancel' : 'Edit'}
                          </Button>
                          <Button type="button" variant="ghost"
                            onClick={() => remove.mutate(String(c.id))}>Remove</Button>
                        </div>
                      ) : null}
                    </TD>
                  </TR>
                  {editing === String(c.id) ? (
                    <TR>
                      <TD colSpan={6} className="bg-surface p-0">
                        <ClaimEdit claim={c} onDone={() => { setEditing(null); refresh(); }} />
                      </TD>
                    </TR>
                  ) : null}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      ) : null}
    </section>
  );
}

/**
 * Correcting a claim after it has gone in.
 *
 * The reference number is typed off a covering letter and the date off a
 * despatch register, and both get mistyped. Without this the only way to fix
 * one was to delete the claim and raise it again, which loses the day it was
 * actually submitted — the one field the department cares about.
 *
 * The milestone is not editable. A claim for a different milestone is a
 * different claim, and changing it under the same row would silently move
 * money between two stages of the contract.
 */
function ClaimEdit({ claim, onDone }: { claim: Row; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = React.useState({
    percent: String(claim.percent ?? ''),
    submitted_on: String(claim.submitted_on ?? ''),
    decided_on: claim.decided_on ? String(claim.decided_on) : '',
    reference_no: claim.reference_no ? String(claim.reference_no) : '',
    extent_ac: claim.extent_ac === null || claim.extent_ac === undefined
      ? '' : String(claim.extent_ac),
    remarks: claim.remarks ? String(claim.remarks) : '',
  });

  const save = useMutation({
    mutationFn: async () => apiRequest(`/api/v1/survey/billing/${claim.id}`, {
      method: 'PATCH',
      headers: { 'If-Match': String(claim.version) },
      body: {
        percent: form.percent === '' ? undefined : Number(form.percent),
        submitted_on: form.submitted_on || undefined,
        // Blank clears it: a decision date with no decision behind it is
        // worse than none.
        decided_on: form.decided_on || null,
        reference_no: form.reference_no.trim() || null,
        extent_ac: form.extent_ac === '' ? null : Number(form.extent_ac),
        remarks: form.remarks.trim() || null,
      },
    }),
    onError: (e) => toast.error('The claim was not changed', messageOf(e)),
    onSuccess: () => { toast.success('Claim updated'); onDone(); },
  });

  return (
    <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-3">
      <label className="text-2xs text-text-subtle">
        Share (%)
        <input className={field} inputMode="decimal" value={form.percent}
          onChange={(e) => setForm({ ...form, percent: e.target.value })} />
      </label>
      <label className="text-2xs text-text-subtle">
        Submitted on
        <input type="date" className={field} value={form.submitted_on} max={businessToday()}
          onChange={(e) => setForm({ ...form, submitted_on: e.target.value })} />
      </label>
      <label className="text-2xs text-text-subtle">
        Decided on
        <input type="date" className={field} value={form.decided_on} max={businessToday()}
          onChange={(e) => setForm({ ...form, decided_on: e.target.value })} />
        <span className="mt-0.5 block">Leave blank if it is still with the department.</span>
      </label>
      <label className="text-2xs text-text-subtle">
        Department reference
        <input className={field} value={form.reference_no} placeholder="RC/2026/114"
          onChange={(e) => setForm({ ...form, reference_no: e.target.value })} />
      </label>
      <label className="text-2xs text-text-subtle">
        Extent claimed (Ac)
        <input className={field} inputMode="decimal" value={form.extent_ac}
          onChange={(e) => setForm({ ...form, extent_ac: e.target.value })} />
      </label>
      <label className="text-2xs text-text-subtle">
        Remarks
        <input className={field} value={form.remarks}
          onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
      </label>
      <div className="sm:col-span-3">
        <Button type="button" variant="primary" loading={save.isPending}
          onClick={() => save.mutate()}>Save changes</Button>
      </div>
    </div>
  );
}


/* ------------------------------------------------- certified totals (§068) */

/**
 * What the village is certified at, against what its returns add up to.
 *
 * Every figure in this module is the sum of daily returns, and that is the
 * right default. It is not what goes to the department: at handover the
 * village is recounted, parcels merge, a hamlet turns out to have been
 * counted twice.
 *
 * Both numbers stay on screen. A certified figure that replaced the record it
 * came from would be the spreadsheet this module exists to replace, just
 * inside the database — and the gap between them is what a reviewer looks at.
 */
function CertifiedTotals({ village, canCertify }: { village: Row; canCertify: boolean }) {
  const villageId = String(village.id);
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, { quantity: string; reason: string }>>({});

  const finished = Object.values((village.stages ?? {}) as Record<string, string>)
    .some((v) => v === 'COMPLETED');

  const figures = useQuery({
    queryKey: ['survey-finals', villageId],
    enabled: open || finished,
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/villages/${villageId}/finals`)).body as { data: Row[] }).data,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['survey-finals', villageId] });
    qc.invalidateQueries({ queryKey: ['survey-villages'] });
    qc.invalidateQueries({ queryKey: ['survey-progress'] });
    qc.invalidateQueries({ queryKey: ['survey-summary'] });
  };

  const save = useMutation({
    mutationFn: async () => apiRequest(`/api/v1/survey/villages/${villageId}/finals`, {
      method: 'PUT',
      body: {
        finals: Object.entries(draft)
          .filter(([, v]) => v.quantity !== '' && v.reason.trim() !== '')
          .map(([code, v]) => ({
            measure_code: code, quantity: Number(v.quantity), reason: v.reason.trim(),
          })),
      },
    }),
    onError: (e) => toast.error('Nothing was certified', messageOf(e)),
    onSuccess: () => {
      toast.success('Certified',
        'Every roll-up now reports the certified figure, with the daily sum beside it.');
      setDraft({}); refresh();
    },
  });

  const clear = useMutation({
    mutationFn: async (code: string) =>
      apiRequest(`/api/v1/survey/villages/${villageId}/finals/${code}`, { method: 'DELETE' }),
    onError: (e) => toast.error('It was not cleared', messageOf(e)),
    onSuccess: () => {
      toast.success('Cleared', 'The village reads as its daily returns again.');
      refresh();
    },
  });

  if (!finished) return null;

  const rows: Row[] = figures.data ?? [];
  // Only measures anybody has recorded or certified: the full list is
  // eleven rows of zeroes on most villages.
  const shown = rows.filter((r) => Number(r.recorded) > 0 || r.certified !== null);
  const ready = Object.values(draft)
    .filter((v) => v.quantity !== '' && v.reason.trim() !== '').length;

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Certified totals
        </h4>
        {canCertify ? (
          <Button type="button" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? 'Done' : 'Certify totals'}
          </Button>
        ) : null}
      </div>

      <p className="mt-1 text-2xs text-text-subtle">
        What the daily returns add up to, and what somebody stands behind at handover.
        Both are kept: the difference is the point.
      </p>

      {figures.isLoading ? <Skeleton className="mt-2 h-16" /> : null}
      {figures.isError ? (
        <ErrorCard error={figures.error} onRetry={() => figures.refetch()} />
      ) : null}

      {shown.length === 0 && !figures.isLoading ? (
        <p className="mt-2 text-xs text-text-muted">Nothing recorded against this village yet.</p>
      ) : null}

      {shown.length > 0 ? (
        <TableWrap className="mt-2">
          <Table>
            <THead>
              <TR>
                <TH>Measure</TH>
                <TH className="text-right">From daily returns</TH>
                <TH className="text-right">Certified</TH>
                <TH className="text-right">Difference</TH>
                <TH>Why</TH>
                {open ? <TH /> : null}
              </TR>
            </THead>
            <TBody>
              {shown.map((r) => {
                const code = String(r.code);
                const d = draft[code] ?? { quantity: '', reason: '' };
                return (
                  <TR key={code}>
                    <TD className="text-text">
                      {String(r.label)}
                      {r.unit ? (
                        <span className="ml-1 text-2xs text-text-subtle">{String(r.unit)}</span>
                      ) : null}
                    </TD>
                    <TD className="text-right tabular-nums text-text-muted">
                      {Number(r.recorded)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {open ? (
                        <input className={`${field} text-right`} inputMode="decimal"
                          placeholder={String(r.certified ?? r.recorded)}
                          value={d.quantity}
                          onChange={(e) => setDraft({
                            ...draft, [code]: { ...d, quantity: e.target.value },
                          })} />
                      ) : r.certified === null
                        ? <span className="text-text-subtle">—</span>
                        : <span className="font-medium text-text">{Number(r.certified)}</span>}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {r.difference === null ? (
                        <span className="text-text-subtle">—</span>
                      ) : (
                        <span className={Number(r.difference) === 0 ? 'text-text-subtle'
                          : Number(r.difference) < 0 ? 'text-warning' : 'text-success'}>
                          {Number(r.difference) > 0 ? '+' : ''}{Number(r.difference)}
                        </span>
                      )}
                    </TD>
                    <TD className="text-2xs text-text-muted">
                      {open ? (
                        <input className={field} placeholder="Recount at handover"
                          value={d.reason}
                          onChange={(e) => setDraft({
                            ...draft, [code]: { ...d, reason: e.target.value },
                          })} />
                      ) : (
                        <>
                          {r.reason ? String(r.reason) : '—'}
                          {r.certified_by_name ? (
                            <div className="text-text-subtle">
                              {String(r.certified_by_name)}
                              {r.certified_at ? ` · ${day(r.certified_at)}` : ''}
                            </div>
                          ) : null}
                        </>
                      )}
                    </TD>
                    {open ? (
                      <TD className="text-right">
                        {r.certified !== null ? (
                          <Button type="button" variant="ghost"
                            onClick={() => clear.mutate(code)}>Clear</Button>
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      ) : null}

      {open ? (
        <div className="mt-2 space-y-2">
          <Notice tone="info" title="A certified figure needs a reason">
            {/* A number that differs from the record with no explanation is
                exactly what this exists to stop. */}
            Enter the figure and why it differs from the daily returns. Both are required,
            and both are recorded against your name.
          </Notice>
          <Button type="button" variant="primary" loading={save.isPending} disabled={ready === 0}
            onClick={() => save.mutate()}>
            Certify {ready || ''} measure{ready === 1 ? '' : 's'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}


/* -------------------------------------------- the village, day by day (§19) */

/**
 * Every return this village has filed, with what was out and who came.
 *
 * The summary totals a village's life; this is the working underneath it.
 * "Eighty-two per cent turnout" is a figure somebody queries, and the answer
 * is the six days in the middle of March where the department sent nobody —
 * which is only visible a day at a time.
 *
 * The line at the bottom is computed by the server from the same rows the
 * table shows, so it can never disagree with the lines above it.
 */
function DailySheet({ village }: { village: Row }) {
  const villageId = String(village.id);
  const [open, setOpen] = React.useState(false);

  const q = useQuery({
    queryKey: ['survey-village-daily', villageId],
    enabled: open,
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/villages/${villageId}/daily`)).body as { data: Row }).data,
  });

  const d = q.data;
  const days: Row[] = d?.days ?? [];
  const measures: Row[] = d?.measures ?? [];
  // Only measures anybody recorded here: eleven columns of zeroes is not a
  // table, it is a wall.
  const active = measures.filter((m) =>
    days.some((x) => Number((x.values as Row)[String(m.code)] ?? 0) > 0));
  const t: Row = d?.totals ?? {};
  const allotted = `${d?.village?.gt_govt_staff_allocated ?? '—'} govt / ${
    d?.village?.gt_crew_allocated ?? '—'} crew`;

  const sheetSpec = {
    name: 'Day by day',
    title: {
      heading: `${String(village.village_name ?? 'Village')} — day by day`,
      period: days.length
        ? `${day(String(days[0].entry_date))} to ${day(String(days[days.length - 1].entry_date))}`
        : 'No returns yet',
      filters: `Agreed staffing: ${allotted}`,
      extra: [
        ['Return days', String(t.return_days ?? 0)],
        ['Rover-days used / idle', `${t.rover_days_used ?? 0} / ${t.rover_days_idle ?? 0}`],
        ['Government staff-days', `${t.govtStaffDays ?? 0} of ${t.govtStaffExpected ?? 0}`],
        ['Crew-days', `${t.crewDays ?? 0} of ${t.crewExpected ?? 0}`],
      ] as Array<[string, string]>,
    },
    columns: [
      { header: 'Date', width: 14 },
      { header: 'Teams', width: 10 },
      { header: 'Rovers out', width: 12 },
      { header: 'Rovers used', width: 12 },
      { header: 'Rovers idle', width: 12 },
      { header: 'Govt staff present', width: 18 },
      { header: 'Crew present', width: 14 },
      ...active.map((m) => ({ header: String(m.label), width: 18 })),
      { header: 'Thin-day reason', width: 24 },
      { header: 'Notes', width: 40 },
    ],
    rows: days.map((x) => [
      String(x.entry_date), String(x.teams_deployed ?? 0),
      String(x.rovers_allocated ?? 0), String(x.rovers_used ?? 0), String(x.rovers_idle ?? 0),
      x.govt_staff_present === null ? '' : String(x.govt_staff_present),
      x.crew_present === null ? '' : String(x.crew_present),
      ...active.map((m) => {
        const v = (x.values as Row)[String(m.code)];
        return v === undefined || v === null ? '' : String(v);
      }),
      x.low_progress_label ? String(x.low_progress_label) : '',
      x.notes ? String(x.notes) : '',
    ]),
  };

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Day by day
        </h4>
        <div className="flex items-center gap-1">
          {open && days.length > 0 ? (
            <ExportMenu sheet={sheetSpec}
              fileName={`village-daily-${String(village.village_code ?? villageId).slice(0, 20)}`} />
          ) : null}
          <Button type="button" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show every return'}
          </Button>
        </div>
      </div>

      {!open ? (
        <p className="mt-1 text-2xs text-text-subtle">
          Every return filed against this village, with the instruments out and who turned up.
        </p>
      ) : null}

      {open && q.isLoading ? <Skeleton className="mt-2 h-32" /> : null}
      {open && q.isError ? <ErrorCard error={q.error} onRetry={() => q.refetch()} /> : null}

      {open && q.isSuccess && days.length === 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          Nothing has been filed against this village yet.
        </p>
      ) : null}

      {open && days.length > 0 ? (
        <>
          <p className="mt-1 text-2xs text-text-subtle">
            Agreed with the mandal: {allotted}. Instruments are read against how many were
            out that day — one of two is a different day from one of six.
          </p>
          <TableWrap className="mt-2">
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH className="text-right">Teams</TH>
                  <TH className="text-right">Rovers out / used / idle</TH>
                  <TH className="text-right">Govt staff</TH>
                  <TH className="text-right">Crew</TH>
                  {active.map((m) => (
                    <TH key={String(m.code)} className="text-right">{String(m.label)}</TH>
                  ))}
                  <TH>Why it was thin</TH>
                </TR>
              </THead>
              <TBody>
                {days.map((x) => {
                  const shortGovt = x.govt_staff_present !== null
                    && d?.village?.gt_govt_staff_allocated != null
                    && Number(x.govt_staff_present) < Number(d.village.gt_govt_staff_allocated);
                  return (
                    <TR key={String(x.entry_date)}>
                      <TD className="tabular-nums text-text">{day(String(x.entry_date))}</TD>
                      <TD className="text-right tabular-nums">{Number(x.teams_deployed ?? 0)}</TD>
                      <TD className="text-right tabular-nums">
                        {Number(x.rovers_allocated ?? 0)} / {Number(x.rovers_used ?? 0)} /{' '}
                        <span className={Number(x.rovers_idle ?? 0) > 0
                          ? 'text-warning' : 'text-text-subtle'}>
                          {Number(x.rovers_idle ?? 0)}
                        </span>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {x.govt_staff_present === null ? (
                          <span className="text-text-subtle">—</span>
                        ) : (
                          <span className={Number(x.govt_staff_present) === 0 ? 'text-danger'
                            : shortGovt ? 'text-warning' : 'text-text'}>
                            {Number(x.govt_staff_present)}
                          </span>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {x.crew_present === null ? (
                          <span className="text-text-subtle">—</span>
                        ) : Number(x.crew_present)}
                      </TD>
                      {active.map((m) => (
                        <TD key={String(m.code)} className="text-right tabular-nums">
                          {(x.values as Row)[String(m.code)] ?? '—'}
                        </TD>
                      ))}
                      <TD className="text-2xs text-text-muted">
                        {x.low_progress_label ? String(x.low_progress_label) : '—'}
                      </TD>
                    </TR>
                  );
                })}
                {/* Totalled by the server from these same rows, so the line
                    at the bottom cannot disagree with the ones above it. */}
                <TR>
                  <TD className="border-t-2 border-border font-medium text-text">Total</TD>
                  <TD className="border-t-2 border-border text-right tabular-nums font-medium">
                    {Number(t.team_days ?? 0)}
                  </TD>
                  <TD className="border-t-2 border-border text-right tabular-nums font-medium">
                    — / {Number(t.rover_days_used ?? 0)} / {Number(t.rover_days_idle ?? 0)}
                  </TD>
                  <TD className="border-t-2 border-border text-right tabular-nums font-medium">
                    {Number(t.govtStaffDays ?? 0)}
                    {t.govtStaffExpected ? (
                      <span className="text-2xs font-normal text-text-subtle">
                        {' '}of {Number(t.govtStaffExpected)}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="border-t-2 border-border text-right tabular-nums font-medium">
                    {Number(t.crewDays ?? 0)}
                    {t.crewExpected ? (
                      <span className="text-2xs font-normal text-text-subtle">
                        {' '}of {Number(t.crewExpected)}
                      </span>
                    ) : null}
                  </TD>
                  {active.map((m) => (
                    <TD key={String(m.code)}
                      className="border-t-2 border-border text-right tabular-nums font-medium">
                      {Number((t.values as Row)?.[String(m.code)] ?? 0)}
                    </TD>
                  ))}
                  <TD className="border-t-2 border-border text-2xs text-text-subtle">
                    over {Number(t.return_days ?? 0)} return day
                    {Number(t.return_days ?? 0) === 1 ? '' : 's'}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </TableWrap>
          <p className="mt-1 text-2xs text-text-subtle">
            {staffingNote(t as any)}
          </p>
        </>
      ) : null}
    </section>
  );
}


/* ----------------------------------------- ground control points (§069) */

/**
 * The control points this village was surveyed from.
 *
 * A GCP is the fixed, known point the DGPS base sits over, and every
 * measurement in the village is relative to it. Establishing one is a
 * one-time job done before ground truthing starts — usually one point, and
 * two or three on a large or awkward village.
 *
 * The coordinates lived in the surveyor's notebook and, with luck, a
 * WhatsApp message. Re-establishing a control point because nobody wrote it
 * down is a day's work with a base station.
 */
function ControlPoints({ village, canManage }: { village: Row; canManage: boolean }) {
  const villageId = String(village.id);
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = React.useState(false);
  const blank = {
    point_code: '', latitude: '', longitude: '', elevation_m: '',
    established_on: '', remarks: '',
  };
  const [form, setForm] = React.useState(blank);

  const points = useQuery({
    queryKey: ['survey-gcps', villageId],
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/villages/${villageId}/gcps`)).body as { data: Row[] }).data,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['survey-gcps', villageId] });

  const save = useMutation({
    mutationFn: async () => apiRequest(`/api/v1/survey/villages/${villageId}/gcps`, {
      method: 'POST',
      body: {
        point_code: form.point_code.trim(),
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        elevation_m: form.elevation_m === '' ? undefined : Number(form.elevation_m),
        established_on: form.established_on || undefined,
        remarks: form.remarks.trim() || undefined,
      },
    }),
    onError: (e) => toast.error('The control point was not recorded', messageOf(e)),
    onSuccess: () => {
      toast.success('Control point recorded',
        'It travels with the village and goes out with the deliverables.');
      setForm(blank); setAdding(false); refresh();
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      apiRequest(`/api/v1/survey/gcps/${id}`, { method: 'DELETE' }),
    onError: (e) => toast.error('It was not removed', messageOf(e)),
    onSuccess: () => { toast.success('Control point removed'); refresh(); },
  });

  const rows: Row[] = points.data ?? [];

  /*
   * What looks wrong about what is being typed, before it is saved.
   *
   * The same check the server runs. Warned rather than blocked: every one of
   * these is also something a legitimate programme produces, and refusing a
   * number somebody is looking straight at is worse than saying what looks
   * odd.
   */
  const typedLat = Number(form.latitude);
  const typedLng = Number(form.longitude);
  const liveWarnings: GcpWarning[] =
    form.latitude !== '' && form.longitude !== ''
      && Number.isFinite(typedLat) && Number.isFinite(typedLng)
      ? checkGcp(typedLat, typedLng) : [];

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Ground control points
        </h4>
        {canManage ? (
          <Button type="button" variant="ghost" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Record a point'}
          </Button>
        ) : null}
      </div>

      <p className="mt-1 text-2xs text-text-subtle">
        The fixed point the base was set over. Recorded once, before ground truthing —
        usually one, sometimes more on a large village.
      </p>

      {points.isLoading ? <Skeleton className="mt-2 h-16" /> : null}
      {points.isError ? (
        <ErrorCard error={points.error} onRetry={() => points.refetch()} />
      ) : null}

      {adding ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-2xs text-text-subtle">
            Point name
            <input className={field} value={form.point_code} placeholder="GCP-1"
              onChange={(e) => setForm({ ...form, point_code: e.target.value })} />
          </label>
          <label className="text-2xs text-text-subtle">
            Established on
            <input type="date" className={field} value={form.established_on}
              max={businessToday()}
              onChange={(e) => setForm({ ...form, established_on: e.target.value })} />
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
            <span className="mt-0.5 block">Optional — a horizontal point is still a point.</span>
          </label>
          <label className="text-2xs text-text-subtle">
            Remarks
            <input className={field} value={form.remarks}
              placeholder="Tied to BM 42; 45 min base observation, PDOP 1.4"
              onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
            <span className="mt-0.5 block">
              How it was fixed. This is the part somebody needs two years later.
            </span>
          </label>

          {liveWarnings.length > 0 ? (
            <div className="sm:col-span-2">
              <Notice tone="warning" title="Check these coordinates">
                <ul className="space-y-0.5">
                  {liveWarnings.map((wn) => <li key={wn}>{GCP_WARNING_NOTES[wn]}</li>)}
                </ul>
                <p className="mt-1">You can still save them — this is a check, not a refusal.</p>
              </Notice>
            </div>
          ) : null}

          <div className="sm:col-span-2">
            <Button type="button" variant="primary" loading={save.isPending}
              disabled={!form.point_code.trim() || form.latitude === '' || form.longitude === ''}
              onClick={() => save.mutate()}>
              Record point
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 && !points.isLoading ? (
        <p className="mt-2 text-xs text-text-muted">
          No control point recorded for this village yet.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <TableWrap className="mt-2">
          <Table>
            <THead>
              <TR>
                <TH>Point</TH>
                <TH className="text-right">Latitude</TH>
                <TH className="text-right">Longitude</TH>
                <TH className="text-right">Elevation</TH>
                <TH>How it was fixed</TH>
                {canManage ? <TH /> : null}
              </TR>
            </THead>
            <TBody>
              {rows.map((g) => (
                <TR key={String(g.id)}>
                  <TD>
                    <div className="font-medium text-text">{String(g.point_code)}</div>
                    {g.established_on ? (
                      <div className="text-2xs text-text-subtle">
                        {day(String(g.established_on))}
                      </div>
                    ) : null}
                  </TD>
                  <TD className="text-right font-mono text-2xs tabular-nums">
                    {formatCoordinate(Number(g.latitude), 'lat')}
                  </TD>
                  <TD className="text-right font-mono text-2xs tabular-nums">
                    {formatCoordinate(Number(g.longitude), 'lng')}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {g.elevation_m === null || g.elevation_m === undefined
                      ? <span className="text-text-subtle">—</span>
                      : `${Number(g.elevation_m)} m`}
                  </TD>
                  <TD className="text-2xs text-text-muted">
                    {g.remarks ? String(g.remarks) : '—'}
                    {((g.warnings as GcpWarning[]) ?? []).map((wn) => (
                      <div key={wn} className="text-warning">{GCP_WARNING_NOTES[wn]}</div>
                    ))}
                    {g.recorded_by_name ? (
                      <div className="text-text-subtle">by {String(g.recorded_by_name)}</div>
                    ) : null}
                  </TD>
                  {canManage ? (
                    <TD className="text-right">
                      <Button type="button" variant="ghost"
                        onClick={() => remove.mutate(String(g.id))}>Remove</Button>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      ) : null}
    </section>
  );
}

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
  billingDecisionRequired, stageTracksStaffing, type BillingStatus,
} from '@silverline/shared';

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
  village, pipeline, canManage, canEnter, openSection,
}: {
  village: Row;
  pipeline: Row[];
  canManage: boolean;
  canEnter: boolean;
  /**
   * Which part to bring into view on arrival.
   *
   * Somebody who picked "Assign crew" from the list has already said what
   * they came to do; making them find it again in an expanded panel is a
   * step that exists only because the software could not be bothered.
   */
  openSection?: 'stages' | 'crew' | 'rovers' | 'billing' | null;
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
      <div className="grid gap-4 lg:grid-cols-2">
        <div {...mark('crew')}>
          <Crew villageId={String(village.id)} pipeline={pipeline} canManage={canManage} />
        </div>
        <div {...mark('rovers')}>
          <Rovers villageId={String(village.id)} canManage={canManage} />
        </div>
        <CrewAssets villageId={String(village.id)} />
        <div {...mark('billing')}>
          <Billing village={village} canManage={canManage} />
        </div>
      </div>
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
function Billing({ village, canManage }: { village: Row; canManage: boolean }) {
  const villageId = String(village.id);
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = React.useState(false);
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
          // aged — and ageing them is why they are tracked.
          ...(billingDecisionRequired(v.status) ? { decided_on: businessToday() } : {}),
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
  const open = [1, 2, 3].filter((m) => !taken.has(m));

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
                  <TR key={String(c.id)}>
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
                          <Button type="button" variant="ghost"
                            onClick={() => remove.mutate(String(c.id))}>Remove</Button>
                        </div>
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      ) : null}
    </section>
  );
}

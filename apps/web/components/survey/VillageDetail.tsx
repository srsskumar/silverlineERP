'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Combobox } from '@/components/ui/Combobox';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Notice } from '@/components/finance/Primitives';
import { day } from '@/lib/finance';
import { STAGE_STATE_LABELS, stageLabel, stateTone } from '@/lib/survey';

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
  village, pipeline, canManage, canEnter,
}: {
  village: Row;
  pipeline: Row[];
  canManage: boolean;
  canEnter: boolean;
}) {
  return (
    <div className="space-y-4 p-3">
      <StagePipeline village={village} pipeline={pipeline} canEnter={canEnter} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Crew villageId={String(village.id)} pipeline={pipeline} canManage={canManage} />
        <Rovers villageId={String(village.id)} canManage={canManage} />
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

  const move = useMutation({
    mutationFn: async (v: Row) =>
      apiRequest(`/api/v1/survey/villages/${village.id}/stage`, { method: 'POST', body: v }),
    onSuccess: () => {
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
  stage, state, dates, onSubmit, pending,
}: {
  stage: Row; state: string; dates: Row;
  onSubmit: (v: Row) => void; pending: boolean;
}) {
  const [form, setForm] = React.useState({
    state,
    started_on: dates.started ?? '',
    completed_on: dates.completed ?? '',
    remarks: dates.remarks ?? '',
  });

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
      <div className="sm:col-span-4">
        <Button type="button" variant="primary" loading={pending}
          disabled={form.state === 'COMPLETED' && !form.completed_on}
          onClick={() => onSubmit({
            state: form.state,
            started_on: form.started_on || undefined,
            completed_on: form.completed_on || undefined,
            remarks: form.remarks || undefined,
          })}>
          Save {stage.label}
        </Button>
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
    queryKey: ['employees', 'for-crew'],
    enabled: adding,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/employees?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const assign = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/villages/${villageId}/crew`, { method: 'POST', body: form }),
    onSuccess: () => {
      setForm({ employee_id: '', stage_code: form.stage_code });
      qc.invalidateQueries({ queryKey: ['survey-crew', villageId] });
    },
  });

  const release = useMutation({
    mutationFn: async (id: string) =>
      apiRequest(`/api/v1/survey/crew/${id}/release`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['survey-crew', villageId] }),
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
              value={form.employee_id}
              onChange={(id) => setForm({ ...form, employee_id: id })}
              isLoading={people.isLoading}
              placeholder="Search the directory…"
              options={(people.data ?? []).map((e) => ({
                id: String(e.id),
                label: [e.first_name, e.last_name].filter(Boolean).join(' ') || String(e.emp_no),
                hint: String(e.emp_no ?? ''),
              }))}
            />
          </div>
          <select className={field} value={form.stage_code}
            onChange={(e) => setForm({ ...form, stage_code: e.target.value })}>
            <option value="">Which stage…</option>
            {pipeline.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
          <div className="sm:col-span-3">
            <Button type="button" variant="primary" loading={assign.isPending}
              disabled={!form.employee_id || !form.stage_code} onClick={() => assign.mutate()}>
              Add to the crew
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
  const today = new Date().toISOString().slice(0, 10);
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

  const allocate = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/villages/${villageId}/rovers`, { method: 'POST', body: form }),
    onSuccess: () => {
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
    onSuccess: () => {
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
            {adding ? 'Cancel' : 'Allocate one'}
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Combobox
              value={form.asset_id}
              onChange={(id) => setForm({ ...form, asset_id: id })}
              isLoading={assets.isLoading}
              placeholder="Search survey equipment…"
              options={(candidates.length ? candidates : assets.data ?? []).map((a) => ({
                id: String(a.id),
                label: String(a.name ?? a.asset_code),
                hint: [a.asset_code, a.serial_number].filter(Boolean).join(' · '),
              }))}
              emptyHint="Instruments in the asset register, category SURVEY"
            />
          </div>
          <input type="date" className={field} value={form.allocated_on}
            onChange={(e) => setForm({ ...form, allocated_on: e.target.value })} />
          <div className="sm:col-span-3">
            <Button type="button" variant="primary" loading={allocate.isPending}
              disabled={!form.asset_id} onClick={() => allocate.mutate()}>
              Allocate
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

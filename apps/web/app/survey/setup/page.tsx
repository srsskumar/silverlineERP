'use client';

import Link from 'next/link';
import { businessToday } from '@/lib/finance';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader, PageBody, Toolbar } from '@/components/ui/Page';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { Notice, Section, Stat } from '@/components/finance/Primitives';
import { duplicateVillageCodes, readVillageCsv, missingColumns } from '@/lib/survey-import';
import { acres, count } from '@/lib/survey';
import { IMPORT_TEMPLATES, downloadTemplate, downloadTemplateWorkbook } from '@/lib/import-templates';

type Row = Record<string, any>;

/**
 * Setting up a survey programme (§59.3).
 *
 * Until this existed the module could be read and not started: there was no
 * way to create a programme or to get the village list in, so every report
 * had nothing to report on.
 *
 * The import is the centre of it. The list arrives from the revenue
 * department as a spreadsheet several thousand rows long, and it is pasted or
 * dropped in exactly as it arrives — the column names are mapped here rather
 * than by asking somebody to rename them.
 */
export default function SurveySetupPage() {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canManage = hasPermission(perms, 'survey.manage');
  const qc = useQueryClient();

  const [projectId, setProjectId] = React.useState('');

  const projects = useQuery({
    queryKey: ['survey-projects'],
    enabled: hasPermission(perms, 'survey.read'),
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/survey/projects?limit=100')).body as { data: Row[] }).data,
  });

  React.useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(String(projects.data[0].id));
  }, [projects.data, projectId]);

  if (!canManage) {
    return (
      <AppShell>
        <PageHeader title="Survey setup" />
        <PageBody>
          <Notice tone="info" title="You do not have access to set up a survey">
            Recording daily progress needs <code>survey.enter</code>; shaping the work list needs{' '}
            <code>survey.manage</code>. The two are separate so that a crew cannot change the list
            its own progress is measured against.
          </Notice>
        </PageBody>
      </AppShell>
    );
  }

  // The programme the picker is pointing at, if the list has caught up with
  // the picker. Undefined for the one render after a programme is created.
  const selectedProgramme = (projects.data ?? []).find(
    (p) => String(p.id) === projectId,
  );

  return (
    <AppShell>
      <PageHeader
        title="Survey setup"
        description="Create a programme, load the villages to be surveyed, and add the columns you count."
      />
      <PageBody>
        <div className="space-y-4">
          {/* Refresh the list before selecting, not after: selecting an id
              the list has not caught up with is what left the panels below
              with nothing to render. */}
          <NewProgramme onCreated={async (id) => {
            await qc.invalidateQueries({ queryKey: ['survey-projects'] });
            setProjectId(id);
          }} />

          {projects.data?.length ? (
            <>
              <Toolbar>
                <label className="flex items-center gap-2 text-xs text-text-muted">
                  Programme
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
                  >
                    {projects.data.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.village_count} villages)
                      </option>
                    ))}
                  </select>
                </label>
                <Link href="/survey" className="ml-auto">
                  <Button type="button" variant="ghost">Back to progress</Button>
                </Link>
              </Toolbar>

              {projectId ? <VillageImport projectId={projectId} /> : null}
              {projectId ? <AddVillage projectId={projectId} /> : null}
              {/*
                * Only once the programme is actually in the list.
                *
                * Creating one selects it immediately and refetches the list
                * afterwards, so for one render the selected id is not in the
                * data yet. The `!` that used to be here asserted otherwise
                * and the panel crashed reading project_id off undefined —
                * which is what anybody saw the moment they created their
                * first programme.
                */}
              {selectedProgramme ? <BoardLink programme={selectedProgramme} /> : null}
            </>
          ) : (
            <EmptyState
              title="No programme yet"
              description="A programme holds the villages to be surveyed and everything recorded against them."
            />
          )}

          <NewMeasure />
        </div>
      </PageBody>
    </AppShell>
  );
}

/* ------------------------------------------------------------- programme */

function NewProgramme({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const today = businessToday();
  const [form, setForm] = React.useState({ code: '', name: '', started_on: today });

  const create = useMutation({
    mutationFn: async () =>
      apiRequest<{ id: string }>('/api/v1/survey/projects', {
        method: 'POST',
        body: { code: form.code, name: form.name, started_on: form.started_on || undefined },
      }),
    onSuccess: (res: any) => {
      onCreated(String(res?.data?.id));
      setOpen(false);
      setForm({ code: '', name: '', started_on: today });
    },
  });

  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  if (!open) {
    return <Button type="button" variant="primary" onClick={() => setOpen(true)}>New programme</Button>;
  }

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-text">New survey programme</h3>
      {/* Said here rather than discovered later: the project is what carries
          the board, the assignees and the planned dates, and creating the two
          separately is the step people forget. */}
      <p className="text-xs text-text-muted">
        A matching project is created with it, so the villages can go on the task board and
        carry assignees and dates. You will not need to create or link one separately.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Code</span>
          <input className={field} value={form.code} placeholder="ASR-RESURVEY-26"
            onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Name</span>
          <input className={field} value={form.name} placeholder="Alluri Sitharama Raju resurvey"
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-2xs uppercase tracking-wide text-text-subtle">Started on</span>
          <input type="date" className={field} value={form.started_on}
            onChange={(e) => setForm({ ...form, started_on: e.target.value })} />
        </label>
      </div>
      {create.isError ? <ErrorCard error={create.error} /> : null}
      <div className="flex gap-2">
        <Button type="button" variant="primary" loading={create.isPending}
          disabled={!form.code.trim() || !form.name.trim()} onClick={() => create.mutate()}>
          Create
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- import */

/**
 * Adding one village without opening a spreadsheet (§note 3).
 *
 * The import exists for the work list that arrives from the revenue
 * department, several thousand rows at a time. It is the wrong tool for the
 * village somebody forgot, and the usual workaround — a one-row CSV — is how
 * people end up with a folder of one-row CSVs.
 */
function AddVillage({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = React.useState({
    village_name: '', village_code: '', district_id: '', mandal_id: '',
    new_mandal_name: '', new_mandal_code: '', total_extent_ac: '',
  });

  // The mandals already in the organisation, which is what a village hangs
  // off. A village with no mandal has nowhere to roll up to.
  const districts = useQuery({
    queryKey: ['org-units', 'district'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/org/units?type=district&limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const mandals = useQuery({
    queryKey: ['org-units', 'mandal'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/org/units?type=mandal&limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  /*
   * Mandals narrowed to the chosen district.
   *
   * A district holds a dozen mandals and the organisation holds hundreds.
   * Offering all of them makes the right one hard to find and the wrong one
   * easy to pick — and a village filed under the wrong mandal is wrong in
   * every report it ever appears in.
   */
  const inDistrict = (mandals.data ?? []).filter(
    (m) => !form.district_id || String(m.parent_id ?? '') === form.district_id);

  // Creating the mandal first, when the village is in one that is not on the
  // list yet — which is the usual reason somebody is adding a village by hand.
  const addMandal = useMutation({
    mutationFn: async () =>
      apiRequest('/api/v1/org/units', {
        method: 'POST',
        body: {
          type: 'mandal', name: form.new_mandal_name.trim(),
          code: form.new_mandal_code.trim(), parent_id: form.district_id,
        },
      }),
    onSuccess: (res: any) => {
      setForm({
        ...form, mandal_id: String(res?.data?.id ?? res?.id ?? ''),
        new_mandal_name: '', new_mandal_code: '',
      });
      qc.invalidateQueries({ queryKey: ['org-units', 'mandal'] });
    },
  });

  const add = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/projects/${projectId}/villages`, {
        method: 'POST',
        body: {
          village_name: form.village_name.trim(),
          village_code: form.village_code.trim(),
          mandal_id: form.mandal_id,
          ...(form.total_extent_ac
            ? { total_extent_ac: Number(form.total_extent_ac) }
            : {}),
        },
      }),
    onSuccess: () => {
      // The district and mandal are kept: somebody adding one village by
      // hand is usually adding three, all in the same mandal.
      setForm((f) => ({
        ...f, village_name: '', village_code: '', total_extent_ac: '',
      }));
      qc.invalidateQueries({ queryKey: ['survey-villages'] });
      qc.invalidateQueries({ queryKey: ['survey-projects'] });
    },
  });

  const field = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';
  const ready = form.village_name.trim() && form.village_code.trim() && form.mandal_id;

  return (
    <Section title="Add a village by hand">
      <Card className="space-y-3 p-4">
        <p className="text-xs text-text-muted">
          For the one the work list missed. The import above is for the list that arrives from
          the revenue department; this is for a single village, and it creates the location if
          it is not there yet.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="space-y-1">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">District</span>
            <select className={field} value={form.district_id}
              onChange={(e) => setForm({ ...form, district_id: e.target.value, mandal_id: '' })}>
              <option value="">Choose…</option>
              {(districts.data ?? []).map((d) => (
                <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">Village name</span>
            <input className={field} value={form.village_name}
              onChange={(e) => setForm({ ...form, village_name: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">Village code</span>
            <input className={field} value={form.village_code}
              placeholder="As the department lists it"
              onChange={(e) => setForm({ ...form, village_code: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">Mandal</span>
            <select className={field} value={form.mandal_id}
              onChange={(e) => setForm({ ...form, mandal_id: e.target.value })}>
              <option value="">
                {form.district_id ? 'Choose…' : 'Choose a district first'}
              </option>
              {inDistrict.map((m) => (
                <option key={String(m.id)} value={String(m.id)}>{String(m.name)}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-2xs uppercase tracking-wide text-text-subtle">
              Extent (Ac)
            </span>
            <input className={field} type="number" min={0} step="0.01"
              value={form.total_extent_ac}
              onChange={(e) => setForm({ ...form, total_extent_ac: e.target.value })} />
          </label>
        </div>
        {form.district_id ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-text-muted hover:text-text">
              The mandal is not on the list
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="text-2xs uppercase tracking-wide text-text-subtle">
                  New mandal name
                </span>
                <input className={field} value={form.new_mandal_name}
                  onChange={(e) => setForm({ ...form, new_mandal_name: e.target.value })} />
              </label>
              <label className="space-y-1">
                <span className="text-2xs uppercase tracking-wide text-text-subtle">
                  Mandal code
                </span>
                <input className={field} value={form.new_mandal_code}
                  onChange={(e) => setForm({ ...form, new_mandal_code: e.target.value })} />
              </label>
              <div className="flex items-end">
                <Button type="button" variant="secondary" loading={addMandal.isPending}
                  disabled={!form.new_mandal_name.trim() || !form.new_mandal_code.trim()}
                  onClick={() => addMandal.mutate()}>
                  Add the mandal
                </Button>
              </div>
            </div>
            {addMandal.isError ? <ErrorCard error={addMandal.error} /> : null}
          </details>
        ) : null}

        {add.isError ? <ErrorCard error={add.error} /> : null}
        {add.isSuccess ? (
          <p className="text-xs text-success">Added to the programme.</p>
        ) : null}
        <Button type="button" variant="primary" disabled={!ready} loading={add.isPending}
          onClick={() => add.mutate()}>
          Add village
        </Button>
      </Card>
    </Section>
  );
}

function VillageImport({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [text, setText] = React.useState('');
  const [preview, setPreview] = React.useState<Row | null>(null);
  const template = IMPORT_TEMPLATES.find((t) => t.key === 'survey-villages')!;

  const rows = React.useMemo(() => {
    if (!text.trim()) return [];
    try { return readVillageCsv(text); } catch { return []; }
  }, [text]);

  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);

  // Repeated village codes, found before anything is sent.
  const duplicates = React.useMemo(() => duplicateVillageCodes(rows), [rows]);
  const duplicateRows = duplicates.reduce((t, d) => t + d.rows.length - 1, 0);

  const run = useMutation({
    /*
     * Sent in batches, not in one request.
     *
     * A 1,400-row list timed out. One request carrying every row has to
     * validate and write all of them before it can answer, and each village
     * may first have to create a district and a mandal — so the gateway
     * gives up long before the work finishes. Batches finish well inside
     * any timeout, and the counts are added together.
     */
    mutationFn: async (dryRun: boolean) => {
      const BATCH = 100;
      const batches: typeof rows[] = [];
      for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

      const total = {
        dry_run: dryRun, rows: 0, imported: 0, validated: 0,
        already_listed: 0, rejected: 0,
        geography_created: { districts: 0, divisions: 0, mandals: 0, villages: 0 },
        results: [] as Array<Record<string, unknown>>,
      };

      for (const [n, batch] of batches.entries()) {
        setProgress({ done: n * BATCH, total: rows.length });
        const res: any = await apiRequest(
          `/api/v1/survey/projects/${projectId}/villages/import`,
          {
            method: 'POST',
            body: { rows: batch, dry_run: dryRun },
            // A village row may create a district and a mandal before it can
            // create the village, so a batch is real work, not a read.
            timeoutMs: 180_000,
          });
        const d = res?.data ?? {};
        total.rows += Number(d.rows ?? 0);
        total.imported += Number(d.imported ?? 0);
        total.validated += Number(d.validated ?? 0);
        total.already_listed += Number(d.already_listed ?? 0);
        total.rejected += Number(d.rejected ?? 0);
        for (const k of ['districts', 'divisions', 'mandals', 'villages'] as const) {
          total.geography_created[k] += Number(d.geography_created?.[k] ?? 0);
        }
        // Row numbers are per batch; shift them back to the row the person is
        // looking at in their spreadsheet.
        for (const r of (d.results ?? [])) {
          total.results.push({ ...r, row: Number(r.row ?? 0) + n * BATCH });
        }
      }
      setProgress(null);
      return { data: total };
    },
    onSuccess: (res: any) => {
      setPreview(res?.data ?? null);
      if (!res?.data?.dry_run) {
        qc.invalidateQueries({ queryKey: ['survey-projects'] });
        qc.invalidateQueries({ queryKey: ['survey-villages'] });
        qc.invalidateQueries({ queryKey: ['survey-progress'] });
      }
    },
  });

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
  }

  return (
    <Section title="Load the villages to be surveyed">
      <Card className="space-y-3 p-4">
        <p className="text-xs text-text-muted">
          Paste the list or choose the file. The column names the revenue department uses are
          recognised as they come — District Name, MandalCode, vill_code_old and the rest — so
          nothing needs renaming first. The district, division and mandal are created from the
          same rows; there is no separate geography step.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,text/csv" onChange={onFile}
            className="text-xs text-text-muted file:mr-2 file:rounded-md file:border file:border-border file:bg-surface file:px-2 file:py-1 file:text-xs" />
          <Button type="button" variant="ghost" onClick={() => downloadTemplate(template)}>
            Template (CSV)
          </Button>
          <Button type="button" variant="ghost" onClick={() => downloadTemplateWorkbook(template)}>
            Template (Excel)
          </Button>
        </div>

        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); }}
          rows={6}
          placeholder="DistrictCode,District Name,DivisionCode,Division Name,MandalCode,Mandal Name,Village Code,Village Name,vill_code_old&#10;15,Alluri Sitharama Raju,1,Paderu,11,KOYYURU,1511077,ADAKULA,314077"
          className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-2xs text-text"
        />

        {duplicates.length > 0 ? (
          <Notice tone="warning" title={`${duplicateRows} of these rows repeat a village already in the file`}>
            {/* Said before the upload, not after: "already listed" in the
                result reads as though the village was in the programme
                beforehand, and it was not — the list itself repeats it. */}
            <p className="mb-2">
              The file has {count(rows.length)} rows but only{' '}
              {count(rows.length - duplicateRows)} different villages. The repeated rows are
              loaded once each; they are reported as already listed, which is why the two
              numbers will not match.
            </p>
            <p className="text-2xs">
              {duplicates.slice(0, 6).map((d) => `${d.code} (rows ${d.rows.join(', ')})`).join(' · ')}
              {duplicates.length > 6 ? ` · and ${duplicates.length - 6} more` : ''}
            </p>
          </Notice>
        ) : null}

        {rows.length > 0 ? (
          <p className="text-xs text-text-muted">
            {count(rows.length)} row{rows.length === 1 ? '' : 's'} read.{' '}
            {missingColumns(rows).length === 0
              ? `First: ${rows[0].village_name ?? ''} (${rows[0].village_code})`
              : (
                <span className="text-warning">
                  Missing {missingColumns(rows).join(', ')} — check the header row.
                </span>
              )}
          </p>
        ) : null}

        {progress ? (
          <p className="text-2xs text-text-subtle">
            Sending row {progress.done + 1}–{Math.min(progress.done + 100, progress.total)} of {progress.total}…
          </p>
        ) : null}

        {run.isError ? <ErrorCard error={run.error} /> : null}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" loading={run.isPending}
            disabled={rows.length === 0} onClick={() => run.mutate(true)}>
            Check the file
          </Button>
          <Button type="button" variant="primary"
            // Deliberately gated on having previewed: an import that creates
            // several thousand rows of geography on a typo in one column is
            // not one anybody runs twice.
            disabled={!preview?.dry_run || run.isPending}
            onClick={() => run.mutate(false)}>
            Import {preview?.dry_run ? `${preview.validated} village${preview.validated === 1 ? '' : 's'}` : ''}
          </Button>
        </div>

        {preview ? <ImportResult result={preview} /> : null}
      </Card>
    </Section>
  );
}

function ImportResult({ result }: { result: Row }) {
  const problems: Row[] = (result.results ?? []).filter(
    (r: Row) => r.status === 'REJECTED' || r.status === 'ALREADY_LISTED');

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label={result.dry_run ? 'Would import' : 'Imported'}
          value={result.dry_run ? result.validated : result.imported}
          tone={(result.dry_run ? result.validated : result.imported) > 0 ? 'success' : undefined} />
        <Stat label="Already listed" value={result.already_listed}
          hint="Left alone, not duplicated" />
        <Stat label="Rejected" value={result.rejected}
          tone={result.rejected > 0 ? 'danger' : undefined} />
        <Stat label="New geography"
          value={`${result.geography_created?.villages ?? 0}`}
          hint={`${result.geography_created?.districts ?? 0} districts, ${result.geography_created?.divisions ?? 0} divisions, ${result.geography_created?.mandals ?? 0} mandals`} />
      </div>

      {result.dry_run ? (
        <Notice tone="info" title="Nothing has been written yet">
          This was a check. Nothing was created — press Import to commit it.
        </Notice>
      ) : (
        <Notice tone="info" title="Imported">
          The villages are in the programme and every report now counts them.
        </Notice>
      )}

      {problems.length ? (
        <TableWrap>
          <Table>
            <THead>
              <TR><TH>Row</TH><TH>Village</TH><TH>Status</TH><TH>Why</TH></TR>
            </THead>
            <TBody>
              {problems.slice(0, 50).map((r) => (
                <TR key={r.row}>
                  <TD className="tabular-nums">{r.row}</TD>
                  <TD className="font-mono text-2xs">{r.village_code ?? '—'}</TD>
                  <TD>
                    <Badge tone={r.status === 'REJECTED' ? 'danger' : 'neutral'}>
                      {r.status === 'REJECTED' ? 'Rejected' : 'Already listed'}
                    </Badge>
                  </TD>
                  <TD className="text-2xs text-text-muted">{r.message}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      ) : null}
      {problems.length > 50 ? (
        <p className="text-2xs text-text-subtle">
          Showing the first 50 of {problems.length}.
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- task board */

/**
 * Putting the village work on the task board (§59 with §S4).
 *
 * Once generated, the task's status is what a village's state means. That is
 * a one-way door worth stating plainly on the screen: the stage columns stop
 * being written, and moving a card is how a village progresses from then on.
 */
/**
 * Give a programme created before pairing its own project.
 *
 * The picker beside it can attach an existing project, which is right when
 * one already exists. This is for the commoner case: there is no project,
 * and making one by hand means leaving this screen, remembering the code,
 * and coming back.
 */
function PairProject({ programmeId }: { programmeId: string }) {
  const qc = useQueryClient();
  const pair = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/survey/projects/${programmeId}/pair`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['survey-projects'] }),
  });

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <p className="mb-2 text-xs text-text-muted">
        This programme has no project, so its villages cannot go on a board or carry
        assignees and dates. Newer programmes get one automatically.
      </p>
      <Button type="button" variant="secondary" loading={pair.isPending}
        onClick={() => pair.mutate()}>
        Create its project
      </Button>
      {pair.isError ? <div className="mt-2"><ErrorCard error={pair.error} /></div> : null}
    </div>
  );
}

function BoardLink({ programme }: { programme: Row }) {
  const qc = useQueryClient();
  const [preview, setPreview] = React.useState<Row | null>(null);

  const projects = useQuery({
    queryKey: ['projects', 'for-survey'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const link = useMutation({
    mutationFn: async (projectId: string) =>
      apiRequest(`/api/v1/survey/projects/${programme.id}`, {
        method: 'PATCH',
        headers: { 'If-Match': String(programme.version) },
        body: { project_id: projectId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['survey-projects'] }),
  });

  const generate = useMutation({
    mutationFn: async (dryRun: boolean) =>
      apiRequest(`/api/v1/survey/projects/${programme.id}/generate-tasks`, {
        method: 'POST',
        body: { dry_run: dryRun, include_stages: true },
        /*
         * A task per village and a subtask per stage: on a programme of a
         * thousand villages that is nine thousand rows in one request, and
         * the default thirty seconds is for reading a screenful. The browser
         * was abandoning it while the server carried on writing, which
         * leaves somebody unable to tell whether the board was built.
         */
        timeoutMs: 600_000,
      }),
    onSuccess: (res: any) => {
      setPreview(res?.data ?? null);
      if (!res?.data?.dry_run) {
        qc.invalidateQueries({ queryKey: ['survey-villages'] });
        qc.invalidateQueries({ queryKey: ['survey-progress'] });
      }
    },
  });

  const field = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <Section title="Put the work on the task board">
      <Card className="space-y-3 p-4">
        <p className="text-xs text-text-muted">
          Each village becomes a task and each of its stages a subtask, so survey work appears on
          the board and in the task list like any other work — with an assignee and planned dates,
          which a survey row has nowhere else to keep.
        </p>

        {!programme.project_id ? (
          <PairProject programmeId={String(programme.id)} />
        ) : null}

        <label className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          Project the tasks belong to
          <select
            className={field}
            value={programme.project_id ?? ''}
            onChange={(e) => e.target.value && link.mutate(e.target.value)}
          >
            <option value="">Not linked yet</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
            ))}
          </select>
          {link.isPending ? <span>linking…</span> : null}
        </label>

        {link.isError ? <ErrorCard error={link.error} /> : null}

        {programme.project_id ? (
          <>
            <Notice tone="warning" title="This changes where a village's state lives">
              {/* Worth saying before, not after. */}
              Once a village is on the board, its task's status <em>is</em> its survey state — the
              stage fields stop being used for it. Moving a card is how the village progresses from
              then on, and a completion date is stamped when the card moves rather than typed.
            </Notice>

            {generate.isError ? <ErrorCard error={generate.error} /> : null}

            <div className="flex gap-2">
              <Button type="button" variant="secondary" loading={generate.isPending}
                onClick={() => generate.mutate(true)}>
                Count what would be created
              </Button>
              <Button type="button" variant="primary"
                disabled={!preview?.dry_run || generate.isPending}
                onClick={() => generate.mutate(false)}>
                {preview?.dry_run
                  ? `Create ${preview.village_tasks + preview.stage_tasks} tasks`
                  : 'Create the tasks'}
              </Button>
            </div>

            {preview ? (
              <div className="grid gap-2 sm:grid-cols-4">
                <Stat label="Villages" value={preview.villages_considered} />
                <Stat label="Village tasks" value={preview.village_tasks} />
                <Stat label="Stage subtasks" value={preview.stage_tasks} />
                <Stat label="Already on the board" value={preview.already_linked}
                  hint="Left alone, not duplicated" />
              </div>
            ) : null}
            {preview && !preview.dry_run ? (
              <Notice tone="info" title="On the board">
                Open the project's board to assign them and set dates.
              </Notice>
            ) : null}
          </>
        ) : (
          <p className="text-2xs text-text-subtle">
            A task belongs to a project, so pick one above before generating.
          </p>
        )}
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------- measures */

/**
 * Adding a column on the fly (§59.4.3).
 *
 * The requirement is explicit that more get added as the work goes on, which
 * is why a measure is a row rather than a database column — and why this is a
 * form rather than a deployment.
 */
function NewMeasure() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    code: '', label: '', group_label: '', unit: 'COUNT', basis: 'TARGET',
  });

  const catalogue = useQuery({
    queryKey: ['survey-measures'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/survey/measures')).body as { data: Row }).data,
  });

  const create = useMutation({
    mutationFn: async () =>
      apiRequest('/api/v1/survey/measures', {
        method: 'POST',
        body: {
          code: form.code.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
          label: form.label,
          group_label: form.group_label || undefined,
          unit: form.unit,
          basis: form.basis,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['survey-measures'] });
      setOpen(false);
      setForm({ code: '', label: '', group_label: '', unit: 'COUNT', basis: 'TARGET' });
    },
  });

  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';
  const measures: Row[] = catalogue.data?.measures ?? [];

  return (
    <Section title="What gets counted">
      <Card className="space-y-3 p-4">
        <p className="text-xs text-text-muted">
          {measures.length} column{measures.length === 1 ? '' : 's'} on the entry form. Adding one
          takes effect immediately — it does not need a release.
        </p>

        <div className="flex flex-wrap gap-1">
          {measures.map((m) => (
            <span key={m.code} className="rounded bg-surface-sunken px-2 py-0.5 text-2xs text-text-muted">
              {m.group_label ? `${m.group_label} · ` : ''}{m.label}
            </span>
          ))}
        </div>

        {open ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="text-2xs uppercase tracking-wide text-text-subtle">Column name</span>
                <input className={field} value={form.label} placeholder="Drone images"
                  onChange={(e) => setForm({
                    ...form, label: e.target.value,
                    code: form.code || e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
                  })} />
              </label>
              <label className="space-y-1">
                <span className="text-2xs uppercase tracking-wide text-text-subtle">Group it sits under</span>
                <input className={field} value={form.group_label} placeholder="Imagery"
                  onChange={(e) => setForm({ ...form, group_label: e.target.value })} />
              </label>
              <label className="space-y-1">
                <span className="text-2xs uppercase tracking-wide text-text-subtle">Measured in</span>
                <select className={field} value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                  <option value="COUNT">a count</option>
                  <option value="POINTS">points</option>
                  <option value="PARCELS">parcels</option>
                  <option value="ACRES">acres</option>
                </select>
              </label>
            </div>
            <label className="space-y-1">
              <span className="text-2xs uppercase tracking-wide text-text-subtle">
                Percentage complete measured against
              </span>
              <select className={field} value={form.basis}
                onChange={(e) => setForm({ ...form, basis: e.target.value })}>
                <option value="TARGET">a target set per village</option>
                <option value="EXTENT">the village extent in acres</option>
                <option value="NONE">nothing — it is a count, not progress</option>
              </select>
              <span className="block text-2xs text-text-subtle">
                Where there is nothing to divide by, the report says so rather than showing 0%.
              </span>
            </label>
            {create.isError ? <ErrorCard error={create.error} /> : null}
            <div className="flex gap-2">
              <Button type="button" variant="primary" loading={create.isPending}
                disabled={!form.label.trim()} onClick={() => create.mutate()}>
                Add the column
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
            Add a column
          </Button>
        )}
      </Card>
    </Section>
  );
}

'use client';

import * as React from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { apiRequestRaw } from '@/lib/apiClient';
import { parseCsv } from '@/lib/csv';
import { readXlsx } from '@/lib/xlsx-read';
import { normaliseHeader } from '@/lib/survey-import';

/**
 * Submitting a filled-in template (enhancement note 3).
 *
 * Every format on this page could be downloaded and none could be uploaded:
 * the page said "upload it from the matching screen" and for assets,
 * allocations and stock no such screen existed. A format nobody can submit is
 * a format nobody uses.
 *
 * Checked before it is written. The preview runs the whole file through the
 * same rules as the real import and reports what each row would do, so the
 * answer to "what will this do to my register" comes before the register
 * changes rather than after.
 */

export interface UploadTarget {
  /** Where the rows go. */
  path: string;
  /** What the button says once a file is chosen. */
  verb: string;
}

type Row = Record<string, unknown>;

/**
 * Rows per request.
 *
 * Small enough that a batch finishes well inside any gateway timeout even
 * when its rows are the slow kind — a village row may have to create a
 * district and a mandal before it can create the village.
 */
const BATCH = 100;

/**
 * What an importer reports back.
 *
 * The shapes differ by endpoint and always did: the asset and stock
 * importers answer with counts and `results`, while the employee importer
 * answers with `validated`/`imported`/`failed` and a `rows` **array**. The
 * summary line read `rows` as a number regardless, so an employee upload
 * printed "[object Object] rows, nothing to change" — the array stringified.
 */
interface ImportOutcome {
  dry_run?: boolean;
  /** Assets and stock: a count. Employees: an array of per-row results. */
  rows?: number | unknown[];
  created?: number;
  updated?: number;
  allocated?: number;
  already_allocated?: number;
  rejected?: number;
  /** The employee importer's vocabulary. */
  validated?: number;
  imported?: number;
  failed?: number;
  results?: Array<{ row: number; key?: string; status: string; message?: string }>;
  errors?: Array<{ index: number; errors?: Array<{ field?: string; message: string }> }>;
}

/** How many rows a response accounts for, whichever shape it used. */
function rowCount(o: ImportOutcome): number {
  if (Array.isArray(o.rows)) return o.rows.length;
  if (typeof o.rows === 'number') return o.rows;
  return (o.validated ?? 0) + (o.imported ?? 0) + (o.failed ?? 0);
}

/** Rejections, in whichever vocabulary the endpoint used. */
function problemsOf(o: ImportOutcome | null): Array<{
  row: number; key?: string; status: string; message?: string;
}> {
  if (!o) return [];
  const fromResults = (o.results ?? []).filter(
    (r) => r.status === 'REJECTED' || r.status === 'ALREADY_ALLOCATED');
  if (fromResults.length > 0) return fromResults;
  // The employee importer reports failures separately, by row index.
  return (o.errors ?? []).map((e) => ({
    row: (e.index ?? 0) + 1,
    status: 'REJECTED',
    message: (e.errors ?? [])
      .map((x) => (x.field ? `${x.field}: ${x.message}` : x.message))
      .join('; '),
  }));
}

export function ImportUpload({ target }: { target: UploadTarget }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [fileName, setFileName] = React.useState('');
  const [outcome, setOutcome] = React.useState<ImportOutcome | null>(null);
  const [error, setError] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);

  const read = async (file: File) => {
    setError(undefined);
    setOutcome(null);
    try {
      /*
       * Excel or CSV.
       *
       * The templates are offered as Excel first, because its dropdowns stop
       * the mis-typed enum behind most rejections — and the upload used to
       * take only CSV, so everybody who took the recommended path had to
       * convert the file back before they could submit it.
       */
      const table = (/\.xlsx?$/i.test(file.name)
        ? await readXlsx(await file.arrayBuffer())
        : parseCsv(await file.text())
      ).filter((r) => r.some((c) => (c ?? '').trim() !== ''));
      if (table.length < 2) throw new Error('That file has a header row and nothing else.');
      // Headers are matched loosely, because a column somebody renamed from
      // "Serial Number" to "serial number" is the same column.
      const headers = table[0].map(normaliseHeader);
      const parsed = table.slice(1).map((line) =>
        Object.fromEntries(headers.map((h, i) => [h, (line[i] ?? '').trim()])));
      setRows(parsed);
      setFileName(file.name);
    } catch (e) {
      setError(e);
      setRows(null);
    }
  };

  /*
   * Sent in batches, not in one request.
   *
   * A 1,400-row village list timed out: one request carrying every row has
   * to validate and write all of them before it can answer, and the gateway
   * gives up first. The file is cut into batches, each a request that
   * finishes well inside any timeout, and the results are added together.
   *
   * The batch is deliberately small enough that a slow row — one that has to
   * create a district and a mandal before it can create the village — cannot
   * push the request over on its own.
   */
  const send = async (dryRun: boolean) => {
    if (!rows) return;
    setBusy(true);
    setError(undefined);
    setOutcome(null);
    try {
      const batches: Row[][] = [];
      for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

      const merged: ImportOutcome = { dry_run: dryRun, rows: 0 };
      const results: NonNullable<ImportOutcome['results']> = [];
      const errors: NonNullable<ImportOutcome['errors']> = [];

      for (const [n, batch] of batches.entries()) {
        setProgress({ done: n * BATCH, total: rows.length });
        const res = await apiRequestRaw(target.path, {
          method: 'POST',
          body: { rows: batch, dry_run: dryRun },
          // The default thirty seconds is for a request that reads a
          // screenful. A batch of rows the server is legitimately writing
          // needs longer, and abandoning it mid-write leaves somebody with
          // no idea how much of their file went in.
          timeoutMs: 180_000,
        });
        const part = (res.body as ImportOutcome) ?? {};
        for (const key of ['created', 'updated', 'allocated', 'already_allocated',
          'rejected', 'validated', 'imported', 'failed'] as const) {
          if (typeof part[key] === 'number') {
            merged[key] = (merged[key] ?? 0) + (part[key] as number);
          }
        }
        merged.rows = (merged.rows as number) + rowCount(part);
        // Row numbers are per batch, so they are shifted back to the row the
        // person is looking at in their spreadsheet.
        for (const r of part.results ?? []) results.push({ ...r, row: r.row + n * BATCH });
        for (const e of part.errors ?? []) errors.push({ ...e, index: (e.index ?? 0) + n * BATCH });
      }

      setProgress(null);
      setOutcome({ ...merged, results, errors });
    } catch (e) {
      setError(e);
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const problems = problemsOf(outcome);

  return (
    <div className="mt-3 rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer text-xs text-primary underline underline-offset-2">
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file);
              e.target.value = '';
            }}
          />
          Choose a filled-in Excel or CSV file…
        </label>
        {fileName ? (
          <span className="text-2xs text-text-subtle">
            {fileName} — {rows?.length ?? 0} row{rows?.length === 1 ? '' : 's'}
          </span>
        ) : null}

        {rows ? (
          <div className="ml-auto flex gap-2">
            {/* Checked before written, always: the answer to "what will this
                do to my register" should come before the register changes. */}
            <Button type="button" variant="secondary" loading={busy}
              onClick={() => void send(true)}>
              Check it
            </Button>
            <Button type="button" variant="primary" loading={busy}
              disabled={!outcome?.dry_run}
              onClick={() => void send(false)}>
              <Upload className="size-4" />
              {target.verb}
            </Button>
          </div>
        ) : null}
      </div>

      {rows && !outcome?.dry_run && !outcome ? (
        <p className="mt-2 text-2xs text-text-subtle">
          Check it first — the upload button turns on once the file has been checked.
        </p>
      ) : null}

      {progress ? (
        <p className="mt-2 text-2xs text-text-subtle">
          Sending row {progress.done + 1}–
          {Math.min(progress.done + BATCH, progress.total)} of {progress.total}…
        </p>
      ) : null}

      {error ? <div className="mt-2"><ErrorCard error={error} /></div> : null}

      {outcome ? (
        <div className="mt-3 space-y-2 text-xs">
          <p className={outcome.dry_run ? 'text-text-muted' : 'text-success'}>
            {outcome.dry_run ? 'Nothing has been saved yet. ' : 'Saved. '}
            {summarise(outcome)}
          </p>
          {problems.length > 0 ? (
            <div className="max-h-48 overflow-y-auto rounded border border-border">
              <table className="w-full text-2xs">
                <tbody>
                  {problems.map((p) => (
                    <tr key={`${p.row}:${p.key ?? ''}`} className="border-b border-border last:border-0">
                      <td className="px-2 py-1 text-text-subtle">Row {p.row}</td>
                      <td className="px-2 py-1 font-mono text-text-muted">{p.key ?? '—'}</td>
                      <td className="px-2 py-1 text-warning">{p.message ?? p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What the file did, or would do, in one line. */
function summarise(o: ImportOutcome): string {
  const total = rowCount(o);
  const parts: string[] = [];
  if (o.created) parts.push(`${o.created} new`);
  if (o.updated) parts.push(`${o.updated} updated`);
  if (o.allocated) parts.push(`${o.allocated} allocated`);
  if (o.already_allocated) parts.push(`${o.already_allocated} already out with somebody`);
  // The employee importer counts differently: validated on a check, imported
  // on the real run.
  if (o.validated) parts.push(`${o.validated} ready to add`);
  if (o.imported) parts.push(`${o.imported} added`);
  const rejected = o.rejected ?? o.failed ?? 0;
  if (rejected) parts.push(`${rejected} rejected`);
  if (parts.length === 0) return `${total} row${total === 1 ? '' : 's'}, nothing to change.`;
  return `${parts.join(', ')} of ${total} row${total === 1 ? '' : 's'}.`;
}

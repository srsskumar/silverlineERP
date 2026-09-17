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

interface ImportOutcome {
  dry_run?: boolean;
  rows?: number;
  created?: number;
  updated?: number;
  allocated?: number;
  already_allocated?: number;
  rejected?: number;
  results?: Array<{ row: number; key?: string; status: string; message?: string }>;
}

export function ImportUpload({ target }: { target: UploadTarget }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [fileName, setFileName] = React.useState('');
  const [outcome, setOutcome] = React.useState<ImportOutcome | null>(null);
  const [error, setError] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);

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

  const send = async (dryRun: boolean) => {
    if (!rows) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await apiRequestRaw(target.path, {
        method: 'POST',
        body: { rows, dry_run: dryRun },
      });
      setOutcome((res.body as ImportOutcome) ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const problems = (outcome?.results ?? []).filter(
    (r) => r.status === 'REJECTED' || r.status === 'ALREADY_ALLOCATED');

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
  const parts: string[] = [];
  if (o.created) parts.push(`${o.created} new`);
  if (o.updated) parts.push(`${o.updated} updated`);
  if (o.allocated) parts.push(`${o.allocated} allocated`);
  if (o.already_allocated) parts.push(`${o.already_allocated} already out with somebody`);
  if (o.rejected) parts.push(`${o.rejected} rejected`);
  if (parts.length === 0) return `${o.rows ?? 0} rows, nothing to change.`;
  return `${parts.join(', ')} of ${o.rows ?? 0} rows.`;
}

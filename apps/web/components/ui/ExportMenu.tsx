'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import {
  downloadCsv, downloadWorkbook, titleLines, type SheetSpec, type ReportTitle,
} from '@/lib/xlsx';

/**
 * Take the table on screen away in a file.
 *
 * Every report in this module ended at the screen. What people actually do
 * with a monthly figure is put it in a covering note or send it to a district
 * office, and the way that happened was somebody retyping it — which is how
 * two versions of the same month start circulating.
 *
 * Deliberately exports *what is on screen*, filters and all, rather than
 * re-fetching everything. A download that quietly contains more rows than the
 * table it sits under is worse than no download: the reader checks a total,
 * finds it does not match, and stops trusting both.
 *
 * Excel and CSV because district offices use both and neither is a safe
 * assumption. Print is the third: a signed hard copy still accompanies most
 * claims.
 */
export function ExportMenu({
  sheet, fileName, note,
}: {
  /** The table exactly as rendered: headers, then one array per row. */
  sheet: SheetSpec;
  /** Without an extension — the same stem is used for every format. */
  fileName: string;
  /** What the file contains, shown beside the buttons. */
  note?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [printing, setPrinting] = React.useState(false);

  /*
   * Which columns go in the file.
   *
   * A village sheet is nineteen columns wide and the note going to the
   * mandal needs four of them. Cutting the other fifteen in Excel afterwards
   * is the step that turns a download into an afternoon.
   *
   * Held by header rather than by index: a column added to the table
   * upstream should not silently change which ones are ticked.
   */
  const headers = React.useMemo(() => sheet.columns.map((c) => c.header), [sheet.columns]);
  const [dropped, setDropped] = React.useState<Set<string>>(() => new Set());

  // Columns that no longer exist stop being dropped, or a header renamed
  // upstream would stay excluded forever with nothing on screen to say so.
  React.useEffect(() => {
    setDropped((prev) => {
      const next = new Set([...prev].filter((h) => headers.includes(h)));
      return next.size === prev.size ? prev : next;
    });
  }, [headers]);

  const keep = React.useMemo(() => {
    const indexes = sheet.columns
      .map((c, i) => (dropped.has(c.header) ? -1 : i))
      .filter((i) => i >= 0);
    return indexes;
  }, [sheet.columns, dropped]);

  /** The sheet as it will actually be written, with dropped columns gone. */
  const cut = React.useMemo<SheetSpec>(() => {
    if (dropped.size === 0) return sheet;
    return {
      ...sheet,
      columns: keep.map((i) => sheet.columns[i]),
      rows: sheet.rows.map((r) => keep.map((i) => r[i] ?? '')),
      title: sheet.title
        ? {
          ...sheet.title,
          // Said on the file itself: a report with columns missing and
          // nothing to say so is one somebody will read as complete.
          extra: [
            ...(sheet.title.extra ?? []),
            ['Columns', `${keep.length} of ${sheet.columns.length} selected`],
          ] as Array<[string, string]>,
        }
        : sheet.title,
    };
  }, [sheet, keep, dropped.size]);

  const empty = cut.rows.length === 0;
  const allOn = dropped.size === 0;

  /*
   * Printing renders the report and waits for the browser to lay it out.
   *
   * Calling print() in the same tick prints the page as it was before React
   * committed the print document, which is the blank page people report.
   */
  const print = () => {
    setPrinting(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.print();
        setPrinting(false);
      });
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1 print:hidden">
      {note ? <span className="mr-1 text-2xs text-text-subtle">{note}</span> : null}

      <Button type="button" variant="ghost"
        title="Choose which columns go in the file"
        onClick={() => setPicking((p) => !p)}>
        {allOn ? 'All columns' : `${keep.length} of ${sheet.columns.length} columns`}
      </Button>

      <Button type="button" variant="ghost" disabled={empty || busy}
        title={empty ? 'Nothing to download yet' : `Download ${cut.rows.length} rows as Excel`}
        onClick={async () => {
          // The logo is fetched before the file is built, so the button has
          // to say it is working — a large report is not instant.
          setBusy(true);
          try { await downloadWorkbook([cut], `${fileName}.xlsx`); }
          finally { setBusy(false); }
        }}>
        {busy ? 'Preparing…' : 'Excel'}
      </Button>

      <Button type="button" variant="ghost" disabled={empty || busy}
        title={empty ? 'Nothing to download yet' : `Download ${cut.rows.length} rows as CSV`}
        onClick={() => downloadCsv(cut, `${fileName}.csv`)}>
        CSV
      </Button>

      <Button type="button" variant="ghost" disabled={empty}
        title="Print the report, or save it as PDF from the print dialogue"
        onClick={print}>
        Print / PDF
      </Button>

      {picking ? (
        <div className="mt-1 w-full rounded-lg border border-border bg-surface-sunken p-2">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-2xs font-medium text-text">Columns in the file</span>
            <Button type="button" variant="ghost" onClick={() => setDropped(new Set())}>
              All
            </Button>
            <Button type="button" variant="ghost"
              /* One column has to survive, or the file is a list of blank
                 rows and the button that made it looked like it worked. */
              onClick={() => setDropped(new Set(headers.slice(1)))}>
              Only the first
            </Button>
            <span className="ml-auto text-2xs text-text-subtle">
              {keep.length} of {sheet.columns.length}
            </span>
          </div>
          <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-3">
            {sheet.columns.map((c) => {
              const on = !dropped.has(c.header);
              const last = on && keep.length === 1;
              return (
                <label key={c.header}
                  className="flex items-center gap-1.5 text-2xs text-text-muted">
                  <input type="checkbox" checked={on} disabled={last}
                    title={last ? 'At least one column has to stay' : undefined}
                    onChange={() => setDropped((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.header)) next.delete(c.header);
                      else next.add(c.header);
                      return next;
                    })} />
                  {c.header}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      {printing ? <PrintDocument sheet={cut} /> : null}
    </div>
  );
}

/**
 * The report as it reaches paper.
 *
 * Rendered into its own root at the end of the document, and print CSS hides
 * everything else on the page. "Print / PDF" used to call window.print() on
 * the whole application — the navigation, the filters, the tab strip — and
 * what came out was a screenshot of software rather than a report anybody
 * could send to a district office.
 *
 * A portal rather than a hidden block inside the page, because a print rule
 * that hides ancestors hides their descendants too: the report has to sit
 * outside everything it is replacing.
 */
function PrintDocument({ sheet }: { sheet: SheetSpec }) {
  const [host, setHost] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const el = document.createElement('div');
    el.id = 'silverline-print-root';
    document.body.appendChild(el);
    setHost(el);
    return () => { el.remove(); };
  }, []);

  if (!host) return null;

  const t: ReportTitle | undefined = sheet.title;
  const lines = t ? titleLines(t) : [];
  /*
   * Landscape once the table is too wide for a portrait page.
   *
   * Nineteen columns down a portrait A4 is four-point type nobody reads. The
   * threshold is rough on purpose — what matters is not printing a wide
   * table onto a narrow page.
   */
  const landscape = sheet.columns.length > 6;

  // A column whose header names a quantity is right-aligned; the numbers in
  // a report are compared down the column, not read across.
  const numeric = sheet.columns.map((c) =>
    /\b(ac|km²|%|days?|no\.?|count|points?|total|extent|qty|quantity|rovers?|crew|staff|villages?)\b/i
      .test(c.header) || /\(.*\)/.test(c.header));

  return createPortal(
    <>
      <style>{`@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 16mm 10mm 12mm; }`}</style>

      <img id="silverline-print-logo" src="/silverline-logo.png" alt="Silverline" />

      {t ? (
        <div className="masthead">
          <h1>{t.heading}</h1>
          <dl>
            {lines.map(([label, value]) => (
              <React.Fragment key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      ) : null}

      <table>
        <thead>
          <tr>
            {sheet.columns.map((c, i) => (
              <th key={c.header} className={numeric[i] ? 'num' : undefined}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((r, ri) => (
            <tr key={ri}>
              {sheet.columns.map((c, ci) => (
                <td key={c.header} className={numeric[ci] ? 'num' : undefined}>
                  {r[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="footnote">
        {sheet.rows.length} row{sheet.rows.length === 1 ? '' : 's'}. Figures are as at the
        moment of printing.
      </p>
    </>,
    host,
  );
}

/** A number as a spreadsheet cell: blank rather than "null" or "0" for nothing. */
export function cellNum(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '';
}

/** A text cell, with nothing rendered as empty rather than as a dash. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s === '—' ? '' : s;
}

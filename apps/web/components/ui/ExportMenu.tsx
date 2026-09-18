'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { downloadCsv, downloadWorkbook, titleLines, type SheetSpec } from '@/lib/xlsx';

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
 * Excel and CSV, because the district offices use both and neither is a
 * safe assumption. Print is the third: a signed hard copy still accompanies
 * most claims, and the browser's own print is better than anything we would
 * write.
 */
export function ExportMenu({
  sheet, fileName, note,
}: {
  /** The table exactly as rendered: headers, then one array per row. */
  sheet: SheetSpec;
  /** Without an extension — the same stem is used for both formats. */
  fileName: string;
  /** What the file contains, shown beside the buttons. */
  note?: string;
}) {
  const empty = sheet.rows.length === 0;
  const [busy, setBusy] = React.useState(false);
  const lines = sheet.title ? titleLines(sheet.title) : [];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {/*
        * The same masthead the file carries, for the printed copy.
        *
        * A page printed from the browser loses the chrome that said which
        * programme and which dates it covered. Hidden on screen because it
        * is already said above it, and printed because there it is not.
        */}
      {sheet.title ? (
        <div className="hidden print:block print:w-full print:border-b print:border-black print:pb-2 print:mb-3">
          <img src="/silverline-logo.png" alt="Silverline" className="mb-1 h-8" />
          <div className="text-base font-semibold text-black">{sheet.title.heading}</div>
          <dl className="mt-0.5 text-xs text-black">
            {lines.map(([label, value]) => (
              <div key={label} className="flex gap-1">
                <dt className="font-medium">{label}:</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {note ? <span className="mr-1 text-2xs text-text-subtle print:hidden">{note}</span> : null}
      <Button type="button" variant="ghost" disabled={empty || busy}
        className="print:hidden"
        title={empty ? 'Nothing to download yet' : `Download ${sheet.rows.length} rows as Excel`}
        onClick={async () => {
          // The logo is fetched before the file is built, so the button has
          // to say it is working — a large report is not instant.
          setBusy(true);
          try { await downloadWorkbook([sheet], `${fileName}.xlsx`); }
          finally { setBusy(false); }
        }}>
        {busy ? 'Preparing…' : 'Excel'}
      </Button>
      <Button type="button" variant="ghost" disabled={empty || busy}
        className="print:hidden"
        title={empty ? 'Nothing to download yet' : `Download ${sheet.rows.length} rows as CSV`}
        onClick={() => downloadCsv(sheet, `${fileName}.csv`)}>
        CSV
      </Button>
      <Button type="button" variant="ghost" className="print:hidden"
        title="Print this page, or save it as PDF from the print dialogue"
        onClick={() => window.print()}>
        Print / PDF
      </Button>
    </div>
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

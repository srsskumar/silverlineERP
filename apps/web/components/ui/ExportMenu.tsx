'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { downloadCsv, downloadWorkbook, type SheetSpec } from '@/lib/xlsx';

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
  return (
    <div className="flex flex-wrap items-center gap-1">
      {note ? <span className="mr-1 text-2xs text-text-subtle">{note}</span> : null}
      <Button type="button" variant="ghost" disabled={empty}
        title={empty ? 'Nothing to download yet' : `Download ${sheet.rows.length} rows as Excel`}
        onClick={() => downloadWorkbook([sheet], `${fileName}.xlsx`)}>
        Excel
      </Button>
      <Button type="button" variant="ghost" disabled={empty}
        title={empty ? 'Nothing to download yet' : `Download ${sheet.rows.length} rows as CSV`}
        onClick={() => downloadCsv(sheet, `${fileName}.csv`)}>
        CSV
      </Button>
      <Button type="button" variant="ghost"
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

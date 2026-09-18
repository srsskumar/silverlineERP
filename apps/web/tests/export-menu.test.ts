import { describe, expect, it } from 'vitest';
import { sheetCsv, titleLines, type SheetSpec } from '../lib/xlsx';

/**
 * Choosing what goes in the file.
 *
 * A village sheet is nineteen columns wide and the note going to the mandal
 * needs four of them. Cutting the other fifteen in Excel afterwards is the
 * step that turns a download into an afternoon.
 *
 * The cutting itself is a pure transformation of the sheet, which is what is
 * tested here — the checkboxes that drive it are a checkbox.
 */
function cut(sheet: SheetSpec, dropped: Set<string>): SheetSpec {
  const keep = sheet.columns
    .map((c, i) => (dropped.has(c.header) ? -1 : i))
    .filter((i) => i >= 0);
  if (dropped.size === 0) return sheet;
  return {
    ...sheet,
    columns: keep.map((i) => sheet.columns[i]),
    rows: sheet.rows.map((r) => keep.map((i) => r[i] ?? '')),
    title: sheet.title
      ? {
        ...sheet.title,
        extra: [
          ...(sheet.title.extra ?? []),
          ['Columns', `${keep.length} of ${sheet.columns.length} selected`],
        ] as Array<[string, string]>,
      }
      : sheet.title,
  };
}

const sheet: SheetSpec = {
  name: 'Villages',
  title: { heading: 'Village list', project: 'Krishna — Resurvey 1' },
  columns: [
    { header: 'Village' }, { header: 'Mandal' },
    { header: 'Extent (Ac)' }, { header: 'Surveyed (Ac)' },
  ],
  rows: [
    ['Adakula', 'Koyyuru', '200', '120'],
    ['Butchampeta', 'Koyyuru', '140', '140'],
  ],
};

describe('choosing the columns that go in the file', () => {
  it('keeps everything when nothing is dropped', () => {
    const out = cut(sheet, new Set());
    expect(out.columns).toHaveLength(4);
    expect(out.rows[0]).toEqual(['Adakula', 'Koyyuru', '200', '120']);
  });

  it('drops a column and the cells under it, together', () => {
    // Dropping a header and leaving its data shifts every value one column
    // left, which files the extent under the mandal.
    const out = cut(sheet, new Set(['Mandal']));
    expect(out.columns.map((c) => c.header)).toEqual(['Village', 'Extent (Ac)', 'Surveyed (Ac)']);
    expect(out.rows[0]).toEqual(['Adakula', '200', '120']);
    expect(out.rows[1]).toEqual(['Butchampeta', '140', '140']);
  });

  it('drops several at once, keeping the rest in their original order', () => {
    const out = cut(sheet, new Set(['Mandal', 'Surveyed (Ac)']));
    expect(out.columns.map((c) => c.header)).toEqual(['Village', 'Extent (Ac)']);
    expect(out.rows[0]).toEqual(['Adakula', '200']);
  });

  it('says on the file itself that columns were left out', () => {
    // A report with columns missing and nothing to say so is one somebody
    // will read as complete.
    const out = cut(sheet, new Set(['Mandal']));
    const stamped = titleLines(out.title!).find(([l]) => l === 'Columns');
    expect(stamped?.[1]).toBe('3 of 4 selected');
  });

  it('says nothing about columns when they are all there', () => {
    const out = cut(sheet, new Set());
    expect(titleLines(out.title!).some(([l]) => l === 'Columns')).toBe(false);
  });

  it('writes the cut sheet, not the whole one', () => {
    const csv = sheetCsv(cut(sheet, new Set(['Mandal', 'Surveyed (Ac)'])));
    expect(csv).toContain('Village,Extent (Ac)');
    expect(csv).not.toContain('Koyyuru');
    expect(csv).toContain('Adakula,200');
  });

  it('leaves a dropped column out of a header that names a filter', () => {
    const out = cut(sheet, new Set(['Mandal']));
    expect(out.columns.some((c) => c.header === 'Mandal')).toBe(false);
  });
});

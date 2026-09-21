import { dayTime } from '@silverline/shared';
/**
 * A very small XLSX writer.
 *
 * Written by hand rather than pulling in a spreadsheet library because the app
 * is a static export shipped to field devices, and the smallest of those
 * libraries is about a megabyte for what amounts to a handful of XML files in
 * a zip. What we need is narrow: a header row, one example row, and dropdowns
 * on the columns that take a fixed set of values.
 *
 * Dropdowns are the reason a template is a spreadsheet at all rather than a
 * CSV. A CSV can state that `status` must be one of four words; a spreadsheet
 * can stop somebody typing a fifth.
 */

/* ------------------------------------------------------------------ zip */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array }

/**
 * A store-only zip — no compression.
 *
 * Deflate would make the file smaller, but a template is a few kilobytes of
 * XML and implementing deflate to save two of them is not a trade worth
 * making. Stored entries are valid zip and every reader accepts them.
 */
export function zipStore(entries: ZipEntry[]): Blob {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),               // no timestamp: templates are not dated
      ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    chunks.push(local, entry.data);

    central.push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
      ...nameBytes,
    ]));
    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((t, c) => t + c.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);

  // Concatenated into one buffer rather than passed as an array of views:
  // TypeScript's BlobPart will not accept a Uint8Array whose backing buffer
  // might be shared, and one allocation for a few kilobytes costs nothing.
  const parts = [...chunks, ...central, end];
  const total = parts.reduce((t, p) => t + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return new Blob([out.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ----------------------------------------------------------------- xlsx */

export interface SheetColumn {
  header: string;
  /** Fixed values this column accepts; becomes a dropdown in the file. */
  options?: string[];
  width?: number;
}

export interface SheetSpec {
  name: string;
  columns: SheetColumn[];
  /** Example rows, in the same order as the columns. */
  rows: string[][];
  /** A masthead above the table saying what this is. */
  title?: ReportTitle;
}

/**
 * What a downloaded report says about itself.
 *
 * A spreadsheet that leaves a meeting is separated from the screen it came
 * from within the hour. Without this it is a grid of numbers nobody can date,
 * attribute or reproduce — and the argument that follows is about whether the
 * figures are current rather than about what they say.
 *
 * Downloaded-on is stamped by the writer rather than passed in: the caller
 * would have to remember, and a report that is wrong about its own date is
 * worse than one that does not carry it.
 */
export interface ReportTitle {
  /** What the report is. */
  heading: string;
  /** The programme or project it covers. */
  project?: string;
  /** The period reported on, already worded. */
  period?: string;
  /** The filters applied, already worded for a reader. */
  filters?: string;
  /** Anything else worth stamping, label then value. */
  extra?: Array<[string, string]>;
}

/** The masthead as label/value lines, in the order they are written. */
export function titleLines(t: ReportTitle): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (t.project) lines.push(['Programme', t.project]);
  if (t.period) lines.push(['Period', t.period]);
  // Stated even when nothing is filtered: "All villages" is information, and
  // its absence is what makes a reader wonder what was left out.
  lines.push(['Filters', t.filters && t.filters.trim() ? t.filters : 'None — everything included']);
  for (const e of t.extra ?? []) lines.push(e);
  // The same spelling as every date on the screen this came from. A
  // spreadsheet that dates itself differently from the report is a
  // spreadsheet somebody has to reconcile by hand.
  lines.push(['Downloaded', dayTime(new Date())]);
  return lines;
}

/**
 * How many rows the masthead occupies, including the blank separator.
 *
 * The logo is anchored over the first rows, so the text starts below it and
 * the two never collide.
 */
export const LOGO_ROWS = 4;
export function titleHeight(t: ReportTitle | undefined): number {
  if (!t) return 0;
  // Logo band, the heading, one row per line, and a blank before the table.
  return LOGO_ROWS + 1 + titleLines(t).length + 1;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A1, B1 … Z1, AA1 — spreadsheet column letters. */
export function columnRef(index: number): string {
  let n = index, ref = '';
  do { ref = String.fromCharCode(65 + (n % 26)) + ref; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return ref;
}

function sheetXml(spec: SheetSpec, validations: string, drawing = ''): string {
  const rows: string[] = [];
  const cells = (values: string[], rowNumber: number) =>
    values.map((v, i) =>
      // inlineStr avoids a shared-string table entirely — one fewer part to
      // keep consistent, at the cost of a slightly larger file.
      `<c r="${columnRef(i)}${rowNumber}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
    ).join('');

  // The masthead, written above the table. The logo is anchored over the
  // first few rows, so the text starts below it.
  let at = 1;
  if (spec.title) {
    at = LOGO_ROWS + 1;
    rows.push(`<row r="${at}">${cells([spec.title.heading], at)}</row>`);
    at += 1;
    for (const [label, value] of titleLines(spec.title)) {
      rows.push(`<row r="${at}">${cells([label, value], at)}</row>`);
      at += 1;
    }
    at += 1; // one blank row, so the table reads as a table
  }

  const headerRow = at;
  rows.push(`<row r="${headerRow}">${cells(spec.columns.map(c => c.header), headerRow)}</row>`);
  spec.rows.forEach((r, i) =>
    rows.push(`<row r="${headerRow + 1 + i}">${cells(r, headerRow + 1 + i)}</row>`));

  const cols = spec.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`)
    .join('');

  // Freeze everything above the first data row, so scrolling a thousand
  // villages keeps the headings and the report's identity in view.
  const freeze = `<sheetViews><sheetView workbookViewId="0">`
    + `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`
    + `</sheetView></sheetViews>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${freeze}
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
${validations}
${drawing}
</worksheet>`;
}

/** Where a column's validation range starts, given the masthead above it. */
function firstDataRow(spec: SheetSpec): number {
  return titleHeight(spec.title) + 2;
}

/**
 * Build an XLSX with one data sheet and a hidden sheet holding the lists.
 *
 * The lists live on their own sheet because a validation formula cannot hold
 * more than 255 characters of inline values — a status list survives that, a
 * list of two hundred employees does not. Referring to a range has no such
 * limit, and it also lets somebody widen a list by editing the sheet.
 */
/**
 * The logo, as bytes, fetched once.
 *
 * Fetched rather than compiled in as base64: it is already served as a static
 * asset, and inlining seven kilobytes of it into every bundle that can export
 * a report is a cost paid by everybody who never downloads one.
 *
 * A failure is not an error. A report without its logo is still the report;
 * refusing to produce one because an image would not load is not.
 */
let logoBytes: Promise<Uint8Array | null> | null = null;
export function silverlineLogo(): Promise<Uint8Array | null> {
  if (!logoBytes) {
    logoBytes = fetch('/silverline-logo.png')
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .then(b => (b ? new Uint8Array(b) : null))
      .catch(() => null);
  }
  return logoBytes;
}

/** The logo's natural size, in EMU (914,400 per inch), scaled to fit. */
const LOGO_W_EMU = 488 * 9525 * 0.75;
const LOGO_H_EMU = 145 * 9525 * 0.75;

export function buildWorkbook(sheets: SheetSpec[], logo?: Uint8Array | null): Blob {
  const listColumns: Array<{ values: string[]; ref: string }> = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  // Only sheets that carry a masthead get the logo over them.
  const withLogo = logo ? sheets.map(sh => Boolean(sh.title)) : sheets.map(() => false);

  // Every option list across every sheet gets a column on the lookup sheet.
  for (const sheet of sheets) {
    for (const column of sheet.columns) {
      if (column.options?.length) {
        const ref = columnRef(listColumns.length);
        listColumns.push({ values: column.options, ref });
      }
    }
  }

  let listIndex = 0;
  const sheetParts = sheets.map((sheet) => {
    const validations: string[] = [];
    sheet.columns.forEach((column, i) => {
      if (!column.options?.length) return;
      const list = listColumns[listIndex];
      listIndex += 1;
      const col = columnRef(i);
      validations.push(
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"` +
        ` errorTitle="Not an allowed value" error="Choose one of the values in the list."` +
        ` sqref="${col}${firstDataRow(sheet)}:${col}${firstDataRow(sheet) + 5000}">` +
        `<formula1>Lists!$${list.ref}$2:$${list.ref}$${list.values.length + 1}</formula1>` +
        `</dataValidation>`,
      );
    });
    const block = validations.length
      ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`
      : '';
    const idx = sheets.indexOf(sheet);
    return sheetXml(sheet, block, withLogo[idx] ? '<drawing r:id="rId1"/>' : '');
  });

  // The lookup sheet: one column per list, with a header naming it.
  const listRows: string[] = [];
  const maxLen = listColumns.reduce((m, l) => Math.max(m, l.values.length), 0);
  listRows.push(`<row r="1">${listColumns.map((l, i) =>
    `<c r="${columnRef(i)}1" t="inlineStr"><is><t>List ${i + 1}</t></is></c>`).join('')}</row>`);
  for (let r = 0; r < maxLen; r += 1) {
    const cells = listColumns.map((l, i) => l.values[r] === undefined ? ''
      : `<c r="${columnRef(i)}${r + 2}" t="inlineStr"><is><t xml:space="preserve">${esc(l.values[r])}</t></is></c>`).join('');
    listRows.push(`<row r="${r + 2}">${cells}</row>`);
  }
  const listsSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${listRows.join('')}</sheetData></worksheet>`;

  const all = [...sheetParts, listsSheet];
  const sheetEntries = all.map((xml, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(xml),
  }));

  const sheetNames = [...sheets.map(s => s.name), 'Lists'];
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetNames.map((n, i) =>
    // The lookup sheet is hidden: it is machinery, and a reader who sees it
    // wonders whether they are supposed to fill it in.
    `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"${n === 'Lists' ? ' state="hidden"' : ''}/>`,
  ).join('')}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${all.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('')}</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${all.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('')}${logo
    ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
    : ''}</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  /*
   * The logo, anchored over the masthead of each sheet that has one.
   *
   * oneCellAnchor pins it to A1 at its own size rather than stretching it
   * across a cell range: a logo that resizes with somebody's column widths
   * stops looking like the logo.
   */
  const drawingParts: Array<{ name: string; data: Uint8Array }> = [];
  if (logo) {
    const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:oneCellAnchor>
<xdr:from><xdr:col>0</xdr:col><xdr:colOff>47625</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>47625</xdr:rowOff></xdr:from>
<xdr:ext cx="${Math.round(LOGO_W_EMU)}" cy="${Math.round(LOGO_H_EMU)}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="1" name="Silverline"/><xdr:cNvPicPr/></xdr:nvPicPr>
<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>
</xdr:wsDr>`;
    const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/silverline.png"/>
</Relationships>`;
    drawingParts.push(
      { name: 'xl/media/silverline.png', data: logo },
      { name: 'xl/drawings/drawing1.xml', data: enc(drawingXml) },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: enc(drawingRels) },
    );
    // One drawing part, shared: the same image on every masthead sheet.
    withLogo.forEach((has, i) => {
      if (!has) return;
      drawingParts.push({
        name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`),
      });
    });
  }

  return zipStore([
    { name: '[Content_Types].xml', data: enc(contentTypes) },
    { name: '_rels/.rels', data: enc(rootRels) },
    { name: 'xl/workbook.xml', data: enc(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc(workbookRels) },
    ...sheetEntries,
    ...drawingParts,
  ]);
}

export async function downloadWorkbook(sheets: SheetSpec[], fileName: string): Promise<void> {
  // A missing logo is not a reason to withhold the report.
  const logo = sheets.some(s => s.title) ? await silverlineLogo() : null;
  const url = URL.createObjectURL(buildWorkbook(sheets, logo));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ------------------------------------------------------------------ csv */

/** A CSV cell, quoted only where it has to be. */
const csvCell = (value: string) =>
  /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/**
 * The same sheet as CSV, for anyone who would rather not open a workbook.
 *
 * What is lost is the dropdowns — the whole reason the template is a
 * spreadsheet — so the allowed values have to be written down somewhere the
 * reader will see them. `optionsNote` below is that somewhere.
 */
export function sheetCsv(spec: SheetSpec): string {
  const lines: string[] = [];
  /*
   * The masthead, as leading lines.
   *
   * It makes the file something other than bare CSV, which is the point: a
   * grid of numbers nobody can date or attribute is what this exists to stop.
   * Anything reading it as data should skip to the header row, and the blank
   * line marks where that is.
   */
  if (spec.title) {
    lines.push(csvCell(spec.title.heading));
    for (const [label, value] of titleLines(spec.title)) {
      lines.push(`${csvCell(label)},${csvCell(value)}`);
    }
    lines.push('');
  }
  lines.push(spec.columns.map((c) => csvCell(c.header)).join(','));
  for (const row of spec.rows) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

/** What a CSV cannot enforce, spelled out in prose instead. */
export function optionsNote(spec: SheetSpec): string[] {
  return spec.columns
    .filter((c) => c.options?.length)
    .map((c) => {
      const values = c.options ?? [];
      // A list of two hundred names is not a note; point at the workbook.
      const shown = values.length > 12
        ? `${values.slice(0, 6).join(', ')} and ${values.length - 6} more (the Excel file lists them all)`
        : values.join(', ');
      return `${c.header} must be one of: ${shown}`;
    });
}

export function downloadCsv(spec: SheetSpec, fileName: string): void {
  const url = URL.createObjectURL(new Blob([sheetCsv(spec)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

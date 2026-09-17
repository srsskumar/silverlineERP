/**
 * Reading an Excel file, without a library.
 *
 * The templates are offered as Excel first, because its dropdowns stop the
 * mis-typed enum that causes most rejections — and then the upload only took
 * CSV, so everyone who took the recommended path had to convert the file back
 * before they could submit it. The recommendation and the only working route
 * pointed in opposite directions.
 *
 * An .xlsx file is a ZIP holding XML. This reads the ZIP's central directory,
 * inflates the two parts that matter — the sheet and the shared string table —
 * and walks the cells. No dependency, for the same reason lib/xlsx.ts writes
 * one by hand: this is a static bundle a field user downloads over a mobile
 * connection, and a spreadsheet library is a large thing to ship for a
 * file format we only need two corners of.
 */

const decoder = new TextDecoder();

/** One row per sheet row, one string per cell, trimmed of trailing blanks. */
export async function readXlsx(file: ArrayBuffer): Promise<string[][]> {
  const entries = readZip(new Uint8Array(file));

  const sheetName = Object.keys(entries).find((n) => /^xl\/worksheets\/sheet1\.xml$/i.test(n))
    ?? Object.keys(entries).find((n) => /^xl\/worksheets\/.*\.xml$/i.test(n));
  if (!sheetName) throw new Error('That file has no worksheet in it.');

  const shared = entries['xl/sharedStrings.xml']
    ? parseSharedStrings(decoder.decode(await inflate(entries['xl/sharedStrings.xml'])))
    : [];
  return parseSheet(decoder.decode(await inflate(entries[sheetName])), shared);
}

/* ------------------------------------------------------------------ zip */

interface ZipPart { method: number; bytes: Uint8Array }

/**
 * The entries of a ZIP, read from its central directory.
 *
 * Read from the directory at the end rather than by walking local headers
 * from the front: a local header may declare sizes of zero and defer them to
 * a data descriptor after the payload, which cannot be parsed without already
 * knowing where the payload ends. The central directory always carries the
 * real sizes.
 */
function readZip(buf: Uint8Array): Record<string, ZipPart> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // End-of-central-directory, scanned backwards: it is last, and its comment
  // field means it is not at a fixed offset.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_536; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That does not look like an Excel file.');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: Record<string, ZipPart> = {};

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));

    // The local header's own name and extra lengths, which differ from the
    // central directory's, decide where the payload actually starts.
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localNameLen + localExtraLen;
    out[name] = { method, bytes: buf.subarray(start, start + compressed) };

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Stored parts pass through; deflated ones go through the platform. */
async function inflate(part: ZipPart): Promise<Uint8Array> {
  if (part.method === 0) return part.bytes;
  if (part.method !== 8) throw new Error('That file uses a compression this reader cannot open.');
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot open Excel files. Save the sheet as CSV instead.');
  }
  const stream = new Blob([part.bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ xml */

/**
 * The shared string table.
 *
 * Excel stores most text once here and refers to it by index from the cells.
 * A string can be split across several <t> runs when part of it is formatted
 * differently, so the runs are joined rather than the first one taken —
 * otherwise "Ground truthing" comes back as "Ground".
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const [, item] of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const [, run] of item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(run);
    out.push(text);
  }
  return out;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cell of rowXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const body = cell[2] ?? '';
      // Empty cells are omitted from the XML entirely, so the column letter
      // is what says where a value belongs. Reading positionally instead
      // shifts every value after a blank cell one column left.
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : row.length;
      while (row.length < index) row.push('');
      row[index] = cellText(attrs, body, shared);
    }
    rows.push(row);
  }
  return rows;
}

function cellText(attrs: string, body: string, shared: string[]): string {
  const type = /t="([^"]+)"/.exec(attrs)?.[1];
  if (type === 's') {
    const i = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
    return shared[i] ?? '';
  }
  // An inline string, written when a sheet does not use the shared table.
  if (type === 'inlineStr') {
    let text = '';
    for (const [, run] of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(run);
    return text;
  }
  return unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '').trim();
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unescapeXml(s: string): string {
  return s
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

import { describe, expect, it } from 'vitest';
import { readXlsx, columnIndex } from '../lib/xlsx-read';
import { buildWorkbook } from '../lib/xlsx';

/**
 * Round-tripped through the writer this app already ships.
 *
 * A hand-made fixture would only prove the reader agrees with whatever I
 * imagined an .xlsx to be. Reading back a workbook the app itself produced
 * proves the two halves agree, which is the case that actually happens: a
 * user downloads our template, fills it in, and uploads it again.
 */
async function roundTrip(rows: string[][]): Promise<string[][]> {
  const blob = buildWorkbook([{
    name: 'Sheet', columns: rows[0].map((h) => ({ header: h })), rows: rows.slice(1),
  }]);
  return readXlsx(await blob.arrayBuffer());
}

describe('reading back a workbook this app wrote', () => {
  it('returns the header row and the data rows', async () => {
    const out = await roundTrip([
      ['code', 'name', 'category'],
      ['AST-1', 'Rover 1', 'ELECTRONIC'],
      ['AST-2', 'Rover 2', 'ELECTRONIC'],
    ]);
    expect(out[0]).toEqual(['code', 'name', 'category']);
    expect(out[1]).toEqual(['AST-1', 'Rover 1', 'ELECTRONIC']);
    expect(out).toHaveLength(3);
  });

  it('keeps a blank cell in its own column', async () => {
    // Excel omits empty cells from the XML entirely. Reading positionally
    // shifts every value after a blank one column left, which silently files
    // the model under the make.
    const out = await roundTrip([
      ['code', 'make', 'model'],
      ['AST-1', '', 'R12i'],
    ]);
    expect(out[1]).toEqual(['AST-1', '', 'R12i']);
  });

  it('keeps text that Excel would store in the shared table', async () => {
    const out = await roundTrip([
      ['reason'],
      ['Ground truthing, Koyyuru mandal'],
    ]);
    expect(out[1][0]).toBe('Ground truthing, Koyyuru mandal');
  });

  it('survives the characters XML has to escape', async () => {
    const out = await roundTrip([
      ['note'],
      ['Cracked & bent <left> "arm"'],
    ]);
    expect(out[1][0]).toBe('Cracked & bent <left> "arm"');
  });

  it('refuses a file that is not a workbook, in words', async () => {
    const notAZip = new TextEncoder().encode('code,name\nAST-1,Rover').buffer;
    await expect(readXlsx(notAZip)).rejects.toThrow(/does not look like an Excel file/);
  });
});

describe('column references', () => {
  it('maps letters to positions', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('Z')).toBe(25);
    expect(columnIndex('AA')).toBe(26);
    expect(columnIndex('AB')).toBe(27);
  });
});

describe('a workbook Excel itself would produce', () => {
  /*
   * Our own writer stores entries uncompressed, so the round-trip above never
   * exercises inflation — and every file a user actually uploads comes out of
   * Excel deflated. This builds a deflated ZIP by hand so that path is
   * covered by something other than hope.
   */
  async function deflatedXlsx(sheetXml: string): Promise<ArrayBuffer> {
    const name = 'xl/worksheets/sheet1.xml';
    const raw = new TextEncoder().encode(sheetXml);
    const deflated = new Uint8Array(await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer());

    const nameBytes = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + nameBytes.length + deflated.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);                       // method: deflate
    lv.setUint32(18, deflated.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(deflated, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, deflated.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, 0, true);                      // local header offset
    central.set(nameBytes, 46);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, local.length, true);

    const out = new Uint8Array(local.length + central.length + eocd.length);
    out.set(local, 0);
    out.set(central, local.length);
    out.set(eocd, local.length + central.length);
    return out.buffer;
  }

  it('inflates a deflated sheet', async () => {
    const xml = '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c>'
      + '<c r="B1" t="inlineStr"><is><t>name</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>AST-9</t></is></c>'
      + '<c r="B2" t="inlineStr"><is><t>Rover 9</t></is></c></row>'
      + '</sheetData></worksheet>';
    const rows = await readXlsx(await deflatedXlsx(xml));
    expect(rows[0]).toEqual(['code', 'name']);
    expect(rows[1]).toEqual(['AST-9', 'Rover 9']);
  });

  it('places a value by its column letter when earlier cells are missing', async () => {
    // Excel writes no <c> at all for an untouched cell, so C2 with no B2 must
    // still land in the third column.
    const xml = '<worksheet><sheetData>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>AST-9</t></is></c>'
      + '<c r="C2" t="inlineStr"><is><t>R12i</t></is></c></row>'
      + '</sheetData></worksheet>';
    const rows = await readXlsx(await deflatedXlsx(xml));
    expect(rows[0]).toEqual(['AST-9', '', 'R12i']);
  });
});

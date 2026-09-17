import { parseCsv } from './csv';

/**
 * Reading the village list the revenue department issues (§59.3.3).
 *
 * The CSV reader itself is the one already used by the employee importer —
 * it handles the quoted field containing a comma, which is what a village
 * name will produce on the first day. What is here is only the mapping from
 * their column names to ours.
 */

/** Fold a header to a comparable key: lower case, spaces and dots to underscore. */
export function normaliseHeader(header: string): string {
  return header.trim().toLowerCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Their column names, mapped onto the importer's.
 *
 * Keyed on what `normaliseHeader` produces for the headings in the source
 * spreadsheet, so the file can be pasted in exactly as it arrives. Asking
 * somebody to rename fourteen columns by hand first is how an import gets
 * abandoned.
 */
export const VILLAGE_COLUMN_ALIASES: Record<string, string> = {
  districtcode: 'district_code',
  district_code: 'district_code',
  district_name: 'district_name',
  divisioncode: 'division_code',
  division_code: 'division_code',
  division_name: 'division_name',
  mandalcode: 'mandal_code',
  mandal_code: 'mandal_code',
  mandal_name: 'mandal_name',
  villagecode: 'village_code',
  village_code: 'village_code',
  village_name: 'village_name',
  vill_code_old: 'vill_code_old',
  total_extent_in_ac: 'total_extent_ac',
  total_extent_ac: 'total_extent_ac',
  extent_in_ac: 'total_extent_ac',
  extent_in_acres: 'total_extent_ac',
  // "No.of DGPS Istruments" as the source sheet spells it, typo and all.
  no_of_dgps_istruments: 'dgps_base',
  no_of_dgps_instruments: 'dgps_base',
  dgps_base: 'dgps_base',
  base: 'dgps_base',
  moving_rovers: 'dgps_rovers',
  dgps_rovers: 'dgps_rovers',
  no_of_teams: 'teams',
  teams: 'teams',
};

/**
 * A CSV of villages, as rows the importer will accept.
 *
 * Columns it does not recognise are dropped rather than passed on: the source
 * sheet carries an SL.NO and several running-total columns that mean nothing
 * to the importer, and forwarding them would only produce validation noise.
 */
export function readVillageCsv(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text).filter(r => r.some(cell => cell.trim() !== ''));
  if (rows.length < 2) return [];
  const headers = rows[0].map(normaliseHeader);
  return rows.slice(1).map((cells) => {
    const out: Record<string, string> = {};
    headers.forEach((h, i) => {
      const mapped = VILLAGE_COLUMN_ALIASES[h];
      if (!mapped) return;
      const value = (cells[i] ?? '').trim();
      // A blank cell is left out rather than sent as an empty string: an
      // empty extent coerced to zero and was then refused for not being
      // positive, so a village with no extent recorded could not be loaded
      // at all.
      if (value !== '') out[mapped] = value;
    });
    return out;
  });
}

/** What the file is missing, so the reader is told before they import. */
export function missingColumns(rows: Array<Record<string, string>>): string[] {
  if (rows.length === 0) return [];
  const required = ['district_code', 'district_name', 'mandal_code', 'mandal_name',
    'village_code', 'village_name'];
  /*
   * A column is missing when no row carries it — not when the first row
   * happens to leave it blank.
   *
   * Blank cells are now dropped rather than sent as empty strings, so
   * checking only the first row would report a column as absent because one
   * village had no district recorded. That warning would send somebody back
   * to fix a file that has nothing wrong with it.
   */
  const present = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) present.add(key);
  return required.filter(c => !present.has(c));
}

/**
 * Village codes that appear more than once in an uploaded file.
 *
 * A work list of 1,399 rows produced 1,183 villages, and the importer
 * reported the other 216 as "already listed" — which read as though they
 * were in the programme beforehand. They were not: the file itself repeated
 * them. The distinction matters, because one means you are re-running an
 * import and the other means the list you were given has duplicate rows in
 * it, which is worth knowing before anybody reconciles a count.
 *
 * Detected here rather than at the server because only the client sees the
 * whole file: the upload is sent in batches, and a row repeated across two
 * batches is invisible to either request on its own.
 */
export function duplicateVillageCodes(
  rows: Array<Record<string, string>>,
): Array<{ code: string; rows: number[] }> {
  const seen = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const code = (row.village_code ?? '').trim();
    if (!code) return;
    const at = seen.get(code);
    if (at) at.push(index + 1);
    else seen.set(code, [index + 1]);
  });
  return [...seen.entries()]
    .filter(([, at]) => at.length > 1)
    .map(([code, at]) => ({ code, rows: at }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

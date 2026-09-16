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
      if (mapped) out[mapped] = (cells[i] ?? '').trim();
    });
    return out;
  });
}

/** What the file is missing, so the reader is told before they import. */
export function missingColumns(rows: Array<Record<string, string>>): string[] {
  if (rows.length === 0) return [];
  const required = ['district_code', 'district_name', 'mandal_code', 'mandal_name',
    'village_code', 'village_name'];
  return required.filter(c => !(c in rows[0]));
}

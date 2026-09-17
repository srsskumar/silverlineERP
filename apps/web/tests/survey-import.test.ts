import { describe, expect, it } from 'vitest';
import {
  normaliseHeader, readVillageCsv, missingColumns, VILLAGE_COLUMN_ALIASES,
  duplicateVillageCodes,
} from '../lib/survey-import';

/** The header row of the source spreadsheet, verbatim. */
const SOURCE_HEADER =
  'DistrictCode,District Name,DivisionCode,Division Name,MandalCode,Mandal Name,Village Code,Village Name,vill_code_old';
const SOURCE_ROW = '15,Alluri Sitharama Raju,1,Paderu,11,KOYYURU,1511077,ADAKULA,314077';

describe('normaliseHeader', () => {
  it('folds the spellings the source file uses', () => {
    expect(normaliseHeader('District Name')).toBe('district_name');
    expect(normaliseHeader('No.of Teams')).toBe('no_of_teams');
    expect(normaliseHeader('  Village Code  ')).toBe('village_code');
    expect(normaliseHeader('DistrictCode')).toBe('districtcode');
  });
});

describe('readVillageCsv', () => {
  it('reads the source file as it arrives, without anything being renamed', () => {
    const rows = readVillageCsv(`${SOURCE_HEADER}\n${SOURCE_ROW}`);
    expect(rows).toEqual([{
      district_code: '15', district_name: 'Alluri Sitharama Raju',
      division_code: '1', division_name: 'Paderu',
      mandal_code: '11', mandal_name: 'KOYYURU',
      village_code: '1511077', village_name: 'ADAKULA', vill_code_old: '314077',
    }]);
  });

  it('keeps a comma inside a quoted village name', () => {
    // The first thing this will meet in a real file.
    const rows = readVillageCsv(
      `${SOURCE_HEADER}\n15,Alluri,1,Paderu,11,KOYYURU,1511077,"Ramapuram, East",314077`);
    expect(rows[0].village_name).toBe('Ramapuram, East');
  });

  it('drops the columns the importer has no use for', () => {
    // The source sheet carries SL.NO and a page of running totals; forwarding
    // them would only produce validation noise.
    const rows = readVillageCsv(
      `SL.NO,${SOURCE_HEADER},Today,Cumulative\n1,${SOURCE_ROW},4,40`);
    expect(rows[0]).not.toHaveProperty('sl_no');
    expect(rows[0]).not.toHaveProperty('today');
    expect(rows[0].village_code).toBe('1511077');
  });

  it('maps the extent and equipment columns', () => {
    const rows = readVillageCsv(
      'Village Code,Village Name,Total extent in Ac,Base,Moving rovers,No.of Teams\n1511077,ADAKULA,16.82,1,3,2');
    expect(rows[0]).toMatchObject({
      total_extent_ac: '16.82', dgps_base: '1', dgps_rovers: '3', teams: '2',
    });
  });

  it('survives the carriage returns Excel on Windows writes', () => {
    const rows = readVillageCsv(`${SOURCE_HEADER}\r\n${SOURCE_ROW}\r\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].village_name).toBe('ADAKULA');
  });

  it('returns nothing for a header with no rows under it', () => {
    expect(readVillageCsv(SOURCE_HEADER)).toEqual([]);
    expect(readVillageCsv('')).toEqual([]);
  });

  it('leaves an optional column empty rather than absent', () => {
    const rows = readVillageCsv(
      'District Name,DistrictCode,MandalCode,Mandal Name,Village Code,Village Name,DivisionCode,Division Name\nAlluri,15,11,KOYYURU,1511077,ADAKULA,,');
    expect(rows[0].division_code).toBe('');
    expect(rows[0].division_name).toBe('');
  });
});

describe('missingColumns', () => {
  it('names what the file is missing before anybody imports it', () => {
    const rows = readVillageCsv('Village Code,Village Name\n1511077,ADAKULA');
    expect(missingColumns(rows)).toContain('district_code');
    expect(missingColumns(rows)).toContain('mandal_name');
  });

  it('is satisfied by the source file', () => {
    expect(missingColumns(readVillageCsv(`${SOURCE_HEADER}\n${SOURCE_ROW}`))).toEqual([]);
  });

  it('says nothing about an empty file', () => {
    expect(missingColumns([])).toEqual([]);
  });
});

describe('the alias table', () => {
  it('maps every alias onto a column the importer accepts', () => {
    const accepted = new Set([
      'district_code', 'district_name', 'division_code', 'division_name',
      'mandal_code', 'mandal_name', 'village_code', 'village_name',
      'vill_code_old', 'total_extent_ac', 'dgps_base', 'dgps_rovers', 'teams',
    ]);
    for (const target of Object.values(VILLAGE_COLUMN_ALIASES)) {
      expect(accepted, target).toContain(target);
    }
  });
});

describe('repeated rows in an uploaded village list', () => {
  it('finds a code that appears more than once, and where', () => {
    /*
     * A 1,399-row file produced 1,183 villages and reported 216 "already
     * listed", which read as though they were in the programme beforehand.
     * They were not — the file repeated them. Saying so before the upload
     * is the difference between a reconciled count and an afternoon spent
     * looking for 216 villages that were never missing.
     */
    const rows = [
      { village_code: '1511077', village_name: 'ADAKULA' },
      { village_code: '1511078', village_name: 'BOMMIKA' },
      { village_code: '1511077', village_name: 'ADAKULA' },
      { village_code: '1511077', village_name: 'Adakula (dup)' },
    ];
    const dups = duplicateVillageCodes(rows);
    expect(dups).toHaveLength(1);
    expect(dups[0].code).toBe('1511077');
    expect(dups[0].rows).toEqual([1, 3, 4]);
  });

  it('says nothing when every code is distinct', () => {
    expect(duplicateVillageCodes([
      { village_code: 'A', village_name: 'One' },
      { village_code: 'B', village_name: 'Two' },
    ])).toEqual([]);
  });

  it('ignores rows with no code rather than grouping them together', () => {
    // Blank codes are a different fault, reported by the importer per row.
    expect(duplicateVillageCodes([
      { village_code: '', village_name: 'One' },
      { village_code: '   ', village_name: 'Two' },
    ])).toEqual([]);
  });

  it('puts the worst repeat first', () => {
    const dups = duplicateVillageCodes([
      { village_code: 'A', village_name: 'x' }, { village_code: 'A', village_name: 'x' },
      { village_code: 'B', village_name: 'y' }, { village_code: 'B', village_name: 'y' },
      { village_code: 'B', village_name: 'y' },
    ]);
    expect(dups[0].code).toBe('B');
  });
});

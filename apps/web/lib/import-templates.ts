/**
 * Download templates for the bulk-import formats.
 *
 * Without one, the first thing anybody importing does is guess at the column
 * names, get a page of validation errors, and guess again. A template that
 * carries the exact headers the parser recognises plus one filled example row
 * turns that into a file they edit and upload.
 *
 * The example row is real, valid data rather than "string, string, string":
 * somebody reading it needs to see that a date is 1990-07-24 and not 24/07/90,
 * which is the mistake a placeholder invites.
 */

import { downloadWorkbook, type SheetSpec } from './xlsx';

export interface ImportTemplate {
  key: string;
  label: string;
  fileName: string;
  description: string;
  /** Columns the importer recognises, in the order they read best. */
  headers: string[];
  /** Columns that must carry a value for a row to be accepted. */
  required: string[];
  /** One row of realistic data, so the expected formats are unambiguous. */
  example: string[];
  /**
   * Columns that accept a fixed set of values, keyed by header.
   *
   * In the CSV these are only documented; in the Excel file they become
   * dropdowns, which is the difference between a rule stated and a rule
   * enforced. Most import failures are a mis-typed enum.
   */
  options?: Record<string, string[]>;
  notes: string[];
}

export const IMPORT_TEMPLATES: ImportTemplate[] = [
  {
    key: 'employees',
    label: 'Employees',
    fileName: 'silverline-employees-template.csv',
    description: 'Staff records, including bank and statutory identifiers.',
    /*
     * No emp_no column.
     *
     * The server allocates the next number. Nobody filling in two hundred
     * rows should be inventing unique identifiers, and the ones people invent
     * collide — two people typing "the next number" at the same time produce
     * the same number, and one import fails on a constraint nobody expected.
     * A number can still be sent by anyone migrating from a system where the
     * numbers are already printed on ID cards; it is simply not asked for.
     */
    headers: [
      'first_name', 'last_name', 'father_name', 'date_of_birth', 'gender',
      'phone', 'phone_secondary', 'email', 'address',
      'designation', 'department', 'date_of_joining', 'status',
      'salary_basic', 'education', 'experience_years', 'skills',
      'aadhaar', 'pan', 'bank_name', 'bank_account', 'bank_ifsc', 'phonepe_number',
    ],
    required: ['first_name', 'last_name', 'phone'],
    options: {
      gender: ['MALE', 'FEMALE', 'OTHER'],
      status: ['ACTIVE', 'SUSPENDED', 'EXITED'],
    },
    example: [
      'Anitha', 'Devi', 'Ramesh Devi', '1990-07-24', 'FEMALE',
      '+919876543210', '', 'anitha.devi@example.com', '12 MG Road, Hyderabad',
      'Site Engineer', 'Projects', '2023-04-01', 'ACTIVE',
      '35000', 'B.E. Civil', '6', 'Survey;AutoCAD',
      '234567890123', 'ABCPD1234E', 'HDFC Bank', '50100123456789', 'HDFC0001234', '+919876543210',
    ],
    notes: [
      'The employee number is allocated on upload, counting on from the highest already issued.',
      'Dates are YYYY-MM-DD. A date written 24/07/1990 is rejected.',
      'Phone numbers keep the country code, and must be unique within the organisation.',
      'Aadhaar, PAN and bank details are encrypted at rest and never appear in an export.',
      'Leave a column blank rather than writing "NA" — the text is stored as given.',
      'status is ACTIVE, SUSPENDED or EXITED.',
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory items',
    fileName: 'silverline-inventory-template.csv',
    description: 'The material master: what an item is, how it is measured, when to reorder.',
    headers: [
      'code', 'name', 'category', 'unit', 'alt_uom', 'conversion_factor',
      'hsn_code', 'gst_rate_pct', 'unit_cost',
      'batch_tracked', 'serial_tracked', 'reorder_level', 'reorder_quantity', 'status',
    ],
    required: ['code', 'name', 'unit'],
    options: {
      unit: ['KG', 'GM', 'TON', 'LTR', 'ML', 'MTR', 'SQM', 'CUM', 'NOS', 'BAG', 'ROLL', 'SET'],
      batch_tracked: ['true', 'false'],
      serial_tracked: ['true', 'false'],
      status: ['ACTIVE', 'INACTIVE'],
    },
    example: [
      'CEM-OPC-53', 'OPC 53 Grade Cement', 'Civil', 'KG', 'BAG', '50',
      '2523', '28', '7.40',
      'true', 'false', '2000', '10000', 'ACTIVE',
    ],
    notes: [
      'unit is the base unit every stock figure is held in.',
      'alt_uom is what the item is bought or issued in. Supply conversion_factor with it — how many base units one alternate unit contains — or quantities entered in it are silently wrong.',
      'reorder_level is measured against free stock, not stock on hand: material entirely reserved still needs reordering.',
      'batch_tracked and serial_tracked are true or false. A tracked item cannot be received without the batch or serial.',
    ],
  },
  {
    key: 'survey-villages',
    label: 'Survey villages',
    fileName: 'silverline-survey-villages-template.csv',
    description: 'The villages to be surveyed, as the revenue department supplies the list.',
    headers: [
      'district_code', 'district_name', 'division_code', 'division_name',
      'mandal_code', 'mandal_name', 'village_code', 'village_name', 'vill_code_old',
      'total_extent_ac', 'dgps_base', 'dgps_rovers', 'teams',
    ],
    required: ['district_code', 'district_name', 'mandal_code', 'mandal_name',
      'village_code', 'village_name'],
    example: [
      '15', 'Alluri Sitharama Raju', '1', 'Paderu',
      '11', 'KOYYURU', '1511077', 'ADAKULA', '314077',
      '16.82', '1', '3', '2',
    ],
    notes: [
      'The columns match the list the revenue department issues, so it can be pasted in as it arrives.',
      'Codes are what reconciliation is done on, not names. Two villages called Ramapuram in one district is ordinary.',
      'vill_code_old carries the previous code, which is how the earlier records are matched.',
      'division_code and division_name may be left blank where a mandal reports straight to the district.',
      'total_extent_ac is the denominator for every extent-based percentage. A village without one is counted but left out of the completion figure.',
      'Extent in square kilometres is worked out from the acres and must not be supplied — two columns holding one quantity disagree the moment either is edited.',
    ],
  },
  {
    key: 'assets',
    label: 'Assets',
    fileName: 'silverline-assets-template.csv',
    description: 'Equipment issued to people and sites, with what it is and what state it is in.',
    /*
     * These are the register's actual columns.
     *
     * The template used to offer purchase_date, purchase_cost, warranty_until
     * and notes, none of which the assets table has, and a status of
     * IN_REPAIR or RETIRED, which it does not accept. Anybody who filled it
     * in got a file the system could not take — which is worse than no
     * template, because it looks like the system's fault.
     */
    /*
     * The same field names the register form uses.
     *
     * The template said `code` where the form says asset code, and offered
     * no vendor at all — so somebody filling in the sheet was working from a
     * different vocabulary than the screen beside it, and had to guess which
     * of the two was right.
     */
    headers: [
      'asset_code', 'name', 'category', 'asset_type', 'serial_number',
      'make', 'model', 'condition', 'condition_note',
    ],
    required: ['asset_code', 'name', 'category'],
    options: {
      category: ['ELECTRONIC', 'ELECTRICAL', 'ACCESSORY'],
      asset_type: [
        'ROVER', 'DRONE', 'TRIPOD', 'BIPOD', 'EXTERNAL_RADIO',
        'EXTERNAL_RADIO_ANTENNA', 'EXTERNAL_BATTERY', 'LAPTOP', 'CPU',
        'MONITOR', 'OTHER',
      ],
      condition: ['BRAND_NEW', 'EXCELLENT', 'GOOD', 'REPAIR', 'UNUSABLE', 'OTHER'],
    },
    example: [
      'AST-RV-014', 'Rover 14', 'ELECTRONIC', 'ROVER', 'TS2024X0914',
      'Trimble', 'R12i', 'GOOD', '',
    ],
    notes: [
      'asset_code is how the asset is referred to everywhere else, and must be unique. It is the same field the register form calls Asset code.',
      'category and asset_type must already exist — add new ones under Assets first.',
      'serial_number identifies the physical unit: an upload matches on it, so a second row with the same serial updates that unit rather than creating another.',
      'Accessories are the exception — they match on code, because a box of screws has no serial worth trusting.',
      'condition_note is required when condition is OTHER.',
    ],
  },
  {
    key: 'asset-allocation',
    label: 'Asset allocation',
    fileName: 'silverline-asset-allocation-template.csv',
    description: 'Who currently holds which asset, and for which project.',
    headers: [
      'asset_code', 'emp_no', 'project_code', 'issued_on', 'due_date',
      'condition', 'reason',
    ],
    required: ['asset_code', 'emp_no', 'reason'],
    options: {
      condition: ['BRAND_NEW', 'EXCELLENT', 'GOOD', 'REPAIR', 'UNUSABLE', 'OTHER'],
    },
    example: [
      'AST-RV-014', 'EMPSLV001001', 'SURVEY-AP-01', '2026-09-01', '2026-12-31',
      'GOOD', 'Ground truthing, Koyyuru mandal',
    ],
    notes: [
      'One row per asset currently out. An asset already allocated to somebody else is reported rather than silently moved.',
      'condition is the state it went out in — what it comes back in is recorded at the return, by whoever receives it.',
      'project_code may be blank for equipment issued without a project.',
      'Dates are YYYY-MM-DD.',
    ],
  },
];

/**
 * The template as a sheet, which is what both downloads are built from.
 *
 * One definition rather than two means the CSV and the Excel file cannot
 * drift apart in their columns, which is exactly the bug a reader would be
 * least able to diagnose.
 */
export function templateSheet(template: ImportTemplate): SheetSpec {
  return {
    name: template.label,
    columns: template.headers.map((header) => ({
      header,
      options: template.options?.[header],
      width: header.length > 14 ? 24 : 16,
    })),
    rows: [template.example],
  };
}

/** A CSV cell, quoted only where it has to be. */
function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The template as CSV text: a header row and one example row.
 *
 * The example is deliberately included rather than left as an empty template.
 * A blank second row tells the reader nothing about whether a date is
 * day-first, or whether a boolean is "true" or "Yes".
 */
export function templateCsv(template: ImportTemplate): string {
  return `${template.headers.map(cell).join(',')}\n${template.example.map(cell).join(',')}\n`;
}

/** The same template as an Excel workbook, with the fixed columns as dropdowns. */
export function downloadTemplateWorkbook(template: ImportTemplate): void {
  downloadWorkbook([templateSheet(template)], template.fileName.replace(/\.csv$/, '.xlsx'));
}

/** Trigger a download of the template in the browser. */
export function downloadTemplate(template: ImportTemplate): void {
  const blob = new Blob([templateCsv(template)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = template.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously races the download in
  // some browsers and produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
  notes: string[];
}

export const IMPORT_TEMPLATES: ImportTemplate[] = [
  {
    key: 'employees',
    label: 'Employees',
    fileName: 'silverline-employees-template.csv',
    description: 'Staff records, including bank and statutory identifiers.',
    headers: [
      'emp_no', 'first_name', 'last_name', 'father_name', 'date_of_birth', 'gender',
      'phone', 'phone_secondary', 'email', 'address',
      'designation', 'department', 'date_of_joining', 'status',
      'salary_basic', 'education', 'experience_years', 'skills',
      'aadhaar', 'pan', 'bank_name', 'bank_account', 'bank_ifsc', 'phonepe_number',
    ],
    required: ['emp_no', 'first_name', 'last_name', 'phone'],
    example: [
      'EMP001', 'Anitha', 'Devi', 'Ramesh Devi', '1990-07-24', 'FEMALE',
      '+919876543210', '', 'anitha.devi@example.com', '12 MG Road, Hyderabad',
      'Site Engineer', 'Projects', '2023-04-01', 'ACTIVE',
      '35000', 'B.E. Civil', '6', 'Survey;AutoCAD',
      '234567890123', 'ABCPD1234E', 'HDFC Bank', '50100123456789', 'HDFC0001234', '+919876543210',
    ],
    notes: [
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
    key: 'assets',
    label: 'Assets',
    fileName: 'silverline-assets-template.csv',
    description: 'Equipment issued to people and sites, with its identifiers and value.',
    headers: [
      'code', 'name', 'category', 'serial_number', 'make', 'model',
      'purchase_date', 'purchase_cost', 'warranty_until', 'condition', 'status', 'notes',
    ],
    required: ['code', 'name'],
    example: [
      'AST-TS-014', 'Total Station', 'Survey Equipment', 'TS2024X0914', 'Leica', 'TS07plus',
      '2024-02-11', '485000', '2027-02-10', 'GOOD', 'AVAILABLE', 'Calibrated Feb 2026',
    ],
    notes: [
      'code is how the asset is referred to everywhere else, and must be unique.',
      'serial_number is what identifies the physical unit — keep it exactly as printed on the plate.',
      'Dates are YYYY-MM-DD.',
      'status is AVAILABLE, ASSIGNED, IN_REPAIR or RETIRED.',
    ],
  },
];

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

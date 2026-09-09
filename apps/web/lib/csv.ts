/**
 * Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF) + header
 * alias mapping to employee import fields. Pure functions — safe in node tests.
 */

export interface CsvParseError {
  index: number;
  errors: string[];
}

export interface ParsedEmployeeCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
  parseErrors: CsvParseError[];
}

function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/** Alias (normalized) -> canonical employee field. */
const HEADER_ALIASES: Record<string, string> = {
  emp_no: 'emp_no',
  empno: 'emp_no',
  emp_number: 'emp_no',
  employee_no: 'emp_no',
  employee_number: 'emp_no',
  employee_id: 'emp_no',
  first_name: 'first_name',
  firstname: 'first_name',
  given_name: 'first_name',
  last_name: 'last_name',
  lastname: 'last_name',
  family_name: 'last_name',
  surname: 'last_name',
  father_name: 'father_name',
  fathers_name: 'father_name',
  date_of_birth: 'date_of_birth',
  dob: 'date_of_birth',
  birth_date: 'date_of_birth',
  gender: 'gender',
  sex: 'gender',
  phone: 'phone',
  mobile: 'phone',
  mobile_number: 'phone',
  phone_number: 'phone',
  contact: 'phone',
  phone_secondary: 'phone_secondary',
  secondary_phone: 'phone_secondary',
  alt_phone: 'phone_secondary',
  email: 'email',
  email_id: 'email',
  aadhaar: 'aadhaar',
  aadhar: 'aadhaar',
  aadhaar_number: 'aadhaar',
  pan: 'pan',
  pan_number: 'pan',
  address: 'address',
  district: 'district_id',
  district_id: 'district_id',
  mandal: 'mandal_id',
  mandal_id: 'mandal_id',
  village: 'village_id',
  village_id: 'village_id',
  site: 'site_id',
  site_id: 'site_id',
  designation: 'designation',
  role: 'designation',
  department: 'department',
  dept: 'department',
  date_of_joining: 'date_of_joining',
  doj: 'date_of_joining',
  joining_date: 'date_of_joining',
  join_date: 'date_of_joining',
  reports_to: 'reports_to',
  reporting_to: 'reports_to',
  manager: 'reports_to',
  salary_basic: 'salary_basic',
  salary: 'salary_basic',
  basic: 'salary_basic',
  bank_name: 'bank_name',
  bank_account: 'bank_account',
  account_number: 'bank_account',
  account_no: 'bank_account',
  bank_ifsc: 'bank_ifsc',
  ifsc: 'bank_ifsc',
  phonepe_number: 'phonepe_number',
  phonepe: 'phonepe_number',
  education: 'education',
  qualification: 'education',
  skills: 'skills',
  experience_years: 'experience_years',
  experience: 'experience_years',
  status: 'status',
};

export function mapHeaderToField(header: string): string | null {
  const normalized = normalizeHeader(header);
  if (!normalized) return null;
  return HEADER_ALIASES[normalized] ?? normalized;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    row.push(field);
    field = '';
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      // Ignore; \n terminates the row.
    } else if (ch === '\n') {
      pushRow();
    } else {
      field += ch;
    }
  }
  // Flush trailing content (last line may lack a newline).
  if (inQuotes) {
    // Unterminated quote — treat literally.
    rows.push([...row, field]);
  } else if (field !== '' || row.length > 0) {
    rows.push([...row, field]);
  }
  return rows;
}

export function parseEmployeeCsv(text: string): ParsedEmployeeCsv {
  const raw = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (raw.length === 0) return { headers: [], rows: [], parseErrors: [] };
  const rawHeaders = raw[0];
  const mapped = rawHeaders.map(mapHeaderToField);
  const headers = rawHeaders.map((h, i) => mapped[i] ?? normalizeHeader(h));
  const rows: Array<Record<string, string>> = [];
  const parseErrors: CsvParseError[] = [];
  for (let r = 1; r < raw.length; r += 1) {
    const cells = raw[r];
    const rowNumber = r; // 1-based data-row index (header excluded)
    if (cells.length !== rawHeaders.length) {
      parseErrors.push({
        index: rowNumber,
        errors: [`Expected ${rawHeaders.length} columns but found ${cells.length}`],
      });
      continue;
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      if (!key) continue;
      record[key] = (cells[c] ?? '').trim();
    }
    // Drop fully-empty rows silently.
    if (Object.values(record).every((v) => v === '')) continue;
    rows.push(record);
  }
  return { headers, rows, parseErrors };
}

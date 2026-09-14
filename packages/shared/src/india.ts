/**
 * India-specific statutory primitives.
 *
 * These are not formatting helpers. Each one encodes a rule that Indian tax,
 * company or labour law actually enforces, and getting any of them wrong
 * produces records that fail an audit or a GST return rather than merely
 * looking untidy:
 *
 *  - a GSTIN carries its state and its PAN inside it, so a GSTIN that
 *    disagrees with the address it sits on is a data-entry error the system
 *    should catch, not carry;
 *  - the Indian financial year runs April–March, and GST law requires invoice
 *    serials to be unique *within* that year, so calendar-year numbering is
 *    non-compliant;
 *  - the MSMED Act fixes payment terms by statute, overriding whatever the
 *    contract says, and interest accrues automatically when it is breached.
 */

/* ----------------------------------------------------------------- GSTIN */

/**
 * GST state codes. The first two digits of every GSTIN.
 *
 * Kept complete rather than range-checked: 97 (Other Territory) and 99 (Centre
 * Jurisdiction) sit outside the 01–38 block, and
 * codes retired on reorganisation must still parse for historical records.
 */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '28': 'Andhra Pradesh (old)', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/**
 * The GSTIN check digit, per the GSTN specification.
 *
 * Every other character is weighted 2, the product is folded (quotient plus
 * remainder on 36), and the total is completed to a multiple of 36. A GSTIN
 * that passes the regex but fails this is a typo, which is exactly the case a
 * length check lets through.
 */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  let factor = 2;
  for (let i = first14.length - 1; i >= 0; i -= 1) {
    const codePoint = GSTIN_CHARSET.indexOf(first14[i]);
    if (codePoint < 0) return '';
    const product = codePoint * factor;
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET[(36 - (sum % 36)) % 36];
}

export interface GstinParts {
  stateCode: string;
  stateName: string;
  pan: string;
  entityNumber: string;
}

/** Structure, state code and check digit. Null when any of the three fails. */
export function parseGstin(value: string | null | undefined): GstinParts | null {
  const gstin = String(value ?? '').trim().toUpperCase();
  if (!GSTIN_SHAPE.test(gstin)) return null;
  const stateCode = gstin.slice(0, 2);
  const stateName = GST_STATE_CODES[stateCode];
  if (!stateName) return null;
  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) return null;
  return { stateCode, stateName, pan: gstin.slice(2, 12), entityNumber: gstin[12] };
}

export function isValidGstin(value: string | null | undefined): boolean {
  return parseGstin(value) !== null;
}

/* ------------------------------------------------------------------- PAN */

/**
 * The fourth character of a PAN declares what kind of holder it is. A company
 * quoting a PAN whose fourth character is 'P' has given an individual's PAN —
 * common when someone types a proprietor's PAN onto a company record, and it
 * breaks TDS treatment downstream.
 */
export const PAN_HOLDER_TYPES: Record<string, string> = {
  P: 'Individual', C: 'Company', H: 'Hindu Undivided Family', F: 'Firm',
  A: 'Association of Persons', T: 'Trust', B: 'Body of Individuals',
  L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government',
};

const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function parsePan(value: string | null | undefined): { pan: string; holderType: string } | null {
  const pan = String(value ?? '').trim().toUpperCase();
  if (!PAN_SHAPE.test(pan)) return null;
  const holderType = PAN_HOLDER_TYPES[pan[3]];
  if (!holderType) return null;
  return { pan, holderType };
}

export function isValidPan(value: string | null | undefined): boolean {
  return parsePan(value) !== null;
}

/** A GSTIN embeds its holder's PAN; a mismatch means one of the two is wrong. */
export function gstinMatchesPan(gstin: string, pan: string): boolean {
  const parsed = parseGstin(gstin);
  return parsed !== null && parsed.pan === String(pan).trim().toUpperCase();
}

/* ----------------------------------------------------------------- Udyam */

/** Udyam registration, the MSME identifier since 2020: UDYAM-XX-00-0000000. */
const UDYAM_SHAPE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

export function isValidUdyam(value: string | null | undefined): boolean {
  return UDYAM_SHAPE.test(String(value ?? '').trim().toUpperCase());
}

/* ------------------------------------------------------------------ IFSC */

/** IFSC: four-letter bank code, '0', six-character branch code. */
const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function isValidIfsc(value: string | null | undefined): boolean {
  return IFSC_SHAPE.test(String(value ?? '').trim().toUpperCase());
}

/* -------------------------------------------------------- financial year */

/**
 * The Indian financial year runs 1 April to 31 March. Every statutory series —
 * GST invoice numbers, TDS returns, payroll — resets on that boundary, so a
 * calendar year is the wrong unit throughout this domain.
 */
export interface FinancialYear {
  /** Calendar year the FY opens in: FY 2026-27 → 2026. */
  startYear: number;
  /** Canonical label, e.g. "2026-27". */
  label: string;
  startDate: string;
  endDate: string;
}

export function financialYearOf(date: Date | string = new Date()): FinancialYear {
  const d = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : date;
  const month = d.getUTCMonth(); // 0 = January
  const year = d.getUTCFullYear();
  // January, February and March belong to the FY that opened the previous April.
  const startYear = month < 3 ? year - 1 : year;
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return {
    startYear,
    label: `${startYear}-${endShort}`,
    startDate: `${startYear}-04-01`,
    endDate: `${startYear + 1}-03-31`,
  };
}

/** True when both dates fall in the same Indian financial year. */
export function sameFinancialYear(a: Date | string, b: Date | string): boolean {
  return financialYearOf(a).startYear === financialYearOf(b).startYear;
}

/**
 * A GST-compliant document number.
 *
 * Rule 46(b) of the CGST Rules: a consecutive serial number, unique within the
 * financial year, at most 16 characters, containing only letters, digits,
 * hyphen and slash. The FY is embedded so the series restarts each year while
 * staying unique across years.
 */
export function gstDocumentNumber(prefix: string, financialYear: string, sequence: number): string {
  const clean = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const serial = String(sequence).padStart(4, '0');
  const number = `${clean}/${financialYear}/${serial}`;
  if (number.length > 16) {
    // Trim the prefix rather than the serial: the serial is what makes the
    // number unique, and silently truncating it would create collisions.
    const room = 16 - (financialYear.length + serial.length + 2);
    if (room < 1) throw new Error('Financial year and sequence leave no room for a prefix');
    return `${clean.slice(0, room)}/${financialYear}/${serial}`;
  }
  return number;
}

export function isValidGstDocumentNumber(value: string): boolean {
  return /^[A-Za-z0-9/-]{1,16}$/.test(value);
}

/* ------------------------------------------------------------- GST split */

export type GstTreatment = 'INTRA_STATE' | 'INTER_STATE';

export interface GstSplit {
  treatment: GstTreatment;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

/**
 * Split a GST amount into its components.
 *
 * The determinant is place of supply against the supplier's state, not the
 * customer's billing address: a Maharashtra supplier billing a Karnataka
 * client for work performed in Maharashtra charges CGST+SGST, because the
 * place of supply is Maharashtra. Callers pass the place of supply for that
 * reason rather than a customer id.
 */
export function splitGst(taxableValue: number, ratePct: number, supplierStateCode: string, placeOfSupplyCode: string): GstSplit {
  const total = Math.round(taxableValue * ratePct) / 100;
  const treatment: GstTreatment = supplierStateCode === placeOfSupplyCode ? 'INTRA_STATE' : 'INTER_STATE';
  if (treatment === 'INTER_STATE') {
    return { treatment, cgst: 0, sgst: 0, igst: round2(total), total: round2(total) };
  }
  // Halving can leave a stray paisa; give it to CGST so the parts always sum
  // back to the total rather than drifting by rounding.
  const half = round2(total / 2);
  return { treatment, cgst: round2(total - half), sgst: half, igst: 0, total: round2(total) };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* -------------------------------------------------------------- MSMED Act */

/**
 * Statutory payment window for a registered MSME supplier.
 *
 * MSMED Act 2006 s.15: 45 days where the agreement fixes a period, 15 days
 * where it does not. The Act overrides a longer contractual term, so a system
 * that simply honours `payment_terms` will under-report the liability and the
 * interest that s.16 makes automatic.
 */
export const MSME_DAYS_WITH_AGREEMENT = 45;
export const MSME_DAYS_WITHOUT_AGREEMENT = 15;

export function msmeDueDate(acceptanceDate: string, hasWrittenAgreement: boolean): string {
  const days = hasWrittenAgreement ? MSME_DAYS_WITH_AGREEMENT : MSME_DAYS_WITHOUT_AGREEMENT;
  const d = new Date(`${acceptanceDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Interest payable on a delayed MSME payment.
 *
 * s.16: three times the RBI notified bank rate, compounded monthly. The rate
 * is passed in rather than hardcoded because the RBI revises it, and a stale
 * constant would silently understate a statutory liability.
 */
export function msmeDelayInterest(
  principal: number, dueDate: string, paidDate: string, rbiBankRatePct: number,
): { days: number; months: number; interest: number } {
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00Z`).getTime();
  const paid = new Date(`${paidDate.slice(0, 10)}T00:00:00Z`).getTime();
  const days = Math.max(0, Math.round((paid - due) / 86_400_000));
  if (days === 0) return { days: 0, months: 0, interest: 0 };
  const months = days / 30;
  const monthlyRate = (rbiBankRatePct * 3) / 100 / 12;
  const interest = principal * (Math.pow(1 + monthlyRate, months) - 1);
  return { days, months: round2(months), interest: round2(interest) };
}

/* ------------------------------------------------------------------- TDS */

/** Common TDS sections for a project business. Rates are the unshaded default. */
export const TDS_SECTIONS: Record<string, { description: string; ratePct: number; thresholdAnnual: number }> = {
  '194C': { description: 'Payments to contractors and sub-contractors', ratePct: 2, thresholdAnnual: 100_000 },
  '194C_INDIVIDUAL': { description: 'Contractor payments where payee is individual or HUF', ratePct: 1, thresholdAnnual: 100_000 },
  '194J': { description: 'Professional or technical services', ratePct: 10, thresholdAnnual: 30_000 },
  '194I_PLANT': { description: 'Rent of plant, machinery or equipment', ratePct: 2, thresholdAnnual: 240_000 },
  '194I_LAND': { description: 'Rent of land, building or furniture', ratePct: 10, thresholdAnnual: 240_000 },
  '194Q': { description: 'Purchase of goods', ratePct: 0.1, thresholdAnnual: 5_000_000 },
};

/**
 * TDS on a payment.
 *
 * s.206AA: where the payee has furnished no PAN, deduct at 20% or the ordinary
 * rate, whichever is higher. A system that applies the section rate regardless
 * under-deducts and leaves the deductor liable for the shortfall.
 */
export function tdsOn(
  amount: number, section: string, opts: { hasPan: boolean; lowerDeductionRatePct?: number | null } = { hasPan: true },
): { section: string; ratePct: number; tds: number; reason: string } {
  const config = TDS_SECTIONS[section];
  if (!config) throw new Error(`Unknown TDS section ${section}`);
  if (!opts.hasPan) {
    const rate = Math.max(20, config.ratePct);
    return { section, ratePct: rate, tds: round2((amount * rate) / 100), reason: 'No PAN on record — section 206AA rate applied' };
  }
  // A section 197 certificate authorises a lower rate for a named payee.
  if (opts.lowerDeductionRatePct !== null && opts.lowerDeductionRatePct !== undefined) {
    return {
      section, ratePct: opts.lowerDeductionRatePct,
      tds: round2((amount * opts.lowerDeductionRatePct) / 100),
      reason: 'Lower deduction certificate under section 197',
    };
  }
  return { section, ratePct: config.ratePct, tds: round2((amount * config.ratePct) / 100), reason: config.description };
}

/* ------------------------------------------------------------- invoicing */

/** The notified GST rates. Anything else is a data-entry error. */
export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28] as const;

export function isValidGstRate(rate: number): boolean {
  return (GST_RATES as readonly number[]).includes(rate);
}

export interface InvoiceLineInput {
  description: string;
  hsnSac: string;
  quantity: number;
  unitRate: number;
  discount?: number;
  gstRatePct: number;
}

export interface ComputedInvoiceLine extends GstSplit {
  description: string;
  hsnSac: string;
  quantity: number;
  unitRate: number;
  discount: number;
  taxableValue: number;
  gstRatePct: number;
  lineTotal: number;
}

export interface ComputedInvoice {
  treatment: GstTreatment;
  lines: ComputedInvoiceLine[];
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  roundOff: number;
  total: number;
  /** HSN-wise summary; a required annexure on the return. */
  hsnSummary: { hsnSac: string; gstRatePct: number; taxableValue: number; tax: number }[];
}

/**
 * Draw a GST invoice.
 *
 * Tax is computed per line, because rate and HSN belong to the item: cement at
 * 28% beside sand at 5% on one invoice is ordinary, and a single invoice-level
 * rate misstates both. Totals are summed from the lines rather than recomputed
 * from the invoice total, so the invoice always reconciles to its own detail.
 *
 * Under reverse charge (s.9(3)/9(4)) the supplier charges nothing — the
 * recipient pays the tax directly — so every tax head is zero and the total is
 * the taxable value. Carrying tax anyway double-counts the liability.
 */
export function computeInvoice(args: {
  lines: InvoiceLineInput[];
  supplierStateCode: string;
  placeOfSupplyCode: string;
  reverseCharge?: boolean;
  roundToRupee?: boolean;
}): ComputedInvoice {
  const reverseCharge = args.reverseCharge ?? false;
  const treatment: GstTreatment =
    args.supplierStateCode === args.placeOfSupplyCode ? 'INTRA_STATE' : 'INTER_STATE';

  const lines: ComputedInvoiceLine[] = args.lines.map(line => {
    if (!isValidGstRate(line.gstRatePct)) {
      throw new Error(`${line.gstRatePct}% is not a notified GST rate`);
    }
    const discount = line.discount ?? 0;
    const taxableValue = round2(line.quantity * line.unitRate - discount);
    const split = reverseCharge
      ? { treatment, cgst: 0, sgst: 0, igst: 0, total: 0 }
      : splitGst(taxableValue, line.gstRatePct, args.supplierStateCode, args.placeOfSupplyCode);
    return {
      description: line.description,
      hsnSac: line.hsnSac,
      quantity: line.quantity,
      unitRate: line.unitRate,
      discount,
      taxableValue,
      gstRatePct: line.gstRatePct,
      ...split,
      lineTotal: round2(taxableValue + split.total),
    };
  });

  const sum = (pick: (l: ComputedInvoiceLine) => number) => round2(lines.reduce((t, l) => t + pick(l), 0));
  const taxableValue = sum(l => l.taxableValue);
  const cgst = sum(l => l.cgst), sgst = sum(l => l.sgst), igst = sum(l => l.igst);
  const taxTotal = round2(cgst + sgst + igst);
  const gross = round2(taxableValue + taxTotal);
  // Invoices are commonly presented rounded to the rupee, with the difference
  // shown as its own line so the arithmetic still ties out.
  const rounded = args.roundToRupee ? Math.round(gross) : gross;
  const roundOff = round2(rounded - gross);

  const summary = new Map<string, { hsnSac: string; gstRatePct: number; taxableValue: number; tax: number }>();
  for (const line of lines) {
    const key = `${line.hsnSac}:${line.gstRatePct}`;
    const entry = summary.get(key)
      ?? { hsnSac: line.hsnSac, gstRatePct: line.gstRatePct, taxableValue: 0, tax: 0 };
    entry.taxableValue = round2(entry.taxableValue + line.taxableValue);
    entry.tax = round2(entry.tax + line.total);
    summary.set(key, entry);
  }

  return {
    treatment, lines, taxableValue, cgst, sgst, igst, taxTotal,
    roundOff, total: round2(rounded),
    hsnSummary: [...summary.values()].sort((a, b) => a.hsnSac.localeCompare(b.hsnSac)),
  };
}

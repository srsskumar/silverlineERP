import { describe, expect, it } from 'vitest';
import {
  GST_STATE_CODES, gstinCheckDigit, parseGstin, isValidGstin, gstinMatchesPan,
  parsePan, isValidPan, isValidUdyam, isValidIfsc,
  financialYearOf, sameFinancialYear, gstDocumentNumber, isValidGstDocumentNumber,
  splitGst, msmeDueDate, msmeDelayInterest, tdsOn,
  MSME_DAYS_WITH_AGREEMENT, MSME_DAYS_WITHOUT_AGREEMENT,
} from './india.js';

/**
 * Build a GSTIN with a correct check digit, so the fixtures exercise the real
 * algorithm instead of hardcoding strings that may themselves be wrong.
 */
function gstinFor(stateCode: string, pan: string, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

describe('GSTIN', () => {
  const PAN = 'AAACR5055K';

  it('accepts a well-formed GSTIN and reads its parts', () => {
    const gstin = gstinFor('27', PAN);
    const parsed = parseGstin(gstin);
    expect(parsed).not.toBeNull();
    expect(parsed!.stateCode).toBe('27');
    expect(parsed!.stateName).toBe('Maharashtra');
    expect(parsed!.pan).toBe(PAN);
  });

  it('rejects a typo that the length and shape still allow', () => {
    // The whole point of the check digit: this passes the regex.
    const good = gstinFor('29', PAN);
    const typo = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
    expect(typo).toHaveLength(15);
    expect(isValidGstin(good)).toBe(true);
    expect(isValidGstin(typo)).toBe(false);
  });

  it('rejects a state code that does not exist', () => {
    // 49 is not an allotted state code, so no GSTIN can begin with it.
    expect(isValidGstin(gstinFor('49', PAN))).toBe(false);
  });

  it('accepts the codes outside the 01-38 block', () => {
    // 97 Other Territory and 99 Centre Jurisdiction are real and a naive
    // range check on 01-38 would reject both.
    expect(isValidGstin(gstinFor('97', PAN))).toBe(true);
    expect(isValidGstin(gstinFor('99', PAN))).toBe(true);
    expect(GST_STATE_CODES['97']).toBe('Other Territory');
  });

  it('is case and whitespace tolerant on input', () => {
    const gstin = gstinFor('33', PAN);
    expect(isValidGstin(`  ${gstin.toLowerCase()}  `)).toBe(true);
  });

  it('rejects empty and malformed values without throwing', () => {
    for (const bad of ['', null, undefined, '27AAACR5055K', '27AAACR5055K1Z5X', 'nonsense']) {
      expect(isValidGstin(bad as string)).toBe(false);
    }
  });

  it('catches a GSTIN and PAN that disagree', () => {
    const gstin = gstinFor('27', PAN);
    expect(gstinMatchesPan(gstin, PAN)).toBe(true);
    expect(gstinMatchesPan(gstin, 'AAACR5055L')).toBe(false);
  });

  it('distinguishes two registrations of one PAN in different states', () => {
    // The case the single-column model could not hold: one company, two states.
    const mh = parseGstin(gstinFor('27', PAN))!;
    const ka = parseGstin(gstinFor('29', PAN))!;
    expect(mh.pan).toBe(ka.pan);
    expect(mh.stateCode).not.toBe(ka.stateCode);
  });
});

describe('PAN', () => {
  it('reads the holder type from the fourth character', () => {
    expect(parsePan('AAACR5055K')!.holderType).toBe('Company');
    expect(parsePan('AAAPR5055K')!.holderType).toBe('Individual');
    expect(parsePan('AAAFR5055K')!.holderType).toBe('Firm');
    expect(parsePan('AAATR5055K')!.holderType).toBe('Trust');
  });

  it('rejects an unallotted holder-type character', () => {
    // 'X' is not a holder type; a PAN carrying it is a typo.
    expect(isValidPan('AAAXR5055K')).toBe(false);
  });

  it('rejects the wrong shape', () => {
    for (const bad of ['', 'AAACR5055', 'AAACR50555K', '12345R5055K', null]) {
      expect(isValidPan(bad as string)).toBe(false);
    }
  });
});

describe('Udyam and IFSC', () => {
  it('accepts a well-formed Udyam number', () => {
    expect(isValidUdyam('UDYAM-MH-26-0012345')).toBe(true);
    expect(isValidUdyam('udyam-ka-03-0000001')).toBe(true);
  });

  it('rejects the pre-2020 formats and malformed values', () => {
    // Udyog Aadhaar numbers are not Udyam numbers.
    expect(isValidUdyam('UAM-MH-26-0012345')).toBe(false);
    expect(isValidUdyam('UDYAM-MH-26-123')).toBe(false);
    expect(isValidUdyam('')).toBe(false);
  });

  it('validates IFSC including the mandatory zero', () => {
    expect(isValidIfsc('HDFC0001234')).toBe(true);
    expect(isValidIfsc('SBIN0000456')).toBe(true);
    // The fifth character is always 0; a bank code in its place is invalid.
    expect(isValidIfsc('HDFC1001234')).toBe(false);
    expect(isValidIfsc('HDF0001234')).toBe(false);
  });
});

describe('Indian financial year', () => {
  it('opens in April', () => {
    expect(financialYearOf('2026-04-01').label).toBe('2026-27');
    expect(financialYearOf('2026-12-31').label).toBe('2026-27');
  });

  it('puts January to March in the year that opened the previous April', () => {
    // The mistake a calendar-year implementation makes.
    expect(financialYearOf('2027-01-15').label).toBe('2026-27');
    expect(financialYearOf('2027-03-31').label).toBe('2026-27');
    expect(financialYearOf('2027-04-01').label).toBe('2027-28');
  });

  it('reports the correct boundaries', () => {
    const fy = financialYearOf('2026-08-15');
    expect(fy.startDate).toBe('2026-04-01');
    expect(fy.endDate).toBe('2027-03-31');
    expect(fy.startYear).toBe(2026);
  });

  it('pads the short year across a century boundary', () => {
    expect(financialYearOf('2099-05-01').label).toBe('2099-00');
  });

  it('knows when two dates share a financial year', () => {
    expect(sameFinancialYear('2026-04-01', '2027-03-31')).toBe(true);
    // One day apart, different FY — the boundary that matters for GST series.
    expect(sameFinancialYear('2027-03-31', '2027-04-01')).toBe(false);
  });
});

describe('GST document numbering (CGST Rule 46(b))', () => {
  it('embeds the financial year so the series restarts each year', () => {
    expect(gstDocumentNumber('INV', '2026-27', 1)).toBe('INV/2026-27/0001');
  });

  it('stays within the 16-character statutory limit', () => {
    const number = gstDocumentNumber('INVOICE', '2026-27', 42);
    expect(number.length).toBeLessThanOrEqual(16);
    expect(isValidGstDocumentNumber(number)).toBe(true);
  });

  it('trims the prefix rather than the serial when space runs out', () => {
    // Truncating the serial would create collisions; the prefix is decorative.
    const number = gstDocumentNumber('VERYLONGPREFIX', '2026-27', 7);
    expect(number.endsWith('/2026-27/0007')).toBe(true);
    expect(number.length).toBeLessThanOrEqual(16);
  });

  it('strips characters the rule does not permit', () => {
    expect(gstDocumentNumber('IN V#', '2026-27', 3)).toBe('INV/2026-27/0003');
  });

  it('rejects a number that breaks the format', () => {
    expect(isValidGstDocumentNumber('INV_2026_0001')).toBe(false);
    expect(isValidGstDocumentNumber('A'.repeat(17))).toBe(false);
  });
});

describe('GST split', () => {
  it('charges CGST and SGST when supply stays in the state', () => {
    const split = splitGst(100_000, 18, '27', '27');
    expect(split.treatment).toBe('INTRA_STATE');
    expect(split.cgst).toBe(9000);
    expect(split.sgst).toBe(9000);
    expect(split.igst).toBe(0);
  });

  it('charges IGST when the place of supply is another state', () => {
    const split = splitGst(100_000, 18, '27', '29');
    expect(split.treatment).toBe('INTER_STATE');
    expect(split.igst).toBe(18_000);
    expect(split.cgst).toBe(0);
    expect(split.sgst).toBe(0);
  });

  it('keeps the halves summing to the total when the paisa is odd', () => {
    // 5% of 1234.55 gives a figure that does not halve cleanly.
    const split = splitGst(1234.55, 5, '27', '27');
    expect(Number((split.cgst + split.sgst).toFixed(2))).toBe(split.total);
  });

  it('turns on place of supply, not on the customer state', () => {
    // A Maharashtra supplier working at a Maharashtra site for a Karnataka
    // client charges CGST+SGST: the place of supply is where the work is.
    expect(splitGst(1000, 18, '27', '27').treatment).toBe('INTRA_STATE');
  });
});

describe('MSMED Act payment terms', () => {
  it('allows 45 days where there is a written agreement', () => {
    expect(msmeDueDate('2026-04-01', true)).toBe('2026-05-16');
    expect(MSME_DAYS_WITH_AGREEMENT).toBe(45);
  });

  it('allows only 15 days where there is none', () => {
    expect(msmeDueDate('2026-04-01', false)).toBe('2026-04-16');
    expect(MSME_DAYS_WITHOUT_AGREEMENT).toBe(15);
  });

  it('charges nothing when payment lands on time', () => {
    expect(msmeDelayInterest(100_000, '2026-05-16', '2026-05-16', 6.5).interest).toBe(0);
    expect(msmeDelayInterest(100_000, '2026-05-16', '2026-05-01', 6.5).days).toBe(0);
  });

  it('compounds monthly at three times the bank rate', () => {
    const result = msmeDelayInterest(100_000, '2026-05-16', '2026-08-14', 6.5);
    expect(result.days).toBe(90);
    // 3 x 6.5% = 19.5% a year, compounded monthly over ~3 months.
    expect(result.interest).toBeGreaterThan(4_700);
    expect(result.interest).toBeLessThan(5_100);
  });
});

describe('TDS', () => {
  it('applies the section rate', () => {
    expect(tdsOn(500_000, '194C').tds).toBe(10_000);
    expect(tdsOn(100_000, '194J').tds).toBe(10_000);
  });

  it('uses the lower individual rate for 194C where the payee is an individual', () => {
    expect(tdsOn(500_000, '194C_INDIVIDUAL').ratePct).toBe(1);
  });

  it('deducts at 20% under section 206AA when no PAN is on record', () => {
    // The expensive mistake: applying 2% to a payee with no PAN leaves the
    // deductor liable for the shortfall.
    const result = tdsOn(500_000, '194C', { hasPan: false });
    expect(result.ratePct).toBe(20);
    expect(result.tds).toBe(100_000);
    expect(result.reason).toContain('206AA');
  });

  it('never drops below the section rate when the section rate is higher', () => {
    // 194J is 10%, so no-PAN still means 20%; but a hypothetical 25% section
    // must not be reduced to 20%.
    expect(tdsOn(100_000, '194J', { hasPan: false }).ratePct).toBe(20);
  });

  it('honours a section 197 lower-deduction certificate', () => {
    const result = tdsOn(500_000, '194C', { hasPan: true, lowerDeductionRatePct: 0.5 });
    expect(result.tds).toBe(2_500);
    expect(result.reason).toContain('197');
  });

  it('refuses an unknown section rather than silently deducting nothing', () => {
    expect(() => tdsOn(1000, '194ZZ')).toThrow(/Unknown TDS section/);
  });
});

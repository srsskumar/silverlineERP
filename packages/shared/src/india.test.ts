import { describe, expect, it } from 'vitest';
import {
  GST_STATE_CODES, gstinCheckDigit, parseGstin, isValidGstin, gstinMatchesPan,
  parsePan, isValidPan, isValidUdyam, isValidIfsc,
  financialYearOf, sameFinancialYear, gstDocumentNumber, isValidGstDocumentNumber,
  splitGst, msmeDueDate, msmeDelayInterest, tdsOn, computeInvoice, isValidGstRate,
  MSME_DAYS_WITH_AGREEMENT, MSME_DAYS_WITHOUT_AGREEMENT,
  contractValueBreakdown, amountInWords, businessDay,
  indianMobile, isIndianMobile, formatIndianMobile,
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

describe('GST invoice', () => {
  const lines = [
    { description: 'Cement OPC 53', hsnSac: '25232910', quantity: 100, unitRate: 400, gstRatePct: 28 },
    { description: 'River sand', hsnSac: '25051011', quantity: 50, unitRate: 1200, gstRatePct: 5 },
  ];

  it('taxes each line at its own rate', () => {
    // A single invoice-level rate misstates both lines; 28% cement beside 5%
    // sand on one invoice is ordinary.
    const inv = computeInvoice({ lines, supplierStateCode: '27', placeOfSupplyCode: '27' });
    expect(inv.lines[0].total).toBe(11_200);   // 28% of 40,000
    expect(inv.lines[1].total).toBe(3_000);    // 5% of 60,000
    expect(inv.taxTotal).toBe(14_200);
  });

  it('splits into CGST and SGST within the state', () => {
    const inv = computeInvoice({ lines, supplierStateCode: '27', placeOfSupplyCode: '27' });
    expect(inv.treatment).toBe('INTRA_STATE');
    expect(inv.cgst).toBe(7_100);
    expect(inv.sgst).toBe(7_100);
    expect(inv.igst).toBe(0);
  });

  it('charges IGST when the place of supply is another state', () => {
    const inv = computeInvoice({ lines, supplierStateCode: '27', placeOfSupplyCode: '29' });
    expect(inv.treatment).toBe('INTER_STATE');
    expect(inv.igst).toBe(14_200);
    expect(inv.cgst + inv.sgst).toBe(0);
  });

  it('charges nothing under reverse charge', () => {
    // s.9(3)/9(4): the recipient pays the tax directly. Carrying an amount
    // here double-counts the liability.
    const inv = computeInvoice({ lines, supplierStateCode: '27', placeOfSupplyCode: '27', reverseCharge: true });
    expect(inv.taxTotal).toBe(0);
    expect(inv.total).toBe(inv.taxableValue);
  });

  it('reconciles the total to its own lines', () => {
    const inv = computeInvoice({ lines, supplierStateCode: '27', placeOfSupplyCode: '29' });
    const fromLines = inv.lines.reduce((t, l) => t + l.lineTotal, 0);
    expect(Number(fromLines.toFixed(2))).toBe(inv.total);
    expect(Number((inv.taxableValue + inv.taxTotal).toFixed(2))).toBe(inv.total);
  });

  it('shows the rounding difference as its own figure', () => {
    const odd = [{ description: 'Labour', hsnSac: '995431', quantity: 1, unitRate: 1234.56, gstRatePct: 18 }];
    const inv = computeInvoice({ lines: odd, supplierStateCode: '27', placeOfSupplyCode: '27', roundToRupee: true });
    expect(Number.isInteger(inv.total)).toBe(true);
    expect(Math.abs(inv.roundOff)).toBeLessThan(1);
    expect(Number((inv.taxableValue + inv.taxTotal + inv.roundOff).toFixed(2))).toBe(inv.total);
  });

  it('applies a line discount before tax', () => {
    const inv = computeInvoice({
      lines: [{ ...lines[0], discount: 4_000 }],
      supplierStateCode: '27', placeOfSupplyCode: '27',
    });
    expect(inv.taxableValue).toBe(36_000);
    expect(inv.taxTotal).toBe(10_080); // 28% of 36,000, not of 40,000
  });

  it('builds the HSN-wise summary the return annexure needs', () => {
    const inv = computeInvoice({
      lines: [...lines, { ...lines[0], quantity: 20 }],
      supplierStateCode: '27', placeOfSupplyCode: '27',
    });
    expect(inv.hsnSummary).toHaveLength(2);
    const cement = inv.hsnSummary.find(h => h.hsnSac === '25232910')!;
    // The two cement lines are merged under one HSN and rate.
    expect(cement.taxableValue).toBe(48_000);
  });

  it('refuses a rate that is not notified', () => {
    // 15% is not a GST rate; accepting it produces a return that will bounce.
    expect(() => computeInvoice({
      lines: [{ ...lines[0], gstRatePct: 15 }],
      supplierStateCode: '27', placeOfSupplyCode: '27',
    })).toThrow(/not a notified GST rate/);
  });

  it('accepts a nil-rated line', () => {
    const inv = computeInvoice({
      lines: [{ description: 'Exempt supply', hsnSac: '99999999', quantity: 1, unitRate: 1000, gstRatePct: 0 }],
      supplierStateCode: '27', placeOfSupplyCode: '27',
    });
    expect(inv.taxTotal).toBe(0);
    expect(inv.total).toBe(1000);
  });
});

describe('contractValueBreakdown', () => {
  it('extracts the tax from a GST-inclusive figure', () => {
    // 11,80,000 inclusive at 18% is 10,00,000 of revenue.
    const b = contractValueBreakdown({ amount: 1_180_000, gstIncluded: true, ratePct: 18 });
    expect(b.net).toBe(1_000_000);
    expect(b.gst).toBe(180_000);
    expect(b.gross).toBe(1_180_000);
  });

  it('adds the tax to a GST-exclusive figure', () => {
    const b = contractValueBreakdown({ amount: 1_000_000, gstIncluded: false, ratePct: 18 });
    expect(b.net).toBe(1_000_000);
    expect(b.gst).toBe(180_000);
    expect(b.gross).toBe(1_180_000);
  });

  it('keeps net plus tax equal to gross when the split does not divide evenly', () => {
    // The failure this prevents: three separately rounded figures that do not
    // add up, which an auditor will notice before anybody else does.
    const b = contractValueBreakdown({ amount: 100_000.01, gstIncluded: true, ratePct: 18 });
    expect(Math.round((b.net + b.gst) * 100)).toBe(Math.round(b.gross * 100));
  });

  it('treats a zero rate as no tax either way', () => {
    const inclusive = contractValueBreakdown({ amount: 500, gstIncluded: true, ratePct: 0 });
    const exclusive = contractValueBreakdown({ amount: 500, gstIncluded: false, ratePct: 0 });
    expect(inclusive).toEqual(exclusive);
    expect(inclusive.gst).toBe(0);
  });

  it('never turns a negative into a credit', () => {
    expect(contractValueBreakdown({ amount: -100, gstIncluded: false, ratePct: 18 }).net).toBe(0);
  });
});

describe('amountInWords', () => {
  it('counts in lakh and crore, which is what the work order says', () => {
    expect(amountInWords(1_250_000)).toBe('Twelve Lakh Fifty Thousand Rupees only');
    expect(amountInWords(12_500_000)).toBe('One Crore Twenty Five Lakh Rupees only');
  });

  it('reads the teens correctly', () => {
    expect(amountInWords(19)).toBe('Nineteen Rupees only');
    expect(amountInWords(1_15_000)).toBe('One Lakh Fifteen Thousand Rupees only');
  });

  it('includes paise when there are any', () => {
    expect(amountInWords(1234.56)).toBe('One Thousand Two Hundred Thirty Four Rupees and Fifty Six Paise only');
  });

  it('says zero rather than nothing', () => {
    expect(amountInWords(0)).toBe('Zero Rupees only');
  });

  it('marks a negative rather than dropping the sign', () => {
    expect(amountInWords(-500)).toBe('Minus Five Hundred Rupees only');
  });

  it('handles a figure with gaps in the middle', () => {
    // 1,00,00,007 — the classic case where a naive implementation emits
    // "One Crore Seven" and loses nothing, or emits stray empty groups.
    expect(amountInWords(10_000_007)).toBe('One Crore Seven Rupees only');
  });
});

describe('businessDay', () => {
  it('is the Indian calendar day, not the UTC one', () => {
    // 2026-09-16 20:00 UTC is already the 17th in India. A crew filing at
    // half past one in the morning is filing on the 17th, and UTC would date
    // it to the 16th.
    expect(businessDay(new Date('2026-09-16T20:00:00Z'))).toBe('2026-09-17');
  });

  it('gets the first hours of an Indian day right', () => {
    // 00:30 IST on the 17th is 19:00 UTC on the 16th. This is the window the
    // bug lived in: five and a half hours of every day reporting yesterday.
    expect(businessDay(new Date('2026-09-16T19:00:00Z'))).toBe('2026-09-17');
    expect(businessDay(new Date('2026-09-16T18:29:00Z'))).toBe('2026-09-16');
  });

  it('agrees with UTC in the middle of the working day', () => {
    expect(businessDay(new Date('2026-09-16T09:00:00Z'))).toBe('2026-09-16');
  });

  it('honours a timezone that is given', () => {
    expect(businessDay(new Date('2026-09-16T20:00:00Z'), 'UTC')).toBe('2026-09-16');
  });

  it('crosses a month and a year boundary', () => {
    expect(businessDay(new Date('2026-03-31T19:00:00Z'))).toBe('2026-04-01');
    expect(businessDay(new Date('2026-12-31T19:00:00Z'))).toBe('2027-01-01');
  });
});

describe('Indian mobile numbers', () => {
  it('reduces every written form of one number to the same ten digits', () => {
    // What a crew member types is not what an administrator saved.
    for (const written of [
      '9100000319', '+919100000319', '+91 91000 00319', '091-9100000319',
      '0 9100000319', '00919100000319', ' 91 91000 00319 ',
    ]) {
      expect(indianMobile(written), written).toBe('9100000319');
    }
  });

  it('refuses a number that is not an Indian mobile', () => {
    // A wrong match here is somebody logging into another person's account,
    // so a near miss is rejected rather than half-matched.
    expect(indianMobile('040 2345 6789')).toBeNull();   // landline
    expect(indianMobile('5100000319')).toBeNull();      // no mobile starts 5
    expect(indianMobile('910000031')).toBeNull();       // nine digits
    expect(indianMobile('91000003199')).toBeNull();     // eleven
    expect(indianMobile('139')).toBeNull();             // short code
    expect(indianMobile('')).toBeNull();
    expect(indianMobile(null)).toBeNull();
    expect(indianMobile('not a number')).toBeNull();
  });

  it('does not mistake a ten-digit number starting 91 for a country code', () => {
    // 9188... is a real mobile. Stripping "91" from it would silently match
    // the wrong account.
    expect(indianMobile('9188776655')).toBe('9188776655');
  });

  it('stores one written form so a number can be dialled and matched', () => {
    expect(formatIndianMobile('91000 00319')).toBe('+919100000319');
    expect(formatIndianMobile('040 2345 6789')).toBeNull();
  });

  it('answers whether a string is a mobile number at all', () => {
    expect(isIndianMobile('+919100000319')).toBe(true);
    expect(isIndianMobile('user_slv001_19')).toBe(false);
  });
});

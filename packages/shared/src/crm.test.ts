import { describe, expect, it } from 'vitest';
import {
  clientSchema, tenderSchema, gstRegistrationSchema, effectiveBidValue,
  LEAD_STAGE_TRANSITIONS, TENDER_STATUS_TRANSITIONS, CRM_ROLE_GRANTS,
} from './crm.js';
import { gstinCheckDigit } from './india.js';

function gstinFor(stateCode: string, pan = 'AAACR5055K', entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

const baseTender = { tender_no: 'TN-1', tender_type: 'OPEN' as const };

describe('effectiveBidValue', () => {
  it('resolves a percentage-rate bid below the estimate', () => {
    // "4.75% below ECV" on a 1 crore estimate — the CPWD/PWD norm.
    expect(effectiveBidValue({ bid_type: 'PERCENTAGE_RATE', quoted_percentage: -4.75, ecv: 10_000_000 }))
      .toBe(9_525_000);
  });

  it('resolves a quote above the estimate', () => {
    expect(effectiveBidValue({ bid_type: 'PERCENTAGE_RATE', quoted_percentage: 3.5, ecv: 10_000_000 }))
      .toBe(10_350_000);
  });

  it('uses the absolute amount for item-rate and lump-sum bids', () => {
    expect(effectiveBidValue({ bid_type: 'ITEM_RATE', bid_value: 4_800_000 })).toBe(4_800_000);
    expect(effectiveBidValue({ bid_type: 'LUMP_SUM', bid_value: 250_000 })).toBe(250_000);
  });

  it('returns null rather than zero when the bid is not priced yet', () => {
    // Contributing zero to a pipeline total would understate it silently.
    expect(effectiveBidValue({ bid_type: 'PERCENTAGE_RATE', quoted_percentage: -5 })).toBeNull();
    expect(effectiveBidValue({ bid_type: 'ITEM_RATE' })).toBeNull();
    expect(effectiveBidValue({})).toBeNull();
  });

  it('accepts the string amounts the API returns from numeric columns', () => {
    expect(effectiveBidValue({ bid_type: 'PERCENTAGE_RATE', quoted_percentage: '-2.5', ecv: '1000000' }))
      .toBe(975_000);
  });
});

describe('client schema — statutory identifiers', () => {
  it('accepts a client with a valid GSTIN and PAN', () => {
    const parsed = clientSchema.safeParse({
      code: 'CL1', name: 'Acme Infra', client_type: 'GOVERNMENT',
      gstin: gstinFor('27'), pan: 'AAACR5055K',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a GSTIN that only looks right', () => {
    const good = gstinFor('27');
    const typo = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
    const parsed = clientSchema.safeParse({ code: 'CL1', name: 'Acme', client_type: 'PRIVATE', gstin: typo });
    expect(parsed.success).toBe(false);
  });

  it('upper-cases identifiers so the unique index sees one spelling', () => {
    const parsed = clientSchema.parse({
      code: 'CL1', name: 'Acme', client_type: 'PRIVATE',
      gstin: gstinFor('29').toLowerCase(), pan: 'aaacr5055k',
    });
    expect(parsed.gstin).toBe(gstinFor('29'));
    expect(parsed.pan).toBe('AAACR5055K');
  });

  it('rejects a malformed Udyam number', () => {
    const parsed = clientSchema.safeParse({
      code: 'CL1', name: 'Acme', client_type: 'PRIVATE', udyam_number: 'UAM-MH-26-0012345',
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults to a written agreement, which is the 45-day MSMED window', () => {
    const parsed = clientSchema.parse({ code: 'CL1', name: 'Acme', client_type: 'PRIVATE' });
    expect(parsed.has_written_agreement).toBe(true);
  });
});

describe('tender schema — Indian bidding practice', () => {
  it('defaults to an item-rate single-cover tender', () => {
    const parsed = tenderSchema.parse(baseTender);
    expect(parsed.bid_type).toBe('ITEM_RATE');
    expect(parsed.cover_system).toBe('SINGLE');
    expect(parsed.emd_exempt).toBe(false);
  });

  it('accepts a percentage-rate bid quoted against an estimate', () => {
    const parsed = tenderSchema.safeParse({
      ...baseTender, bid_type: 'PERCENTAGE_RATE', quoted_percentage: -4.75, ecv: '10000000',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a percentage quote with no estimate behind it', () => {
    const parsed = tenderSchema.safeParse({
      ...baseTender, bid_type: 'PERCENTAGE_RATE', quoted_percentage: -4.75,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.includes('ecv'))).toBe(true);
    }
  });

  it('refuses an arithmetic-impossible discount', () => {
    // More than 100% below the estimate is a negative price.
    expect(tenderSchema.safeParse({ ...baseTender, bid_type: 'PERCENTAGE_RATE', quoted_percentage: -120, ecv: '100' }).success)
      .toBe(false);
  });

  it('refuses an EMD exemption with nothing to prove it', () => {
    const parsed = tenderSchema.safeParse({ ...baseTender, emd_exempt: true });
    expect(parsed.success).toBe(false);
  });

  it('accepts an MSME exemption carrying its registration number', () => {
    const parsed = tenderSchema.safeParse({
      ...baseTender, emd_exempt: true, emd_exemption_basis: 'MSME',
      emd_exemption_ref: 'UDYAM-MH-26-0012345',
    });
    expect(parsed.success).toBe(true);
  });

  it('requires joint-venture shares to account for the whole scope', () => {
    const short = tenderSchema.safeParse({
      ...baseTender, jv_flag: true,
      jv_partners: [{ name: 'A', scope_pct: 60 }, { name: 'B', scope_pct: 30 }],
    });
    expect(short.success).toBe(false);

    const exact = tenderSchema.safeParse({
      ...baseTender, jv_flag: true,
      jv_partners: [{ name: 'A', scope_pct: 60 }, { name: 'B', scope_pct: 40 }],
    });
    expect(exact.success).toBe(true);
  });

  it('still refuses a closing date before the start date', () => {
    expect(tenderSchema.safeParse({ ...baseTender, start_date: '2026-05-01', closing_date: '2026-04-01' }).success)
      .toBe(false);
  });
});

describe('GST registration schema', () => {
  it('accepts a registration per state for one party', () => {
    for (const state of ['27', '29', '36']) {
      const parsed = gstRegistrationSchema.safeParse({
        party_type: 'CLIENT', party_id: '3f1a0c2e-0000-4000-8000-000000000001', gstin: gstinFor(state),
      });
      expect(parsed.success, `state ${state}`).toBe(true);
    }
  });

  it('carries the registration type that changes tax treatment', () => {
    const parsed = gstRegistrationSchema.parse({
      party_type: 'VENDOR', party_id: '3f1a0c2e-0000-4000-8000-000000000001',
      gstin: gstinFor('27'), registration_type: 'COMPOSITION',
    });
    // A composition dealer charges no GST; treating them as REGULAR would
    // claim input credit that does not exist.
    expect(parsed.registration_type).toBe('COMPOSITION');
  });

  it('defaults to REGULAR', () => {
    const parsed = gstRegistrationSchema.parse({
      party_type: 'CLIENT', party_id: '3f1a0c2e-0000-4000-8000-000000000001', gstin: gstinFor('33'),
    });
    expect(parsed.registration_type).toBe('REGULAR');
  });
});

describe('state machines stay closed', () => {
  it('leaves every terminal lead stage with no exit', () => {
    for (const stage of ['CONVERTED', 'LOST', 'DISQUALIFIED'] as const) {
      expect(LEAD_STAGE_TRANSITIONS[stage]).toEqual([]);
    }
  });

  it('leaves every terminal tender status with no exit', () => {
    for (const status of ['AWARDED', 'REJECTED', 'CANCELLED'] as const) {
      expect(TENDER_STATUS_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('never advertises a transition to a status that does not exist', () => {
    const known = new Set(Object.keys(TENDER_STATUS_TRANSITIONS));
    for (const targets of Object.values(TENDER_STATUS_TRANSITIONS)) {
      for (const target of targets) expect(known.has(target)).toBe(true);
    }
  });
});

describe('role grants keep the reserved override reserved', () => {
  it('gives the eligibility override to Super Admin alone', () => {
    const holders = Object.entries(CRM_ROLE_GRANTS)
      .filter(([, codes]) => codes.includes('tender.override'))
      .map(([role]) => role);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('lets the Bid/Tender Manager submit but not override their own gate', () => {
    expect(CRM_ROLE_GRANTS.BID_TENDER_MANAGER).toContain('tender.submit');
    expect(CRM_ROLE_GRANTS.BID_TENDER_MANAGER).not.toContain('tender.override');
  });

  it('keeps the Client Viewer out of the commercial domain entirely', () => {
    expect(CRM_ROLE_GRANTS.CLIENT_VIEWER).toEqual([]);
  });
});

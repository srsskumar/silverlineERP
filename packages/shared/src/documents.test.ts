import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_ROLE_GRANTS, DOCUMENT_TYPE_SEEDS, DOCUMENT_TYPE_CODES,
  canDelete, daysUntil, documentCreateSchema, documentRenewSchema, documentState,
  isInForce, legalHoldSchema, renewalQueue, summarise, typeAllowsOwner,
} from './documents.js';

const AS_OF = '2026-09-15';

describe('daysUntil', () => {
  it('counts whole days forward and backward', () => {
    expect(daysUntil('2026-09-20', AS_OF)).toBe(5);
    expect(daysUntil('2026-09-10', AS_OF)).toBe(-5);
    expect(daysUntil(AS_OF, AS_OF)).toBe(0);
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(daysUntil('2026-10-01', '2026-09-30')).toBe(1);
    expect(daysUntil('2027-01-01', '2026-12-31')).toBe(1);
  });

  it('counts across a leap day', () => {
    // 2028 is a leap year; February has 29 days.
    expect(daysUntil('2028-03-01', '2028-02-28')).toBe(2);
  });
});

describe('documentState', () => {
  it('is valid well before expiry', () => {
    expect(documentState({ expiresOn: '2027-01-01', noticeDays: 30 }, AS_OF)).toBe('VALID');
  });

  it('is expiring once inside the notice window', () => {
    expect(documentState({ expiresOn: '2026-10-01', noticeDays: 30 }, AS_OF)).toBe('EXPIRING');
  });

  it('is still in force on the day it expires', () => {
    // A licence valid "until 31 March" is valid on 31 March. Treating the
    // expiry date as already lapsed stops work a day early.
    const state = documentState({ expiresOn: AS_OF, noticeDays: 30 }, AS_OF);
    expect(state).toBe('EXPIRING');
    expect(isInForce(state)).toBe(true);
  });

  it('is expired the day after', () => {
    expect(documentState({ expiresOn: '2026-09-14', noticeDays: 30 }, AS_OF)).toBe('EXPIRED');
  });

  it('honours a type-specific notice window', () => {
    // A PUC renewed in an afternoon does not need sixty days of warning, and
    // a labour licence taking six weeks needs more than thirty.
    const in40Days = { expiresOn: '2026-10-25' };
    expect(documentState({ ...in40Days, noticeDays: 7 }, AS_OF)).toBe('VALID');
    expect(documentState({ ...in40Days, noticeDays: 60 }, AS_OF)).toBe('EXPIRING');
  });

  it('defaults the window to thirty days when the type sets none', () => {
    expect(documentState({ expiresOn: '2026-10-10' }, AS_OF)).toBe('EXPIRING');
    expect(documentState({ expiresOn: '2026-11-10' }, AS_OF)).toBe('VALID');
  });

  it('reports a superseded document as superseded, not expired', () => {
    // It was renewed. Reporting it as expired sends somebody to renew a
    // document that has already been renewed, and after that happens twice
    // nobody reads the alerts.
    expect(documentState(
      { expiresOn: '2020-01-01', supersededById: 'x' }, AS_OF,
    )).toBe('SUPERSEDED');
  });

  it('reports a document with no expiry as such rather than as valid', () => {
    // A degree certificate does not expire; calling it VALID would put it in
    // the same bucket as a licence somebody has to keep renewing.
    expect(documentState({ expiresOn: null }, AS_OF)).toBe('NO_EXPIRY');
  });
});

describe('summarise', () => {
  const items = [
    { expiresOn: '2027-01-01', noticeDays: 30 },                              // valid
    { expiresOn: '2026-10-01', noticeDays: 30, blocksOperations: true },      // expiring, blocking
    { expiresOn: '2026-08-01', noticeDays: 30, blocksOperations: true },      // expired, blocking
    { expiresOn: '2026-08-01', noticeDays: 30 },                              // expired
    { expiresOn: '2020-01-01', supersededById: 'x', blocksOperations: true }, // superseded
    { expiresOn: null },                                                      // no expiry
  ];

  it('counts each state once', () => {
    const s = summarise(items, AS_OF);
    expect(s).toMatchObject({
      total: 6, valid: 1, expiring: 1, expired: 2, superseded: 1, noExpiry: 1,
    });
  });

  it('counts what stops work apart from what is merely untidy', () => {
    // "12 expired documents" flattens the difference between a stale PAN scan
    // and a lapsed labour licence.
    const s = summarise(items, AS_OF);
    expect(s.blocking).toBe(1);
    expect(s.blockingSoon).toBe(1);
  });

  it('does not count a superseded blocker as blocking', () => {
    const s = summarise([
      { expiresOn: '2020-01-01', supersededById: 'x', blocksOperations: true },
    ], AS_OF);
    expect(s.blocking).toBe(0);
  });

  it('reports zeroes for an empty register rather than failing', () => {
    expect(summarise([], AS_OF).total).toBe(0);
  });
});

describe('renewalQueue', () => {
  it('puts the most urgent first', () => {
    const q = renewalQueue([
      { expiresOn: '2026-11-01' },
      { expiresOn: '2026-09-20' },
      { expiresOn: '2026-10-05' },
    ], AS_OF, 60);
    expect(q.map(i => i.expiresOn)).toEqual(['2026-09-20', '2026-10-05', '2026-11-01']);
  });

  it('includes what has already lapsed, ahead of what has not', () => {
    // An expired licence is more urgent than one expiring on Friday, and
    // dropping it because it is "past" is how it stays expired.
    const q = renewalQueue([
      { expiresOn: '2026-09-20' },
      { expiresOn: '2026-08-01' },
    ], AS_OF, 60);
    expect(q[0].expiresOn).toBe('2026-08-01');
    expect(q[0].state).toBe('EXPIRED');
    expect(q[0].daysRemaining).toBeLessThan(0);
  });

  it('breaks a tie in favour of what stops work', () => {
    const q = renewalQueue([
      { expiresOn: '2026-09-20', blocksOperations: false },
      { expiresOn: '2026-09-20', blocksOperations: true },
    ], AS_OF, 60);
    expect(q[0].blocksOperations).toBe(true);
  });

  it('drops a document that has already been renewed', () => {
    const q = renewalQueue([
      { expiresOn: '2026-09-20', supersededById: 'newer' },
    ], AS_OF, 60);
    expect(q).toEqual([]);
  });

  it('ignores documents that do not expire', () => {
    expect(renewalQueue([{ expiresOn: null }], AS_OF, 60)).toEqual([]);
  });

  it('respects the window asked for', () => {
    const items = [{ expiresOn: '2026-11-30' }];
    expect(renewalQueue(items, AS_OF, 30)).toHaveLength(0);
    expect(renewalQueue(items, AS_OF, 90)).toHaveLength(1);
  });
});

describe('canDelete', () => {
  it('refuses while the retention period is still running', () => {
    const r = canDelete({ expiresOn: '2024-03-31', retentionYears: 8, asOf: AS_OF });
    expect(r.deletable).toBe(false);
    expect(r.retainUntil).toBe('2032-03-31');
  });

  it('allows deletion once retention has run', () => {
    const r = canDelete({ expiresOn: '2020-03-31', retentionYears: 3, asOf: AS_OF });
    expect(r.deletable).toBe(true);
  });

  it('measures retention from expiry, not from issue', () => {
    // A licence issued in 2020 and valid to 2027 must be kept for its
    // retention period after 2027. Measuring from issue would permit
    // destroying a document that is still in force.
    const r = canDelete({
      issuedOn: '2020-01-01', expiresOn: '2027-01-01', retentionYears: 3, asOf: AS_OF,
    });
    expect(r.deletable).toBe(false);
    expect(r.retainUntil).toBe('2030-01-01');
  });

  it('falls back to the issue date where nothing expires', () => {
    const r = canDelete({ issuedOn: '2015-06-01', retentionYears: 8, asOf: AS_OF });
    expect(r.retainUntil).toBe('2023-06-01');
    expect(r.deletable).toBe(true);
  });

  it('refuses under legal hold however old the document is', () => {
    // A document under audit or arbitration survives any routine clean-up.
    const r = canDelete({
      expiresOn: '1999-01-01', retentionYears: 1, legalHold: true, asOf: AS_OF,
    });
    expect(r.deletable).toBe(false);
    expect(r.reason).toContain('legal hold');
  });

  it('refuses when neither date is recorded, and says why', () => {
    const r = canDelete({ retentionYears: 8, asOf: AS_OF });
    expect(r.deletable).toBe(false);
    expect(r.reason).toContain('retention period cannot be worked out');
  });
});

describe('seeded types', () => {
  it('has no duplicate codes', () => {
    expect(new Set(DOCUMENT_TYPE_CODES).size).toBe(DOCUMENT_TYPE_CODES.length);
  });

  it('gives every type a notice window and a retention period', () => {
    for (const seed of DOCUMENT_TYPE_SEEDS) {
      expect(seed.noticeDays, seed.code).toBeGreaterThan(0);
      expect(seed.retentionYears, seed.code).toBeGreaterThan(0);
    }
  });

  it('requires an expiry date on every type whose lapse stops work', () => {
    // A labour licence with no recorded expiry is worse than no record: it
    // reads as compliant.
    for (const seed of DOCUMENT_TYPE_SEEDS) {
      if (seed.blocksOperations && seed.code !== 'GST_REGISTRATION') {
        expect(seed.expiryRequired, seed.code).toBe(true);
      }
    }
  });

  it('keeps statutory records for the statutory period', () => {
    // Companies Act 2013 s.128 — eight years for books of account.
    for (const code of ['GST_REGISTRATION', 'PAN', 'TAN', 'EPF_CODE', 'ESIC_CODE']) {
      const seed = DOCUMENT_TYPE_SEEDS.find(s => s.code === code)!;
      expect(seed.retentionYears, code).toBeGreaterThanOrEqual(8);
    }
  });

  it('gives a slow renewal more warning than a fast one', () => {
    const licence = DOCUMENT_TYPE_SEEDS.find(s => s.code === 'LABOUR_LICENCE')!;
    const puc = DOCUMENT_TYPE_SEEDS.find(s => s.code === 'PUC')!;
    expect(licence.noticeDays).toBeGreaterThan(puc.noticeDays);
  });

  it('marks identity and medical records confidential', () => {
    for (const code of ['PAN', 'MEDICAL_FITNESS', 'DRIVING_LICENCE', 'EMPLOYMENT_CONTRACT']) {
      expect(DOCUMENT_TYPE_SEEDS.find(s => s.code === code)!.confidential, code).toBe(true);
    }
  });

  it('cites a basis for the types that stop work', () => {
    // Somebody told their site cannot operate deserves to be told why.
    const blocking = DOCUMENT_TYPE_SEEDS.filter(s => s.blocksOperations);
    expect(blocking.length).toBeGreaterThan(5);
    expect(blocking.filter(s => s.basis).length).toBeGreaterThanOrEqual(blocking.length - 3);
  });
});

describe('typeAllowsOwner', () => {
  it('keeps a vehicle certificate off an employee record', () => {
    const fitness = DOCUMENT_TYPE_SEEDS.find(s => s.code === 'FITNESS_CERTIFICATE')!;
    expect(typeAllowsOwner(fitness, 'asset')).toBe(true);
    expect(typeAllowsOwner(fitness, 'employee')).toBe(false);
  });

  it('treats an empty owner list as unrestricted', () => {
    expect(typeAllowsOwner({ owners: [] }, 'project')).toBe(true);
  });
});

describe('schemas', () => {
  const valid = {
    type_code: 'LABOUR_LICENCE', owner_type: 'project' as const,
    owner_id: '11111111-1111-4111-8111-111111111111',
    title: 'Labour licence — Ameerpet', expires_on: '2027-03-31',
  };

  it('accepts a well-formed document', () => {
    expect(documentCreateSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses an expiry before the document takes effect', () => {
    const r = documentCreateSchema.safeParse({
      ...valid, valid_from: '2027-01-01', expires_on: '2026-01-01',
    });
    expect(r.success).toBe(false);
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    // 01/04/2027 is 1 April or 4 January depending on who typed it.
    const r = documentCreateSchema.safeParse({ ...valid, expires_on: '31/03/2027' });
    expect(r.success).toBe(false);
  });

  it('refuses an owner type it does not know', () => {
    expect(documentCreateSchema.safeParse({ ...valid, owner_type: 'building' }).success).toBe(false);
  });

  it('requires an expiry date on a renewal', () => {
    // A renewal with no new expiry is not a renewal.
    expect(documentRenewSchema.safeParse({}).success).toBe(false);
    expect(documentRenewSchema.safeParse({ expires_on: '2028-03-31' }).success).toBe(true);
  });

  it('requires a reason to place a hold but not to release one', () => {
    expect(legalHoldSchema.safeParse({ legal_hold: true }).success).toBe(false);
    expect(legalHoldSchema.safeParse({ legal_hold: true, reason: 'Arbitration' }).success).toBe(true);
    expect(legalHoldSchema.safeParse({ legal_hold: false }).success).toBe(true);
  });
});

describe('role grants', () => {
  it('lets an auditor read everything but delete nothing', () => {
    // An auditor who can destroy evidence is not a control.
    const auditor = DOCUMENT_ROLE_GRANTS.AUDITOR;
    expect(auditor).toContain('document.read');
    expect(auditor).toContain('document.confidential');
    expect(auditor).toContain('document.legalhold');
    expect(auditor).not.toContain('document.delete');
  });

  it('keeps confidential documents away from roles that do not need them', () => {
    for (const role of ['PROJECT_MANAGER', 'SITE_ENGINEER', 'TEAM_LEAD', 'SALES_BD_EXECUTIVE'] as const) {
      expect(DOCUMENT_ROLE_GRANTS[role as keyof typeof DOCUMENT_ROLE_GRANTS] ?? [])
        .not.toContain('document.confidential');
    }
  });

  it('grants deletion to administrators only', () => {
    for (const [role, grants] of Object.entries(DOCUMENT_ROLE_GRANTS)) {
      if (grants.includes('document.delete')) {
        expect(['SUPER_ADMIN', 'ADMIN']).toContain(role);
      }
    }
  });
});

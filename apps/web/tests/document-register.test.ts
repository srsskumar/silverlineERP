import { describe, expect, it } from 'vitest';
import {
  CATEGORY_LABELS, DOCUMENT_STATES, OWNER_LABELS, STATE_LABELS,
  consequence, deadlineLabel, registerHeadline, retentionNote, stateTone,
} from '../lib/document-register';
import { NAV_GROUPS } from '../lib/nav';
import { DOCUMENT_PERMISSIONS, DOCUMENT_TYPE_SEEDS, DOCUMENT_STATES as SHARED_STATES } from '@silverline/shared';

describe('states', () => {
  it('labels every state the server can return', () => {
    // A state the UI cannot label renders as a raw enum in front of a user.
    expect([...DOCUMENT_STATES].sort()).toEqual([...SHARED_STATES].sort());
    for (const s of DOCUMENT_STATES) expect(STATE_LABELS[s], s).toBeTruthy();
  });

  it('treats superseded as neutral, not as a problem', () => {
    // It means the document was renewed, which is the good outcome. Colouring
    // it like a failure is what trains people to stop reading the colours.
    expect(stateTone('SUPERSEDED')).toBe('neutral');
    expect(stateTone('NO_EXPIRY')).toBe('neutral');
    expect(stateTone('VALID')).toBe('success');
    expect(stateTone('EXPIRING')).toBe('warning');
    expect(stateTone('EXPIRED')).toBe('danger');
  });
});

describe('deadlineLabel', () => {
  it('says what a negative number means instead of showing it', () => {
    // The register is read under time pressure; nobody should have to work
    // out the sign.
    expect(deadlineLabel(-14)).toBe('Expired 14 days ago');
    expect(deadlineLabel(-1)).toBe('Expired yesterday');
  });

  it('names today and tomorrow rather than counting them', () => {
    expect(deadlineLabel(0)).toBe('Expires today');
    expect(deadlineLabel(1)).toBe('Expires tomorrow');
  });

  it('switches to a coarser unit once the count stops being useful', () => {
    expect(deadlineLabel(12)).toBe('12 days left');
    expect(deadlineLabel(90)).toBe('3 months left');
    expect(deadlineLabel(730)).toBe('2 years left');
  });

  it('says there is no expiry rather than showing a blank', () => {
    expect(deadlineLabel(null)).toBe('No expiry date');
    expect(deadlineLabel(undefined)).toBe('No expiry date');
  });
});

describe('consequence', () => {
  it('says nothing for a document whose lapse costs nothing', () => {
    expect(consequence({ blocks_operations: false })).toBeNull();
  });

  it('says work stops, and cites why', () => {
    const text = consequence({
      blocks_operations: true,
      basis: 'Contract Labour (Regulation and Abolition) Act 1970, s.12',
      state: 'EXPIRING',
    })!;
    expect(text).toContain('stops if it lapses');
    expect(text).toContain('Contract Labour');
  });

  it('speaks in the past tense once it has already lapsed', () => {
    const text = consequence({ blocks_operations: true, state: 'EXPIRED' })!;
    expect(text).toContain('has lapsed');
    expect(text).toContain('should stop');
  });
});

describe('registerHeadline', () => {
  const base = { total: 10, expired: 0, expiring: 0, blocking: 0, blockingSoon: 0 };

  it('leads with what stops work, over everything else', () => {
    // A lapsed labour licence outranks nine untidy scans.
    const text = registerHeadline({ ...base, expired: 9, blocking: 1 });
    expect(text).toContain('work depends on');
    expect(text).toContain('should not continue');
  });

  it('distinguishes untidy from unlawful', () => {
    const text = registerHeadline({ ...base, expired: 3 });
    expect(text).toContain('None of them stops work');
  });

  it('says so plainly when everything is in order', () => {
    expect(registerHeadline(base)).toBe('Everything on the register is in force.');
  });

  it('handles an empty register without claiming everything is fine', () => {
    expect(registerHeadline({ ...base, total: 0 })).toContain('Nothing is on the register');
    expect(registerHeadline(undefined)).toContain('Nothing is on the register');
  });

  it('gets the grammar right for exactly one', () => {
    expect(registerHeadline({ ...base, blocking: 1 })).toContain('1 document has lapsed');
    expect(registerHeadline({ ...base, blocking: 2 })).toContain('2 documents have lapsed');
  });
});

describe('retentionNote', () => {
  it('says nothing when the document can be deleted', () => {
    expect(retentionNote({ deletable: true })).toBeNull();
  });

  it('passes the reason through rather than inventing one', () => {
    expect(retentionNote({ deletable: false, reason: 'Statutory retention runs to 2032-03-31.' }))
      .toContain('2032-03-31');
  });
});

describe('labels', () => {
  it('labels every owner the server accepts', () => {
    const owners = new Set(DOCUMENT_TYPE_SEEDS.flatMap((s) => s.owners));
    for (const owner of owners) expect(OWNER_LABELS[owner], owner).toBeTruthy();
  });

  it('labels every category the seeds use', () => {
    for (const seed of DOCUMENT_TYPE_SEEDS) {
      expect(CATEGORY_LABELS[seed.category], seed.category).toBeTruthy();
    }
  });
});

describe('navigation', () => {
  it('reaches the register behind a permission the server issues', () => {
    const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === '/documents');
    expect(item).toBeTruthy();
    expect([...DOCUMENT_PERMISSIONS]).toContain(item!.permission);
  });
});

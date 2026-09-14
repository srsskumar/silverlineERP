import { NAV_GROUPS, QUICK_CREATE } from '../lib/nav';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, hasPermission } from '../lib/permissions';

describe('hasPermission', () => {
  it('returns true when the holder has the code', () => {
    expect(
      hasPermission({ permissions: [PERMISSIONS.EMPLOYEE_READ, 'other.code'] }, PERMISSIONS.EMPLOYEE_READ),
    ).toBe(true);
  });

  it('returns false when the holder lacks the code', () => {
    expect(hasPermission({ permissions: [PERMISSIONS.DOCUMENT_READ] }, PERMISSIONS.EMPLOYEE_READ)).toBe(false);
  });

  it('returns false for an empty permission list', () => {
    expect(hasPermission({ permissions: [] }, PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it('returns false for a null holder', () => {
    expect(hasPermission(null, PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it('returns false for an undefined holder', () => {
    expect(hasPermission(undefined, PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it('returns false when permissions is missing or not an array', () => {
    expect(hasPermission({}, PERMISSIONS.AUDIT_READ)).toBe(false);
    expect(hasPermission({ permissions: null }, PERMISSIONS.AUDIT_READ)).toBe(false);
  });
});

describe('commercial spine navigation (§4, §7, §8)', () => {
  const dests = (perms: string[]) =>
    NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => !i.permission || perms.includes(i.permission))
      .map((i) => i.href);

  it('shows the pipeline to a Sales/BD Executive', () => {
    const visible = dests(['lead.read', 'client.read', 'tender.read']);
    expect(visible).toContain('/leads');
    expect(visible).toContain('/clients');
    expect(visible).toContain('/tenders');
  });

  it('hides every commercial destination from an employee', () => {
    // §4.1 deny by default: an employee holds none of these codes.
    const visible = dests([]);
    for (const href of ['/leads', '/tenders', '/clients']) {
      expect(visible).not.toContain(href);
    }
  });

  it('gates the tender list on tender.read, not on lead.read', () => {
    // The two roles are distinct in §4; a lead-only grant must not open tenders.
    const visible = dests(['lead.read']);
    expect(visible).toContain('/leads');
    expect(visible).not.toContain('/tenders');
  });

  it('offers the quick-create actions only with the matching manage grant', () => {
    const forPerms = (perms: string[]) =>
      QUICK_CREATE.filter((i) => !i.permission || perms.includes(i.permission)).map((i) => i.href);
    expect(forPerms(['lead.manage'])).toContain('/leads/new');
    expect(forPerms(['lead.read'])).not.toContain('/leads/new');
    expect(forPerms(['tender.manage'])).toContain('/tenders/new');
  });
});

/**
 * The module catalog (`packages/shared/src/modules.ts`) is supposed to be
 * `nav.ts` restated as data, so a mobile client can filter its own nav from
 * the same list a web client uses. That is only true if the two are kept in
 * lock-step by a test that fails the moment they drift -- otherwise "the
 * catalog matches nav.ts" is just a comment somebody trusted once.
 */
import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG, MODULE_CODES, MODULE_CATALOG_BY_CODE } from '@silverline/shared';
import { NAV_GROUPS } from '../lib/nav';

/** nav.ts flattened the same way the catalog is: one entry per destination, in order. */
const navEntries = NAV_GROUPS.flatMap((g) => g.items.map((item) => ({
  label: item.label,
  permission: item.permission,
  requires: item.requires,
  anyOf: item.anyOf,
})));

describe('the module catalog matches nav.ts', () => {
  it('has exactly as many entries as nav.ts has destinations', () => {
    expect(MODULE_CATALOG).toHaveLength(navEntries.length);
  });

  it('gives every module a unique code, in nav.ts order', () => {
    expect(new Set(MODULE_CODES).size).toBe(MODULE_CODES.length);
  });

  it.each(MODULE_CATALOG.map((m, i) => [i, m] as const))(
    'entry %i (%s) has the same label, permission, requires and anyOf as nav.ts',
    (i, m) => {
      const nav = navEntries[i];
      expect(nav, `nav.ts has no destination at index ${i} for catalog entry ${m.code}`).toBeTruthy();
      expect(m.label).toBe(nav.label);
      expect(m.permission).toBe(nav.permission);
      expect(m.requires ?? undefined).toEqual(nav.requires ?? undefined);
      expect(m.anyOf ?? undefined).toEqual(nav.anyOf ?? undefined);
    },
  );

  it('leaves out a permission for exactly the one nav.ts destination that has none', () => {
    // /security: gating it could lock out the very user the system is
    // forcing to enrol in MFA. Both files agree there is exactly one.
    const ungated = MODULE_CATALOG.filter((m) => !m.permission);
    expect(ungated.map((m) => m.code)).toEqual(['security']);
  });

  it('is addressable by code the same way the API keys its rows', () => {
    for (const code of MODULE_CODES) {
      expect(MODULE_CATALOG_BY_CODE[code]?.code).toBe(code);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  money, moneyShort, moneyIndian, day, percent,
  documentTypeLabel, documentHref, financialTone, slaState,
  utilisationWidth, categoryLabel, creditBlockLabel,
} from '../lib/finance';
import { NAV_GROUPS, QUICK_CREATE } from '../lib/nav';
import {
  APPROVAL_PERMISSIONS, BILLING_PERMISSIONS, EXPENSE_PERMISSIONS,
  LEDGER_PERMISSIONS, PROCUREMENT_PERMISSIONS,
} from '@silverline/shared';

describe('money', () => {
  it('prints zero rather than hiding it', () => {
    // A nil receivable is information; only an unrecorded figure is a dash.
    expect(money(0)).toContain('0.00');
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money('')).toBe('—');
  });

  it('accepts the string a numeric column comes back as', () => {
    // PostgreSQL NUMERIC arrives over the wire as a string, and every one of
    // these screens reads one.
    expect(money('1234.50')).toBe(money(1234.5));
  });

  it('refuses to render nonsense as a number', () => {
    expect(money('not a number')).toBe('—');
    expect(money(Number.NaN)).toBe('—');
  });

  it('drops paise for headline figures', () => {
    expect(moneyShort(1234.56)).not.toContain('.56');
  });
});

describe('moneyIndian', () => {
  it('uses lakh and crore, which is how the figure is read aloud', () => {
    expect(moneyIndian(12_000_000)).toBe('₹1.20 Cr');
    expect(moneyIndian(250_000)).toBe('₹2.50 L');
  });

  it('keeps small amounts in full', () => {
    expect(moneyIndian(4500)).toContain('4,500');
  });

  it('keeps the sign on a negative', () => {
    expect(moneyIndian(-250_000)).toBe('-₹2.50 L');
  });
});

describe('day and percent', () => {
  it('returns a dash for a missing or unparseable date', () => {
    expect(day(null)).toBe('—');
    expect(day('not a date')).toBe('—');
  });

  it('formats a percentage to one place by default', () => {
    expect(percent(12.345)).toBe('12.3%');
    expect(percent(12.345, 0)).toBe('12%');
    expect(percent(null)).toBe('—');
  });
});

describe('documentTypeLabel', () => {
  it('names the documents in the words the business uses', () => {
    expect(documentTypeLabel('PURCHASE_REQUISITION')).toBe('Requisition');
    expect(documentTypeLabel('RA_BILL')).toBe('RA bill');
  });

  it('degrades readably for a type it has not been taught', () => {
    // A new document type must not render as a raw enum in the middle of a
    // sentence, nor blank out the row.
    expect(documentTypeLabel('SOMETHING_NEW')).toBe('something new');
    expect(documentTypeLabel(null)).toBe('—');
  });
});

describe('documentHref', () => {
  it('links an approval back to the document it governs', () => {
    expect(documentHref('EXPENSE_CLAIM', 'abc')).toBe('/expenses?open=abc');
    expect(documentHref('PURCHASE_ORDER', 'abc')).toBe('/procurement?kind=orders&open=abc');
    expect(documentHref('RA_BILL', 'abc')).toBe('/billing?open=abc');
  });

  it('only links to routes that actually exist', () => {
    // The first draft pointed at /procurement/orders and /billing/ra-bills,
    // neither of which is a page. Pinning the link to the real route list
    // keeps a rename from quietly producing dead links in the approvals queue.
    const routes = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)));
    for (const type of ['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'EXPENSE_CLAIM', 'RA_BILL']) {
      const href = documentHref(type, 'abc')!;
      expect(routes.has(href.split('?')[0]), `${type} → ${href}`).toBe(true);
    }
  });

  it('returns nothing rather than a broken link', () => {
    // A type with no screen yet must not produce a link to a 404.
    expect(documentHref('LEAVE_REQUEST', 'abc')).toBeNull();
    expect(documentHref('EXPENSE_CLAIM', null)).toBeNull();
  });
});

describe('financialTone', () => {
  it('colours outcomes and leaves working states quiet', () => {
    // Fifty in-flight documents must not read as fifty alerts.
    expect(financialTone('APPROVED')).toBe('success');
    expect(financialTone('REJECTED')).toBe('danger');
    expect(financialTone('DRAFT')).toBe('neutral');
    expect(financialTone('CONVERTED')).toBe('info');
  });

  it('warns on anything that is waiting for a person', () => {
    expect(financialTone('PENDING')).toBe('warning');
    expect(financialTone('SUBMITTED')).toBe('warning');
  });

  it('stays neutral for a status it does not know', () => {
    expect(financialTone('WHATEVER')).toBe('neutral');
    expect(financialTone(null)).toBe('neutral');
  });
});

describe('slaState', () => {
  const now = new Date('2026-09-15T12:00:00Z');

  it('reports an untimed step as untimed, never as healthy', () => {
    // Green for a step nobody set a clock on claims a guarantee that does not
    // exist, which is worse than showing nothing.
    const s = slaState('2026-09-15T00:00:00Z', null, now);
    expect(s.tone).toBe('neutral');
    expect(s.remainingHours).toBeNull();
    expect(s.label).toBe('Waiting 12h');
  });

  it('counts a breach and says by how much', () => {
    const s = slaState('2026-09-13T12:00:00Z', 24, now);
    expect(s.breached).toBe(true);
    expect(s.tone).toBe('danger');
    expect(s.label).toBe('Overdue by 1d');
  });

  it('warns only inside the last quarter of the window', () => {
    // Earlier than that a nudge is noise; later it no longer changes anything.
    expect(slaState('2026-09-15T02:00:00Z', 48, now).tone).toBe('success');
    expect(slaState('2026-09-13T18:00:00Z', 48, now).tone).toBe('warning');
  });

  it('handles a step that has not started', () => {
    const s = slaState(null, 24, now);
    expect(s.label).toBe('Not started');
    expect(s.breached).toBe(false);
  });

  it('never reports negative waiting from a clock skew', () => {
    expect(slaState('2026-09-15T13:00:00Z', 24, now).waitedHours).toBe(0);
  });

  it('switches to days once the wait passes a day', () => {
    expect(slaState('2026-09-13T12:00:00Z', null, now).label).toBe('Waiting 2d');
  });
});

describe('utilisationWidth', () => {
  it('caps an overrun so the bar stays readable', () => {
    expect(utilisationWidth(150, 100)).toBe(100);
  });

  it('returns nothing for an unbudgeted head', () => {
    // A full bar would say "on budget" about a head with no budget at all.
    expect(utilisationWidth(5000, 0)).toBeNull();
    expect(utilisationWidth(5000, Number.NaN)).toBeNull();
  });

  it('scales normally inside the budget', () => {
    expect(utilisationWidth(25, 100)).toBe(25);
  });
});

describe('expense labels', () => {
  it('spells out the categories', () => {
    expect(categoryLabel('SITE_MATERIALS_PETTY')).toBe('Site materials (petty)');
    expect(categoryLabel('PER_DIEM')).toBe('Per diem');
  });

  it('turns a credit block code into the sentence finance will be asked for', () => {
    expect(creditBlockLabel('BLOCKED_SECTION_17_5')).toContain('17(5)');
    expect(creditBlockLabel('PLACE_OF_SUPPLY_UNREGISTERED')).toContain('no registration');
    expect(creditBlockLabel(null)).toBeNull();
  });
});

/**
 * Navigation gating.
 *
 * The permission on a nav item is a business rule, not a rendering detail: a
 * typo fails open only if nobody checks that the code exists on the server.
 */
describe('finance navigation', () => {
  const financeGroup = NAV_GROUPS.find((g) => g.title === 'Finance')!;

  it('gates every finance destination on a permission', () => {
    expect(financeGroup).toBeTruthy();
    for (const item of financeGroup.items) {
      expect(item.permission, `${item.href} has no permission gate`).toBeTruthy();
    }
  });

  it('uses the permission codes the server actually issues', () => {
    // Checked against the server's own constants rather than a list copied
    // here. A frozen literal only ever compares this file to itself, which is
    // precisely the check that would miss a code the backend renamed. A
    // colon-style code would never match, and the destination would silently
    // vanish for everybody without a single test failing.
    const issued = new Set<string>([
      ...APPROVAL_PERMISSIONS, ...PROCUREMENT_PERMISSIONS, ...EXPENSE_PERMISSIONS,
      ...BILLING_PERMISSIONS, ...LEDGER_PERMISSIONS,
    ]);
    for (const item of financeGroup.items) {
      expect(issued.has(item.permission!), `${item.href} gates on ${item.permission}, which the server never issues`)
        .toBe(true);
    }
  });

  it('offers a claim to anyone who can raise one', () => {
    const claim = QUICK_CREATE.find((q) => q.href === '/expenses');
    expect(claim?.permission).toBe('expense.manage');
  });

  it('never reuses a destination across two groups', () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

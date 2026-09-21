import { describe, expect, it } from 'vitest';
import {
  lineTotals, scheduleTotals, isSupplyProject,
  catalogueItemSchema, supplyLineSchema,
} from './supply.js';

describe('one line', () => {
  it('adds GST on top when the price excludes it', () => {
    expect(lineTotals({ quantity: 10, unit_price: 1000, gst_rate: 18 }))
      .toEqual({ taxable: 10000, gst: 1800, gross: 11800 });
  });

  it('works backwards out of the gross when the price includes it', () => {
    // 11800 inclusive of 18% is 10000 + 1800, exactly.
    expect(lineTotals({ quantity: 1, unit_price: 11800, gst_rate: 18, price_includes_gst: true }))
      .toEqual({ taxable: 10000, gst: 1800, gross: 11800 });
  });

  it('is a round trip: quoting inclusive or exclusive of the same money agrees', () => {
    const exclusive = lineTotals({ quantity: 3, unit_price: 4500, gst_rate: 12 });
    const inclusive = lineTotals({
      quantity: 1, unit_price: exclusive.gross, gst_rate: 12, price_includes_gst: true,
    });
    expect(inclusive.taxable).toBe(exclusive.taxable);
    expect(inclusive.gst).toBe(exclusive.gst);
  });

  it('charges nothing at nil rate, either way round', () => {
    expect(lineTotals({ quantity: 2, unit_price: 500, gst_rate: 0 }))
      .toEqual({ taxable: 1000, gst: 0, gross: 1000 });
    expect(lineTotals({ quantity: 2, unit_price: 500, gst_rate: 0, price_includes_gst: true }))
      .toEqual({ taxable: 1000, gst: 0, gross: 1000 });
  });

  it('keeps the parts summing to the gross on an awkward number', () => {
    const t = lineTotals({ quantity: 7, unit_price: 333.33, gst_rate: 5 });
    expect(t.taxable + t.gst).toBeCloseTo(t.gross, 2);
  });

  it('handles a fractional quantity, which is what a service-month is', () => {
    expect(lineTotals({ quantity: 1.5, unit_price: 20000, gst_rate: 18 }))
      .toEqual({ taxable: 30000, gst: 5400, gross: 35400 });
  });
});

describe('the whole schedule', () => {
  const LINES = [
    { quantity: 10, unit_price: 1000, gst_rate: 18 },
    { quantity: 2, unit_price: 5000, gst_rate: 12 },
    { quantity: 1, unit_price: 2360, gst_rate: 18, price_includes_gst: true },
  ];

  it('totals the money and says it in words', () => {
    const t = scheduleTotals(LINES);
    expect(t.taxable).toBe(10000 + 10000 + 2000);
    expect(t.gst).toBe(1800 + 1200 + 360);
    expect(t.gross).toBe(25360);
    expect(t.in_words).toContain('Twenty Five Thousand Three Hundred Sixty');
  });

  it('groups by slab, because the invoice has to show it that way', () => {
    const t = scheduleTotals(LINES);
    expect(t.by_rate).toEqual([
      { gst_rate: 12, taxable: 10000, gst: 1200 },
      { gst_rate: 18, taxable: 12000, gst: 2160 },
    ]);
  });

  it('splits CGST and SGST within the state', () => {
    const t = scheduleTotals(LINES, { supplierStateCode: '37', placeOfSupplyCode: '37' });
    expect(t.treatment).toBe('INTRA_STATE');
    expect(t.cgst + t.sgst).toBeCloseTo(t.gst, 2);
    expect(t.igst).toBe(0);
  });

  it('charges IGST across a state line', () => {
    const t = scheduleTotals(LINES, { supplierStateCode: '37', placeOfSupplyCode: '29' });
    expect(t.treatment).toBe('INTER_STATE');
    expect(t.igst).toBeCloseTo(t.gst, 2);
    expect(t.cgst).toBe(0);
  });

  it('splits each slab rather than the summed tax', () => {
    /*
     * Halving the total of three different slabs is arithmetic on a number
     * that means nothing. Per-slab it comes back to the same total, which
     * is the only property worth asserting.
     */
    const t = scheduleTotals(LINES, { supplierStateCode: '37', placeOfSupplyCode: '37' });
    const fromSlabs = t.by_rate.reduce((sum, r) => sum + r.gst, 0);
    expect(t.cgst + t.sgst).toBeCloseTo(fromSlabs, 2);
  });

  it('refuses to guess the tax heads without a place of supply', () => {
    const t = scheduleTotals(LINES);
    expect(t.treatment).toBeNull();
    expect(t.cgst).toBe(0);
    expect(t.sgst).toBe(0);
    expect(t.igst).toBe(0);
    // ...while still totalling the money, which does not depend on it.
    expect(t.gross).toBe(25360);
  });

  it('is zero and says so on an empty schedule', () => {
    const t = scheduleTotals([]);
    expect(t.gross).toBe(0);
    expect(t.in_words).toContain('Zero');
    expect(t.by_rate).toEqual([]);
  });
});

describe('which projects get one', () => {
  it('covers goods, services, goods and services, and AMC', () => {
    for (const code of ['goods', 'services', 'goods_and_services', 'amc']) {
      expect(isSupplyProject(code)).toBe(true);
    }
    expect(isSupplyProject('GOODS')).toBe(true);
  });

  it('leaves a measured contract alone', () => {
    expect(isSupplyProject('fieldwork')).toBe(false);
    expect(isSupplyProject(null)).toBe(false);
    expect(isSupplyProject(undefined)).toBe(false);
  });
});

describe('what may be entered', () => {
  it('refuses a GST rate that is not a slab', () => {
    // 1.8 for 18 is the typo that reaches an invoice.
    const bad = supplyLineSchema.safeParse({
      description: 'Rover', uom: 'nos', quantity: 1, unit_price: 100, gst_rate: 1.8,
    });
    expect(bad.success).toBe(false);
  });

  it('accepts every real slab', () => {
    for (const rate of [0, 0.25, 5, 12, 18, 28]) {
      expect(supplyLineSchema.safeParse({
        description: 'Item', uom: 'nos', quantity: 1, unit_price: 100, gst_rate: rate,
      }).success).toBe(true);
    }
  });

  it('refuses a quantity of nothing', () => {
    expect(supplyLineSchema.safeParse({
      description: 'Item', uom: 'nos', quantity: 0, unit_price: 100, gst_rate: 18,
    }).success).toBe(false);
  });

  it('allows a price of nothing, because a free replacement is still a line', () => {
    expect(supplyLineSchema.safeParse({
      description: 'Replacement under warranty', uom: 'nos', quantity: 1,
      unit_price: 0, gst_rate: 18,
    }).success).toBe(true);
  });

  it('defaults the price to excluding GST, which is how a tender is quoted', () => {
    const line = supplyLineSchema.parse({
      description: 'Item', uom: 'nos', quantity: 1, unit_price: 100, gst_rate: 18,
    });
    expect(line.price_includes_gst).toBe(false);
  });

  it('checks the shape of an HSN or SAC code', () => {
    expect(catalogueItemSchema.safeParse({
      code: 'RVR', name: 'GNSS rover', kind: 'GOOD', uom: 'nos',
      hsn_sac: '90158030', standard_rate: 250000, gst_rate: 18,
    }).success).toBe(true);
    expect(catalogueItemSchema.safeParse({
      code: 'RVR', name: 'GNSS rover', kind: 'GOOD', uom: 'nos',
      hsn_sac: '90', standard_rate: 250000, gst_rate: 18,
    }).success).toBe(false);
  });
});

describe('the grant map', () => {
  it('names every role, so a new one has to say what it gets', async () => {
    const { SUPPLY_ROLE_GRANTS } = await import('./supply.js');
    const { ROLE_CODES } = await import('./rbac.js');
    for (const code of ROLE_CODES) expect(SUPPLY_ROLE_GRANTS[code]).toBeDefined();
  });

  it('keeps rate-setting with the commercial roles', async () => {
    const { SUPPLY_ROLE_GRANTS } = await import('./supply.js');
    const { ROLE_CODES } = await import('./rbac.js');
    const setters = ROLE_CODES.filter((c) => SUPPLY_ROLE_GRANTS[c].includes('catalogue.manage'));
    expect([...setters].sort()).toEqual(
      ['ADMIN', 'BID_TENDER_MANAGER', 'SALES_BD_EXECUTIVE', 'SUPER_ADMIN'],
    );
  });
});

import { describe, expect, it } from 'vitest';
import { stockLocationSchema, stockCountSchema, LOCATION_KINDS } from '@silverline/shared';
import { STOCK_LOCATION_FIELDS, STOCK_COUNT_FIELDS, stockCountBody } from '../lib/stock-forms';

/**
 * B-008: the stock module (stock-locations/stock-counts/stock-reservations/
 * stock/reorder) had API routes and no UI. These check the new forms'
 * fields against the API's own zod schemas directly -- not just that a
 * field exists for each schema key, but that the exact bodies the form
 * produces actually parse.
 */

const LOC = { code: 'WH1', name: 'Central store', kind: 'WAREHOUSE' as const };
const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const LOCATION_ID = '22222222-2222-2222-2222-222222222222';
const ITEM_ID = '33333333-3333-3333-3333-333333333333';

describe('stock location form', () => {
  it('the plain fields the form collects round-trip through the create schema', () => {
    expect(stockLocationSchema.safeParse(LOC).success).toBe(true);
  });

  it('every field the form marks required really is required by the schema', () => {
    for (const key of ['code', 'name', 'kind']) {
      const without = { ...LOC } as Record<string, unknown>;
      delete without[key];
      expect(stockLocationSchema.safeParse(without).success, `${key} should be required`).toBe(false);
    }
  });

  it('offers exactly the location kinds the API accepts', () => {
    const kindField = STOCK_LOCATION_FIELDS.find((f) => f.key === 'kind');
    expect(kindField?.options?.map((o) => o.value).sort()).toEqual([...LOCATION_KINDS].sort());
  });

  it('offers the project/parent fields the schema conditionally requires for a site/sub-location', () => {
    // A site with no project, and a sub-location with no parent, are both
    // refused server-side -- the form has to offer somewhere to put them.
    expect(stockLocationSchema.safeParse({ ...LOC, kind: 'SITE' }).success).toBe(false);
    expect(stockLocationSchema.safeParse({ ...LOC, kind: 'SITE', project_id: PROJECT_ID }).success).toBe(true);
    expect(stockLocationSchema.safeParse({ ...LOC, kind: 'SUB_LOCATION' }).success).toBe(false);
    expect(['parent_id', 'project_id'].every((k) => STOCK_LOCATION_FIELDS.some((f) => f.key === k))).toBe(true);
  });
});

describe('stock count form', () => {
  const flat = {
    count_no: 'SC1', location_id: LOCATION_ID, counted_on: '2026-09-24',
    item_id: ITEM_ID, counted_quantity: '42',
  };

  it('folds the single line the form collects into the lines array the API requires', () => {
    const body = stockCountBody(flat);
    const parsed = stockCountSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect(body.lines).toEqual([{ item_id: ITEM_ID, counted_quantity: 42 }]);
  });

  it('keeps an optional batch number and remark when given, and coerces the quantity to a number', () => {
    const body = stockCountBody({ ...flat, counted_quantity: '5', batch_no: 'B1', remarks: 'Shelf 4' });
    expect(stockCountSchema.safeParse(body).success).toBe(true);
    expect(body.lines).toEqual([{ item_id: ITEM_ID, counted_quantity: 5, batch_no: 'B1', remarks: 'Shelf 4' }]);
  });

  it('every field the form collects has somewhere to land in the schema', () => {
    const offered = new Set(STOCK_COUNT_FIELDS.map((f) => f.key));
    expect(offered).toEqual(new Set(['count_no', 'location_id', 'counted_on', 'item_id', 'counted_quantity', 'batch_no', 'remarks']));
  });
});

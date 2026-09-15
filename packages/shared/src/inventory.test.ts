import { describe, expect, it } from 'vitest';
import {
  STOCK_TYPE_BEHAVIOUR, stockDelta, toBaseQuantity, stockPosition, checkIssue,
  reservationHolds, COUNT_TRANSITIONS, countVariances, materialVariances,
  createsLocationCycle, INVENTORY_ROLE_GRANTS, INVENTORY_PERMISSIONS,
  stockLocationSchema, stockTransactionSchema, stockCountSchema, countApprovalSchema,
  itemMasterSchema,
} from './inventory.js';

describe('transaction types', () => {
  it('distinguishes the three ways stock leaves', () => {
    // Consumption is the job doing its work, damage is a loss, and a transfer
    // is stock that still exists. A ledger that calls all three "out" cannot
    // produce a cost report worth reading.
    expect(STOCK_TYPE_BEHAVIOUR.CONSUMPTION.effect).toBe('OUT');
    expect(STOCK_TYPE_BEHAVIOUR.DAMAGE_LOSS.effect).toBe('OUT');
    expect(STOCK_TYPE_BEHAVIOUR.TRANSFER.effect).toBe('MOVE');
  });

  it('makes a transfer one transaction with two ends', () => {
    // Recorded as a separate issue and receipt, the second half gets forgotten
    // and stock evaporates in transit — which looks exactly like theft.
    expect(stockDelta('TRANSFER', 'FROM')).toBe(-1);
    expect(stockDelta('TRANSFER', 'TO')).toBe(1);
  });

  it('gives a receipt no effect on the source', () => {
    expect(stockDelta('PURCHASE_RECEIPT', 'TO')).toBe(1);
    expect(stockDelta('PURCHASE_RECEIPT', 'FROM')).toBe(0);
  });

  it('demands a reason for a loss or a correction', () => {
    expect(STOCK_TYPE_BEHAVIOUR.DAMAGE_LOSS.requiresReason).toBe(true);
    expect(STOCK_TYPE_BEHAVIOUR.ADJUSTMENT.requiresReason).toBe(true);
    expect(STOCK_TYPE_BEHAVIOUR.PURCHASE_RECEIPT.requiresReason).toBe(false);
  });
});

describe('toBaseQuantity', () => {
  const cement = { baseUom: 'KG', altUom: 'BAG', conversionFactor: 50 };

  it('converts the alternate unit into the base', () => {
    // Fifty bags plus fifty kilograms is a hundred of nothing.
    expect(toBaseQuantity(cement, 10, 'BAG')).toBe(500);
  });

  it('leaves a base-unit quantity alone', () => {
    expect(toBaseQuantity(cement, 10, 'KG')).toBe(10);
    expect(toBaseQuantity(cement, 10)).toBe(10);
  });

  it('refuses a unit the item is not measured in', () => {
    expect(() => toBaseQuantity(cement, 10, 'TONNE')).toThrow();
  });

  it('refuses an alternate unit with no factor rather than guessing one', () => {
    expect(() => toBaseQuantity({ baseUom: 'KG', altUom: 'BAG' }, 10, 'BAG')).toThrow();
  });
});

describe('stockPosition', () => {
  it('keeps reserved stock on hand but out of what is available', () => {
    // The bags are still in the store; they are promised to somebody.
    const p = stockPosition({ onHand: 100, reserved: 30 });
    expect(p.onHand).toBe(100);
    expect(p.available).toBe(70);
  });

  it('measures the reorder level against what is free', () => {
    // Stock entirely reserved needs reordering just as much as an empty shelf.
    const p = stockPosition({ onHand: 100, reserved: 95, reorderLevel: 10 });
    expect(p.belowReorder).toBe(true);
  });

  it('does not flag a reorder when none is configured', () => {
    expect(stockPosition({ onHand: 0, reserved: 0 }).belowReorder).toBe(false);
  });
});

describe('checkIssue', () => {
  it('allows an issue within what is available', () => {
    expect(checkIssue({ position: stockPosition({ onHand: 100, reserved: 20 }), quantity: 50 }).allowed)
      .toBe(true);
  });

  it('refuses an issue that would go past somebody else’s reservation', () => {
    const v = checkIssue({ position: stockPosition({ onHand: 100, reserved: 80 }), quantity: 50 });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('INSUFFICIENT_STOCK');
    // The message has to explain why a full store cannot supply the issue.
    expect(v.reason).toContain('reserved');
    expect(v.shortBy).toBe(30);
  });

  it('lets a project draw on its own reservation', () => {
    const v = checkIssue({
      position: stockPosition({ onHand: 100, reserved: 80 }),
      quantity: 50, fromReservation: 80,
    });
    expect(v.allowed).toBe(true);
  });

  it('allows a negative issue only under the override, and still reports it', () => {
    // Material does move before the paperwork catches up, but a ledger that
    // silently goes negative has stopped describing anything real.
    const blocked = checkIssue({ position: stockPosition({ onHand: 5, reserved: 0 }), quantity: 20 });
    expect(blocked.allowed).toBe(false);
    const allowed = checkIssue({
      position: stockPosition({ onHand: 5, reserved: 0 }), quantity: 20, allowNegative: true,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.shortBy).toBe(15);
  });

  it('refuses an issue of nothing', () => {
    expect(checkIssue({ position: stockPosition({ onHand: 100, reserved: 0 }), quantity: 0 }).code)
      .toBe('INVALID_QUANTITY');
  });
});

describe('reservationHolds', () => {
  it('holds an active reservation', () => {
    expect(reservationHolds({ state: 'ACTIVE' }, '2026-09-15')).toBe(true);
  });

  it('stops holding once it expires, without anybody acting', () => {
    // A reservation nobody released would otherwise hold material for a
    // project that finished last year, and the store would look empty.
    expect(reservationHolds({ state: 'ACTIVE', expiresOn: '2026-09-01' }, '2026-09-15')).toBe(false);
  });

  it('holds right up to the expiry date', () => {
    expect(reservationHolds({ state: 'ACTIVE', expiresOn: '2026-09-15' }, '2026-09-15')).toBe(true);
  });

  it('does not hold once released or consumed', () => {
    expect(reservationHolds({ state: 'RELEASED' }, '2026-09-15')).toBe(false);
    expect(reservationHolds({ state: 'CONSUMED' }, '2026-09-15')).toBe(false);
  });
});

describe('stock counts', () => {
  it('approves before it moves any stock', () => {
    // Otherwise a physical count is a way to write material off with nobody
    // signing for it.
    expect(COUNT_TRANSITIONS.COUNTED).toContain('APPROVED');
    expect(COUNT_TRANSITIONS.DRAFT).not.toContain('APPROVED');
  });

  it('treats an approved count as final', () => {
    expect(COUNT_TRANSITIONS.APPROVED).toEqual([]);
  });

  it('reports a shortage and a surplus differently', () => {
    const v = countVariances([
      { reference: 'a', systemQuantity: 100, countedQuantity: 90 },
      { reference: 'b', systemQuantity: 100, countedQuantity: 110 },
      { reference: 'c', systemQuantity: 100, countedQuantity: 100 },
    ]);
    expect(v[0].direction).toBe('SHORT');
    expect(v[0].variance).toBe(-10);
    expect(v[1].direction).toBe('OVER');
    expect(v[2].direction).toBe('MATCH');
  });

  it('gives the variance as a proportion, because scale decides if it matters', () => {
    // Two short of five is a problem; two short of five thousand is dust.
    const v = countVariances([
      { reference: 'small', systemQuantity: 5, countedQuantity: 3 },
      { reference: 'large', systemQuantity: 5000, countedQuantity: 4998 },
    ]);
    expect(v[0].variancePct).toBe(-40);
    expect(v[1].variancePct).toBe(-0.04);
  });

  it('has no percentage against a system quantity of zero', () => {
    // Found stock the ledger never knew about is a finding, not a percentage.
    expect(countVariances([{ reference: 'x', systemQuantity: 0, countedQuantity: 8 }])[0].variancePct)
      .toBeNull();
  });

  it('picks out the lines worth a second look', () => {
    const v = countVariances([
      { reference: 'small', systemQuantity: 5, countedQuantity: 3 },
      { reference: 'large', systemQuantity: 5000, countedQuantity: 4998 },
      { reference: 'exact', systemQuantity: 10, countedQuantity: 10 },
    ]);
    const material = materialVariances(v, { quantityThreshold: 5, percentThreshold: 10 });
    expect(material.map(m => m.reference)).toEqual(['small']);
  });
});

describe('createsLocationCycle', () => {
  const nodes = [
    { id: 'a', parentId: null, kind: 'WAREHOUSE' as const },
    { id: 'b', parentId: 'a', kind: 'SUB_LOCATION' as const },
    { id: 'c', parentId: 'b', kind: 'SUB_LOCATION' as const },
  ];

  it('refuses a location becoming its own parent', () => {
    expect(createsLocationCycle(nodes, 'a', 'a')).toBe(true);
  });

  it('refuses a location being parented under its own descendant', () => {
    // Every roll-up query would then never terminate.
    expect(createsLocationCycle(nodes, 'a', 'c')).toBe(true);
  });

  it('allows an ordinary move', () => {
    expect(createsLocationCycle(nodes, 'c', 'a')).toBe(false);
  });

  it('allows detaching to the top', () => {
    expect(createsLocationCycle(nodes, 'c', null)).toBe(false);
  });
});

describe('inventory grants', () => {
  it('does not let the storekeeper approve the count of their own store', () => {
    expect(INVENTORY_ROLE_GRANTS.INVENTORY_MANAGER).toContain('stockcount.manage');
    expect(INVENTORY_ROLE_GRANTS.INVENTORY_MANAGER).not.toContain('stockcount.approve');
  });

  it('reserves the negative-stock override for the top role', () => {
    const holders = Object.entries(INVENTORY_ROLE_GRANTS)
      .filter(([, perms]) => perms.includes('stock.negative_override')).map(([role]) => role);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('keeps the auditor to reads', () => {
    for (const p of INVENTORY_ROLE_GRANTS.AUDITOR) expect(p.endsWith('.read')).toBe(true);
  });

  it('lets a project manager draw and reserve without running the store', () => {
    expect(INVENTORY_ROLE_GRANTS.PROJECT_MANAGER).toContain('stock.issue');
    expect(INVENTORY_ROLE_GRANTS.PROJECT_MANAGER).not.toContain('stock.receive');
  });

  it('names every granted permission in the permission list', () => {
    const known = new Set<string>(INVENTORY_PERMISSIONS);
    for (const perms of Object.values(INVENTORY_ROLE_GRANTS)) {
      for (const p of perms) expect(known.has(p)).toBe(true);
    }
  });
});

describe('schemas', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('demands a source for an issue and a destination for a receipt', () => {
    expect(stockTransactionSchema.safeParse({
      transaction_type: 'ISSUE', item_id: uuid, quantity: 5, reference: 'R1',
    }).success).toBe(false);
    expect(stockTransactionSchema.safeParse({
      transaction_type: 'PURCHASE_RECEIPT', item_id: uuid, quantity: 5, reference: 'R1',
    }).success).toBe(false);
  });

  it('demands a reason for damage', () => {
    expect(stockTransactionSchema.safeParse({
      transaction_type: 'DAMAGE_LOSS', item_id: uuid, quantity: 5,
      from_location_id: uuid, reference: 'R1',
    }).success).toBe(false);
  });

  it('refuses a transfer to the same place', () => {
    expect(stockTransactionSchema.safeParse({
      transaction_type: 'TRANSFER', item_id: uuid, quantity: 5,
      from_location_id: uuid, to_location_id: uuid, reference: 'R1',
    }).success).toBe(false);
  });

  it('insists a site location names its project', () => {
    // Otherwise it cannot roll up into that project's material cost, which is
    // the only reason to have one.
    expect(stockLocationSchema.safeParse({ code: 'S1', name: 'Site 1', kind: 'SITE' }).success)
      .toBe(false);
    expect(stockLocationSchema.safeParse({
      code: 'S1', name: 'Site 1', kind: 'SITE', project_id: uuid,
    }).success).toBe(true);
  });

  it('insists a sub-location sits inside something', () => {
    expect(stockLocationSchema.safeParse({ code: 'R1', name: 'Rack 1', kind: 'SUB_LOCATION' }).success)
      .toBe(false);
  });

  it('refuses an alternate unit with no conversion factor', () => {
    expect(itemMasterSchema.safeParse({ alt_uom: 'BAG' }).success).toBe(false);
    expect(itemMasterSchema.safeParse({ alt_uom: 'BAG', conversion_factor: 50 }).success).toBe(true);
  });

  it('refuses a count with no lines', () => {
    expect(stockCountSchema.safeParse({
      count_no: 'C1', location_id: uuid, counted_on: '2026-09-15', lines: [],
    }).success).toBe(false);
  });

  it('demands a reason on either count decision', () => {
    expect(countApprovalSchema.safeParse({ action: 'APPROVE' }).success).toBe(false);
    expect(countApprovalSchema.safeParse({ action: 'APPROVE', reason: 'Counted twice' }).success)
      .toBe(true);
  });
});

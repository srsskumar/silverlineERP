import { describe, expect, it } from 'vitest';
import {
  ASSET_TYPE_SEEDS, ASSET_CATEGORY_SEEDS, ASSET_CONDITIONS, ASSET_CONDITION_CODES,
  assetConditionLabel, conditionNeedsNote, assetLocation, canMatchOnSerial,
} from './assets.js';

describe('the asset vocabulary', () => {
  it('covers every instrument the note names', () => {
    const codes = ASSET_TYPE_SEEDS.map(t => t.code);
    for (const wanted of [
      'ROVER', 'DRONE', 'TRIPOD', 'BIPOD', 'LAPTOP', 'CPU', 'MONITOR',
      'EXTERNAL_RADIO', 'EXTERNAL_BATTERY', 'EXTERNAL_RADIO_ANTENNA',
    ]) {
      expect(codes, wanted).toContain(wanted);
    }
  });

  it('puts the daily instruments before the office equipment', () => {
    // A crew signing rovers in and out every morning should not scroll past
    // three kinds of monitor to reach them.
    const order = (c: string) => ASSET_TYPE_SEEDS.find(t => t.code === c)!.displayOrder;
    expect(order('ROVER')).toBeLessThan(order('LAPTOP'));
    expect(order('OTHER')).toBeGreaterThan(order('MONITOR'));
  });

  it('has no duplicate codes in either list', () => {
    for (const list of [ASSET_TYPE_SEEDS, ASSET_CATEGORY_SEEDS]) {
      expect(new Set(list.map(x => x.code)).size).toBe(list.length);
    }
  });

  it('offers the conditions a receiver picks from, and no more', () => {
    expect(ASSET_CONDITION_CODES).toEqual([
      'BRAND_NEW', 'EXCELLENT', 'GOOD', 'REPAIR', 'UNUSABLE', 'OTHER',
    ]);
  });

  it('demands a note for "other", and not otherwise', () => {
    expect(conditionNeedsNote('OTHER')).toBe(true);
    expect(conditionNeedsNote('GOOD')).toBe(false);
    expect(conditionNeedsNote(null)).toBe(false);
  });

  it('reads a condition the register held before this list existed', () => {
    // Rewriting WORN to fit a new dropdown would invent a fact about
    // equipment nobody re-inspected.
    expect(assetConditionLabel('GOOD')).toBe('Good');
    expect(assetConditionLabel('WORN')).toBe('Worn');
    expect(assetConditionLabel('FAIR')).toBe('Fair');
    expect(assetConditionLabel(null)).toBe('—');
  });

  it('title-cases a free-text value the register holds verbatim', () => {
    // Mobile used to send condition as free text; "good" was stored as-is
    // (findings-mobile-audit2 MA-002) and must not read as a lower-case code.
    expect(assetConditionLabel('good')).toBe('Good');
    expect(assetConditionLabel('needs_repair')).toBe('Needs repair');
  });
});

describe('where an asset is', () => {
  it('is in the field exactly when somebody holds it', () => {
    // Worked out from the allocation rather than stored beside it: two
    // columns that can disagree leave nobody able to say which is lying.
    expect(assetLocation({ id: 'x' })).toBe('IN_FIELD');
    expect(assetLocation(null)).toBe('IN_OFFICE');
    expect(assetLocation(undefined)).toBe('IN_OFFICE');
  });
});

describe('recognising the same asset twice in an import', () => {
  it('matches on serial number', () => {
    expect(canMatchOnSerial('ELECTRONIC', 'SN-4471')).toBe(true);
  });

  it('will not match an accessory, which has no serial worth trusting', () => {
    // Two rows for a box of tripod screws are two boxes, not one box twice.
    // Merging them would silently destroy real stock.
    expect(canMatchOnSerial('ACCESSORY', 'SN-4471')).toBe(false);
    expect(canMatchOnSerial('ACCESSORY', null)).toBe(false);
  });

  it('will not match on a blank serial, whatever the category', () => {
    expect(canMatchOnSerial('ELECTRONIC', '')).toBe(false);
    expect(canMatchOnSerial('ELECTRONIC', '   ')).toBe(false);
    expect(canMatchOnSerial('ELECTRONIC', null)).toBe(false);
  });
});

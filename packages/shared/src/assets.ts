/**
 * The asset register (enhancement note 3).
 *
 * A survey programme lives or dies on its instruments, and the register has
 * to answer four questions about each one: what it is, what condition it is
 * in, where it is right now, and who had it before. The first two are
 * vocabulary; the second two are history.
 *
 * Types and categories are seeded rather than fixed. The note asks for "an
 * option to add more" for both, and it is right: nobody can enumerate in
 * advance every instrument a survey firm will buy, and a register that
 * refuses the thing you just bought gets kept in a spreadsheet instead.
 */

export interface AssetLookupSeed {
  code: string;
  label: string;
  displayOrder: number;
}

/**
 * What the thing is.
 *
 * Ordered so the instruments a survey crew signs in and out daily come
 * first, and the office equipment that moves once a year comes last.
 */
export const ASSET_TYPE_SEEDS: AssetLookupSeed[] = [
  { code: 'ROVER', label: 'Rover', displayOrder: 10 },
  { code: 'DRONE', label: 'Drone', displayOrder: 20 },
  { code: 'TRIPOD', label: 'Tripod', displayOrder: 30 },
  { code: 'BIPOD', label: 'Bipod', displayOrder: 40 },
  { code: 'EXTERNAL_RADIO', label: 'External radio', displayOrder: 50 },
  { code: 'EXTERNAL_RADIO_ANTENNA', label: 'External radio antenna', displayOrder: 60 },
  { code: 'EXTERNAL_BATTERY', label: 'External battery', displayOrder: 70 },
  { code: 'LAPTOP', label: 'Laptop', displayOrder: 80 },
  { code: 'CPU', label: 'CPU', displayOrder: 90 },
  { code: 'MONITOR', label: 'Monitor', displayOrder: 100 },
  { code: 'OTHER', label: 'Other', displayOrder: 999 },
];

/**
 * What kind of thing it is.
 *
 * The note names electrical, electronic and accessories. The distinction
 * that earns its keep is the last one: an accessory has no serial number
 * worth tracking, and the import rules turn on that.
 */
export const ASSET_CATEGORY_SEEDS: AssetLookupSeed[] = [
  { code: 'ELECTRONIC', label: 'Electronic', displayOrder: 10 },
  { code: 'ELECTRICAL', label: 'Electrical', displayOrder: 20 },
  { code: 'ACCESSORY', label: 'Accessories', displayOrder: 30 },
];

/**
 * The state it is in.
 *
 * Fixed rather than extensible, because these are the words a receiver picks
 * from while holding the thing, and a list that grows becomes a list nobody
 * reads to the end. "Other" carries the escape hatch, and demands a note --
 * "other" with nothing written is the same as saying nothing.
 */
export const ASSET_CONDITIONS = [
  { code: 'BRAND_NEW', label: 'Brand new' },
  { code: 'EXCELLENT', label: 'Excellent' },
  { code: 'GOOD', label: 'Good' },
  { code: 'REPAIR', label: 'Needs repair' },
  { code: 'UNUSABLE', label: 'Unusable' },
  { code: 'OTHER', label: 'Other' },
] as const;

export const ASSET_CONDITION_CODES = ASSET_CONDITIONS.map(c => c.code);
export type AssetCondition = (typeof ASSET_CONDITIONS)[number]['code'];

/**
 * Conditions that existed before this vocabulary did.
 *
 * The register already held WORN and FAIR. Rewriting history to fit a new
 * dropdown would be inventing facts about equipment nobody re-inspected, so
 * the old words stay valid for the rows that carry them and simply are not
 * offered for new ones.
 */
export const LEGACY_ASSET_CONDITIONS = ['WORN', 'FAIR', 'NEW', 'DAMAGED'] as const;

export function assetConditionLabel(code: string | null | undefined): string {
  const known = ASSET_CONDITIONS.find(c => c.code === code);
  if (known) return known.label;
  if (!code) return '—';
  // A legacy or free-text value reads as words, title-cased ("good" -> "Good").
  return code.charAt(0).toUpperCase() + code.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** "Other" with nothing written is the same as saying nothing. */
export function conditionNeedsNote(code: string | null | undefined): boolean {
  return code === 'OTHER';
}

/**
 * Where the thing is, worked out rather than stored.
 *
 * An asset is in the field when somebody currently holds it and nowhere
 * else. Storing that as a separate column invites the two to disagree --
 * an asset marked "in office" with an open allocation against it, and no way
 * to tell which is lying. The allocation is the fact; the location is a
 * reading of it.
 */
export type AssetLocation = 'IN_OFFICE' | 'IN_FIELD';

export function assetLocation(openAssignment: unknown): AssetLocation {
  return openAssignment ? 'IN_FIELD' : 'IN_OFFICE';
}

export const ASSET_LOCATION_LABELS: Record<AssetLocation, string> = {
  IN_OFFICE: 'In office',
  IN_FIELD: 'In field',
};

/**
 * Whether a duplicate import row can be recognised at all.
 *
 * The note asks that duplicates be identified by serial number, "other than
 * accessories" -- and that exception is the whole rule. A box of tripod
 * screws has no serial number, so two rows for it are two boxes, not one box
 * twice. Matching those on anything else would silently merge real stock.
 */
export function canMatchOnSerial(
  categoryCode: string | null | undefined, serial: string | null | undefined,
): boolean {
  if (!serial || !serial.trim()) return false;
  return categoryCode !== 'ACCESSORY';
}

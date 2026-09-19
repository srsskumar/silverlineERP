import { z } from 'zod';
import type { RoleCode } from './rbac.js';

/**
 * Inventory and material control (§44).
 *
 * The existing ledger recorded a direction — IN or OUT — and nothing else.
 * That is an item ledger, not stock control, and it cannot answer the two
 * questions a storekeeper actually asks:
 *
 *  - *Do we have fifty bags at this site?* Direction alone has no location, so
 *    the only answer is an organisation-wide total that is true of nowhere.
 *  - *Why did the stock go?* Consumption, damage and a transfer are all "out",
 *    and a cost report that cannot tell them apart is worthless: one is the
 *    job doing its work, one is a loss, and one is stock that still exists.
 *
 * So the transaction *type* is the recorded fact, and direction is derived
 * from it.
 */

/* ------------------------------------------------------ transaction types */

export const STOCK_TRANSACTION_TYPES = [
  'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'ISSUE', 'TRANSFER', 'RETURN_TO_VENDOR',
  'RETURN_FROM_PROJECT', 'ADJUSTMENT', 'DAMAGE_LOSS', 'CONSUMPTION', 'COUNT_ADJUSTMENT',
] as const;
export type StockTransactionType = (typeof STOCK_TRANSACTION_TYPES)[number];

export interface TypeBehaviour {
  /** Whether stock arrives, leaves, or moves between two places. */
  effect: 'IN' | 'OUT' | 'MOVE';
  requiresFrom: boolean;
  requiresTo: boolean;
  /** Types whose whole purpose is to explain a discrepancy. */
  requiresReason: boolean;
  label: string;
}

/**
 * What each type does to stock, and what it must name to be meaningful.
 *
 * A transfer is a single transaction with two locations rather than an issue
 * and a receipt somebody has to remember to pair. Recorded separately, the
 * second half gets forgotten and stock evaporates in transit — and the
 * evaporation looks exactly like theft in the variance report.
 */
export const STOCK_TYPE_BEHAVIOUR: Record<StockTransactionType, TypeBehaviour> = {
  OPENING_BALANCE: { effect: 'IN', requiresFrom: false, requiresTo: true, requiresReason: false, label: 'Opening balance' },
  PURCHASE_RECEIPT: { effect: 'IN', requiresFrom: false, requiresTo: true, requiresReason: false, label: 'Purchase receipt' },
  RETURN_FROM_PROJECT: { effect: 'IN', requiresFrom: false, requiresTo: true, requiresReason: false, label: 'Return from project' },
  ISSUE: { effect: 'OUT', requiresFrom: true, requiresTo: false, requiresReason: false, label: 'Issue to project' },
  CONSUMPTION: { effect: 'OUT', requiresFrom: true, requiresTo: false, requiresReason: false, label: 'Consumption' },
  RETURN_TO_VENDOR: { effect: 'OUT', requiresFrom: true, requiresTo: false, requiresReason: false, label: 'Return to vendor' },
  // A loss and a correction both need saying why: they are the entries an
  // auditor reads first, and an unexplained one cannot be defended.
  DAMAGE_LOSS: { effect: 'OUT', requiresFrom: true, requiresTo: false, requiresReason: true, label: 'Damage or loss' },
  ADJUSTMENT: { effect: 'IN', requiresFrom: false, requiresTo: true, requiresReason: true, label: 'Adjustment' },
  COUNT_ADJUSTMENT: { effect: 'IN', requiresFrom: false, requiresTo: true, requiresReason: true, label: 'Count adjustment' },
  TRANSFER: { effect: 'MOVE', requiresFrom: true, requiresTo: true, requiresReason: false, label: 'Transfer' },
};

/** Signed effect on a location's stock: +1 arriving, -1 leaving, 0 for a move. */
export function stockDelta(type: StockTransactionType, atLocation: 'FROM' | 'TO'): number {
  const behaviour = STOCK_TYPE_BEHAVIOUR[type];
  if (behaviour.effect === 'MOVE') return atLocation === 'FROM' ? -1 : 1;
  if (behaviour.effect === 'IN') return atLocation === 'TO' ? 1 : 0;
  return atLocation === 'FROM' ? -1 : 0;
}

/* ------------------------------------------------- units of measure */

export interface ItemUom {
  /** The unit every ledger figure is stored in. */
  baseUom: string;
  /** A second unit the item is bought or issued in, if any. */
  altUom?: string | null;
  /** How many base units one alternate unit contains. */
  conversionFactor?: number | null;
}

/**
 * Convert an entered quantity to the base unit.
 *
 * Material is bought in bags and issued in kilograms, and a ledger that stores
 * whichever unit was typed produces sums that are simply wrong — fifty bags
 * plus fifty kilograms is a hundred of nothing. Everything is stored in the
 * base unit; what was typed is kept alongside so the entry still reads the way
 * the storekeeper wrote it.
 */
export function toBaseQuantity(item: ItemUom, quantity: number, uom?: string | null): number {
  if (!uom || uom === item.baseUom) return round3(quantity);
  if (item.altUom && uom === item.altUom) {
    const factor = item.conversionFactor ?? 0;
    if (factor <= 0) {
      throw new Error(`No conversion factor from ${item.altUom} to ${item.baseUom}`);
    }
    return round3(quantity * factor);
  }
  throw new Error(`${uom} is not a unit this item is measured in`);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/* --------------------------------------------------------- availability */

export interface StockPosition {
  /** Physically present at the location. */
  onHand: number;
  /** Spoken for by a project or task, and still physically present. */
  reserved: number;
  /** What anybody else may take. */
  available: number;
  /** True when the item has fallen to or below its reorder level. */
  belowReorder: boolean;
}

/**
 * On-hand, reserved and available.
 *
 * Reservation reduces what is *available*, never what is on hand: the bags are
 * still in the store, they are simply promised to somebody. Collapsing the two
 * breaks in both directions — treat reserved stock as gone and a stock check
 * says the store is empty while it is full; treat it as free and the same bags
 * get promised twice.
 */
export function stockPosition(args: {
  onHand: number;
  reserved: number;
  reorderLevel?: number | null;
}): StockPosition {
  const onHand = round3(args.onHand);
  const reserved = round3(Math.max(0, args.reserved));
  const available = round3(onHand - reserved);
  const level = args.reorderLevel ?? 0;
  return {
    onHand,
    reserved,
    available,
    // Measured on what is actually free. An item with stock entirely reserved
    // needs reordering just as much as one with an empty shelf.
    belowReorder: level > 0 && available <= level,
  };
}

export interface IssueVerdict {
  allowed: boolean;
  code?: string;
  reason?: string;
  /** How far the issue would push the location below zero. */
  shortBy?: number;
}

/**
 * Whether stock can leave a location.
 *
 * Refused by default when it would drive the balance negative. In field
 * operations material genuinely does move before the paperwork catches up, so
 * an override exists — but it is a permission and it is recorded, because a
 * ledger that quietly goes negative has stopped describing anything real.
 */
export function checkIssue(args: {
  position: StockPosition;
  quantity: number;
  /** Issuing against your own reservation draws on it rather than free stock. */
  fromReservation?: number;
  allowNegative?: boolean;
}): IssueVerdict {
  const quantity = round3(args.quantity);
  if (quantity <= 0) {
    return { allowed: false, code: 'INVALID_QUANTITY', reason: 'An issue has to move something' };
  }
  const drawable = round3(args.position.available + Math.max(0, args.fromReservation ?? 0));
  if (quantity <= drawable) return { allowed: true };

  const shortBy = round3(quantity - drawable);
  if (args.allowNegative) return { allowed: true, shortBy };
  return {
    allowed: false,
    code: 'INSUFFICIENT_STOCK',
    reason: args.position.reserved > 0
      ? `Only ${drawable} is available here — ${args.position.onHand} on hand, ${args.position.reserved} reserved for somebody else`
      : `Only ${drawable} is available here`,
    shortBy,
  };
}

/* --------------------------------------------------------- reservations */

export const RESERVATION_STATES = ['ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

/**
 * Whether a reservation still holds stock.
 *
 * An expired reservation stops holding stock on its expiry date without
 * anybody doing anything. A reservation nobody ever released would otherwise
 * hold material for a project that finished last year, and the store would
 * look empty while being full.
 */
export function reservationHolds(
  reservation: { state: ReservationState; expiresOn?: string | null },
  today: string,
): boolean {
  if (reservation.state !== 'ACTIVE') return false;
  if (reservation.expiresOn && reservation.expiresOn < today) return false;
  return true;
}

/* -------------------------------------------------------- stock counts */

export const COUNT_STATES = ['DRAFT', 'COUNTED', 'APPROVED', 'CANCELLED'] as const;
export type CountState = (typeof COUNT_STATES)[number];

export const COUNT_TRANSITIONS: Record<CountState, CountState[]> = {
  DRAFT: ['COUNTED', 'CANCELLED'],
  // A count is approved before it moves any stock, so that a physical count
  // cannot be used to write material off without anybody signing for it.
  COUNTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: [],
  CANCELLED: [],
};

export interface CountLine {
  reference: string;
  /** What the ledger said at the moment of counting. */
  systemQuantity: number;
  /** What was physically found. */
  countedQuantity: number;
}

export interface CountVariance extends CountLine {
  variance: number;
  /** A shortage is the line that needs explaining; a surplus is nearly as odd. */
  direction: 'SHORT' | 'OVER' | 'MATCH';
  variancePct: number | null;
}

/**
 * The variance on each counted line.
 *
 * Reported as a percentage as well as a quantity because scale decides whether
 * a difference matters: two bags short of five is a problem, two short of five
 * thousand is dust on the scale.
 */
export function countVariances(lines: CountLine[]): CountVariance[] {
  return lines.map(line => {
    const variance = round3(line.countedQuantity - line.systemQuantity);
    return {
      ...line,
      variance,
      direction: variance < 0 ? 'SHORT' : variance > 0 ? 'OVER' : 'MATCH',
      variancePct: line.systemQuantity > 0
        ? Math.round((variance / line.systemQuantity) * 10_000) / 100
        : null,
    };
  });
}

/** Lines worth a second look, by absolute quantity or by proportion. */
export function materialVariances(
  variances: CountVariance[],
  opts: { quantityThreshold?: number; percentThreshold?: number } = {},
): CountVariance[] {
  const q = opts.quantityThreshold ?? 0;
  const p = opts.percentThreshold ?? 0;
  return variances.filter(v =>
    v.direction !== 'MATCH' &&
    (Math.abs(v.variance) > q || (v.variancePct !== null && Math.abs(v.variancePct) > p)));
}

/* ------------------------------------------------------------ locations */

export const LOCATION_KINDS = ['WAREHOUSE', 'SITE', 'SUB_LOCATION'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export interface LocationNode {
  id: string;
  parentId?: string | null;
  kind: LocationKind;
}

/**
 * Whether a proposed parent would create a cycle (§44.2).
 *
 * A location that is its own ancestor makes the hierarchy unwalkable and every
 * roll-up query non-terminating.
 */
export function createsLocationCycle(
  nodes: LocationNode[], childId: string, proposedParentId: string | null,
): boolean {
  if (!proposedParentId) return false;
  if (proposedParentId === childId) return true;
  const byId = new Map(nodes.map(n => [n.id, n]));
  let cursor: string | null | undefined = proposedParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === childId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/* ------------------------------------------------------------ permissions */

export const INVENTORY_PERMISSIONS = [
  'stock.read', 'stock.issue', 'stock.receive', 'stock.transfer',
  'stock.adjust', 'location.read', 'location.manage',
  'reservation.read', 'reservation.manage',
  'stockcount.read', 'stockcount.manage', 'stockcount.approve',
  // Issuing stock a location does not have. Recorded, and held narrowly: a
  // ledger that can go negative without anybody noticing describes nothing.
  'stock.negative_override',
] as const;

export const INVENTORY_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...INVENTORY_PERMISSIONS],
  ADMIN: INVENTORY_PERMISSIONS.filter(p => p !== 'stock.negative_override'),
  // Runs the stores: receives, issues, transfers and counts. Does not approve
  // the count that would write off the variance in their own store.
  INVENTORY_MANAGER: ['stock.read', 'stock.issue', 'stock.receive', 'stock.transfer',
    'stock.adjust', 'location.read', 'location.manage',
    'reservation.read', 'reservation.manage', 'stockcount.read', 'stockcount.manage'],
  // Draws material for their site and reserves it ahead of need.
  PROJECT_MANAGER: ['stock.read', 'stock.issue', 'location.read',
    'reservation.read', 'reservation.manage', 'stockcount.read'],
  TEAM_LEAD: ['stock.read', 'location.read', 'reservation.read'],
  AUDITOR: ['stock.read', 'location.read', 'reservation.read', 'stockcount.read'],
  BID_TENDER_MANAGER: ['stock.read'],
  GOVT_OBSERVER: [],
  EMPLOYEE: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  SALES_BD_EXECUTIVE: [],
  CLIENT_VIEWER: [],
};

/* ---------------------------------------------------------------- schemas */

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const qty = z.coerce.number().finite().positive();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const stockLocationSchema = z.object({
  code: text.max(30).transform(v => v.toUpperCase()),
  name: text.max(150),
  kind: z.enum(LOCATION_KINDS),
  parent_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  address_line: z.string().trim().max(500).optional(),
  active: z.boolean().default(true),
}).superRefine((v, ctx) => {
  // A site location that names no project cannot be rolled up into a project's
  // material cost, which is the only reason to have one.
  if (v.kind === 'SITE' && !v.project_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['project_id'],
      message: 'A site location has to say which project it belongs to',
    });
  }
  if (v.kind === 'SUB_LOCATION' && !v.parent_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['parent_id'],
      message: 'A sub-location has to sit inside another location',
    });
  }
});

export const stockTransactionSchema = z.object({
  transaction_type: z.enum(STOCK_TRANSACTION_TYPES),
  item_id: uuid,
  quantity: qty,
  /** The unit the storekeeper entered; converted to the item's base unit. */
  uom: z.string().trim().max(20).optional(),
  from_location_id: uuid.nullable().optional(),
  to_location_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  task_id: uuid.nullable().optional(),
  batch_no: z.string().trim().max(50).optional(),
  serial_no: z.string().trim().max(100).optional(),
  occurred_at: dateString.optional(),
  document_type: z.string().trim().max(30).optional(),
  document_id: uuid.nullable().optional(),
  reference: text.max(100),
  reason: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  const behaviour = STOCK_TYPE_BEHAVIOUR[v.transaction_type];
  if (behaviour.requiresFrom && !v.from_location_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['from_location_id'],
      message: `${behaviour.label} has to say where the stock left`,
    });
  }
  if (behaviour.requiresTo && !v.to_location_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['to_location_id'],
      message: `${behaviour.label} has to say where the stock arrived`,
    });
  }
  if (behaviour.requiresReason && !v.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['reason'],
      message: `${behaviour.label} has to say why — it is the entry an auditor reads first`,
    });
  }
  if (v.transaction_type === 'TRANSFER' && v.from_location_id === v.to_location_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['to_location_id'],
      message: 'A transfer has to move the stock somewhere else',
    });
  }
});

export const reservationSchema = z.object({
  item_id: uuid,
  location_id: uuid,
  quantity: qty,
  project_id: uuid.nullable().optional(),
  task_id: uuid.nullable().optional(),
  /** Stock is held until this date, then released without anybody acting. */
  expires_on: dateString.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const stockCountSchema = z.object({
  count_no: text.max(50),
  location_id: uuid,
  counted_on: dateString,
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    item_id: uuid,
    counted_quantity: z.coerce.number().finite().min(0),
    batch_no: z.string().trim().max(50).optional(),
    remarks: z.string().trim().max(500).optional(),
  })).min(1, 'A count needs at least one line'),
});

export const countApprovalSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  // Approving a count posts adjustments that move real stock, so the person
  // signing says why they accept a variance they did not count themselves.
  if (!v.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'Say why the variance is accepted or refused',
    });
  }
});

export const itemMasterSchema = z.object({
  category: z.string().trim().max(100).optional(),
  base_uom: z.string().trim().max(20).optional(),
  alt_uom: z.string().trim().max(20).nullable().optional(),
  conversion_factor: z.coerce.number().positive().nullable().optional(),
  hsn_code: z.string().trim().max(10).nullable().optional(),
  gst_rate_pct: z.coerce.number().min(0).max(28).nullable().optional(),
  batch_tracked: z.boolean().optional(),
  serial_tracked: z.boolean().optional(),
  reorder_level: z.coerce.number().min(0).optional(),
  reorder_quantity: z.coerce.number().min(0).optional(),
}).superRefine((v, ctx) => {
  // An alternate unit with no factor is a unit nothing can be converted from,
  // and every quantity entered in it would be silently wrong.
  if (v.alt_uom && !v.conversion_factor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['conversion_factor'],
      message: 'Say how many base units one of these contains',
    });
  }
});

import type { Pool, PoolClient } from 'pg';

/**
 * The organisation-wide stock ledger, read the same way everywhere.
 *
 * An item's total is every receipt less every issue. A transfer is neither:
 * it moves stock from one location to another and leaves the item's total
 * where it was. Transfers are stored with direction 'IN' -- the column only
 * allows IN and OUT, and a move is not an OUT -- so a sum that reads the
 * direction alone counts every transfer as fresh stock, and an item moved
 * between two stores three times reports three extra loads that do not
 * exist. Existing rows are left as they are; the reading is what is fixed,
 * here, once.
 */
export const itemDeltaSql = (alias = '') => {
  const a = alias ? `${alias}.` : '';
  return `CASE WHEN ${a}transaction_type = 'TRANSFER' THEN 0
               WHEN ${a}direction = 'IN' THEN ${a}quantity
               ELSE -${a}quantity END`;
};

/** The item's total across every location, from the ledger. */
export async function itemOnHand(db: Pool | PoolClient, itemId: string): Promise<number> {
  const row = (await db.query(
    `SELECT COALESCE(sum(${itemDeltaSql()}), 0) AS on_hand FROM stock_transactions WHERE item_id = $1`,
    [itemId])).rows[0];
  return Number(row.on_hand);
}

/**
 * Lock an item for the rest of the transaction.
 *
 * Every posting that takes stock out reads the balance and then writes
 * against it. Two of them reading at once each see the same stock free and
 * together drive it negative. Holding the item row serialises them.
 */
export async function lockItem(db: PoolClient, itemId: string, orgId: string): Promise<Record<string, any>> {
  const row = (await db.query(
    'SELECT * FROM inventory_items WHERE id = $1 AND org_id = $2 FOR UPDATE', [itemId, orgId])).rows[0];
  return row;
}

/** The level an item is reordered at: the reorder level, else the older threshold. */
export function lowStockLevel(item: Record<string, any>): number {
  return item.reorder_level === null || item.reorder_level === undefined
    ? Number(item.low_stock_threshold ?? 0)
    : Number(item.reorder_level);
}

/**
 * Tell the storekeepers when an item crosses its reorder level.
 *
 * Once per crossing, not once per issue below it. The old alert fired on
 * every OUT posted while the item was low, so a store that issued ten times
 * from a low bin sent ten identical notices and taught everybody to ignore
 * them. It now fires on the posting that takes the item from above the level
 * to at or below it, keyed by item and that posting; it fires again only
 * after stock has been replenished above the level and falls through it once
 * more.
 */
export async function notifyLowStockCrossing(db: PoolClient, args: {
  orgId: string;
  item: Record<string, any>;
  before: number;
  after: number;
  transactionId: string;
}): Promise<boolean> {
  const level = lowStockLevel(args.item);
  if (!(args.before > level && args.after <= level)) return false;
  // $1 and $2 carry explicit casts: a bare parameter in an INSERT ... SELECT
  // list is inferred from the select expression, not the target column, so
  // reusing $1 in the uuid-typed WHERE made Postgres deduce two different
  // types for it and reject the statement (42P08).
  await db.query(
    `INSERT INTO notifications(org_id, recipient_id, type, title, body, entity_type, entity_id, event_key)
     SELECT DISTINCT $1::uuid, u.id, 'LOW_STOCK', 'Stock needs replenishment',
            'Open Inventory to review stock levels', 'inventory_item', $2::uuid, $3::text
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE' AND rp.permission_code = 'inventory.manage'
     ON CONFLICT DO NOTHING`,
    [args.orgId, String(args.item.id), `low-stock:${args.item.id}:${args.transactionId}`]);
  return true;
}

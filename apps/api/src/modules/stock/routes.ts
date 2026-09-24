import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  stockLocationSchema, stockTransactionSchema, reservationSchema,
  stockCountSchema, countApprovalSchema, itemMasterSchema,
  STOCK_TYPE_BEHAVIOUR, stockDelta, toBaseQuantity, stockPosition, checkIssue,
  countVariances, createsLocationCycle, COUNT_TRANSITIONS,
  type StockTransactionType, type CountState, type LocationNode,
  businessDay,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';
import { itemDeltaSql, itemOnHand, lockItem, notifyLowStockCrossing } from '../../common/stockLedger.js';

/**
 * Inventory and material control (§44).
 *
 * Stock is held per item *per location*. The organisation-wide total the old
 * ledger produced was true of nowhere: a storekeeper asking whether a site has
 * fifty bags could not be answered by it.
 */
export async function registerStockRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);
  // The calendar day where the work happens, not in UTC. For the first
  // five and a half hours of every Indian day, UTC is still yesterday.
  const today = () => businessDay();

  /**
   * On-hand at a location, summed from the ledger.
   *
   * Never a stored running total. Receipts, issues, transfers and count
   * adjustments all write here, and a cached balance between four writers
   * drifts — the ledger is the only thing that can be re-derived.
   */
  async function onHandAt(db: Pool | PoolClient, itemId: string, locationId: string): Promise<number> {
    const row = (await db.query(
      `SELECT COALESCE(sum(
         CASE WHEN to_location_id = $2 THEN COALESCE(base_quantity, quantity)
              WHEN from_location_id = $2 THEN -COALESCE(base_quantity, quantity)
              ELSE 0 END), 0) AS on_hand
       FROM stock_transactions
       WHERE item_id = $1 AND (to_location_id = $2 OR from_location_id = $2)
         AND reversal_of IS NULL`, [itemId, locationId])).rows[0];
    return Number(row.on_hand);
  }

  /** Stock spoken for at a location by reservations that still hold. */
  async function reservedAt(db: Pool | PoolClient, itemId: string, locationId: string): Promise<number> {
    const row = (await db.query(
      `SELECT COALESCE(sum(quantity), 0) AS reserved FROM stock_reservations
       WHERE item_id = $1 AND location_id = $2 AND state = 'ACTIVE'
         AND (expires_on IS NULL OR expires_on >= $3::date)`,
      [itemId, locationId, today()])).rows[0];
    return Number(row.reserved);
  }

  async function positionAt(db: Pool | PoolClient, item: Record<string, any>, locationId: string) {
    return stockPosition({
      onHand: await onHandAt(db, String(item.id), locationId),
      reserved: await reservedAt(db, String(item.id), locationId),
      reorderLevel: item.reorder_level === null || item.reorder_level === undefined
        ? Number(item.low_stock_threshold ?? 0) : Number(item.reorder_level),
    });
  }

  /* ------------------------------------------------------------ locations */

  app.get('/api/v1/stock-locations', { preHandler: guard('location.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const values: unknown[] = [u.orgId];
    let where = 'l.org_id = $1';
    if (q.kind) { values.push(q.kind); where += ` AND l.kind = $${values.length}`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND l.project_id = $${values.length}::uuid`; }
    return {
      data: (await pool.query(
        `SELECT l.*, p.name AS parent_name, pr.code AS project_code
         FROM stock_locations l
         LEFT JOIN stock_locations p ON p.id = l.parent_id
         LEFT JOIN projects pr ON pr.id = l.project_id
         WHERE ${where} ORDER BY l.kind, l.code`, values)).rows,
    };
  });

  app.post('/api/v1/stock-locations', { preHandler: guard('location.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(stockLocationSchema, req.body);
    const row = await mutate(pool, req, 'location.create', 'stock_location', async db => {
      const clash = await db.query(
        'SELECT 1 FROM stock_locations WHERE org_id = $1 AND code = $2', [u.orgId, input.code]);
      if (clash.rowCount) fail('DUPLICATE_LOCATION', `Location ${input.code} already exists`, 409);
      if (input.parent_id) await inOrg(db, 'stock_locations', input.parent_id, u.orgId);
      if (input.project_id) await inOrg(db, 'projects', input.project_id, u.orgId);
      return (await db.query(
        `INSERT INTO stock_locations(org_id, created_by, code, name, kind, parent_id,
           project_id, address_line, active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [u.orgId, u.id, input.code, input.name, input.kind, input.parent_id ?? null,
         input.project_id ?? null, input.address_line ?? null, input.active])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  app.patch('/api/v1/stock-locations/:id', { preHandler: guard('location.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { name?: string; parent_id?: string | null; active?: boolean };
    return {
      data: await mutate(pool, req, 'location.update', 'stock_location', async db => {
        const location = await inOrg(db, 'stock_locations', id, u.orgId, true);
        version(req, location as { version: number });
        if (body.parent_id !== undefined) {
          const nodes: LocationNode[] = (await db.query(
            'SELECT id, parent_id, kind FROM stock_locations WHERE org_id = $1', [u.orgId]))
            .rows.map(r => ({ id: String(r.id), parentId: r.parent_id, kind: r.kind }));
          // A location under its own descendant makes every roll-up query
          // non-terminating.
          if (createsLocationCycle(nodes, id, body.parent_id)) {
            fail('LOCATION_CYCLE', 'That would place the location inside itself');
          }
          if (body.parent_id) await inOrg(db, 'stock_locations', body.parent_id, u.orgId);
        }
        return (await db.query(
          `UPDATE stock_locations SET name = COALESCE($2, name),
             parent_id = CASE WHEN $3::boolean THEN $4::uuid ELSE parent_id END,
             active = COALESCE($5, active), version = version + 1,
             updated_at = now(), updated_by = $6
           WHERE id = $1 RETURNING *`,
          [id, body.name ?? null, body.parent_id !== undefined, body.parent_id ?? null,
           body.active ?? null, u.id])).rows[0];
      }),
    };
  });

  /* ---------------------------------------------------------- item master */

  app.patch('/api/v1/inventory/items/:id/master', { preHandler: guard('inventory.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(itemMasterSchema, req.body);
    return {
      data: await mutate(pool, req, 'item.master', 'inventory_item', async db => {
        const item = await inOrg(db, 'inventory_items', id, u.orgId, true);
        version(req, item as { version: number });
        return (await db.query(
          `UPDATE inventory_items SET
             category = COALESCE($2, category),
             unit = COALESCE($3, unit),
             alt_uom = CASE WHEN $4::boolean THEN $5 ELSE alt_uom END,
             conversion_factor = CASE WHEN $4::boolean THEN $6 ELSE conversion_factor END,
             hsn_code = COALESCE($7, hsn_code),
             gst_rate_pct = COALESCE($8, gst_rate_pct),
             batch_tracked = COALESCE($9, batch_tracked),
             serial_tracked = COALESCE($10, serial_tracked),
             reorder_level = COALESCE($11, reorder_level),
             reorder_quantity = COALESCE($12, reorder_quantity),
             version = version + 1, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, input.category ?? null, input.base_uom ?? null,
           input.alt_uom !== undefined, input.alt_uom ?? null, input.conversion_factor ?? null,
           input.hsn_code ?? null, input.gst_rate_pct ?? null,
           input.batch_tracked ?? null, input.serial_tracked ?? null,
           input.reorder_level ?? null, input.reorder_quantity ?? null])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------------------ positions */

  /** On-hand, reserved and available for every item at a location. */
  app.get('/api/v1/stock-locations/:id/stock', { preHandler: guard('stock.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await inOrg(pool, 'stock_locations', id, u.orgId);
    const rows = (await pool.query(
      `SELECT i.id, i.code, i.name, i.unit, i.reorder_level, i.low_stock_threshold,
              COALESCE(sum(CASE WHEN t.to_location_id = $2 THEN COALESCE(t.base_quantity, t.quantity)
                                WHEN t.from_location_id = $2 THEN -COALESCE(t.base_quantity, t.quantity)
                                ELSE 0 END), 0) AS on_hand,
              COALESCE((SELECT sum(r.quantity) FROM stock_reservations r
                        WHERE r.item_id = i.id AND r.location_id = $2 AND r.state = 'ACTIVE'
                          AND (r.expires_on IS NULL OR r.expires_on >= $3::date)), 0) AS reserved
       FROM inventory_items i
       LEFT JOIN stock_transactions t
         ON t.item_id = i.id AND t.reversal_of IS NULL
        AND (t.to_location_id = $2 OR t.from_location_id = $2)
       WHERE i.org_id = $1
       GROUP BY i.id
       HAVING COALESCE(sum(CASE WHEN t.to_location_id = $2 THEN COALESCE(t.base_quantity, t.quantity)
                                WHEN t.from_location_id = $2 THEN -COALESCE(t.base_quantity, t.quantity)
                                ELSE 0 END), 0) <> 0
           OR COALESCE((SELECT sum(r.quantity) FROM stock_reservations r
                        WHERE r.item_id = i.id AND r.location_id = $2 AND r.state = 'ACTIVE'), 0) <> 0
       ORDER BY i.name`, [u.orgId, id, today()])).rows;

    return {
      data: rows.map(r => ({
        item_id: r.id, code: r.code, name: r.name, unit: r.unit,
        ...stockPosition({
          onHand: Number(r.on_hand),
          reserved: Number(r.reserved),
          reorderLevel: r.reorder_level === null ? Number(r.low_stock_threshold ?? 0) : Number(r.reorder_level),
        }),
      })),
    };
  });

  /* -------------------------------------------------------- transactions */

  app.get('/api/v1/stock-transactions', { preHandler: guard('stock.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 't.org_id = $1';
    if (q.item_id) { values.push(q.item_id); where += ` AND t.item_id = $${values.length}::uuid`; }
    if (q.transaction_type) { values.push(q.transaction_type); where += ` AND t.transaction_type = $${values.length}`; }
    if (q.location_id) {
      values.push(q.location_id);
      where += ` AND (t.from_location_id = $${values.length}::uuid OR t.to_location_id = $${values.length}::uuid)`;
    }
    const rows = (await pool.query(
      `SELECT t.*, i.code AS item_code, i.name AS item_name,
              f.name AS from_location_name, tl.name AS to_location_name,
              u.username AS created_by_username
       FROM stock_transactions t
       JOIN inventory_items i ON i.id = t.item_id
       LEFT JOIN stock_locations f ON f.id = t.from_location_id
       LEFT JOIN stock_locations tl ON tl.id = t.to_location_id
       LEFT JOIN users u ON u.id = t.created_by
       WHERE ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  /** The permission each kind of movement needs. */
  const permissionFor: Record<StockTransactionType, string> = {
    OPENING_BALANCE: 'stock.adjust', PURCHASE_RECEIPT: 'stock.receive',
    RETURN_FROM_PROJECT: 'stock.receive', ISSUE: 'stock.issue',
    CONSUMPTION: 'stock.issue', RETURN_TO_VENDOR: 'stock.issue',
    DAMAGE_LOSS: 'stock.adjust', ADJUSTMENT: 'stock.adjust',
    COUNT_ADJUSTMENT: 'stock.adjust', TRANSFER: 'stock.transfer',
  };

  app.post('/api/v1/stock-transactions', { preHandler: guard('stock.read') }, async (req, reply) => {
    const u = actor(req), input = parse(stockTransactionSchema, req.body);
    const needed = permissionFor[input.transaction_type];
    if (!u.permissions.includes(needed)) {
      fail('FORBIDDEN', `${STOCK_TYPE_BEHAVIOUR[input.transaction_type].label} needs the ${needed} permission`, 403);
    }
    const row = await mutate(pool, req, 'stock.move', 'stock_transaction', async db => {
      const item = await inOrg(db, 'inventory_items', input.item_id, u.orgId, true);
      if (input.from_location_id) await inOrg(db, 'stock_locations', input.from_location_id, u.orgId);
      if (input.to_location_id) await inOrg(db, 'stock_locations', input.to_location_id, u.orgId);
      // A retired item takes no new stock (D-005), the same rule the older
      // /inventory/transactions route applies. What is already on the shelf
      // can still be issued, returned, counted or written off, so that the
      // balance a deactivated item leaves behind can be cleared.
      if (String(item.status ?? 'ACTIVE') !== 'ACTIVE'
          && (input.transaction_type === 'PURCHASE_RECEIPT' || input.transaction_type === 'OPENING_BALANCE')) {
        fail('ITEM_INACTIVE', `${item.name} has been deactivated and cannot take new stock. Reactivate it first.`);
      }

      if (item.batch_tracked && !input.batch_no) {
        fail('BATCH_REQUIRED', `${item.name} is batch tracked — name the batch`);
      }
      if (item.serial_tracked && !input.serial_no) {
        fail('SERIAL_REQUIRED', `${item.name} is serial tracked — name the serial`);
      }

      // Converted here and stored in the base unit. A ledger holding whichever
      // unit was typed produces sums that are simply wrong.
      let baseQuantity: number;
      try {
        baseQuantity = toBaseQuantity(
          { baseUom: String(item.unit), altUom: item.alt_uom, conversionFactor: item.conversion_factor === null ? null : Number(item.conversion_factor) },
          input.quantity, input.uom);
      } catch (e) {
        fail('UNKNOWN_UOM', e instanceof Error ? e.message : 'Unknown unit of measure');
      }

      let negativeOverride = false;
      if (input.from_location_id) {
        const position = await positionAt(db, item, input.from_location_id);
        const verdict = checkIssue({
          position, quantity: baseQuantity!,
          allowNegative: u.permissions.includes('stock.negative_override'),
        });
        if (!verdict.allowed) fail(verdict.code!, verdict.reason!);
        negativeOverride = (verdict.shortBy ?? 0) > 0;
      }

      const direction = STOCK_TYPE_BEHAVIOUR[input.transaction_type].effect === 'OUT' ? 'OUT' : 'IN';
      // Read under the item lock inOrg took above, before this posting lands.
      const before = await itemOnHand(db, input.item_id);
      const posted = (await db.query(
        `INSERT INTO stock_transactions(org_id, created_by, item_id, direction, quantity,
           base_quantity, entered_quantity, entered_uom, reference, project_id, task_id, reason,
           transaction_type, from_location_id, to_location_id, batch_no, serial_no,
           occurred_at, document_type, document_id, negative_override)
         VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [u.orgId, u.id, input.item_id, direction, baseQuantity!,
         input.quantity, input.uom ?? item.unit, input.reference,
         input.project_id ?? null, input.task_id ?? null, input.reason ?? null,
         input.transaction_type, input.from_location_id ?? null, input.to_location_id ?? null,
         input.batch_no ?? null, input.serial_no ?? null, input.occurred_at ?? today(),
         input.document_type ?? null, input.document_id ?? null, negativeOverride])).rows[0];
      await notifyLowStockCrossing(db, {
        orgId: u.orgId, item, before, after: await itemOnHand(db, input.item_id),
        transactionId: String(posted.id),
      });
      return posted;
    });
    reply.code(201);
    return { data: row };
  });

  /* -------------------------------------------------------- reservations */

  app.get('/api/v1/stock-reservations', { preHandler: guard('reservation.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const values: unknown[] = [u.orgId];
    let where = 'r.org_id = $1';
    if (q.state) { values.push(q.state); where += ` AND r.state = $${values.length}`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND r.project_id = $${values.length}::uuid`; }
    return {
      data: (await pool.query(
        `SELECT r.*, i.code AS item_code, i.name AS item_name, l.name AS location_name,
                p.code AS project_code
         FROM stock_reservations r
         JOIN inventory_items i ON i.id = r.item_id
         JOIN stock_locations l ON l.id = r.location_id
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE ${where} ORDER BY r.created_at DESC`, values)).rows,
    };
  });

  app.post('/api/v1/stock-reservations', { preHandler: guard('reservation.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(reservationSchema, req.body);
    const row = await mutate(pool, req, 'reservation.create', 'stock_reservation', async db => {
      // Locked, like every issue: two reservations read the same free
      // quantity otherwise, and both promise it (D-001).
      const item = await inOrg(db, 'inventory_items', input.item_id, u.orgId, true);
      await inOrg(db, 'stock_locations', input.location_id, u.orgId);
      const position = await positionAt(db, item, input.location_id);
      // Reserving stock that is not free would promise the same bags twice.
      if (input.quantity > position.available) {
        fail('INSUFFICIENT_STOCK',
          `Only ${position.available} is available to reserve — ${position.onHand} on hand, ${position.reserved} already reserved`);
      }
      return (await db.query(
        `INSERT INTO stock_reservations(org_id, created_by, item_id, location_id, quantity,
           project_id, task_id, expires_on, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [u.orgId, u.id, input.item_id, input.location_id, input.quantity,
         input.project_id ?? null, input.task_id ?? null, input.expires_on ?? null,
         input.notes ?? null])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  app.post('/api/v1/stock-reservations/:id/release', { preHandler: guard('reservation.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    return {
      data: await mutate(pool, req, 'reservation.release', 'stock_reservation', async db => {
        const reservation = await inOrg(db, 'stock_reservations', id, u.orgId, true);
        version(req, reservation as { version: number });
        if (reservation.state !== 'ACTIVE') {
          fail('NOT_ACTIVE', `That reservation is already ${String(reservation.state).toLowerCase()}`);
        }
        return (await db.query(
          `UPDATE stock_reservations SET state='RELEASED', released_at=now(), released_by=$2,
             version=version+1, updated_at=now(), updated_by=$2 WHERE id=$1 RETURNING *`,
          [id, u.id])).rows[0];
      }),
    };
  });

  /* --------------------------------------------------------- stock counts */

  app.get('/api/v1/stock-counts', { preHandler: guard('stockcount.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'c.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND c.status = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT c.*, l.name AS location_name, a.username AS approved_by_username,
              (SELECT count(*)::int FROM stock_count_lines x WHERE x.count_id = c.id) AS line_count,
              (SELECT count(*)::int FROM stock_count_lines x WHERE x.count_id = c.id AND x.variance <> 0) AS variance_count
       FROM stock_counts c
       JOIN stock_locations l ON l.id = c.location_id
       LEFT JOIN users a ON a.id = c.approved_by
       WHERE ${where} ORDER BY c.counted_on DESC, c.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.get('/api/v1/stock-counts/:id', { preHandler: guard('stockcount.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const count = await inOrg(pool, 'stock_counts', id, u.orgId);
    const lines = (await pool.query(
      `SELECT x.*, i.code AS item_code, i.name AS item_name, i.unit
       FROM stock_count_lines x JOIN inventory_items i ON i.id = x.item_id
       WHERE x.count_id = $1 ORDER BY i.name`, [id])).rows;
    return {
      data: {
        ...count, lines,
        allowed_statuses: COUNT_TRANSITIONS[count.status as CountState] ?? [],
      },
    };
  });

  app.post('/api/v1/stock-counts', { preHandler: guard('stockcount.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(stockCountSchema, req.body);
    const row = await mutate(pool, req, 'stockcount.create', 'stock_count', async db => {
      const clash = await db.query(
        'SELECT 1 FROM stock_counts WHERE org_id = $1 AND count_no = $2', [u.orgId, input.count_no]);
      if (clash.rowCount) fail('DUPLICATE_COUNT_NO', `Count ${input.count_no} already exists`, 409);
      await inOrg(db, 'stock_locations', input.location_id, u.orgId);

      const count = (await db.query(
        `INSERT INTO stock_counts(org_id, created_by, count_no, location_id, counted_on, notes, status)
         VALUES($1,$2,$3,$4,$5,$6,'COUNTED') RETURNING *`,
        [u.orgId, u.id, input.count_no, input.location_id, input.counted_on,
         input.notes ?? null])).rows[0];

      for (const line of input.lines) {
        const item = await inOrg(db, 'inventory_items', line.item_id, u.orgId);
        // Frozen now. Recomputing at approval would compare the count against
        // a ledger that has moved since somebody walked the aisles.
        const systemQuantity = await onHandAt(db, String(item.id), input.location_id);
        await db.query(
          `INSERT INTO stock_count_lines(org_id, count_id, item_id, system_quantity,
             counted_quantity, variance, batch_no, remarks)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [u.orgId, count.id, line.item_id, systemQuantity, line.counted_quantity,
           Math.round((line.counted_quantity - systemQuantity) * 10_000) / 10_000,
           line.batch_no ?? null, line.remarks ?? null]);
      }
      return count;
    });
    reply.code(201);
    return { data: row };
  });

  /**
   * Approve a count and post its adjustments (§44.5).
   *
   * The adjustments are COUNT_ADJUSTMENT rather than ADJUSTMENT, and each line
   * records the transaction it produced — so a correction driven by a physical
   * count is separately auditable from one somebody keyed by hand.
   */
  app.post('/api/v1/stock-counts/:id/approval', { preHandler: guard('stockcount.approve') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(countApprovalSchema, req.body);
    return {
      data: await mutate(pool, req, `stockcount.${input.action.toLowerCase()}`, 'stock_count', async db => {
        const count = await inOrg(db, 'stock_counts', id, u.orgId, true);
        version(req, count as { version: number });
        const from = count.status as CountState;
        const to = input.action === 'APPROVE' ? 'APPROVED' : 'DRAFT';
        if (!(COUNT_TRANSITIONS[from] ?? []).includes(to as CountState)) {
          fail('INVALID_TRANSITION', `A ${from.toLowerCase()} count cannot be ${input.action.toLowerCase()}d`);
        }
        if (String(count.created_by) === u.id) {
          // Whoever counted does not also sign for the variance; otherwise a
          // count is a way to write material off single-handed.
          fail('SELF_APPROVAL', 'The person who recorded a count cannot approve its variance', 403);
        }

        if (input.action === 'REJECT') {
          return (await db.query(
            `UPDATE stock_counts SET status='DRAFT', rejected_reason=$2,
               version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1 RETURNING *`,
            [id, input.reason, u.id])).rows[0];
        }

        // Item order, so two approvals touching the same items take their
        // locks in the same order and cannot deadlock.
        const lines = (await db.query(
          'SELECT * FROM stock_count_lines WHERE count_id = $1 AND variance <> 0 ORDER BY item_id', [id])).rows;
        for (const line of lines) {
          const variance = Number(line.variance);
          // The variance was frozen when the aisles were walked; stock may
          // have been issued since. A write-off that now exceeds what the
          // location holds would drive it negative, so it is checked against
          // the ledger as it stands, under the item lock, like any other
          // posting that takes stock out.
          const item = await lockItem(db, String(line.item_id), u.orgId);
          const before = await itemOnHand(db, String(line.item_id));
          if (variance < 0) {
            const onHand = await onHandAt(db, String(line.item_id), String(count.location_id));
            if (onHand + variance < -0.0005) {
              fail('INSUFFICIENT_STOCK',
                `${item.name}: the count writes off ${Math.abs(variance)} but only ${onHand} is on hand here now -- stock has moved since the count. Recount before approving.`,
                409);
            }
          }
          const posted = (await db.query(
            `INSERT INTO stock_transactions(org_id, created_by, item_id, direction, quantity,
               base_quantity, entered_quantity, entered_uom, reference, reason, transaction_type,
               from_location_id, to_location_id, occurred_at, document_type, document_id)
             VALUES($1,$2,$3,$4,$5,$5,$5,NULL,$6,$7,'COUNT_ADJUSTMENT',$8,$9,$10,'STOCK_COUNT',$11)
             RETURNING id`,
            [u.orgId, u.id, line.item_id, variance > 0 ? 'IN' : 'OUT', Math.abs(variance),
             `Count ${count.count_no}`, input.reason,
             variance > 0 ? null : count.location_id,
             variance > 0 ? count.location_id : null,
             count.counted_on, id])).rows[0];
          await db.query('UPDATE stock_count_lines SET adjustment_id = $2 WHERE id = $1',
            [line.id, posted.id]);
          await notifyLowStockCrossing(db, {
            orgId: u.orgId, item, before, after: await itemOnHand(db, String(line.item_id)),
            transactionId: String(posted.id),
          });
        }

        return (await db.query(
          `UPDATE stock_counts SET status='APPROVED', approved_at=now(), approved_by=$2,
             approval_reason=$3, version=version+1, updated_at=now(), updated_by=$2
           WHERE id=$1 RETURNING *`, [id, u.id, input.reason])).rows[0];
      }),
    };
  });

  /** Items at or below their reorder level, measured on what is free. */
  app.get('/api/v1/stock/reorder', { preHandler: guard('stock.read') }, async req => {
    const u = actor(req);
    const rows = (await pool.query(
      `SELECT i.id, i.code, i.name, i.unit, i.reorder_level, i.reorder_quantity,
              i.low_stock_threshold,
              -- The item's total, which a transfer between two locations
              -- does not change. Summing by location presence counted every
              -- transfer as an arrival and missed every receipt posted
              -- without a location.
              COALESCE(sum(${itemDeltaSql('t')}), 0) AS on_hand,
              COALESCE((SELECT sum(r.quantity) FROM stock_reservations r
                        WHERE r.item_id = i.id AND r.state = 'ACTIVE'
                          AND (r.expires_on IS NULL OR r.expires_on >= $2::date)), 0) AS reserved
       FROM inventory_items i
       LEFT JOIN stock_transactions t ON t.item_id = i.id AND t.reversal_of IS NULL
       WHERE i.org_id = $1 AND i.status = 'ACTIVE'
       GROUP BY i.id ORDER BY i.name`, [u.orgId, today()])).rows;

    return {
      data: rows.map(r => ({
        item_id: r.id, code: r.code, name: r.name, unit: r.unit,
        reorder_quantity: r.reorder_quantity === null ? null : Number(r.reorder_quantity),
        ...stockPosition({
          onHand: Number(r.on_hand), reserved: Number(r.reserved),
          reorderLevel: r.reorder_level === null ? Number(r.low_stock_threshold ?? 0) : Number(r.reorder_level),
        }),
      })).filter(r => r.belowReorder),
    };
  });
}

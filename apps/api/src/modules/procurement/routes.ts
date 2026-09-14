import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  requisitionSchema, purchaseOrderSchema, grnSchema,
  receiptStatus, threeWayMatch, withinRequisition,
  PR_TRANSITIONS, PO_TRANSITIONS, type PrStatus, type PoStatus,
  resolveLadder, type LadderMode,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail, projectAccess } from '../../common/domain.js';

/**
 * Procurement (§6.6, §13.2, §43).
 *
 * Requisitions and orders route through the approval engine rather than
 * carrying their own approver field — that ladder was built first precisely so
 * this module would not reinvent it.
 *
 * Received quantity is always summed from GRNs. Nothing here keeps a running
 * total on the order line, because two writers with one number eventually
 * disagree and the reconciliation is painful.
 */
export async function registerProcurementRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  /** Raise an approval instance for a document, reusing the §41 engine. */
  async function submitForApproval(
    db: PoolClient, req: Parameters<typeof actor>[0], documentType: string,
    documentId: string, amount: number, projectId: string | null,
  ): Promise<string> {
    const u = actor(req);
    const policy = (await db.query(
      `SELECT * FROM approval_policies
       WHERE org_id = $1 AND document_type = $2 AND active
         AND (project_id = $3::uuid OR project_id IS NULL)
       ORDER BY project_id NULLS LAST LIMIT 1`, [u.orgId, documentType, projectId])).rows[0];
    if (!policy) {
      fail('NO_APPROVAL_POLICY',
        `No active approval policy covers ${documentType}. Configure the authority slabs before submitting.`);
    }
    const levels = (await db.query(
      'SELECT * FROM approval_levels WHERE policy_id = $1 ORDER BY sequence', [policy.id])).rows
      .map(r => ({
        sequence: Number(r.sequence), minAmount: Number(r.min_amount),
        maxAmount: r.max_amount === null ? null : Number(r.max_amount),
        approverRole: r.approver_role, approverUserId: r.approver_user_id,
        slaHours: r.sla_hours === null ? null : Number(r.sla_hours),
      }));
    const ladder = resolveLadder(levels, amount, policy.mode as LadderMode);
    if (!ladder.length) fail('NO_APPROVER', `The policy leaves ${amount} outside every authority band`);

    const instance = (await db.query(
      `INSERT INTO approval_instances(org_id, created_by, document_type, document_id, policy_id,
         project_id, amount, requested_by, current_sequence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$2,$8) RETURNING id`,
      [u.orgId, u.id, documentType, documentId, policy.id, projectId, amount, ladder[0].sequence])).rows[0];
    for (const s of ladder) {
      await db.query(
        `INSERT INTO approval_steps(org_id, instance_id, sequence, approver_role, approver_user_id,
           sla_hours, pending_since)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [u.orgId, instance.id, s.sequence, s.approverRole, s.approverUserId, s.slaHours,
         s.sequence === ladder[0].sequence ? new Date() : null]);
    }
    return String(instance.id);
  }

  /** Cumulative accepted and rejected quantity per order line, from the GRNs. */
  async function receiptsFor(db: Pool | PoolClient, purchaseOrderId: string) {
    const rows = (await db.query(
      `SELECT l.po_line_id,
              COALESCE(sum(l.accepted_quantity), 0) AS accepted,
              COALESCE(sum(l.received_quantity - l.accepted_quantity), 0) AS rejected
       FROM grn_lines l
       JOIN goods_receipt_notes g ON g.id = l.grn_id
       WHERE g.purchase_order_id = $1 AND g.status = 'RECEIVED'
       GROUP BY l.po_line_id`, [purchaseOrderId])).rows;
    return new Map(rows.map(r => [String(r.po_line_id), {
      accepted: Number(r.accepted), rejected: Number(r.rejected),
    }]));
  }

  /* ---------------------------------------------------------- requisition */

  app.get('/api/v1/requisitions', { preHandler: guard('requisition.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'r.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND r.status = $${values.length}`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND r.project_id = $${values.length}::uuid`; }
    const rows = (await pool.query(
      `SELECT r.*, u.username AS requested_by_username, p.code AS project_code
       FROM purchase_requisitions r
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN projects p ON p.id = r.project_id
       WHERE ${where} ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.get('/api/v1/requisitions/:id', { preHandler: guard('requisition.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const pr = await inOrg(pool, 'purchase_requisitions', id, u.orgId);
    const lines = (await pool.query(
      'SELECT * FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [id])).rows;
    const orders = (await pool.query(
      'SELECT id, po_number, status, total_value FROM purchase_orders WHERE requisition_id = $1', [id])).rows;
    return {
      data: { ...pr, lines, purchase_orders: orders,
        allowed_statuses: PR_TRANSITIONS[pr.status as PrStatus] ?? [] },
    };
  });

  app.post('/api/v1/requisitions', { preHandler: guard('requisition.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(requisitionSchema, req.body);
    if (input.project_id) await projectAccess(pool, req, input.project_id);
    const row = await mutate(pool, req, 'requisition.create', 'requisition', async db => {
      if (input.project_id) await inOrg(db, 'projects', input.project_id, u.orgId);
      const estimated = input.lines.reduce((t, l) => t + l.quantity * (l.estimated_rate ?? 0), 0);
      const pr = (await db.query(
        `INSERT INTO purchase_requisitions(org_id, created_by, requisition_no, project_id,
           requested_by, required_by, justification, estimated_value)
         VALUES($1,$2,$3,$4,$2,$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.requisition_no, input.project_id ?? null,
         input.required_by ?? null, input.justification, estimated.toFixed(2)])).rows[0];
      let lineNo = 0;
      for (const line of input.lines) {
        lineNo += 1;
        await db.query(
          `INSERT INTO requisition_lines(org_id, requisition_id, line_no, item_id, description,
             unit, quantity, estimated_rate, remarks)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [u.orgId, pr.id, lineNo, line.item_id ?? null, line.description,
           line.unit, line.quantity, line.estimated_rate ?? null, line.remarks ?? null]);
      }
      return pr;
    });
    return reply.code(201).send({ data: row });
  });

  /** Submit for approval; the ladder is the §41 engine, not a local approver. */
  app.post('/api/v1/requisitions/:id/submit', { preHandler: guard('requisition.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    return {
      data: await mutate(pool, req, 'requisition.submit', 'requisition', async db => {
        const pr = await inOrg(db, 'purchase_requisitions', id, u.orgId, true);
        version(req, pr as { version: number });
        if (!(PR_TRANSITIONS[pr.status as PrStatus] ?? []).includes('SUBMITTED')) {
          fail('INVALID_STATUS_TRANSITION', `A requisition at ${pr.status} cannot be submitted`);
        }
        const approvalId = await submitForApproval(
          db, req, 'PURCHASE_REQUISITION', id, Number(pr.estimated_value), pr.project_id);
        return (await db.query(
          `UPDATE purchase_requisitions SET status='SUBMITTED', approval_id=$2,
             version=version+1, updated_at=now(), updated_by=$3
           WHERE id=$1 RETURNING *`, [id, approvalId, u.id])).rows[0];
      }),
    };
  });

  /* -------------------------------------------------------- purchase order */

  app.get('/api/v1/purchase-orders', { preHandler: guard('po.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'o.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND o.status = $${values.length}`; }
    if (q.vendor_id) { values.push(q.vendor_id); where += ` AND o.vendor_id = $${values.length}::uuid`; }
    const rows = (await pool.query(
      `SELECT o.*, v.name AS vendor_name FROM purchase_orders o
       JOIN vendors v ON v.id = o.vendor_id
       WHERE ${where} ORDER BY o.po_date DESC, o.created_at DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.get('/api/v1/purchase-orders/:id', { preHandler: guard('po.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const po = await inOrg(pool, 'purchase_orders', id, u.orgId);
    const lines = (await pool.query(
      'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no', [id])).rows;
    const receipts = await receiptsFor(pool, id);
    const amendments = (await pool.query(
      'SELECT * FROM po_amendments WHERE purchase_order_id = $1 ORDER BY revision', [id])).rows;
    return {
      data: {
        ...po,
        lines: lines.map(l => ({
          ...l,
          ...receiptStatus({
            orderedQuantity: Number(l.quantity),
            receivedQuantity: receipts.get(String(l.id))?.accepted ?? 0,
            rejectedQuantity: receipts.get(String(l.id))?.rejected ?? 0,
          }),
        })),
        amendments,
        allowed_statuses: PO_TRANSITIONS[po.status as PoStatus] ?? [],
      },
    };
  });

  app.post('/api/v1/purchase-orders', { preHandler: guard('po.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(purchaseOrderSchema, req.body);
    if (input.project_id) await projectAccess(pool, req, input.project_id);
    const row = await mutate(pool, req, 'po.create', 'purchase_order', async db => {
      const vendor = await inOrg(db, 'vendors', input.vendor_id, u.orgId);
      // A blacklisted vendor must not receive an order; that is the entire
      // point of maintaining the flag.
      if (String(vendor.blacklist_status) === 'BLACKLISTED') {
        fail('VENDOR_BLACKLISTED',
          `${vendor.name} is blacklisted: ${vendor.blacklist_reason ?? 'no reason recorded'}`);
      }
      if (input.project_id) await inOrg(db, 'projects', input.project_id, u.orgId);

      // §6.6: an order may not exceed the requisition that authorised it.
      let override: { reason: string } | null = null;
      if (input.requisition_id) {
        const pr = await inOrg(db, 'purchase_requisitions', input.requisition_id, u.orgId, true);
        if (pr.status !== 'APPROVED' && pr.status !== 'CONVERTED') {
          fail('REQUISITION_NOT_APPROVED', 'Only an approved requisition can be converted into an order');
        }
        const prLines = (await db.query(
          'SELECT id, description, quantity FROM requisition_lines WHERE requisition_id = $1',
          [input.requisition_id])).rows;
        const byId = new Map(prLines.map(l => [String(l.id), l]));
        const check = withinRequisition(
          prLines.map(l => ({ reference: String(l.id), quantity: Number(l.quantity) })),
          input.lines
            .filter(l => l.requisition_line_id)
            .map(l => ({ reference: String(l.requisition_line_id), quantity: l.quantity })));
        if (!check.within) {
          if (!input.scope_override_reason) {
            const readable = check.problems.map(p => {
              const id = p.split(':')[0].replace(' is not on the requisition', '');
              return p.replace(id, byId.get(id)?.description ?? id);
            });
            fail('EXCEEDS_REQUISITION',
              `This order goes beyond the requisition — ${readable.join('; ')}. Record an override reason to proceed.`);
          }
          override = { reason: input.scope_override_reason };
        }
      }

      const lines = input.lines.map(l => {
        const taxable = Math.round(l.quantity * l.unit_rate * 100) / 100;
        const tax = Math.round(taxable * l.gst_rate_pct) / 100;
        return { ...l, taxable, tax, total: Math.round((taxable + tax) * 100) / 100 };
      });
      const taxableValue = lines.reduce((t, l) => t + l.taxable, 0);
      const taxAmount = lines.reduce((t, l) => t + l.tax, 0);

      const po = (await db.query(
        `INSERT INTO purchase_orders(org_id, created_by, po_number, vendor_id, requisition_id,
           project_id, po_date, delivery_date, payment_terms, delivery_address, place_of_supply,
           taxable_value, tax_amount, total_value,
           scope_override_by, scope_override_reason, scope_override_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [u.orgId, u.id, input.po_number, input.vendor_id, input.requisition_id ?? null,
         input.project_id ?? null, input.po_date, input.delivery_date ?? null,
         input.payment_terms ?? null, input.delivery_address ?? null, input.place_of_supply ?? null,
         taxableValue.toFixed(2), taxAmount.toFixed(2), (taxableValue + taxAmount).toFixed(2),
         override ? u.id : null, override?.reason ?? null, override ? new Date() : null])).rows[0];

      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await db.query(
          `INSERT INTO purchase_order_lines(org_id, purchase_order_id, line_no, item_id,
             requisition_line_id, description, hsn_sac, unit, quantity, unit_rate, gst_rate_pct,
             taxable_value, tax_amount, line_total, remarks)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [u.orgId, po.id, lineNo, l.item_id ?? null, l.requisition_line_id ?? null, l.description,
           l.hsn_sac ?? null, l.unit, l.quantity, l.unit_rate, l.gst_rate_pct,
           l.taxable.toFixed(2), l.tax.toFixed(2), l.total.toFixed(2), l.remarks ?? null]);
      }
      if (input.requisition_id) {
        await db.query(
          `UPDATE purchase_requisitions SET status='CONVERTED', version=version+1,
             updated_at=now(), updated_by=$2 WHERE id=$1 AND status='APPROVED'`,
          [input.requisition_id, u.id]);
        await db.query(
          `INSERT INTO record_conversions(org_id, source_type, source_id, target_type, target_id, carried_fields, actor_id)
           VALUES($1,'PURCHASE_ORDER',$2,'PAYMENT',$3,$4,$5)
           ON CONFLICT DO NOTHING`,
          [u.orgId, input.requisition_id, po.id,
           JSON.stringify({ total_value: (taxableValue + taxAmount).toFixed(2) }), u.id]);
      }
      return { ...po, lines };
    });
    return reply.code(201).send({ data: row });
  });

  app.post('/api/v1/purchase-orders/:id/submit', { preHandler: guard('po.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    return {
      data: await mutate(pool, req, 'po.submit', 'purchase_order', async db => {
        const po = await inOrg(db, 'purchase_orders', id, u.orgId, true);
        version(req, po as { version: number });
        if (!(PO_TRANSITIONS[po.status as PoStatus] ?? []).includes('PENDING_APPROVAL')) {
          fail('INVALID_STATUS_TRANSITION', `An order at ${po.status} cannot be submitted`);
        }
        const approvalId = await submitForApproval(
          db, req, 'PURCHASE_ORDER', id, Number(po.total_value), po.project_id);
        return (await db.query(
          `UPDATE purchase_orders SET status='PENDING_APPROVAL', approval_id=$2,
             version=version+1, updated_at=now(), updated_by=$3
           WHERE id=$1 RETURNING *`, [id, approvalId, u.id])).rows[0];
      }),
    };
  });

  app.post('/api/v1/purchase-orders/:id/status', { preHandler: guard('po.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { status?: string; reason?: string };
    const next = String(body.status ?? '') as PoStatus;
    return {
      data: await mutate(pool, req, 'po.status', 'purchase_order', async db => {
        const po = await inOrg(db, 'purchase_orders', id, u.orgId, true);
        version(req, po as { version: number });
        const allowed = PO_TRANSITIONS[po.status as PoStatus] ?? [];
        if (!allowed.includes(next)) {
          fail('INVALID_STATUS_TRANSITION',
            allowed.length ? `An order at ${po.status} can move to ${allowed.join(', ')}`
                           : `${po.status} is a final status`);
        }
        // An order reaches APPROVED only when its approval instance says so;
        // otherwise the ladder is decorative.
        if (next === 'APPROVED') {
          const approval = po.approval_id
            ? (await db.query('SELECT status FROM approval_instances WHERE id=$1', [po.approval_id])).rows[0]
            : null;
          if (!approval || approval.status !== 'APPROVED') {
            fail('NOT_APPROVED',
              'This order has not cleared its approval ladder yet. Approvals are recorded against the approval request, not here.');
          }
        }
        if ((next === 'CANCELLED' || next === 'CLOSED') && !body.reason) {
          fail('VALIDATION_ERROR', `Say why the order is being ${next.toLowerCase()}`);
        }
        return (await db.query(
          `UPDATE purchase_orders SET status=$2,
             cancelled_reason = COALESCE($3, cancelled_reason),
             closed_reason    = COALESCE($4, closed_reason),
             version=version+1, updated_at=now(), updated_by=$5
           WHERE id=$1 RETURNING *`,
          [id, next, next === 'CANCELLED' ? body.reason : null,
           next === 'CLOSED' ? body.reason : null, u.id])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------------------------ GRN */

  app.post('/api/v1/grns', { preHandler: guard('grn.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(grnSchema, req.body);
    const body = req.body as { over_receipt_reason?: string };
    const row = await mutate(pool, req, 'grn.create', 'grn', async db => {
      const po = await inOrg(db, 'purchase_orders', input.purchase_order_id, u.orgId, true);
      if (!['SENT', 'PARTIALLY_RECEIVED', 'APPROVED'].includes(String(po.status))) {
        fail('PO_NOT_RECEIVABLE',
          `Goods cannot be received against an order at ${po.status}`);
      }

      const poLines = new Map((await db.query(
        'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1', [input.purchase_order_id])
      ).rows.map(r => [String(r.id), r]));
      const priorReceipts = await receiptsFor(db, input.purchase_order_id);

      // Over-receipt is reported, not silently swallowed: the material is on
      // site either way, and accepting the excess is a commercial decision.
      const over: string[] = [];
      for (const line of input.lines) {
        const poLine = poLines.get(line.po_line_id);
        if (!poLine) fail('UNKNOWN_PO_LINE', 'A receipt line does not belong to this order');
        const already = priorReceipts.get(line.po_line_id)?.accepted ?? 0;
        const status = receiptStatus({
          orderedQuantity: Number(poLine!.quantity),
          receivedQuantity: already + line.accepted_quantity,
          rejectedQuantity: 0,
        });
        if (status.overReceivedQuantity > 0) {
          over.push(`${poLine!.description}: ${status.overReceivedQuantity} beyond the ordered ${poLine!.quantity}`);
        }
      }
      if (over.length && !body.over_receipt_reason) {
        fail('OVER_RECEIPT',
          `This receipt exceeds the order — ${over.join('; ')}. Record a reason to accept the excess.`);
      }

      const grn = (await db.query(
        `INSERT INTO goods_receipt_notes(org_id, created_by, grn_no, purchase_order_id,
           received_date, challan_no, vehicle_no, received_by, over_receipt_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$2,$8) RETURNING *`,
        [u.orgId, u.id, input.grn_no, input.purchase_order_id, input.received_date,
         input.challan_no ?? null, input.vehicle_no ?? null, over.length ? body.over_receipt_reason : null])).rows[0];

      for (const line of input.lines) {
        const poLine = poLines.get(line.po_line_id)!;
        // Accepted material enters stock. The link is stored so inventory and
        // procurement reconcile without inferring it later.
        let stockId: string | null = null;
        if (line.accepted_quantity > 0 && poLine.item_id) {
          stockId = (await db.query(
            `INSERT INTO stock_transactions(org_id, created_by, item_id, direction, quantity,
               reference, project_id)
             VALUES($1,$2,$3,'IN',$4,$5,$6) RETURNING id`,
            [u.orgId, u.id, poLine.item_id, line.accepted_quantity,
             `GRN ${input.grn_no}`, po.project_id ?? null])).rows[0].id;
        }
        await db.query(
          `INSERT INTO grn_lines(org_id, grn_id, po_line_id, received_quantity, accepted_quantity,
             rejection_reason, remarks, stock_transaction_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [u.orgId, grn.id, line.po_line_id, line.received_quantity, line.accepted_quantity,
           line.rejection_reason ?? null, line.remarks ?? null, stockId]);
      }

      // Move the order on from what the receipts now total.
      const after = await receiptsFor(db, input.purchase_order_id);
      const complete = [...poLines.values()].every(l =>
        (after.get(String(l.id))?.accepted ?? 0) >= Number(l.quantity));
      const nextStatus = complete ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED';
      await db.query(
        `UPDATE purchase_orders SET status=$2, version=version+1, updated_at=now(), updated_by=$3
         WHERE id=$1`, [input.purchase_order_id, nextStatus, u.id]);

      return { ...grn, purchase_order_status: nextStatus, over_receipts: over };
    });
    return reply.code(201).send({ data: row });
  });

  app.get('/api/v1/purchase-orders/:id/grns', { preHandler: guard('grn.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await inOrg(pool, 'purchase_orders', id, u.orgId);
    const rows = (await pool.query(
      `SELECT g.*, COALESCE(json_agg(l.* ORDER BY l.created_at) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
       FROM goods_receipt_notes g LEFT JOIN grn_lines l ON l.grn_id = g.id
       WHERE g.purchase_order_id = $1 GROUP BY g.id ORDER BY g.received_date DESC`, [id])).rows;
    return { data: rows };
  });

  /* ------------------------------------------------------------- matching */

  /**
   * Three-way match an invoice against its order and receipts.
   *
   * The result is recorded rather than recomputed on demand: a payment
   * released against an override must keep the evidence of what was
   * overridden, and recomputing later against changed data rewrites history.
   */
  app.post('/api/v1/invoices/:id/match', { preHandler: guard('match.read') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { tolerance?: { quantityPct?: number; ratePct?: number; valueAbsolute?: number }; override_reason?: string };
    const row = await mutate(pool, req, 'invoice.match', 'invoice', async db => {
      const invoice = await inOrg(db, 'invoices', id, u.orgId, true);
      if (!invoice.purchase_order_id) {
        fail('NO_PURCHASE_ORDER',
          'This invoice is not linked to a purchase order, so there is nothing to match it against');
      }
      const poLines = (await db.query(
        'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no',
        [invoice.purchase_order_id])).rows;
      const receipts = await receiptsFor(db, String(invoice.purchase_order_id));
      const invoiceLines = (await db.query(
        'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [id])).rows;

      // Match by description where no explicit link exists; a real deployment
      // would key on item_id, and that is preferred when present.
      const invoiceByKey = new Map(invoiceLines.map(l => [String(l.item_id ?? l.description), l]));
      const lines = poLines.map(p => {
        const inv = invoiceByKey.get(String(p.item_id ?? p.description));
        return {
          reference: String(p.description),
          orderedQuantity: Number(p.quantity),
          orderedRate: Number(p.unit_rate),
          receivedQuantity: receipts.get(String(p.id))?.accepted ?? 0,
          invoicedQuantity: inv ? Number(inv.quantity) : 0,
          invoicedRate: inv ? Number(inv.unit_rate) : 0,
        };
      });

      const result = threeWayMatch(lines, body.tolerance ?? {});
      let overridden = false;
      if (!result.matched && body.override_reason) {
        if (!u.permissions.includes('match.override')) {
          fail('FORBIDDEN',
            'Releasing payment against a mismatched invoice needs the match.override permission', 403);
        }
        overridden = true;
      }

      const record = (await db.query(
        `INSERT INTO invoice_match_results(org_id, invoice_id, purchase_order_id, matched, exceptions,
           ordered_value, received_value, invoiced_value, override_by, override_reason, override_at, checked_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [u.orgId, id, invoice.purchase_order_id, result.matched, JSON.stringify(result.exceptions),
         result.orderedValue, result.receivedValue, result.invoicedValue,
         overridden ? u.id : null, overridden ? body.override_reason : null,
         overridden ? new Date() : null, u.id])).rows[0];

      await db.query(
        'UPDATE invoices SET match_status = $2 WHERE id = $1',
        [id, result.matched ? 'MATCHED' : overridden ? 'OVERRIDDEN' : 'EXCEPTION']);

      return { ...record, ...result };
    });
    return reply.code(201).send({ data: row });
  });

  app.get('/api/v1/invoices/:id/match', { preHandler: guard('match.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await inOrg(pool, 'invoices', id, u.orgId);
    const rows = (await pool.query(
      'SELECT * FROM invoice_match_results WHERE invoice_id = $1 ORDER BY created_at DESC', [id])).rows;
    return { data: rows };
  });
}

import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  requisitionSchema, purchaseOrderSchema, grnSchema,
  rfqSchema, quoteSchema, returnSchema, acknowledgementSchema,
  receiptStatus, threeWayMatch, withinRequisition,
  compareQuotes, lowestQuote, checkAmendment, requiresReapproval,
  PR_TRANSITIONS, PO_TRANSITIONS, type PrStatus, type PoStatus,
  resolveLadder, type LadderMode, type VendorQuote,
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

  /** Authority slabs for a policy, in the shape the shared resolver wants. */
  async function levelsForPolicy(db: Pool | PoolClient, policyId: string) {
    return (await db.query(
      'SELECT * FROM approval_levels WHERE policy_id = $1 ORDER BY sequence', [policyId])).rows
      .map(r => ({
        sequence: Number(r.sequence), minAmount: Number(r.min_amount),
        maxAmount: r.max_amount === null ? null : Number(r.max_amount),
        approverRole: r.approver_role, approverUserId: r.approver_user_id,
        slaHours: r.sla_hours === null ? null : Number(r.sla_hours),
      }));
  }

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
    const ladder = resolveLadder(
      await levelsForPolicy(db, String(policy.id)), amount, policy.mode as LadderMode);
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

  /* ------------------------------------------------------- RFQ (§43.1) */

  app.get('/api/v1/rfqs', { preHandler: guard('rfq.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'r.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND r.status = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT r.*, v.name AS selected_vendor_name,
              (SELECT count(*)::int FROM rfq_vendors iv WHERE iv.rfq_id = r.id) AS invited_count,
              (SELECT count(*)::int FROM vendor_quotes vq WHERE vq.rfq_id = r.id) AS quote_count
       FROM rfqs r LEFT JOIN vendors v ON v.id = r.selected_vendor_id
       WHERE ${where} ORDER BY r.due_date DESC, r.created_at DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.get('/api/v1/rfqs/:id', { preHandler: guard('rfq.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const rfq = await inOrg(pool, 'rfqs', id, u.orgId);
    const [lines, invited, quotes] = await Promise.all([
      pool.query('SELECT * FROM rfq_lines WHERE rfq_id = $1 ORDER BY line_no', [id]),
      pool.query(
        `SELECT iv.vendor_id, v.name AS vendor_name, iv.invited_at
         FROM rfq_vendors iv JOIN vendors v ON v.id = iv.vendor_id
         WHERE iv.rfq_id = $1 ORDER BY v.name`, [id]),
      pool.query(
        `SELECT q.id, q.vendor_id, v.name AS vendor_name, q.quote_date, q.technically_qualified
         FROM vendor_quotes q JOIN vendors v ON v.id = q.vendor_id
         WHERE q.rfq_id = $1 ORDER BY q.created_at`, [id]),
    ]);
    // Who was invited but has not responded — the chase list before the due date.
    const quoted = new Set(quotes.rows.map(r => String(r.vendor_id)));
    return {
      data: {
        ...rfq, lines: lines.rows, invited: invited.rows, quotes: quotes.rows,
        awaiting: invited.rows.filter(v => !quoted.has(String(v.vendor_id))),
      },
    };
  });

  app.post('/api/v1/rfqs', { preHandler: guard('rfq.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(rfqSchema, req.body);
    if (input.project_id) await projectAccess(pool, req, input.project_id);
    const row = await mutate(pool, req, 'rfq.create', 'rfq', async db => {
      for (const vendorId of input.vendor_ids) {
        const vendor = await inOrg(db, 'vendors', vendorId, u.orgId);
        // Inviting a blacklisted vendor wastes everyone's time and invites the
        // award to go to somebody who cannot be given the order.
        if (String(vendor.blacklist_status) === 'BLACKLISTED') {
          fail('VENDOR_BLACKLISTED', `${vendor.name} is blacklisted and cannot be invited to quote`);
        }
      }
      const rfq = (await db.query(
        `INSERT INTO rfqs(org_id, created_by, rfq_no, requisition_id, project_id, due_date, scope)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.rfq_no, input.requisition_id ?? null,
         input.project_id ?? null, input.due_date, input.scope ?? null])).rows[0];
      let lineNo = 0;
      for (const line of input.lines) {
        lineNo += 1;
        await db.query(
          `INSERT INTO rfq_lines(org_id, rfq_id, line_no, item_id, description, unit, quantity)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [u.orgId, rfq.id, lineNo, line.item_id ?? null, line.description, line.unit, line.quantity]);
      }
      for (const vendorId of input.vendor_ids) {
        await db.query('INSERT INTO rfq_vendors(org_id, rfq_id, vendor_id) VALUES($1,$2,$3)',
          [u.orgId, rfq.id, vendorId]);
      }
      return rfq;
    });
    return reply.code(201).send({ data: row });
  });

  app.post('/api/v1/rfqs/:id/quotes', { preHandler: guard('rfq.manage') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(quoteSchema, req.body);
    const body = req.body as { disqualification_reason?: string };
    const row = await mutate(pool, req, 'rfq.quote', 'rfq', async db => {
      const rfq = await inOrg(db, 'rfqs', id, u.orgId, true);
      if (rfq.status !== 'OPEN') {
        fail('RFQ_CLOSED', `Quotes cannot be recorded against a ${String(rfq.status).toLowerCase()} RFQ`);
      }
      const invited = await db.query(
        'SELECT 1 FROM rfq_vendors WHERE rfq_id = $1 AND vendor_id = $2', [id, input.vendor_id]);
      if (!invited.rowCount) {
        fail('VENDOR_NOT_INVITED',
          'That vendor was not invited to this RFQ. Accepting an uninvited quote defeats the comparison.');
      }
      if (!input.technically_qualified && !body.disqualification_reason) {
        fail('VALIDATION_ERROR', 'Say why the quote is technically disqualified');
      }
      let quote;
      try {
        quote = (await db.query(
          `INSERT INTO vendor_quotes(org_id, created_by, rfq_id, vendor_id, quote_no, quote_date,
             validity_days, freight, other_charges, delivery_days, payment_terms,
             technically_qualified, gst_creditable, disqualification_reason)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [u.orgId, u.id, id, input.vendor_id, input.quote_no ?? null, input.quote_date,
           input.validity_days ?? null, input.freight ?? 0, input.other_charges ?? 0,
           input.delivery_days ?? null, input.payment_terms ?? null,
           input.technically_qualified, input.gst_creditable,
           body.disqualification_reason ?? null])).rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          fail('QUOTE_ALREADY_RECORDED',
            'A quote from this vendor is already on the RFQ. Withdraw it before recording a revision.', 409);
        }
        throw error;
      }
      for (const line of input.lines) {
        await db.query(
          `INSERT INTO vendor_quote_lines(org_id, quote_id, rfq_line_id, unit_rate,
             discount_pct, gst_rate_pct, remarks)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [u.orgId, quote.id, line.rfq_line_id, line.unit_rate,
           line.discount_pct, line.gst_rate_pct, line.remarks ?? null]);
      }
      return quote;
    });
    return reply.code(201).send({ data: row });
  });

  /** The comparison sheet: landed cost per vendor, ranked (§43.1). */
  app.get('/api/v1/rfqs/:id/comparison', { preHandler: guard('rfq.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const rfq = await inOrg(pool, 'rfqs', id, u.orgId);
    const rfqLines = (await pool.query(
      'SELECT * FROM rfq_lines WHERE rfq_id = $1 ORDER BY line_no', [id])).rows;
    const quantities = new Map(rfqLines.map(l => [String(l.id), Number(l.quantity)]));
    const rows = (await pool.query(
      `SELECT q.*, v.name AS vendor_name,
              COALESCE(json_agg(l.* ORDER BY l.rfq_line_id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
       FROM vendor_quotes q
       JOIN vendors v ON v.id = q.vendor_id
       LEFT JOIN vendor_quote_lines l ON l.quote_id = q.id
       WHERE q.rfq_id = $1 GROUP BY q.id, v.name ORDER BY q.created_at`, [id])).rows;

    const quotes: VendorQuote[] = rows.map(r => ({
      vendorId: String(r.vendor_id),
      vendorName: String(r.vendor_name),
      freight: Number(r.freight),
      otherCharges: Number(r.other_charges),
      deliveryDays: r.delivery_days === null ? undefined : Number(r.delivery_days),
      technicallyQualified: r.technically_qualified,
      gstCreditable: r.gst_creditable,
      paymentTerms: r.payment_terms ?? undefined,
      lines: (r.lines as Record<string, unknown>[]).map(l => ({
        reference: String(l.rfq_line_id),
        quantity: quantities.get(String(l.rfq_line_id)) ?? 0,
        unitRate: Number(l.unit_rate),
        discountPct: Number(l.discount_pct),
        gstRatePct: Number(l.gst_rate_pct),
      })),
    }));

    const evaluations = compareQuotes(quotes);
    return {
      data: {
        rfq, lines: rfqLines, evaluations,
        recommended: lowestQuote(evaluations),
      },
    };
  });

  /**
   * Award the RFQ.
   *
   * Choosing anyone but L1 is allowed — delivery, quality history and capacity
   * are real considerations — but §43.1 asks for the justification, and it is
   * demanded here rather than left optional.
   */
  app.post('/api/v1/rfqs/:id/award', { preHandler: guard('rfq.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { vendor_id?: string; reason?: string };
    if (!body.vendor_id) fail('VALIDATION_ERROR', 'Name the vendor being awarded');
    return {
      data: await mutate(pool, req, 'rfq.award', 'rfq', async db => {
        const rfq = await inOrg(db, 'rfqs', id, u.orgId, true);
        version(req, rfq as { version: number });
        if (rfq.status !== 'OPEN') {
          fail('RFQ_CLOSED', `A ${String(rfq.status).toLowerCase()} RFQ cannot be awarded again`);
        }
        const quote = await db.query(
          'SELECT technically_qualified FROM vendor_quotes WHERE rfq_id = $1 AND vendor_id = $2',
          [id, body.vendor_id]);
        if (!quote.rowCount) fail('NO_QUOTE', 'That vendor did not quote on this RFQ');
        if (!quote.rows[0].technically_qualified) {
          fail('NOT_QUALIFIED', 'That quote was technically disqualified and cannot be awarded');
        }
        if (!body.reason) {
          fail('VALIDATION_ERROR',
            'Record why this vendor was selected — the comparison has to be defensible later');
        }
        return (await db.query(
          `UPDATE rfqs SET status='AWARDED', selected_vendor_id=$2, selection_reason=$3,
             selected_by=$4, selected_at=now(), version=version+1, updated_at=now(), updated_by=$4
           WHERE id=$1 RETURNING *`, [id, body.vendor_id, body.reason, u.id])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------- amendments (§43.2) */

  /**
   * Amend an issued order.
   *
   * The gap this closes: po_amendments existed as a table with no endpoint.
   * A material change re-routes the approval through the §41 engine, so an
   * order approved at one value cannot quietly ship at another.
   */
  app.post('/api/v1/purchase-orders/:id/amend', { preHandler: guard('po.amend') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as {
      reason?: string;
      lines?: { po_line_id: string; quantity?: number; unit_rate?: number }[];
      delivery_date?: string;
    };
    if (!body.reason) fail('VALIDATION_ERROR', 'Say why the order is being amended');
    const row = await mutate(pool, req, 'po.amend', 'purchase_order', async db => {
      const po = await inOrg(db, 'purchase_orders', id, u.orgId, true);
      version(req, po as { version: number });
      if (['CLOSED', 'CANCELLED', 'FULLY_RECEIVED'].includes(String(po.status))) {
        fail('PO_NOT_AMENDABLE', `An order at ${po.status} can no longer be amended`);
      }

      const poLines = (await db.query(
        'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no', [id])).rows;
      const receipts = await receiptsFor(db, id);
      const proposed = new Map((body.lines ?? []).map(l => [l.po_line_id, l]));

      const check = checkAmendment(poLines.map(l => {
        const change = proposed.get(String(l.id));
        return {
          poLineId: String(l.id),
          reference: String(l.description),
          currentQuantity: Number(l.quantity),
          newQuantity: change?.quantity ?? Number(l.quantity),
          currentRate: Number(l.unit_rate),
          newRate: change?.unit_rate ?? Number(l.unit_rate),
          receivedQuantity: receipts.get(String(l.id))?.accepted ?? 0,
        };
      }));
      if (!check.valid) fail('INVALID_AMENDMENT', check.problems.join('; '));

      for (const l of poLines) {
        const change = proposed.get(String(l.id));
        if (!change) continue;
        const quantity = change.quantity ?? Number(l.quantity);
        const rate = change.unit_rate ?? Number(l.unit_rate);
        const taxable = Math.round(quantity * rate * 100) / 100;
        const tax = Math.round(taxable * Number(l.gst_rate_pct)) / 100;
        await db.query(
          `UPDATE purchase_order_lines SET quantity=$2, unit_rate=$3, taxable_value=$4,
             tax_amount=$5, line_total=$6 WHERE id=$1`,
          [l.id, quantity, rate, taxable.toFixed(2), tax.toFixed(2), (taxable + tax).toFixed(2)]);
      }

      const totals = (await db.query(
        `SELECT COALESCE(sum(taxable_value),0) AS taxable, COALESCE(sum(tax_amount),0) AS tax,
                COALESCE(sum(line_total),0) AS total
         FROM purchase_order_lines WHERE purchase_order_id = $1`, [id])).rows[0];

      const revision = Number(po.revision) + 1;
      const amendment = (await db.query(
        `INSERT INTO po_amendments(org_id, purchase_order_id, revision, reason,
           previous_total, new_total, changes, amended_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [u.orgId, id, revision, body.reason, po.total_value, totals.total,
         JSON.stringify({ lines: body.lines ?? [], delivery_date: body.delivery_date ?? null }), u.id])).rows[0];

      await db.query(
        `UPDATE purchase_orders SET taxable_value=$2, tax_amount=$3, total_value=$4,
           delivery_date=COALESCE($5, delivery_date), revision=$6,
           version=version+1, updated_at=now(), updated_by=$7
         WHERE id=$1`,
        [id, totals.taxable, totals.tax, totals.total, body.delivery_date ?? null, revision, u.id]);

      // §41: an order approved at one value must not ship at another. The
      // approval engine decides whether the move is material.
      let reapproval: { required: boolean; reason: string } | null = null;
      if (po.approval_id) {
        const instance = (await db.query(
          'SELECT * FROM approval_instances WHERE id = $1', [po.approval_id])).rows[0];
        const policy = (await db.query(
          'SELECT * FROM approval_policies WHERE id = $1', [instance.policy_id])).rows[0];
        const levels = await levelsForPolicy(db, String(instance.policy_id));
        const verdict = requiresReapproval({
          approvedAmount: Number(instance.amount),
          newAmount: Number(totals.total),
          levels,
          mode: policy.mode as LadderMode,
          tolerancePct: Number(policy.tolerance_pct),
        });
        reapproval = verdict;
        if (verdict.required) {
          await db.query(
            `UPDATE approval_instances SET status='SUPERSEDED', superseded_reason=$2, superseded_by=$1,
               decided_at=now(), version=version+1, updated_at=now(), updated_by=$3
             WHERE id=$1`, [po.approval_id, `Amendment ${revision}: ${verdict.reason}`, u.id]);
          await db.query(
            "UPDATE approval_steps SET status='SKIPPED' WHERE instance_id=$1 AND status='PENDING'",
            [po.approval_id]);
          const freshId = await submitForApproval(
            db, req, 'PURCHASE_ORDER', id, Number(totals.total), po.project_id);
          await db.query('UPDATE approval_instances SET superseded_by=$2 WHERE id=$1',
            [po.approval_id, freshId]);
          await db.query(
            `UPDATE purchase_orders SET approval_id=$2, status='PENDING_APPROVAL',
               version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1`,
            [id, freshId, u.id]);
          await db.query('UPDATE po_amendments SET approval_id=$2 WHERE id=$1', [amendment.id, freshId]);
        }
      }
      return { ...amendment, reapproval };
    });
    return reply.code(201).send({ data: row });
  });

  /* ------------------------------------------- acknowledgement (§43.4) */

  app.post('/api/v1/purchase-orders/:id/acknowledge', { preHandler: guard('po.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(acknowledgementSchema, req.body);
    return {
      data: await mutate(pool, req, 'po.acknowledge', 'purchase_order', async db => {
        const po = await inOrg(db, 'purchase_orders', id, u.orgId, true);
        version(req, po as { version: number });
        // Anything from APPROVED onward has been issued, so a vendor can
        // acknowledge it — including retrospectively after delivery, which is
        // ordinary record-keeping. Only a draft or a cancelled order has
        // genuinely never reached them.
        if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(String(po.status))) {
          fail('PO_NOT_ISSUED',
            `An order at ${po.status} has not been issued to the vendor, so there is nothing to acknowledge`);
        }
        // A promised date earlier than the order itself is a data-entry error.
        if (input.promised_delivery_date && input.promised_delivery_date < String(po.po_date).slice(0, 10)) {
          fail('VALIDATION_ERROR', 'The promised delivery date cannot precede the order date');
        }
        return (await db.query(
          `UPDATE purchase_orders SET acknowledged_on=$2, acknowledged_reference=$3,
             promised_delivery_date=$4, acknowledgement_exceptions=$5,
             version=version+1, updated_at=now(), updated_by=$6
           WHERE id=$1 RETURNING *`,
          [id, input.acknowledged_on, input.reference ?? null,
           input.promised_delivery_date ?? null, input.exceptions ?? null, u.id])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------- returns (§43.3) */

  app.post('/api/v1/vendor-returns', { preHandler: guard('return.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(returnSchema, req.body);
    const row = await mutate(pool, req, 'return.create', 'vendor_return', async db => {
      const grn = await inOrg(db, 'goods_receipt_notes', input.grn_id, u.orgId, true);
      if (grn.status !== 'RECEIVED') {
        fail('GRN_CANCELLED', 'Material cannot be returned against a cancelled receipt');
      }
      const grnLines = new Map((await db.query(
        `SELECT l.*, p.item_id, p.description
         FROM grn_lines l JOIN purchase_order_lines p ON p.id = l.po_line_id
         WHERE l.grn_id = $1`, [input.grn_id])).rows.map(r => [String(r.id), r]));

      // Already returned, so a second return cannot exceed what is left.
      const returned = new Map((await db.query(
        `SELECT l.grn_line_id, COALESCE(sum(l.quantity),0) AS qty
         FROM vendor_return_lines l
         JOIN vendor_returns r ON r.id = l.return_id
         WHERE r.grn_id = $1 GROUP BY l.grn_line_id`, [input.grn_id])).rows
        .map(r => [String(r.grn_line_id), Number(r.qty)]));

      for (const line of input.lines) {
        const grnLine = grnLines.get(line.grn_line_id);
        if (!grnLine) fail('UNKNOWN_GRN_LINE', 'A return line does not belong to this receipt');
        const accepted = Number(grnLine!.accepted_quantity);
        const already = returned.get(line.grn_line_id) ?? 0;
        if (already + line.quantity > accepted) {
          fail('EXCEEDS_RECEIPT',
            `${grnLine!.description}: returning ${line.quantity} would exceed the ${accepted} accepted` +
            (already ? ` (${already} already returned)` : ''));
        }
      }

      const ret = (await db.query(
        `INSERT INTO vendor_returns(org_id, created_by, return_no, grn_id, return_date,
           reason, resolution, remarks, returned_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$2) RETURNING *`,
        [u.orgId, u.id, input.return_no, input.grn_id, input.return_date,
         input.reason, input.resolution, input.remarks])).rows[0];

      for (const line of input.lines) {
        const grnLine = grnLines.get(line.grn_line_id)!;
        // §43.3: inventory moves only through controlled transactions, so the
        // return posts its own OUT rather than editing the original receipt.
        let stockId: string | null = null;
        if (grnLine.item_id) {
          stockId = (await db.query(
            `INSERT INTO stock_transactions(org_id, created_by, item_id, direction, quantity, reference)
             VALUES($1,$2,$3,'OUT',$4,$5) RETURNING id`,
            [u.orgId, u.id, grnLine.item_id, line.quantity, `Return ${input.return_no}`])).rows[0].id;
        }
        await db.query(
          `INSERT INTO vendor_return_lines(org_id, return_id, grn_line_id, quantity, remarks, stock_transaction_id)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [u.orgId, ret.id, line.grn_line_id, line.quantity, line.remarks ?? null, stockId]);
      }
      return ret;
    });
    return reply.code(201).send({ data: row });
  });

  app.get('/api/v1/vendor-returns', { preHandler: guard('return.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'r.org_id = $1';
    if (q.grn_id) { values.push(q.grn_id); where += ` AND r.grn_id = $${values.length}::uuid`; }
    const rows = (await pool.query(
      `SELECT r.*, g.grn_no FROM vendor_returns r
       JOIN goods_receipt_notes g ON g.id = r.grn_id
       WHERE ${where} ORDER BY r.return_date DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });
}

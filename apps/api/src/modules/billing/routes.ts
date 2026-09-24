import type { FastifyInstance } from 'fastify';
import { paise } from "../../common/money.js";
import type { Pool, PoolClient } from 'pg';
import {
  boqItemSchema, raBillSchema, deductionPolicySchema, advanceSchema,
  raBillLine, computeRaBill, recoverAdvance, retentionReleaseStatus,
  RA_BILL_TRANSITIONS, type RaBillStatus, type RaBillLine, type DeductionPolicy,
  surveyBoqLinkSchema, measuredLine, proposalHasWork, dateStringSchema,
  receivableDueDate, raBillDisputeSchema, businessDay,
  raBillStatusSchema, certifiableAmount, retentionReleaseSchema,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail, projectAccess } from '../../common/domain.js';

/**
 * Running-account billing (§15, §37.3).
 *
 * The invariant this module protects: a bill claims cumulative measurement
 * less what earlier bills already claimed. `previous_quantity` is therefore
 * never supplied by the caller — it is read from the last certified bill
 * inside the same transaction. A client that could set it would be able to
 * bill the same work twice by sending zero.
 */
export async function registerBillingRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  /** The policy that applies to a project, with the org's own defaults absent. */
  async function policyFor(db: Pool | PoolClient, projectId: string): Promise<DeductionPolicy & { gstRatePct?: number; dlpEndDate?: string | null; firstTranchePct?: number }> {
    const row = (await db.query('SELECT * FROM project_billing_policies WHERE project_id = $1', [projectId])).rows[0];
    if (!row) return {};
    return {
      retentionPct: num(row.retention_pct),
      retentionCapPctOfContract: num(row.retention_cap_pct_of_contract),
      securityDepositPct: num(row.security_deposit_pct),
      labourCessPct: num(row.labour_cess_pct),
      tdsIncomeTaxPct: num(row.tds_income_tax_pct),
      tdsGstPct: num(row.tds_gst_pct),
      gstRatePct: num(row.gst_rate_pct),
      dlpEndDate: row.dlp_end_date,
      firstTranchePct: num(row.retention_first_tranche_pct),
    };
  }
  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

  /**
   * Cumulative quantity certified per BOQ item on earlier bills.
   *
   * Drawn from bills that are CERTIFIED or PAID only. A draft or submitted
   * bill has not been accepted by the client, so treating its measurement as
   * "already billed" would understate the next claim.
   */
  async function previouslyCertified(
    db: Pool | PoolClient, projectId: string, excludeBillId?: string,
  ) {
    const rows = (await db.query(
      `SELECT i.boq_item_id,
              max(i.cumulative_quantity) AS qty,
              max(i.cumulative_amount)   AS amount
       FROM ra_bill_items i
       JOIN ra_bills b ON b.id = i.ra_bill_id
       WHERE b.project_id = $1 AND b.status IN ('CERTIFIED','PAID')
         AND ($2::uuid IS NULL OR b.id <> $2)
       GROUP BY i.boq_item_id`, [projectId, excludeBillId ?? null])).rows;
    return new Map(rows.map(r => [String(r.boq_item_id), { qty: Number(r.qty), amount: Number(r.amount) }]));
  }

  /* ------------------------------------------------------------------ BOQ */

  app.get('/api/v1/projects/:id/boq', { preHandler: guard('boq.read') }, async req => {
    const id = (req.params as { id: string }).id;
    await projectAccess(pool, req, id);
    const rows = (await pool.query(
      `SELECT * FROM boq_items WHERE project_id = $1 AND status = 'ACTIVE'
       ORDER BY sort_order, item_code`, [id])).rows;
    const total = rows.reduce((t, r) => t + Number(r.amount), 0);
    return { data: rows, summary: { item_count: rows.length, boq_value: total.toFixed(2) } };
  });

  app.post('/api/v1/projects/:id/boq', { preHandler: guard('boq.manage') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(boqItemSchema, req.body);
    await projectAccess(pool, req, id);
    const row = await mutate(pool, req, 'boq.create', 'boq_item', async db => {
      await inOrg(db, 'projects', id, u.orgId);
      const amount = paise(input.quantity * input.rate);
      return (await db.query(
        `INSERT INTO boq_items(org_id, created_by, project_id, item_code, section, description,
           unit, quantity, rate, amount, sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           COALESCE((SELECT max(sort_order)+1 FROM boq_items WHERE project_id=$3),0))
         RETURNING *`,
        [u.orgId, u.id, id, input.item_code, input.section ?? null, input.description,
         input.unit, input.quantity, input.rate, amount])).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  /* ------------------------------------------------------- billing policy */

  app.put('/api/v1/projects/:id/billing-policy', { preHandler: guard('boq.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(deductionPolicySchema, req.body) as Record<string, unknown>;
    await projectAccess(pool, req, id);
    return {
      data: await mutate(pool, req, 'billing.policy', 'project', async db => {
        await inOrg(db, 'projects', id, u.orgId);
        // A certified bill froze its own figures, but changing the policy
        // while a measurement is open would silently redraw that bill.
        const open = await db.query(
          "SELECT bill_no FROM ra_bills WHERE project_id=$1 AND status IN ('DRAFT','SUBMITTED')", [id]);
        if (open.rowCount) {
          fail('BILL_IN_PROGRESS',
            `Bill ${open.rows[0].bill_no} is still open. Certify or cancel it before changing the deduction policy.`);
        }
        const keys = Object.keys(input);
        const cols = ['retention_pct','retention_cap_pct_of_contract','security_deposit_pct',
          'labour_cess_pct','tds_income_tax_pct','tds_gst_pct','gst_rate_pct',
          'payment_terms_days'].filter(c => keys.includes(c));
        const sets = cols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
        return (await db.query(
          `INSERT INTO project_billing_policies(project_id, org_id, created_by, ${cols.join(',')})
           VALUES($1,$2,$3,${cols.map((_, i) => `$${i + 4}`).join(',')})
           ON CONFLICT (project_id) DO UPDATE SET ${sets},
             version = project_billing_policies.version + 1, updated_at = now(), updated_by = $3
           RETURNING *`,
          [id, u.orgId, u.id, ...cols.map(c => input[c])])).rows[0];
      }),
    };
  });

  /* -------------------------------------------------------------- advances */

  app.post('/api/v1/advances', { preHandler: guard('rabill.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(advanceSchema, req.body);
    await projectAccess(pool, req, input.project_id);
    const row = await mutate(pool, req, 'advance.create', 'advance', async db => {
      await inOrg(db, 'projects', input.project_id, u.orgId);
      return (await db.query(
        `INSERT INTO project_advances(org_id, created_by, project_id, advance_type, amount,
           paid_on, recovery_pct, bank_guarantee_id, remarks)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [u.orgId, u.id, input.project_id, input.advance_type, input.amount,
         input.paid_on, input.recovery_pct, input.bank_guarantee_id ?? null, input.remarks ?? null])).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  /**
   * There was no way to see an advance once it was recorded — "New advance"
   * on the billing page had no list beside it, and nothing but a direct SQL
   * query could confirm one had actually been saved (item 6, final QA fix
   * wave). Same read permission and org-scoping as the RA-bill list
   * (rabill.read); unlike that one this is not nested under a project, since
   * the billing page wants "every advance", filterable down to one project.
   */
  app.get('/api/v1/advances', { preHandler: guard('rabill.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'a.org_id = $1';
    if (q.project_id) {
      await projectAccess(pool, req, String(q.project_id));
      values.push(q.project_id);
      where += ` AND a.project_id = $${values.length}::uuid`;
    }
    const rows = (await pool.query(
      `SELECT a.*, p.code AS project_code, p.name AS project_name
       FROM project_advances a JOIN projects p ON p.id = a.project_id
       WHERE ${where} ORDER BY a.paid_on DESC, a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  /* -------------------------------------------------------------- RA bills */

  app.get('/api/v1/projects/:id/ra-bills', { preHandler: guard('rabill.read') }, async req => {
    const id = (req.params as { id: string }).id;
    await projectAccess(pool, req, id);
    const rows = (await pool.query(
      'SELECT * FROM ra_bills WHERE project_id = $1 ORDER BY bill_no DESC', [id])).rows;
    return { data: rows };
  });

  app.get('/api/v1/ra-bills/:id', { preHandler: guard('rabill.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const bill = await inOrg(pool, 'ra_bills', id, u.orgId);
    await projectAccess(pool, req, String(bill.project_id));
    const [items, deductions] = await Promise.all([
      pool.query(
        `SELECT i.*, b.item_code, b.description, b.unit, b.quantity AS boq_quantity
         FROM ra_bill_items i JOIN boq_items b ON b.id = i.boq_item_id
         WHERE i.ra_bill_id = $1 ORDER BY b.sort_order, b.item_code`, [id]),
      pool.query('SELECT * FROM ra_bill_deductions WHERE ra_bill_id = $1 ORDER BY head', [id]),
    ]);
    return {
      data: {
        ...bill,
        items: items.rows,
        deductions: deductions.rows,
        allowed_statuses: RA_BILL_TRANSITIONS[bill.status as RaBillStatus] ?? [],
      },
    };
  });

  /**
   * Draw a bill.
   *
   * Everything — increments, deductions, advance recovery, the net — is
   * computed server-side from the cumulative measurement the caller supplies
   * and the policy on file. The caller states what was measured; it does not
   * state what it is owed.
   */
  app.post('/api/v1/ra-bills', { preHandler: guard('rabill.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(raBillSchema, req.body);
    await projectAccess(pool, req, input.project_id);
    const row = await mutate(pool, req, 'rabill.create', 'ra_bill', async db => {
      const project = await inOrg(db, 'projects', input.project_id, u.orgId, true);

      const finalBill = await db.query(
        "SELECT bill_no FROM ra_bills WHERE project_id=$1 AND bill_type='FINAL' AND status<>'CANCELLED'",
        [input.project_id]);
      if (finalBill.rowCount) {
        fail('FINAL_BILL_RAISED',
          `The final bill (${finalBill.rows[0].bill_no}) closes this account. No further bill can be raised.`);
      }

      const boq = new Map((await db.query(
        "SELECT * FROM boq_items WHERE project_id=$1 AND status='ACTIVE'", [input.project_id])
      ).rows.map(r => [String(r.id), r]));
      const previous = await previouslyCertified(db, input.project_id);

      const computed: (RaBillLine & { boqItemId: string; remarks?: string })[] = [];
      for (const line of input.lines) {
        const item = boq.get(line.boq_item_id);
        if (!item) fail('UNKNOWN_BOQ_ITEM', 'A measured item is not on this project’s active BOQ');
        const prior = previous.get(line.boq_item_id);
        computed.push({
          ...raBillLine({
            boqQuantity: Number(item!.quantity),
            rate: Number(item!.rate),
            cumulativeQuantity: line.cumulative_quantity,
            previousQuantity: prior?.qty ?? 0,
          }),
          boqItemId: line.boq_item_id,
          remarks: line.remarks,
        });
      }

      const grossValue = computed.reduce((t, l) => t + l.thisAmount, 0);
      if (grossValue <= 0 && input.bill_type !== 'FINAL') {
        fail('NOTHING_TO_BILL',
          'This measurement claims no additional work. Record further progress before raising a bill.');
      }

      const policy = await policyFor(db, input.project_id);
      // Retention already withheld feeds the contract cap.
      const held = Number((await db.query(
        `SELECT COALESCE(sum(CASE WHEN entry_type='WITHHELD' THEN amount ELSE -amount END),0) AS held
         FROM retention_ledger WHERE project_id=$1`, [input.project_id])).rows[0].held);

      const advances = (await db.query(
        "SELECT * FROM project_advances WHERE project_id=$1 AND status='OUTSTANDING' ORDER BY paid_on",
        [input.project_id])).rows;
      const recoveries = advances.map(a => ({
        row: a,
        recovery: recoverAdvance(
          Number(a.amount) - Number(a.recovered_amount), grossValue, Number(a.recovery_pct),
          a.advance_type === 'MATERIAL' ? 'MATERIAL_ADVANCE' : 'MOBILISATION_ADVANCE'),
      }));

      const totals = computeRaBill(computed, policy, {
        contractValue: project.contract_value ? Number(project.contract_value) : undefined,
        retentionHeldToDate: held,
        gstRatePct: policy.gstRatePct,
        advances: recoveries.map(r => r.recovery),
        fixedDeductions: input.fixed_deductions.map(d => ({ head: d.head, label: d.label, amount: d.amount })),
      });

      const billNo = Number((await db.query(
        'SELECT COALESCE(max(bill_no),0)+1 AS next FROM ra_bills WHERE project_id=$1', [input.project_id])
      ).rows[0].next);

      let bill;
      try {
        bill = (await db.query(
          `INSERT INTO ra_bills(org_id, created_by, project_id, bill_no, bill_type, period_from, period_to,
             measurement_book_ref, cumulative_value, previous_value, gross_value, gst_amount,
             total_deductions, net_payable, remarks)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [u.orgId, u.id, input.project_id, billNo, input.bill_type, input.period_from, input.period_to,
           input.measurement_book_ref ?? null,
           computed.reduce((t, l) => t + l.cumulativeAmount, 0),
           computed.reduce((t, l) => t + l.previousAmount, 0),
           totals.grossValue, totals.gstAmount, totals.totalDeductions, totals.netPayable,
           input.remarks ?? null])).rows[0];
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).constraint === 'uk_ra_one_open') {
          fail('BILL_IN_PROGRESS',
            'A bill is already open on this project. Certify or cancel it before raising another.', 409);
        }
        throw error;
      }

      for (const line of computed) {
        await db.query(
          `INSERT INTO ra_bill_items(org_id, ra_bill_id, boq_item_id, cumulative_quantity,
             previous_quantity, rate, cumulative_amount, previous_amount, this_amount,
             excess_quantity, remarks)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [u.orgId, bill.id, line.boqItemId, line.cumulativeQuantity, line.previousQuantity,
           line.rate, line.cumulativeAmount, line.previousAmount, line.thisAmount,
           line.excessQuantity, line.remarks ?? null]);
      }

      const advanceByHead = new Map(recoveries
        .filter(r => r.recovery.recovered > 0)
        .map(r => [r.recovery.head + ':' + String(r.recovery.recovered), r.row.id]));
      for (const d of totals.deductions) {
        const reason = input.fixed_deductions.find(f => f.head === d.head && f.amount === d.amount)?.reason;
        await db.query(
          `INSERT INTO ra_bill_deductions(org_id, ra_bill_id, head, label, basis, rate_pct, amount, advance_id, reason)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [u.orgId, bill.id, d.head, d.label, d.basis, d.ratePct, d.amount,
           advanceByHead.get(d.head + ':' + String(d.amount)) ?? null, reason ?? null]);
      }

      return {
        ...bill,
        items: computed,
        deductions: totals.deductions,
        excess_items: computed.filter(l => l.isExcess).length,
        downward_revisions: computed.filter(l => l.isDownwardRevision).length,
      };
    });
    return reply.code(201).send({ data: row });
  });

  /**
   * Move a bill along its lifecycle.
   *
   * Certification is the hinge: it turns the measurement into a receivable, so
   * it needs its own permission (§4.1 keeps it away from whoever measured),
   * and it is the point at which retention is actually withheld and advances
   * are actually recovered. Doing that at draft time would let an abandoned
   * measurement move money.
   */
  app.post('/api/v1/ra-bills/:id/status', { preHandler: guard('rabill.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = parse(raBillStatusSchema, req.body);
    const next = body.status;
    // Certification is project-scoped like every other bill mutation: a
    // manager scoped to one project must not certify another's bill by id.
    await projectAccess(pool, req, String((await inOrg(pool, 'ra_bills', id, u.orgId)).project_id));
    return {
      data: await mutate(pool, req, 'rabill.status', 'ra_bill', async db => {
        const bill = await inOrg(db, 'ra_bills', id, u.orgId, true);
        version(req, bill as { version: number });
        // The certified figure becomes the receivable. Less than claimed is
        // the client's prerogative; more than the work plus its tax is not.
        if (body.certified_amount !== undefined && next !== 'CERTIFIED') {
          fail('VALIDATION_ERROR', 'A certified amount is recorded when the bill is certified, not on other moves');
        }
        if (body.certified_amount !== undefined
            && !certifiableAmount({ gross_value: bill.gross_value, gst_amount: bill.gst_amount }, body.certified_amount)) {
          fail('EXCEEDS_CLAIM',
            `The certified amount cannot exceed the bill's value of ${(Number(bill.gross_value) + Number(bill.gst_amount ?? 0)).toFixed(2)} including GST`);
        }
        const from = bill.status as RaBillStatus;
        const allowed = RA_BILL_TRANSITIONS[from] ?? [];
        if (!allowed.includes(next)) {
          fail('INVALID_STATUS_TRANSITION',
            allowed.length ? `A bill at ${from} can move to ${allowed.join(', ')}`
                           : `${from} is a final status and cannot move again`);
        }
        if (next === 'CERTIFIED' && !u.permissions.includes('rabill.certify')) {
          fail('FORBIDDEN', 'Certifying a bill needs the rabill.certify permission', 403);
        }
        if (next === 'CANCELLED' && !body.reason) {
          fail('VALIDATION_ERROR', 'Record why the bill is being cancelled');
        }

        if (next === 'CERTIFIED') {
          // Retention moves into the ledger and advances are drawn down here,
          // in the same transaction as certification.
          const retention = (await db.query(
            "SELECT amount FROM ra_bill_deductions WHERE ra_bill_id=$1 AND head='RETENTION'", [id])).rows[0];
          if (retention) {
            await db.query(
              `INSERT INTO retention_ledger(org_id, created_by, project_id, ra_bill_id, entry_type, amount)
               VALUES($1,$2,$3,$4,'WITHHELD',$5)`,
              [u.orgId, u.id, bill.project_id, id, retention.amount]);
          }
          const advanceLines = (await db.query(
            'SELECT advance_id, amount FROM ra_bill_deductions WHERE ra_bill_id=$1 AND advance_id IS NOT NULL', [id])).rows;
          for (const line of advanceLines) {
            await db.query(
              `UPDATE project_advances
               SET recovered_amount = recovered_amount + $2,
                   status = CASE WHEN recovered_amount + $2 >= amount THEN 'RECOVERED' ELSE status END,
                   version = version + 1, updated_at = now(), updated_by = $3
               WHERE id = $1`, [line.advance_id, line.amount, u.id]);
          }
        }

        // Decide the stamps in JS rather than with CASE expressions. Reusing
        // one parameter as both a uuid value and a string comparison inside a
        // CASE leaves the driver unable to infer a single type for it, which
        // is a 500 rather than a helpful error.
        const now = new Date();
        const certifying = next === 'CERTIFIED';
        // The receivable falls due on the project's agreed terms, counted
        // from the day it was certified where the organisation works. No
        // terms on file leaves it undated rather than guessed.
        let dueDate: string | null = null;
        if (certifying) {
          const ctx = (await db.query(
            `SELECT p.payment_terms_days, o.settings->>'timezone' AS tz
             FROM organizations o
             LEFT JOIN project_billing_policies p ON p.project_id = $2
             WHERE o.id = $1`, [u.orgId, bill.project_id])).rows[0];
          dueDate = receivableDueDate(
            businessDay(now, ctx?.tz || undefined),
            ctx?.payment_terms_days === null || ctx?.payment_terms_days === undefined
              ? null : Number(ctx.payment_terms_days));
        }
        return (await db.query(
          `UPDATE ra_bills SET status = $3,
             submitted_at     = COALESCE($4, submitted_at),
             certified_at     = COALESCE($5, certified_at),
             certified_by     = COALESCE($6, certified_by),
             certified_amount = COALESCE($7, certified_amount),
             paid_at          = COALESCE($8, paid_at),
             cancelled_reason = COALESCE($9, cancelled_reason),
             due_date         = COALESCE($10::date, due_date),
             version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`,
          [id, u.id, next,
           next === 'SUBMITTED' ? now : null,
           certifying ? now : null,
           certifying ? u.id : null,
           // The client may certify a different figure than claimed; absent
           // that, the claimed net stands. Taken from the locked row rather
           // than a CASE, which needed $3 to be two types at once.
           certifying ? (body.certified_amount ?? Number(bill.net_payable)) : null,
           next === 'PAID' ? now : null,
           body.reason ?? null,
           dueDate])).rows[0];
      }),
    };
  });

  /**
   * Mark a certified bill as disputed by the client, or clear it (§58.2).
   *
   * A flag, not a status: the bill a client disputes is exactly the one that
   * also goes overdue, and both have to be visible. The receivables ageing
   * reports it in its own column, because a dispute is a different problem
   * from slow payment and goes to a different person.
   */
  app.patch('/api/v1/ra-bills/:id/dispute', { preHandler: guard('rabill.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(raBillDisputeSchema, req.body);
    await projectAccess(pool, req, String((await inOrg(pool, 'ra_bills', id, u.orgId)).project_id));
    return {
      data: await mutate(pool, req, 'rabill.dispute', 'ra_bill', async db => {
        const bill = await inOrg(db, 'ra_bills', id, u.orgId, true);
        if (bill.status === 'CANCELLED') {
          fail('BILL_CANCELLED', 'A cancelled bill is not owed, so there is nothing to dispute');
        }
        return (await db.query(
          `UPDATE ra_bills SET disputed = $2, dispute_reason = $3,
             version = version + 1, updated_at = now(), updated_by = $4
           WHERE id = $1 RETURNING *`,
          [id, input.disputed, input.disputed ? input.reason : null, u.id])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------------------- retention */

  app.get('/api/v1/projects/:id/retention', { preHandler: guard('retention.read') }, async req => {
    const id = (req.params as { id: string }).id;
    await projectAccess(pool, req, id);
    const ledger = (await pool.query(
      'SELECT * FROM retention_ledger WHERE project_id = $1 ORDER BY created_at', [id])).rows;
    const held = ledger.reduce((t, e) =>
      t + (e.entry_type === 'WITHHELD' ? Number(e.amount) : -Number(e.amount)), 0);
    const policy = await policyFor(pool, id);
    const status = policy.dlpEndDate
      ? retentionReleaseStatus({
          heldAmount: held,
          dlpEndDate: String(policy.dlpEndDate).slice(0, 10),
          firstTranchePct: policy.firstTranchePct,
        })
      : { releasable: 0, withheld: held, reason: 'No defect liability period is configured for this project' };
    return { data: { ledger, held, ...status } };
  });

  app.post('/api/v1/projects/:id/retention/release', { preHandler: guard('retention.release') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = parse(retentionReleaseSchema, req.body ?? {});
    await projectAccess(pool, req, id);
    const row = await mutate(pool, req, 'retention.release', 'retention', async db => {
      await inOrg(db, 'projects', id, u.orgId, true);
      const ledger = (await db.query(
        'SELECT entry_type, amount FROM retention_ledger WHERE project_id = $1 FOR UPDATE', [id])).rows;
      const held = ledger.reduce((t, e) =>
        t + (e.entry_type === 'WITHHELD' ? Number(e.amount) : -Number(e.amount)), 0);
      if (held <= 0) fail('NOTHING_WITHHELD', 'No retention is being held on this project');

      const policy = await policyFor(db, id);
      if (!policy.dlpEndDate) {
        fail('DLP_NOT_CONFIGURED',
          'Set the defect liability period before releasing retention — §6.7 forbids release before it ends');
      }
      const status = retentionReleaseStatus({
        heldAmount: held,
        dlpEndDate: String(policy.dlpEndDate).slice(0, 10),
        firstTranchePct: policy.firstTranchePct,
      });
      if (status.releasable <= 0) fail('DLP_NOT_ENDED', status.reason);

      const amount = body.amount ?? status.releasable;
      if (amount > status.releasable) {
        fail('EXCEEDS_RELEASABLE',
          `Only ${status.releasable.toFixed(2)} may be released now. ${status.reason}`);
      }
      return (await db.query(
        `INSERT INTO retention_ledger(org_id, created_by, project_id, entry_type, amount,
           released_at, released_by, reason)
         VALUES($1,$2,$3,'RELEASED',$4,current_date,$2,$5) RETURNING *`,
        [u.orgId, u.id, id, amount, body.reason ?? null])).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  /* ------------------------------------------- billing what was measured */

  /**
   * Which BOQ lines are measured by the survey module, and how.
   *
   * Setting one up is a commercial decision — it says "this contract line is
   * paid on that field measurement" — so it sits behind the same permission
   * as the BOQ itself rather than behind survey access.
   */
  app.get('/api/v1/projects/:id/survey-boq-links',
    { preHandler: guard('boq.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await projectAccess(pool, req, id);
      await inOrg(pool, 'projects', id, u.orgId);
      return {
        data: (await pool.query(
          `SELECT l.id, l.boq_item_id, l.measure_id, l.stage_id, l.factor,
                  b.item_code, b.description, b.unit AS boq_unit, b.quantity AS boq_quantity,
                  b.rate,
                  m.code AS measure_code, m.label AS measure_label, m.unit AS measure_unit,
                  s.code AS stage_code, s.label AS stage_label
             FROM survey_boq_links l
             JOIN boq_items b ON b.id = l.boq_item_id
             JOIN survey_measures m ON m.id = l.measure_id
             LEFT JOIN survey_stages s ON s.id = l.stage_id
            WHERE l.org_id = $1 AND b.project_id = $2
            ORDER BY b.sort_order, b.item_code`,
          [u.orgId, id])).rows,
      };
    });

  /**
   * The measures and stages a BOQ line can be linked to.
   *
   * Served from here, behind boq.read, rather than sending the billing
   * screen to the survey module's own lists. Whoever sets up a link is a
   * commercial person who may hold no survey permission at all, and a
   * dropdown that renders empty because of a permission nobody mentioned is
   * worse than no dropdown.
   */
  app.get('/api/v1/projects/:id/survey-measure-options',
    { preHandler: guard('boq.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await projectAccess(pool, req, id);
      await inOrg(pool, 'projects', id, u.orgId);
      const paired = (await pool.query(
        'SELECT id, code, name FROM survey_projects WHERE project_id = $1 AND org_id = $2',
        [id, u.orgId])).rows[0];
      const [measures, stages] = await Promise.all([
        pool.query(
          `SELECT id, code, label, unit, basis FROM survey_measures
            WHERE org_id = $1 AND active ORDER BY display_order, label`, [u.orgId]),
        pool.query(
          `SELECT id, code, label FROM survey_stages
            WHERE org_id = $1 AND active ORDER BY display_order, label`, [u.orgId]),
      ]);
      return {
        data: {
          programme: paired ?? null,
          measures: measures.rows,
          stages: stages.rows,
        },
      };
    });

  app.post('/api/v1/projects/:id/survey-boq-links',
    { preHandler: guard('boq.manage') }, async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(surveyBoqLinkSchema, req.body);
      await projectAccess(pool, req, id);
      const row = await mutate(pool, req, 'survey.boq.link', 'survey_boq_link', async db => {
        const item = await inOrg(db, 'boq_items', input.boq_item_id, u.orgId);
        if (String(item.project_id) !== id) {
          fail('WRONG_PROJECT',
            'That BOQ line belongs to a different project. Open the project the line is on.',
            422);
        }
        const measure = (await db.query(
          'SELECT id, code FROM survey_measures WHERE id = $1 AND org_id = $2',
          [input.measure_id, u.orgId])).rows[0];
        if (!measure) {
          fail('UNKNOWN_MEASURE',
            'There is no such measure. Pick one from the survey measure list.', 422);
        }
        if (input.stage_id) {
          const stage = (await db.query(
            'SELECT id FROM survey_stages WHERE id = $1 AND org_id = $2',
            [input.stage_id, u.orgId])).rows[0];
          if (!stage) {
            fail('UNKNOWN_STAGE',
              'There is no such stage. Pick one from the survey pipeline.', 422);
          }
        }
        /*
         * The project has to be the one the survey programme is running
         * against, or the quantities would come from work done somewhere
         * else entirely.
         */
        const paired = (await db.query(
          'SELECT id FROM survey_projects WHERE project_id = $1 AND org_id = $2',
          [id, u.orgId])).rows[0];
        if (!paired) {
          fail('NOT_A_SURVEY_PROJECT',
            'No survey programme is running against this project, so there are no field '
            + 'measurements to bill from. Pair a programme to it first, from Land survey.',
            422);
        }
        try {
          return (await db.query(
            `INSERT INTO survey_boq_links
               (org_id, boq_item_id, measure_id, stage_id, factor, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [u.orgId, input.boq_item_id, input.measure_id,
             input.stage_id ?? null, input.factor, u.id])).rows[0];
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            fail('ALREADY_LINKED',
              'That BOQ line already draws its quantity from a measure. Remove the existing '
              + 'link first, or use a separate BOQ line for the second measure.', 409);
          }
          throw err;
        }
      });
      return reply.code(201).send({ data: row });
    });

  app.delete('/api/v1/survey-boq-links/:id',
    { preHandler: guard('boq.manage') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      return mutate(pool, req, 'survey.boq.unlink', 'survey_boq_link', async db => {
        const row = (await db.query(
          'DELETE FROM survey_boq_links WHERE id = $1 AND org_id = $2 RETURNING *',
          [id, u.orgId])).rows[0];
        if (!row) {
          fail('NOT_FOUND',
            'That link is already gone. Reload the list to see what is there now.', 404);
        }
        return row;
      });
    });

  /**
   * What the field measured, as a bill nobody has raised yet.
   *
   * Cumulative by construction, because that is what a running-account bill
   * carries: every bill states the total measured to date and the engine
   * works out this bill's share by subtracting what was certified before.
   *
   * A proposal, not a bill. A measurement book is certified by an engineer
   * who walks the ground, and software billing automatically from its own
   * records would assert something it is in no position to assert. Every
   * line is editable before anything is raised.
   */
  app.get('/api/v1/projects/:id/measured-proposal',
    { preHandler: guard('rabill.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const q = req.query as { period_to?: string };
      const periodTo = q.period_to ?? new Date().toISOString().slice(0, 10);
      if (!dateStringSchema.safeParse(periodTo).success) {
        fail('VALIDATION_ERROR',
          'Give the date to measure up to as YYYY-MM-DD, and make it a real date.', 422);
      }
      await projectAccess(pool, req, id);
      await inOrg(pool, 'projects', id, u.orgId);

      const links = (await pool.query(
        `SELECT l.id, l.boq_item_id, l.measure_id, l.stage_id, l.factor,
                b.item_code, b.description, b.unit AS boq_unit,
                b.quantity AS boq_quantity, b.rate,
                m.code AS measure_code, m.label AS measure_label, m.unit AS measure_unit,
                s.code AS stage_code, s.label AS stage_label
           FROM survey_boq_links l
           JOIN boq_items b ON b.id = l.boq_item_id AND b.status = 'ACTIVE'
           JOIN survey_measures m ON m.id = l.measure_id
           LEFT JOIN survey_stages s ON s.id = l.stage_id
          WHERE l.org_id = $1 AND b.project_id = $2
          ORDER BY b.sort_order, b.item_code`,
        [u.orgId, id])).rows;

      if (links.length === 0) {
        return {
          data: { period_to: periodTo, lines: [], has_work: false },
          message: 'No BOQ line on this project draws its quantity from a field measurement yet.',
        };
      }

      const previous = await previouslyCertified(pool, id);

      /*
       * Every line's measured total, in one pass.
       *
       * This was a query per BOQ line. A BOQ runs to tens of lines rather
       * than thousands so it was never going to fall over, but a round trip
       * per line is a shape that only gets worse, and the stage gate is the
       * one thing that differs per line — which a lateral handles without
       * giving any of it up.
       *
       * A stage is complete according to whichever source governs it, the
       * same rule resolveStage() applies everywhere else: the linked task
       * when there is one, the stage row's own columns when there is not.
       * Reading only the row would bill nothing at all for a programme whose
       * stages are run from the task board, which is most of them.
       *
       * Dates come out in UTC because that is the date the screens show —
       * a bill that disagrees with the stage date on the village page would
       * be a second thing to reconcile, which is the problem this feature
       * exists to remove.
       *
       * A village counts only once its gating stage is complete *and dated*:
       * a bill is a claim as at a date, and an undated completion cannot be
       * placed before or after it. A task dragged to Done without an end
       * time is exactly that, so those are counted separately rather than
       * dropped in silence — quietly under-billing is the worse failure, and
       * the fix is for somebody to set the date.
       */
      const measured = new Map((await pool.query(
        `SELECT l.id AS link_id,
                q.billable, q.undated_quantity, q.undated_villages
           FROM survey_boq_links l
           JOIN boq_items b ON b.id = l.boq_item_id AND b.status = 'ACTIVE'
           LEFT JOIN LATERAL (
             WITH counted AS (
               SELECT e.survey_village_id,
                      ev.quantity,
                      CASE WHEN vs.task_id IS NOT NULL
                           THEN (t.status = 'DONE')
                           ELSE (vs.state = 'COMPLETED')
                      END AS finished,
                      CASE WHEN vs.task_id IS NOT NULL
                           THEN (t.actual_end_at AT TIME ZONE 'UTC')::date
                           ELSE vs.completed_on
                      END AS finished_on
                 FROM survey_entries e
                 JOIN survey_entry_values ev
                   ON ev.entry_id = e.id AND ev.measure_id = l.measure_id
                 JOIN survey_villages sv ON sv.id = e.survey_village_id
                 JOIN survey_projects sp ON sp.id = sv.survey_project_id
                 LEFT JOIN survey_village_stages vs
                   ON vs.survey_village_id = sv.id AND vs.stage_id = l.stage_id
                 LEFT JOIN tasks t ON t.id = vs.task_id
                WHERE e.org_id = l.org_id
                  AND sp.project_id = b.project_id
                  AND e.entry_date <= $3::date
             )
             SELECT
               COALESCE(sum(quantity) FILTER (
                 WHERE l.stage_id IS NULL
                    OR (finished AND finished_on IS NOT NULL AND finished_on <= $3::date)
               ), 0) AS billable,
               COALESCE(sum(quantity) FILTER (
                 WHERE l.stage_id IS NOT NULL AND finished AND finished_on IS NULL
               ), 0) AS undated_quantity,
               count(DISTINCT survey_village_id) FILTER (
                 WHERE l.stage_id IS NOT NULL AND finished AND finished_on IS NULL
               ) AS undated_villages
             FROM counted
           ) q ON true
          WHERE l.org_id = $1 AND b.project_id = $2`,
        [u.orgId, id, periodTo])).rows.map(r => [String(r.link_id), r]));

      const lines = links.map(l => {
        const m = measured.get(String(l.id)) ?? {
          billable: 0, undated_quantity: 0, undated_villages: 0,
        };
        const computed = measuredLine({
          measuredQuantity: Number(m.billable),
          factor: Number(l.factor),
          previousQuantity: previous.get(String(l.boq_item_id))?.qty ?? 0,
          boqQuantity: Number(l.boq_quantity),
          undatedVillages: Number(m.undated_villages),
        });
        return {
          boq_item_id: l.boq_item_id,
          item_code: l.item_code,
          description: l.description,
          boq_unit: l.boq_unit,
          boq_quantity: Number(l.boq_quantity),
          rate: Number(l.rate),
          measure_code: l.measure_code,
          measure_label: l.measure_label,
          measure_unit: l.measure_unit,
          stage_code: l.stage_code,
          stage_label: l.stage_label,
          factor: Number(l.factor),
          measured_quantity: Number(m.billable),
          undated_villages: Number(m.undated_villages),
          undated_quantity: Number(m.undated_quantity),
          ...computed,
        };
      });

      return {
        data: {
          period_to: periodTo,
          lines,
          has_work: proposalHasWork(lines),
        },
      };
    });
}

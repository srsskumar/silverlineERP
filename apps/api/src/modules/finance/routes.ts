import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  paymentSchema, paymentAllocationSchema, financialPeriodSchema, periodClosureSchema,
  bankImportSchema, invoiceStatusSchema, disputeSchema,
  settlementPosition, unallocated, checkAllocation, findPeriodOverlap,
  reconcileImport, INVOICE_TRANSITIONS,
  type AllocationLine, type InvoiceLifecycle,
  businessDay,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import {
  actor, parse, page, inOrg, mutate, version, fail, projectAccess, periodsFor, guardPeriod,
} from '../../common/domain.js';

/**
 * Financial control (§45).
 *
 * Nothing here is ever deleted. A payment that turns out to be wrong is
 * reversed by a second entry that points at the first, and both stay — a
 * financial record that can vanish is one that cannot be audited.
 */
export async function registerFinanceRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  const iso = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

  // periodsFor/guardPeriod moved to common/domain.js (fix round 1, B-002
  // review): the payment-run execute route needed the identical closed-
  // period check and was a separate module, not something a closure here
  // could reach.

  /** Live allocations against a document, in the shape the pure layer wants. */
  async function allocationsFor(
    db: Pool | PoolClient, documentType: string, documentId: string,
  ): Promise<AllocationLine[]> {
    return (await db.query(
      `SELECT a.* FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id
       WHERE a.document_type = $1 AND a.document_id = $2
         AND a.reversed_at IS NULL AND p.reversed_at IS NULL`,
      [documentType, documentId])).rows.map(r => ({
      amount: Number(r.amount),
      tdsAmount: Number(r.tds_amount),
      retentionAmount: Number(r.retention_amount),
      advanceAdjusted: Number(r.advance_adjusted),
      otherDeduction: Number(r.other_deduction),
    }));
  }

  /**
   * What a document was billed at, whichever kind of document it is.
   *
   * `lock` takes the document row for the rest of the transaction. Allocating
   * reads what is outstanding and then writes against it; without the lock
   * two receipts applied to one bill at the same moment each see the whole
   * balance free and together settle it more than once.
   */
  async function documentValue(
    db: Pool | PoolClient, orgId: string, type: string, id: string, lock = false,
  ): Promise<{ invoiced: number; dueDate: string | null }> {
    const forUpdate = lock ? ' FOR UPDATE' : '';
    if (type === 'RA_BILL') {
      const row = (await db.query(
        `SELECT certified_amount, gross_value FROM ra_bills WHERE id = $1 AND org_id = $2${forUpdate}`, [id, orgId])).rows[0];
      if (!row) fail('NOT_FOUND', 'RA bill not found', 404);
      return { invoiced: Number(row.certified_amount ?? row.gross_value), dueDate: null };
    }
    if (type === 'VENDOR_INVOICE') {
      const row = (await db.query(
        `SELECT total, due_date FROM invoices WHERE id = $1 AND org_id = $2${forUpdate}`, [id, orgId])).rows[0];
      if (!row) fail('NOT_FOUND', 'Invoice not found', 404);
      return { invoiced: Number(row.total), dueDate: row.due_date ? iso(row.due_date) : null };
    }
    if (type === 'EXPENSE_CLAIM') {
      const row = (await db.query(
        `SELECT approved_amount, total_allowed FROM expense_claims WHERE id = $1 AND org_id = $2${forUpdate}`, [id, orgId])).rows[0];
      if (!row) fail('NOT_FOUND', 'Expense claim not found', 404);
      return { invoiced: Number(row.approved_amount ?? row.total_allowed), dueDate: null };
    }
    const row = (await db.query(
      `SELECT amount FROM project_advances WHERE id = $1 AND org_id = $2${forUpdate}`, [id, orgId])).rows[0];
    if (!row) fail('NOT_FOUND', 'Advance not found', 404);
    return { invoiced: Number(row.amount), dueDate: null };
  }

  /* ------------------------------------------------------------- periods */

  app.get('/api/v1/financial-periods', { preHandler: guard('period.read') }, async req => {
    const u = actor(req);
    return {
      data: (await pool.query(
        `SELECT p.*, c.username AS closed_by_username, r.username AS reopened_by_username
         FROM financial_periods p
         LEFT JOIN users c ON c.id = p.closed_by
         LEFT JOIN users r ON r.id = p.reopened_by
         WHERE p.org_id = $1 ORDER BY p.starts_on DESC`, [u.orgId])).rows,
    };
  });

  app.post('/api/v1/financial-periods', { preHandler: guard('period.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(financialPeriodSchema, req.body);
    const row = await mutate(pool, req, 'period.create', 'financial_period', async db => {
      const existing = await periodsFor(db, u.orgId);
      const clash = existing.find(p => p.code === input.code);
      if (clash) fail('DUPLICATE_PERIOD', `Period ${input.code} already exists`, 409);
      const overlap = findPeriodOverlap([
        ...existing,
        { code: input.code, startsOn: input.starts_on, endsOn: input.ends_on, status: 'OPEN' },
      ]);
      if (overlap) {
        fail('PERIOD_OVERLAP',
          `${overlap[0].code} and ${overlap[1].code} cover the same days — which period a document falls in would be a matter of luck`);
      }
      return (await db.query(
        `INSERT INTO financial_periods(org_id, created_by, code, starts_on, ends_on)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [u.orgId, u.id, input.code, input.starts_on, input.ends_on])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  app.post('/api/v1/financial-periods/:id/closure', { preHandler: guard('period.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(periodClosureSchema, req.body);
    return {
      data: await mutate(pool, req, `period.${input.action.toLowerCase()}`, 'financial_period', async db => {
        const period = await inOrg(db, 'financial_periods', id, u.orgId, true);
        version(req, period as { version: number });
        if (input.action === 'CLOSE') {
          if (period.status === 'CLOSED') fail('ALREADY_CLOSED', `${period.code} is already closed`);
          return (await db.query(
            `UPDATE financial_periods SET status='CLOSED', closed_at=now(), closed_by=$2,
               version=version+1, updated_at=now(), updated_by=$2 WHERE id=$1 RETURNING *`,
            [id, u.id])).rows[0];
        }
        if (period.status === 'OPEN') fail('ALREADY_OPEN', `${period.code} is already open`);
        return (await db.query(
          `UPDATE financial_periods SET status='OPEN', reopened_at=now(), reopened_by=$2,
             reopen_reason=$3, version=version+1, updated_at=now(), updated_by=$2
           WHERE id=$1 RETURNING *`,
          [id, u.id, input.reason])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------------------ payments */

  app.get('/api/v1/payments', { preHandler: guard('payment.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'p.org_id = $1';
    if (q.direction) { values.push(q.direction); where += ` AND p.direction = $${values.length}`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND p.project_id = $${values.length}::uuid`; }
    if (q.unallocated === 'true') {
      // Money in the bank nobody has matched yet — derived, never a status.
      where += ` AND p.reversed_at IS NULL AND p.amount > COALESCE((
        SELECT sum(a.amount + a.tds_amount + a.retention_amount + a.other_deduction)
        FROM payment_allocations a WHERE a.payment_id = p.id AND a.reversed_at IS NULL), 0)`;
    }
    const rows = (await pool.query(
      `SELECT p.*, pr.code AS project_code,
              COALESCE((SELECT sum(a.amount + a.tds_amount + a.retention_amount + a.other_deduction)
                        FROM payment_allocations a
                        WHERE a.payment_id = p.id AND a.reversed_at IS NULL), 0) AS allocated
       FROM payments p
       LEFT JOIN projects pr ON pr.id = p.project_id
       WHERE ${where} ORDER BY p.paid_on DESC, p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return {
      data: rows.slice(0, limit).map(r => ({
        ...r,
        unallocated_amount: Number(r.amount) - Number(r.allocated),
      })),
      has_more: rows.length > limit,
    };
  });

  app.get('/api/v1/payments/:id', { preHandler: guard('payment.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const payment = await inOrg(pool, 'payments', id, u.orgId);
    const allocations = (await pool.query(
      'SELECT * FROM payment_allocations WHERE payment_id = $1 ORDER BY created_at', [id])).rows;
    const live: AllocationLine[] = allocations.filter(a => !a.reversed_at).map(a => ({
      amount: Number(a.amount),
      tdsAmount: Number(a.tds_amount),
      retentionAmount: Number(a.retention_amount),
      advanceAdjusted: Number(a.advance_adjusted),
      otherDeduction: Number(a.other_deduction),
    }));
    return {
      data: {
        ...payment,
        allocations,
        unallocated_amount: unallocated(Number(payment.amount), live),
      },
    };
  });

  app.post('/api/v1/payments', { preHandler: guard('payment.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(paymentSchema, req.body);
    if (input.project_id) await projectAccess(pool, req, input.project_id);
    const row = await mutate(pool, req, 'payment.create', 'payment', async db => {
      await guardPeriod(db, req, input.paid_on);
      const clash = await db.query(
        'SELECT 1 FROM payments WHERE org_id = $1 AND payment_no = $2', [u.orgId, input.payment_no]);
      if (clash.rowCount) fail('DUPLICATE_PAYMENT_NO', `Payment ${input.payment_no} already exists`, 409);
      return (await db.query(
        `INSERT INTO payments(org_id, created_by, payment_no, direction, paid_on, amount, mode,
           reference, party_type, party_id, project_id, bank_account, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [u.orgId, u.id, input.payment_no, input.direction, input.paid_on, input.amount, input.mode,
         input.reference ?? null, input.party_type ?? null, input.party_id ?? null,
         input.project_id ?? null, input.bank_account ?? null, input.notes ?? null])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /**
   * Reverse a payment (§45.5).
   *
   * Never a delete. The original stays, a mirror entry records the undo, and
   * the allocations it carried are released so the documents they settled go
   * back to being outstanding.
   */
  app.post('/api/v1/payments/:id/reverse', { preHandler: guard('payment.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { reason?: string };
    if (!body?.reason) fail('VALIDATION_ERROR', 'Say why the payment is being reversed');
    return {
      data: await mutate(pool, req, 'payment.reverse', 'payment', async db => {
        const payment = await inOrg(db, 'payments', id, u.orgId, true);
        version(req, payment as { version: number });
        if (payment.reversed_at) fail('ALREADY_REVERSED', 'That payment is already reversed');
        await guardPeriod(db, req, iso(payment.paid_on));
        await db.query(
          'UPDATE payment_allocations SET reversed_at = now() WHERE payment_id = $1 AND reversed_at IS NULL',
          [id]);
        return (await db.query(
          `UPDATE payments SET reversed_at=now(), reversed_by=$2, reversal_reason=$3,
             version=version+1, updated_at=now(), updated_by=$2 WHERE id=$1 RETURNING *`,
          [id, u.id, body.reason])).rows[0];
      }),
    };
  });

  /* --------------------------------------------------------- allocation */

  app.post('/api/v1/payments/:id/allocations', { preHandler: guard('payment.allocate') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(paymentAllocationSchema, req.body);
    const row = await mutate(pool, req, 'payment.allocate', 'payment_allocation', async db => {
      const payment = await inOrg(db, 'payments', id, u.orgId, true);
      if (payment.reversed_at) fail('PAYMENT_REVERSED', 'A reversed payment cannot be allocated');

      const already = (await db.query(
        'SELECT * FROM payment_allocations WHERE payment_id = $1 AND reversed_at IS NULL', [id]))
        .rows.map(r => ({
          amount: Number(r.amount), tdsAmount: Number(r.tds_amount),
          retentionAmount: Number(r.retention_amount), advanceAdjusted: Number(r.advance_adjusted),
          otherDeduction: Number(r.other_deduction),
        }));

      const doc = await documentValue(db, u.orgId, input.document_type, input.document_id, true);
      const position = settlementPosition({
        invoiced: doc.invoiced,
        allocations: await allocationsFor(db, input.document_type, input.document_id),
        dueDate: doc.dueDate,
      });

      const line: AllocationLine = {
        amount: input.amount,
        tdsAmount: input.tds_amount ?? 0,
        retentionAmount: input.retention_amount ?? 0,
        advanceAdjusted: input.advance_adjusted ?? 0,
        otherDeduction: input.other_deduction ?? 0,
      };
      const verdict = checkAllocation({
        paymentAmount: Number(payment.amount),
        alreadyAllocated: already,
        line,
        documentOutstanding: position.outstanding,
      });
      if (!verdict.allowed) fail(verdict.code!, verdict.reason!);

      return (await db.query(
        `INSERT INTO payment_allocations(org_id, created_by, payment_id, document_type, document_id,
           amount, tds_amount, retention_amount, advance_adjusted, other_deduction, deduction_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [u.orgId, u.id, id, input.document_type, input.document_id, input.amount,
         input.tds_amount ?? 0, input.retention_amount ?? 0, input.advance_adjusted ?? 0,
         input.other_deduction ?? 0, input.deduction_reason ?? null])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /** Where a document stands: billed, settled, still owed, and whether late. */
  app.get('/api/v1/documents/:type/:id/settlement', { preHandler: guard('payment.read') }, async req => {
    const u = actor(req);
    const { type, id } = req.params as { type: string; id: string };
    const documentType = type.toUpperCase().replace(/-/g, '_');
    if (!['RA_BILL', 'VENDOR_INVOICE', 'EXPENSE_CLAIM', 'ADVANCE'].includes(documentType)) {
      fail('VALIDATION_ERROR', 'Unknown document type');
    }
    const doc = await documentValue(pool, u.orgId, documentType, id);
    const position = settlementPosition({
      invoiced: doc.invoiced,
      allocations: await allocationsFor(pool, documentType, id),
      dueDate: doc.dueDate,
    });
    const payments = (await pool.query(
      `SELECT p.id, p.payment_no, p.paid_on, p.mode, p.reference,
              a.amount, a.tds_amount, a.retention_amount, a.advance_adjusted, a.other_deduction
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       WHERE a.document_type = $1 AND a.document_id = $2
         AND a.reversed_at IS NULL AND p.reversed_at IS NULL
       ORDER BY p.paid_on`, [documentType, id])).rows;
    return { data: { document_type: documentType, document_id: id, ...position, payments } };
  });

  /* ------------------------------------------------------ bank statement */

  app.get('/api/v1/bank-transactions', { preHandler: guard('bank.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND reconciliation_status = $${values.length}`; }
    if (q.bank_account) { values.push(q.bank_account); where += ` AND bank_account = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT * FROM bank_transactions WHERE ${where}
       ORDER BY value_date DESC, created_at DESC, id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  /**
   * Import a statement (§45.4).
   *
   * A line already reconciled by a person is never silently overwritten. If
   * the feed now disagrees with what they confirmed, the line is flagged as an
   * exception for them to look at — the feed does not get to decide that it
   * was right and they were wrong.
   */
  app.post('/api/v1/bank-transactions/import', { preHandler: guard('bank.reconcile') }, async req => {
    const u = actor(req), input = parse(bankImportSchema, req.body);
    return {
      data: await mutate(pool, req, 'bank.import', 'bank_transaction', async db => {
        const summary = { applied: 0, created: 0, skipped: 0, exceptions: 0 };
        const flagged: Array<{ statement_ref: string; note: string }> = [];
        for (const t of input.transactions) {
          const account = t.bank_account ?? input.bank_account ?? null;
          const existing = (await db.query(
            `SELECT * FROM bank_transactions
             WHERE org_id = $1 AND COALESCE(bank_account,'') = COALESCE($2,'') AND statement_ref = $3
             FOR UPDATE`, [u.orgId, account, t.statement_ref])).rows[0];

          const verdict = reconcileImport(
            existing ? {
              amount: Number(existing.amount),
              state: existing.reconciliation_status,
              reconciledAt: existing.reconciled_at,
            } : null,
            { amount: t.amount },
          );

          if (verdict.action === 'SKIP_RECONCILED') { summary.skipped += 1; continue; }
          if (verdict.action === 'FLAG_EXCEPTION') {
            await db.query(
              `UPDATE bank_transactions SET reconciliation_status='EXCEPTION', exception_note=$2,
                 version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1`,
              [existing.id, verdict.note, u.id]);
            summary.exceptions += 1;
            flagged.push({ statement_ref: t.statement_ref, note: verdict.note! });
            continue;
          }
          if (existing) {
            await db.query(
              `UPDATE bank_transactions SET amount=$2, value_date=$3, narration=$4,
                 version=version+1, updated_at=now(), updated_by=$5 WHERE id=$1`,
              [existing.id, t.amount, t.value_date, t.narration ?? null, u.id]);
            summary.applied += 1;
          } else {
            await db.query(
              `INSERT INTO bank_transactions(org_id, created_by, bank_account, statement_ref,
                 value_date, amount, narration)
               VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [u.orgId, u.id, account, t.statement_ref, t.value_date, t.amount, t.narration ?? null]);
            summary.created += 1;
          }
        }
        return { ...summary, flagged };
      }),
    };
  });

  /** A person confirms a statement line against a payment. */
  app.post('/api/v1/bank-transactions/:id/reconcile', { preHandler: guard('bank.reconcile') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { payment_id?: string; note?: string };
    return {
      data: await mutate(pool, req, 'bank.reconcile', 'bank_transaction', async db => {
        const line = await inOrg(db, 'bank_transactions', id, u.orgId, true);
        version(req, line as { version: number });
        if (!body?.payment_id) {
          fail('VALIDATION_ERROR', 'Name the payment this statement line settles');
        }
        const payment = await inOrg(db, 'payments', body.payment_id, u.orgId);
        if (payment.reversed_at) fail('PAYMENT_REVERSED', 'That payment has been reversed');
        // The statement is the bank's record and the payment is ours; if they
        // disagree the difference is the point, so it is reported rather than
        // rounded away.
        const matched = Math.abs(Number(line.amount) - Number(payment.amount)) <= 0.005;
        const status = matched ? 'RECONCILED' : 'PARTIALLY_MATCHED';
        // Decided here rather than in a CASE inside the statement: reusing one
        // parameter in two type contexts makes PostgreSQL deduce a type for it
        // and then reject the other use.
        return (await db.query(
          `UPDATE bank_transactions SET payment_id=$2, reconciliation_status=$3,
             reconciled_at=$4, reconciled_by=$5, exception_note=$6,
             version=version+1, updated_at=now(), updated_by=$7
           WHERE id=$1 RETURNING *`,
          [id, body.payment_id, status,
           matched ? new Date() : null,
           matched ? u.id : null,
           matched ? null
             : `Statement says ${line.amount}; the payment records ${payment.amount}`,
           u.id])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------- invoice lifecycle */

  app.post('/api/v1/invoices/:id/status', { preHandler: guard('invoice.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(invoiceStatusSchema, req.body);
    return {
      data: await mutate(pool, req, 'invoice.status', 'invoice', async db => {
        const invoice = await inOrg(db, 'invoices', id, u.orgId, true);
        const from = String(invoice.lifecycle_status ?? 'ISSUED') as InvoiceLifecycle;
        if (!(INVOICE_TRANSITIONS[from] ?? []).includes(input.status)) {
          fail('INVALID_TRANSITION',
            `An invoice cannot go from ${from.toLowerCase()} to ${input.status.toLowerCase()}`);
        }
        // Issuing is the act that puts a document number in front of a client
        // and into a tax return, so it is kept behind its own permission.
        if (input.status === 'ISSUED' && !u.permissions.includes('invoice.issue')) {
          fail('FORBIDDEN', 'Issuing an invoice needs the invoice.issue permission', 403);
        }
        if (input.status === 'CANCELLED' && !input.reason) {
          fail('VALIDATION_ERROR', 'Say why the invoice is being cancelled');
        }
        return (await db.query(
          `UPDATE invoices SET lifecycle_status=$2, cancelled_reason=$3 WHERE id=$1 RETURNING *`,
          [id, input.status, input.status === 'CANCELLED' ? input.reason : invoice.cancelled_reason]))
          .rows[0];
      }),
    };
  });

  app.post('/api/v1/invoices/:id/dispute', { preHandler: guard('invoice.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(disputeSchema, req.body);
    return {
      data: await mutate(pool, req, 'invoice.dispute', 'invoice', async db => {
        await inOrg(db, 'invoices', id, u.orgId, true);
        // A flag, not a status: the invoice a client disputes is exactly the
        // one that also goes overdue, and both facts have to be visible.
        return (await db.query(
          'UPDATE invoices SET disputed=$2, dispute_reason=$3 WHERE id=$1 RETURNING *',
          [id, input.disputed, input.disputed ? input.reason : null])).rows[0];
      }),
    };
  });

  /**
   * The receivables and payables ledger (§15.2).
   *
   * Ages what is outstanding rather than what was billed: an invoice paid on
   * time has no place in an ageing report, and a disputed one belongs in its
   * own column rather than silently inflating the oldest bucket.
   */
  app.get('/api/v1/finance/outstanding', { preHandler: guard('payment.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const asOf = String(q.as_of ?? businessDay());
    const rows = (await pool.query(
      `SELECT i.id, i.serial_number, i.total, i.due_date, i.disputed, i.lifecycle_status,
              v.name AS vendor_name,
              COALESCE((SELECT sum(a.amount + a.tds_amount + a.advance_adjusted)
                        FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                        WHERE a.document_type='VENDOR_INVOICE' AND a.document_id = i.id
                          AND a.reversed_at IS NULL AND p.reversed_at IS NULL), 0) AS settled
       FROM invoices i
       LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE i.org_id = $1 AND i.lifecycle_status <> 'CANCELLED'`, [u.orgId])).rows;

    const buckets = { current: 0, d30: 0, d60: 0, d90: 0, older: 0, disputed: 0 };
    const items = rows.map(r => {
      const position = settlementPosition({
        invoiced: Number(r.total),
        allocations: [{ amount: Number(r.settled) }],
        dueDate: r.due_date ? iso(r.due_date) : null,
        asOf,
      });
      if (position.outstanding > 0.005) {
        if (r.disputed) buckets.disputed += position.outstanding;
        else if (!position.overdue) buckets.current += position.outstanding;
        else if (position.daysOverdue <= 30) buckets.d30 += position.outstanding;
        else if (position.daysOverdue <= 60) buckets.d60 += position.outstanding;
        else if (position.daysOverdue <= 90) buckets.d90 += position.outstanding;
        else buckets.older += position.outstanding;
      }
      return {
        id: r.id, serial_number: r.serial_number, vendor_name: r.vendor_name,
        lifecycle_status: r.lifecycle_status, disputed: r.disputed,
        due_date: r.due_date, ...position,
      };
    }).filter(i => i.outstanding > 0.005);

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      data: {
        as_of: asOf,
        buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, round(v)])),
        total: round(items.reduce((t, i) => t + i.outstanding, 0)),
        items: items.sort((a, b) => b.daysOverdue - a.daysOverdue),
      },
    };
  });
}

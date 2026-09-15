import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  paymentRunSchema, runDecisionSchema, payableHoldSchema,
  ageOutstanding, payableDue, msmeInterestOn, creditExposure, daysSalesOutstanding,
  selectForRun, settlementPosition, PAYMENT_RUN_TRANSITIONS,
  type PayableCandidate, type PaymentRunState, type AgeingItem,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';

/**
 * Accounts payable and receivable (§58).
 *
 * Both ledgers answer an operational question rather than an accounting one:
 * who owes us and how late, and whom must we pay this week by law.
 */
export async function registerLedgerRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);
  const today = () => new Date().toISOString().slice(0, 10);
  const iso = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null;

  async function bankRate(db: Pool | PoolClient, orgId: string): Promise<number> {
    const row = (await db.query(
      'SELECT rbi_bank_rate_pct FROM organizations WHERE id = $1', [orgId])).rows[0];
    return Number(row?.rbi_bank_rate_pct ?? 6.5);
  }

  /** Settled amount against a document, from live allocations only. */
  const SETTLED = `COALESCE((SELECT sum(a.amount + a.tds_amount + a.advance_adjusted)
     FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
     WHERE a.document_type = $DOCTYPE AND a.document_id = $DOCID
       AND a.reversed_at IS NULL AND p.reversed_at IS NULL), 0)`;

  /* ------------------------------------------------------- receivables */

  /**
   * What clients owe (§58.2).
   *
   * Retention is reported apart from the buckets: it is owed but not
   * collectable until the defect liability period ends, and ageing it sends
   * the collections team after money the client is entitled to hold.
   */
  app.get('/api/v1/ar/ageing', { preHandler: guard('ar.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const asOf = String(q.as_of ?? today());

    const rows = (await pool.query(
      `SELECT b.id, b.bill_no, b.bill_type, b.due_date, b.certified_at,
              COALESCE(b.certified_amount, b.gross_value) AS billed,
              p.id AS project_id, p.code AS project_code, p.name AS project_name,
              c.id AS client_id, c.name AS client_name, c.credit_limit,
              ${SETTLED.replace('$DOCTYPE', "'RA_BILL'").replace('$DOCID', 'b.id')} AS settled,
              COALESCE((SELECT sum(CASE WHEN r.entry_type='WITHHELD' THEN r.amount ELSE -r.amount END)
                        FROM retention_ledger r WHERE r.project_id = p.id), 0) AS retention_held
       FROM ra_bills b
       JOIN projects p ON p.id = b.project_id
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE b.org_id = $1 AND b.status IN ('CERTIFIED','PAID')`, [u.orgId])).rows;

    const byClient = new Map<string, { name: string; creditLimit: number | null; items: AgeingItem[]; rows: unknown[] }>();
    const seenProjects = new Set<string>();

    for (const r of rows) {
      const billed = Number(r.billed);
      const outstanding = Math.round((billed - Number(r.settled)) * 100) / 100;
      const key = r.client_id ? String(r.client_id) : 'UNASSIGNED';
      if (!byClient.has(key)) {
        byClient.set(key, {
          name: r.client_name ?? 'No client recorded',
          creditLimit: r.credit_limit === null ? null : Number(r.credit_limit),
          items: [], rows: [],
        });
      }
      const bucket = byClient.get(key)!;
      // Retention is held per project, not per bill; counting it once per bill
      // would multiply it by the number of bills raised.
      const retention = seenProjects.has(String(r.project_id)) ? 0 : Number(r.retention_held);
      seenProjects.add(String(r.project_id));
      bucket.items.push({ outstanding, dueDate: iso(r.due_date), retention });
      if (outstanding > 0.005 || retention > 0.005) {
        bucket.rows.push({
          bill_id: r.id, bill_no: r.bill_no, bill_type: r.bill_type,
          project_code: r.project_code, project_name: r.project_name,
          billed, settled: Number(r.settled), outstanding,
          retention, due_date: iso(r.due_date), certified_at: r.certified_at,
        });
      }
    }

    const clients = [...byClient.entries()].map(([clientId, v]) => {
      const ageing = ageOutstanding(v.items, asOf);
      return {
        client_id: clientId === 'UNASSIGNED' ? null : clientId,
        client_name: v.name,
        ...ageing,
        credit: creditExposure({ limit: v.creditLimit, outstanding: ageing.total }),
        bills: v.rows,
      };
    }).filter(c => c.total > 0.005).sort((a, b) => b.overdue - a.overdue);

    const overall = ageOutstanding(
      [...byClient.values()].flatMap(v => v.items), asOf);

    // DSO over the window asked for, defaulting to a quarter. Reported with
    // the period, because the same receivable gives a wildly different figure
    // over a month and over a year.
    const periodDays = Math.max(1, Number(q.period_days) || 90);
    const sales = (await pool.query(
      `SELECT COALESCE(sum(COALESCE(certified_amount, gross_value)), 0) AS total
       FROM ra_bills WHERE org_id = $1 AND status IN ('CERTIFIED','PAID')
         AND certified_at >= $2::date - $3::int`, [u.orgId, asOf, periodDays])).rows[0];

    return {
      data: {
        as_of: asOf,
        ...overall,
        ...daysSalesOutstanding({
          outstanding: overall.total - overall.retention,
          creditSales: Number(sales.total), periodDays,
        }),
        clients,
      },
    };
  });

  /** Opening balance, movements and closing balance for one client (§58.2.5). */
  app.get('/api/v1/ar/statement/:clientId', { preHandler: guard('ar.read') }, async req => {
    const u = actor(req), { clientId } = req.params as { clientId: string };
    const { q } = page(req);
    const from = String(q.from ?? '1900-01-01');
    const to = String(q.to ?? today());
    const client = await inOrg(pool, 'clients', clientId, u.orgId);

    const bills = (await pool.query(
      `SELECT b.id, b.bill_no, b.certified_at::date AS on_date, b.due_date,
              COALESCE(b.certified_amount, b.gross_value) AS amount, p.code AS project_code
       FROM ra_bills b JOIN projects p ON p.id = b.project_id
       WHERE b.org_id = $1 AND p.client_id = $2 AND b.status IN ('CERTIFIED','PAID')
       ORDER BY b.certified_at`, [u.orgId, clientId])).rows;

    const receipts = (await pool.query(
      `SELECT p.id, p.payment_no, p.paid_on AS on_date, p.mode, p.reference,
              a.amount + a.tds_amount + a.advance_adjusted AS amount
       FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id
       JOIN ra_bills b ON b.id = a.document_id
       JOIN projects pr ON pr.id = b.project_id
       WHERE a.document_type = 'RA_BILL' AND pr.client_id = $1
         AND a.reversed_at IS NULL AND p.reversed_at IS NULL
       ORDER BY p.paid_on`, [clientId])).rows;

    const entries = [
      ...bills.map(b => ({ ...b, kind: 'BILL' as const, debit: Number(b.amount), credit: 0 })),
      ...receipts.map(r => ({ ...r, kind: 'RECEIPT' as const, debit: 0, credit: Number(r.amount) })),
    ].sort((a, b) => (iso(a.on_date)! < iso(b.on_date)! ? -1 : 1));

    // The opening balance is everything before the window; without it the
    // statement does not reconcile to the ledger, which is exactly what it is
    // sent to a client to do.
    let running = 0, opening = 0;
    const inPeriod: unknown[] = [];
    for (const e of entries) {
      const date = iso(e.on_date)!;
      running += e.debit - e.credit;
      if (date < from) { opening = running; continue; }
      if (date > to) continue;
      inPeriod.push({ ...e, balance: Math.round(running * 100) / 100 });
    }

    return {
      data: {
        client: { id: client.id, name: client.name, code: client.code },
        from, to,
        opening_balance: Math.round(opening * 100) / 100,
        closing_balance: Math.round(running * 100) / 100,
        entries: inPeriod,
      },
    };
  });

  /* ---------------------------------------------------------- payables */

  /** Everything this organisation owes, on the date the law actually fixes. */
  async function payableRows(db: Pool | PoolClient, orgId: string, asOf: string) {
    const rate = await bankRate(db, orgId);
    const rows = (await db.query(
      `SELECT i.id, i.serial_number, i.total, i.due_date, i.accepted_on, i.invoice_date,
              i.disputed, i.on_hold, i.hold_reason, i.match_status, i.lifecycle_status,
              v.id AS vendor_id, v.name AS vendor_name,
              v.udyam_number, v.msme_category, v.has_written_agreement,
              ${SETTLED.replace('$DOCTYPE', "'VENDOR_INVOICE'").replace('$DOCID', 'i.id')} AS settled
       FROM invoices i
       LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE i.org_id = $1 AND i.lifecycle_status <> 'CANCELLED'`, [orgId])).rows;

    return rows.map(r => {
      const outstanding = Math.round((Number(r.total) - Number(r.settled)) * 100) / 100;
      const due = payableDue({
        party: {
          udyamNumber: r.udyam_number, msmeCategory: r.msme_category,
          hasWrittenAgreement: r.has_written_agreement,
        },
        acceptanceDate: iso(r.accepted_on) ?? iso(r.invoice_date),
        contractualDueDate: iso(r.due_date),
        asOf,
      });
      return {
        row: r, outstanding, due,
        interest: msmeInterestOn({ due, outstanding, asOf, bankRatePct: rate }),
      };
    });
  }

  app.get('/api/v1/ap/ageing', { preHandler: guard('ap.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const asOf = String(q.as_of ?? today());
    const rows = await payableRows(pool, u.orgId, asOf);

    const byVendor = new Map<string, { name: string; items: AgeingItem[]; rows: unknown[]; interest: number }>();
    for (const { row: r, outstanding, due, interest } of rows) {
      if (outstanding <= 0.005) continue;
      const key = r.vendor_id ? String(r.vendor_id) : 'UNASSIGNED';
      if (!byVendor.has(key)) {
        byVendor.set(key, { name: r.vendor_name ?? 'No vendor recorded', items: [], rows: [], interest: 0 });
      }
      const bucket = byVendor.get(key)!;
      // Aged on the effective date — the statutory one where it governs — so
      // an MSME invoice at 40 days shows as nearly overdue rather than sitting
      // comfortably inside a 60-day bucket.
      bucket.items.push({
        outstanding, dueDate: due.effectiveDueDate,
        disputed: r.disputed, onHold: r.on_hold,
      });
      bucket.interest += interest;
      bucket.rows.push({
        invoice_id: r.id, serial_number: r.serial_number,
        total: Number(r.total), settled: Number(r.settled), outstanding,
        contractual_due_date: due.contractualDueDate,
        statutory_due_date: due.statutoryDueDate,
        effective_due_date: due.effectiveDueDate,
        is_msme: due.isMsme, days_overdue: due.daysOverdue,
        accrued_interest: interest,
        disputed: r.disputed, on_hold: r.on_hold, hold_reason: r.hold_reason,
        match_status: r.match_status,
      });
    }

    const vendors = [...byVendor.entries()].map(([vendorId, v]) => ({
      vendor_id: vendorId === 'UNASSIGNED' ? null : vendorId,
      vendor_name: v.name,
      ...ageOutstanding(v.items, asOf),
      accrued_interest: Math.round(v.interest * 100) / 100,
      invoices: v.rows,
    })).sort((a, b) => b.overdue - a.overdue);

    const overall = ageOutstanding([...byVendor.values()].flatMap(v => v.items), asOf);
    return {
      data: {
        as_of: asOf,
        ...overall,
        // A real liability whether or not anybody recorded it, and not
        // deductible for income tax.
        msme_accrued_interest: Math.round(
          rows.reduce((t, r) => t + r.interest, 0) * 100) / 100,
        msme_outstanding: Math.round(
          rows.filter(r => r.due.isMsme).reduce((t, r) => t + Math.max(0, r.outstanding), 0) * 100) / 100,
        vendors,
      },
    };
  });

  /** Put a payable on hold, or release it (§58.3.5). */
  app.post('/api/v1/ap/invoices/:id/hold', { preHandler: guard('payable.hold') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(payableHoldSchema, req.body);
    return {
      data: await mutate(pool, req, 'payable.hold', 'invoice', async db => {
        await inOrg(db, 'invoices', id, u.orgId, true);
        return (await db.query(
          'UPDATE invoices SET on_hold = $2, hold_reason = $3 WHERE id = $1 RETURNING *',
          [id, input.on_hold, input.on_hold ? input.reason : null])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------------- payment run */

  app.get('/api/v1/payment-runs', { preHandler: guard('paymentrun.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'r.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND r.status = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT r.*, a.username AS approved_by_username,
              (SELECT count(*)::int FROM payment_run_lines l WHERE l.run_id = r.id) AS line_count
       FROM payment_runs r LEFT JOIN users a ON a.id = r.approved_by
       WHERE ${where} ORDER BY r.run_date DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.get('/api/v1/payment-runs/:id', { preHandler: guard('paymentrun.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const run = await inOrg(pool, 'payment_runs', id, u.orgId);
    const lines = (await pool.query(
      `SELECT l.*, i.serial_number, v.name AS vendor_name
       FROM payment_run_lines l
       LEFT JOIN invoices i ON i.id = l.document_id
       LEFT JOIN vendors v ON v.id = l.party_id
       WHERE l.run_id = $1 ORDER BY l.statutory_due_date NULLS LAST, l.contractual_due_date`, [id])).rows;
    return {
      data: { ...run, lines, allowed_statuses: PAYMENT_RUN_TRANSITIONS[run.status as PaymentRunState] ?? [] },
    };
  });

  /**
   * Build a run (§58.3.4).
   *
   * Refuses a disputed invoice, one whose three-way match has not passed, and
   * one on hold. Orders statutory obligations first: those accrue interest and
   * must be disclosed, where paying a non-MSME supplier late costs goodwill and
   * nothing else.
   */
  app.post('/api/v1/payment-runs', { preHandler: guard('paymentrun.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(paymentRunSchema, req.body);
    const row = await mutate(pool, req, 'paymentrun.create', 'payment_run', async db => {
      const clash = await db.query(
        'SELECT 1 FROM payment_runs WHERE org_id = $1 AND run_no = $2', [u.orgId, input.run_no]);
      if (clash.rowCount) fail('DUPLICATE_RUN_NO', `Run ${input.run_no} already exists`, 409);

      const rows = await payableRows(db, u.orgId, input.due_through);
      const candidates: PayableCandidate[] = rows.map(r => ({
        documentId: String(r.row.id),
        outstanding: r.outstanding,
        due: r.due,
        disputed: Boolean(r.row.disputed),
        onHold: Boolean(r.row.on_hold),
        matchStatus: r.row.match_status,
      }));
      const selection = selectForRun(candidates, {
        asOf: input.due_through,
        hasMatchOverride: u.permissions.includes('match.override'),
        includeNotYetDue: input.include_not_yet_due,
      });

      const run = (await db.query(
        `INSERT INTO payment_runs(org_id, created_by, run_no, run_date, due_through,
           bank_account, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.run_no, input.run_date, input.due_through,
         input.bank_account ?? null, input.notes ?? null])).rows[0];

      const byId = new Map(rows.map(r => [String(r.row.id), r]));
      let total = 0;
      for (const c of selection.included) {
        const source = byId.get(c.documentId)!;
        total += c.outstanding;
        await db.query(
          `INSERT INTO payment_run_lines(org_id, run_id, document_type, document_id, party_id,
             amount, contractual_due_date, statutory_due_date, is_msme, accrued_interest)
           VALUES($1,$2,'VENDOR_INVOICE',$3,$4,$5,$6,$7,$8,$9)`,
          [u.orgId, run.id, c.documentId, source.row.vendor_id, c.outstanding,
           c.due.contractualDueDate, c.due.statutoryDueDate, c.due.isMsme, source.interest]);
      }
      const updated = (await db.query(
        'UPDATE payment_runs SET total_amount = $2 WHERE id = $1 RETURNING *',
        [run.id, Math.round(total * 100) / 100])).rows[0];
      return { ...updated, excluded: selection.excluded };
    });
    reply.code(201);
    return { data: row };
  });

  app.post('/api/v1/payment-runs/:id/decision', { preHandler: guard('paymentrun.approve') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(runDecisionSchema, req.body);
    return {
      data: await mutate(pool, req, `paymentrun.${input.action.toLowerCase()}`, 'payment_run', async db => {
        const run = await inOrg(db, 'payment_runs', id, u.orgId, true);
        version(req, run as { version: number });
        const to = input.action === 'APPROVE' ? 'APPROVED' : 'CANCELLED';
        if (!(PAYMENT_RUN_TRANSITIONS[run.status as PaymentRunState] ?? []).includes(to as PaymentRunState)) {
          fail('INVALID_TRANSITION',
            `A ${String(run.status).toLowerCase()} run cannot be ${input.action.toLowerCase()}d`);
        }
        if (input.action === 'APPROVE' && String(run.created_by) === u.id) {
          // Building a batch and releasing it single-handed is how a payment
          // to an unintended account leaves the building.
          fail('SELF_APPROVAL', 'The person who built a run cannot also release it', 403);
        }
        if (input.action === 'CANCEL') {
          return (await db.query(
            `UPDATE payment_runs SET status='CANCELLED', cancelled_reason=$2, version=version+1,
               updated_at=now(), updated_by=$3 WHERE id=$1 RETURNING *`,
            [id, input.reason, u.id])).rows[0];
        }
        return (await db.query(
          `UPDATE payment_runs SET status='APPROVED', approved_at=now(), approved_by=$2,
             version=version+1, updated_at=now(), updated_by=$2 WHERE id=$1 RETURNING *`,
          [id, u.id])).rows[0];
      }),
    };
  });
}

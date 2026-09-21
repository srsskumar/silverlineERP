import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  paymentRunSchema, runDecisionSchema, payableHoldSchema,
  ageOutstanding, payableDue, msmeInterestOn, creditExposure, daysSalesOutstanding,
  selectForRun, matchAllowsPayment, PAYMENT_RUN_TRANSITIONS,
  type PayableCandidate, type PaymentRunState, type AgeingItem,
  businessDay,
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
  // The calendar day where the work happens, not in UTC. For the first
  // five and a half hours of every Indian day, UTC is still yesterday.
  const today = () => businessDay();
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

  /**
   * The calendar day a timestamp fell on where the organisation works.
   * Certification is stamped with the instant; the ledgers talk in days, and
   * for five and a half hours of every Indian day UTC is still yesterday.
   */
  const localDay = (column: string, orgColumn: string) =>
    `(${column} AT TIME ZONE COALESCE((SELECT o.settings->>'timezone' FROM organizations o
       WHERE o.id = ${orgColumn}), 'Asia/Kolkata'))::date`;

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

    // Everything as it stood at the end of as_of: bills certified by then,
    // receipts dated by then, retention entries made by then. Reading today's
    // ledger under last quarter's date reports a position that never existed
    // -- later bills inflate it and later receipts shrink it.
    const rows = (await pool.query(
      `SELECT b.id, b.bill_no, b.bill_type, b.due_date, b.certified_at,
              b.disputed, b.dispute_reason,
              COALESCE(b.certified_amount, b.gross_value) AS billed,
              p.id AS project_id, p.code AS project_code, p.name AS project_name,
              c.id AS client_id, c.name AS client_name, c.credit_limit,
              COALESCE((SELECT sum(a.amount + a.tds_amount + a.advance_adjusted)
                 FROM payment_allocations a JOIN payments pm ON pm.id = a.payment_id
                 WHERE a.document_type = 'RA_BILL' AND a.document_id = b.id
                   AND a.reversed_at IS NULL AND pm.reversed_at IS NULL
                   AND pm.paid_on <= $2::date), 0) AS settled,
              COALESCE((SELECT sum(CASE WHEN r.entry_type='WITHHELD' THEN r.amount ELSE -r.amount END)
                        FROM retention_ledger r WHERE r.project_id = p.id
                          AND ${localDay('r.created_at', 'r.org_id')} <= $2::date), 0) AS retention_held
       FROM ra_bills b
       JOIN projects p ON p.id = b.project_id
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE b.org_id = $1 AND b.status IN ('CERTIFIED','PAID')
         AND ${localDay('b.certified_at', 'b.org_id')} <= $2::date`, [u.orgId, asOf])).rows;

    const byClient = new Map<string, { name: string; creditLimit: number | null; items: AgeingItem[]; rows: unknown[] }>();
    const seenProjects = new Set<string>();

    for (const r of rows) {
      const billed = Number(r.billed);
      // In paise, so a bill settled to the rupee does not linger as dust.
      const outstanding = (Math.round(billed * 100) - Math.round(Number(r.settled) * 100)) / 100;
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
      bucket.items.push({ outstanding, dueDate: iso(r.due_date), retention, disputed: Boolean(r.disputed) });
      if (outstanding > 0.005 || retention > 0.005) {
        bucket.rows.push({
          bill_id: r.id, bill_no: r.bill_no, bill_type: r.bill_type,
          project_code: r.project_code, project_name: r.project_name,
          billed, settled: Number(r.settled), outstanding,
          retention, due_date: iso(r.due_date), certified_at: r.certified_at,
          disputed: Boolean(r.disputed), dispute_reason: r.dispute_reason ?? null,
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
       FROM ra_bills b WHERE b.org_id = $1 AND b.status IN ('CERTIFIED','PAID')
         AND ${localDay('b.certified_at', 'b.org_id')} >= $2::date - $3::int
         AND ${localDay('b.certified_at', 'b.org_id')} <= $2::date`, [u.orgId, asOf, periodDays])).rows[0];

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
      `SELECT b.id, b.bill_no, ${localDay('b.certified_at', 'b.org_id')} AS on_date, b.due_date,
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
       WHERE a.document_type = 'RA_BILL' AND pr.client_id = $1 AND b.org_id = $2
         -- Only receipts against bills that are on the statement. A receipt
         -- still allocated to a bill since cancelled would otherwise credit
         -- the client for a debit the statement never shows.
         AND b.status IN ('CERTIFIED','PAID')
         AND a.reversed_at IS NULL AND p.reversed_at IS NULL
       ORDER BY p.paid_on`, [clientId, u.orgId])).rows;

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
      // Nothing after the window counts, not even towards the closing
      // balance: a statement to 30 June that closes on today's figure does
      // not reconcile to anything the client can check.
      if (date > to) continue;
      running += e.debit - e.credit;
      if (date < from) { opening = running; continue; }
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

  /**
   * Everything this organisation owes, on the date the law actually fixes.
   *
   * `lockIds` locks those invoices for the rest of the transaction before
   * reading them, so a hold, a dispute or an allocation landing in between
   * cannot slip past a check made on the figures read here.
   */
  async function payableRows(
    db: Pool | PoolClient, orgId: string, asOf: string,
    opts: { lockIds?: string[]; excludeRunId?: string } = {},
  ) {
    const rate = await bankRate(db, orgId);
    if (opts.lockIds) {
      if (!opts.lockIds.length) return [];
      // Locked in a separate statement: FOR UPDATE cannot sit on a query
      // with aggregates in it, and ordering by id keeps two approvals that
      // share invoices from deadlocking on each other.
      await db.query(
        'SELECT id FROM invoices WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [orgId, opts.lockIds]);
    }
    const values: unknown[] = [orgId, opts.excludeRunId ?? null];
    let where = "i.org_id = $1 AND i.lifecycle_status <> 'CANCELLED'";
    if (opts.lockIds) { values.push(opts.lockIds); where += ` AND i.id = ANY($${values.length}::uuid[])`; }
    const rows = (await db.query(
      `SELECT i.id, i.serial_number, i.total, i.due_date, i.accepted_on, i.invoice_date,
              i.disputed, i.on_hold, i.hold_reason, i.match_status, i.lifecycle_status,
              i.purchase_order_id,
              v.id AS vendor_id, v.name AS vendor_name,
              v.udyam_number, v.msme_category, v.has_written_agreement,
              ${SETTLED.replace('$DOCTYPE', "'VENDOR_INVOICE'").replace('$DOCID', 'i.id')} AS settled,
              (SELECT r.run_no FROM payment_run_lines l JOIN payment_runs r ON r.id = l.run_id
                WHERE l.document_type = 'VENDOR_INVOICE' AND l.document_id = i.id
                  AND r.status IN ('DRAFT','APPROVED')
                  AND r.id IS DISTINCT FROM $2::uuid
                LIMIT 1) AS open_run_no
       FROM invoices i
       LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE ${where}`, values)).rows;

    return rows.map(r => {
      // Summed in paise. Subtracting rupee floats leaves a paisa of dust that
      // makes a settled invoice look outstanding.
      const outstanding = (Math.round(Number(r.total) * 100) - Math.round(Number(r.settled) * 100)) / 100;
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

  /** The shape selectForRun wants, from a payable row. */
  const candidateOf = (r: Awaited<ReturnType<typeof payableRows>>[number]): PayableCandidate => ({
    documentId: String(r.row.id),
    outstanding: r.outstanding,
    due: r.due,
    disputed: Boolean(r.row.disputed),
    onHold: Boolean(r.row.on_hold),
    matchStatus: r.row.match_status,
    hasPurchaseOrder: Boolean(r.row.purchase_order_id),
    openRunNo: r.row.open_run_no ?? null,
  });

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
        has_purchase_order: Boolean(r.purchase_order_id),
        open_run_no: r.open_run_no ?? null,
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
    const hasMatchOverride = u.permissions.includes('match.override');
    if (input.match_overrides.length && !hasMatchOverride) {
      fail('FORBIDDEN',
        'Paying an invoice whose three-way match failed needs the match.override permission', 403);
    }
    const matchOverrides = Object.fromEntries(
      input.match_overrides.map(o => [o.document_id, o.reason]));
    const row = await mutate(pool, req, 'paymentrun.create', 'payment_run', async db => {
      // One run is built at a time per organisation. Two built side by side
      // would each see the other's invoices as free and both take them; the
      // unique index on open lines would refuse the second, but as a bare
      // conflict rather than a run that simply leaves them out.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('payment-run:' || $1, 0))", [u.orgId]);
      const clash = await db.query(
        'SELECT 1 FROM payment_runs WHERE org_id = $1 AND run_no = $2', [u.orgId, input.run_no]);
      if (clash.rowCount) fail('DUPLICATE_RUN_NO', `Run ${input.run_no} already exists`, 409);

      const rows = await payableRows(db, u.orgId, input.due_through);
      const selection = selectForRun(rows.map(candidateOf), {
        asOf: input.due_through,
        hasMatchOverride,
        matchOverrides,
        includeNotYetDue: input.include_not_yet_due,
      });

      const run = (await db.query(
        `INSERT INTO payment_runs(org_id, created_by, run_no, run_date, due_through,
           bank_account, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.run_no, input.run_date, input.due_through,
         input.bank_account ?? null, input.notes ?? null])).rows[0];

      const byId = new Map(rows.map(r => [String(r.row.id), r]));
      let totalPaise = 0;
      for (const c of selection.included) {
        const source = byId.get(c.documentId)!;
        totalPaise += Math.round(c.outstanding * 100);
        await db.query(
          `INSERT INTO payment_run_lines(org_id, run_id, document_type, document_id, party_id,
             amount, contractual_due_date, statutory_due_date, is_msme, accrued_interest,
             match_override_reason)
           VALUES($1,$2,'VENDOR_INVOICE',$3,$4,$5,$6,$7,$8,$9,$10)`,
          [u.orgId, run.id, c.documentId, source.row.vendor_id, c.outstanding,
           c.due.contractualDueDate, c.due.statutoryDueDate, c.due.isMsme, source.interest,
           c.overrideReason ?? null]);
      }
      const updated = (await db.query(
        'UPDATE payment_runs SET total_amount = $2 WHERE id = $1 RETURNING *',
        [run.id, totalPaise / 100])).rows[0];
      return { ...updated, excluded: selection.excluded };
    });
    reply.code(201);
    return { data: row };
  });

  /**
   * Why each line of a run can no longer be paid as built, if any.
   *
   * A run is built on one day and released on another. In between an
   * invoice can be put on hold, disputed, cancelled, part-paid by hand or
   * re-matched and failed, and approving the run as it stood would pay it
   * anyway. So every line is checked again, against rows locked for the rest
   * of the approval.
   */
  async function staleLines(db: PoolClient, orgId: string, run: Record<string, any>) {
    const lines = (await db.query(
      'SELECT * FROM payment_run_lines WHERE run_id = $1 ORDER BY document_id', [run.id])).rows;
    const invoiceLines = lines.filter(l => l.document_type === 'VENDOR_INVOICE');
    const current = new Map((await payableRows(db, orgId, iso(run.due_through)!, {
      lockIds: invoiceLines.map(l => String(l.document_id)),
      excludeRunId: String(run.id),
    })).map(r => [String(r.row.id), r]));

    const problems: Array<{ document_id: string; code: string; reason: string }> = [];
    for (const line of invoiceLines) {
      const id = String(line.document_id);
      const now = current.get(id);
      if (!now) {
        problems.push({ document_id: id, code: 'CANCELLED', reason: 'An invoice on the run has been cancelled' });
        continue;
      }
      const label = String(now.row.serial_number ?? id);
      const candidate = candidateOf(now);
      if (candidate.openRunNo) {
        problems.push({ document_id: id, code: 'IN_OPEN_RUN', reason: `${label} is also on run ${candidate.openRunNo}` });
      } else if (candidate.disputed) {
        problems.push({ document_id: id, code: 'DISPUTED', reason: `${label} is now under dispute` });
      } else if (candidate.onHold) {
        problems.push({ document_id: id, code: 'ON_HOLD', reason: `${label} has been put on hold` });
      } else if (!matchAllowsPayment(candidate) && !line.match_override_reason) {
        problems.push({ document_id: id, code: 'NOT_MATCHED', reason: `${label} no longer passes the three-way match` });
      } else if (Math.round(now.outstanding * 100) < Math.round(Number(line.amount) * 100)) {
        // Part-settled since the run was built: paying the line as it stands
        // would pay more than is owed.
        problems.push({
          document_id: id, code: 'SETTLED',
          reason: `${label} now has ${now.outstanding.toFixed(2)} outstanding, less than the ${Number(line.amount).toFixed(2)} on the run`,
        });
      }
    }
    return problems;
  }

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
        if (input.action === 'APPROVE') {
          const problems = await staleLines(db, u.orgId, run);
          if (problems.length) {
            // Refused whole rather than trimmed: the approver is signing for
            // the batch they were shown, and a run that silently shrinks on
            // approval is not that batch. Cancel it and build a fresh one.
            fail('RUN_OUT_OF_DATE',
              `This run no longer matches the ledger: ${problems.map(p => p.reason).join('; ')}. Cancel it and build a new one.`,
              409);
          }
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

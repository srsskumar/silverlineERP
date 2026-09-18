import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  costHeadSchema, budgetSchema, costAdjustmentSchema, budgetPosition, profitability,
  expensePolicySchema, expenseClaimSchema, claimDecisionSchema, reimbursementSchema,
  evaluateClaim, policyFor, receiptFingerprint, softDuplicateKey, canApproveClaim,
  canTransition, reimbursementPosition, EXPENSE_CLAIM_TRANSITIONS,
  type ExpenseClaimStatus, type ExpensePolicy, type ExpenseCategory, type ExpenseLineInput,
  businessDay,
  apportionRun, payrollCostPostSchema, payrollCostReverseSchema,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail, projectAccess } from '../../common/domain.js';
import { submitForApproval } from '../../common/approvalRouting.js';

/**
 * Expense management and project cost control (§15.6, §16).
 *
 * The two ship together because §16.4 — a billable expense reaching the
 * project's actual cost — has nowhere to land without the cost ledger.
 *
 * Cost reaches a project only when a claim is approved. A submitted claim
 * moves nothing, because a project manager reading cost that might still be
 * rejected is reading a number that is not yet true. An approval that is later
 * reversed posts a reversing entry rather than deleting the original.
 */
export async function registerExpenseRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  // The calendar day where the work happens, not in UTC. For the first
  // five and a half hours of every Indian day, UTC is still yesterday.
  const today = () => businessDay();

  /** The organisation's expense policies, in the shape the evaluator wants. */
  async function policiesFor(db: Pool | PoolClient, orgId: string): Promise<ExpensePolicy[]> {
    return (await db.query(
      'SELECT * FROM expense_policies WHERE org_id = $1', [orgId])).rows.map(r => ({
      id: String(r.id),
      category: r.category as ExpenseCategory,
      effectiveFrom: r.effective_from instanceof Date
        ? r.effective_from.toISOString().slice(0, 10) : String(r.effective_from),
      effectiveTo: r.effective_to === null ? null
        : (r.effective_to instanceof Date ? r.effective_to.toISOString().slice(0, 10) : String(r.effective_to)),
      perLineLimit: r.per_line_limit === null ? null : Number(r.per_line_limit),
      perClaimLimit: r.per_claim_limit === null ? null : Number(r.per_claim_limit),
      unitRate: r.unit_rate === null ? null : Number(r.unit_rate),
      requiresReceiptAbove: r.requires_receipt_above === null ? null : Number(r.requires_receipt_above),
      appliesToGrade: r.applies_to_grade,
    }));
  }

  /**
   * The states the organisation holds a GST registration in.
   *
   * Needed to decide whether a hotel bill from another state carries credit
   * this company can actually take.
   */
  async function registeredStates(db: Pool | PoolClient, orgId: string): Promise<string[]> {
    const rows = (await db.query(
      `SELECT DISTINCT state_code AS state FROM party_gst_registrations
       WHERE org_id = $1 AND party_type = 'ORGANIZATION' AND status = 'ACTIVE'`, [orgId])).rows;
    return rows.map(r => String(r.state));
  }

  /** A claim's lines in evaluator shape, so policy is applied identically everywhere. */
  function toLineInputs(rows: Record<string, any>[]): ExpenseLineInput[] {
    return rows.map(r => ({
      category: r.category as ExpenseCategory,
      expenseDate: r.expense_date instanceof Date
        ? r.expense_date.toISOString().slice(0, 10) : String(r.expense_date),
      amount: Number(r.amount),
      units: r.units === null || r.units === undefined ? null : Number(r.units),
      hasReceipt: Boolean(r.receipt_document_id),
      vendorGstin: r.vendor_gstin,
      invoiceNo: r.invoice_no,
      gstAmount: r.gst_amount === null || r.gst_amount === undefined ? null : Number(r.gst_amount),
      supplyStateCode: r.supply_state_code,
      billableToClient: Boolean(r.billable_to_client),
    }));
  }

  /** Claims this actor is allowed to see, as a SQL fragment. */
  function visibility(u: ReturnType<typeof actor>, values: unknown[]): string {
    if (u.permissions.includes('expense.read_all')) return '';
    values.push(u.id);
    return ` AND (c.claimant_user_id = $${values.length} OR c.requested_by = $${values.length})`;
  }

  /* -------------------------------------------------------------- cost heads */

  app.get('/api/v1/cost-heads', { preHandler: guard('costhead.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'org_id = $1';
    if (q.kind) { values.push(q.kind); where += ` AND kind = $${values.length}`; }
    if (q.active !== undefined) { values.push(q.active === 'true'); where += ` AND active = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT * FROM cost_heads WHERE ${where} ORDER BY kind, code LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.post('/api/v1/cost-heads', { preHandler: guard('costhead.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(costHeadSchema, req.body);
    const row = await mutate(pool, req, 'costhead.create', 'cost_head', async db => {
      const clash = await db.query(
        'SELECT 1 FROM cost_heads WHERE org_id = $1 AND code = $2', [u.orgId, input.code]);
      if (clash.rowCount) fail('DUPLICATE_COST_HEAD', `Cost head ${input.code} already exists`, 409);
      return (await db.query(
        `INSERT INTO cost_heads(org_id, created_by, code, name, kind, description, active)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.code, input.name, input.kind, input.description ?? null, input.active])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  app.patch('/api/v1/cost-heads/:id', { preHandler: guard('costhead.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(costHeadSchema.partial(), req.body);
    return {
      data: await mutate(pool, req, 'costhead.update', 'cost_head', async db => {
        const head = await inOrg(db, 'cost_heads', id, u.orgId, true);
        version(req, head as { version: number });
        // Retiring a head must not orphan the entries already posted to it,
        // so deactivation is the only way out — never deletion.
        return (await db.query(
          `UPDATE cost_heads SET name = COALESCE($2, name), kind = COALESCE($3, kind),
             description = COALESCE($4, description), active = COALESCE($5, active),
             version = version + 1, updated_at = now(), updated_by = $6
           WHERE id = $1 RETURNING *`,
          [id, input.name ?? null, input.kind ?? null, input.description ?? null,
           input.active ?? null, u.id])).rows[0];
      }),
    };
  });

  /* ---------------------------------------------------------- project budget */

  app.get('/api/v1/projects/:id/budget', { preHandler: guard('budget.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await projectAccess(pool, req, id);
    const rows = (await pool.query(
      `SELECT b.*, h.code AS cost_head_code, h.name AS cost_head_name, h.kind
       FROM project_budgets b JOIN cost_heads h ON h.id = b.cost_head_id
       WHERE b.org_id = $1 AND b.project_id = $2 AND b.superseded_at IS NULL
       ORDER BY h.kind, h.code`, [u.orgId, id])).rows;
    return { data: rows };
  });

  app.put('/api/v1/projects/:id/budget', { preHandler: guard('budget.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await projectAccess(pool, req, id);
    const input = parse(budgetSchema, req.body);
    return {
      data: await mutate(pool, req, 'budget.revise', 'project_budget', async db => {
        const heads = new Set(input.lines.map(l => l.cost_head_id));
        if (heads.size !== input.lines.length) {
          fail('DUPLICATE_COST_HEAD', 'The same cost head appears twice in one budget');
        }
        for (const headId of heads) {
          const head = await inOrg(db, 'cost_heads', headId, u.orgId);
          if (!head.active) fail('COST_HEAD_INACTIVE', `Cost head ${head.code} is retired`);
        }
        const prior = (await db.query(
          `SELECT max(revision) AS revision FROM project_budgets
           WHERE project_id = $1`, [id])).rows[0];
        const revision = Number(prior?.revision ?? 0) + 1;
        if (revision > 1 && !input.revision_reason) {
          // A budget that moves without a reason is the single hardest thing
          // to explain to an auditor six months later.
          fail('REVISION_REASON_REQUIRED', 'Say why the budget is being revised');
        }
        await db.query(
          `UPDATE project_budgets SET superseded_at = now()
           WHERE project_id = $1 AND superseded_at IS NULL`, [id]);
        const written = [];
        for (const line of input.lines) {
          written.push((await db.query(
            `INSERT INTO project_budgets(org_id, created_by, project_id, cost_head_id,
               budgeted_amount, revision, revision_reason, notes)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [u.orgId, u.id, id, line.cost_head_id, line.budgeted_amount, revision,
             input.revision_reason ?? null, line.notes ?? null])).rows[0]);
        }
        return { id, revision, lines: written };
      }),
    };
  });

  /* ------------------------------------------------------------ cost position */

  app.get('/api/v1/projects/:id/cost-position', { preHandler: guard('cost.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await projectAccess(pool, req, id);
    const project = await inOrg(pool, 'projects', id, u.orgId);

    const budgets = (await pool.query(
      `SELECT cost_head_id, budgeted_amount FROM project_budgets
       WHERE org_id = $1 AND project_id = $2 AND superseded_at IS NULL`, [u.orgId, id])).rows;
    const entries = (await pool.query(
      `SELECT cost_head_id, amount, nature, reversal_of FROM project_cost_entries
       WHERE org_id = $1 AND project_id = $2`, [u.orgId, id])).rows;
    const heads = (await pool.query(
      'SELECT id, code, name, kind FROM cost_heads WHERE org_id = $1', [u.orgId])).rows;
    const headById = new Map(heads.map(h => [String(h.id), h]));

    const position = budgetPosition(
      budgets.map(b => ({ costHeadId: String(b.cost_head_id), budgetedAmount: Number(b.budgeted_amount) })),
      entries.map(e => ({
        costHeadId: String(e.cost_head_id), amount: Number(e.amount),
        nature: e.nature as 'COMMITTED' | 'ACTUAL', reversalOf: e.reversal_of,
      })));

    // A project with no awarded value reports cost without a margin rather
    // than a margin against zero.
    const contractValue = Number(project.contract_value ?? 0);
    return {
      data: {
        project_id: id,
        heads: position.heads.map(h => ({ ...h, cost_head: headById.get(h.costHeadId) ?? null })),
        totals: position.totals,
        profitability: profitability({
          contractValue,
          actualCost: position.totals.actual,
          committedCost: position.totals.committed,
        }),
      },
    };
  });

  app.get('/api/v1/projects/:id/cost-entries', { preHandler: guard('cost.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const { limit, offset, q } = page(req);
    await projectAccess(pool, req, id);
    const values: unknown[] = [u.orgId, id, limit + 1, offset];
    let where = 'e.org_id = $1 AND e.project_id = $2';
    if (q.cost_head_id) { values.push(q.cost_head_id); where += ` AND e.cost_head_id = $${values.length}::uuid`; }
    if (q.source_type) { values.push(q.source_type); where += ` AND e.source_type = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT e.*, h.code AS cost_head_code, h.name AS cost_head_name
       FROM project_cost_entries e JOIN cost_heads h ON h.id = e.cost_head_id
       WHERE ${where} ORDER BY e.entry_date DESC, e.created_at DESC LIMIT $3 OFFSET $4`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.post('/api/v1/cost-entries', { preHandler: guard('cost.adjust') }, async (req, reply) => {
    const u = actor(req), input = parse(costAdjustmentSchema, req.body);
    await projectAccess(pool, req, input.project_id);
    const row = await mutate(pool, req, 'cost.adjust', 'project_cost_entry', async db => {
      await inOrg(db, 'cost_heads', input.cost_head_id, u.orgId);
      return (await db.query(
        `INSERT INTO project_cost_entries(org_id, created_by, project_id, cost_head_id,
           nature, source_type, entry_date, amount, narration)
         VALUES($1,$2,$3,$4,'ACTUAL','MANUAL',$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.project_id, input.cost_head_id,
         input.entry_date, input.amount, input.narration])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /* -------------------------------------------------------- expense policies */

  app.get('/api/v1/expense-policies', { preHandler: guard('expense.policy.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const values: unknown[] = [u.orgId];
    let where = 'org_id = $1';
    if (q.category) { values.push(q.category); where += ` AND category = $${values.length}`; }
    if (q.on_date) {
      values.push(q.on_date);
      where += ` AND effective_from <= $${values.length}::date AND (effective_to IS NULL OR effective_to >= $${values.length}::date)`;
    }
    return {
      data: (await pool.query(
        `SELECT * FROM expense_policies WHERE ${where}
         ORDER BY category, effective_from DESC`, values)).rows,
    };
  });

  app.post('/api/v1/expense-policies', { preHandler: guard('expense.policy.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(expensePolicySchema, req.body);
    const row = await mutate(pool, req, 'expense.policy.create', 'expense_policy', async db => {
      // Superseding the standing policy is the normal way to change a limit:
      // the old one stays, closed the day before the new one starts, so a
      // claim for last month is still measured against last month's rule.
      const standing = (await db.query(
        `SELECT * FROM expense_policies
         WHERE org_id = $1 AND category = $2 AND effective_to IS NULL
           AND COALESCE(applies_to_grade,'') = COALESCE($3,'')
         FOR UPDATE`,
        [u.orgId, input.category, input.applies_to_grade ?? null])).rows[0];
      if (standing && !input.effective_to) {
        const from = String(input.effective_from);
        const standingFrom = standing.effective_from instanceof Date
          ? standing.effective_from.toISOString().slice(0, 10) : String(standing.effective_from);
        if (from <= standingFrom) {
          fail('POLICY_OVERLAP',
            `The standing ${input.category} policy already starts on ${standingFrom}. A replacement has to start later.`);
        }
        // Computed here rather than in SQL: a date expression reused in two
        // type contexts inside one statement makes PostgreSQL guess wrongly.
        const closeOn = new Date(`${from}T00:00:00Z`);
        closeOn.setUTCDate(closeOn.getUTCDate() - 1);
        await db.query(
          `UPDATE expense_policies SET effective_to = $2, version = version + 1,
             updated_at = now(), updated_by = $3 WHERE id = $1`,
          [standing.id, closeOn.toISOString().slice(0, 10), u.id]);
      }
      return (await db.query(
        `INSERT INTO expense_policies(org_id, created_by, category, effective_from, effective_to,
           per_line_limit, per_claim_limit, unit_rate, requires_receipt_above, applies_to_grade, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [u.orgId, u.id, input.category, input.effective_from, input.effective_to ?? null,
         input.per_line_limit ?? null, input.per_claim_limit ?? null, input.unit_rate ?? null,
         input.requires_receipt_above ?? null, input.applies_to_grade ?? null,
         input.notes ?? null])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /* ----------------------------------------------------------------- claims */

  app.get('/api/v1/expense-claims', { preHandler: guard('expense.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'c.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND c.status = $${values.length}`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND c.project_id = $${values.length}::uuid`; }
    if (q.policy_exception === 'true') where += ' AND c.policy_exception';
    where += visibility(u, values);
    const rows = (await pool.query(
      `SELECT c.*, u.username AS claimant_username, p.code AS project_code,
              (SELECT COALESCE(sum(amount),0) FROM expense_reimbursements r WHERE r.claim_id = c.id) AS reimbursed_amount
       FROM expense_claims c
       LEFT JOIN users u ON u.id = c.claimant_user_id
       LEFT JOIN projects p ON p.id = c.project_id
       WHERE ${where} ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.get('/api/v1/expense-claims/:id', { preHandler: guard('expense.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const claim = await inOrg(pool, 'expense_claims', id, u.orgId);
    if (!u.permissions.includes('expense.read_all') &&
        String(claim.claimant_user_id) !== u.id && String(claim.requested_by) !== u.id) {
      fail('FORBIDDEN', 'This claim belongs to someone else', 403);
    }
    const lines = (await pool.query(
      'SELECT * FROM expense_lines WHERE claim_id = $1 ORDER BY line_no', [id])).rows;
    const payments = (await pool.query(
      'SELECT * FROM expense_reimbursements WHERE claim_id = $1 ORDER BY paid_on', [id])).rows;
    const approval = claim.approval_id
      ? (await pool.query('SELECT * FROM approval_instances WHERE id = $1', [claim.approval_id])).rows[0]
      : null;
    // The override is only meaningful with a name against it (§16.5).
    const overrideBy = claim.override_by
      ? (await pool.query('SELECT username FROM users WHERE id = $1', [claim.override_by])).rows[0]
      : null;
    return {
      data: {
        ...claim, lines, reimbursements: payments, approval,
        override_by_username: overrideBy?.username ?? null,
        reimbursement: reimbursementPosition(
          Number(claim.approved_amount ?? claim.total_allowed), payments.map(p => ({ amount: Number(p.amount) }))),
        allowed_statuses: EXPENSE_CLAIM_TRANSITIONS[claim.status as ExpenseClaimStatus] ?? [],
      },
    };
  });

  app.post('/api/v1/expense-claims', { preHandler: guard('expense.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(expenseClaimSchema, req.body);
    const row = await mutate(pool, req, 'expense.claim.create', 'expense_claim', async db => {
      const clash = await db.query(
        'SELECT 1 FROM expense_claims WHERE org_id = $1 AND claim_no = $2', [u.orgId, input.claim_no]);
      if (clash.rowCount) fail('DUPLICATE_CLAIM_NO', `Claim ${input.claim_no} already exists`, 409);

      // Whose expense it is. Keying a claim in for somebody else is ordinary —
      // a site clerk does it daily — but the claimant has to be recorded, or
      // maker-checker later tests the wrong person.
      let claimantUserId = u.id;
      let employeeId = input.employee_id ?? null;
      if (employeeId) {
        await inOrg(db, 'employees', employeeId, u.orgId);
        // The sign-in account is linked from the user side; an employee with
        // no account (most field staff) keeps the raiser as claimant, which is
        // correct — there is nobody else for maker-checker to exclude.
        const account = (await db.query(
          'SELECT id FROM users WHERE org_id = $1 AND employee_id = $2 LIMIT 1',
          [u.orgId, employeeId])).rows[0];
        claimantUserId = account ? String(account.id) : u.id;
      } else {
        const own = (await db.query('SELECT employee_id FROM users WHERE id = $1', [u.id])).rows[0];
        employeeId = own?.employee_id ? String(own.employee_id) : null;
      }
      if (input.project_id) await inOrg(db, 'projects', input.project_id, u.orgId);
      if (input.cost_head_id) await inOrg(db, 'cost_heads', input.cost_head_id, u.orgId);

      const claim = (await db.query(
        `INSERT INTO expense_claims(org_id, created_by, claim_no, employee_id, claimant_user_id,
           requested_by, project_id, cost_head_id, claim_date, purpose, status)
         VALUES($1,$2,$3,$4,$5,$2,$6,$7,$8,$9,'DRAFT') RETURNING *`,
        [u.orgId, u.id, input.claim_no, employeeId, claimantUserId,
         input.project_id ?? null, input.cost_head_id ?? null, input.claim_date, input.purpose])).rows[0];

      await writeLines(db, u, claim, input.lines);
      return await recomputeClaim(db, u, String(claim.id));
    });
    reply.code(201);
    return { data: row };
  });

  app.put('/api/v1/expense-claims/:id/lines', { preHandler: guard('expense.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(expenseClaimSchema.innerType().pick({ lines: true }), req.body);
    return {
      data: await mutate(pool, req, 'expense.claim.lines', 'expense_claim', async db => {
        const claim = await inOrg(db, 'expense_claims', id, u.orgId, true);
        version(req, claim as { version: number });
        if (claim.status !== 'DRAFT' && claim.status !== 'REJECTED') {
          fail('CLAIM_NOT_EDITABLE',
            `A ${String(claim.status).toLowerCase()} claim cannot be edited. Withdraw it, or raise a new one.`);
        }
        if (String(claim.requested_by) !== u.id && String(claim.claimant_user_id) !== u.id
            && !u.permissions.includes('expense.read_all')) {
          fail('FORBIDDEN', 'This claim belongs to someone else', 403);
        }
        // Fingerprints follow the lines they belong to, so replacing the lines
        // must release the bills they claimed.
        await db.query('DELETE FROM expense_receipt_fingerprints WHERE claim_id = $1', [id]);
        await db.query('DELETE FROM expense_lines WHERE claim_id = $1', [id]);
        await writeLines(db, u, claim, input.lines);
        return await recomputeClaim(db, u, id);
      }),
    };
  });

  /** Write the lines, refusing a bill this organisation has already paid once. */
  async function writeLines(
    db: PoolClient, u: ReturnType<typeof actor>, claim: Record<string, any>,
    lines: ReturnType<typeof expenseClaimSchema.parse>['lines'],
  ) {
    const policies = await policiesFor(db, u.orgId);
    const states = await registeredStates(db, u.orgId);
    const evaluation = evaluateClaim({
      lines: toLineInputs(lines.map(l => ({ ...l, receipt_document_id: l.receipt_document_id }))),
      policies, registeredStateCodes: states,
    });

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i], verdict = evaluation.lines[i];
      const projectId = line.project_id ?? claim.project_id ?? null;
      const inserted = (await db.query(
        `INSERT INTO expense_lines(org_id, claim_id, line_no, category, expense_date, description,
           amount, units, currency, receipt_document_id, vendor_name, vendor_gstin, invoice_no,
           gst_amount, supply_state_code, gst_creditable, credit_block_reason, billable_to_client,
           project_id, cost_head_id, allowed_amount, excess_amount, policy_exception, exception_notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING *`,
        [u.orgId, claim.id, i + 1, line.category, line.expense_date, line.description,
         line.amount, line.units ?? null, line.currency, line.receipt_document_id ?? null,
         line.vendor_name ?? null, line.vendor_gstin ?? null, line.invoice_no ?? null,
         line.gst_amount ?? null, line.supply_state_code ?? null,
         verdict.credit.creditable, verdict.credit.reason, line.billable_to_client,
         projectId, line.cost_head_id ?? claim.cost_head_id ?? null,
         verdict.allowedAmount, verdict.excessAmount, verdict.policyException,
         verdict.exceptions.length ? verdict.exceptions.join('; ') : null])).rows[0];

      const fingerprint = receiptFingerprint({
        vendorGstin: line.vendor_gstin, vendorName: line.vendor_name,
        invoiceNo: line.invoice_no, amount: line.amount,
      });
      if (fingerprint) {
        const prior = (await db.query(
          `SELECT f.claim_id, c.claim_no FROM expense_receipt_fingerprints f
           JOIN expense_claims c ON c.id = f.claim_id
           WHERE f.org_id = $1 AND f.fingerprint = $2 AND c.status <> 'WITHDRAWN'`,
          [u.orgId, fingerprint])).rows[0];
        if (prior) {
          fail('DUPLICATE_RECEIPT',
            `Bill ${line.invoice_no} for ${line.amount} was already claimed on ${prior.claim_no}`, 409);
        }
        await db.query(
          `INSERT INTO expense_receipt_fingerprints(org_id, fingerprint, line_id, claim_id)
           VALUES($1,$2,$3,$4)`, [u.orgId, fingerprint, inserted.id, claim.id]);
      }
    }
  }

  /** Re-total a claim from its lines. The header never holds a stale sum. */
  async function recomputeClaim(db: PoolClient, u: ReturnType<typeof actor>, id: string) {
    const totals = (await db.query(
      `SELECT COALESCE(sum(amount),0) AS claimed, COALESCE(sum(allowed_amount),0) AS allowed,
              COALESCE(sum(excess_amount),0) AS excess, bool_or(policy_exception) AS exception
       FROM expense_lines WHERE claim_id = $1`, [id])).rows[0];
    const claim = (await db.query(
      `UPDATE expense_claims SET total_claimed = $2, total_allowed = $3, total_excess = $4,
         policy_exception = COALESCE($5, false), version = version + 1,
         updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING *`,
      [id, totals.claimed, totals.allowed, totals.excess, totals.exception, u.id])).rows[0];
    const lines = (await db.query(
      'SELECT * FROM expense_lines WHERE claim_id = $1 ORDER BY line_no', [id])).rows;
    return { ...claim, lines };
  }

  /* ------------------------------------------------------------- submission */

  app.post('/api/v1/expense-claims/:id/submit', { preHandler: guard('expense.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    return {
      data: await mutate(pool, req, 'expense.claim.submit', 'expense_claim', async db => {
        const claim = await inOrg(db, 'expense_claims', id, u.orgId, true);
        version(req, claim as { version: number });
        if (!canTransition(claim.status as ExpenseClaimStatus, 'SUBMITTED')) {
          fail('INVALID_TRANSITION', `A ${String(claim.status).toLowerCase()} claim cannot be submitted`);
        }
        const lineCount = (await db.query(
          'SELECT count(*)::int AS n FROM expense_lines WHERE claim_id = $1', [id])).rows[0].n;
        if (!lineCount) fail('NO_LINES', 'A claim with no lines has nothing to approve');

        // The excess is submitted along with the rest. Trimming it silently
        // would hide the very thing an approver needs to decide about; the
        // ladder is drawn on what is actually being asked for.
        const amount = Number(claim.total_claimed);
        const approvalId = await submitForApproval(
          db, req, 'EXPENSE_CLAIM', id, amount, claim.project_id ?? null);
        return (await db.query(
          `UPDATE expense_claims SET status = 'SUBMITTED', approval_id = $2, submitted_at = now(),
             version = version + 1, updated_at = now(), updated_by = $3
           WHERE id = $1 RETURNING *`, [id, approvalId, u.id])).rows[0];
      }),
    };
  });

  app.post('/api/v1/expense-claims/:id/withdraw', { preHandler: guard('expense.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { reason?: string };
    if (!body?.reason) fail('VALIDATION_ERROR', 'Say why the claim is being withdrawn');
    return {
      data: await mutate(pool, req, 'expense.claim.withdraw', 'expense_claim', async db => {
        const claim = await inOrg(db, 'expense_claims', id, u.orgId, true);
        version(req, claim as { version: number });
        if (String(claim.claimant_user_id) !== u.id && String(claim.requested_by) !== u.id) {
          fail('FORBIDDEN', 'Only the claimant can withdraw a claim', 403);
        }
        if (!canTransition(claim.status as ExpenseClaimStatus, 'WITHDRAWN')) {
          fail('INVALID_TRANSITION', `A ${String(claim.status).toLowerCase()} claim cannot be withdrawn`);
        }
        if (claim.approval_id) {
          await db.query(
            `UPDATE approval_instances SET status = 'RECALLED', recalled_reason = $2,
               decided_at = now(), version = version + 1 WHERE id = $1 AND status = 'PENDING'`,
            [claim.approval_id, body.reason]);
          await db.query(
            "UPDATE approval_steps SET status = 'SKIPPED' WHERE instance_id = $1 AND status = 'PENDING'",
            [claim.approval_id]);
        }
        // The bills go back into circulation — a withdrawn claim never paid
        // for them, so a corrected claim must be able to use them again.
        await db.query('DELETE FROM expense_receipt_fingerprints WHERE claim_id = $1', [id]);
        return (await db.query(
          `UPDATE expense_claims SET status = 'WITHDRAWN', withdrawn_reason = $2, decided_at = now(),
             version = version + 1, updated_at = now(), updated_by = $3
           WHERE id = $1 RETURNING *`, [id, body.reason, u.id])).rows[0];
      }),
    };
  });

  /* --------------------------------------------------------------- decision */

  /**
   * Record the ladder's outcome on the claim.
   *
   * Guarded by `approval.act`, not by an expense permission. Every employee
   * holds `expense.read` so they can follow their own claim, and gating the
   * decision on that would let any colleague flip a claim to approved the
   * moment the ladder cleared — the authority matrix would decide nothing.
   */
  app.post('/api/v1/expense-claims/:id/decision', { preHandler: guard('approval.act') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(claimDecisionSchema, req.body);
    if (input.status !== 'APPROVED' && input.status !== 'REJECTED') {
      fail('VALIDATION_ERROR', 'A decision is either APPROVED or REJECTED');
    }
    return {
      data: await mutate(pool, req, `expense.claim.${input.status.toLowerCase()}`, 'expense_claim', async db => {
        const claim = await inOrg(db, 'expense_claims', id, u.orgId, true);
        version(req, claim as { version: number });
        if (!canTransition(claim.status as ExpenseClaimStatus, input.status as ExpenseClaimStatus)) {
          fail('INVALID_TRANSITION',
            `A ${String(claim.status).toLowerCase()} claim cannot be ${input.status.toLowerCase()}`);
        }

        // The generic engine checks the raiser. That is not enough when a
        // clerk keys in a manager's claim: the manager is the claimant, and
        // approving their own spend is precisely what maker-checker forbids.
        const check = canApproveClaim({
          approverUserId: u.id,
          requestedByUserId: String(claim.requested_by),
          claimantUserId: claim.claimant_user_id ? String(claim.claimant_user_id) : null,
        });
        if (!check.allowed) fail('SELF_APPROVAL', check.reason!, 403);

        if (input.status === 'REJECTED') {
          if (!input.reason) fail('VALIDATION_ERROR', 'Say why the claim is being rejected');
          if (claim.approval_id) {
            await db.query(
              `UPDATE approval_instances SET status = 'REJECTED', rejection_reason = $2,
                 decided_at = now(), version = version + 1 WHERE id = $1 AND status = 'PENDING'`,
              [claim.approval_id, input.reason]);
            await db.query(
              "UPDATE approval_steps SET status = 'SKIPPED' WHERE instance_id = $1 AND status = 'PENDING'",
              [claim.approval_id]);
          }
          return (await db.query(
            `UPDATE expense_claims SET status = 'REJECTED', rejection_reason = $2, decided_at = now(),
               version = version + 1, updated_at = now(), updated_by = $3
             WHERE id = $1 RETURNING *`, [id, input.reason, u.id])).rows[0];
        }

        // The ladder has to have finished. Without this, a claim is approved
        // by whoever opens it first and the authority matrix is decoration.
        if (claim.approval_id) {
          const instance = (await db.query(
            'SELECT status FROM approval_instances WHERE id = $1', [claim.approval_id])).rows[0];
          if (!instance || instance.status !== 'APPROVED') {
            fail('NOT_APPROVED',
              `The approval ladder is ${String(instance?.status ?? 'missing').toLowerCase()}. Every level has to decide before the claim is approved.`);
          }
        }

        const excess = Number(claim.total_excess);
        let approvedAmount = Number(claim.total_allowed);
        let overrideReason: string | null = null;
        if (excess > 0) {
          // Paying above policy is a decision somebody signs for by name. The
          // report at §16.5 is only possible because it is captured here and
          // not reconstructed afterwards.
          if (!u.permissions.includes('expense.override')) {
            fail('OVERRIDE_REQUIRED',
              `This claim is ${excess} above policy. Approving it needs the expense override permission.`, 403);
          }
          if (!input.override_reason) {
            fail('OVERRIDE_REASON_REQUIRED',
              `This claim is ${excess} above policy. Say why the excess is being allowed.`);
          }
          approvedAmount = Number(claim.total_claimed);
          overrideReason = input.override_reason;
        }

        const approved = (await db.query(
          `UPDATE expense_claims SET status = 'APPROVED', approved_amount = $2,
             override_reason = $3, override_by = $4, decided_at = now(),
             version = version + 1, updated_at = now(), updated_by = $5
           WHERE id = $1 RETURNING *`,
          [id, approvedAmount, overrideReason, overrideReason ? u.id : null, u.id])).rows[0];

        await postCostEntries(db, u, approved);
        return approved;
      }),
    };
  });

  /**
   * Push the billable part of an approved claim onto the project cost ledger.
   *
   * Only on approval (§16.4): cost that might still be rejected is not cost,
   * and a project manager reading it would be reading a number that is not
   * yet true. Creditable GST is excluded because it comes back; blocked GST
   * is included because it does not.
   */
  async function postCostEntries(db: PoolClient, u: ReturnType<typeof actor>, claim: Record<string, any>) {
    const rows = (await db.query(
      `SELECT project_id, cost_head_id,
              COALESCE(sum(allowed_amount - CASE WHEN gst_creditable THEN COALESCE(gst_amount,0) ELSE 0 END), 0) AS amount
       FROM expense_lines
       WHERE claim_id = $1 AND billable_to_client AND project_id IS NOT NULL
       GROUP BY project_id, cost_head_id`, [claim.id])).rows;

    for (const row of rows) {
      const amount = Number(row.amount);
      if (amount <= 0) continue;
      let headId = row.cost_head_id ? String(row.cost_head_id) : null;
      if (!headId) {
        // Every entry needs a head. An organisation that has not configured
        // one gets OTHER created for it rather than losing the cost.
        headId = await defaultCostHead(db, u);
      }
      await db.query(
        `INSERT INTO project_cost_entries(org_id, created_by, project_id, cost_head_id,
           nature, source_type, source_id, entry_date, amount, narration)
         VALUES($1,$2,$3,$4,'ACTUAL','EXPENSE_CLAIM',$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [u.orgId, u.id, row.project_id, headId, claim.id, claim.claim_date, amount,
         `Expense claim ${claim.claim_no}`]);
    }
  }

  async function defaultCostHead(db: PoolClient, u: ReturnType<typeof actor>): Promise<string> {
    const existing = (await db.query(
      "SELECT id FROM cost_heads WHERE org_id = $1 AND code = 'OTHER'", [u.orgId])).rows[0];
    if (existing) return String(existing.id);
    return String((await db.query(
      `INSERT INTO cost_heads(org_id, created_by, code, name, kind, description)
       VALUES($1,$2,'OTHER','Other','OTHER','Created automatically for uncategorised cost')
       RETURNING id`, [u.orgId, u.id])).rows[0].id);
  }

  /* ---------------------------------------------------------- reimbursement */

  app.post('/api/v1/expense-claims/:id/reimburse', { preHandler: guard('expense.reimburse') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(reimbursementSchema, req.body);
    const row = await mutate(pool, req, 'expense.claim.reimburse', 'expense_reimbursement', async db => {
      const claim = await inOrg(db, 'expense_claims', id, u.orgId, true);
      if (claim.status !== 'APPROVED') {
        fail('NOT_APPROVED',
          `A ${String(claim.status).toLowerCase()} claim cannot be paid. Only an approved claim is a payable.`);
      }
      const approved = Number(claim.approved_amount ?? claim.total_allowed);
      const paid = (await db.query(
        'SELECT COALESCE(sum(amount),0) AS paid FROM expense_reimbursements WHERE claim_id = $1', [id])).rows[0];
      const position = reimbursementPosition(approved, [{ amount: Number(paid.paid) }]);
      if (input.amount > position.outstanding) {
        fail('OVERPAYMENT',
          `Only ${position.outstanding} is outstanding on this claim; ${input.amount} would overpay it.`);
      }

      const payment = (await db.query(
        `INSERT INTO expense_reimbursements(org_id, created_by, claim_id, amount, paid_on, mode, reference, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [u.orgId, u.id, id, input.amount, input.paid_on, input.mode,
         input.reference ?? null, input.notes ?? null])).rows[0];

      // The claim only closes when the balance reaches zero. A status that has
      // to be kept in step with a running total eventually stops being true,
      // so it is derived from the payments rather than set optimistically.
      const settled = reimbursementPosition(approved, [{ amount: Number(paid.paid) + input.amount }]).settled;
      if (settled) {
        await db.query(
          `UPDATE expense_claims SET status = 'REIMBURSED', version = version + 1,
             updated_at = now(), updated_by = $2 WHERE id = $1`, [id, u.id]);
      }
      return { ...payment, claim_settled: settled };
    });
    reply.code(201);
    return { data: row };
  });

  /* --------------------------------------------------------------- reporting */

  /**
   * The five views §16.5 asks for, from one endpoint with a `group_by`.
   *
   * Aging is counted from submission, not from the expense date: an employee
   * who sat on a receipt for a month has not created an approval backlog.
   */
  app.get('/api/v1/expense-reports', { preHandler: guard('expense.read_all') }, async req => {
    const u = actor(req), { q } = page(req);
    const groupBy = String(q.group_by ?? 'employee');
    const values: unknown[] = [u.orgId];
    let where = 'c.org_id = $1';
    if (q.from) { values.push(q.from); where += ` AND c.claim_date >= $${values.length}::date`; }
    if (q.to) { values.push(q.to); where += ` AND c.claim_date <= $${values.length}::date`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND c.project_id = $${values.length}::uuid`; }

    if (groupBy === 'aging') {
      return {
        data: (await pool.query(
          `SELECT c.id, c.claim_no, c.total_claimed, c.submitted_at,
                  u.username AS claimant_username,
                  (date_part('day', now() - c.submitted_at))::int AS days_pending
           FROM expense_claims c
           LEFT JOIN users u ON u.id = c.claimant_user_id
           WHERE ${where} AND c.status = 'SUBMITTED'
           ORDER BY c.submitted_at`, values)).rows,
      };
    }

    if (groupBy === 'exception') {
      // The policy-exception report: what was approved above policy, by whom,
      // and on what stated reason.
      return {
        data: (await pool.query(
          `SELECT c.id, c.claim_no, c.total_claimed, c.total_allowed, c.total_excess,
                  c.approved_amount, c.override_reason, c.decided_at,
                  o.username AS override_by_username, u.username AS claimant_username
           FROM expense_claims c
           LEFT JOIN users o ON o.id = c.override_by
           LEFT JOIN users u ON u.id = c.claimant_user_id
           WHERE ${where} AND c.total_excess > 0 AND c.status IN ('APPROVED','REIMBURSED')
           ORDER BY c.total_excess DESC`, values)).rows,
      };
    }

    const grouping: Record<string, { select: string; join: string; group: string }> = {
      employee: {
        select: 'u.id AS key, u.username AS label',
        join: 'LEFT JOIN users u ON u.id = c.claimant_user_id', group: 'u.id, u.username',
      },
      project: {
        select: 'p.id AS key, p.code AS label',
        join: 'LEFT JOIN projects p ON p.id = c.project_id', group: 'p.id, p.code',
      },
      category: {
        select: 'l.category AS key, l.category AS label',
        join: 'JOIN expense_lines l ON l.claim_id = c.id', group: 'l.category',
      },
    };
    const shape = grouping[groupBy];
    if (!shape) {
      fail('VALIDATION_ERROR',
        `group_by must be one of employee, project, category, aging or exception`);
    }
    const amount = groupBy === 'category' ? 'l.amount' : 'c.total_claimed';
    const allowed = groupBy === 'category' ? 'l.allowed_amount' : 'c.total_allowed';
    return {
      data: (await pool.query(
        `SELECT ${shape.select},
                count(DISTINCT c.id)::int AS claims,
                COALESCE(sum(${amount}),0) AS claimed,
                COALESCE(sum(${allowed}),0) AS allowed
         FROM expense_claims c ${shape.join}
         WHERE ${where} AND c.status NOT IN ('DRAFT','WITHDRAWN')
         GROUP BY ${shape.group} ORDER BY claimed DESC`, values)).rows,
    };
  });

  /**
   * What a claim would evaluate to, without writing anything.
   *
   * Mobile quick-capture (§16.2) needs to tell a field engineer that a bill is
   * over the limit while they are still standing at the counter, not a week
   * later when finance rejects it.
   */
  app.post('/api/v1/expense-claims/evaluate', { preHandler: guard('expense.manage') }, async req => {
    const u = actor(req);
    const input = parse(expenseClaimSchema.innerType().pick({ lines: true }), req.body);
    const policies = await policiesFor(pool, u.orgId);
    const evaluation = evaluateClaim({
      lines: toLineInputs(input.lines), policies,
      registeredStateCodes: await registeredStates(pool, u.orgId),
    });
    const softKeys = input.lines.map(l => softDuplicateKey({
      employeeId: u.id, category: l.category, expenseDate: l.expense_date, amount: l.amount,
    }));
    return {
      data: {
        ...evaluation,
        policies_applied: input.lines.map(l =>
          policyFor(policies, l.category, l.expense_date)?.id ?? null),
        soft_duplicate_keys: softKeys,
        evaluated_on: today(),
      },
    };
  });

  /* -------------------------------------------- labour cost from payroll */

  /**
   * Where a payroll run's wage bill was actually earned (§note 10).
   *
   * The cost ledger only ever heard from expense claims and manual
   * adjustments, so in a survey business — where the dominant cost is crew
   * days in the field — every project's margin was revenue against almost
   * nothing.
   *
   * The days come from attendance, which records the village a crew checked
   * out of; the village belongs to a survey programme, and the programme to
   * a project. Real money apportioned by real days, rather than a daily rate
   * derived from salary_basic that would agree with nothing in the accounts.
   */
  async function labourCostOf(db: Pool | PoolClient, orgId: string, runId: string) {
    const run = await inOrg(db, 'payroll_runs', runId, orgId);

    /*
     * A day counts once, for the project it was worked on.
     *
     * The check-out names the village (§53); the check-in is the fallback for
     * a day somebody forgot to close properly. DISTINCT on the day, because
     * two events on one day are still one day of wage — otherwise a crew
     * member who moved between villages costs twice what they were paid.
     */
    const days = (await db.query(
      `SELECT ar.employee_id,
              sp.project_id,
              count(DISTINCT ar.work_date) AS days
         FROM attendance_records ar
         JOIN attendance_events ev
           ON ev.id = COALESCE(ar.check_out_event_id, ar.check_in_event_id)
         JOIN survey_villages sv ON sv.id = ev.survey_village_id
         JOIN survey_projects sp ON sp.id = sv.survey_project_id
        WHERE ar.work_date BETWEEN $1::date AND $2::date
          AND sp.org_id = $3
          AND sp.project_id IS NOT NULL
        GROUP BY ar.employee_id, sp.project_id`,
      [run.period_start, run.period_end, orgId])).rows;

    const present = (await db.query(
      `SELECT ar.employee_id, count(DISTINCT ar.work_date) AS days
         FROM attendance_records ar
         JOIN employees e ON e.id = ar.employee_id AND e.org_id = $3
        WHERE ar.work_date BETWEEN $1::date AND $2::date
        GROUP BY ar.employee_id`,
      [run.period_start, run.period_end, orgId])).rows;
    const presentBy = new Map(present.map(r => [String(r.employee_id), Number(r.days)]));

    const slips = (await db.query(
      `SELECT ps.employee_id, ps.gross
         FROM payslips ps
        WHERE ps.payroll_run_id = $1 AND ps.org_id = $2 AND ps.is_current`,
      [runId, orgId])).rows;

    const byEmployee = new Map<string, { projectId: string; days: number }[]>();
    for (const d of days) {
      const key = String(d.employee_id);
      if (!byEmployee.has(key)) byEmployee.set(key, []);
      byEmployee.get(key)!.push({ projectId: String(d.project_id), days: Number(d.days) });
    }

    const apportioned = apportionRun(slips.map(s => ({
      employeeId: String(s.employee_id),
      gross: Number(s.gross),
      totalDays: presentBy.get(String(s.employee_id)) ?? 0,
      byProject: byEmployee.get(String(s.employee_id)) ?? [],
    })));

    return { run, apportioned, payslipCount: slips.length };
  }

  /**
   * What is already on the ledger for this run, and not since reversed.
   *
   * reversed_at rather than "is anything pointing at this": the same question
   * has to be asked by the unique index that stops a double posting, and a
   * partial index cannot ask it as a subquery.
   */
  async function postedFor(db: Pool | PoolClient, orgId: string, runId: string) {
    return (await db.query(
      `SELECT e.* FROM project_cost_entries e
        WHERE e.org_id = $1 AND e.source_type = 'PAYROLL' AND e.source_id = $2
          AND e.reversal_of IS NULL AND e.reversed_at IS NULL`,
      [orgId, runId])).rows;
  }

  app.get('/api/v1/payroll-runs/:id/labour-cost',
    { preHandler: guard('cost.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { run, apportioned, payslipCount } = await labourCostOf(pool, u.orgId, id);
      const posted = await postedFor(pool, u.orgId, id);

      const names = new Map((await pool.query(
        'SELECT id, code, name FROM projects WHERE org_id = $1', [u.orgId]))
        .rows.map(r => [String(r.id), r]));

      return {
        data: {
          payroll_run: {
            id: run.id, status: run.status,
            period_start: run.period_start, period_end: run.period_end,
            total_gross: Number(run.total_gross),
          },
          payslips: payslipCount,
          /*
           * Only a locked run. A run that can still be recalculated is not a
           * cost yet, and posting one means chasing it with reversals when
           * the numbers move.
           */
          postable: run.status === 'LOCKED',
          already_posted: posted.length > 0,
          posted_total: posted.reduce((t, p) => t + Number(p.amount), 0),
          lines: apportioned.byProject.map(p => ({
            ...p,
            project: names.get(p.projectId) ?? null,
          })),
          unattributed_amount: apportioned.unattributedAmount,
          unattributed_days: apportioned.unattributedDays,
          employees_with_no_attributable_days: apportioned.employeesWithNoAttributableDays,
        },
      };
    });

  app.post('/api/v1/payroll-runs/:id/labour-cost',
    { preHandler: guard('cost.adjust') }, async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(payrollCostPostSchema, req.body);

      const out = await mutate(pool, req, 'cost.payroll.post', 'payroll_run', async db => {
        // Locks the run for the length of the transaction, so two posts of
        // the same run serialise rather than both passing the check below.
        const run = await inOrg(db, 'payroll_runs', id, u.orgId, true);
        if (run.status !== 'LOCKED') {
          fail('RUN_NOT_LOCKED',
            `This run is ${String(run.status).toLowerCase()}. Only a locked run can be posted `
            + 'to the cost ledger — anything earlier can still be recalculated, and the cost '
            + 'would have to be chased with reversals when it moved.', 422);
        }

        const existing = await postedFor(db, u.orgId, id);
        if (existing.length > 0) {
          fail('ALREADY_POSTED',
            `This run's labour cost is already on the ledger (${existing.length} `
            + 'project(s)). Reverse it first if the run has been reopened and changed.', 409);
        }

        const { apportioned } = await labourCostOf(db, u.orgId, id);
        if (apportioned.byProject.length === 0) {
          fail('NOTHING_TO_POST',
            'No day in this period was recorded against a project, so there is nothing to '
            + 'apportion. Crews record the village on their check-out, and the village is '
            + 'what ties a day to a project.', 422);
        }

        const headId = input.cost_head_id
          ? String((await inOrg(db, 'cost_heads', input.cost_head_id, u.orgId)).id)
          : await labourCostHead(db, u);

        const written = [];
        for (const line of apportioned.byProject) {
          written.push((await db.query(
            `INSERT INTO project_cost_entries(org_id, created_by, project_id, cost_head_id,
               nature, source_type, source_id, entry_date, amount, narration)
             VALUES($1,$2,$3,$4,'ACTUAL','PAYROLL',$5,$6,$7,$8) RETURNING *`,
            [u.orgId, u.id, line.projectId, headId, id, run.period_end, line.amount,
             input.narration
               ?? `Payroll ${String(run.period_start).slice(0, 10)} to `
                  + `${String(run.period_end).slice(0, 10)}: ${line.days} day(s) `
                  + `worked by ${line.employees} person(s)`])).rows[0]);
        }

        return {
          posted: written.length,
          total: written.reduce((t, w) => t + Number(w.amount), 0),
          unattributed_amount: apportioned.unattributedAmount,
          unattributed_days: apportioned.unattributedDays,
        };
      });

      return reply.code(201).send({ data: out });
    });

  app.post('/api/v1/payroll-runs/:id/labour-cost/reverse',
    { preHandler: guard('cost.adjust') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(payrollCostReverseSchema, req.body);

      return {
        data: await mutate(pool, req, 'cost.payroll.reverse', 'payroll_run', async db => {
          await inOrg(db, 'payroll_runs', id, u.orgId, true);
          const existing = await postedFor(db, u.orgId, id);
          if (existing.length === 0) {
            fail('NOT_POSTED',
              'Nothing from this run is on the ledger to reverse.', 422);
          }
          /*
           * Reversed rather than deleted. What was posted and then taken back
           * is exactly what somebody querying the cost of a month needs to
           * see; a ledger that can be tidied up is worth nothing at the
           * moment it matters.
           */
          for (const e of existing) {
            // Marked before the reversal is written, so the unique index sees
            // the slot freed and the run can be posted again afterwards.
            await db.query(
              'UPDATE project_cost_entries SET reversed_at = now() WHERE id = $1', [e.id]);
            await db.query(
              `INSERT INTO project_cost_entries(org_id, created_by, project_id, cost_head_id,
                 nature, source_type, source_id, entry_date, amount, narration, reversal_of)
               VALUES($1,$2,$3,$4,$5,'PAYROLL',$6,$7,$8,$9,$10)`,
              [u.orgId, u.id, e.project_id, e.cost_head_id, e.nature, id,
               businessDay(), -Number(e.amount),
               `Reversal: ${input.reason}`, e.id]);
          }
          return { reversed: existing.length };
        }),
      };
    });

  /**
   * The head wages go under.
   *
   * LABOUR if the organisation has one, created if not. An organisation that
   * has not set its cost heads up should still get its wage bill onto the
   * projects rather than losing it for want of configuration.
   */
  async function labourCostHead(db: PoolClient, u: ReturnType<typeof actor>): Promise<string> {
    const existing = (await db.query(
      "SELECT id FROM cost_heads WHERE org_id = $1 AND kind = 'LABOUR' AND active ORDER BY code LIMIT 1",
      [u.orgId])).rows[0];
    if (existing) return String(existing.id);
    return String((await db.query(
      `INSERT INTO cost_heads(org_id, created_by, code, name, kind, description)
       VALUES($1,$2,'LABOUR','Field labour','LABOUR',
              'Created automatically to hold wages apportioned from payroll')
       RETURNING id`, [u.orgId, u.id])).rows[0].id);
  }
}

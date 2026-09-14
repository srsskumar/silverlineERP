import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  approvalPolicySchema, approvalDecisionSchema, delegationSchema,
  resolveLadder, canAct, nextActionableStep, createsDelegationCycle, requiresReapproval,
  type ApprovalDocumentType, type ApprovalStep, type Delegation, type LadderMode,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';

/**
 * Approval engine (§41).
 *
 * Other modules submit a document here and read back whether it may proceed.
 * The decision logic lives in packages/shared/src/approvals.ts so it can be
 * tested without a database; this module owns persistence, locking and audit.
 */
export async function registerApprovalRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);
  const today = () => new Date().toISOString().slice(0, 10);

  /** Live delegations in the org, as the pure layer wants them. */
  async function delegationsFor(db: Pool | PoolClient, orgId: string): Promise<Delegation[]> {
    const rows = (await db.query(
      `SELECT from_user_id, to_user_id, valid_from, valid_to, document_types, revoked_at
       FROM approval_delegations WHERE org_id = $1 AND revoked_at IS NULL`, [orgId])).rows;
    return rows.map(r => ({
      fromUserId: String(r.from_user_id),
      toUserId: String(r.to_user_id),
      validFrom: String(r.valid_from).slice(0, 10),
      validTo: String(r.valid_to).slice(0, 10),
      documentTypes: Array.isArray(r.document_types) && r.document_types.length ? r.document_types : null,
      revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    }));
  }

  /** The policy that governs a document: project override first, then org. */
  async function policyFor(db: Pool | PoolClient, orgId: string, documentType: string, projectId?: string | null) {
    const rows = (await db.query(
      `SELECT * FROM approval_policies
       WHERE org_id = $1 AND document_type = $2 AND active
         AND (project_id = $3::uuid OR project_id IS NULL)
       ORDER BY project_id NULLS LAST LIMIT 1`, [orgId, documentType, projectId ?? null])).rows;
    return rows[0] ?? null;
  }

  async function levelsFor(db: Pool | PoolClient, policyId: string) {
    const rows = (await db.query(
      'SELECT * FROM approval_levels WHERE policy_id = $1 ORDER BY sequence', [policyId])).rows;
    return rows.map(r => ({
      sequence: Number(r.sequence),
      minAmount: Number(r.min_amount),
      maxAmount: r.max_amount === null ? null : Number(r.max_amount),
      approverRole: r.approver_role,
      approverUserId: r.approver_user_id,
      slaHours: r.sla_hours === null ? null : Number(r.sla_hours),
    }));
  }

  async function stepsFor(db: Pool | PoolClient, instanceId: string): Promise<(ApprovalStep & { id: string; slaHours: number | null; pendingSince: string | null })[]> {
    const rows = (await db.query(
      'SELECT * FROM approval_steps WHERE instance_id = $1 ORDER BY sequence', [instanceId])).rows;
    return rows.map(r => ({
      id: String(r.id),
      sequence: Number(r.sequence),
      status: r.status,
      approverRole: r.approver_role,
      approverUserId: r.approver_user_id,
      actedByUserId: r.acted_by,
      slaHours: r.sla_hours === null ? null : Number(r.sla_hours),
      pendingSince: r.pending_since ? String(r.pending_since) : null,
    }));
  }

  /* ---------------------------------------------------------------- policy */

  app.get('/api/v1/approval-policies', { preHandler: guard('approval.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'p.org_id = $1';
    if (q.document_type) { values.push(q.document_type); where += ` AND p.document_type = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT p.*, COALESCE(json_agg(l.* ORDER BY l.sequence) FILTER (WHERE l.id IS NOT NULL), '[]') AS levels
       FROM approval_policies p LEFT JOIN approval_levels l ON l.policy_id = p.id
       WHERE ${where} GROUP BY p.id ORDER BY p.document_type, p.created_at DESC
       LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.post('/api/v1/approval-policies', { preHandler: guard('approval.configure') }, async (req, reply) => {
    const u = actor(req), input = parse(approvalPolicySchema, req.body);
    const row = await mutate(pool, req, 'approval.policy.create', 'approval_policy', async db => {
      if (input.project_id) await inOrg(db, 'projects', input.project_id, u.orgId);
      // Replacing rather than stacking: two active policies for one document
      // type would make routing ambiguous, and the unique index refuses it.
      await db.query(
        `UPDATE approval_policies SET active = FALSE, version = version + 1, updated_at = now(), updated_by = $4
         WHERE org_id = $1 AND document_type = $2 AND active
           AND ($3::uuid IS NULL AND project_id IS NULL OR project_id = $3::uuid)`,
        [u.orgId, input.document_type, input.project_id ?? null, u.id]);

      const policy = (await db.query(
        `INSERT INTO approval_policies(org_id, created_by, document_type, name, mode, project_id, tolerance_pct, active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [u.orgId, u.id, input.document_type, input.name, input.mode,
         input.project_id ?? null, input.tolerance_pct, input.active])).rows[0];

      for (const level of input.levels) {
        if (level.approver_user_id) await inOrg(db, 'users', level.approver_user_id, u.orgId);
        await db.query(
          `INSERT INTO approval_levels(org_id, policy_id, sequence, min_amount, max_amount,
             approver_role, approver_user_id, sla_hours)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [u.orgId, policy.id, level.sequence, level.min_amount, level.max_amount,
           level.approver_role ?? null, level.approver_user_id ?? null, level.sla_hours ?? null]);
      }
      return { ...policy, levels: input.levels };
    });
    return reply.code(201).send({ data: row });
  });

  /* ------------------------------------------------------------- instances */

  /**
   * Submit a document for approval.
   *
   * Exposed so other modules — and integration tests — drive the same path a
   * purchase order will. The ladder is drawn here from the amount and frozen
   * onto steps, so editing the policy later cannot silently redraw a request
   * already in flight.
   */
  app.post('/api/v1/approvals', { preHandler: guard('approval.read') }, async (req, reply) => {
    const u = actor(req);
    const body = req.body as { document_type?: string; document_id?: string; amount?: number; project_id?: string | null };
    if (!body.document_type || !body.document_id || body.amount === undefined) {
      fail('VALIDATION_ERROR', 'document_type, document_id and amount are required');
    }
    const row = await mutate(pool, req, 'approval.submit', 'approval_instance', async db => {
      const policy = await policyFor(db, u.orgId, body.document_type!, body.project_id);
      if (!policy) {
        fail('NO_APPROVAL_POLICY',
          `No active approval policy covers ${body.document_type}. Configure the authority slabs before submitting.`);
      }
      const levels = await levelsFor(db, policy.id);
      const ladder = resolveLadder(levels, Number(body.amount), policy.mode as LadderMode);
      if (!ladder.length) {
        fail('NO_APPROVER',
          `The policy leaves ${body.amount} outside every authority band. Check the slabs.`);
      }

      let instance;
      try {
        instance = (await db.query(
          `INSERT INTO approval_instances(org_id, created_by, document_type, document_id, policy_id,
             project_id, amount, requested_by, current_sequence)
           VALUES($1,$2,$3,$4,$5,$6,$7,$2,$8) RETURNING *`,
          [u.orgId, u.id, body.document_type, body.document_id, policy.id,
           body.project_id ?? null, body.amount, ladder[0].sequence])).rows[0];
      } catch (error) {
        if ((error as { constraint?: string }).constraint === 'uk_ai_live_document') {
          fail('ALREADY_PENDING', 'This document is already awaiting approval', 409);
        }
        throw error;
      }

      for (const s of ladder) {
        await db.query(
          `INSERT INTO approval_steps(org_id, instance_id, sequence, approver_role, approver_user_id,
             sla_hours, pending_since)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          // Only the first step starts its SLA clock; the rest are not waiting
          // on anybody yet, and starting their clocks would report them overdue
          // for time they spent legitimately blocked.
          [u.orgId, instance.id, s.sequence, s.approverRole, s.approverUserId, s.slaHours,
           s.sequence === ladder[0].sequence ? new Date() : null]);
      }
      return { ...instance, steps: ladder };
    });
    return reply.code(201).send({ data: row });
  });

  app.get('/api/v1/approvals/:id', { preHandler: guard('approval.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const instance = await inOrg(pool, 'approval_instances', id, u.orgId);
    const steps = await stepsFor(pool, id);
    // approval.read alone means "your own requests"; approval.read_all is the
    // org-wide grant the Auditor and managers hold.
    if (String(instance.requested_by) !== u.id && !u.permissions.includes('approval.read_all')) {
      fail('FORBIDDEN', 'You can only view approvals you raised', 403);
    }
    return { data: { ...instance, steps, next_step: nextActionableStep(steps) } };
  });

  /** The acting user's queue, delegations included. */
  app.get('/api/v1/approvals/inbox', { preHandler: guard('approval.act') }, async req => {
    const u = actor(req);
    const delegations = await delegationsFor(pool, u.orgId);
    const principals = delegations
      .filter(d => d.toUserId === u.id && d.validFrom <= today() && today() <= d.validTo)
      .map(d => d.fromUserId);
    const rows = (await pool.query(
      `SELECT i.*, s.id AS step_id, s.sequence, s.approver_role, s.approver_user_id, s.pending_since, s.sla_hours
       FROM approval_steps s JOIN approval_instances i ON i.id = s.instance_id
       WHERE s.org_id = $1 AND s.status = 'PENDING' AND i.status = 'PENDING'
         AND (s.approver_role = ANY($2::text[]) OR s.approver_user_id = ANY($3::uuid[]))
         -- maker-checker: never show somebody their own request
         AND i.requested_by <> $4
       ORDER BY s.pending_since NULLS LAST, i.created_at`,
      [u.orgId, u.roles ?? [], [u.id, ...principals], u.id])).rows;
    // Only the step that is actually next may be acted on.
    const actionable = [];
    for (const row of rows) {
      const steps = await stepsFor(pool, String(row.id));
      const next = nextActionableStep(steps);
      if (next && next.sequence === Number(row.sequence)) actionable.push(row);
    }
    return { data: actionable };
  });

  /**
   * Approve or reject at the current level.
   *
   * Maker-checker, sequence and delegation are all decided by the shared
   * `canAct`, so the same rules hold wherever they are evaluated.
   */
  app.post('/api/v1/approvals/:id/decision', { preHandler: guard('approval.act') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(approvalDecisionSchema, req.body);
    return {
      data: await mutate(pool, req, `approval.${input.decision.toLowerCase()}`, 'approval_instance', async db => {
        const instance = await inOrg(db, 'approval_instances', id, u.orgId, true);
        version(req, instance as { version: number });
        if (instance.status !== 'PENDING') {
          fail('NOT_PENDING', `This request is already ${String(instance.status).toLowerCase()}`);
        }

        const steps = await stepsFor(db, id);
        const step = nextActionableStep(steps);
        const decision = canAct({
          step, steps,
          actorUserId: u.id,
          actorRoles: u.roles ?? [],
          requesterUserId: String(instance.requested_by),
          delegations: await delegationsFor(db, u.orgId),
          documentType: instance.document_type as ApprovalDocumentType,
          today: today(),
          hasSelfApproveOverride: u.permissions.includes('approval.self_approve'),
        });
        if (!decision.allowed) {
          if (decision.code === 'NOT_THE_APPROVER') {
            // If this actor owns a *later* rung, the real problem is sequence,
            // not authority — saying so saves them hunting for a permission
            // they already hold.
            const laterRung = steps.find(s =>
              s.status === 'PENDING' && s.sequence > (step?.sequence ?? 0) &&
              ((s.approverRole && (u.roles ?? []).includes(s.approverRole)) || s.approverUserId === u.id));
            if (laterRung) {
              fail('OUT_OF_SEQUENCE',
                `Level ${step!.sequence} must decide before your level ${laterRung.sequence}.`);
            }
          }
          fail(decision.code, decision.reason, decision.code === 'SELF_APPROVAL' ? 403 : 422);
        }

        const current = steps.find(s => s.sequence === step!.sequence)!;
        const onBehalf = decision.viaDelegation ? current.approverUserId : null;
        await db.query(
          `UPDATE approval_steps SET status = $2, acted_by = $3, acted_at = now(),
             acted_on_behalf_of = $4, comments = $5
           WHERE id = $1`,
          [current.id, input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
           u.id, onBehalf, input.comments ?? null]);

        if (input.decision === 'REJECT') {
          // Rejection ends the instance. The requester reworks and resubmits,
          // which draws a fresh ladder against whatever the amount now is.
          return (await db.query(
            `UPDATE approval_instances SET status = 'REJECTED', rejection_reason = $2,
               decided_at = now(), version = version + 1, updated_at = now(), updated_by = $3
             WHERE id = $1 RETURNING *`, [id, input.comments ?? 'Rejected', u.id])).rows[0];
        }

        const remaining = steps.filter(s => s.sequence > current.sequence && s.status === 'PENDING');
        if (!remaining.length) {
          return (await db.query(
            `UPDATE approval_instances SET status = 'APPROVED', current_sequence = NULL,
               decided_at = now(), version = version + 1, updated_at = now(), updated_by = $2
             WHERE id = $1 RETURNING *`, [id, u.id])).rows[0];
        }
        // Start the next level's SLA clock now that it is genuinely waiting.
        const next = remaining[0];
        await db.query('UPDATE approval_steps SET pending_since = now() WHERE id = $1', [next.id]);
        return (await db.query(
          `UPDATE approval_instances SET current_sequence = $2, version = version + 1,
             updated_at = now(), updated_by = $3
           WHERE id = $1 RETURNING *`, [id, next.sequence, u.id])).rows[0];
      }),
    };
  });

  /** The requester pulls a request back before it is decided. */
  app.post('/api/v1/approvals/:id/recall', { preHandler: guard('approval.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { reason?: string };
    if (!body.reason) fail('VALIDATION_ERROR', 'Say why the request is being withdrawn');
    return {
      data: await mutate(pool, req, 'approval.recall', 'approval_instance', async db => {
        const instance = await inOrg(db, 'approval_instances', id, u.orgId, true);
        version(req, instance as { version: number });
        if (String(instance.requested_by) !== u.id) {
          fail('FORBIDDEN', 'Only the person who raised a request can withdraw it', 403);
        }
        if (instance.status !== 'PENDING') {
          fail('NOT_PENDING', `This request is already ${String(instance.status).toLowerCase()}`);
        }
        return (await db.query(
          `UPDATE approval_instances SET status = 'RECALLED', recalled_reason = $2,
             decided_at = now(), version = version + 1, updated_at = now(), updated_by = $3
           WHERE id = $1 RETURNING *`, [id, body.reason, u.id])).rows[0];
      }),
    };
  });

  /**
   * Report a change in the document's amount.
   *
   * This is the hole most approval implementations leave open: the approval
   * sits on the document, the edit lands on the amount, and nothing connects
   * them, so a purchase order approved at 4 lakh ships at 6. Owning modules
   * call this on every amount change; a material one supersedes the instance
   * and a fresh ladder is drawn.
   */
  app.post('/api/v1/approvals/:id/revalidate', { preHandler: guard('approval.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { amount?: number };
    if (body.amount === undefined) fail('VALIDATION_ERROR', 'Send the document’s new amount');
    return {
      data: await mutate(pool, req, 'approval.revalidate', 'approval_instance', async db => {
        const instance = await inOrg(db, 'approval_instances', id, u.orgId, true);
        const policy = (await db.query('SELECT * FROM approval_policies WHERE id = $1', [instance.policy_id])).rows[0];
        const levels = await levelsFor(db, String(instance.policy_id));
        const verdict = requiresReapproval({
          approvedAmount: Number(instance.amount),
          newAmount: Number(body.amount),
          levels,
          mode: policy.mode as LadderMode,
          tolerancePct: Number(policy.tolerance_pct),
        });
        if (!verdict.required) {
          await db.query(
            'UPDATE approval_instances SET amount = $2, updated_at = now(), updated_by = $3 WHERE id = $1',
            [id, body.amount, u.id]);
          return { ...instance, amount: body.amount, reapproval_required: false, reason: verdict.reason };
        }

        const ladder = resolveLadder(levels, Number(body.amount), policy.mode as LadderMode);
        if (!ladder.length) fail('NO_APPROVER', `The policy leaves ${body.amount} outside every authority band`);

        // The replacement has to exist before the original can point at it:
        // chk_ai_superseded requires status, superseded_by and the reason to
        // arrive together, so that no row can claim to be superseded by
        // nothing. Marking the old one first violated it.
        //
        // uk_ai_live_document also allows only one PENDING instance per
        // document, so the old one is closed in the same statement that names
        // its successor, before the successor is inserted.
        await db.query(
          `UPDATE approval_instances SET status = 'SUPERSEDED', superseded_reason = $2,
             superseded_by = $1, decided_at = now(), version = version + 1,
             updated_at = now(), updated_by = $3
           WHERE id = $1`, [id, verdict.reason, u.id]);
        await db.query(
          "UPDATE approval_steps SET status = 'SKIPPED' WHERE instance_id = $1 AND status = 'PENDING'", [id]);

        const fresh = (await db.query(
          `INSERT INTO approval_instances(org_id, created_by, document_type, document_id, policy_id,
             project_id, amount, requested_by, current_sequence)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [u.orgId, u.id, instance.document_type, instance.document_id, instance.policy_id,
           instance.project_id, body.amount, instance.requested_by, ladder[0].sequence])).rows[0];
        await db.query('UPDATE approval_instances SET superseded_by = $2 WHERE id = $1', [id, fresh.id]);
        for (const s of ladder) {
          await db.query(
            `INSERT INTO approval_steps(org_id, instance_id, sequence, approver_role, approver_user_id,
               sla_hours, pending_since)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [u.orgId, fresh.id, s.sequence, s.approverRole, s.approverUserId, s.slaHours,
             s.sequence === ladder[0].sequence ? new Date() : null]);
        }
        return { ...fresh, reapproval_required: true, reason: verdict.reason, superseded: id };
      }),
    };
  });

  /* ------------------------------------------------------------ delegation */

  app.post('/api/v1/approval-delegations', { preHandler: guard('approval.delegate') }, async (req, reply) => {
    const u = actor(req), input = parse(delegationSchema, req.body);
    const row = await mutate(pool, req, 'approval.delegate', 'approval_delegation', async db => {
      if (input.to_user_id === u.id) {
        fail('VALIDATION_ERROR', 'Delegating to yourself changes nothing');
      }
      await inOrg(db, 'users', input.to_user_id, u.orgId);
      const existing = await delegationsFor(db, u.orgId);
      // A→B→A means the authority comes back to its source and nobody is
      // accountable; refuse it rather than let the resolver walk in circles.
      if (createsDelegationCycle(existing, {
        fromUserId: u.id, toUserId: input.to_user_id,
        validFrom: input.valid_from, validTo: input.valid_to,
      })) {
        fail('DELEGATION_CYCLE',
          'That delegation would hand your authority back to you through another person');
      }
      return (await db.query(
        `INSERT INTO approval_delegations(org_id, created_by, from_user_id, to_user_id,
           valid_from, valid_to, document_types, reason)
         VALUES($1,$2,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.to_user_id, input.valid_from, input.valid_to,
         JSON.stringify(input.document_types), input.reason])).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.post('/api/v1/approval-delegations/:id/revoke', { preHandler: guard('approval.delegate') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    return {
      data: await mutate(pool, req, 'approval.delegate.revoke', 'approval_delegation', async db => {
        const row = await inOrg(db, 'approval_delegations', id, u.orgId, true);
        if (String(row.from_user_id) !== u.id && !u.permissions.includes('approval.configure')) {
          fail('FORBIDDEN', 'Only the delegating user can revoke their delegation', 403);
        }
        if (row.revoked_at) fail('ALREADY_REVOKED', 'That delegation is already revoked');
        return (await db.query(
          'UPDATE approval_delegations SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *',
          [id, u.id])).rows[0];
      }),
    };
  });

  app.get('/api/v1/approval-delegations', { preHandler: guard('approval.read') }, async req => {
    const u = actor(req);
    const rows = (await pool.query(
      `SELECT d.*, f.username AS from_username, t.username AS to_username
       FROM approval_delegations d
       JOIN users f ON f.id = d.from_user_id
       JOIN users t ON t.id = d.to_user_id
       WHERE d.org_id = $1 AND (d.from_user_id = $2 OR d.to_user_id = $2
             OR $3::boolean)
       ORDER BY d.valid_from DESC`,
      [u.orgId, u.id, u.permissions.includes('approval.configure')])).rows;
    return { data: rows };
  });
}

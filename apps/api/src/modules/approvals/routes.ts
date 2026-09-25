import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  approvalPolicySchema, approvalDecisionSchema, delegationSchema,
  resolveLadder, canAct, nextActionableStep, createsDelegationCycle, requiresReapproval,
  holdsApproverRole, rolesSatisfyingApproverRole,
  type ApprovalDocumentType, type ApprovalStep, type Delegation, type LadderMode,
  businessDay,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';
import { resolveScopes } from '../../common/scopes.js';
import { assertLadderHasEligibleApprovers } from '../../common/approvalRouting.js';

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
  // The calendar day where the work happens, not in UTC. For the first
  // five and a half hours of every Indian day, UTC is still yesterday.
  const today = () => businessDay();

  /**
   * Carry the ladder's verdict onto the document that asked for it.
   *
   * A requisition has no status route of its own: it is submitted here and
   * waits. Without this, a fully approved ladder left the requisition at
   * SUBMITTED forever, and no order could ever be raised against it -- the
   * test suite papered over the gap by updating the row directly.
   *
   * An order does have its own `/status` route, but that route only ever
   * *checks* the ladder ("an order reaches APPROVED only when its approval
   * instance says so") -- something still has to be the one that actually
   * flips the status once the ladder clears, the same as a requisition.
   * Left unhandled, an approved order sat at PENDING_APPROVAL forever and
   * every caller (including this test suite, by writing the row directly)
   * had to reach past the API to move it. A rejected order has no REJECTED
   * status of its own (`PO_STATUSES`) -- DRAFT is its rework state, and
   * PENDING_APPROVAL already allows falling back to DRAFT.
   *
   * Claims are the one type still left alone: they read the instance and
   * move themselves via their own decision route, with checks that belong
   * in their module.
   */
  async function reflectOnDocument(
    db: PoolClient, instance: Record<string, any>, outcome: 'APPROVED' | 'REJECTED', actorId: string,
  ) {
    if (instance.document_type === 'PURCHASE_REQUISITION') {
      await db.query(
        `UPDATE purchase_requisitions SET status = $2, version = version + 1,
           updated_at = now(), updated_by = $3
         WHERE id = $1 AND approval_id = $4 AND status = 'SUBMITTED'`,
        [instance.document_id, outcome, actorId, instance.id]);
      return;
    }
    if (instance.document_type === 'PURCHASE_ORDER') {
      // §43.2: an amendment that sent an already-issued order (SENT,
      // PARTIALLY_RECEIVED, ...) back through the ladder must land it back
      // there, not at the fresh-order defaults below. The amendment that
      // requested this instance is the one row that knows what to restore.
      const amendment = (await db.query(
        `SELECT id, pre_status FROM po_amendments WHERE approval_id = $1`,
        [instance.id])).rows[0];
      if (amendment?.pre_status) {
        await db.query(
          `UPDATE purchase_orders SET status = $2, version = version + 1,
             updated_at = now(), updated_by = $3
           WHERE id = $1 AND approval_id = $4 AND status = 'PENDING_APPROVAL'`,
          [instance.document_id, amendment.pre_status, actorId, instance.id]);
        if (outcome === 'REJECTED') {
          // Flagged rather than reverted: the line changes it made stay in
          // place, but it is marked as not having taken effect.
          await db.query(`UPDATE po_amendments SET rejected_at = now() WHERE id = $1`, [amendment.id]);
        }
        return;
      }
      const next = outcome === 'APPROVED' ? 'APPROVED' : 'DRAFT';
      await db.query(
        `UPDATE purchase_orders SET status = $2, version = version + 1,
           updated_at = now(), updated_by = $3
         WHERE id = $1 AND approval_id = $4 AND status = 'PENDING_APPROVAL'`,
        [instance.document_id, next, actorId, instance.id]);
      return;
    }
  }

  /**
   * Live delegations in the org, as the pure layer wants them.
   *
   * `from_user_roles` is what lets `canAct` honour delegation on a
   * role-based step ("any PROJECT_MANAGER") and not only a named-approver
   * one: the delegate inherits the principal's eligibility, so the pure
   * layer needs to know what roles the principal actually held.
   * `from_user_scope` is I2 (fix round 1): the same role-based delegation
   * must not let a delegate reach a project the principal could not
   * themselves reach, so the pure layer also needs the principal's own
   * resolved project scope.
   *
   * Only a principal whose own login is still ACTIVE lends anything (review
   * A, item 2): authority borrowed from somebody who has exited or been
   * disabled would otherwise outlive them -- an exited ADMIN's delegate
   * kept clearing ADMIN steps.
   */
  async function delegationsFor(db: Pool | PoolClient, orgId: string): Promise<Delegation[]> {
    const rows = (await db.query(
      `SELECT d.from_user_id, d.to_user_id, d.valid_from, d.valid_to, d.document_types, d.revoked_at,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS from_user_roles
       FROM approval_delegations d
       JOIN users fu ON fu.id = d.from_user_id AND fu.auth_status = 'ACTIVE'
       LEFT JOIN user_roles ur ON ur.user_id = d.from_user_id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE d.org_id = $1 AND d.revoked_at IS NULL
       GROUP BY d.id`, [orgId])).rows;
    if (!rows.length) return [];
    const fromUserIds = [...new Set(rows.map(r => String(r.from_user_id)))];
    const scopeRows = (await db.query(
      `SELECT user_id, scope_type, scope_id FROM user_roles WHERE user_id = ANY($1::uuid[])`,
      [fromUserIds])).rows;
    const scopesByUser = new Map<string, { scope_type: string | null; scope_id: string | null }[]>();
    for (const r of scopeRows) {
      const id = String(r.user_id);
      (scopesByUser.get(id) ?? scopesByUser.set(id, []).get(id)!).push(
        { scope_type: r.scope_type, scope_id: r.scope_id });
    }
    return rows.map(r => {
      const resolved = resolveScopes(scopesByUser.get(String(r.from_user_id)) ?? []);
      return {
        fromUserId: String(r.from_user_id),
        toUserId: String(r.to_user_id),
        validFrom: String(r.valid_from).slice(0, 10),
        validTo: String(r.valid_to).slice(0, 10),
        documentTypes: Array.isArray(r.document_types) && r.document_types.length ? r.document_types : null,
        revokedAt: r.revoked_at ? String(r.revoked_at) : null,
        fromUserRoles: Array.isArray(r.from_user_roles) ? r.from_user_roles.map(String) : [],
        fromUserScope: { global: resolved.global, projects: resolved.projects },
      };
    });
  }

  /** The policy that governs a document: project override first, then org. */
  /**
   * Whether a ladder names the same only-possible person at two levels (fix
   * round 2, item 2(a)).
   *
   * Segregation of duties (I3, fix round 1) refuses the same physical
   * person -- and any delegate acting on their behalf -- a second level of
   * one instance, unconditionally. Two patterns make that certain rather
   * than incidental:
   *
   *  - the same approver_user_id named at two levels: always the same
   *    person, so the ladder could never clear no matter who else is
   *    involved;
   *  - the same approver_role at two levels when the organisation
   *    currently has at most one holder of it: nobody else could stand in
   *    by role, and I3 also refuses that one holder's own delegate (the
   *    principal behind a delegation counts as having "decided" too).
   *
   * A role held by two or more people is left alone -- a different person
   * legitimately clearing each level is exactly how the ladder is meant to
   * work, and who holds a role can change after the policy is saved.
   *
   * The holder count only counts users.auth_status = 'ACTIVE' (fix round
   * 3), matching admin/routes.ts's keepAdministrator: a disabled user keeps
   * their user_roles row, so without this a role with one active and one
   * disabled holder was wrongly treated as resolvable by two people.
   */
  async function ladderUnresolvableReason(
    db: Pool | PoolClient, orgId: string,
    levels: { sequence: number; approver_role?: string | null; approver_user_id?: string | null }[],
  ): Promise<string | null> {
    const byUser = new Map<string, number[]>();
    const byRole = new Map<string, number[]>();
    for (const l of levels) {
      if (l.approver_user_id) {
        byUser.set(l.approver_user_id, [...(byUser.get(l.approver_user_id) ?? []), l.sequence]);
      }
      if (l.approver_role) {
        byRole.set(l.approver_role, [...(byRole.get(l.approver_role) ?? []), l.sequence]);
      }
    }
    for (const [userId, sequences] of byUser) {
      if (sequences.length < 2) continue;
      const named = (await db.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0];
      return `${named?.username ?? 'The same person'} is named as the approver for levels `
        + `${sequences.join(' and ')}. The same person can never decide two levels of one request.`;
    }
    for (const [role, sequences] of byRole) {
      if (sequences.length < 2) continue;
      const holders = (await db.query(
        `SELECT count(DISTINCT ur.user_id)::int AS n
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
          WHERE r.code = ANY($1::text[]) AND u.org_id = $2 AND u.auth_status = 'ACTIVE'`,
        [rolesSatisfyingApproverRole(role), orgId])).rows[0];
      if (Number(holders.n) <= 1) {
        return `${role.replaceAll('_', ' ').toLowerCase()} is named as the approver for levels `
          + `${sequences.join(' and ')}, and this organisation currently has ${Number(holders.n)} `
          + `holder${Number(holders.n) === 1 ? '' : 's'} of that role. The same person can never `
          + `decide two levels of one request.`;
      }
    }
    return null;
  }

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
      actedOnBehalfOf: r.acted_on_behalf_of ? String(r.acted_on_behalf_of) : null,
      slaHours: r.sla_hours === null ? null : Number(r.sla_hours),
      pendingSince: r.pending_since ? String(r.pending_since) : null,
    }));
  }

  /**
   * The same steps, with the audit trail attached.
   *
   * `stepsFor` returns the shape the decision engine wants and nothing more —
   * deliberately, since it feeds `canAct`. But a ladder with no actor, no
   * timestamp and no comment is not an audit trail, it is a progress bar, so
   * the detail view reads its own richer row.
   */
  async function stepsWithTrail(db: Pool | PoolClient, instanceId: string) {
    return (await db.query(
      `SELECT s.*, a.username AS acted_by_username, b.username AS acted_on_behalf_of_username
       FROM approval_steps s
       LEFT JOIN users a ON a.id = s.acted_by
       LEFT JOIN users b ON b.id = s.acted_on_behalf_of
       WHERE s.instance_id = $1 ORDER BY s.sequence`, [instanceId])).rows;
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
      // Fix round 2, item 2(a): refuse a ladder that could never clear,
      // before touching the policy this would otherwise replace.
      const unresolvable = await ladderUnresolvableReason(db, u.orgId, input.levels);
      if (unresolvable) fail('LADDER_UNRESOLVABLE', unresolvable);
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

  /**
   * Turn a policy off without replacing it.
   *
   * POST .../:id already retires the previous policy for a document type
   * when a new one is created, so "edit" already works by superseding. What
   * that route cannot do is switch a policy off with nothing standing in for
   * it, which the web admin screen needs for "stop routing this document
   * type until further notice." Same If-Match discipline as every other
   * single-row mutation here.
   */
  app.post('/api/v1/approval-policies/:id/deactivate', { preHandler: guard('approval.configure') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    return {
      data: await mutate(pool, req, 'approval.policy.deactivate', 'approval_policy', async db => {
        const policy = await inOrg(db, 'approval_policies', id, u.orgId, true);
        version(req, policy as { version: number }, 'approval policy');
        if (!policy.active) fail('NOT_ACTIVE', 'This policy is already inactive');
        return (await db.query(
          `UPDATE approval_policies SET active = FALSE, version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`, [id, u.id])).rows[0];
      }),
    };
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
        // Named so the web admin screen's error card can point straight at
        // Approvals → Policies without parsing this sentence.
        fail('NO_APPROVAL_POLICY',
          `No approval route is set up for ${String(body.document_type).replaceAll('_', ' ').toLowerCase()}`
          + `${body.project_id ? ' in this project' : ''}. Ask an administrator to add one under Approvals → Policies.`);
      }
      const levels = await levelsFor(db, policy.id);
      const ladder = resolveLadder(levels, Number(body.amount), policy.mode as LadderMode);
      if (!ladder.length) {
        fail('NO_APPROVER',
          `The policy leaves ${body.amount} outside every authority band. Check the slabs.`);
      }
      await assertLadderHasEligibleApprovers(db, u.orgId, policy, ladder, u.id, String(body.document_type));

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

  /**
   * The requests this actor is allowed to see.
   *
   * `approval.read` alone means the ones they raised; `approval.read_all` is
   * the organisation-wide grant. Without this a requester could act on a
   * request from the inbox but never find one they had raised themselves.
   */
  app.get('/api/v1/approvals', { preHandler: guard('approval.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'i.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND i.status = $${values.length}`; }
    if (q.document_type) { values.push(q.document_type); where += ` AND i.document_type = $${values.length}`; }
    // `mine=true` narrows an org-wide reader back to their own requests, which
    // is what the "raised by me" view wants.
    if (q.mine === 'true' || !u.permissions.includes('approval.read_all')) {
      values.push(u.id);
      where += ` AND i.requested_by = $${values.length}`;
    }
    const rows = (await pool.query(
      `SELECT i.*, u.username AS requested_by_username, p.code AS project_code,
              pol.name AS policy_name
       FROM approval_instances i
       LEFT JOIN users u ON u.id = i.requested_by
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN approval_policies pol ON pol.id = i.policy_id
       WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
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
    const requester = (await pool.query(
      'SELECT username FROM users WHERE id = $1', [instance.requested_by])).rows[0];
    const policy = instance.policy_id
      ? (await pool.query('SELECT name, mode FROM approval_policies WHERE id = $1', [instance.policy_id])).rows[0]
      : null;
    return {
      data: {
        ...instance,
        requested_by_username: requester?.username ?? null,
        policy_name: policy?.name ?? null,
        policy_mode: policy?.mode ?? null,
        steps: await stepsWithTrail(pool, id),
        next_step: nextActionableStep(steps),
      },
    };
  });

  /**
   * The acting user's queue, delegations and project scope included.
   *
   * DECISION (2026-09-24): a project-scoped approver (§4.1 -- TEAM_LEAD and
   * PROJECT_MANAGER default to an assigned-project scope) must see only
   * documents in a project their own approval.act scope covers, plus
   * org-wide (project-less) documents they are otherwise eligible for --
   * not every pending step across the organisation. A global scope (most
   * other roles, and anyone with an explicit null-scope assignment) is
   * unaffected.
   */
  app.get('/api/v1/approvals/inbox', { preHandler: guard('approval.act') }, async req => {
    const u = actor(req);
    const scopes = resolveScopes(u.scopes);
    const delegations = await delegationsFor(pool, u.orgId);
    const liveDelegationsToMe = delegations
      .filter(d => d.toUserId === u.id && d.validFrom <= today() && today() <= d.validTo);
    const principals = liveDelegationsToMe.map(d => d.fromUserId);
    // A role-based step ("any PROJECT_MANAGER") names no one person; canAct
    // already lets a live delegate of any role holder act on it (owner
    // decision 2026-09-24), so the inbox has to offer it to them too, not
    // only a step assigned to them by name.
    const delegatedRoles = [...new Set(liveDelegationsToMe.flatMap(d => d.fromUserRoles ?? []))];
    // An ADMIN step is met by a SUPER_ADMIN too (review A, item 1), so the
    // prefilter offers ADMIN steps to anyone holding SUPER_ADMIN.
    const heldRoles = [...(u.roles ?? []), ...delegatedRoles];
    const roleMatch = [...new Set([...heldRoles,
      ...(holdsApproverRole(heldRoles, 'ADMIN') ? ['ADMIN'] : [])])];
    const rows = (await pool.query(
      `SELECT i.*, s.id AS step_id, s.sequence, s.approver_role, s.approver_user_id, s.pending_since, s.sla_hours
       FROM approval_steps s JOIN approval_instances i ON i.id = s.instance_id
       WHERE s.org_id = $1 AND s.status = 'PENDING' AND i.status = 'PENDING'
         AND (s.approver_role = ANY($2::text[]) OR s.approver_user_id = ANY($3::uuid[]))
         -- maker-checker: never show somebody their own request
         AND i.requested_by <> $4
         -- project scope: org-wide documents always show; a scoped approver
         -- (not global) sees a project one only when it is theirs.
         AND ($5::boolean OR i.project_id IS NULL OR i.project_id = ANY($6::uuid[]))
       ORDER BY s.pending_since NULLS LAST, i.created_at`,
      [u.orgId, roleMatch, [u.id, ...principals], u.id, scopes.global, scopes.projects])).rows;
    // Only a step this actor could actually decide right now belongs in the
    // inbox -- reusing canAct() itself (fix round 2, item 2(c)) rather than
    // re-deriving a second opinion of its rules, so sequence, delegation and
    // segregation of duties (I2/I3) all filter the list exactly as they
    // would refuse the decision. Without this, an item only a policy fix --
    // not this person, and not any delegate of theirs -- could ever clear
    // (the same person named twice, or the sole holder of a role at two
    // levels) sat in the inbox looking actionable and 422'd on click.
    const actionable = [];
    for (const row of rows) {
      const steps = await stepsFor(pool, String(row.id));
      const step = steps.find(s => s.id === String(row.step_id)) ?? null;
      const decision = canAct({
        step, steps,
        actorUserId: u.id,
        actorRoles: u.roles ?? [],
        requesterUserId: String(row.requested_by),
        delegations,
        documentType: row.document_type as ApprovalDocumentType,
        today: today(),
        hasSelfApproveOverride: u.permissions.includes('approval.self_approve'),
        projectId: row.project_id ? String(row.project_id) : null,
      });
      if (decision.allowed) actionable.push(row);
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
        // I1 (owner decision 2026-09-24, fix round 1): the same project
        // scope the inbox filters by (resolveScopes over the approval.act
        // scope this guard already resolved) applies to deciding one
        // directly by id -- otherwise the inbox's filtering is cosmetic,
        // not a boundary. Refused as FORBIDDEN, matching projectAccess()'s
        // own wording for "this exists, but not in your scope" elsewhere.
        const scopes = resolveScopes(u.scopes);
        if (!scopes.global && instance.project_id && !scopes.projects.includes(String(instance.project_id))) {
          fail('FORBIDDEN', 'This request is for a project outside your scope', 403);
        }
        version(req, instance as { version: number }, 'approval request');
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
          projectId: instance.project_id ? String(instance.project_id) : null,
        });
        if (!decision.allowed) {
          if (decision.code === 'NOT_THE_APPROVER') {
            // If this actor owns a *later* rung, the real problem is sequence,
            // not authority — saying so saves them hunting for a permission
            // they already hold.
            const laterRung = steps.find(s =>
              s.status === 'PENDING' && s.sequence > (step?.sequence ?? 0) &&
              ((s.approverRole && holdsApproverRole(u.roles ?? [], s.approverRole)) || s.approverUserId === u.id));
            if (laterRung) {
              fail('OUT_OF_SEQUENCE',
                `Level ${step!.sequence} must decide before your level ${laterRung.sequence}.`);
            }
          }
          if (decision.code === 'SEGREGATION_OF_DUTIES') {
            // Fix round 2, item 2(b): this is a policy design problem, not
            // something the requester or the approver can work around --
            // naming the policy and saying who can fix it stops them
            // resubmitting the same request expecting a different answer.
            const policy = (await db.query(
              `SELECT p.name FROM approval_policies p
                 JOIN approval_instances i ON i.policy_id = p.id
                WHERE i.id = $1`, [id])).rows[0];
            fail('SEGREGATION_OF_DUTIES',
              `${decision.reason} Ask an administrator to change the `
              + `"${policy?.name ?? 'approval'}" policy so each level can be decided by a different person.`);
          }
          fail(decision.code, decision.reason, decision.code === 'SELF_APPROVAL' ? 403 : 422);
        }

        const current = steps.find(s => s.sequence === step!.sequence)!;
        // A named-approver step's principal is current.approverUserId; a
        // role-based step ("any PROJECT_MANAGER") has none, so canAct itself
        // says whose authority a delegated match actually used.
        const onBehalf = decision.viaDelegation ? (decision.onBehalfOf ?? null) : null;
        await db.query(
          `UPDATE approval_steps SET status = $2, acted_by = $3, acted_at = now(),
             acted_on_behalf_of = $4, comments = $5
           WHERE id = $1`,
          [current.id, input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
           u.id, onBehalf, input.comments ?? null]);

        if (input.decision === 'REJECT') {
          // Rejection ends the instance. The requester reworks and resubmits,
          // which draws a fresh ladder against whatever the amount now is.
          await reflectOnDocument(db, instance, 'REJECTED', u.id);
          return (await db.query(
            `UPDATE approval_instances SET status = 'REJECTED', rejection_reason = $2,
               decided_at = now(), version = version + 1, updated_at = now(), updated_by = $3
             WHERE id = $1 RETURNING *`, [id, input.comments ?? 'Rejected', u.id])).rows[0];
        }

        const remaining = steps.filter(s => s.sequence > current.sequence && s.status === 'PENDING');
        if (!remaining.length) {
          await reflectOnDocument(db, instance, 'APPROVED', u.id);
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
        await assertLadderHasEligibleApprovers(
          db, u.orgId, policy, ladder, String(instance.requested_by), String(instance.document_type));

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

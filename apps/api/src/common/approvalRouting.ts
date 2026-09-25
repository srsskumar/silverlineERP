import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { businessDay, resolveLadder, rolesSatisfyingApproverRole, type LadderMode } from '@silverline/shared';
import { actor, fail } from './domain.js';

/**
 * Routing a document into the §41 approval engine.
 *
 * Every financial document does the same three things — find the policy that
 * covers it, resolve the ladder for its amount, write the instance and its
 * steps — so it lives here rather than once per module. Procurement and
 * expenses both call it; payments and RA bill certification will.
 */

/** Authority slabs for a policy, in the shape the shared resolver wants. */
export async function levelsForPolicy(db: Pool | PoolClient, policyId: string) {
  return (await db.query(
    'SELECT * FROM approval_levels WHERE policy_id = $1 ORDER BY sequence', [policyId])).rows
    .map(r => ({
      sequence: Number(r.sequence), minAmount: Number(r.min_amount),
      maxAmount: r.max_amount === null ? null : Number(r.max_amount),
      approverRole: r.approver_role, approverUserId: r.approver_user_id,
      slaHours: r.sla_hours === null ? null : Number(r.sla_hours),
    }));
}

/**
 * Refuse a submission that nobody could ever approve (review A, item 1).
 *
 * A ladder can be perfectly valid on paper and still have nobody to clear
 * one of its levels for this particular request: the org-wide fallback's
 * only step is ADMIN, and when the sole administrator is the one raising
 * the requisition, maker-checker refuses them and there is nobody else --
 * the request would sit in no one's inbox forever. Each level needs at
 * least one ACTIVE person other than the requester who can act on it: the
 * named approver, a holder of the step's role (an ADMIN step is met by a
 * SUPER_ADMIN too), or a live delegate of one of those. Checked against the
 * same rules canAct() applies at decision time, so this never refuses a
 * request that could in fact have cleared.
 */
export async function assertLadderHasEligibleApprovers(
  db: Pool | PoolClient, orgId: string, policy: { name?: string | null },
  ladder: { sequence: number; approverRole: string | null; approverUserId: string | null }[],
  requesterId: string, documentType: string,
): Promise<void> {
  const today = businessDay();
  for (const s of ladder) {
    let principals: string[] = [];
    if (s.approverUserId) {
      principals = (await db.query(
        `SELECT id FROM users WHERE id = $1 AND org_id = $2 AND auth_status = 'ACTIVE'`,
        [s.approverUserId, orgId])).rows.map(r => String(r.id));
    } else if (s.approverRole) {
      principals = (await db.query(
        `SELECT DISTINCT u.id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE' AND r.code = ANY($2::text[])`,
        [orgId, rolesSatisfyingApproverRole(s.approverRole)])).rows.map(r => String(r.id));
    }
    if (principals.some(id => id !== requesterId)) continue;
    if (principals.length) {
      const delegated = await db.query(
        `SELECT 1 FROM approval_delegations d
           JOIN users t ON t.id = d.to_user_id AND t.auth_status = 'ACTIVE'
          WHERE d.org_id = $1 AND d.revoked_at IS NULL AND d.from_user_id = ANY($2::uuid[])
            AND d.to_user_id <> $3 AND d.valid_from <= $4::date AND $4::date <= d.valid_to
            AND (jsonb_array_length(d.document_types) = 0 OR d.document_types ? $5)
          LIMIT 1`,
        [orgId, principals, requesterId, today, documentType]);
      if ((delegated.rowCount ?? 0) > 0) continue;
    }
    const policyName = policy.name ? `"${policy.name}"` : 'this';
    const who = s.approverUserId ? 'the approver it names'
      : s.approverRole === 'ADMIN' ? 'an administrator'
      : `somebody with the ${String(s.approverRole).replaceAll('_', ' ').toLowerCase()} role`;
    const fix = s.approverRole === 'ADMIN'
      ? 'Ask for another person to be given administrator rights'
      : 'Ask an administrator to give that role to another active person';
    fail('NO_ELIGIBLE_APPROVER',
      `Nobody ${principals.length ? 'other than you ' : ''}can approve level ${s.sequence} of the `
      + `${policyName} approval policy: it needs ${who}. ${fix}, or to change the policy under `
      + 'Approvals → Policies.');
  }
}

/**
 * Raise an approval instance for a document.
 *
 * A project-specific policy wins over the organisation-wide one, so a site
 * with tighter authority than head office keeps it.
 */
export async function submitForApproval(
  db: PoolClient, req: FastifyRequest, documentType: string,
  documentId: string, amount: number, projectId: string | null,
): Promise<string> {
  const u = actor(req);
  const policy = (await db.query(
    `SELECT * FROM approval_policies
     WHERE org_id = $1 AND document_type = $2 AND active
       AND (project_id = $3::uuid OR project_id IS NULL)
     ORDER BY project_id NULLS LAST LIMIT 1`, [u.orgId, documentType, projectId])).rows[0];
  if (!policy) {
    // Named so the web admin screen's error card can point straight at
    // Approvals → Policies without parsing this sentence.
    fail('NO_APPROVAL_POLICY',
      `No approval route is set up for ${documentType.replaceAll('_', ' ').toLowerCase()}`
      + `${projectId ? ' in this project' : ''}. Ask an administrator to add one under Approvals → Policies.`);
  }
  const ladder = resolveLadder(
    await levelsForPolicy(db, String(policy.id)), amount, policy.mode as LadderMode);
  if (!ladder.length) fail('NO_APPROVER', `The policy leaves ${amount} outside every authority band`);
  await assertLadderHasEligibleApprovers(db, u.orgId, policy, ladder, u.id, documentType);

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

import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { resolveLadder, type LadderMode } from '@silverline/shared';
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

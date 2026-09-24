/**
 * Who decides a leave request, and keeping that answer current.
 *
 * step1Approver/step2Approver are the same functions filing uses to
 * assemble a chain in the first place, factored out here (fix round 2,
 * item 1) so the leave routes (GET /:id, POST .../decision) and the
 * employee exit flow can all call exactly the same resolution -- and so
 * `reassignIfIneligible` can re-run them against whichever step is
 * current, not duplicate the eligibility rule a third time.
 */
import type { Pool } from "pg";
import { S3_PERMISSIONS } from "@silverline/shared";
import { writeAudit } from "../../common/audit.js";

const LEAVE_DECIDE = S3_PERMISSIONS.LEAVE_DECIDE;

export interface ApprovalStepLike {
  step: number;
  approver_user_id: string;
  status: string;
  decided_at: string | null;
  note: string | null;
}

/** Step-1 candidate: linked user of the requester's `reports_to` manager. */
export async function step1Approver(
  db: Pick<Pool, "query">,
  orgId: string,
  requesterEmployeeId: string,
): Promise<string | null> {
  const mgr = await db.query(
    "SELECT reports_to FROM employees WHERE id = $1::uuid AND org_id = $2",
    [requesterEmployeeId, orgId],
  );
  const reportsTo = (mgr.rows[0] as { reports_to: string | null } | undefined)?.reports_to;
  if (!reportsTo) {
    return null;
  }
  const linked = await db.query(
    `SELECT u.id FROM users u
     WHERE u.employee_id = $1::uuid AND u.org_id = $2 AND u.auth_status = 'ACTIVE'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = u.id AND rp.permission_code = $3
       )
     LIMIT 1`,
    [reportsTo, orgId, LEAVE_DECIDE],
  );
  return (linked.rows[0] as { id: string } | undefined)?.id ?? null;
}

/**
 * Step-2 candidate: the org's HR manager (owner decision, 2026-09-24).
 *
 * This used to pick whichever of HR_MANAGER/ADMIN/SUPER_ADMIN had the
 * oldest account -- an ADMIN account older than the org's HR_MANAGER one
 * silently won, so HR could go an entire deployment without ever seeing
 * this step. An admin is now only a fallback for an org with no HR
 * manager at all, never a substitute for one that exists.
 *
 * Deterministic by lowest user id (org settings carries no designated-HR
 * override today; this is the ordering until one is added).
 *
 * `applicantUserId` is excluded from both queries -- the requester's own
 * account is never picked as their own step-2 approver.
 */
export async function step2Approver(
  db: Pick<Pool, "query">,
  orgId: string,
  applicantUserId: string | null,
): Promise<string | null> {
  const excluded = applicantUserId ?? "00000000-0000-0000-0000-000000000000";
  const hr = await db.query(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE' AND r.code = 'HR_MANAGER'
       AND u.id != $2::uuid
     ORDER BY u.id ASC
     LIMIT 1`,
    [orgId, excluded],
  );
  const hrId = (hr.rows[0] as { id: string } | undefined)?.id;
  if (hrId) return hrId;
  const admin = await db.query(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE' AND r.code IN ('ADMIN', 'SUPER_ADMIN')
       AND u.id != $2::uuid
     ORDER BY u.id ASC
     LIMIT 1`,
    [orgId, excluded],
  );
  return (admin.rows[0] as { id: string } | undefined)?.id ?? null;
}

/** Whether `userId` is still a step-2-eligible approver: active, holds
 * HR_MANAGER/ADMIN/SUPER_ADMIN, and is not the applicant. */
async function isEligibleStep2Approver(
  db: Pick<Pool, "query">,
  orgId: string,
  userId: string,
  applicantUserId: string | null,
): Promise<boolean> {
  if (applicantUserId && userId === applicantUserId) return false;
  const res = await db.query(
    `SELECT 1 FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1::uuid AND u.org_id = $2 AND u.auth_status = 'ACTIVE'
       AND r.code IN ('HR_MANAGER', 'ADMIN', 'SUPER_ADMIN')
     LIMIT 1`,
    [userId, orgId],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface ReassignableRequest {
  id: string;
  org_id: string;
  employee_id: string;
  status: string;
  current_approver_id: string | null;
  approval_chain: unknown;
}

export interface ReassignResult {
  reassigned: boolean;
  approverId: string | null;
  chain: ApprovalStepLike[];
}

/**
 * Fix round 2, item 1: a pending request's current approver may have
 * exited, been disabled, or lost the role that put them on the chain,
 * after the chain was assembled -- and was then stuck forever, since
 * nobody else was ever assigned `current_approver_id`. Re-resolves the
 * step-2 (HR manager / admin) slot when its holder is no longer eligible,
 * writing the new approver back and auditing the change.
 *
 * Step 1 is not re-resolved here: it is a direct `reports_to` relationship
 * that a manager change already updates going forward, and re-deriving it
 * retroactively for an in-flight request is a different, larger decision
 * this fix does not make. A stale step-2 slot is the reported problem, and
 * the only one this function touches -- it is a no-op for a request
 * currently sitting at step 1.
 *
 * Called from three places: GET /leave/requests/:id (lazily, on read),
 * POST /leave/requests/:id/decision (before the NOT_APPROVER check, so a
 * newly-eligible approver can act immediately), and the employee exit
 * flow (in the same transaction as the exit, for every pending request
 * the exiting user was the approver on).
 */
export async function reassignIfIneligible(
  db: Pick<Pool, "query">,
  req: ReassignableRequest,
  ctx: {
    actorId: string | null;
    impersonatorId?: string | null;
    actorIp?: string | null;
    actorUserAgent?: string | null;
    requestId?: string | null;
    reason: string;
  },
): Promise<ReassignResult> {
  const chain = (Array.isArray(req.approval_chain) ? req.approval_chain : []) as ApprovalStepLike[];
  if (req.status !== "PENDING" || !req.current_approver_id) {
    return { reassigned: false, approverId: req.current_approver_id, chain };
  }
  const idx = chain.findIndex(
    (s) => s.approver_user_id === req.current_approver_id && s.status === "PENDING",
  );
  // Only the last (step-2) slot is ever re-resolved -- see the doc comment.
  if (idx < 0 || idx !== chain.length - 1) {
    return { reassigned: false, approverId: req.current_approver_id, chain };
  }

  const requesterLink = await db.query(
    "SELECT id FROM users WHERE employee_id = $1::uuid AND org_id = $2 LIMIT 1",
    [req.employee_id, req.org_id],
  );
  const requesterUserId = (requesterLink.rows[0] as { id: string } | undefined)?.id ?? null;

  const stillEligible = await isEligibleStep2Approver(
    db, req.org_id, req.current_approver_id, requesterUserId,
  );
  if (stillEligible) {
    return { reassigned: false, approverId: req.current_approver_id, chain };
  }

  const fresh = await step2Approver(db, req.org_id, requesterUserId);
  if (!fresh) {
    // Nobody eligible at all right now (org has no HR manager or admin
    // left) -- leave the stale approver in place rather than clear it to
    // nothing; there is nothing better to assign.
    return { reassigned: false, approverId: req.current_approver_id, chain };
  }

  const newChain = chain.map((s, i) => (i === idx ? { ...s, approver_user_id: fresh } : s));
  const upd = await db.query(
    `UPDATE leave_requests SET approval_chain = $2, current_approver_id = $3::uuid,
       updated_at = NOW(), version = version + 1
     WHERE id = $1::uuid AND status = 'PENDING' AND current_approver_id = $4::uuid
     RETURNING id`,
    [req.id, JSON.stringify(newChain), fresh, req.current_approver_id],
  );
  if ((upd.rowCount ?? 0) === 0) {
    // Lost a race (a decision or another reassignment landed first);
    // nothing to report as changed from here.
    return { reassigned: false, approverId: req.current_approver_id, chain };
  }
  await writeAudit(db, {
    orgId: req.org_id,
    actorId: ctx.actorId,
    impersonatorId: ctx.impersonatorId ?? null,
    actorIp: ctx.actorIp ?? null,
    actorUserAgent: ctx.actorUserAgent ?? null,
    action: "leave.request.reassign_approver",
    entityType: "leave_request",
    entityId: req.id,
    beforeState: { approver_user_id: req.current_approver_id },
    afterState: { approver_user_id: fresh },
    reason: ctx.reason,
    requestId: ctx.requestId ?? null,
  });
  return { reassigned: true, approverId: fresh, chain: newChain };
}

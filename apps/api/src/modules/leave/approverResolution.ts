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

/** Whether `userId` is still a step-1-eligible approver: active, holds the
 * `leave.decide` grant (the same test `step1Approver`'s own query applies
 * to a candidate), and is not the applicant. */
async function isEligibleStep1Approver(
  db: Pick<Pool, "query">,
  orgId: string,
  userId: string,
  applicantUserId: string | null,
): Promise<boolean> {
  if (applicantUserId && userId === applicantUserId) return false;
  const res = await db.query(
    `SELECT 1 FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE u.id = $1::uuid AND u.org_id = $2 AND u.auth_status = 'ACTIVE'
       AND rp.permission_code = $3
     LIMIT 1`,
    [userId, orgId, LEAVE_DECIDE],
  );
  return (res.rowCount ?? 0) > 0;
}

/** First ACTIVE user in the org holding one of `roleCodes`, excluding
 * every id in `exclude` (the applicant, plus whoever holds the *other*
 * step of this same request's chain — never double up one person across
 * both steps), ordered by lowest id for determinism. */
async function firstEligibleByRole(
  db: Pick<Pool, "query">,
  orgId: string,
  roleCodes: string[],
  exclude: Iterable<string>,
): Promise<string | null> {
  const excludeArr = Array.from(new Set(exclude));
  const guard = excludeArr.length > 0 ? excludeArr : ["00000000-0000-0000-0000-000000000000"];
  const res = await db.query(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE' AND r.code = ANY($2::text[])
       AND u.id != ALL($3::uuid[])
     ORDER BY u.id ASC
     LIMIT 1`,
    [orgId, roleCodes, guard],
  );
  return (res.rows[0] as { id: string } | undefined)?.id ?? null;
}

/**
 * Step-2 fallback cascade (HR manager, then admin), given an arbitrary
 * exclusion set rather than just the applicant — used both by the public
 * `step2Approver` (filing time, applicant-only exclusion) and by
 * `reassignIfIneligible` (which also excludes whoever holds the request's
 * other step, so a reassignment never lands the same person on both).
 */
async function step2FallbackCascade(
  db: Pick<Pool, "query">,
  orgId: string,
  exclude: Iterable<string>,
): Promise<string | null> {
  const hr = await firstEligibleByRole(db, orgId, ["HR_MANAGER"], exclude);
  if (hr) return hr;
  return firstEligibleByRole(db, orgId, ["ADMIN", "SUPER_ADMIN"], exclude);
}

/**
 * Step-1 fallback cascade (fix round 3, controller ruling): the ineligible
 * approver's *own* reporting manager (if active, holds `leave.decide`, and
 * not excluded), then the same HR-manager-then-admin cascade step 2 uses.
 * `exclude` already carries the applicant and whoever holds the request's
 * other step; a candidate that would duplicate either is skipped in favour
 * of the next one down the cascade, all the way to admin.
 */
async function step1FallbackCascade(
  db: Pick<Pool, "query">,
  orgId: string,
  ineligibleApproverUserId: string,
  exclude: Iterable<string>,
): Promise<string | null> {
  const excludeSet = new Set(exclude);
  const linked = await db.query(
    "SELECT employee_id FROM users WHERE id = $1::uuid AND org_id = $2",
    [ineligibleApproverUserId, orgId],
  );
  const employeeId = (linked.rows[0] as { employee_id: string | null } | undefined)?.employee_id ?? null;
  if (employeeId) {
    const mgr = await step1Approver(db, orgId, employeeId);
    if (mgr && !excludeSet.has(mgr)) {
      return mgr;
    }
  }
  return step2FallbackCascade(db, orgId, excludeSet);
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
 * Fix round 2/3, item 1: a pending request's current approver -- at
 * *either* step -- may have exited, been disabled, or lost the role that
 * put them on the chain, after the chain was assembled, and was then
 * stuck forever since nobody else was ever assigned `current_approver_id`.
 * Re-resolves whichever step is currently pending when its holder is no
 * longer eligible, writing the new approver back and auditing the change.
 *
 * Fallback order (controller ruling, fix round 3):
 * - An ineligible **step-2** (HR/admin) holder falls back through the same
 *   cascade filing itself uses: the org's HR manager, then an admin.
 * - An ineligible **step-1** (reporting-manager) holder falls back to
 *   *their own* reporting manager first (if active, holds `leave.decide`),
 *   then the same HR-manager-then-admin cascade step 2 uses.
 * - The applicant is never a candidate at any tier. Nor is whoever holds
 *   the request's *other* step -- a candidate that would duplicate them is
 *   skipped for the next one down the cascade, so one person can never end
 *   up deciding both steps of the same request after a reassignment.
 * - If every tier is exhausted with nobody eligible, the stale approver is
 *   left in place rather than cleared to nothing.
 *
 * Called from three places: GET /leave/requests/:id (lazily, on read),
 * POST /leave/requests/:id/decision (before the NOT_APPROVER check, so a
 * newly-eligible approver can act immediately), and the employee exit
 * flow (in the same transaction as the exit, for every pending request
 * the exiting user was the approver on, at whichever step).
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
  if (idx < 0) {
    return { reassigned: false, approverId: req.current_approver_id, chain };
  }
  const isFinalStep = idx === chain.length - 1;

  const requesterLink = await db.query(
    "SELECT id FROM users WHERE employee_id = $1::uuid AND org_id = $2 LIMIT 1",
    [req.employee_id, req.org_id],
  );
  const requesterUserId = (requesterLink.rows[0] as { id: string } | undefined)?.id ?? null;

  // Never double up one person across both steps: whoever holds the
  // request's *other* step is off-limits for the one being reassigned.
  const otherStepApprovers = chain
    .filter((_, i) => i !== idx)
    .map((s) => s.approver_user_id);
  const exclude = new Set<string>(otherStepApprovers);
  if (requesterUserId) exclude.add(requesterUserId);

  const stillEligible = isFinalStep
    ? await isEligibleStep2Approver(db, req.org_id, req.current_approver_id, requesterUserId)
    : await isEligibleStep1Approver(db, req.org_id, req.current_approver_id, requesterUserId);
  if (stillEligible) {
    return { reassigned: false, approverId: req.current_approver_id, chain };
  }

  const fresh = isFinalStep
    ? await step2FallbackCascade(db, req.org_id, exclude)
    : await step1FallbackCascade(db, req.org_id, req.current_approver_id, exclude);
  if (!fresh) {
    // Nobody eligible at all right now (org has no HR manager or admin
    // left, or every candidate would duplicate the other step) -- leave
    // the stale approver in place rather than clear it to nothing; there
    // is nothing better to assign.
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

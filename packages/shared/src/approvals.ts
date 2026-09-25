import { z } from 'zod';
import type { RoleCode } from './rbac.js';
import type { Tone } from './financial-control.js';

/**
 * Approval workflow over a Delegation of Authority matrix (§41, §22.1).
 *
 * Every financial document in the system routes through this: purchase
 * requisitions, purchase orders, expense claims, payment release, RA bill
 * certification, tender submission above threshold. Building it once and
 * correctly is why it comes before procurement rather than after.
 *
 * Four rules carry the weight, and each exists because of a specific failure:
 *
 *  1. Maker-checker. The raiser cannot approve their own document. Without it
 *     the ladder is decoration.
 *  2. Sequential gating. Level 2 cannot act before level 1, or the ladder
 *     collapses into "whoever clicks first".
 *  3. Re-routing on material change. A purchase order approved at 4 lakh and
 *     then edited to 6 lakh must lose its approvals and climb the ladder
 *     again. This is the classic ERP hole: the approval is on the document,
 *     the edit is on the amount, and nothing connects them.
 *  4. Delegation is time-bound. A manager delegating during leave grants
 *     authority for a date range, not permanently, and the audit trail must
 *     show the act was taken on delegated authority.
 */

/* ------------------------------------------------------------------ DoA */

export const APPROVAL_DOCUMENT_TYPES = [
  'PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'VENDOR_INVOICE',
  'EXPENSE_CLAIM', 'PAYMENT', 'RA_BILL', 'TENDER_SUBMISSION',
  'LEAVE_REQUEST', 'ADVANCE', 'RETENTION_RELEASE',
] as const;
export type ApprovalDocumentType = (typeof APPROVAL_DOCUMENT_TYPES)[number];

/**
 * How a ladder is drawn from the slabs.
 *
 * SINGLE routes to the one authority whose band contains the amount — common
 * for low-risk documents where an extra signature buys nothing.
 *
 * CUMULATIVE routes through every level up to and including that one, which is
 * the norm for procurement in Indian companies: a 6 lakh order is seen by the
 * project manager *and* the finance head, not only the finance head.
 */
export type LadderMode = 'SINGLE' | 'CUMULATIVE';

export interface ApprovalLevel {
  sequence: number;
  /** Inclusive lower bound of the band this level owns. */
  minAmount: number;
  /** Exclusive upper bound; null means "and above". */
  maxAmount: number | null;
  approverRole?: RoleCode | string | null;
  approverUserId?: string | null;
  slaHours?: number | null;
}

export interface LadderStep {
  sequence: number;
  approverRole: string | null;
  approverUserId: string | null;
  slaHours: number | null;
}

/**
 * The levels an amount must clear.
 *
 * Bands are half-open [min, max) so that a slab boundary belongs to exactly one
 * level. An amount of exactly 500000 against bands [0,500000) and [500000,null)
 * routes to the second — the higher authority — which is the conservative
 * reading and the one an auditor expects.
 */
export function resolveLadder(levels: ApprovalLevel[], amount: number, mode: LadderMode = 'CUMULATIVE'): LadderStep[] {
  const ordered = [...levels].sort((a, b) => a.sequence - b.sequence);
  const owning = ordered.find(l => amount >= l.minAmount && (l.maxAmount === null || amount < l.maxAmount));
  if (!owning) return [];
  const chosen = mode === 'SINGLE'
    ? [owning]
    : ordered.filter(l => l.sequence <= owning.sequence);
  return chosen.map(l => ({
    sequence: l.sequence,
    approverRole: l.approverRole ?? null,
    approverUserId: l.approverUserId ?? null,
    slaHours: l.slaHours ?? null,
  }));
}

/** True when the slabs leave a gap or overlap — a policy that cannot route. */
export function validateSlabs(levels: ApprovalLevel[]): { valid: boolean; problem?: string } {
  if (!levels.length) return { valid: false, problem: 'A policy needs at least one level' };
  const ordered = [...levels].sort((a, b) => a.minAmount - b.minAmount);
  if (ordered[0].minAmount !== 0) {
    return { valid: false, problem: 'The first slab must start at zero, or small amounts route nowhere' };
  }
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const current = ordered[i], next = ordered[i + 1];
    if (current.maxAmount === null) {
      return { valid: false, problem: 'Only the highest slab may be open-ended' };
    }
    if (current.maxAmount !== next.minAmount) {
      return {
        valid: false,
        problem: current.maxAmount < next.minAmount
          ? `Amounts between ${current.maxAmount} and ${next.minAmount} route to nobody`
          : `Slabs overlap between ${next.minAmount} and ${current.maxAmount}`,
      };
    }
  }
  if (ordered[ordered.length - 1].maxAmount !== null) {
    return { valid: false, problem: 'The highest slab must be open-ended, or large amounts route nowhere' };
  }
  const sequences = new Set(levels.map(l => l.sequence));
  if (sequences.size !== levels.length) {
    return { valid: false, problem: 'Two levels share a sequence number' };
  }
  return { valid: true };
}

/* ----------------------------------------------------------- delegation */

export interface Delegation {
  fromUserId: string;
  toUserId: string;
  /** Inclusive. */
  validFrom: string;
  /** Inclusive — the last day the delegate may act. */
  validTo: string;
  documentTypes?: ApprovalDocumentType[] | null;
  revokedAt?: string | null;
  /**
   * Role codes the delegating user holds.
   *
   * A named-approver step ("boss, specifically") only ever needed
   * `fromUserId`/`toUserId` — `effectiveApprovers` walks the chain by user
   * id. A role-based step ("any PROJECT_MANAGER") names no one person, so
   * the same delegation only helps there if the delegate can be shown to
   * stand in for *someone who holds that role*. This is what lets `canAct`
   * check that without a database lookup of its own.
   */
  fromUserRoles?: string[];
  /**
   * The delegating user's own project scope (fix round 1, I2).
   *
   * A role-based delegation must not let a delegate reach further than the
   * principal themselves could: `global` true means every project;
   * otherwise `projects` is the exhaustive list. Absent (an older caller
   * that has not supplied it) is treated as unrestricted -- see
   * `principalCanReachProject`.
   */
  fromUserScope?: { global: boolean; projects: string[] };
}

/**
 * Who may act for a principal today.
 *
 * Delegation chains are followed, because a delegate going on leave in turn
 * delegates onward, but a cycle is refused rather than followed — A→B→A would
 * otherwise loop forever, and it also means nobody is actually accountable.
 */
export function effectiveApprovers(
  principalUserId: string, delegations: Delegation[], documentType: ApprovalDocumentType, today: string,
): { userId: string; viaDelegation: boolean; chain: string[] }[] {
  const live = delegations.filter(d =>
    !d.revokedAt &&
    d.validFrom <= today && today <= d.validTo &&
    (!d.documentTypes || d.documentTypes.length === 0 || d.documentTypes.includes(documentType)));

  const results: { userId: string; viaDelegation: boolean; chain: string[] }[] = [
    { userId: principalUserId, viaDelegation: false, chain: [] },
  ];
  const seen = new Set([principalUserId]);
  let frontier = [principalUserId];
  const chains = new Map<string, string[]>([[principalUserId, []]]);

  while (frontier.length) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const d of live.filter(x => x.fromUserId === from)) {
        if (seen.has(d.toUserId)) continue; // a cycle, or already reachable
        seen.add(d.toUserId);
        const chain = [...(chains.get(from) ?? []), from];
        chains.set(d.toUserId, chain);
        results.push({ userId: d.toUserId, viaDelegation: true, chain });
        next.push(d.toUserId);
      }
    }
    frontier = next;
  }
  return results;
}

/** A delegation that would let someone hand authority back to its source. */
export function createsDelegationCycle(existing: Delegation[], candidate: Delegation): boolean {
  const live = existing.filter(d => !d.revokedAt);
  const seen = new Set<string>([candidate.toUserId]);
  let frontier = [candidate.toUserId];
  while (frontier.length) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const d of live.filter(x => x.fromUserId === from)) {
        if (d.toUserId === candidate.fromUserId) return true;
        if (seen.has(d.toUserId)) continue;
        seen.add(d.toUserId);
        next.push(d.toUserId);
      }
    }
    frontier = next;
  }
  return false;
}

/* ------------------------------------------------------------- instance */

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'RECALLED', 'SUPERSEDED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Status-badge tone for an approval instance (fix round 1, item 7, optional
 * mobile-parity cleanup). Web's generic `financialTone` has no case for
 * RECALLED (falls through to neutral) and mobile disagreed with web's own
 * SUPERSEDED=info (mobile read it as danger); this is the one map both now
 * read. RECALLED reads danger, the same severity mobile always gave it,
 * closing the web-side gap; SUPERSEDED keeps web's existing info, the same
 * meaning that status already carries for other document types.
 */
export const APPROVAL_STATUS_TONES: Record<ApprovalStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  RECALLED: 'danger',
  SUPERSEDED: 'info',
};

export const STEP_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SKIPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface ApprovalStep {
  sequence: number;
  status: StepStatus;
  approverRole: string | null;
  approverUserId: string | null;
  actedByUserId?: string | null;
  /** Set when actedByUserId acted on delegated authority -- whose. */
  actedOnBehalfOf?: string | null;
}

/**
 * The step that may be acted on now.
 *
 * Sequential by construction: the first step still pending. Anything later is
 * blocked, which is the whole point of a ladder.
 */
export function nextActionableStep(steps: ApprovalStep[]): ApprovalStep | null {
  return [...steps].sort((a, b) => a.sequence - b.sequence).find(s => s.status === 'PENDING') ?? null;
}

export type ApprovalDecision =
  | { allowed: true; viaDelegation: boolean; onBehalfOf?: string | null }
  | { allowed: false; code: string; reason: string };

/**
 * Whether a project the delegate would be deciding for is one the principal
 * whose authority they are borrowing could themselves access.
 *
 * Only meaningful for a role-based step (fix round 1, I2): a named-approver
 * step already ties one specific person to one specific instance when the
 * ladder is drawn, so there is nothing for a delegate to over-reach into.
 * "Any PROJECT_MANAGER" carries no such instance-specific tie, so without
 * this a delegate with a broader scope than their principal could use a
 * borrowed role to decide a project the principal never managed. Absent
 * `projectId` (an org-wide document) or `fromUserScope` (not supplied by an
 * older caller), this is permissive by design -- both mean "nothing to
 * narrow by".
 */
function principalCanReachProject(
  projectId: string | null | undefined, scope: Delegation['fromUserScope'],
): boolean {
  if (!projectId) return true;
  if (!scope) return true;
  return scope.global || scope.projects.includes(projectId);
}

/** Who has already decided an earlier level of this instance. */
function priorDeciderIdentities(steps: ApprovalStep[], beforeSequence: number): Set<string> {
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.sequence >= beforeSequence) continue;
    if (s.status !== 'APPROVED' && s.status !== 'REJECTED') continue; // a skipped step decided nothing
    if (s.actedByUserId) ids.add(s.actedByUserId);
    if (s.actedOnBehalfOf) ids.add(s.actedOnBehalfOf);
  }
  return ids;
}

function resolveEligibility(args: {
  step: ApprovalStep;
  actorUserId: string;
  actorRoles: string[];
  delegations?: Delegation[];
  documentType: ApprovalDocumentType;
  today: string;
  projectId?: string | null;
}): ApprovalDecision {
  const { step, actorUserId, actorRoles, documentType, today, projectId } = args;
  if (step.approverUserId) {
    const permitted = effectiveApprovers(step.approverUserId, args.delegations ?? [], documentType, today);
    const match = permitted.find(p => p.userId === actorUserId);
    if (!match) {
      return { allowed: false, code: 'NOT_THE_APPROVER', reason: 'This step is assigned to somebody else' };
    }
    return { allowed: true, viaDelegation: match.viaDelegation, onBehalfOf: match.viaDelegation ? step.approverUserId : null };
  }

  if (step.approverRole) {
    if (actorRoles.includes(step.approverRole)) {
      return { allowed: true, viaDelegation: false };
    }
    // Nobody named holds this step -- any role holder does. So a delegate
    // inherits it exactly as they would a named approver's step, provided
    // the person they stand in for actually held the role (and, I2, could
    // themselves reach this document's project): a deputy covering a PM's
    // leave should be able to act on "any PROJECT_MANAGER" the same as they
    // act on a step assigned to that PM by name -- but only for a project
    // the PM they are covering for actually manages.
    const live = (args.delegations ?? []).filter(d =>
      !d.revokedAt && d.validFrom <= today && today <= d.validTo &&
      (!d.documentTypes || d.documentTypes.length === 0 || d.documentTypes.includes(documentType)));
    const viaRoleDelegation = live.find(d =>
      d.toUserId === actorUserId && (d.fromUserRoles ?? []).includes(step.approverRole!) &&
      principalCanReachProject(projectId, d.fromUserScope));
    if (viaRoleDelegation) return { allowed: true, viaDelegation: true, onBehalfOf: viaRoleDelegation.fromUserId };
    return {
      allowed: false, code: 'NOT_THE_APPROVER',
      reason: `This step needs the ${step.approverRole.replaceAll('_', ' ').toLowerCase()} role`,
    };
  }

  return { allowed: false, code: 'NO_APPROVER', reason: 'This step names no approver' };
}

/**
 * Whether this actor may act on this step right now.
 *
 * Maker-checker is the first gate and the one §4.1 names explicitly: an
 * approver cannot approve their own request unless an emergency override is
 * explicitly granted and audited. The override is deliberately awkward to
 * reach — it is a permission, not a flag on the request.
 *
 * Segregation of duties (fix round 1, I3) is the last gate, applied to
 * whatever eligibility resolves to: one person may decide at most one level
 * of a given instance, whether they acted as themselves or as someone
 * else's delegate. Checked against both identities an earlier step could
 * carry -- who physically decided it, and whose authority they borrowed to
 * do it -- against both identities behind the current attempt, so neither a
 * PM who cleared their own level and then reaches for a delegated ADMIN
 * role, nor the ADMIN's other delegate finishing what the PM started, gets
 * two levels of the same instance between them.
 */
export function canAct(args: {
  step: ApprovalStep | null;
  steps: ApprovalStep[];
  actorUserId: string;
  actorRoles: string[];
  requesterUserId: string;
  delegations?: Delegation[];
  documentType: ApprovalDocumentType;
  today?: string;
  hasSelfApproveOverride?: boolean;
  /** The document's project, for I2's principal-scope check on a role-based delegation. */
  projectId?: string | null;
}): ApprovalDecision {
  const { step, steps, actorUserId, requesterUserId } = args;
  if (!step) return { allowed: false, code: 'NOTHING_PENDING', reason: 'There is no step waiting for a decision' };

  const actionable = nextActionableStep(steps);
  if (!actionable || actionable.sequence !== step.sequence) {
    return {
      allowed: false, code: 'OUT_OF_SEQUENCE',
      reason: actionable
        ? `Level ${actionable.sequence} must decide before level ${step.sequence}`
        : 'This request has already been decided',
    };
  }

  if (actorUserId === requesterUserId && !args.hasSelfApproveOverride) {
    return {
      allowed: false, code: 'SELF_APPROVAL',
      reason: 'You raised this request, so you cannot approve it. Route it to another approver.',
    };
  }

  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const result = resolveEligibility({
    step, actorUserId, actorRoles: args.actorRoles, delegations: args.delegations,
    documentType: args.documentType, today, projectId: args.projectId,
  });
  if (!result.allowed) return result;

  const priorIdentities = priorDeciderIdentities(steps, step.sequence);
  const currentIdentities = [actorUserId, ...(result.viaDelegation && result.onBehalfOf ? [result.onBehalfOf] : [])];
  if (currentIdentities.some(id => priorIdentities.has(id))) {
    return {
      allowed: false, code: 'SEGREGATION_OF_DUTIES',
      reason: 'The same person has already decided an earlier level of this request, directly or as a delegate',
    };
  }

  return result;
}

/**
 * Has the approved amount moved enough to invalidate the approvals already
 * given?
 *
 * Any increase re-routes, because the ladder is drawn from the amount and a
 * larger figure may need a higher authority — and even within one band, an
 * approver signed for the figure they saw. A decrease within the same band is
 * left standing: re-approving a cheaper version of something already agreed
 * wastes everyone's time and trains people to click through.
 */
export function requiresReapproval(args: {
  approvedAmount: number;
  newAmount: number;
  levels: ApprovalLevel[];
  mode?: LadderMode;
  tolerancePct?: number;
}): { required: boolean; reason: string } {
  const { approvedAmount, newAmount, levels } = args;
  const tolerance = args.tolerancePct ?? 0;
  if (newAmount === approvedAmount) return { required: false, reason: 'Amount unchanged' };

  if (newAmount > approvedAmount) {
    const increasePct = approvedAmount === 0 ? Infinity : ((newAmount - approvedAmount) / approvedAmount) * 100;
    if (increasePct > tolerance) {
      return {
        required: true,
        reason: `The amount rose from ${approvedAmount} to ${newAmount}; approvals were given for the lower figure`,
      };
    }
  }

  const before = resolveLadder(levels, approvedAmount, args.mode).map(s => s.sequence).join(',');
  const after = resolveLadder(levels, newAmount, args.mode).map(s => s.sequence).join(',');
  if (before !== after) {
    return { required: true, reason: 'The new amount falls in a different authority band' };
  }
  return { required: false, reason: 'Change is within the approved authority and tolerance' };
}

/** Steps whose SLA has elapsed, for escalation (§52.4). */
export function overdueSteps(
  steps: (ApprovalStep & { pendingSince?: string | null; slaHours?: number | null })[],
  now: Date = new Date(),
): { sequence: number; hoursWaiting: number; slaHours: number }[] {
  const out: { sequence: number; hoursWaiting: number; slaHours: number }[] = [];
  for (const step of steps) {
    if (step.status !== 'PENDING' || !step.slaHours || !step.pendingSince) continue;
    const waiting = (now.getTime() - new Date(step.pendingSince).getTime()) / 3_600_000;
    if (waiting > step.slaHours) {
      out.push({ sequence: step.sequence, hoursWaiting: Math.floor(waiting), slaHours: step.slaHours });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- schemas */

export const approvalLevelSchema = z.object({
  sequence: z.coerce.number().int().min(1).max(20),
  min_amount: z.coerce.number().min(0),
  max_amount: z.coerce.number().min(0).nullable(),
  approver_role: z.string().trim().max(50).nullable().optional(),
  approver_user_id: z.string().uuid().nullable().optional(),
  sla_hours: z.coerce.number().int().min(1).max(8760).nullable().optional(),
}).refine(v => v.approver_role || v.approver_user_id, {
  message: 'A level must name either an approver role or a specific approver',
  path: ['approver_role'],
}).refine(v => v.max_amount === null || v.max_amount > v.min_amount, {
  message: 'The upper bound must exceed the lower bound',
  path: ['max_amount'],
});

export const approvalPolicySchema = z.object({
  document_type: z.enum(APPROVAL_DOCUMENT_TYPES),
  name: z.string().trim().min(1).max(150),
  mode: z.enum(['SINGLE', 'CUMULATIVE']).default('CUMULATIVE'),
  project_id: z.string().uuid().nullable().optional(),
  /** Percent by which an amount may rise before approvals are torn up. */
  tolerance_pct: z.coerce.number().min(0).max(25).default(0),
  active: z.boolean().default(true),
  levels: z.array(approvalLevelSchema).min(1).max(20),
}).superRefine((value, ctx) => {
  const check = validateSlabs(value.levels.map(l => ({
    sequence: l.sequence, minAmount: l.min_amount, maxAmount: l.max_amount,
    approverRole: l.approver_role, approverUserId: l.approver_user_id,
  })));
  if (!check.valid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: check.problem!, path: ['levels'] });
  }
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  comments: z.string().trim().max(2000).optional(),
}).refine(v => v.decision !== 'REJECT' || Boolean(v.comments), {
  message: 'Say why the request is being rejected — the requester has to act on it',
  path: ['comments'],
});

export const delegationSchema = z.object({
  to_user_id: z.string().uuid(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  document_types: z.array(z.enum(APPROVAL_DOCUMENT_TYPES)).max(20).default([]),
  reason: z.string().trim().min(1).max(500),
}).refine(v => v.valid_to >= v.valid_from, {
  message: 'A delegation cannot end before it starts',
  path: ['valid_to'],
});

export const APPROVAL_PERMISSIONS = [
  // Sees requests you raised. Everyone who can raise one holds this.
  'approval.read',
  // Sees every request in the organisation. §4 gives the Auditor read across
  // all domains; without a separate code the "own requests only" check that
  // stops an employee browsing would block the Auditor too.
  'approval.read_all',
  'approval.configure', 'approval.act',
  'approval.delegate', 'approval.self_approve',
] as const;

export const APPROVAL_ROLE_GRANTS: Record<RoleCode, string[]> = {
  // §4.1 reserves the emergency self-approval override for the top role.
  SUPER_ADMIN: [...APPROVAL_PERMISSIONS],
  ADMIN: ['approval.read', 'approval.read_all', 'approval.configure', 'approval.act', 'approval.delegate'],
  PROJECT_MANAGER: ['approval.read', 'approval.read_all', 'approval.act', 'approval.delegate'],
  TEAM_LEAD: ['approval.read', 'approval.read_all', 'approval.act'],
  BID_TENDER_MANAGER: ['approval.read', 'approval.read_all', 'approval.act'],
  GOVT_OBSERVER: [],
  HR_MANAGER: ['approval.read', 'approval.read_all', 'approval.act'],
  PAYROLL_OFFICER: ['approval.read', 'approval.read_all', 'approval.act'],
  INVENTORY_MANAGER: ['approval.read', 'approval.read_all', 'approval.act'],
  // §4: reads across all domains including the audit trail, never mutates.
  AUDITOR: ['approval.read', 'approval.read_all'],
  // An employee sees the progress of what they raised; the read route scopes
  // that to their own requests.
  EMPLOYEE: ['approval.read'],
  SALES_BD_EXECUTIVE: ['approval.read'],
  CLIENT_VIEWER: [],
};

import { z } from 'zod';
import type { RoleCode } from './rbac.js';

/**
 * §075 -- viewing the application as another user.
 *
 * The whole policy lives here as one pure function, so the question "may
 * this person hold this person's session?" has a single answer that a test
 * can ask without a database.
 */

export const IMPERSONATION_PERMISSIONS = ['admin.impersonate'] as const;

export const IMPERSONATION_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: ['admin.impersonate'],
  ADMIN: ['admin.impersonate'],
  /*
   * Everyone else, explicitly. A project manager investigating "why can't my
   * team lead see this village" wants this and cannot have it: it is an
   * administrator's tool because it can write as somebody else, and there is
   * no version of it that can only look. Their route is to ask an
   * administrator, who leaves a row behind when they do it.
   */
  PROJECT_MANAGER: [],
  TEAM_LEAD: [],
  EMPLOYEE: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: [],
  AUDITOR: [],
  CLIENT_VIEWER: [],
  SALES_BD_EXECUTIVE: [],
  BID_TENDER_MANAGER: [],
  GOVT_OBSERVER: [],
};

/** The longest a single view-as session may run before it has to be asked for again. */
export const IMPERSONATION_MAX_MINUTES = 120;
export const IMPERSONATION_DEFAULT_MINUTES = 30;

export const impersonateSchema = z.object({
  user_id: z.string().uuid(),
  /*
   * Required, and required to say something. The register is only worth
   * keeping if the rows in it explain themselves a year later.
   */
  reason: z.string().trim().min(10, 'Say why in a few words -- this is recorded').max(500),
  minutes: z.number().int().min(5).max(IMPERSONATION_MAX_MINUTES).optional(),
});
export type ImpersonateInput = z.infer<typeof impersonateSchema>;

export interface Principal {
  id: string;
  roles: string[];
  permissions: string[];
}

export interface ImpersonationVerdict {
  ok: boolean;
  /** Why not, phrased for the person who tried. */
  reason?: string;
}

/**
 * May `actor` hold `subject`'s session?
 *
 * The rule is that impersonation never gains anybody anything. An
 * administrator can already reach whatever the people below them can reach;
 * borrowing their identity is a convenience, not an escalation. So the
 * subject's permissions must be a subset of the actor's -- which also, on
 * its own, stops an ADMIN from becoming a SUPER_ADMIN, stops two
 * administrators with different grants from laundering permissions through
 * each other, and keeps working when somebody invents a new role next year.
 */
export function canImpersonate(actor: Principal, subject: Principal): ImpersonationVerdict {
  if (!actor.permissions.includes('admin.impersonate')) {
    return { ok: false, reason: 'You are not allowed to view the application as another user' };
  }
  if (actor.id === subject.id) {
    return { ok: false, reason: 'You are already yourself' };
  }
  const beyond = accessBeyond(actor, subject);
  /*
   * Named separately from the subset rule even though the subset rule would
   * catch it, because this is the case somebody will actually hit and
   * "SUPER_ADMIN cannot be impersonated" is a better sentence to read than
   * a list of nineteen permissions you are missing.
   */
  if (beyond.superAdmin) {
    return { ok: false, reason: 'A super administrator cannot be viewed as by anybody else' };
  }
  if (beyond.gained.length) {
    return {
      ok: false,
      reason: `That account can do things you cannot (${listGained(beyond.gained)}), so viewing as them would give you access you do not have`,
    };
  }
  return { ok: true };
}

/**
 * What `subject` can do that `actor` cannot.
 *
 * The one comparison behind every "may this person act on that account"
 * question: viewing as somebody, and setting their password, switching them
 * off or changing their roles. Each of those hands the actor, directly or
 * one step later, whatever the subject holds -- so each has to ask whether
 * the subject holds anything the actor does not.
 */
export function accessBeyond(
  actor: Pick<Principal, 'roles' | 'permissions'>,
  subject: Pick<Principal, 'roles' | 'permissions'>,
): { superAdmin: boolean; gained: string[] } {
  const held = new Set(actor.permissions);
  return {
    superAdmin: subject.roles.includes('SUPER_ADMIN') && !actor.roles.includes('SUPER_ADMIN'),
    gained: [...new Set(subject.permissions)].filter((p) => !held.has(p)),
  };
}

function listGained(gained: string[]): string {
  return `${gained.slice(0, 3).join(', ')}${gained.length > 3 ? `, and ${gained.length - 3} more` : ''}`;
}

/**
 * May `actor` administer `subject`'s account -- set its password, disable
 * it, change its two-factor policy or its roles?
 *
 * Each of those is a way into the account: a password the actor has just
 * set is a password the actor knows. So the rule is the one that governs
 * viewing as somebody: the subject must hold nothing the actor does not,
 * and a super administrator is nobody's business but another super
 * administrator's. Without it, anybody holding users.manage -- which the HR
 * manager role does -- could reset an administrator's password and sign in
 * as them.
 */
export function canManageAccount(
  actor: Pick<Principal, 'roles' | 'permissions'>,
  subject: Pick<Principal, 'roles' | 'permissions'>,
): ImpersonationVerdict {
  const beyond = accessBeyond(actor, subject);
  if (beyond.superAdmin) {
    return { ok: false, reason: 'Only a super administrator can change a super administrator\'s account' };
  }
  if (beyond.gained.length) {
    return {
      ok: false,
      reason: `That account can do things you cannot (${listGained(beyond.gained)}), so only somebody who holds at least as much can change it`,
    };
  }
  return { ok: true };
}

/**
 * Routes that stay the real person's own business while impersonating.
 *
 * Borrowing somebody's screen is not permission to change the locks on it.
 * Everything here either changes how the subject authenticates or would let
 * the borrowed session outlive the impersonation.
 */
export const IMPERSONATION_FORBIDDEN_PATHS = [
  '/api/v1/auth/password',
  '/api/v1/auth/mfa/setup',
  '/api/v1/auth/mfa/verify',
  '/api/v1/auth/mfa/disable',
  '/api/v1/auth/refresh',
  '/api/v1/auth/impersonate',
] as const;

export function impersonationBlocks(path: string): boolean {
  // Query strings and trailing slashes should not be a way past the list.
  const clean = path.split('?')[0].replace(/\/+$/, '') || '/';
  return IMPERSONATION_FORBIDDEN_PATHS.some((p) => clean === p);
}

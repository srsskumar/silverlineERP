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
  /*
   * Named separately from the subset rule even though the subset rule would
   * catch it, because this is the case somebody will actually hit and
   * "SUPER_ADMIN cannot be impersonated" is a better sentence to read than
   * a list of nineteen permissions you are missing.
   */
  if (subject.roles.includes('SUPER_ADMIN') && !actor.roles.includes('SUPER_ADMIN')) {
    return { ok: false, reason: 'A super administrator cannot be viewed as by anybody else' };
  }
  const held = new Set(actor.permissions);
  const gained = subject.permissions.filter((p) => !held.has(p));
  if (gained.length) {
    return {
      ok: false,
      reason: `That account can do things you cannot (${gained.slice(0, 3).join(', ')}${gained.length > 3 ? `, and ${gained.length - 3} more` : ''}), so viewing as them would give you access you do not have`,
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

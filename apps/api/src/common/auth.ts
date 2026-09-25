import {enforceRecordScope} from "./recordScope.js";
import type { FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { ApiError, mfaRequired, impersonationBlocks, type MfaPolicy } from "@silverline/shared";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: {
      id: string;
      orgId: string;
      username: string;
      mfaEnrollmentRequired:boolean;
      worker?:boolean;
      roles: string[];
      permissions: string[];
      /** Raw `user_roles` scope assignments (nullScope = global). */
      scopes: Array<{ scope_type: string | null; scope_id: string | null }>;
      /*
       * Set only while an administrator is viewing the application as this
       * user (§075). Everything else on this object describes the subject --
       * that is the point -- so this is the one field that remembers who is
       * actually at the keyboard, and it is what the audit trail records.
       */
      impersonator?: { id: string; username: string };
      impersonationId?: string;
    };
  }
}

interface AccessClaims {
  sub: string;
  org_id: string;
  type: string;
  family?: string;
  /** §075: the real actor behind an impersonated session, and the register row. */
  act?: string;
  imp?: string;
  worker?:boolean;
  iat?:number;
  exp?:number;
}

export interface AuthContext {
  pool: Pool;
  jwtSecret: string;
}

export function buildAuthenticate(ctx: AuthContext) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new ApiError({
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const token = header.slice("Bearer ".length).trim();
    let claims: AccessClaims;
    try {
      claims = jwt.verify(token, ctx.jwtSecret, { algorithms: ['HS256'] }) as AccessClaims;
    } catch {
      throw new ApiError({
        status: 401,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token",
      });
    }
    if (claims.type !== "access" || !claims.sub || (!claims.family&&!(claims.worker&&claims.iat&&claims.exp&&claims.exp-claims.iat<=60))) {
      throw new ApiError({
        status: 401,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token",
      });
    }
    const userRes = await ctx.pool.query(
      `SELECT id, org_id, username, auth_status, mfa_enabled, must_change_password,
              mfa_policy
       FROM users WHERE id = $1`,
      [claims.sub],
    );
    const row = userRes.rows[0] as
      | { id: string; org_id: string; username: string; auth_status: string;
          mfa_enabled: boolean; must_change_password: boolean; mfa_policy: string }
      | undefined;
    if (!row || row.auth_status !== "ACTIVE") {
      // Generic message: never leak whether the account exists / is disabled.
      throw new ApiError({
        status: 401,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token",
      });
    }
    if (claims.family) {
      const active = await ctx.pool.query(
        `SELECT s.id,s.last_used_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.org_id WHERE s.family=$1 AND s.user_id=$2 AND s.revoked=false AND s.expires_at>now() AND COALESCE(s.last_used_at,s.created_at)>now()-COALESCE((o.settings->>'session_timeout_minutes')::int,10080)*interval '1 minute' AND NOT EXISTS(SELECT 1 FROM device_registrations d WHERE d.user_id=s.user_id AND d.device_id=s.device_id AND d.revoked_at IS NOT NULL) LIMIT 1`,
        [claims.family, row.id],
      );
      if(active.rowCount&&(!active.rows[0].last_used_at||new Date(active.rows[0].last_used_at).getTime()<Date.now()-60000))await ctx.pool.query('UPDATE sessions SET last_used_at=now() WHERE id=$1',[active.rows[0].id]);
      if (!active.rowCount) throw new ApiError({ status: 401, code: 'INVALID_TOKEN', message: 'Session revoked or expired' });
    }
    const rolesRes = await ctx.pool.query(
      // mfa_required rides along on a query that already runs, so making the
      // requirement configurable costs nothing per request.
      `SELECT r.code, r.mfa_required FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [row.id],
    );
    const roleFlags = rolesRes.rows as Array<{ code: string; mfa_required: boolean }>;
    const roles = roleFlags.map((r) => r.code);
    const permsRes = await ctx.pool.query(
      `SELECT DISTINCT rp.permission_code FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1`,
      [row.id],
    );
    const permissions = permsRes.rows.map(
      (r) => (r as { permission_code: string }).permission_code,
    );
    const scopesRes = await ctx.pool.query(
      `SELECT ur.scope_type,ur.scope_id,r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id = $1`,
      [row.id],
    );
    let scopes = scopesRes.rows.map(
      (r) =>
        r.code==='EMPLOYEE'?{scope_type:'self',scope_id:row.id}:r as { scope_type: string | null; scope_id: string | null },
    );
    const clientOnly=roles.length>0&&roles.every(r=>r==='CLIENT_VIEWER');
    // External viewers require explicit project assignments, including legacy accounts.
    if(clientOnly)scopes=scopes.filter(s=>s.scope_type==='project'&&s.scope_id);
    if(clientOnly&&!scopes.length)scopes=[{scope_type:'restricted',scope_id:row.id}];
    if(clientOnly&&(req.url.startsWith('/api/v1/custom-fields')||/\/projects\/[^/]+\/(people|dependencies)/.test(req.url)||/\/tasks\/[^/]+\/(comments|evidence|activity|planning)/.test(req.url)))throw new ApiError({status:403,code:'FORBIDDEN',message:'Client access is limited to project progress'});
    /*
     * Who needs an authenticator is now the organisation's decision (§34).
     *
     * It used to be a list of role codes compiled in here, which put a policy
     * question somewhere only a deploy could answer -- and it was wrong for
     * the field, where a rover operator reading a six-digit code off a second
     * device before every shift pays that cost every morning.
     *
     * The floor still holds: a super administrator is never exempt, whatever
     * the role flag or the account's own policy says. That account can grant
     * itself the permission to change this setting, so opting out of it would
     * itself be the attack.
     */
    const mfaEnrollmentRequired =
      req.server.appConfig.nodeEnv === 'production'
      && !row.mfa_enabled
      && mfaRequired(roleFlags, row.mfa_policy as MfaPolicy);
    req.authUser = {
      id: row.id,
      orgId: row.org_id,
      username: row.username,
      roles,
      permissions,
      scopes,
      mfaEnrollmentRequired,
      worker:claims.worker===true&&!claims.family,
    };
    /*
     * §075 -- an administrator looking through somebody else's eyes.
     *
     * Everything above deliberately ran against the subject: the roles, the
     * permissions, the scopes, the gates. A token that says "act" changes
     * nothing about what may be done, only who we say did it -- which is the
     * only honest way to test whether the scoping rules work.
     *
     * The register row is checked on every request, not just at the start,
     * so revoking an impersonation ends it now rather than whenever the
     * token happens to expire.
     */
    if (claims.act && claims.imp) {
      const live = await ctx.pool.query(
        `SELECT s.id, u.username
           FROM impersonation_sessions s
           JOIN users u ON u.id = s.actor_id
          WHERE s.id = $1 AND s.actor_id = $2 AND s.subject_id = $3
            AND s.ended_at IS NULL AND s.expires_at > now()
            AND u.auth_status = 'ACTIVE'`,
        [claims.imp, claims.act, row.id],
      );
      if (!live.rowCount) {
        throw new ApiError({ status: 401, code: 'INVALID_TOKEN', message: 'That view-as session has ended' });
      }
      req.authUser.impersonator = { id: claims.act, username: live.rows[0].username as string };
      req.authUser.impersonationId = claims.imp;
      /*
       * Borrowing somebody's screen is not permission to change the locks on
       * it. Their password, their authenticator, and anything that would let
       * the borrowed session outlive the impersonation stay theirs.
       */
      if (impersonationBlocks(req.url)) {
        throw new ApiError({
          status: 403,
          code: 'IMPERSONATION_FORBIDDEN',
          message: 'That is the account holder\'s own to change. Stop viewing as them first.',
        });
      }
    }
    /*
     * Background work is exempt, as it is from the password gate below.
     *
     * Both gates exist to put a *person* in front of a screen -- an
     * enrolment screen here, a change-password screen there -- and a worker
     * token has no screen to be put in front of. Blocking it stopped two
     * report schedules on the production VM, and the error they failed with
     * named MFA, which is not something anybody would connect to a report
     * that had simply stopped arriving.
     *
     * The account's own interactive access stays blocked, which is what the
     * requirement is for: the authority behind a schedule or an automation
     * rule was established when it was created, and re-checking the author's
     * enrolment at each run only breaks the work, it does not enrol anybody.
     */
    if(mfaEnrollmentRequired&&!req.authUser.worker&&!req.url.startsWith("/api/v1/auth/")&&!req.url.startsWith("/api/v1/devices/register"))throw new ApiError({status:403,code:"MFA_ENROLLMENT_REQUIRED",message:"Set up an authenticator in Account security before continuing"});
    /*
     * A password somebody else chose is a password somebody else knows (§34).
     *
     * An administrator resetting a password, or creating an account with a
     * starting one, leaves a shared secret. The account can sign in -- it has
     * to, or the password could never be changed -- and can do nothing else
     * until the person sets their own.
     *
     * Same shape as the MFA gate above, and deliberately so: the auth routes
     * stay open because the change itself lives there.
     *
     * Background work is exempt. The gate exists to route a *person* to the
     * change-password screen, and a worker token has no screen to be routed
     * to: blocking it would stop that account's scheduled reports and
     * automation rules with an error nobody would connect to a password
     * policy. Their interactive access stays blocked, which is the part that
     * matters -- the authority behind the automation was established when it
     * was created, not at each run.
     *
     * The MFA gate above is exempt for the same reason and in the same way.
     */
    if (row.must_change_password
        && !req.authUser.worker
        && !req.url.startsWith("/api/v1/auth/")) {
      throw new ApiError({
        status: 403,
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "Set your own password before continuing",
      });
    }
  };
}

/** RBAC gate: endpoint permission × user roles. 401 anon, 403 without leak. */
export function requirePermission(
  authenticate: (req: FastifyRequest) => Promise<void>,
  permission: string,
) {
  return requireAllPermissions(authenticate, [permission]);
}

/**
 * A gate that needs every one of several permissions.
 *
 * Exists for the routes where one permission names the action and another
 * names the thing it is done to. Somebody's personal file is the case that
 * forced it: `document.read` says you may read documents, and after the
 * company document register reused that code it was handed to inventory
 * managers, payroll officers and bid managers -- none of whom may open the
 * staff directory. So an inventory manager could list and download another
 * employee's identity documents while `/employees/:id` refused them.
 *
 * Each permission is checked, scoped and record-checked in turn, so a team
 * lead whose `employee.read` covers their own team sees only their team's
 * files. The scopes left on the request are those of the last permission.
 */
export function requireAllPermissions(
  authenticate: (req: FastifyRequest) => Promise<void>,
  permissions: readonly string[],
) {
  async function guard(req: FastifyRequest): Promise<void> {
    await authenticate(req);
    for (const permission of permissions) {
      if (!req.authUser?.permissions.includes(permission)) {
        /*
         * Still generic about the resource — naming it would reveal whether it
         * exists — but specific about the permission, which is the one thing
         * the person can actually act on. "Insufficient permissions" left them
         * with nothing to ask for and nobody to ask.
         */
        throw new ApiError({
          status: 403,
          code: "FORBIDDEN",
          message: `This needs the "${permission}" permission, which your roles do not include. `
            + "An administrator can add it to your role under Administration \u2192 Roles.",
        });
      }
      req.authUser!.scopes=await scopesForPermission(req,permission);
      if((permission.startsWith('payroll.')||permission.startsWith('inventory.')||permission==='webhook.manage'||permission==='admin.configure'||permission==='users.manage'||permission==='users.read')&&req.authUser!.scopes.length&&!req.authUser!.scopes.some(s=>!s.scope_type||!s.scope_id))throw new ApiError({status:403,code:'FORBIDDEN',message:'This organization-wide action requires organization-wide permission'});
      await enforceRecordScope(req, permission);
    }
  }
  // Metadata only, read by the contract test's onRoute hook (createApp.ts)
  // to build a route -> required-permissions registry mechanically, instead
  // of grepping route files. Never read at request time.
  (guard as { requiredPermissions?: readonly string[] }).requiredPermissions = permissions;
  return guard;
}

/**
 * A gate that needs at least one of several permissions.
 *
 * POST /api/v1/invoices is the first user of it (fix round 1, I4): creating
 * an invoice may be done under invoice.create (a narrow grant meant only for
 * that) or under invoice.manage (which already covers every other invoice
 * write, so a holder of it loses nothing). The scope left on the request,
 * and the record-scope check run, are for whichever permission the caller
 * actually holds -- the first match, in the order given.
 */
export function requireAnyPermission(
  authenticate: (req: FastifyRequest) => Promise<void>,
  permissions: readonly string[],
) {
  async function guard(req: FastifyRequest): Promise<void> {
    await authenticate(req);
    const held = permissions.find(p => req.authUser?.permissions.includes(p));
    if (!held) {
      throw new ApiError({
        status: 403,
        code: "FORBIDDEN",
        message: `This needs the "${permissions.join('" or "')}" permission, which your roles do not include. `
          + "An administrator can add it to your role under Administration → Roles.",
      });
    }
    req.authUser!.scopes = await scopesForPermission(req, held);
    if((held.startsWith('payroll.')||held.startsWith('inventory.')||held==='webhook.manage'||held==='admin.configure'||held==='users.manage'||held==='users.read')&&req.authUser!.scopes.length&&!req.authUser!.scopes.some(s=>!s.scope_type||!s.scope_id))throw new ApiError({status:403,code:'FORBIDDEN',message:'This organization-wide action requires organization-wide permission'});
    await enforceRecordScope(req, held);
  }
  // Same contract-registry metadata as requireAllPermissions, plus the "any"
  // mode, so the route matrix picks a negative tester holding none of them.
  (guard as { requiredPermissions?: readonly string[] }).requiredPermissions = permissions;
  (guard as { permissionMode?: "all" | "any" }).permissionMode = "any";
  return guard;
}

/** A global low-privilege role must not widen a different role's permission. */
/**
 * The permissions the visibility policy governs.
 *
 * Reading, and only reading: which projects and tasks somebody sees in a
 * list. What they may then do to one is decided by the permissions they
 * hold and by the record-scope rules, which already say a person may work a
 * task assigned to them or one they were added to.
 *
 * Narrowing the acting permissions here as well answers a question nobody
 * asked. It took a project manager's ability to close a project, a team
 * lead's ability to assign work, and — because every scoped read shares this
 * resolver — a manager's ability to approve their own team's leave.
 */
const SCOPED_TO_OWN_WORK=(permission:string):boolean=>
 permission==='task.read'||permission==='project.read'||permission==='cycle.read';

/**
 * What a role lets somebody see, and how much of it (§note 17).
 *
 * A role row with no scope used to mean the whole organisation, so the safe
 * setting was the one an administrator had to remember to apply — and mostly
 * did not. EMPLOYEE was the one exception, forced to self-scope in code
 * whatever the row said: the right behaviour arrived at the wrong way,
 * invisible and unconfigurable.
 *
 * Now the default comes from role_scope_policies, per organisation, because
 * the answer differs: a contractor running one district wants its project
 * managers to see everything, one running six does not. An explicit scope on
 * the role row still wins — it is narrower than any default and somebody set
 * it on purpose.
 */
export async function scopesForPermission(req:FastifyRequest,permission:string){
 const rows=(await req.server.db.query(
  `SELECT ur.scope_type, ur.scope_id, r.code,
          /*
           * Safe by default, including for an organisation created after
           * this was introduced: a policy row records a deviation, and its
           * absence must not mean "sees everything".
           */
          COALESCE(p.default_scope,
                   CASE WHEN r.code IN ('EMPLOYEE','TEAM_LEAD','PROJECT_MANAGER')
                        THEN 'ASSIGNED' ELSE 'GLOBAL' END) AS default_scope
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN role_scope_policies p
       ON p.role_code = r.code AND p.org_id = $3
    WHERE ur.user_id = $1 AND rp.permission_code = $2`,
  [req.authUser!.id,permission,req.authUser!.orgId])).rows;
 const scoped=rows
  .filter(r=>r.code!=='CLIENT_VIEWER'||r.scope_type==='project')
  .map(r=>{
   // An explicit scope was chosen for this person; a default never overrides it.
   if(r.scope_type&&r.scope_id)return {scope_type:r.scope_type as string,scope_id:r.scope_id as string};
   /*
    * The policy narrows the work, not the person (§note 17).
    *
    * It answers "which projects and tasks are mine", and applying it to
    * every scoped read answers a question nobody asked: a project manager
    * restricted to their own projects could no longer approve their team's
    * leave, and a team lead could not see the attendance they supervise.
    * Those are decided by the permissions they hold, which is where they
    * belong.
    */
   if(r.default_scope==='ASSIGNED'&&SCOPED_TO_OWN_WORK(permission)){
    return {scope_type:'self',scope_id:req.authUser!.id};
   }
   return {scope_type:null,scope_id:null};
  });
 return scoped.length?scoped:[{scope_type:'restricted',scope_id:req.authUser!.id}];
}

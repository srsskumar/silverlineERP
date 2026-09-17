import {enforceRecordScope} from "./recordScope.js";
import type { FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { ApiError, mfaRequired, type MfaPolicy } from "@silverline/shared";

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
    };
  }
}

interface AccessClaims {
  sub: string;
  org_id: string;
  type: string;
  family?: string;
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
    if(mfaEnrollmentRequired&&!req.url.startsWith("/api/v1/auth/")&&!req.url.startsWith("/api/v1/devices/register"))throw new ApiError({status:403,code:"MFA_ENROLLMENT_REQUIRED",message:"Set up an authenticator in Account security before continuing"});
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
     * The MFA gate above does block workers, and two report schedules on the
     * production VM fail that way today. That is a pre-existing security
     * decision rather than an oversight, so it is left alone; the fix there
     * is for those two accounts to enrol.
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
  return async function guard(req: FastifyRequest): Promise<void> {
    await authenticate(req);
    if (!req.authUser?.permissions.includes(permission)) {
      // Generic 403: never reveal whether the target resource exists.
      throw new ApiError({
        status: 403,
        code: "FORBIDDEN",
        message: "Insufficient permissions",
      });
    }
    req.authUser!.scopes=await scopesForPermission(req,permission);
    if((permission.startsWith('payroll.')||permission.startsWith('inventory.')||permission==='webhook.manage'||permission==='admin.configure'||permission==='users.manage'||permission==='users.read')&&req.authUser!.scopes.length&&!req.authUser!.scopes.some(s=>!s.scope_type||!s.scope_id))throw new ApiError({status:403,code:'FORBIDDEN',message:'This organization-wide action requires organization-wide permission'});
    await enforceRecordScope(req, permission);
  };
}

/** A global low-privilege role must not widen a different role's permission. */
export async function scopesForPermission(req:FastifyRequest,permission:string){
 const rows=(await req.server.db.query('SELECT ur.scope_type,ur.scope_id,r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id WHERE ur.user_id=$1 AND rp.permission_code=$2',[req.authUser!.id,permission])).rows;
 const scoped=rows.filter(r=>r.code!=='CLIENT_VIEWER'||r.scope_type==='project').map(r=>r.code==='EMPLOYEE'?{scope_type:'self',scope_id:req.authUser!.id}:({scope_type:r.scope_type as string|null,scope_id:r.scope_id as string|null}));
 return scoped.length?scoped:[{scope_type:'restricted',scope_id:req.authUser!.id}];
}

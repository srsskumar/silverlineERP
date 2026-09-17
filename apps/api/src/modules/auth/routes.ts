import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  ApiError,
  changePasswordSchema,
  mfaRequired,
  type MfaPolicy,
  loginSchema,
  logoutSchema,
  mfaVerifySchema,
  refreshSchema,
  toFieldErrors,
} from "@silverline/shared";
import { writeAudit } from "../../common/audit.js";
import { buildAuthenticate } from "../../common/auth.js";
import { sendError } from "../../common/httpErrors.js";
import { createLoginRateLimiter } from "../../common/rateLimit.js";
import {
  changePassword,
  disableMfa,
  login,
  logout,
  refresh,
  setupMfa,
  UnknownUserError,
  verifyMfa,
  type ServiceContext,
} from "./service.js";

export interface AuthRoutesOptions {
  pool: Pool;
  jwtSecret: string;
  loginRateLimitMax: number;
  loginRateLimitWindowMs: number;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const ctx: ServiceContext = { pool: opts.pool, jwtSecret: opts.jwtSecret };
  const authenticate = buildAuthenticate({ pool: opts.pool, jwtSecret: opts.jwtSecret });
  const loginRateLimit = createLoginRateLimiter({
    max: opts.loginRateLimitMax,
    windowMs: opts.loginRateLimitWindowMs,
  });

  const metaOf = (req: {
    ip: string;
    headers: Record<string, unknown>;
    requestId: string;
  }) => ({
    ip: req.ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : null,
    requestId: req.requestId,
  });

  app.post(
    "/api/v1/auth/login",
    { preHandler: loginRateLimit },
    async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      try {
        const result = await login(ctx, parsed.data, metaOf(req));
        const user = result.body["user"] as
          | { id: string; org_id: string }
          | undefined;
        await writeAudit(opts.pool, {
          orgId: user?.org_id ?? null,
          actorId: user?.id ?? null,
          actorIp: req.ip,
          actorUserAgent: metaOf(req).userAgent,
          action: "auth.login",
          entityType: "user",
          entityId: user?.id,
          requestId: req.requestId,
        });
        return reply.status(result.status).send(result.body);
      } catch (err) {
        if (err instanceof UnknownUserError) {
          await writeAudit(opts.pool, {
            orgId: null,
            actorId: null,
            actorIp: req.ip,
            actorUserAgent: metaOf(req).userAgent,
            action: "auth.login_failed",
            entityType: "user",
            reason: "unknown username",
            requestId: req.requestId,
          });
        } else if (err instanceof ApiError && ["INVALID_CREDENTIALS","INVALID_MFA_CODE","ACCOUNT_LOCKED"].includes(err.code)) {
          const row = await opts.pool.query(
            "SELECT id, org_id FROM users WHERE username = $1 ORDER BY created_at ASC LIMIT 1",
            [parsed.data.username],
          );
          const found = row.rows[0] as
            | { id: string; org_id: string }
            | undefined;
          await writeAudit(opts.pool, {
            orgId: found?.org_id ?? null,
            actorId: found?.id ?? null,
            actorIp: req.ip,
            actorUserAgent: metaOf(req).userAgent,
            action: "auth.login_failed",
            entityType: "user",
            entityId: found?.id,
            reason: err.code,
            requestId: req.requestId,
          });
        }
        throw err;
      }
    },
  );

  app.post("/api/v1/auth/refresh", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const result = await refresh(ctx, parsed.data.refresh_token, metaOf(req));
    const user = result.body["user"] as { id: string; org_id: string };
    await writeAudit(opts.pool, {
      orgId: user.org_id,
      actorId: user.id,
      actorIp: req.ip,
      actorUserAgent: metaOf(req).userAgent,
      action: "auth.refresh",
      entityType: "session",
      entityId: user.id,
      requestId: req.requestId,
    });
    return reply.status(result.status).send(result.body);
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const parsed = logoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    // Best-effort actor attribution: logout stays idempotent even anonymously.
    let actorId: string | null = null;
    let orgId: string | null = null;
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        const probe = { ...req };
        await authenticate(probe as typeof req);
        actorId = (probe as typeof req).authUser?.id ?? null;
        orgId = (probe as typeof req).authUser?.orgId ?? null;
      } catch {
        actorId = null;
      }
    }
    const { revoked } = await logout(ctx, parsed.data.refresh_token);
    if (revoked || parsed.data.refresh_token) {
      await writeAudit(opts.pool, {
        orgId,
        actorId,
        actorIp: req.ip,
        actorUserAgent: metaOf(req).userAgent,
        action: "auth.logout",
        entityType: "session",
        requestId: req.requestId,
      });
    }
    return reply.status(200).send({ success: true });
  });

  app.post(
    "/api/v1/auth/mfa/setup",
    { preHandler: authenticate },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        throw new ApiError({
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const out = await setupMfa(ctx, user.id);
      await writeAudit(opts.pool, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: req.ip,
        actorUserAgent: metaOf(req).userAgent,
        action: "auth.mfa_setup",
        entityType: "user",
        entityId: user.id,
        requestId: req.requestId,
      });
      return reply.status(200).send(out);
    },
  );

  app.post(
    "/api/v1/auth/mfa/verify",
    { preHandler: [authenticate,loginRateLimit] },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        throw new ApiError({
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const parsed = mfaVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      await verifyMfa(ctx, user.id, parsed.data.code);
      await writeAudit(opts.pool, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: req.ip,
        actorUserAgent: metaOf(req).userAgent,
        action: "auth.mfa_verified",
        entityType: "user",
        entityId: user.id,
        requestId: req.requestId,
      });
      return reply.status(200).send({ enabled: true, mfa_enabled: true });
    },
  );

  app.post(
    "/api/v1/auth/mfa/disable",
    { preHandler: [authenticate,loginRateLimit] },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        throw new ApiError({
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const parsed=mfaVerifySchema.safeParse(req.body);
      if(!parsed.success)throw new ApiError({status:422,code:'VALIDATION_ERROR',message:'The current authenticator code is required'});
      /*
       * Turning it off has to answer the same question as being made to turn
       * it on, or the gate is a revolving door: an account could enrol, be
       * let through, and disable it again on the next request.
       *
       * Read from the database rather than the token, because a role's
       * setting may have changed since this token was issued and the stricter
       * of the two answers is the one to act on.
       */
      const policy = (await opts.pool.query(
        `SELECT u.mfa_policy,
                COALESCE(json_agg(json_build_object('code', r.code,
                  'mfa_required', r.mfa_required)) FILTER (WHERE r.id IS NOT NULL),
                  '[]') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.id = $1 GROUP BY u.mfa_policy`, [user.id])).rows[0] as
          { mfa_policy: string; roles: Array<{ code: string; mfa_required: boolean }> }
          | undefined;
      if (app.appConfig.nodeEnv === 'production'
          && mfaRequired(policy?.roles ?? [], (policy?.mfa_policy ?? 'INHERIT') as MfaPolicy)) {
        throw new ApiError({
          status: 403, code: 'MFA_REQUIRED',
          message: 'Your role requires MFA. Ask an administrator for account recovery.',
        });
      }
      await disableMfa(ctx, user.id, parsed.data.code);
      await writeAudit(opts.pool, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: req.ip,
        actorUserAgent: metaOf(req).userAgent,
        action: "auth.mfa_disabled",
        entityType: "user",
        entityId: user.id,
        requestId: req.requestId,
      });
      return reply.status(200).send({ disabled: true, mfa_enabled: false });
    },
  );

  /**
   * Setting your own password (§34).
   *
   * Rate limited with the login limiter: guessing the current password here
   * is the same attack as guessing it at the login form, and leaving this
   * door unlimited would simply move it.
   */
  app.post(
    "/api/v1/auth/password",
    { preHandler: [authenticate, loginRateLimit] },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        throw new ApiError({
          status: 401, code: "UNAUTHENTICATED", message: "Authentication required",
        });
      }
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      await changePassword(ctx, user.id, parsed.data);
      await writeAudit(opts.pool, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: req.ip,
        actorUserAgent: metaOf(req).userAgent,
        action: "auth.password_changed",
        entityType: "user",
        entityId: user.id,
        requestId: req.requestId,
      });
      // Every session is gone, this one included: the change is only worth
      // making if whoever else knew the password is signed out by it.
      return reply.status(200).send({ changed: true, sessions_revoked: true });
    },
  );

  app.get(
    "/api/v1/auth/me",
    { preHandler: authenticate },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        throw new ApiError({
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const row = await opts.pool.query(
        `SELECT id, username, email, phone, org_id, auth_status,
                mfa_enabled, last_login_at
         FROM users WHERE id = $1`,
        [user.id],
      );
      const full = row.rows[0] as {
        id: string;
        username: string;
        email: string | null;
        phone: string | null;
        org_id: string;
        auth_status: string;
        mfa_enabled: boolean;
        last_login_at: Date | null;
      };
      return reply.status(200).send({
        user: {
          ...full,
          mfa_enrollment_required:user.mfaEnrollmentRequired,
          timezone:(await opts.pool.query("SELECT COALESCE(settings->>'timezone','Asia/Kolkata') AS timezone FROM organizations WHERE id=$1",[user.orgId])).rows[0].timezone,
          last_login_at: full.last_login_at?.toISOString() ?? null,
        },
        roles: user.roles,
        permissions: user.permissions,
      });
    },
  );
}

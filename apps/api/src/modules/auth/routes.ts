import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import jwt from "jsonwebtoken";
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
  canImpersonate,
  impersonateSchema,
  IMPERSONATION_DEFAULT_MINUTES,
} from "@silverline/shared";
import { writeAudit } from "../../common/audit.js";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { sendError } from "../../common/httpErrors.js";
import { createAuthRateLimit, typedAccount } from "../../common/rateLimit.js";
import {
  changePassword,
  disableMfa,
  login,
  logout,
  refresh,
  setupMfa,
  startImpersonation,
  endImpersonation,
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
  /*
   * One limiter per class of endpoint (AUTH-3), each counting by client
   * address and by account in separate buckets -- see createAuthRateLimit.
   * All in memory: the API is one process on one box, and that is what
   * makes a Map an honest count. A second process would need these moved
   * into the database.
   */
  const limit = (
    max: number,
    keys: Parameters<typeof createAuthRateLimit>[0]["keys"],
    message?: string,
  ) => createAuthRateLimit({ max, windowMs: opts.loginRateLimitWindowMs, keys, message });
  const byUser = (req: FastifyRequest) => ({ ip: req.ip, account: req.authUser?.id });
  // Guessing a password: by the name being guessed at, as well as by address.
  const loginRateLimit = limit(opts.loginRateLimitMax,
    (req) => ({ ip: req.ip, account: typedAccount(req) }),
    "Too many sign-in attempts, try again later");
  // Guessing a six-digit code, or a current password, from inside a session.
  const mfaRateLimit = limit(opts.loginRateLimitMax, byUser,
    "Too many authentication codes, try again later");
  const passwordRateLimit = limit(opts.loginRateLimitMax, byUser,
    "Too many password attempts, try again later");
  // Each request notifies people; the ten-minute rule below stops repeats
  // for one account, this stops one address walking through all of them.
  const resetRequestRateLimit = limit(opts.loginRateLimitMax,
    (req) => ({ ip: req.ip, account: typedAccount(req) }));
  /*
   * Refresh runs itself: every open tab and every phone refreshes every
   * fifteen minutes, and an office on one connection shares an address. So
   * it is looser than sign-in and counts by address only -- what it guards
   * against is somebody replaying guesses at a 256-bit token, which a limit
   * cannot make harder, and a loop hammering the database, which it can.
   */
  const refreshRateLimit = limit(opts.loginRateLimitMax * 6, (req) => ({ ip: req.ip }));
  // Each call writes a new secret or mints a token: nobody needs many.
  const mfaSetupRateLimit = limit(opts.loginRateLimitMax, byUser);
  const impersonateRateLimit = limit(opts.loginRateLimitMax, byUser);

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

  app.post("/api/v1/auth/refresh", { preHandler: refreshRateLimit }, async (req, reply) => {
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
    let bearer: { userId: string; family: string } | null = null;
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        // Object.create, not a spread: a spread drops the getters on the
        // request's prototype (req.server among them), so authenticate threw
        // on every probe and a sign-out was never attributed to anybody.
        const probe = Object.create(req) as typeof req;
        await authenticate(probe);
        actorId = (probe as typeof req).authUser?.id ?? null;
        orgId = (probe as typeof req).authUser?.orgId ?? null;
        // Verified just now by authenticate, so decoding is enough; the
        // family is the session this access token was issued under.
        const family = (jwt.decode(header.slice("Bearer ".length).trim()) as { family?: unknown } | null)?.family;
        if (actorId && typeof family === "string") bearer = { userId: actorId, family };
      } catch {
        actorId = null;
      }
    }
    const { revoked } = await logout(ctx, parsed.data.refresh_token, bearer);
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
    { preHandler: [authenticate, mfaSetupRateLimit] },
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
    { preHandler: [authenticate, mfaRateLimit] },
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
    { preHandler: [authenticate, mfaRateLimit] },
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
   * Rate limited like the login form: guessing the current password here is
   * the same attack as guessing it there, and leaving this door unlimited
   * would simply move it.
   */
  app.post(
    "/api/v1/auth/password",
    { preHandler: [authenticate, passwordRateLimit] },
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
        /*
         * §075. Null for everybody nearly all of the time; when it is not,
         * the web application has everything it needs to put a banner up
         * and offer the way out of it.
         */
        impersonation: user.impersonator
          ? {
              session_id: user.impersonationId ?? null,
              actor_id: user.impersonator.id,
              actor_username: user.impersonator.username,
            }
          : null,
      });
    },
  );

  /**
   * "I have forgotten my password" (§note 16).
   *
   * There was no way to ask. Changing a password needs you to be signed in,
   * which is exactly what somebody who has forgotten it cannot do, and a
   * crew member in a mandal three hours from the office had no route back
   * except telephoning whoever happened to know where the admin screen was.
   *
   * It raises a request and tells the people who can act on it: the person
   * they report to, the managers on their programmes, and the
   * administrators. No link is emailed and no password is generated — an
   * administrator sets one and hands it over, which in a field organisation
   * is how it actually happens.
   *
   * The answer is the same whether the account exists or not. Anything else
   * turns this into a way to find out who works here.
   */
  app.post(
    "/api/v1/auth/password-reset-request",
    { preHandler: resetRequestRateLimit },
    async (req, reply) => {
      const body = (req.body ?? {}) as { username?: string };
      const typed = String(body.username ?? "").trim();
      const said = {
        message:
          "If that account exists, the people who can reset it have been told. "
          + "Ask your team lead or supervisor — they will set a new password for you.",
      };
      if (!typed || typed.length > 255) return reply.status(202).send(said);

      // By sign-in name or by mobile number, because half the field staff
      // sign in with their phone and would not know their username.
      const digits = typed.replace(/\D/g, "").slice(-10);
      const found = (await opts.pool.query(
        `SELECT u.id, u.org_id, u.employee_id
           FROM users u
          WHERE u.auth_status = 'ACTIVE'
            AND (lower(u.username) = lower($1)
                 OR ($2 <> '' AND u.mobile_digits = $2))
          LIMIT 1`,
        [typed, digits],
      )).rows[0];
      if (!found) return reply.status(202).send(said);

      /*
       * One request per person per ten minutes.
       *
       * Without it, typing one username repeatedly is a way to fill every
       * manager's inbox, and the alert stops meaning anything the first time
       * it arrives twenty times.
       */
      const recent = (await opts.pool.query(
        `SELECT 1 FROM password_reset_requests
          WHERE user_id = $1 AND requested_at > now() - interval '10 minutes'
          LIMIT 1`,
        [found.id],
      )).rowCount;
      if (recent) return reply.status(202).send(said);

      const request = (await opts.pool.query(
        `INSERT INTO password_reset_requests(org_id, user_id, requested_as, requested_ip)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [found.org_id, found.id, typed, metaOf(req).ip ?? null],
      )).rows[0];

      const who = (await opts.pool.query(
        `SELECT COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), u.username)
                  AS name,
                e.emp_no
           FROM users u LEFT JOIN employees e ON e.id = u.employee_id
          WHERE u.id = $1`, [found.id])).rows[0];
      const label = who?.emp_no ? `${who.name} (${who.emp_no})` : (who?.name ?? typed);

      /*
       * Everybody who could actually do something about it.
       *
       * The person they report to first, because they are nearest and most
       * likely to know whether the request is genuine; then the managers of
       * the programmes they are on; then the administrators, who can always
       * act. Distinct, so somebody who is two of those gets told once.
       */
      const recipients = (await opts.pool.query(
        `SELECT DISTINCT m.id
           FROM users m
           LEFT JOIN employees me ON me.id = m.employee_id
           LEFT JOIN user_roles ur ON ur.user_id = m.id
           LEFT JOIN roles r ON r.id = ur.role_id
          WHERE m.org_id = $1 AND m.auth_status = 'ACTIVE' AND m.id <> $2
            AND (
              me.id = (SELECT e.reports_to FROM employees e WHERE e.id = $3)
              OR r.code IN ('SUPER_ADMIN','ADMIN','PROJECT_MANAGER','HR_MANAGER')
              OR (r.code = 'TEAM_LEAD' AND EXISTS (
                    SELECT 1 FROM survey_project_employees a
                    JOIN survey_project_employees b
                      ON b.survey_project_id = a.survey_project_id
                   WHERE a.employee_id = $3 AND a.released_on IS NULL
                     AND b.employee_id = me.id AND b.released_on IS NULL))
            )`,
        [found.org_id, found.id, found.employee_id],
      )).rows;

      for (const r of recipients) {
        await opts.pool.query(
          `INSERT INTO notifications(org_id, recipient_id, type, title, body,
             entity_type, entity_id)
           VALUES($1,$2,'PASSWORD_RESET_REQUEST',$3,$4,'password_reset_request',$5)`,
          [found.org_id, r.id,
           `${label} cannot sign in`,
           "They have asked for their password to be reset. Set a new one under "
             + "Administration, then tell them what it is.",
           request.id],
        );
      }

      await writeAudit(opts.pool, {
        orgId: found.org_id,
        actorId: found.id,
        action: "auth.password_reset.requested",
        entityType: "user",
        entityId: found.id,
        afterState: { requested_as: typed, told: recipients.length },
        requestId: req.requestId,
      });

      return reply.status(202).send(said);
    },
  );

  /* =============================================================== §075
   * Viewing the application as another user.
   *
   * Built because there was no honest way to answer "what can a team lead
   * on that programme actually see?" short of making an account, giving it
   * the roles, and logging in as it -- which nobody does, so the scoping
   * rules went untested until somebody in a mandal found the hole.
   *
   * It is deliberately not a read-only preview. A preview would answer the
   * easy half of the question (what is on the screen) and none of the hard
   * half (what happens when they press the button).
   */

  app.get(
    "/api/v1/auth/impersonate/targets",
    { preHandler: requirePermission(authenticate, "admin.impersonate") },
    async (req, reply) => {
      const me = req.authUser!;
      const q = String((req.query as { q?: string } | undefined)?.q ?? "").trim();
      const rows = await opts.pool.query(
        `SELECT u.id, u.username, u.email, u.auth_status,
                COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
                COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
                TRIM(CONCAT_WS(' ', e.first_name, e.last_name)) AS full_name,
                e.designation
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id
           LEFT JOIN roles r ON r.id = ur.role_id
           LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
           LEFT JOIN employees e ON e.id = u.employee_id
          WHERE u.org_id = $1 AND u.id <> $2 AND u.auth_status = 'ACTIVE'
            AND ($3 = '' OR u.username ILIKE '%' || $3 || '%'
                 OR CONCAT_WS(' ', e.first_name, e.last_name) ILIKE '%' || $3 || '%')
          GROUP BY u.id, u.username, u.email, u.auth_status, e.first_name, e.last_name, e.designation
          ORDER BY COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''), u.username)
          LIMIT 200`,
        [me.orgId, me.id, q],
      );
      /*
       * Every candidate is returned, allowed or not, each carrying the
       * reason. A picker that silently omits the accounts you may not hold
       * teaches nobody anything; one that shows them greyed out with "that
       * account can do things you cannot" explains the rule in the place
       * where the question is being asked.
       */
      return reply.status(200).send({
        data: rows.rows.map((r) => {
          const verdict = canImpersonate(
            { id: me.id, roles: me.roles, permissions: me.permissions },
            { id: r.id as string, roles: r.roles as string[], permissions: r.permissions as string[] },
          );
          return {
            id: r.id,
            username: r.username,
            full_name: r.full_name,
            designation: r.designation,
            roles: r.roles,
            permission_count: (r.permissions as string[]).length,
            allowed: verdict.ok,
            blocked_reason: verdict.ok ? null : verdict.reason,
          };
        }),
      });
    },
  );

  app.post(
    "/api/v1/auth/impersonate",
    { preHandler: [requirePermission(authenticate, "admin.impersonate"), impersonateRateLimit] },
    async (req, reply) => {
      const me = req.authUser!;
      const parsed = impersonateSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const out = await startImpersonation(ctx, {
        actor: { id: me.id, orgId: me.orgId, roles: me.roles, permissions: me.permissions },
        subjectId: parsed.data.user_id,
        reason: parsed.data.reason,
        minutes: parsed.data.minutes ?? IMPERSONATION_DEFAULT_MINUTES,
        ip: req.ip,
        userAgent: metaOf(req).userAgent,
        requestId: req.requestId,
      });
      await writeAudit(opts.pool, {
        orgId: me.orgId,
        actorId: me.id,
        actorIp: req.ip,
        actorUserAgent: metaOf(req).userAgent,
        action: "auth.impersonation_started",
        entityType: "user",
        entityId: out.subject.id,
        reason: parsed.data.reason,
        afterState: { session_id: out.session_id, expires_at: out.expires_at, subject: out.subject.username },
        requestId: req.requestId,
      });
      return reply.status(201).send(out);
    },
  );

  /*
   * Stopping works from either side, because either token may be the one in
   * the browser's hand: the borrowed one (the ordinary case -- the button
   * is on the banner) or the administrator's own (they closed the tab and
   * came back). Notably it does NOT require admin.impersonate, since while
   * impersonating an employee the session does not hold it -- requiring it
   * would trap the administrator inside the session they asked to leave.
   */
  app.post(
    "/api/v1/auth/impersonate/stop",
    { preHandler: authenticate },
    async (req, reply) => {
      const me = req.authUser!;
      const actorId = me.impersonator?.id ?? me.id;
      const out = await endImpersonation(ctx, { actorId });
      if (out.ended) {
        await writeAudit(opts.pool, {
          orgId: me.orgId,
          actorId,
          actorIp: req.ip,
          actorUserAgent: metaOf(req).userAgent,
          action: "auth.impersonation_ended",
          entityType: "user",
          entityId: out.subject_id,
          requestId: req.requestId,
        });
      }
      return reply.status(200).send(out);
    },
  );
}

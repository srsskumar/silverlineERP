import {encryptPii,decryptPii} from "../../common/crypto.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import type { Pool, PoolClient } from "pg";
import { ApiError, indianMobile } from "@silverline/shared";

export const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Thrown when the login username matches no account (audited without actor). */
export class UnknownUserError extends ApiError {
  constructor() {
    super({
      status: 401,
      code: "INVALID_CREDENTIALS",
      message: "Invalid username or password",
    });
    this.name = "UnknownUserError";
  }
}

interface UserRow {
  id: string;
  org_id: string;
  username: string;
  email: string | null;
  phone: string | null;
  auth_status: string;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  failed_login_attempts: number;
  locked_until: string | null;
  password_hash: string;
  last_login_at: string | null;
  must_change_password: boolean;
}

export interface ServiceContext {
  pool: Pool | PoolClient;
  jwtSecret: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rolesAndPermissions(
  pool: Pool | PoolClient,
  userId: string,
): Promise<{ roles: string[]; permissions: string[] }> {
  const rolesRes = await pool.query(
    `SELECT r.code FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [userId],
  );
  const permsRes = await pool.query(
    `SELECT DISTINCT rp.permission_code FROM role_permissions rp
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return {
    roles: rolesRes.rows.map((r) => (r as { code: string }).code),
    permissions: permsRes.rows.map(
      (r) => (r as { permission_code: string }).permission_code,
    ),
  };
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

async function issueSession(
  ctx: ServiceContext,
  user: { id: string; orgId: string },
  opts: { family?: string; device?: string | null; deviceId?: string | null; ip?: string | null },
): Promise<TokenPair & { family: string }> {
  const { roles, permissions } = await rolesAndPermissions(ctx.pool, user.id);
  const family = opts.family ?? randomUUID();
  const access_token = jwt.sign(
    {
      sub: user.id,
      org_id: user.orgId,
      roles,
      permissions,
      type: "access",
      family,
    },
    ctx.jwtSecret,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );
  const refresh_token = randomBytes(32).toString("hex");
  await ctx.pool.query(
    `INSERT INTO sessions (user_id, refresh_hash, family, device, ip, expires_at, device_id)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::INTERVAL,$7)`,
    [
      user.id,
      sha256Hex(refresh_token),
      family,
      opts.device ?? null,
      opts.ip ?? null,
      String(REFRESH_TOKEN_TTL_MS),
      opts.deviceId??null,
    ],
  );
  return { access_token, refresh_token, family };
}

export interface LoginResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Find the account somebody is signing in to (§34).
 *
 * By username, or by mobile number. A field crew member knows their own
 * number; they do not know "user_slv001_19" and will not keep it, so in
 * practice somebody else logs in for them and the attendance and progress
 * records stop meaning what they say.
 *
 * The username is tried first and exactly. A number is only looked up when
 * what was typed is an Indian mobile in the first place, so an account whose
 * username happens to be numeric still authenticates as itself.
 *
 * Two accounts cannot share a number -- a unique index refuses it -- but the
 * query is written not to trust that: an ambiguous match returns nobody
 * rather than picking one, because picking one means signing somebody into
 * another person's account.
 */
async function findLoginUser(
  ctx: ServiceContext, identifier: string,
): Promise<UserRow | undefined> {
  const byName = await ctx.pool.query(
    "SELECT * FROM users WHERE username = $1 ORDER BY created_at ASC LIMIT 1",
    [identifier],
  );
  if (byName.rows[0]) return byName.rows[0] as UserRow;

  const digits = indianMobile(identifier);
  if (!digits) return undefined;

  // LIMIT 2, so an ambiguous number is visible rather than silently resolved.
  const byMobile = await ctx.pool.query(
    "SELECT * FROM users WHERE mobile_digits = $1 LIMIT 2",
    [digits],
  );
  if (byMobile.rowCount !== 1) return undefined;
  return byMobile.rows[0] as UserRow;
}

export async function login(
  ctx: ServiceContext,
  input: { username: string; password: string; totp_code?: string; device_id?:string },
  meta: { ip?: string | null; userAgent?: string | null; requestId: string },
): Promise<LoginResult> {
  const user = await findLoginUser(ctx, input.username);

  if (!user) {
    throw new UnknownUserError();
  }

  if (
    user.locked_until !== null &&
    new Date(user.locked_until).getTime() > Date.now()
  ) {
    throw new ApiError({
      status: 423,
      code: "ACCOUNT_LOCKED",
      message: "Account is temporarily locked due to failed login attempts",
      retryable: true,
    });
  }

  if (user.auth_status !== "ACTIVE") {
    // Same generic shape as a bad password: do not leak account state.
    throw invalidCredentials();
  }

  const passwordOk = await bcrypt.compare(input.password, user.password_hash);
  if (!passwordOk) {
    await recordFailedAttempt(ctx,user.id);
    throw invalidCredentials();
  }

  if (user.mfa_enabled) {
    if (!input.totp_code) {
      // No audit: no authentication decision was made yet.
      return {
        status: 200,
        body: { mfa_required: true as const },
      };
    }
    const codeOk = await consumeTotp(ctx, user.id, user.mfa_secret, input.totp_code);
    if (!codeOk) {
      await recordFailedAttempt(ctx,user.id);
      throw new ApiError({
        status: 401,
        code: "INVALID_MFA_CODE",
        message: "Invalid authentication code",
      });
    }
  }

  if(input.device_id&&(await ctx.pool.query('SELECT 1 FROM device_registrations WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NOT NULL',[user.id,input.device_id])).rowCount)throw new ApiError({status:401,code:'DEVICE_REVOKED',message:'This device is revoked'});
  await ctx.pool.query(
    `UPDATE users SET failed_login_attempts = 0, locked_until = NULL,
       last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [user.id],
  );
  const { roles } = await rolesAndPermissions(ctx.pool, user.id);
  const pair = await issueSession(
    ctx,
    { id: user.id, orgId: user.org_id },
    { ip: meta.ip, device:meta.userAgent, deviceId:input.device_id },
  );
  return {
    status: 200,
    body: {
      access_token: pair.access_token,
      refresh_token: pair.refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      mfa_required: false as const,
      // So the app can send them straight to the change screen rather than
      // to a home page where every request would come back 403.
      must_change_password: user.must_change_password === true,
      user: {
        id: user.id,
        username: user.username,
        org_id: user.org_id,
        roles,
      },
    },
  };
}

/**
 * Setting your own password (§34).
 *
 * Requires the current one. Without that, anybody holding a token that leaked
 * from a shared phone could lock the owner out of their own account, and a
 * token is far easier to come by than a password.
 *
 * Every other session is revoked. If the reason for changing it is that
 * somebody else knows it, leaving their session alive defeats the change.
 */
export async function changePassword(
  ctx: ServiceContext,
  userId: string,
  input: { current_password: string; new_password: string },
): Promise<{ changed: true }> {
  const row = (await ctx.pool.query(
    "SELECT id, password_hash, must_change_password FROM users WHERE id = $1",
    [userId])).rows[0] as
      { id: string; password_hash: string; must_change_password: boolean } | undefined;
  if (!row) throw invalidCredentials();

  const ok = await bcrypt.compare(input.current_password, row.password_hash);
  if (!ok) {
    throw new ApiError({
      status: 401,
      code: "INVALID_CREDENTIALS",
      message: "That is not your current password",
    });
  }

  // Changing it to what it already is clears the must-change flag without
  // changing anything, which is the whole of the protection defeated.
  if (await bcrypt.compare(input.new_password, row.password_hash)) {
    throw new ApiError({
      status: 422,
      code: "PASSWORD_UNCHANGED",
      message: "Choose a password you have not been given",
    });
  }

  const hash = await bcrypt.hash(input.new_password, 12);
  await ctx.pool.query(
    `UPDATE users SET password_hash = $2, must_change_password = false,
       password_set_at = now(), updated_at = now() WHERE id = $1`,
    [userId, hash]);
  await ctx.pool.query(
    "UPDATE sessions SET revoked = true, revoked_at = now() WHERE user_id = $1 AND revoked = false",
    [userId]);
  return { changed: true };
}

/** Generic credential failure: identical message for every bad-password case. */
function invalidCredentials(): ApiError {
  return new ApiError({
    status: 401,
    code: "INVALID_CREDENTIALS",
    message: "Invalid username or password",
  });
}

export async function refresh(
  ctx: ServiceContext,
  refreshToken: string,
  meta: { ip?: string | null; userAgent?: string | null; requestId: string },
): Promise<LoginResult> {
  const client = await (ctx.pool as Pool).connect();
  try {
    await client.query('BEGIN');
    const result = await rotateRefresh({ ...ctx, pool: client }, refreshToken, meta);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Security revocations must survive a rejected replay.
    await client.query(error instanceof ApiError ? 'COMMIT' : 'ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function rotateRefresh(
  ctx: ServiceContext,
  refreshToken: string,
  meta: { ip?: string | null; userAgent?: string | null; requestId: string },
): Promise<LoginResult> {
  const hash = sha256Hex(refreshToken);
  const sessRes = await ctx.pool.query(
    `SELECT s.*, u.org_id, u.username, u.auth_status, COALESCE(s.last_used_at,s.created_at) <= now()-COALESCE((o.settings->>'session_timeout_minutes')::int,10080)*interval '1 minute' AS idle_expired
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id=u.org_id
     WHERE s.refresh_hash = $1 FOR UPDATE OF s`,
    [hash],
  );
  const sess = sessRes.rows[0] as
    | {
        id: string;
        user_id: string;
        family: string;
        revoked: boolean;
        expires_at: string;
        org_id: string;
        username: string;
        auth_status: string;
        device_id:string|null;
        idle_expired:boolean;
      }
    | undefined;

  if (!sess) {
    throw new ApiError({
      status: 401,
      code: "INVALID_REFRESH_TOKEN",
      message: "Invalid refresh token",
    });
  }

  if(sess.device_id&&(await ctx.pool.query('SELECT 1 FROM device_registrations WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NOT NULL',[sess.user_id,sess.device_id])).rowCount)throw new ApiError({status:401,code:'DEVICE_REVOKED',message:'This device is revoked'});
  if (sess.revoked) {
    // Reuse detected: revoke the whole token family (possible theft).
    await ctx.pool.query(
      "UPDATE sessions SET revoked = true, revoked_at = NOW() WHERE family = $1",
      [sess.family],
    );
    throw new ApiError({
      status: 401,
      code: "REFRESH_TOKEN_REUSED",
      message: "Refresh token reuse detected",
    });
  }

  if (sess.idle_expired || new Date(sess.expires_at).getTime() <= Date.now()) {
    await ctx.pool.query(
      "UPDATE sessions SET revoked = true, revoked_at = NOW() WHERE id = $1",
      [sess.id],
    );
    throw new ApiError({
      status: 401,
      code: "INVALID_REFRESH_TOKEN",
      message: "Invalid refresh token",
    });
  }

  if (sess.auth_status !== "ACTIVE") {
    throw new ApiError({
      status: 401,
      code: "INVALID_REFRESH_TOKEN",
      message: "Invalid refresh token",
    });
  }


  // Single-use rotation: retire the presented token, issue same-family successor.
  await ctx.pool.query(
    "UPDATE sessions SET revoked = true, revoked_at = NOW(), last_used_at = NOW() WHERE id = $1",
    [sess.id],
  );
  const { roles } = await rolesAndPermissions(ctx.pool, sess.user_id);
  const pair = await issueSession(
    ctx,
    { id: sess.user_id, orgId: sess.org_id },
    { family: sess.family, ip: meta.ip, device:meta.userAgent, deviceId:sess.device_id },
  );
  return {
    status: 200,
    body: {
      access_token: pair.access_token,
      refresh_token: pair.refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      mfa_required: false as const,
      user: {
        id: sess.user_id,
        username: sess.username,
        org_id: sess.org_id,
        roles,
      },
    },
  };
}

/** Revokes one session by refresh token. Idempotent: unknown/already-revoked → ok. */
export async function logout(
  ctx: ServiceContext,
  refreshToken: string | undefined,
): Promise<{ revoked: boolean }> {
  if (!refreshToken) {
    return { revoked: false };
  }
  const res = await ctx.pool.query(
    `UPDATE sessions SET revoked = true, revoked_at = NOW()
     WHERE family = (SELECT family FROM sessions WHERE refresh_hash = $1) AND revoked = false`,
    [sha256Hex(refreshToken)],
  );
  return { revoked: (res.rowCount ?? 0) > 0 };
}

export async function setupMfa(
  ctx: ServiceContext,
  userId: string,
): Promise<{ secret: string; otpauth_url: string }> {
  const userRes = await ctx.pool.query(
    "SELECT username, mfa_enabled FROM users WHERE id = $1",
    [userId],
  );
  const row = userRes.rows[0] as { username: string; mfa_enabled: boolean } | undefined;
  if (!row) {
    throw new ApiError({
      status: 401,
      code: "INVALID_TOKEN",
      message: "Invalid or expired token",
    });
  }
  const secret = authenticator.generateSecret();
  if (row.mfa_enabled) throw new ApiError({ status: 409, code: 'MFA_ALREADY_ENABLED', message: 'Disable the existing authenticator before replacing it' });
  await ctx.pool.query(
    "UPDATE users SET mfa_secret = $1, mfa_last_counter = NULL, updated_at = NOW() WHERE id = $2",
    [encryptPii(secret), userId],
  );
  return {
    secret,
    otpauth_url: authenticator.keyuri(row.username, "Silverline ERP", secret),
  };
}

export async function verifyMfa(
  ctx: ServiceContext,
  userId: string,
  code: string,
): Promise<void> {
  const userRes = await ctx.pool.query(
    "SELECT mfa_secret FROM users WHERE id = $1",
    [userId],
  );
  const row = userRes.rows[0] as { mfa_secret: string | null } | undefined;
  if (!(await consumeTotp(ctx, userId, row?.mfa_secret ?? null, code))) {
    throw new ApiError({
      status: 401,
      code: "INVALID_MFA_CODE",
      message: "Invalid authentication code",
    });
  }
  await ctx.pool.query(
    "UPDATE users SET mfa_enabled = true, updated_at = NOW() WHERE id = $1",
    [userId],
  );
  await ctx.pool.query('UPDATE sessions SET revoked=true,revoked_at=now() WHERE user_id=$1',[userId]);
}

export async function disableMfa(ctx: ServiceContext, userId: string, code: string): Promise<void> {
  await verifyMfa(ctx,userId,code);

  await ctx.pool.query(
    // The spent-counter is cleared with the secret: a later re-enrolment gets a
    // new secret, and a counter inherited from the old one would reject its
    // first codes until wall-clock time caught up.
    "UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_last_counter = NULL, updated_at = NOW() WHERE id = $1",
    [userId],
  );
}

export async function revokeFamily(ctx: ServiceContext, family: string): Promise<void> {
  await ctx.pool.query(
    "UPDATE sessions SET revoked = true, revoked_at = NOW() WHERE family = $1",
    [family],
  );
}

function mfaSecret(value:string):string { return value.startsWith('gcm1.') ? decryptPii(value) : value; }

/** TOTP step length in seconds — otplib's default, restated so the counter math is explicit. */
const TOTP_STEP_SECONDS = 30;

/**
 * How many steps on either side of "now" a code may come from.
 *
 * Zero — a code is valid only for its own 30-second step — is both otplib's
 * default and this deployment's policy. It is stated explicitly because the
 * clock-skew window is a security decision rather than an incidental library
 * default, and because §14.1 requires the accepted window to be deterministic.
 */
export const TOTP_SKEW_STEPS = 0;
authenticator.options = { window: TOTP_SKEW_STEPS };

/** The step counter a TOTP code belongs to, or null when it matches none. */
function totpCounter(code: string, secret: string, at: number = Date.now()): number | null {
  // checkDelta answers "how many steps away from now", honouring the window
  // configured above, so the counter stays correct if that window ever widens.
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null || delta === undefined) return null;
  return Math.floor(at / 1000 / TOTP_STEP_SECONDS) + delta;
}

/**
 * Verifies a TOTP code and spends it.
 *
 * `authenticator.check` alone leaves a code replayable for the rest of its
 * step: anyone who observes it — in transit, over a shoulder, in a screenshot —
 * can present it again within the same window. Recording the highest counter a
 * user has spent makes each code single-use, which is what §14.1's replay
 * policy asks for. The compare-and-set is done in the UPDATE's WHERE clause, so
 * two concurrent logins racing with the same code cannot both win.
 */
async function consumeTotp(
  ctx: ServiceContext,
  userId: string,
  encryptedSecret: string | null,
  code: string,
): Promise<boolean> {
  if (!encryptedSecret) return false;
  const secret = mfaSecret(encryptedSecret);
  if (!authenticator.check(code, secret)) return false;
  const counter = totpCounter(code, secret);
  // A code that checks out but cannot be placed in a step is not something we
  // can protect against replay, so refuse it rather than accept it blindly.
  if (counter === null) return false;
  const spent = await ctx.pool.query(
    `UPDATE users SET mfa_last_counter = $2, updated_at = NOW()
      WHERE id = $1 AND (mfa_last_counter IS NULL OR mfa_last_counter < $2)`,
    [userId, counter],
  );
  return (spent.rowCount ?? 0) > 0;
}
async function recordFailedAttempt(ctx:ServiceContext,id:string):Promise<void> {
 const result=await ctx.pool.query("UPDATE users SET failed_login_attempts=CASE WHEN locked_until<now() THEN 1 ELSE failed_login_attempts+1 END,locked_until=CASE WHEN (CASE WHEN locked_until<now() THEN 1 ELSE failed_login_attempts+1 END)>=$2 THEN now()+($3||' milliseconds')::interval ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING failed_login_attempts",[id,MAX_FAILED_ATTEMPTS,String(LOCKOUT_MS)]);
 if(result.rows[0].failed_login_attempts>=MAX_FAILED_ATTEMPTS)throw new ApiError({status:423,code:'ACCOUNT_LOCKED',message:'Account is temporarily locked due to failed login attempts',retryable:true});
}

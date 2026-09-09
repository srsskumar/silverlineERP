import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { isValidIdempotencyKey } from "@silverline/shared";

function headerKey(req: FastifyRequest): string | null {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  return key && isValidIdempotencyKey(key.trim()) ? key.trim() : null;
}

/**
 * Idempotency-Key replay for POST endpoints (reuses the S0
 * `idempotency_keys` table). Returns the stored response when this key was
 * already applied (same method+path and unexpired), otherwise null and the
 * caller must process + {@link storeIdempotentResponse}.
 */
export async function replayIfSeen(
  pool: Pool,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const key = headerKey(req);
  if (!key) {
    return false;
  }
  const res = await pool.query(
    `SELECT status_code, response_body FROM idempotency_keys
      WHERE key = $1 AND method = $2 AND path = $3 AND user_id = $4`,
    [key, req.method, req.url.split("?")[0], req.authUser?.id ?? null],
  );
  const row = res.rows[0] as
    | { status_code: number; response_body: unknown }
    | undefined;
  if (!row) {
    return false;
  }
  await reply.status(row.status_code).send(row.response_body);
  return true;
}

export function idempotencyKeyOf(req: FastifyRequest): string | null {
  return headerKey(req);
}

/** Persists the response for a processed idempotent request (best-effort). */
export async function storeIdempotentResponse(
  pool: Pool,
  req: FastifyRequest,
  userId: string | null,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const key = headerKey(req);
  if (!key) {
    return;
  }
  try {
    await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, method, path, status_code, response_body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id,key) DO NOTHING`,
      [
        key,
        userId,
        req.method,
        req.url.split("?")[0],
        statusCode,
        JSON.stringify(body),
      ],
    );
  } catch (err) {
    throw err;
  }
}

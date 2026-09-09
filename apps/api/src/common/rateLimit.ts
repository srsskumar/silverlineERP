import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "@silverline/shared";

export interface LoginRateLimitOptions {
  max: number;
  windowMs: number;
}

/**
 * Minimal in-memory fixed-window login rate limiter (S0: 10/min/IP).
 * Single-process by design for the one-box lean deployment; the window map
 * is bounded because keys expire out of the window.
 */
export function createLoginRateLimiter(opts: LoginRateLimitOptions) {
  const hits = new Map<string, number[]>();

  return async function loginRateLimit(req: FastifyRequest): Promise<void> {
    const key = req.ip;
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    if(hits.size>=10000){for(const [id,times] of hits)if((times.at(-1)??0)<=windowStart)hits.delete(id);if(hits.size>=10000)hits.delete(hits.keys().next().value!);}
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= opts.max) {
      throw new ApiError({
        status: 429,
        code: "RATE_LIMITED",
        message: "Too many login attempts, try again later",
        retryable: true,
      });
    }
    recent.push(now);
    hits.set(key, recent);
  };
}

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  /**
   * Key selector. Defaults to the authed user id, falling back to the
   * request IP for anonymous callers (S6 punch limiter convention).
   */
  keyOf?: (req: FastifyRequest) => string;
  code?: string;
  message?: string;
}

/**
 * Generic in-memory fixed-window rate limiter (S6). Single-process by design
 * for the one-box lean deployment. On exceed it sends a 429 RATE_LIMITED
 * envelope with `retryable: true` and a top-level `retry_after_ms` hint
 * (ms until the oldest hit in the window expires).
 */
export function createRateLimiter(opts: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  return async function rateLimit(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = opts.keyOf
      ? opts.keyOf(req)
      : ((req.authUser?.id ?? req.ip) as string);
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    if(hits.size>=10000){for(const [id,times] of hits)if((times.at(-1)??0)<=windowStart)hits.delete(id);if(hits.size>=10000)hits.delete(hits.keys().next().value!);}
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= opts.max) {
      const retryAfterMs = Math.max(0, (recent[0] ?? now) + opts.windowMs - now);
      await reply.status(429).send({
        code: opts.code ?? "RATE_LIMITED",
        message: opts.message ?? "Too many requests, try again later",
        field_errors: [],
        request_id: req.requestId ?? "unknown",
        retryable: true,
        retry_after_ms: retryAfterMs,
      });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
  };
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./httpErrors.js";

/**
 * One fixed-window counter: how many times a key was seen in the last window.
 *
 * In memory, on purpose and with a known cost. The API runs as one process on
 * one box behind nginx, so one process's memory is the whole picture. Two
 * processes (a cluster, a second VM behind a load balancer) would each count
 * separately and every limit here would silently double -- at that point
 * this belongs in Postgres or Redis. A restart forgets every count, which
 * is acceptable for limits measured in minutes.
 *
 * Bounded: keys fall out of the window, and past 10,000 live keys the stale
 * ones are swept and then the oldest dropped, so a flood of distinct keys
 * cannot grow the map without limit.
 */
export function createWindowCounter(opts: { max: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  const recentFor = (key: string, now: number) =>
    (hits.get(key) ?? []).filter((t) => t > now - opts.windowMs);
  return {
    /** Milliseconds until `key` may try again; 0 when it may try now. */
    wait(key: string, now = Date.now()): number {
      const recent = recentFor(key, now);
      if (recent.length < opts.max) return 0;
      return Math.max(1, (recent[recent.length - opts.max] ?? now) + opts.windowMs - now);
    },
    record(key: string, now = Date.now()): void {
      const windowStart = now - opts.windowMs;
      if (hits.size >= 10000) {
        for (const [id, times] of hits) if ((times.at(-1) ?? 0) <= windowStart) hits.delete(id);
        if (hits.size >= 10000) hits.delete(hits.keys().next().value!);
      }
      const recent = recentFor(key, now);
      recent.push(now);
      hits.set(key, recent);
    },
  };
}

export interface AuthRateLimitOptions {
  max: number;
  windowMs: number;
  /**
   * The buckets a request counts against, by dimension -- typically
   * `{ ip: req.ip, account: <username or user id> }`. Each dimension has its
   * own counter, so a key in one can never be confused with a key in
   * another. A dimension that returns undefined or '' is not counted.
   */
  keys: (req: FastifyRequest) => Record<string, string | undefined>;
  message?: string;
}

/**
 * A limiter for one class of authentication endpoint (AUTH-3).
 *
 * Counting by address alone is not enough and never was: behind nginx
 * every request used to arrive from 127.0.0.1, so the whole organisation
 * shared one bucket of ten logins a minute -- a lockout for everybody at
 * nine in the morning and no protection at all against somebody patient.
 * With the real address restored (trustProxy), an address bucket stops one
 * machine hammering; an account bucket stops many machines taking turns at
 * one account, which an address bucket alone cannot see.
 *
 * Each endpoint class gets its own instance, so a busy refresh loop cannot
 * use up somebody's login attempts, or the other way round.
 *
 * A refused request is not counted, so waiting out the Retry-After is
 * always enough; counting refusals would let a client that retries too
 * eagerly lock itself out for ever.
 */
export function createAuthRateLimit(opts: AuthRateLimitOptions) {
  const counters = new Map<string, ReturnType<typeof createWindowCounter>>();
  const counter = (dimension: string) => {
    let c = counters.get(dimension);
    if (!c) counters.set(dimension, (c = createWindowCounter(opts)));
    return c;
  };
  return async function authRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    const now = Date.now();
    const keys = Object.entries(opts.keys(req)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    );
    const wait = Math.max(0, ...keys.map(([dimension, key]) => counter(dimension).wait(key, now)));
    if (wait > 0) {
      // Whole seconds, rounded up: Retry-After has no finer unit, and
      // rounding down would invite a retry that is refused again.
      reply.header("Retry-After", String(Math.ceil(wait / 1000)));
      return sendError(reply, req.requestId ?? "unknown", {
        status: 429,
        code: "RATE_LIMITED",
        message: opts.message ?? "Too many attempts, try again later",
        retryable: true,
      });
    }
    for (const [dimension, key] of keys) counter(dimension).record(key, now);
  };
}

/** The sign-in name as typed, folded so "Admin" and "admin " share a bucket. */
export function typedAccount(req: FastifyRequest): string | undefined {
  const body = req.body as { username?: unknown } | undefined;
  return typeof body?.username === "string" ? body.username.trim().toLowerCase().slice(0, 255) : undefined;
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
      // Optional call: unit tests hand in a bare reply without header().
      reply.header?.("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
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

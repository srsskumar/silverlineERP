/**
 * Pure sync-queue policy helpers — dependency-free (importable from node:test).
 * No expo-sqlite / fetch / timers here; queue.ts wires these to storage.
 */

/** One active op per entity+op pair (spec D). */
export function dedupeKey(entity: string, op: string): string {
  return `${entity}::${op}`;
}

export interface BackoffOptions {
  /** First delay. Default 1s. */
  baseMs?: number;
  /** Hard ceiling. Default 5 min. */
  capMs?: number;
  /** Random source (inject a stub in tests for determinism). */
  random?: () => number;
}

/**
 * Exponential backoff with full jitter: delay = min(cap, base * 2^retry) and
 * then uniform(0, delay). retryCount is 0-based (0 = first retry).
 */
export function computeBackoffMs(
  retryCount: number,
  opts: BackoffOptions = {},
): number {
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 5 * 60 * 1000;
  const random = opts.random ?? Math.random;
  const safeRetry = Math.max(0, Math.floor(retryCount));
  const ceiling = Math.min(capMs, baseMs * 2 ** safeRetry);
  return Math.floor(random() * (ceiling + 1));
}

export const MAX_QUEUE_RETRIES = 8;

export function maxRetriesExceeded(
  retryCount: number,
  max: number = MAX_QUEUE_RETRIES,
): boolean {
  return retryCount >= max;
}

/** FIFO ordering key: lower sequence first, ties broken by created_at. */
export function compareFifo(
  a: { seq: number; created_at: number },
  b: { seq: number; created_at: number },
): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.created_at - b.created_at;
}

/** Ops eligible for flush: QUEUED, or BACKOFF whose time has come. */
export function isFlushEligible(
  state: string,
  nextRetryAt: number | null,
  now: number,
): boolean {
  if (state === "QUEUED") return true;
  if (state === "BACKOFF") {
    return nextRetryAt === null || nextRetryAt <= now;
  }
  return false;
}

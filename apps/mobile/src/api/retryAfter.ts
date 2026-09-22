/**
 * The server's answer to "when may I try again", read the way it is sent.
 *
 * Auth endpoints and the punch limiter answer 429 with a Retry-After header
 * in whole seconds (the auth limiter) and, on the punch limiter, a
 * retry_after_ms field in the body as well. Until this existed the app read
 * neither: the outbox retried a rate-limited punch on its ordinary jittered
 * backoff -- which can be under a second -- and the sign-in screen showed
 * "try again later" with nothing to say how much later. A refused attempt
 * is not counted by the server, so waiting out the header is always enough;
 * ignoring it is what turns one 429 into a run of them.
 *
 * Dependency-free so the node test runner can import it.
 */

/** Header (seconds or an HTTP date) and body hint, whichever says more. */
export function parseRetryAfter(
  header: string | null | undefined,
  body?: unknown,
  now: number = Date.now(),
): number | null {
  let fromHeader: number | null = null;
  const raw = header?.trim();
  if (raw) {
    if (/^\d+$/.test(raw)) fromHeader = Number(raw) * 1000;
    else {
      const at = Date.parse(raw);
      if (!Number.isNaN(at)) fromHeader = Math.max(0, at - now);
    }
  }
  let fromBody: number | null = null;
  if (typeof body === "object" && body !== null) {
    const ms = (body as { retry_after_ms?: unknown }).retry_after_ms;
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) fromBody = ms;
  }
  if (fromHeader === null) return fromBody;
  if (fromBody === null) return fromHeader;
  return Math.max(fromHeader, fromBody);
}

/**
 * When the next attempt may go: the ordinary backoff, or the server's wait
 * when that is longer. The backoff still applies below it, so a limiter that
 * says "one second" does not collapse the exponential curve on a server that
 * is also failing for other reasons.
 */
export function nextAttemptDelayMs(backoffMs: number, retryAfterMs: number | null | undefined): number {
  const wait = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.max(backoffMs, wait);
}

/** "Try again in 5 seconds" / "in 2 minutes", or null when there is no wait to name. */
export function retryAfterText(retryAfterMs: number | null | undefined): string | null {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return null;
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds < 60) return `Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

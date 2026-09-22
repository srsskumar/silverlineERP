/**
 * Whether a punch reaches the server as a replay, decided once.
 *
 * The server refuses a *live* field punch-out with no return filed, so that
 * the person is prompted; a punch that has waited in the outbox is accepted
 * and the unfiled return recorded instead (§59). The executor used to work
 * that out on every attempt -- "retried, or older than a minute, therefore a
 * replay" -- and add `queued_offline: true` to the body accordingly.
 *
 * The server keys its idempotency on a hash of the whole body. So a punch
 * whose first attempt reached the server but whose response was lost came
 * back on the retry with one field more, was refused as
 * IDEMPOTENCY_MISMATCH, classified as a conflict and marked FAILED: a punch
 * the server had already recorded, shown to the person as one that failed.
 *
 * Now the question is answered at the first attempt and the answer written
 * into the stored payload, so every later attempt sends the byte-identical
 * body and the server's replay echo (200 applied) is what comes back.
 *
 * Dependency-free so the node test runner can import it.
 */

/**
 * How long an op may sit in the outbox before its punch counts as history
 * rather than something the person can still be asked about. Matches the
 * server's live-punch window in spirit; the server's own window is wider.
 */
export const REPLAY_AFTER_MS = 60 * 1000;

export interface PunchBody {
  /** What goes on the wire. */
  body: Record<string, unknown>;
  /** True when the decision was taken now and must be written back to the row. */
  frozen: boolean;
}

/**
 * The body for this attempt. A payload that already carries the answer is
 * sent as it is, whatever the clock or retry count now say; one that does
 * not gets the answer from how long it has waited, and that becomes part of
 * the stored payload.
 */
export function punchBody(
  payload: Record<string, unknown>,
  op: { created_at: number },
  now: number = Date.now(),
): PunchBody {
  if ("queued_offline" in payload) return { body: payload, frozen: false };
  const replay = now - op.created_at > REPLAY_AFTER_MS;
  return { body: { ...payload, queued_offline: replay }, frozen: true };
}

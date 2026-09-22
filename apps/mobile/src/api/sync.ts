/**
 * Sync outcome vocabulary — dependency-free (importable from node:test).
 *
 * Backend truth (apps/api/src/modules/attendance/routes.ts):
 *  - 201 { event, record, decision: "ACCEPTED" }      → fresh punch accepted
 *  - 200 { applied: true, event, record }             → idempotent replay /
 *    5-min suppression echo (no side effects, treat as success)
 *  - 202 { review: "REQUIRES_REVIEW", code, exception_id, message }
 *    → stored, queued for human review (TIMESTAMP_SKEW | MOCK_LOCATION |
 *    DEVICE_SIGNAL | ON_APPROVED_LEAVE; older rows may carry the retired
 *    OUTSIDE_GEOFENCE / NO_LOCATION / POOR_ACCURACY codes)
 *  - 422 envelope { code, message, field_errors[] }   → rejected, do NOT retry
 *    blindly (DUPLICATE_CHECKIN, CHECKOUT_WITHOUT_CHECKIN, RECORD_CLOSED,
 *    FUTURE_PUNCH, EMPLOYEE_INACTIVE, VALIDATION_ERROR, ...)
 *  - 409 { code: "VERSION_CONFLICT" }                 → stale base_version
 *    (tasks status / leave decision with If-Match); needs refetch + user call
 *  - 5xx / 429 / network failure                      → transient, back off
 */

export type SyncState =
  | "QUEUED"
  | "SENDING"
  | "BACKOFF"
  | "SUCCEEDED"
  | "FAILED";

export type SyncDecision =
  | "ACCEPTED"
  | "ALREADY_APPLIED"
  | "REJECTED"
  | "CONFLICT"
  | "REVIEW";

/** Transport-level outcome that never reaches the classifier. */
export type SyncTransport = "TRANSIENT";

function bodyCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "code" in body) {
    const c = (body as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

function bodyFlag(body: unknown, key: string): unknown {
  if (typeof body === "object" && body !== null && key in body) {
    return (body as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Classify one HTTP response into the SyncDecision union.
 * Returns "TRANSIENT" for 429/5xx so the queue can back off instead of
 * failing the op. Throws on a missing/unreadable status (caller bug).
 */
export function classifySyncResponse(
  status: number,
  body: unknown,
): SyncDecision | SyncTransport {
  if (!Number.isInteger(status) || status <= 0) {
    throw new Error(`classifySyncResponse: invalid status ${String(status)}`);
  }
  if (status === 429 || status >= 500) return "TRANSIENT";
  if (status === 202 || bodyFlag(body, "review") === "REQUIRES_REVIEW") {
    return "REVIEW";
  }
  if (status === 409 || bodyCode(body) === "VERSION_CONFLICT") return "CONFLICT";
  if (status === 200 && bodyFlag(body, "applied") === true) {
    return "ALREADY_APPLIED";
  }
  if (
    status === 201 ||
    bodyFlag(body, "decision") === "ACCEPTED" ||
    (status >= 200 && status < 300)
  ) {
    // Bare-201 with decision ACCEPTED is the canonical accept path; any other
    // 2xx without review/applied markers is also an accept (tolerant read).
    return "ACCEPTED";
  }
  return "REJECTED";
}

export interface OutcomeResolution {
  state: SyncState;
  /** False for terminal outcomes (rejected/conflict/review need a human). */
  retryable: boolean;
  decision: SyncDecision | SyncTransport;
}

/**
 * Map a classified decision (or transport failure) to the op's next state.
 * REVIEW is terminal-success: the server persisted the event and opened an
 * exception, so the op SUCCEEDs but is flagged via `needsReview`.
 */
export function resolveOutcome(
  decision: SyncDecision | SyncTransport,
): OutcomeResolution {
  switch (decision) {
    case "ACCEPTED":
    case "ALREADY_APPLIED":
    case "REVIEW":
      return { state: "SUCCEEDED", retryable: false, decision };
    case "CONFLICT":
    case "REJECTED":
      return { state: "FAILED", retryable: false, decision };
    case "TRANSIENT":
      return { state: "BACKOFF", retryable: true, decision };
  }
}

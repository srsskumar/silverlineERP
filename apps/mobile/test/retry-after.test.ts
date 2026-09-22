/**
 * The server's Retry-After, read and honoured.
 *
 * The auth limiter answers 429 with Retry-After in whole seconds; the punch
 * limiter adds retry_after_ms to the body. Neither was read: the outbox
 * retried on its own jittered backoff, which can be under a second, and the
 * sign-in screen said "try again later" without saying how much later.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextAttemptDelayMs, parseRetryAfter, retryAfterText } from "../src/api/retryAfter";

describe("Retry-After", () => {
  it("reads whole seconds from the header, as the auth limiter sends it", () => {
    assert.equal(parseRetryAfter("5"), 5000);
    assert.equal(parseRetryAfter(" 42 "), 42000);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-09-22T06:00:00Z");
    assert.equal(parseRetryAfter("Tue, 22 Sep 2026 06:00:30 GMT", undefined, now), 30_000);
    // A date in the past is a wait of nothing, not a negative one.
    assert.equal(parseRetryAfter("Tue, 22 Sep 2026 05:59:00 GMT", undefined, now), 0);
  });

  it("takes the body's retry_after_ms when there is no header, and the longer of the two when both", () => {
    assert.equal(parseRetryAfter(null, { retry_after_ms: 1500 }), 1500);
    assert.equal(parseRetryAfter("1", { retry_after_ms: 2500 }), 2500);
    assert.equal(parseRetryAfter("3", { retry_after_ms: 500 }), 3000);
  });

  it("is null when the server said nothing usable", () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("soon"), null);
    assert.equal(parseRetryAfter(undefined, { retry_after_ms: -1 }), null);
    assert.equal(parseRetryAfter(undefined, { retry_after_ms: "5" }), null);
  });

  it("never schedules the next attempt before the server's wait, and keeps the backoff above it", () => {
    assert.equal(nextAttemptDelayMs(300, 5000), 5000);
    assert.equal(nextAttemptDelayMs(9000, 5000), 9000);
    assert.equal(nextAttemptDelayMs(300, null), 300);
    assert.equal(nextAttemptDelayMs(300, undefined), 300);
  });

  it("tells a person how long, in the unit they would say it in", () => {
    assert.equal(retryAfterText(5000), "Try again in 5 seconds.");
    assert.equal(retryAfterText(1000), "Try again in 1 second.");
    assert.equal(retryAfterText(90_000), "Try again in 2 minutes.");
    assert.equal(retryAfterText(0), null);
    assert.equal(retryAfterText(null), null);
  });
});

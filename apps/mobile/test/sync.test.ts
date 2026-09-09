import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySyncResponse,
  resolveOutcome,
} from "../src/api/sync.js";
import {
  compareFifo,
  computeBackoffMs,
  dedupeKey,
  isFlushEligible,
  maxRetriesExceeded,
  MAX_QUEUE_RETRIES,
} from "../src/sync/policy.js";

describe("classifySyncResponse", () => {
  it("201 with ACCEPTED decision → ACCEPTED", () => {
    assert.equal(
      classifySyncResponse(201, { decision: "ACCEPTED" }),
      "ACCEPTED",
    );
  });
  it("bare 201 → ACCEPTED", () => {
    assert.equal(classifySyncResponse(201, {}), "ACCEPTED");
  });
  it("200 with applied:true → ALREADY_APPLIED (idempotent replay)", () => {
    assert.equal(
      classifySyncResponse(200, { applied: true, event: {}, record: {} }),
      "ALREADY_APPLIED",
    );
  });
  it("202 with REQUIRES_REVIEW → REVIEW", () => {
    assert.equal(
      classifySyncResponse(202, {
        review: "REQUIRES_REVIEW",
        code: "OUTSIDE_GEOFENCE",
        exception_id: "x",
      }),
      "REVIEW",
    );
  });
  it("200 carrying review flag → REVIEW regardless of status", () => {
    assert.equal(
      classifySyncResponse(200, { review: "REQUIRES_REVIEW", code: "MOCK_LOCATION" }),
      "REVIEW",
    );
  });
  it("422 business reject → REJECTED", () => {
    assert.equal(
      classifySyncResponse(422, {
        code: "DUPLICATE_CHECKIN",
        message: "dup",
        field_errors: [],
      }),
      "REJECTED",
    );
  });
  it("409 / VERSION_CONFLICT → CONFLICT", () => {
    assert.equal(
      classifySyncResponse(409, { code: "VERSION_CONFLICT" }),
      "CONFLICT",
    );
    assert.equal(
      classifySyncResponse(422, { code: "VERSION_CONFLICT" }),
      "CONFLICT",
    );
  });
  it("429 and 5xx → TRANSIENT (back off, never fail the op)", () => {
    assert.equal(classifySyncResponse(429, {}), "TRANSIENT");
    assert.equal(classifySyncResponse(500, {}), "TRANSIENT");
    assert.equal(classifySyncResponse(503, { code: "X" }), "TRANSIENT");
  });
  it("throws on invalid status (caller bug)", () => {
    assert.throws(() => classifySyncResponse(0, {}));
    assert.throws(() => classifySyncResponse(NaN, {}));
  });
});

describe("resolveOutcome", () => {
  it("ACCEPTED / ALREADY_APPLIED → SUCCEEDED, not retryable", () => {
    assert.deepEqual(resolveOutcome("ACCEPTED"), {
      state: "SUCCEEDED",
      retryable: false,
      decision: "ACCEPTED",
    });
    assert.equal(resolveOutcome("ALREADY_APPLIED").state, "SUCCEEDED");
  });
  it("REVIEW → SUCCEEDED (server persisted + opened exception)", () => {
    const o = resolveOutcome("REVIEW");
    assert.equal(o.state, "SUCCEEDED");
    assert.equal(o.retryable, false);
  });
  it("REJECTED / CONFLICT → FAILED, terminal", () => {
    assert.equal(resolveOutcome("REJECTED").state, "FAILED");
    assert.equal(resolveOutcome("CONFLICT").retryable, false);
  });
  it("TRANSIENT → BACKOFF, retryable", () => {
    assert.deepEqual(resolveOutcome("TRANSIENT"), {
      state: "BACKOFF",
      retryable: true,
      decision: "TRANSIENT",
    });
  });
});

describe("dedupeKey", () => {
  it("one active op per entity+op", () => {
    assert.equal(dedupeKey("task_status", "status:abc"), "task_status::status:abc");
    assert.notEqual(
      dedupeKey("task_status", "status:abc"),
      dedupeKey("task_status", "status:abd"),
    );
  });
});

describe("computeBackoffMs", () => {
  it("grows exponentially (deterministic random=~1)", () => {
    const hi = () => 0.999999;
    const b0 = computeBackoffMs(0, { baseMs: 1000, random: hi });
    const b1 = computeBackoffMs(1, { baseMs: 1000, random: hi });
    const b2 = computeBackoffMs(2, { baseMs: 1000, random: hi });
    assert.ok(b0 <= 1000 && b1 <= 2000 && b2 <= 4000);
    assert.ok(b1 > b0 && b2 > b1);
  });
  it("caps at capMs", () => {
    const hi = () => 0.999999;
    const b = computeBackoffMs(30, { baseMs: 1000, capMs: 5000, random: hi });
    assert.ok(b <= 5000);
  });
  it("full jitter can hit ~0 (random=0)", () => {
    assert.equal(computeBackoffMs(3, { random: () => 0 }), 0);
  });
  it("negative retry counts clamp to first bucket", () => {
    const hi = () => 0.999999;
    assert.ok(computeBackoffMs(-5, { baseMs: 1000, random: hi }) <= 1000);
  });
});

describe("queue policy", () => {
  it("MAX_QUEUE_RETRIES default is 8", () => {
    assert.equal(MAX_QUEUE_RETRIES, 8);
    assert.equal(maxRetriesExceeded(7), false);
    assert.equal(maxRetriesExceeded(8), true);
  });
  it("FIFO compares seq then created_at", () => {
    assert.ok(
      compareFifo({ seq: 1, created_at: 9 }, { seq: 2, created_at: 1 }) < 0,
    );
    assert.ok(
      compareFifo({ seq: 1, created_at: 5 }, { seq: 1, created_at: 6 }) < 0,
    );
    assert.equal(
      compareFifo({ seq: 1, created_at: 5 }, { seq: 1, created_at: 5 }),
      0,
    );
  });
  it("flush eligibility: QUEUED always, BACKOFF only when due", () => {
    const now = 1_000_000;
    assert.equal(isFlushEligible("QUEUED", null, now), true);
    assert.equal(isFlushEligible("BACKOFF", now - 1, now), true);
    assert.equal(isFlushEligible("BACKOFF", now + 60_000, now), false);
    assert.equal(isFlushEligible("SENDING", null, now), false);
    assert.equal(isFlushEligible("SUCCEEDED", null, now), false);
    assert.equal(isFlushEligible("FAILED", null, now), false);
  });
});

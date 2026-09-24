/// <reference types="node" />
/**
 * What the outbox keeps of the server's answer, run against the production
 * queue on a real SQLite database.
 *
 * Three things used to be lost between the server and the person:
 *  - a 202's reason (NO_LOCATION, ON_APPROVED_LEAVE, TIMESTAMP_SKEW on a
 *    punch replayed after the signal came back) -- the row went SUCCEEDED
 *    with a blank payload and nothing else;
 *  - a 429's Retry-After -- the row came back on its own sub-second backoff;
 *  - a 422's field errors -- a leave request failed as "VALIDATION_ERROR:
 *    Validation failed" and nothing about which date was wrong.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  createQueue,
  reviewMessage,
  reviewNote,
  type QueueDatabase,
} from "../src/sync/queueCore";
import { describeApiError } from "../src/errorFormat";
import { SCHEMA_SQL } from "../src/sync/schema";

type RequestError = Error & {
  status: number;
  retryable: boolean;
  code: string;
  retryAfterMs?: number | null;
  fieldErrors?: { field: string; message: string }[];
};

function requestError(args: Omit<RequestError, keyof Error> & { message: string }): RequestError {
  return Object.assign(new Error(args.message), args);
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  const port: QueueDatabase = {
    getFirstAsync: async <T>(sql: string, params: (string | number | null)[]) =>
      (db.prepare(sql).get(...params) as T) ?? null,
    getAllAsync: async <T>(sql: string, params: (string | number | null)[]) =>
      db.prepare(sql).all(...params) as T[],
    runAsync: async (sql, params) => db.prepare(sql).run(...params),
  };
  const queue = createQueue({
    getDb: async () => port,
    getAccount: async () => "alice",
    uuid: randomUUID,
    isApiError: (e): e is RequestError => e instanceof Error && "status" in e,
    seal: async (_id, value) => value,
    unseal: async (_id, value) => value,
  });
  const row = (uuid: string) =>
    db.prepare("SELECT * FROM pending_ops WHERE client_uuid=?").get(uuid) as {
      state: string; decision: string | null; error: string | null; payload: string; next_retry_at: number | null; retry_count: number;
    };
  return { db, queue, row };
}

describe("the server's verdict on a delivered punch", () => {
  it("keeps a 202's code and message on the SUCCEEDED row, with the payload gone", async () => {
    const { db, queue, row } = fixture();
    const op = await queue.enqueueOp({
      entity: "attendance_event", op: "check_out:2026-09-22T06:00:00Z",
      payload: { employee_id: "e", event_type: "CHECK_OUT", client_timestamp: "2026-09-22T06:00:00Z" },
    });
    // The shape postAttendanceEvent hands back for the live 202 seen on the API.
    await queue.flushQueue(async () => ({
      status: 202,
      body: {
        kind: "REVIEW", code: "TIMESTAMP_SKEW", exception_id: "x",
        message: "client_timestamp differs from server time by more than 15 minutes; queued for review",
      },
    }));
    const saved = row(op.client_uuid);
    assert.equal(saved.state, "SUCCEEDED");
    assert.equal(saved.decision, "REVIEW");
    assert.equal(saved.payload, "{}");
    assert.equal(
      saved.error,
      "TIMESTAMP_SKEW: client_timestamp differs from server time by more than 15 minutes; queued for review",
    );
    assert.equal(
      reviewMessage(saved.error),
      "Submitted for review: client_timestamp differs from server time by more than 15 minutes; queued for review",
    );
    db.close();
  });

  it("leaves an accepted row with nothing to say", async () => {
    const { db, queue, row } = fixture();
    const op = await queue.enqueueOp({ entity: "attendance_event", op: "in", payload: { a: 1 } });
    await queue.flushQueue(async () => ({ status: 201, body: { kind: "ACCEPTED", event: {} } }));
    assert.equal(row(op.client_uuid).state, "SUCCEEDED");
    assert.equal(row(op.client_uuid).error, null);
    assert.equal(reviewMessage(null), "Submitted for review.");
    db.close();
  });

  it("words the note from whatever the server gave", () => {
    assert.equal(reviewNote({ code: "NO_LOCATION", message: "no fix" }), "NO_LOCATION: no fix");
    assert.equal(reviewNote({ code: "ON_APPROVED_LEAVE" }), "ON_APPROVED_LEAVE");
    assert.equal(reviewNote({ message: "held" }), "held");
    assert.equal(reviewNote({}), null);
    assert.equal(reviewNote("nope"), null);
  });
});

describe("a rate-limited operation", () => {
  it("waits at least the server's Retry-After before the next attempt, and is not failed", async () => {
    const { db, queue, row } = fixture();
    const op = await queue.enqueueOp({ entity: "attendance_event", op: "in", payload: { a: 1 } });
    const before = Date.now();
    const result = await queue.flushQueue(async () => {
      throw requestError({ status: 429, code: "RATE_LIMITED", message: "Too many requests", retryable: true, retryAfterMs: 5000 });
    });
    assert.equal(result.deferred, 1);
    assert.equal(result.failed, 0);
    const saved = row(op.client_uuid);
    assert.equal(saved.state, "BACKOFF");
    assert.equal(saved.retry_count, 1);
    assert.ok(saved.next_retry_at !== null && saved.next_retry_at >= before + 5000,
      `next_retry_at ${saved.next_retry_at} must honour the 5 s Retry-After (now ${before})`);
    // And it is not eligible again until then.
    const again = await queue.flushQueue(async () => ({ status: 201, body: {} }));
    assert.equal(again.attempted, 0);
    db.close();
  });

  it("still backs off on its own curve when the server names no wait", async () => {
    const { db, queue, row } = fixture();
    const op = await queue.enqueueOp({ entity: "attendance_event", op: "in", payload: { a: 1 } });
    const before = Date.now();
    await queue.flushQueue(async () => {
      throw requestError({ status: 503, code: "REQUEST_FAILED", message: "down", retryable: true, retryAfterMs: null });
    });
    const saved = row(op.client_uuid);
    assert.equal(saved.state, "BACKOFF");
    assert.ok(saved.next_retry_at !== null && saved.next_retry_at >= before && saved.next_retry_at <= before + 2001 + 5000);
    db.close();
  });
});

describe("a refused operation", () => {
  it("records the field errors so the reason is readable in the queue", async () => {
    const { db, queue, row } = fixture();
    const op = await queue.enqueueOp({
      entity: "leave_request", op: "leave:1",
      payload: { leave_type_id: "t", from_date: "2026-10-05", to_date: "2026-10-01" },
    });
    await queue.flushQueue(async () => {
      throw requestError({
        status: 422, code: "DATE_RANGE", message: "from_date must be on or before to_date", retryable: false,
        fieldErrors: [{ field: "to_date", message: "to_date must be on or after from_date" }],
      });
    });
    const saved = row(op.client_uuid);
    assert.equal(saved.state, "FAILED");
    assert.equal(saved.decision, "REJECTED");
    assert.equal(saved.error, "to_date must be on or after from_date");
    db.close();
  });

  it("says only what it has when there are no field errors", () => {
    assert.equal(
      describeApiError(
        requestError({ status: 404, code: "NOT_FOUND", message: "Leave type not found", retryable: false }),
        "Request failed",
      ),
      "Leave type not found",
    );
  });
});

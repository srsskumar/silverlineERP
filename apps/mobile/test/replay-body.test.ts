/// <reference types="node" />
/**
 * A retried punch sends the same bytes as its first attempt.
 *
 * The server keys idempotency on a hash of the whole body. The executor
 * used to add `queued_offline: true` on any retry, so a punch whose first
 * attempt reached the server but whose response was lost came back as a
 * different request: 409 IDEMPOTENCY_MISMATCH, classified CONFLICT, marked
 * FAILED -- a punch the server had already recorded, shown as one that
 * failed. Seen against the live API on 2026-09-22.
 *
 * The decision is now taken once and written into the stored payload. This
 * runs the production queue on a real SQLite database with an executor that
 * does what engine.defaultExecutor does with a punch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createQueue, type QueueDatabase } from "../src/sync/queueCore";
import { punchBody, REPLAY_AFTER_MS } from "../src/sync/replay";
import { SCHEMA_SQL } from "../src/sync/schema";

describe("punchBody", () => {
  const op = { created_at: 1_000_000 };

  it("marks a punch that has waited as a replay, and a fresh one as live", () => {
    assert.deepEqual(punchBody({ a: 1 }, op, op.created_at + REPLAY_AFTER_MS + 1), {
      body: { a: 1, queued_offline: true }, frozen: true,
    });
    assert.deepEqual(punchBody({ a: 1 }, op, op.created_at + 5_000), {
      body: { a: 1, queued_offline: false }, frozen: true,
    });
  });

  it("never revisits an answer already in the payload, whatever the clock says", () => {
    const live = { a: 1, queued_offline: false };
    assert.deepEqual(punchBody(live, op, op.created_at + 3 * 60 * 60 * 1000), { body: live, frozen: false });
    const replay = { a: 1, queued_offline: true };
    assert.deepEqual(punchBody(replay, op, op.created_at), { body: replay, frozen: false });
  });
});

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
  // A visible seal, so the test can see that the rewritten payload was sealed.
  const queue = createQueue({
    getDb: async () => port,
    getAccount: async () => "alice",
    uuid: randomUUID,
    isApiError: (e): e is Error & { status: number; retryable: boolean; code: string } =>
      e instanceof Error && "status" in e,
    seal: async (_id, value) => `sealed:${value}`,
    unseal: async (_id, value) => value.replace(/^sealed:/, ""),
  });
  return { db, queue };
}

describe("a punch retried after a lost response", () => {
  it("sends the identical body the second time, and the row holds it sealed", async () => {
    const { db, queue } = fixture();
    const op = await queue.enqueueOp({
      entity: "attendance_event", op: "check_in:t",
      payload: { employee_id: "e", event_type: "CHECK_IN", client_timestamp: "2026-09-22T06:00:00Z" },
    });
    // Two minutes in the outbox before the first attempt: a replay.
    let clock = op.created_at + 2 * 60 * 1000;
    const sent: string[] = [];
    // What engine.defaultExecutor does with an attendance_event.
    const executor = async (row: { client_uuid: string; payload: string; created_at: number }) => {
      const { body, frozen } = punchBody(JSON.parse(row.payload), row, clock);
      if (frozen) await queue.rewriteOp(row.client_uuid, JSON.stringify(body));
      sent.push(JSON.stringify(body));
      if (sent.length === 1) throw new Error("Connection lost"); // server got it; we did not hear
      return { status: 200, body: { applied: true } };
    };

    await queue.flushQueue(executor);
    const stored = db.prepare("SELECT payload, state FROM pending_ops WHERE client_uuid=?").get(op.client_uuid) as { payload: string; state: string };
    assert.equal(stored.state, "BACKOFF");
    assert.equal(stored.payload, `sealed:${sent[0]}`, "the body sent is the body kept");
    assert.match(sent[0], /"queued_offline":true/);

    // The retry, an hour later.
    clock += 60 * 60 * 1000;
    db.prepare("UPDATE pending_ops SET next_retry_at=0").run();
    await queue.flushQueue(executor);
    assert.equal(sent.length, 2);
    assert.equal(sent[1], sent[0], "a retry must be byte-identical or the server refuses it as a different request");
    assert.equal((db.prepare("SELECT state FROM pending_ops").get() as { state: string }).state, "SUCCEEDED");
    db.close();
  });

  it("keeps a live first attempt live on the retry, instead of turning it into a replay", async () => {
    const { db, queue } = fixture();
    const op = await queue.enqueueOp({ entity: "attendance_event", op: "check_out:t", payload: { event_type: "CHECK_OUT" } });
    let clock = op.created_at + 1_000;
    const sent: string[] = [];
    const executor = async (row: { client_uuid: string; payload: string; created_at: number }) => {
      const { body, frozen } = punchBody(JSON.parse(row.payload), row, clock);
      if (frozen) await queue.rewriteOp(row.client_uuid, JSON.stringify(body));
      sent.push(JSON.stringify(body));
      if (sent.length === 1) throw new Error("Connection lost");
      return { status: 201, body: {} };
    };
    await queue.flushQueue(executor);
    assert.match(sent[0], /"queued_offline":false/);
    clock += 10 * 60 * 1000; // well past REPLAY_AFTER_MS, and retry_count is now 1
    db.prepare("UPDATE pending_ops SET next_retry_at=0").run();
    await queue.flushQueue(executor);
    assert.equal(sent[1], sent[0]);
    db.close();
  });

  it("does not rewrite a row that is no longer in flight", async () => {
    const { db, queue } = fixture();
    const op = await queue.enqueueOp({ entity: "attendance_event", op: "x", payload: { a: 1 } });
    await queue.flushQueue(async () => ({ status: 201, body: {} }));
    await queue.rewriteOp(op.client_uuid, JSON.stringify({ a: 2 }));
    const row = db.prepare("SELECT payload FROM pending_ops WHERE client_uuid=?").get(op.client_uuid) as { payload: string };
    assert.equal(row.payload, "{}", "a delivered row keeps its emptied payload");
    db.close();
  });
});

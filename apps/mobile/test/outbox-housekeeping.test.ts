/// <reference types="node" />
/**
 * The outbox has to stay small and its failures have to stay visible.
 *
 * Delivered operations used to live forever -- a photo's sealed base64 with
 * them -- and the queue screen listed the oldest hundred rows, so once a
 * hundred had been delivered a new failure was never shown and never retried.
 * These run the production queue against a real SQLite database with the
 * production schema.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  createQueue,
  purgeSettledOps,
  SETTLED_KEEP_MAX,
  SETTLED_RETENTION_MS,
  type QueueDatabase,
} from "../src/sync/queueCore";
import { SCHEMA_SQL } from "../src/sync/schema";

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
  // Sealing is not under test here; an identity vault keeps payloads legible.
  const queue = createQueue({
    getDb: async () => port,
    getAccount: async () => "alice",
    uuid: randomUUID,
    isApiError: (e): e is Error & { status: number; retryable: boolean; code: string } =>
      e instanceof Error && "status" in e,
    seal: async (_id, value) => value,
    unseal: async (_id, value) => value,
  });
  const count = (where: string) =>
    (db.prepare(`SELECT count(*) AS n FROM pending_ops WHERE ${where}`).get() as { n: number }).n;
  return { db, port, queue, count };
}

async function deliver(fx: ReturnType<typeof fixture>, n: number, prefix = "ok") {
  for (let i = 0; i < n; i += 1) {
    await fx.queue.enqueueOp({ entity: "task_comment", op: `${prefix}${i}`, payload: { body: `${prefix} ${i}` } });
  }
  while (fx.count("state='QUEUED'") > 0) {
    await fx.queue.flushQueue(async () => ({ status: 201, body: {} }));
  }
}

describe("MOB-2 delivered operations do not accumulate", () => {
  it("drops the sealed body as soon as the server has the operation", async () => {
    const fx = fixture();
    await fx.queue.enqueueOp({
      entity: "task_evidence",
      op: "photo",
      payload: { base64: "A".repeat(50_000) },
    });
    await fx.queue.flushQueue(async () => ({ status: 201, body: {} }));
    const row = fx.db.prepare("SELECT state, payload FROM pending_ops").get() as {
      state: string;
      payload: string;
    };
    assert.equal(row.state, "SUCCEEDED");
    assert.equal(row.payload, "{}");
    fx.db.close();
  });

  it("keeps no more than the newest delivered rows after a flush", async () => {
    const fx = fixture();
    await deliver(fx, SETTLED_KEEP_MAX + 30);
    assert.equal(fx.count("state='SUCCEEDED'"), SETTLED_KEEP_MAX);
    // The survivors are the most recent ones, so a caller reading back the
    // outcome of what it just submitted still finds it.
    const last = fx.db
      .prepare("SELECT op FROM pending_ops ORDER BY seq DESC LIMIT 1")
      .get() as { op: string };
    assert.equal(last.op, `ok${SETTLED_KEEP_MAX + 29}`);
    fx.db.close();
  });

  it("drops delivered rows past the retention window but never failed or waiting ones", async () => {
    const fx = fixture();
    await deliver(fx, 3);
    await fx.queue.enqueueOp({ entity: "task_status", op: "rejected", payload: {} });
    await fx.queue.flushQueue(async () => ({ status: 422, body: { code: "VALIDATION_ERROR" } }));
    await fx.queue.enqueueOp({ entity: "task_comment", op: "waiting", payload: {} });
    const old = Date.now() - SETTLED_RETENTION_MS - 1000;
    fx.db.prepare("UPDATE pending_ops SET updated_at=?, created_at=?").run(old, old);

    await purgeSettledOps(fx.port);

    assert.equal(fx.count("state='SUCCEEDED'"), 0);
    assert.equal(fx.count("state='FAILED'"), 1);
    assert.equal(fx.count("state='QUEUED'"), 1);
    fx.db.close();
  });
});

describe("MOB-2 the queue screen shows failures first", () => {
  it("lists a failure that happened after a hundred deliveries, then waiting work", async () => {
    const fx = fixture();
    // Keep every delivered row, as an install that predates the purge would.
    fx.db.exec(
      "CREATE TRIGGER keep BEFORE DELETE ON pending_ops BEGIN SELECT RAISE(IGNORE); END;",
    );
    await deliver(fx, 120);
    await fx.queue.enqueueOp({ entity: "task_status", op: "late", payload: {} });
    await fx.queue.flushQueue(async () => ({ status: 409, body: { code: "VERSION_CONFLICT" } }));
    await fx.queue.enqueueOp({ entity: "task_comment", op: "waiting", payload: {} });

    const rows = await fx.queue.listOps();
    assert.equal(rows.length, 100);
    assert.equal(rows[0]!.op, "late");
    assert.equal(rows[0]!.state, "FAILED");
    assert.equal(rows[1]!.op, "waiting");
    // Delivered rows follow, newest first.
    assert.equal(rows[2]!.op, "ok119");
    fx.db.close();
  });
});

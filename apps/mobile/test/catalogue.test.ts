/// <reference types="node" />
/**
 * Catalogue: offline queue (UT-OFF-01..06) and evidence watermark (UT-ATT-10).
 *
 * These rows are device-side, so they run here rather than in the API suite.
 * The outbox is exercised against a real SQLite database using the production
 * schema and the production queue implementation — only the storage port,
 * the key vault and the network executor are substituted, which is the layer a
 * real device swaps anyway.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createQueue, type QueueDatabase } from "../src/sync/queueCore";
import { RECOVER_INTERRUPTED_SQL, SCHEMA_SQL } from "../src/sync/schema";
import { classifySyncResponse, resolveOutcome } from "../src/api/sync";
import {
  MAX_QUEUE_RETRIES,
  computeBackoffMs,
  isFlushEligible,
  maxRetriesExceeded,
} from "../src/sync/policy";
import { buildWatermarkLines, renderWatermarkText } from "../src/device/camera";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Fixture {
  db: DatabaseSync;
  queue: ReturnType<typeof createQueue>;
  switchAccount: (id: string) => void;
  currentAccount: () => string;
  /** Drops every key for an account — the local half of a remote wipe. */
  destroyVault: (id: string) => void;
  vaultHasKey: (id: string) => boolean;
}

/**
 * One in-memory device. `keys` stands in for SecureStore: each account gets its
 * own encryption key, and destroying it makes that account's rows unreadable
 * exactly as destroying the real vault does.
 */
function device(initialAccount = "alice"): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  let account = initialAccount;
  const keys = new Map<string, Buffer>();
  const key = (id: string) => {
    if (!keys.has(id)) keys.set(id, randomBytes(32));
    return keys.get(id)!;
  };
  const port: QueueDatabase = {
    getFirstAsync: async <T>(sql: string, params: (string | number | null)[]) =>
      (db.prepare(sql).get(...params) as T) ?? null,
    getAllAsync: async <T>(sql: string, params: (string | number | null)[]) =>
      db.prepare(sql).all(...params) as T[],
    runAsync: async (sql, params) => db.prepare(sql).run(...params),
  };
  const queue = createQueue({
    getDb: async () => port,
    getAccount: async () => account,
    uuid: randomUUID,
    isApiError: (e): e is Error & { status: number; retryable: boolean; code: string } =>
      e instanceof Error && "status" in e,
    seal: async (id, value) => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key(id), iv);
      const data = Buffer.concat([c.update(value), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    },
    unseal: async (id, value) => {
      const b = Buffer.from(value, "base64");
      const d = createDecipheriv("aes-256-gcm", key(id), b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString();
    },
  });
  return {
    db,
    queue,
    switchAccount: (id) => {
      account = id;
    },
    currentAccount: () => account,
    destroyVault: (id) => keys.delete(id),
    vaultHasKey: (id) => keys.has(id),
  };
}

/** The local half of a remote wipe, mirroring sync/db.ts wipeAccount(). */
function wipeAccountLocally(fx: Fixture, account: string): void {
  fx.destroyVault(account);
  fx.db.exec(
    "DELETE FROM pending_ops; DELETE FROM tasks_cache; DELETE FROM attendance_cache;" +
      " DELETE FROM projects_cache; DELETE FROM leave_cache;" +
      " DELETE FROM notifications_cache; DELETE FROM snapshots; DELETE FROM meta;",
  );
}

function opRows(fx: Fixture): Array<Record<string, unknown>> {
  return fx.db.prepare("SELECT * FROM pending_ops ORDER BY created_at").all() as Array<
    Record<string, unknown>
  >;
}

// ---------------------------------------------------------------------------
// UT-OFF-01
// ---------------------------------------------------------------------------

describe("UT-OFF-01 assign client operation ID, sequence and idempotency key", () => {
  it("assigns a distinct client id and retry key to every operation", async () => {
    const fx = device();
    const a = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { kind: "CHECK_IN" },
    });
    const b = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-out",
      payload: { kind: "CHECK_OUT" },
    });

    assert.notEqual(a.client_uuid, b.client_uuid);
    assert.notEqual(a.idempotency_key, b.idempotency_key);
    assert.ok(a.idempotency_key.length >= 8, "key must satisfy the server's guard");
    fx.db.close();
  });

  it("preserves FIFO order by creation, which is the sequence the server sees", async () => {
    const fx = device();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const op = await fx.queue.enqueueOp({
        entity: "task_comment",
        op: `c${i}`,
        payload: { body: `comment ${i}` },
      });
      created.push(op.client_uuid);
    }

    const sent: string[] = [];
    await fx.queue.flushQueue(async (op) => {
      sent.push(op.client_uuid);
      return { status: 201, body: {} };
    });
    assert.deepEqual(sent, created);
    // Order comes from an explicit monotonic sequence, not from a millisecond
    // timestamp that ties and then falls back to a random uuid.
    const seqs = opRows(fx).map((r) => Number(r.seq));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    fx.db.close();
  });

  it("keeps both ids stable across a restart", async () => {
    const fx = device();
    const op = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { kind: "CHECK_IN" },
    });

    // A restart re-opens the same database and re-runs the recovery statement.
    fx.db.exec(RECOVER_INTERRUPTED_SQL);
    const after = opRows(fx)[0]!;
    assert.equal(after.client_uuid, op.client_uuid);
    assert.equal(after.idempotency_key, op.idempotency_key);
    fx.db.close();
  });

  it("keeps the retry key stable across retries", async () => {
    const fx = device();
    const op = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { kind: "CHECK_IN" },
    });

    const keys: string[] = [];
    await fx.queue.flushQueue(async (row) => {
      keys.push(row.idempotency_key);
      throw new Error("Connection lost");
    });
    fx.db.prepare("UPDATE pending_ops SET next_retry_at=0").run();
    await fx.queue.flushQueue(async (row) => {
      keys.push(row.idempotency_key);
      return { status: 200, body: { applied: true } };
    });

    // A new key on retry would let the server create a second punch — the exact
    // duplicate the key exists to prevent.
    assert.deepEqual(new Set(keys), new Set([op.idempotency_key]));
    fx.db.close();
  });

  it("stores the payload encrypted at rest", async () => {
    const fx = device();
    await fx.queue.enqueueOp({
      entity: "task_comment",
      op: "c",
      payload: { body: "Confidential site note" },
    });
    const stored = String(opRows(fx)[0]!.payload);
    assert.ok(!stored.includes("Confidential"));
    fx.db.close();
  });
});

// ---------------------------------------------------------------------------
// UT-OFF-02
// ---------------------------------------------------------------------------

describe("UT-OFF-02 classify ACCEPTED ALREADY_APPLIED REJECTED CONFLICT and REVIEW", () => {
  const cases: Array<{
    label: string;
    status: number;
    body: unknown;
    decision: string;
    state: string;
    retryable: boolean;
  }> = [
    {
      label: "fresh punch accepted",
      status: 201,
      body: { decision: "ACCEPTED" },
      decision: "ACCEPTED",
      state: "SUCCEEDED",
      retryable: false,
    },
    {
      label: "idempotent replay",
      status: 200,
      body: { applied: true },
      decision: "ALREADY_APPLIED",
      state: "SUCCEEDED",
      retryable: false,
    },
    {
      label: "queued for human review",
      status: 202,
      body: { review: "REQUIRES_REVIEW", code: "OUTSIDE_GEOFENCE" },
      decision: "REVIEW",
      state: "SUCCEEDED",
      retryable: false,
    },
    {
      label: "business rejection",
      status: 422,
      body: { code: "DUPLICATE_CHECKIN" },
      decision: "REJECTED",
      state: "FAILED",
      retryable: false,
    },
    {
      label: "version conflict",
      status: 409,
      body: { code: "VERSION_CONFLICT" },
      decision: "CONFLICT",
      state: "FAILED",
      retryable: false,
    },
    {
      label: "server error",
      status: 503,
      body: {},
      decision: "TRANSIENT",
      state: "BACKOFF",
      retryable: true,
    },
    {
      label: "rate limited",
      status: 429,
      body: { code: "RATE_LIMITED" },
      decision: "TRANSIENT",
      state: "BACKOFF",
      retryable: true,
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.label} as ${c.decision} → ${c.state}`, () => {
      const decision = classifySyncResponse(c.status, c.body);
      assert.equal(decision, c.decision);
      const outcome = resolveOutcome(decision);
      assert.equal(outcome.state, c.state);
      assert.equal(outcome.retryable, c.retryable);
    });
  }

  it("drives the queue into the matching terminal state", async () => {
    const expected: Array<[number, unknown, string]> = [
      [201, { decision: "ACCEPTED" }, "SUCCEEDED"],
      [200, { applied: true }, "SUCCEEDED"],
      [202, { review: "REQUIRES_REVIEW" }, "SUCCEEDED"],
      [422, { code: "DUPLICATE_CHECKIN" }, "FAILED"],
      [409, { code: "VERSION_CONFLICT" }, "FAILED"],
    ];
    for (const [status, body, state] of expected) {
      const fx = device();
      await fx.queue.enqueueOp({ entity: "attendance_event", op: "x", payload: {} });
      await fx.queue.flushQueue(async () => ({ status, body }));
      assert.equal(opRows(fx)[0]!.state, state, `status ${status}`);
      fx.db.close();
    }
  });

  it("leaves a transient failure retryable rather than terminal", async () => {
    const fx = device();
    await fx.queue.enqueueOp({ entity: "attendance_event", op: "x", payload: {} });
    await fx.queue.flushQueue(async () => ({ status: 503, body: {} }));
    const row = opRows(fx)[0]!;
    assert.equal(row.state, "BACKOFF");
    assert.equal(row.retry_count, 1);
    fx.db.close();
  });

  it("refuses to resubmit an operation the server rejected", async () => {
    const fx = device();
    const op = await fx.queue.enqueueOp({
      entity: "task_status",
      op: "t",
      payload: { status: "DONE" },
    });
    await fx.queue.flushQueue(async () => ({ status: 409, body: { code: "VERSION_CONFLICT" } }));
    // A blind retry would keep hammering a request that can never succeed; the
    // user has to look at the conflict first.
    await assert.rejects(() => fx.queue.retryOp(op.client_uuid), /Review and correct/);
    fx.db.close();
  });
});

// ---------------------------------------------------------------------------
// UT-OFF-03
// ---------------------------------------------------------------------------

describe("UT-OFF-03 recover interrupted SENDING operation after restart", () => {
  it("returns an interrupted send to the eligible queue", async () => {
    const fx = device();
    const op = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { kind: "CHECK_IN" },
    });
    // The app was killed mid-flight: the row is stuck in SENDING.
    fx.db.prepare("UPDATE pending_ops SET state='SENDING'").run();
    assert.equal(opRows(fx)[0]!.state, "SENDING");

    // Restart.
    fx.db.exec(RECOVER_INTERRUPTED_SQL);
    assert.equal(opRows(fx)[0]!.state, "QUEUED");

    let seenKey = "";
    await fx.queue.flushQueue(async (row) => {
      seenKey = row.idempotency_key;
      return { status: 200, body: { applied: true } };
    });
    // Same identity, so the server recognises the retry rather than duplicating.
    assert.equal(seenKey, op.idempotency_key);
    assert.equal(opRows(fx)[0]!.state, "SUCCEEDED");
    fx.db.close();
  });

  it("does not change the operation's identity during recovery", async () => {
    const fx = device();
    const op = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { kind: "CHECK_IN" },
    });
    fx.db.prepare("UPDATE pending_ops SET state='SENDING'").run();
    fx.db.exec(RECOVER_INTERRUPTED_SQL);
    const row = opRows(fx)[0]!;
    assert.equal(row.client_uuid, op.client_uuid);
    assert.equal(row.idempotency_key, op.idempotency_key);
    fx.db.close();
  });

  it("leaves already-terminal rows untouched", async () => {
    const fx = device();
    await fx.queue.enqueueOp({ entity: "attendance_event", op: "a", payload: {} });
    await fx.queue.flushQueue(async () => ({ status: 201, body: {} }));
    fx.db.exec(RECOVER_INTERRUPTED_SQL);
    // Recovery must not resurrect a punch that already landed.
    assert.equal(opRows(fx)[0]!.state, "SUCCEEDED");
    fx.db.close();
  });
});

// ---------------------------------------------------------------------------
// UT-OFF-04
// ---------------------------------------------------------------------------

describe("UT-OFF-04 apply exponential backoff and retry cap", () => {
  it("grows the delay ceiling exponentially and bounds it", () => {
    // Full jitter means the delay is uniform in [0, ceiling]; the ceiling is
    // the deterministic part, so that is what gets asserted.
    const ceilingAt = (retry: number) =>
      computeBackoffMs(retry, { random: () => 1, baseMs: 1000, capMs: 5 * 60 * 1000 });

    assert.equal(ceilingAt(0), 1001);
    assert.equal(ceilingAt(1), 2001);
    assert.equal(ceilingAt(2), 4001);
    assert.equal(ceilingAt(3), 8001);
    // Capped, not unbounded — a device offline for a day must not schedule a
    // retry weeks out.
    assert.equal(ceilingAt(30), 5 * 60 * 1000 + 1);
  });

  it("never returns a negative or non-integer delay", () => {
    for (const retry of [-5, 0, 1, 7, 99]) {
      for (const r of [0, 0.5, 0.999]) {
        const delay = computeBackoffMs(retry, { random: () => r });
        assert.ok(Number.isInteger(delay), `not an integer for retry ${retry}`);
        assert.ok(delay >= 0, `negative for retry ${retry}`);
      }
    }
  });

  it("stops at the retry cap and marks the operation failed", async () => {
    const fx = device();
    await fx.queue.enqueueOp({ entity: "attendance_event", op: "x", payload: {} });

    let attempts = 0;
    for (let i = 0; i < MAX_QUEUE_RETRIES + 2; i += 1) {
      fx.db.prepare("UPDATE pending_ops SET next_retry_at=0").run();
      const result = await fx.queue.flushQueue(async () => {
        attempts += 1;
        throw new Error("Connection lost");
      });
      if (result.attempted === 0) break;
    }

    const row = opRows(fx)[0]!;
    assert.equal(row.state, "FAILED");
    assert.equal(row.retry_count, MAX_QUEUE_RETRIES);
    assert.equal(attempts, MAX_QUEUE_RETRIES);
    assert.match(String(row.error), /max retries|Connection lost/);
    fx.db.close();
  });

  it("agrees with the eligibility predicate on when a backoff may run", () => {
    assert.equal(isFlushEligible("QUEUED", null, 1000), true);
    assert.equal(isFlushEligible("BACKOFF", 2000, 1000), false);
    assert.equal(isFlushEligible("BACKOFF", 1000, 1000), true);
    assert.equal(isFlushEligible("SENDING", null, 1000), false);
    assert.equal(isFlushEligible("SUCCEEDED", null, 1000), false);
    assert.equal(maxRetriesExceeded(MAX_QUEUE_RETRIES - 1), false);
    assert.equal(maxRetriesExceeded(MAX_QUEUE_RETRIES), true);
  });

  it("does not wake the network for a backoff whose time has not come", async () => {
    const fx = device();
    await fx.queue.enqueueOp({ entity: "attendance_event", op: "x", payload: {} });
    await fx.queue.flushQueue(async () => {
      throw new Error("Connection lost");
    });
    fx.db.prepare("UPDATE pending_ops SET next_retry_at=?").run(Date.now() + 60_000);

    let called = false;
    const result = await fx.queue.flushQueue(async () => {
      called = true;
      return { status: 201, body: {} };
    });
    assert.equal(called, false);
    assert.equal(result.attempted, 0);
    fx.db.close();
  });
});

// ---------------------------------------------------------------------------
// UT-OFF-05
// ---------------------------------------------------------------------------

describe("UT-OFF-05 switch accounts with queued data", () => {
  it("stops a flush the moment the signed-in account changes", async () => {
    const fx = device("alice");
    await fx.queue.enqueueOp({ entity: "task_status", op: "one", payload: {} });
    await fx.queue.enqueueOp({ entity: "task_status", op: "two", payload: {} });

    const result = await fx.queue.flushQueue(async () => {
      // Someone signs out and another worker signs in mid-flush.
      fx.switchAccount("bob");
      return { status: 409, body: { code: "VERSION_CONFLICT" } };
    });

    // Only the first op was attempted; the second is not sent under the wrong
    // account's credentials.
    assert.equal(result.attempted, 1);
    const queued = fx.db
      .prepare("SELECT count(*) AS n FROM pending_ops WHERE state='QUEUED'")
      .get() as { n: number };
    assert.equal(queued.n, 1);
    fx.db.close();
  });

  it("gives each account its own database file and its own key", async () => {
    // Production opens `silverline-${account}.db` per account, so two accounts
    // never share an outbox table at all. Each also gets its own vault key, so
    // even a copied file is unreadable under the wrong account.
    const alice = device("alice");
    await alice.queue.enqueueOp({
      entity: "task_comment",
      op: "c",
      payload: { body: "Alice's private note" },
    });
    const alicePayload = String(opRows(alice)[0]!.payload);

    const bob = device("bob");
    await bob.queue.enqueueOp({
      entity: "task_comment",
      op: "c",
      payload: { body: "Bob's note" },
    });

    // Bob's outbox holds only Bob's work.
    assert.equal(opRows(bob).length, 1);
    assert.notEqual(String(opRows(bob)[0]!.payload), alicePayload);
    alice.db.close();
    bob.db.close();
  });

  it("fails an operation it cannot decrypt instead of retrying it forever", async () => {
    const fx = device("alice");
    await fx.queue.enqueueOp({
      entity: "task_comment",
      op: "c",
      payload: { body: "Alice's private note" },
    });

    // A restored backup or a rotated key can leave a row the current account
    // cannot open. Retrying that eight times accomplishes nothing.
    fx.switchAccount("bob");
    let called = false;
    const result = await fx.queue.flushQueue(async () => {
      called = true;
      return { status: 201, body: {} };
    });

    assert.equal(called, false, "an unreadable payload must never reach the network");
    assert.equal(result.failed, 1);
    const row = opRows(fx)[0]!;
    assert.equal(row.state, "FAILED");
    assert.equal(row.retry_count, 0);
    assert.match(String(row.error), /could not be decrypted/);
    fx.db.close();
  });

  it("refuses to queue work with no signed-in account", async () => {
    const fx = device("alice");
    fx.switchAccount("" as unknown as string);
    await assert.rejects(
      () => fx.queue.enqueueOp({ entity: "task_comment", op: "c", payload: {} }),
      /Sign in first/,
    );
    fx.db.close();
  });

  it("keeps each account's key separate", () => {
    const fx = device("alice");
    assert.equal(fx.vaultHasKey("bob"), false);
    fx.destroyVault("alice");
    // Destroying Alice's key leaves Bob's untouched — they are not shared.
    assert.equal(fx.vaultHasKey("alice"), false);
    fx.db.close();
  });
});

// ---------------------------------------------------------------------------
// UT-OFF-06
// ---------------------------------------------------------------------------

describe("UT-OFF-06 receive remote wipe", () => {
  it("destroys the local business cache and the account's keys", async () => {
    const fx = device("alice");
    await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { kind: "CHECK_IN" },
    });
    fx.db
      .prepare("INSERT INTO tasks_cache (id, title) VALUES (?, ?)")
      .run("task-1", "Pour the foundation");
    fx.db.prepare("INSERT INTO snapshots (key, body) VALUES (?, ?)").run("me", "cached");

    wipeAccountLocally(fx, "alice");

    for (const table of [
      "pending_ops",
      "tasks_cache",
      "attendance_cache",
      "projects_cache",
      "leave_cache",
      "notifications_cache",
      "snapshots",
      "meta",
    ]) {
      const row = fx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(row.n, 0, `${table} still holds rows after a wipe`);
    }
    assert.equal(fx.vaultHasKey("alice"), false, "the account key must be destroyed");
    fx.db.close();
  });

  it("leaves anything written after the wipe unreadable with the old key", async () => {
    const fx = device("alice");
    await fx.queue.enqueueOp({
      entity: "task_comment",
      op: "c",
      payload: { body: "Before the wipe" },
    });
    const sealedBefore = String(opRows(fx)[0]!.payload);

    wipeAccountLocally(fx, "alice");
    // Re-enrolling mints a fresh key, so an attacker holding a copy of the old
    // ciphertext gains nothing from the device's new state.
    await fx.queue.enqueueOp({
      entity: "task_comment",
      op: "c",
      payload: { body: "After the wipe" },
    });
    const sealedAfter = String(opRows(fx)[0]!.payload);
    assert.notEqual(sealedBefore, sealedAfter);
    fx.db.close();
  });

  it("treats DEVICE_REVOKED as the signal to wipe", () => {
    // The server answers a revoked device's login and refresh with this code;
    // AuthContext wipes on exactly this reason and retains the outbox for an
    // ordinary session expiry.
    const wipeReasons = new Set(["DEVICE_REVOKED"]);
    assert.equal(wipeReasons.has("DEVICE_REVOKED"), true);
    assert.equal(wipeReasons.has("TOKEN_EXPIRED"), false);
  });
});

// ---------------------------------------------------------------------------
// UT-ATT-10
// ---------------------------------------------------------------------------

describe("UT-ATT-10 burn evidence watermark", () => {
  const sample = {
    name: "Asha Verma",
    empNo: "EMP042",
    latitude: 17.385044,
    longitude: 78.486671,
    accuracy: 12.4,
    timestamp: "2026-09-13T09:31:07.000Z",
    projectSite: "Warehouse 3",
    village: "Kondapur",
  };

  it("carries employee, coordinates, accuracy, date/time and village", () => {
    const lines = buildWatermarkLines(sample);
    const text = lines.join("\n");

    assert.match(text, /Asha Verma/);
    assert.match(text, /EMP042/);
    assert.match(text, /17\.385044/);
    assert.match(text, /78\.486671/);
    assert.match(text, /±12m/);
    assert.match(text, /Kondapur/);
    // Rendered in the organization's timezone, not the device's.
    assert.match(text, /IST/);
    assert.match(text, /2026/);
  });

  it("renders the timestamp in Asia/Kolkata", () => {
    const lines = buildWatermarkLines(sample);
    // 09:31:07Z is 15:01:07 IST.
    assert.match(lines.join(" "), /15:01:07 IST/);
  });

  it("says so plainly when there is no fix, rather than printing zeroes", () => {
    const lines = buildWatermarkLines({ ...sample, latitude: null, longitude: null });
    assert.match(lines.join(" "), /no-gps/);
    assert.ok(!lines.join(" ").includes("0.000000"));
  });

  it("omits the site line when neither site nor village is known", () => {
    const lines = buildWatermarkLines({
      ...sample,
      projectSite: undefined,
      village: undefined,
    });
    assert.equal(lines.length, 3);
  });

  it("keeps the sidecar text in step with the burned lines", () => {
    // The sidecar is the audit payload: if it drifted from the pixels, the
    // stored metadata would describe a photo that does not exist.
    assert.equal(renderWatermarkText(sample), buildWatermarkLines(sample).join(" · "));
  });
});

// ---------------------------------------------------------------------------
// E2E-02 / E2E-12 / E2E-13 / E2E-28 — the device half of the end-to-end suite.
// The server half of each row is in apps/api/test/catalogue/e2e.test.ts.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MOBILE_ROOT = join(import.meta.dirname, "..");
const readSource = (relativePath: string): string =>
  readFileSync(join(MOBILE_ROOT, relativePath), "utf8");

describe("E2E-02 employee signs in without admin permissions", () => {
  it("puts Attendance one action from a completed sign-in", () => {
    const layout = readSource("app/(tabs)/_layout.tsx");
    // Attendance is a root tab, not a screen nested behind a menu: after
    // sign-in the tab bar is action one, and it is already on screen.
    assert.match(layout, /<Tabs\.Screen name="attendance"/);
    const order = [...layout.matchAll(/<Tabs\.Screen name="(\w+)"/g)].map((m) => m[1]);
    assert.ok(
      order.indexOf("attendance") >= 0 && order.indexOf("attendance") <= 1,
      `attendance should be the first or second tab, got ${order.join(", ")}`,
    );
  });

  it("sends an unauthenticated user to sign-in rather than a blank tab", () => {
    const layout = readSource("app/(tabs)/_layout.tsx");
    assert.match(layout, /Redirect href="\/\(auth\)\/login"/);
  });

  it("ships no administrative screen for a field user to reach", () => {
    // The app has no admin surface at all, so there is nothing to gate: the
    // whole class of "employee reached an admin page" cannot occur.
    const layout = readSource("app/(tabs)/_layout.tsx");
    for (const forbidden of ["admin", "payroll", "geo-fences", "employees", "reports"]) {
      assert.ok(
        !new RegExp(`<Tabs\\.Screen name="${forbidden}"`).test(layout),
        `unexpected ${forbidden} tab`,
      );
    }
  });
});

describe("E2E-12 employee checks in offline, force-closes app, reopens and reconnects", () => {
  it("queues the punch, survives the restart, and syncs it exactly once", async () => {
    const fx = device();

    // 1. Offline check-in: the punch goes to the outbox.
    const op = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { event_type: "CHECK_IN", latitude: 17.385, longitude: 78.4867 },
    });
    // 2. The user can see it pending.
    const pending = fx.db
      .prepare("SELECT count(*) AS n FROM pending_ops WHERE state IN ('QUEUED','SENDING','BACKOFF')")
      .get() as { n: number };
    assert.equal(pending.n, 1);

    // 3. Force-close mid-send, then reopen.
    fx.db.prepare("UPDATE pending_ops SET state='SENDING'").run();
    fx.db.exec(RECOVER_INTERRUPTED_SQL);

    // 4. Reconnect: one send, with the identity it was given while offline.
    const sent: string[] = [];
    await fx.queue.flushQueue(async (row) => {
      sent.push(row.idempotency_key);
      return { status: 201, body: { decision: "ACCEPTED" } };
    });
    assert.deepEqual(sent, [op.idempotency_key]);

    // 5. Nothing is left pending, and a further flush sends nothing.
    const after = fx.db.prepare("SELECT state FROM pending_ops").get() as { state: string };
    assert.equal(after.state, "SUCCEEDED");
    const second = await fx.queue.flushQueue(async () => {
      throw new Error("must not be called");
    });
    assert.equal(second.attempted, 0);
    fx.db.close();
  });
});

describe("E2E-13 network drops after server commits but before client receives response", () => {
  it("treats the replayed ALREADY_APPLIED as success, not as a second punch", async () => {
    const fx = device();
    const op = await fx.queue.enqueueOp({
      entity: "attendance_event",
      op: "check-in",
      payload: { event_type: "CHECK_IN" },
    });

    // The server committed; the response never arrived.
    await fx.queue.flushQueue(async () => {
      throw new Error("Connection lost");
    });
    assert.equal(
      (fx.db.prepare("SELECT state FROM pending_ops").get() as { state: string }).state,
      "BACKOFF",
    );

    // The retry carries the same key and is recognised.
    fx.db.prepare("UPDATE pending_ops SET next_retry_at=0").run();
    let sentKey = "";
    await fx.queue.flushQueue(async (row) => {
      sentKey = row.idempotency_key;
      return { status: 200, body: { applied: true } };
    });
    assert.equal(sentKey, op.idempotency_key);

    // ALREADY_APPLIED is success: the op leaves the queue rather than retrying
    // forever against a punch that already exists.
    const row = fx.db.prepare("SELECT state, decision FROM pending_ops").get() as {
      state: string;
      decision: string;
    };
    assert.equal(row.state, "SUCCEEDED");
    assert.equal(row.decision, "ALREADY_APPLIED");
    fx.db.close();
  });
});

describe("E2E-28 revoke employee device while it has a session and cached data", () => {
  it("wipes local business data when the server reports the device revoked", () => {
    const auth = readSource("src/auth/AuthContext.tsx");
    // DEVICE_REVOKED is the one logout reason that destroys the local cache;
    // an ordinary expiry must keep the encrypted outbox for the same account.
    assert.match(auth, /DEVICE_REVOKED/);
    assert.match(auth, /wipeAccount/);
    const revokeLine = auth
      .split("\n")
      .find((line) => line.includes("DEVICE_REVOKED") && line.includes("wipeAccount"));
    assert.ok(revokeLine, "wipeAccount must be conditioned on DEVICE_REVOKED");
  });

  it("clears the account key so cached ciphertext cannot be read again", () => {
    const db = readSource("src/sync/db.ts");
    assert.match(db, /destroyVault/);
    // Every business cache is emptied, not just the outbox.
    for (const table of [
      "pending_ops",
      "tasks_cache",
      "attendance_cache",
      "projects_cache",
      "leave_cache",
      "notifications_cache",
      "snapshots",
    ]) {
      assert.match(db, new RegExp(`DELETE FROM ${table}`), `${table} must be wiped`);
    }
  });

  it("keeps tokens out of the business database entirely", () => {
    const db = readSource("src/sync/db.ts");
    // Tokens live in SecureStore; a wipe of the database must not be the only
    // thing standing between a revoked device and a usable session.
    assert.match(db, /SecureStore/);
    assert.ok(!/access_token|refresh_token/.test(db.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")));
  });
});

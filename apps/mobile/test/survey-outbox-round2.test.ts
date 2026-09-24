/**
 * Fix round 2: a crew member's second go at the same day, through the real
 * outbox (createQueue / flushQueue / runSurveyEntryOp), against a fake server
 * that behaves as the API does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createQueue, type QueueDatabase } from "../src/sync/queueCore";
import { SCHEMA_SQL } from "../src/sync/schema";
import { runSurveyEntryOp, supersedeSurveyEntry } from "../src/sync/surveyEntryOp";
import {
  amendmentFor, conflictReview, draftFromEntry, returnSubmission, type FiledEntry,
} from "../src/survey/fieldCrew";
import { emptyDraft } from "../src/survey/returnForm";

class FakeApiError extends Error {
  constructor(public status: number, public code: string, message: string,
    public retryable = false) { super(message); }
}

const V = "123e4567-e89b-12d3-a456-426614174000";
const D = "2026-09-24";
const MEASURES = [
  { id: "m1", code: "PVT", label: "Private extent", group_label: null, unit: "acres", basis: "EXTENT", display_order: 1 },
  { id: "m2", code: "VB", label: "Boundary points", group_label: null, unit: "points", basis: "TARGET", display_order: 2 },
];
const VILLAGE = { id: V, low_progress_threshold_ac: null, gt_state: null, gt_expected_end_on: null,
  gt_completed_on: null, gt_variance_reason: null };

function server() {
  let row: (FiledEntry & { survey_village_id: string }) | null = null;
  let posts = 0;
  const keys = new Map<string, { hash: string; response: unknown }>();
  const patches: Array<Record<string, any>> = [];
  const idem = (key: string, body: unknown, run: () => unknown) => {
    const hash = JSON.stringify(body);
    const prior = keys.get(key);
    if (prior) {
      if (prior.hash !== hash) throw new FakeApiError(409, "IDEMPOTENCY_CONFLICT", "Key was already used for another request");
      return prior.response;
    }
    const response = run();
    keys.set(key, { hash, response });
    return response;
  };
  return {
    patches,
    get posts() { return posts; },
    get row() { return row; },
    edit(values: Record<string, number>) {
      row = { ...row!, values: { ...row!.values, ...values }, version: row!.version + 1 };
    },
    deps: {
      post: async (entry: any, key: string) => idem(key, entry, () => {
        if (row) throw new FakeApiError(409, "ALREADY_ENTERED", "Amend it instead.");
        posts += 1;
        row = { id: "e1", version: 1, entry_date: entry.entry_date, survey_village_id: V,
          teams_deployed: entry.teams_deployed ?? 0, notes: entry.notes ?? null,
          govt_staff_present: entry.govt_staff_present ?? null, crew_present: entry.crew_present ?? null,
          values: { ...entry.values } };
        return { ...row };
      }),
      getFiled: async () => (row ? { ...row, values: { ...row.values } } : null),
      patch: async (id: string, version: number, body: any, key: string) => idem(key, body, () => {
        if (!row || version !== row.version) throw new FakeApiError(409, "VERSION_CONFLICT", "stale");
        patches.push(body);
        const values = { ...row.values };
        for (const [c, q] of Object.entries(body.values ?? {})) {
          if (q === 0) delete values[c]; else values[c] = q as number;
        }
        const rest = Object.fromEntries(Object.entries(body)
          .filter(([k]) => k !== "values" && k !== "amendment_reason"));
        row = { ...row, ...rest, values, version: row.version + 1 };
        return { ...row };
      }),
      conflict: (message: string) => new FakeApiError(409, "SURVEY_DAY_CHANGED", message),
    },
  };
}

function outbox() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  const port: QueueDatabase = {
    getFirstAsync: async <T>(sql: string, p: (string | number | null)[]) =>
      (db.prepare(sql).get(...p) as T) ?? null,
    getAllAsync: async <T>(sql: string, p: (string | number | null)[]) =>
      db.prepare(sql).all(...p) as T[],
    runAsync: async (sql, p) => db.prepare(sql).run(...p),
  };
  const queue = createQueue({
    getDb: async () => port, getAccount: async () => "crew", uuid: randomUUID,
    isApiError: (e): e is Error & { status: number; retryable: boolean; code: string } =>
      e instanceof FakeApiError,
    seal: async (_id, v) => v, unseal: async (_id, v) => v,
  });
  const rows = () => db.prepare("SELECT client_uuid, state, decision, error FROM pending_ops ORDER BY seq").all() as
    Array<{ client_uuid: string; state: string; decision: string | null; error: string | null }>;
  return { db, queue, rows };
}

/** What DailyReturn queues, through the same builder and the same enqueue options. */
async function file(o: ReturnType<typeof outbox>, quantities: Record<string, string>,
  filed: FiledEntry | null = null) {
  const draft = filed ? { ...draftFromEntry(filed, MEASURES), quantities } : { ...emptyDraft(), quantities };
  const built = returnSubmission({ village: VILLAGE, workDate: D, measures: MEASURES, draft, kit: [] });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return o.queue.enqueueOp({
    entity: built.op.entity, op: built.op.op, payload: built.op.payload as any,
    ...(built.op.baseVersion !== undefined ? { baseVersion: built.op.baseVersion } : {}),
    supersede: supersedeSurveyEntry,
  });
}

describe("filing the same day twice before the first one is sent", () => {
  it("lands one entry with the second figures (never sent: the op is replaced)", async () => {
    const s = server(), o = outbox();
    const a = await file(o, { PVT: "5" });
    const b = await file(o, { PVT: "8", VB: "30" });
    assert.equal(a.client_uuid, b.client_uuid);
    assert.equal(o.rows().length, 1);
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.rows()[0].state, "SUCCEEDED");
    assert.equal(s.posts, 1);
    assert.deepEqual(s.row!.values, { PVT: 8, VB: 30 });
  });

  it("lands the second figures even when the first attempt reached the server and its reply was lost", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "5" });
    let lost = true;
    await o.queue.flushQueue(async op => {
      const r = await runSurveyEntryOp(op, s.deps);
      if (lost) { lost = false; throw new Error("socket hang up"); }
      return r;
    });
    assert.equal(o.rows()[0].state, "BACKOFF");
    await file(o, { PVT: "8" });                      // re-filed while still waiting
    assert.equal(o.rows().length, 1);
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0").run();
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.rows()[0].state, "SUCCEEDED", JSON.stringify(o.rows()));
    assert.equal(s.posts, 1);
    assert.deepEqual(s.row!.values, { PVT: 8 });
    assert.equal(s.patches.length, 1);
  });

  it("still refuses to overwrite a day somebody else changed after the first attempt landed", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "5" });
    let lost = true;
    await o.queue.flushQueue(async op => {
      const r = await runSurveyEntryOp(op, s.deps);
      if (lost) { lost = false; throw new Error("socket hang up"); }
      return r;
    });
    s.edit({ PVT: 50 });                                // supervisor, meanwhile
    await file(o, { PVT: "8" });
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0").run();
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.rows()[0].decision, "CONFLICT");
    assert.deepEqual(s.row!.values, { PVT: 50 });
  });
});

describe("a conflicted return can be reviewed and re-submitted without re-typing", () => {
  it("opens the crew's figures against the server's, and re-submits on the current version", async () => {
    const s = server(), o = outbox();
    await s.deps.post({ survey_village_id: V, entry_date: D, values: { PVT: 5, VB: 40 } }, "crew-a");
    const seen = (await s.deps.getFiled())!;
    s.edit({ PVT: 50 });                                              // supervisor
    await file(o, { PVT: "6", VB: "40" }, seen);                      // stale correction
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    const conflicted = o.rows()[0];
    assert.equal(conflicted.decision, "CONFLICT");

    // Review: the queued draft, read back, beside the server's day now.
    const payload = await o.queue.readPayload(conflicted.client_uuid);
    const current = (await s.deps.getFiled())!;
    const review = conflictReview(payload as any, current, MEASURES);
    assert.equal(review.draft.quantities.PVT, "6");
    assert.equal(review.draft.baseVersion, current.version);
    assert.deepEqual(review.differences.map(d => d.code), ["PVT"]);
    assert.match(review.differences[0].note, /50/);

    // Re-submit from the review, then the old row is let go.
    const built = returnSubmission({ village: VILLAGE, workDate: D, measures: MEASURES,
      draft: review.draft, kit: [] });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    await o.queue.discardOp(conflicted.client_uuid);
    await o.queue.enqueueOp({ entity: built.op.entity, op: built.op.op,
      payload: built.op.payload as any, baseVersion: built.op.baseVersion,
      supersede: supersedeSurveyEntry });
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.rows().length, 1);
    assert.equal(o.rows()[0].state, "SUCCEEDED");
    assert.deepEqual(s.row!.values, { PVT: 6, VB: 40 });
  });
});

describe("the base version is pinned when the form is filled (round 2, item 2)", () => {
  it("keeps the version the crew saw even if a later read of the day moves on", () => {
    const seen: FiledEntry = { id: "e1", version: 4, entry_date: D, values: { PVT: 3 } };
    const draft = draftFromEntry(seen, MEASURES);
    assert.equal(draft.baseVersion, 4);
    // The screen's query refetches and now holds version 5; the op must not follow.
    const built = returnSubmission({ village: VILLAGE, workDate: D, measures: MEASURES,
      draft: { ...draft, quantities: { PVT: "9" } }, kit: [],
      filed: { ...seen, version: 5 } });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.op.baseVersion, 4);
  });
});


/**
 * Final-review fix 1: a conflicted return is reviewed for ITS day, not today.
 *
 * Monday's correction, conflicted and reviewed on Tuesday, used to be built
 * with Tuesday's date: saved as a new Tuesday return or merged onto Tuesday,
 * and the Monday op was then discarded. Driven through the real queue and
 * executor against a fake server that keeps one entry per day and refuses a
 * past-day amendment to anyone but a manager, as the API does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createQueue, type QueueDatabase } from "../src/sync/queueCore";
import { SCHEMA_SQL } from "../src/sync/schema";
import { runSurveyEntryOp, surveyEntryChain, type SurveyEntryDeps } from "../src/sync/surveyEntryOp";
import { conflictReview, draftFromEntry, returnSubmission, type FiledEntry } from "../src/survey/fieldCrew";
import { reviewDay, submitReview } from "../src/survey/reviewSubmit";

class FakeApiError extends Error {
  constructor(public status: number, public code: string, message: string,
    public retryable = false) { super(message); }
}

const V = "123e4567-e89b-12d3-a456-426614174000";
const MON = "2026-09-21", TUE = "2026-09-22";
const MEASURES = [
  { id: "m1", code: "PVT", label: "Private extent", group_label: null, unit: "acres", basis: "EXTENT", display_order: 1 },
];
const VILLAGE = { id: V, low_progress_threshold_ac: null, gt_state: null, gt_expected_end_on: null,
  gt_completed_on: null, gt_variance_reason: null };

function daysServer(opts: { today: string; manager: boolean }) {
  const rows = new Map<string, FiledEntry & { survey_village_id: string }>();
  const keys = new Map<string, { hash: string; response: unknown }>();
  let posts = 0;
  const idem = (key: string, body: unknown, run: () => unknown) => {
    const hash = JSON.stringify(body), prior = keys.get(key);
    if (prior) {
      if (prior.hash !== hash) throw new FakeApiError(409, "IDEMPOTENCY_CONFLICT", "Key reused");
      return prior.response;
    }
    const response = run();
    keys.set(key, { hash, response });
    return response;
  };
  const deps: SurveyEntryDeps = {
    post: async (entry: any, key: string) => idem(key, entry, () => {
      if (rows.has(entry.entry_date)) throw new FakeApiError(409, "ALREADY_ENTERED", "Amend it instead.");
      posts += 1;
      const row = { id: `e-${entry.entry_date}`, version: 1, entry_date: entry.entry_date,
        survey_village_id: V, values: { ...entry.values } };
      rows.set(entry.entry_date, row);
      return { ...row };
    }),
    getFiled: async (_v: string, date: string) => {
      const r = rows.get(date);
      return r ? { ...r, values: { ...r.values } } : null;
    },
    patch: async (id: string, version: number, body: any, key: string) => idem(key, body, () => {
      const row = [...rows.values()].find(r => r.id === id);
      if (!row) throw new FakeApiError(404, "NOT_FOUND", "gone");
      if (row.entry_date !== opts.today && !opts.manager) {
        throw new FakeApiError(403, "PAST_DAY_AMENDMENT", "Correcting an earlier day needs a programme manager.");
      }
      if (version !== row.version) throw new FakeApiError(409, "VERSION_CONFLICT", "stale");
      const values = { ...row.values };
      for (const [c, q] of Object.entries(body.values ?? {})) {
        if (q === 0) delete values[c]; else values[c] = q as number;
      }
      const next = { ...row, values, version: row.version + 1 };
      rows.set(row.entry_date, next);
      return { ...next };
    }),
    conflict: (message: string) => new FakeApiError(409, "SURVEY_DAY_CHANGED", message),
  };
  return {
    deps, rows, get posts() { return posts; },
    edit(date: string, values: Record<string, number>) {
      const r = rows.get(date)!;
      rows.set(date, { ...r, values: { ...r.values, ...values }, version: r.version + 1 });
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
    chains: { survey_entry: surveyEntryChain },
  });
  const rows = () => db.prepare("SELECT client_uuid, op, state, decision FROM pending_ops ORDER BY seq").all() as
    Array<{ client_uuid: string; op: string; state: string; decision: string | null }>;
  return { db, queue, rows };
}

/** Monday filed, the supervisor corrects it, the crew's stale Monday correction conflicts. */
async function mondayConflict(s: ReturnType<typeof daysServer>, o: ReturnType<typeof outbox>) {
  await s.deps.post({ survey_village_id: V, entry_date: MON, values: { PVT: 5 } }, "crew-first");
  const seen = (await s.deps.getFiled(V, MON))!;
  s.edit(MON, { PVT: 50 });
  const built = returnSubmission({ village: VILLAGE, workDate: MON, measures: MEASURES,
    draft: { ...draftFromEntry(seen, MEASURES), quantities: { PVT: "6" } }, kit: [] });
  if (!built.ok) throw new Error("unreachable");
  await o.queue.enqueueOp({ entity: built.op.entity, op: built.op.op, payload: built.op.payload as any,
    baseVersion: built.op.baseVersion });
  await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
  const conflicted = o.rows()[0];
  assert.equal(conflicted.decision, "CONFLICT");
  const payload = await o.queue.readPayload(conflicted.client_uuid) as any;
  return { clientUuid: conflicted.client_uuid, payload };
}

async function review(s: ReturnType<typeof daysServer>, o: ReturnType<typeof outbox>,
  r: { clientUuid: string; payload: any }, canManage: boolean) {
  // The form loads the op's day, not today's.
  const plan = reviewDay(r.payload, TUE, canManage);
  const filed = (await s.deps.getFiled(V, plan.date))!;
  const { draft } = conflictReview(r.payload, filed, MEASURES);
  return submitReview({
    review: r, village: VILLAGE, measures: MEASURES, draft, kit: [], filed,
    workDate: TUE, canManage,
    enqueue: async op => {
      await o.queue.enqueueOp({ entity: op.entity, op: op.op, payload: op.payload as any,
        ...(op.baseVersion !== undefined ? { baseVersion: op.baseVersion } : {}) });
      await o.queue.flushQueue(q => runSurveyEntryOp(q, s.deps));
      const last = o.rows().at(-1)!;
      if (last.state !== "SUCCEEDED") throw new Error(`replacement ${last.state}`);
      return "Saved.";
    },
    discard: id => o.queue.discardOp(id),
  });
}

describe("reviewing a conflicted return on a later day", () => {
  it("as a manager: amends Monday's entry, creates no Tuesday entry, and only then lets the op go", async () => {
    const s = daysServer({ today: TUE, manager: true }), o = outbox();
    const r = await mondayConflict(s, o);
    const out = await review(s, o, r, true);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(s.rows.get(MON)!.values, { PVT: 6 });
    assert.equal(s.rows.has(TUE), false, "no Tuesday entry");
    assert.equal(s.posts, 1);
    const left = o.rows();
    assert.equal(left.some(x => x.client_uuid === r.clientUuid), false, "the conflicted op was answered");
    assert.ok(left.every(x => x.op.endsWith(MON)), JSON.stringify(left));
  });

  it("as crew: says a past day needs the PM up front, queues nothing and keeps the op", async () => {
    const s = daysServer({ today: TUE, manager: false }), o = outbox();
    const r = await mondayConflict(s, o);
    const plan = reviewDay(r.payload, TUE, false);
    assert.equal(plan.date, MON);
    assert.equal(plan.blocked, true);
    assert.match(plan.notice ?? "", /PM/);
    assert.match(plan.notice ?? "", /Sync queue/);
    const out = await review(s, o, r, false);
    assert.equal(out.ok, false);
    assert.deepEqual(s.rows.get(MON)!.values, { PVT: 50 });
    assert.equal(s.rows.has(TUE), false);
    assert.deepEqual(o.rows().map(x => [x.client_uuid, x.decision]), [[r.clientUuid, "CONFLICT"]]);
  });

  it("keeps the original op when the replacement cannot be queued", async () => {
    const s = daysServer({ today: TUE, manager: true }), o = outbox();
    const r = await mondayConflict(s, o);
    const filed = (await s.deps.getFiled(V, MON))!;
    const out = await submitReview({
      review: r, village: VILLAGE, measures: MEASURES,
      draft: conflictReview(r.payload, filed, MEASURES).draft, kit: [], filed,
      workDate: TUE, canManage: true,
      enqueue: async () => { throw new Error("storage full"); },
      discard: id => o.queue.discardOp(id),
    }).catch(e => ({ ok: false as const, problems: [String(e)] }));
    assert.equal(out.ok, false);
    assert.equal(o.rows()[0].client_uuid, r.clientUuid);
  });

  it("says the correction is queued when only removing the old copy fails", async () => {
    const s = daysServer({ today: TUE, manager: true }), o = outbox();
    const r = await mondayConflict(s, o);
    const filed = (await s.deps.getFiled(V, MON))!;
    let queued = 0;
    const out = await submitReview({
      review: r, village: VILLAGE, measures: MEASURES,
      draft: conflictReview(r.payload, filed, MEASURES).draft, kit: [], filed,
      workDate: TUE, canManage: true,
      enqueue: async () => { queued += 1; return "Saved."; },
      discard: async () => { throw new Error("locked"); },
    });
    assert.equal(queued, 1);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.match(out.message, /correction is queued/);
    assert.doesNotMatch(out.message, /kept in the Sync queue/);
  });

  it("a same-day review is not blocked, for crew too", () => {
    const plan = reviewDay({ entry_date: TUE }, TUE, false);
    assert.deepEqual([plan.date, plan.blocked], [TUE, false]);
  });
});

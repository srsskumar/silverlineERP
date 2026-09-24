/**
 * Fix round 5: a filing made while a flush is settling an op, and the size
 * of what an op remembers having sent (`_prior`).
 *
 * The interleavings are forced at exact points: the fake outbox runs a hook
 * just before a matching write, and the hook starts an enqueue without
 * awaiting it, then yields. Before the fix the enqueue ran inside the flush's
 * read-modify-write (or the flush inside the enqueue's); with the queue lock
 * it waits its turn. The invariant is asserted after every step, and each
 * case ends with the latest figures on the server, one entry and no CONFLICT.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSurveyEntryOp, PRIOR_MAX } from "../src/sync/surveyEntryOp";
import { returnSubmission } from "../src/survey/fieldCrew";
import { emptyDraft } from "../src/survey/returnForm";
import { D, MEASURES, VILLAGE, outbox, server } from "./support/surveyOutbox";

type O = ReturnType<typeof outbox>;
type S = ReturnType<typeof server>;

const tick = () => new Promise<void>(r => setImmediate(r));
const ticks = async (n: number) => { for (let i = 0; i < n; i += 1) await tick(); };

function invariant(o: O) {
  const rows = o.db.prepare(
    "SELECT seq, state FROM pending_ops WHERE entity='survey_entry' AND state IN ('QUEUED','BACKOFF','SENDING') ORDER BY seq").all() as
    Array<{ seq: number; state: string }>;
  const waiting = rows.filter(r => r.state !== "SENDING");
  const sending = rows.filter(r => r.state === "SENDING");
  assert.ok(waiting.length <= 1, `more than one waiting op: ${JSON.stringify(rows)}`);
  assert.ok(sending.length <= 1, `more than one sending op: ${JSON.stringify(rows)}`);
  if (waiting.length && sending.length) {
    assert.ok(sending[0].seq < waiting[0].seq, `the sending op must be ahead: ${JSON.stringify(rows)}`);
  }
  const failed = o.db.prepare("SELECT state, decision, error FROM pending_ops WHERE state='FAILED'").all();
  assert.deepEqual(failed, [], "no op failed");
}

async function file(o: O, quantities: Record<string, string>) {
  const built = returnSubmission({ village: VILLAGE, workDate: D, measures: MEASURES,
    draft: { ...emptyDraft(), quantities }, kit: [] });
  if (!built.ok) throw new Error(built.problems.join(" "));
  const op = await o.queue.enqueueOp({ entity: built.op.entity, op: built.op.op,
    payload: built.op.payload as any });
  invariant(o);
  return op;
}

const exec = (o: O, s: S, deps: Partial<S["deps"]> = {}) => (op: any) =>
  runSurveyEntryOp(op, { ...s.deps, ...deps, remember: (id, p) => o.queue.rewriteOp(id, p) });

async function drain(o: O, s: S) {
  for (let i = 0; i < 4; i += 1) {
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0 WHERE state = 'BACKOFF'").run();
    await o.queue.flushQueue(exec(o, s));
    invariant(o);
  }
}

function settled(o: O, s: S, values: Record<string, number>) {
  const rows = o.db.prepare("SELECT state, decision, error FROM pending_ops").all() as
    Array<{ state: string; decision: string | null; error: string | null }>;
  assert.ok(rows.every(r => r.state === "SUCCEEDED"), JSON.stringify(rows));
  assert.deepEqual(s.row!.values, values);
  assert.equal(s.posts, 1, "one entry");
}

/** The `_prior` list of every active survey op. */
function priors(o: O): unknown[][] {
  const rows = o.db.prepare(
    "SELECT payload FROM pending_ops WHERE entity='survey_entry' AND state IN ('QUEUED','BACKOFF','SENDING')").all() as
    Array<{ payload: string }>;
  return rows.map(r => (JSON.parse(r.payload)._prior ?? []) as unknown[]);
}

describe("an enqueue interleaved with a flush that is settling an op (round 5, item 1)", () => {
  it("a re-file folded into the waiting op while the hand-over is being written is not overwritten", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });                                        // A
    let refile: Promise<unknown> | null = null;
    // The flush has read the waiting op and merged A's requests into it;
    // just before it writes the merge back, the crew files again.
    o.before(/COALESCE\(base_version/, async () => {
      refile = file(o, { PVT: "4" });
      await ticks(5);
    });
    let first = true;
    await o.queue.flushQueue(async op => {
      if (first) { first = false; await file(o, { PVT: "3" }); }         // C behind A
      return exec(o, s)(op);
    });
    assert.ok(refile, "the hand-over was written");
    await refile;
    invariant(o);
    await drain(o, s);
    settled(o, s, { PVT: 4 });
  });

  it("a hand-over (then absorb) while a re-file is folding into the waiting op keeps the older op's requests", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });                                        // A
    await o.queue.flushQueue(async op => {                               // A lands, reply lost
      await exec(o, s)(op);
      throw new Error("socket hang up");
    });
    invariant(o);
    await file(o, { PVT: "2" });                                        // folds into A (BACKOFF)
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0").run();
    let hooked = false;
    // The re-file has read the waiting op and merged; it pauses just before
    // writing, and the flush settles A meanwhile.
    o.before(/SET payload = \?, base_version = \?, updated_at = \?/, async () => {
      hooked = true;
      await ticks(5);
    });
    let refile: Promise<unknown> | null = null;
    let first = true;
    await o.queue.flushQueue(async op => {
      if (!first) return exec(o, s)(op);
      first = false;
      await file(o, { PVT: "3" });                                        // C behind A (A SENDING)
      await exec(o, s)(op);                                              // A recovers v1, PATCHes to v2...
      refile = file(o, { PVT: "4" });                                    // ...the crew files again...
      for (let i = 0; i < 10 && !hooked; i += 1) await tick();
      assert.ok(hooked, "the re-file reached its write");
      throw new Error("socket hang up");                                 // ...and A's PATCH reply is lost
    });
    await refile;
    invariant(o);
    await drain(o, s);
    settled(o, s, { PVT: 4 });
  });
});

describe("what an op remembers having sent stays small (round 5, item 2)", () => {
  it("re-filing a never-sent op records nothing", async () => {
    const s = server(), o = outbox();
    for (let i = 1; i <= 20; i += 1) {
      await file(o, { PVT: String(i) });
      assert.deepEqual(priors(o), [[]]);
    }
    await drain(o, s);
    settled(o, s, { PVT: 20 });
  });

  it("repeated lost replies with a re-file each time keep one or two entries", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });
    for (let i = 2; i <= 12; i += 1) {
      o.db.prepare("UPDATE pending_ops SET next_retry_at = 0, retry_count = 0").run();
      await o.queue.flushQueue(async op => { await exec(o, s)(op); throw new Error("timeout"); });
      invariant(o);
      assert.ok(priors(o)[0].length <= 2, JSON.stringify(priors(o)));
      await file(o, { PVT: String(i) });
      assert.ok(priors(o)[0].length <= 2, JSON.stringify(priors(o)));
    }
    await drain(o, s);
    settled(o, s, { PVT: 12 });
  });

  it("many attempts that never reached the server are capped, and the one that landed is kept", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });
    await o.queue.flushQueue(async op => { await exec(o, s)(op); throw new Error("timeout"); });  // landed, lost
    const offline = { post: async () => { throw new Error("network down"); } };
    for (let i = 2; i <= 20; i += 1) {
      await file(o, { PVT: String(i) });
      o.db.prepare("UPDATE pending_ops SET next_retry_at = 0, retry_count = 0").run();
      await o.queue.flushQueue(exec(o, s, offline));
      invariant(o);
      assert.ok(priors(o)[0].length <= PRIOR_MAX, JSON.stringify(priors(o)));
    }
    await drain(o, s);
    settled(o, s, { PVT: 20 });
  });
});

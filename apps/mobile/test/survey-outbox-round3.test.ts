/**
 * Fix round 3: races between a running flush and a new filing, the review's
 * full diff, and a superseded correction whose amend reply was lost.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSurveyEntryOp, supersedeSurveyEntry } from "../src/sync/surveyEntryOp";
import { draftFromEntry, returnSubmission, type FiledEntry } from "../src/survey/fieldCrew";
import { emptyDraft } from "../src/survey/returnForm";
import { D, MEASURES, V, VILLAGE, outbox, server } from "./support/surveyOutbox";

type O = ReturnType<typeof outbox>;
type S = ReturnType<typeof server>;

async function file(o: O, quantities: Record<string, string>, filed: FiledEntry | null = null) {
  const draft = filed ? { ...draftFromEntry(filed, MEASURES), quantities } : { ...emptyDraft(), quantities };
  const built = returnSubmission({ village: VILLAGE, workDate: D, measures: MEASURES, draft, kit: [] });
  if (!built.ok) throw new Error(built.problems.join(" "));
  return o.queue.enqueueOp({
    entity: built.op.entity, op: built.op.op, payload: built.op.payload as any,
    ...(built.op.baseVersion !== undefined ? { baseVersion: built.op.baseVersion } : {}),
    supersede: supersedeSurveyEntry,
  });
}

/** The production executor, with the outbox's own rewrite as its memory. */
const exec = (o: O, s: S) => (op: any) =>
  op.entity === "survey_entry"
    ? runSurveyEntryOp(op, { ...s.deps, remember: (id, p) => o.queue.rewriteOp(id, p) })
    : Promise.resolve({ status: 201, body: {} });

describe("a new filing while a flush is running loses nothing (round 3, item 1)", () => {
  it("sends the latest figures when the flush read the row before a supersede rewrote it", async () => {
    const s = server(), o = outbox();
    // Something ahead of the return, so the flush has already read the
    // return's row by the time the crew re-files.
    await o.queue.enqueueOp({ entity: "task_comment", op: "c1", payload: { body: "hi" } });
    await file(o, { PVT: "5" });
    let refiled = false;
    await o.queue.flushQueue(async op => {
      if (!refiled) { refiled = true; await file(o, { PVT: "8" }); }
      return exec(o, s)(op);
    });
    // Flush again, in case the filing went in as an op of its own.
    await o.queue.flushQueue(exec(o, s));
    assert.deepEqual(s.row!.values, { PVT: 8 });
    assert.ok(o.rows().filter(r => r.entity === "survey_entry").every(r => r.state === "SUCCEEDED"),
      JSON.stringify(o.rows()));
  });

  it("queues the new figures behind a row that is already SENDING, and they land", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "5" });
    let refiled = false;
    await o.queue.flushQueue(async op => {
      // The op is on the wire when the crew files again.
      if (!refiled) { refiled = true; await file(o, { PVT: "8", VB: "20" }); }
      return exec(o, s)(op);
    });
    const survey = o.rows().filter(r => r.entity === "survey_entry");
    assert.equal(survey.length, 2, "the second filing is its own op");
    await o.queue.flushQueue(exec(o, s));
    assert.deepEqual(s.row!.values, { PVT: 8, VB: 20 });
    assert.equal(s.posts, 1);
    assert.ok(o.rows().every(r => r.state === "SUCCEEDED"), JSON.stringify(o.rows()));
  });

  it("still refuses when someone else changed the day before the queued-behind op", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "5" });
    let refiled = false;
    await o.queue.flushQueue(async op => {
      if (!refiled) { refiled = true; await file(o, { PVT: "8" }); }
      return exec(o, s)(op);
    });
    s.edit({ PVT: 50 });
    await o.queue.flushQueue(exec(o, s));
    assert.equal(o.rows().at(-1)!.decision, "CONFLICT");
    assert.deepEqual(s.row!.values, { PVT: 50 });
  });
});

describe("a superseded correction whose amend reply was lost (round 3, item 3)", () => {
  it("lands the newest figures instead of a false conflict", async () => {
    const s = server(), o = outbox();
    await s.deps.post({ survey_village_id: V, entry_date: D, values: { PVT: 5 } }, "crew-a");
    const seen = (await s.deps.getFiled(V, D))!;
    await file(o, { PVT: "6" }, seen);                  // a correction of v1
    let lost = true;
    await o.queue.flushQueue(async op => {
      const r = await exec(o, s)(op);                  // PATCH lands (v2)...
      if (lost) { lost = false; throw new Error("socket hang up"); } // ...reply lost
      return r;
    });
    assert.equal(o.rows()[0].state, "BACKOFF");
    await file(o, { PVT: "7" }, seen);                  // re-corrected from the same form
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0").run();
    await o.queue.flushQueue(exec(o, s));
    assert.equal(o.rows()[0].state, "SUCCEEDED", JSON.stringify(o.rows()));
    assert.deepEqual(s.row!.values, { PVT: 7 });
  });
});


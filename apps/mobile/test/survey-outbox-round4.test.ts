/**
 * Fix round 4: chains of filings for one village-day.
 *
 * The invariant checked after every step: for one village-day there is at
 * most one QUEUED/BACKOFF op, plus at most one SENDING op ahead of it. And
 * every chain ends with the latest figures on the server, one entry, and no
 * false CONFLICT.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSurveyEntryOp } from "../src/sync/surveyEntryOp";
import { returnSubmission } from "../src/survey/fieldCrew";
import { emptyDraft } from "../src/survey/returnForm";
import { D, MEASURES, V, VILLAGE, outbox, server } from "./support/surveyOutbox";

type O = ReturnType<typeof outbox>;
type S = ReturnType<typeof server>;

async function file(o: O, quantities: Record<string, string>) {
  const built = returnSubmission({ village: VILLAGE, workDate: D, measures: MEASURES,
    draft: { ...emptyDraft(), quantities }, kit: [] });
  if (!built.ok) throw new Error(built.problems.join(" "));
  const op = await o.queue.enqueueOp({ entity: built.op.entity, op: built.op.op,
    payload: built.op.payload as any });
  invariant(o);
  return op;
}

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
}

const exec = (o: O, s: S) => (op: any) =>
  runSurveyEntryOp(op, { ...s.deps, remember: (id, p) => o.queue.rewriteOp(id, p) });

async function drain(o: O, s: S) {
  for (let i = 0; i < 4; i += 1) {
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0 WHERE state = 'BACKOFF'").run();
    await o.queue.flushQueue(exec(o, s));
    invariant(o);
  }
}

function settled(o: O, s: S, values: Record<string, number>) {
  assert.deepEqual(s.row!.values, values);
  assert.equal(s.posts, 1, "one entry");
  const rows = o.db.prepare("SELECT state, decision, error FROM pending_ops").all() as
    Array<{ state: string; decision: string | null; error: string | null }>;
  assert.ok(rows.every(r => r.state === "SUCCEEDED"), JSON.stringify(rows));
}

describe("chains of filings for one village-day", () => {
  it("SENDING, then two re-files: the second re-file supersedes the first behind-op", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });                                     // A
    let step = 0;
    await o.queue.flushQueue(async op => {
      if (step === 0) {
        step = 1;
        await file(o, { PVT: "3" });                                  // B3 → behind-op C
        await file(o, { PVT: "4" });                                  // B4 → must fold into C
        const waiting = o.db.prepare(
          "SELECT count(*) AS n FROM pending_ops WHERE state IN ('QUEUED','BACKOFF')").get() as { n: number };
        assert.equal(waiting.n, 1);
      }
      return exec(o, s)(op);
    });
    invariant(o);
    await drain(o, s);
    settled(o, s, { PVT: 4 });
  });

  it("BACKOFF with a behind-op present, then a re-file: the latest lands after the older one", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });                                     // A
    let first = true;
    await o.queue.flushQueue(async op => {
      const r = await exec(o, s)(op);                                // A lands...
      if (first) {
        first = false;
        await file(o, { PVT: "3" });                                  // C queued behind A
        throw new Error("socket hang up");                            // ...A's reply lost → BACKOFF
      }
      return r;
    });
    invariant(o);
    await file(o, { PVT: "4" });                                     // must not fold into A
    await drain(o, s);
    settled(o, s, { PVT: 4 });
  });

  it("a rewritten-then-sent op, then a behind-op: the replay finds what was actually sent", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });                                     // A (B1)
    await file(o, { PVT: "2" });                                     // rewrites A to B2, same key
    let first = true;
    await o.queue.flushQueue(async op => {
      if (first) { first = false; await file(o, { PVT: "3" }); }      // behind-op while A sends B2
      return exec(o, s)(op);
    });
    invariant(o);
    await drain(o, s);
    settled(o, s, { PVT: 3 });
  });

  it("four steps: sent, lost reply, re-filed twice while waiting, then a re-file while sending", async () => {
    const s = server(), o = outbox();
    await file(o, { PVT: "1" });
    let n = 0;
    await o.queue.flushQueue(async op => {
      n += 1;
      const r = await exec(o, s)(op);
      if (n === 1) throw new Error("timeout");                        // A landed, reply lost
      return r;
    });
    await file(o, { PVT: "2" });                                     // folds into A (BACKOFF)
    await file(o, { PVT: "5" });                                     // folds into A again
    let refiled = false;
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0").run();
    await o.queue.flushQueue(async op => {
      if (!refiled) { refiled = true; await file(o, { PVT: "6" }); }  // behind A while A sends
      return exec(o, s)(op);
    });
    await drain(o, s);
    settled(o, s, { PVT: 6 });
  });
});

/**
 * The survey return's path through the real outbox (fix round 1, item 1).
 *
 * createQueue + flushQueue are the production queue; runSurveyEntryOp is the
 * production executor for survey_entry. Only the server is fake, and it
 * behaves as the API does: one return per village-day (409 ALREADY_ENTERED),
 * idempotent replay by key, and PATCH refused unless If-Match is current.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createQueue, type QueueDatabase } from "../src/sync/queueCore";
import { SCHEMA_SQL } from "../src/sync/schema";
import { DAY_CHANGED, runSurveyEntryOp } from "../src/sync/surveyEntryOp";
import type { FiledEntry } from "../src/survey/fieldCrew";

class FakeApiError extends Error {
  constructor(public status: number, public code: string, message: string,
    public retryable = false) { super(message); }
}

type Row = FiledEntry & { survey_village_id: string };

function server() {
  let row: Row | null = null;
  const keys = new Map<string, { hash: string; response: unknown }>();
  const patches: Array<{ version: number; body: Record<string, any> }> = [];
  const idem = (key: string, body: unknown, run: () => unknown) => {
    const hash = JSON.stringify(body);
    const prior = keys.get(key);
    if (prior) {
      if (prior.hash !== hash) throw new FakeApiError(409, "IDEMPOTENCY_CONFLICT", "Key reused");
      return prior.response;
    }
    const response = run();
    keys.set(key, { hash, response });
    return response;
  };
  return {
    patches,
    get row() { return row; },
    /** Somebody else writing the day, e.g. a supervisor on the web. */
    edit(values: Record<string, number>) {
      row = { ...row!, values: { ...row!.values, ...values }, version: row!.version + 1 };
    },
    deps: {
      post: async (entry: any, key: string) => idem(key, entry, () => {
        if (row) throw new FakeApiError(409, "ALREADY_ENTERED", "Already recorded. Amend it instead.");
        row = {
          id: "e1", version: 1, entry_date: entry.entry_date,
          survey_village_id: entry.survey_village_id, teams_deployed: entry.teams_deployed ?? 0,
          notes: entry.notes ?? null, govt_staff_present: entry.govt_staff_present ?? null,
          crew_present: entry.crew_present ?? null, values: { ...entry.values },
        };
        return { ...row };
      }),
      getFiled: async () => (row ? { ...row, values: { ...row.values } } : null),
      patch: async (id: string, version: number, body: any, key: string) => idem(key, body, () => {
        if (!row || row.id !== id) throw new FakeApiError(404, "NOT_FOUND", "gone");
        if (version !== row.version) throw new FakeApiError(409, "VERSION_CONFLICT", "stale");
        patches.push({ version, body });
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
  const state = () => db.prepare(
    "SELECT state, decision, error FROM pending_ops ORDER BY seq DESC LIMIT 1").get() as
    { state: string; decision: string | null; error: string | null };
  return { db, queue, state };
}

const V = "123e4567-e89b-12d3-a456-426614174000";
const D = "2026-09-24";
const entry = (values: Record<string, number>, extra: Record<string, unknown> = {}) =>
  ({ survey_village_id: V, entry_date: D, values, ...extra });

describe("a survey return through the outbox", () => {
  it("files a new day once, however often the op is replayed", async () => {
    const s = server(), o = outbox();
    await o.queue.enqueueOp({ entity: "survey_entry", op: `${V}:${D}`, payload: entry({ PVT: 5 }) });
    let calls = 0;
    // The first attempt lands but its response is lost: the phone retries.
    await o.queue.flushQueue(async op => {
      calls += 1;
      const r = await runSurveyEntryOp(op, s.deps);
      if (calls === 1) throw new Error("socket hang up");
      return r;
    });
    assert.equal(o.state().state, "BACKOFF");
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0").run();
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.state().state, "SUCCEEDED");
    assert.equal(s.row!.version, 1);
    assert.deepEqual(s.row!.values, { PVT: 5 });
    assert.equal(s.patches.length, 0);
  });

  it("does not overwrite a supervisor's correction with a stale replay: CONFLICT, no PATCH", async () => {
    const s = server(), o = outbox();
    await s.deps.post(entry({ PVT: 5, VB: 40 }), "crew-a");        // A files
    const seen = await s.deps.getFiled();                          // B opens the day (v1)
    s.edit({ PVT: 50 });                                           // supervisor corrects it (v2)
    await o.queue.enqueueOp({
      entity: "survey_entry", op: `${V}:${D}`,
      payload: entry({ PVT: 6, VB: 40 }), baseVersion: seen!.version,
    });                                                            // B's stale correction
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    const st = o.state();
    assert.equal(st.state, "FAILED");
    assert.equal(st.decision, "CONFLICT");
    assert.match(String(st.error), /changed by someone else/);
    assert.equal(s.patches.length, 0);
    assert.deepEqual(s.row!.values, { PVT: 50, VB: 40 });
  });

  it("refuses to amend a day the phone never saw (no base version)", async () => {
    const s = server(), o = outbox();
    await s.deps.post(entry({ PVT: 5 }), "someone-else");
    await o.queue.enqueueOp({ entity: "survey_entry", op: `${V}:${D}`, payload: entry({ PVT: 9 }) });
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.state().decision, "CONFLICT");
    assert.equal(s.patches.length, 0);
    assert.deepEqual(s.row!.values, { PVT: 5 });
    assert.equal(DAY_CHANGED, "This day was changed by someone else. Review and re-submit.");
  });

  it("amends only what changed when the base still matches", async () => {
    const s = server(), o = outbox();
    await s.deps.post(entry({ PVT: 5, VB: 40 }, { teams_deployed: 2, crew_present: 3 }), "crew-a");
    const seen = await s.deps.getFiled();
    await o.queue.enqueueOp({
      entity: "survey_entry", op: `${V}:${D}`,
      payload: entry({ PVT: 25 }), baseVersion: seen!.version,
    });
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.state().state, "SUCCEEDED");
    assert.equal(s.patches.length, 1);
    const body = s.patches[0].body;
    assert.deepEqual(body.values, { PVT: 25 });
    // A measure left blank, a blank team count and blank attendance are
    // "not provided", never a zero.
    assert.equal("teams_deployed" in body, false);
    assert.equal("crew_present" in body, false);
    assert.deepEqual(s.row!.values, { PVT: 25, VB: 40 });
    assert.equal(s.row!.crew_present, 3);
    assert.equal(s.row!.teams_deployed, 2);
  });

  it("counts a retry after a lost amendment response as done, not as a conflict", async () => {
    const s = server(), o = outbox();
    await s.deps.post(entry({ PVT: 5 }), "crew-a");
    const seen = await s.deps.getFiled();
    await o.queue.enqueueOp({
      entity: "survey_entry", op: `${V}:${D}`,
      payload: entry({ PVT: 7 }), baseVersion: seen!.version,
    });
    let first = true;
    await o.queue.flushQueue(async op => {
      const r = await runSurveyEntryOp(op, s.deps);
      if (first) { first = false; throw new Error("timeout"); }
      return r;
    });
    o.db.prepare("UPDATE pending_ops SET next_retry_at = 0").run();
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.equal(o.state().state, "SUCCEEDED");
    assert.equal(s.patches.length, 1);
    assert.deepEqual(s.row!.values, { PVT: 7 });
  });

  it("removes a figure only when the crew typed 0 for it", async () => {
    const s = server(), o = outbox();
    await s.deps.post(entry({ PVT: 5, VB: 40 }), "crew-a");
    const seen = await s.deps.getFiled();
    await o.queue.enqueueOp({
      entity: "survey_entry", op: `${V}:${D}`,
      payload: entry({ VB: 0 }), baseVersion: seen!.version,
    });
    await o.queue.flushQueue(op => runSurveyEntryOp(op, s.deps));
    assert.deepEqual(s.patches[0].body.values, { VB: 0 });
    assert.deepEqual(s.row!.values, { PVT: 5 });
  });
});

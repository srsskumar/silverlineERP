/**
 * A fake survey server and an in-memory outbox, for driving the real
 * createQueue / flushQueue / runSurveyEntryOp (fix rounds 2 and 3).
 *
 * The server behaves as the API does: one return per village-day (409
 * ALREADY_ENTERED), idempotent replay by key (same body → stored reply,
 * different body → 409 IDEMPOTENCY_CONFLICT, checked before anything else),
 * and PATCH refused unless If-Match is the current version.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createQueue, type QueueDatabase } from "../../src/sync/queueCore";
import { SCHEMA_SQL } from "../../src/sync/schema";
import type { SurveyEntryDeps } from "../../src/sync/surveyEntryOp";
import type { FiledEntry } from "../../src/survey/fieldCrew";

export class FakeApiError extends Error {
  constructor(public status: number, public code: string, message: string,
    public retryable = false) { super(message); }
}

export const V = "123e4567-e89b-12d3-a456-426614174000";
export const D = "2026-09-24";
export const MEASURES = [
  { id: "m1", code: "PVT", label: "Private extent", group_label: null, unit: "acres", basis: "EXTENT", display_order: 1 },
  { id: "m2", code: "VB", label: "Boundary points", group_label: null, unit: "points", basis: "TARGET", display_order: 2 },
];
export const VILLAGE = { id: V, low_progress_threshold_ac: null, gt_state: null, gt_expected_end_on: null,
  gt_completed_on: null, gt_variance_reason: null };

export function server() {
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
  const deps: SurveyEntryDeps = {
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
  };
  return {
    deps,
    patches,
    get posts() { return posts; },
    get row() { return row; },
    edit(values: Record<string, number>) {
      row = { ...row!, values: { ...row!.values, ...values }, version: row!.version + 1 };
    },
  };
}

export function outbox() {
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
  const rows = () => db.prepare(
    "SELECT client_uuid, entity, state, decision, error FROM pending_ops ORDER BY seq").all() as
    Array<{ client_uuid: string; entity: string; state: string; decision: string | null; error: string | null }>;
  return { db, queue, rows };
}

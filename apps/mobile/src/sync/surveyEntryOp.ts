/**
 * The outbox executor for a queued survey return (survey_entry).
 *
 * Kept apart from engine.ts, which pulls in React Native, so the queue tests
 * can drive it through the real createQueue/flushQueue with a fake server.
 */
import {
  amendmentFor,
  isEmptyAmendment,
  isSecondFiling,
  type EntryAmendment,
  type FiledEntry,
} from "../survey/fieldCrew";

export const DAY_CHANGED = "This day was changed by someone else. Review and re-submit.";

export interface SurveyEntryDeps {
  post(entry: any, idempotencyKey: string): Promise<unknown>;
  getFiled(villageId: string, date: string): Promise<FiledEntry | null>;
  patch(id: string, version: number, body: EntryAmendment, idempotencyKey: string): Promise<unknown>;
  /** A non-retryable 409 the queue records as CONFLICT, carrying `message`. */
  conflict(message: string): Error;
}

/** The first body a superseded op's key may already have carried. */
const SENT = "_sent";

/**
 * Fold a second filing for the same village-day into the op still waiting
 * (fix round 2), so one op lands with the latest figures.
 *
 * The idempotency key stays. If the pending op was never sent, the server
 * has never seen the key and the new body simply goes under it. If it was
 * sent and the reply lost (BACKOFF), the server may hold the key with the
 * first body; the new body under the same key then comes back
 * IDEMPOTENCY_CONFLICT. So the first body is remembered (only the first:
 * that is the only one the key can have carried) and the executor uses it
 * to recover what the first attempt created, then amends it.
 */
export function supersedeSurveyEntry(
  pending: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const { [SENT]: earlier, ...first } = pending;
  return { ...next, [SENT]: earlier ?? first };
}

function isKeyReused(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return Boolean(e && e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT");
}

export async function runSurveyEntryOp(
  op: { payload: string; idempotency_key: string; base_version: number | null },
  deps: SurveyEntryDeps,
): Promise<{ status: number; body: unknown }> {
  const { [SENT]: sent, ...entry } = JSON.parse(op.payload) as Record<string, any>;
  let base = op.base_version;
  try {
    return { status: 201, body: await deps.post(entry, op.idempotency_key) };
  } catch (err) {
    if (isKeyReused(err) && sent) {
      // The first attempt landed; its reply is replayed for the first body,
      // and the day it created is what this filing corrects.
      const created = await deps.post(sent, op.idempotency_key) as { version?: number } | null;
      base = typeof created?.version === "number" ? created.version : null;
    } else if (!isSecondFiling(err)) {
      throw err;
    }
    const filed = await deps.getFiled(entry.survey_village_id, entry.entry_date);
    if (!filed) throw err;
    const amendment = amendmentFor(filed, entry as never);
    // Already reads as the form does: a retry after a lost response.
    if (isEmptyAmendment(amendment)) return { status: 200, body: filed };
    /*
     * Amend only the day the crew was looking at (fix round 1).
     *
     * The PATCH used to carry the version just fetched, so If-Match could
     * never fire, and a stale replay overwrote a supervisor's web correction
     * or another crew member's figures. Now a day changed since the form was
     * opened, or never opened at all, is a CONFLICT the person reviews.
     */
    if (base === null || base === undefined || base !== filed.version) {
      throw deps.conflict(DAY_CHANGED);
    }
    return {
      status: 200,
      body: await deps.patch(filed.id, base, amendment, `${op.idempotency_key}:amend`),
    };
  }
}


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

export async function runSurveyEntryOp(
  op: { payload: string; idempotency_key: string; base_version: number | null },
  deps: SurveyEntryDeps,
): Promise<{ status: number; body: unknown }> {
  const entry = JSON.parse(op.payload);
  try {
    return { status: 201, body: await deps.post(entry, op.idempotency_key) };
  } catch (err) {
    if (!isSecondFiling(err)) throw err;
    const filed = await deps.getFiled(entry.survey_village_id, entry.entry_date);
    if (!filed) throw err;
    const amendment = amendmentFor(filed, entry);
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
    if (op.base_version === null || op.base_version === undefined
        || op.base_version !== filed.version) {
      throw deps.conflict(DAY_CHANGED);
    }
    return {
      status: 200,
      body: await deps.patch(filed.id, op.base_version, amendment, `${op.idempotency_key}:amend`),
    };
  }
}

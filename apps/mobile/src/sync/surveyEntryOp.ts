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
  /**
   * Write the op's payload back before a correction is sent (round 3), so a
   * lost reply can be recognised on the retry. The outbox's rewriteOp.
   */
  remember?(clientUuid: string, payload: string): Promise<void>;
}

/*
 * What a superseded op remembers (rounds 2 and 3), carried in its payload and
 * stripped before anything is sent:
 *   _sent     the first body the pending op may already have delivered
 *   _sentKey  the key it was delivered under (the pending op's key; for a
 *             rewritten op that is this op's own key, for one queued behind a
 *             SENDING op it is the other op's)
 *   _amend    a correction already sent: its base, body and key, so a lost
 *             reply can be replayed rather than read as someone else's edit
 */
const SENT = "_sent", SENT_KEY = "_sentKey", AMEND = "_amend";

interface SentAmend { base: number; body: EntryAmendment; key: string }

/**
 * Fold a second filing for the same village-day into the op still waiting,
 * so one op lands with the latest figures (round 2), and keep what is needed
 * to recover whatever the earlier body already did (round 3).
 */
export function supersedeSurveyEntry(
  pending: Record<string, unknown>,
  next: Record<string, unknown>,
  ctx?: { idempotencyKey: string },
): Record<string, unknown> {
  const { [SENT]: earlier, [SENT_KEY]: earlierKey, [AMEND]: amend, ...first } = pending;
  return {
    ...next,
    [SENT]: earlier ?? first,
    ...(earlierKey ?? ctx?.idempotencyKey ? { [SENT_KEY]: earlierKey ?? ctx?.idempotencyKey } : {}),
    ...(amend ? { [AMEND]: amend } : {}),
  };
}

/** A short, stable fingerprint, so a changed correction gets a key of its own. */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function isKeyReused(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return Boolean(e && e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT");
}

export async function runSurveyEntryOp(
  op: { client_uuid?: string; payload: string; idempotency_key: string; base_version: number | null },
  deps: SurveyEntryDeps,
): Promise<{ status: number; body: unknown }> {
  const stored = JSON.parse(op.payload) as Record<string, any>;
  const { [SENT]: sent, [SENT_KEY]: sentKey, [AMEND]: sentAmend, ...entry } = stored;
  let base = op.base_version;
  try {
    return { status: 201, body: await deps.post(entry, op.idempotency_key) };
  } catch (err) {
    if (!isSecondFiling(err) && !(isKeyReused(err) && sent)) throw err;
    if (sent) {
      /*
       * An earlier body may have created this day: this op's own first
       * attempt (key reused), or the op this one was queued behind. Its
       * reply is replayed under the key it went with, and the version it
       * created is the base this filing corrects. Anything but a replayed
       * reply (someone else's day, a key never used) leaves the base alone.
       */
      try {
        const created = await deps.post(sent, sentKey ?? op.idempotency_key) as { version?: number } | null;
        if (typeof created?.version === "number") base = created.version;
      } catch { /* not ours: the base stays as it was */ }
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
    /*
     * A correction this op already sent, whose reply was lost (round 3).
     * Replayed under its own key: if it landed, the server hands back the
     * day it made, and that version, not somebody else's edit, is why the
     * day has moved on.
     */
    const earlierAmend = sentAmend as SentAmend | undefined;
    if (earlierAmend && base === earlierAmend.base && base !== filed.version) {
      try {
        const amended = await deps.patch(filed.id, earlierAmend.base, earlierAmend.body, earlierAmend.key) as
          { version?: number } | null;
        if (typeof amended?.version === "number") base = amended.version;
      } catch { /* it never landed, or the day moved for another reason */ }
    }
    if (base === null || base === undefined || base !== filed.version) {
      throw deps.conflict(DAY_CHANGED);
    }
    // Each distinct correction gets a key of its own, so a superseded one is
    // never sent under a key that already carried a different body.
    const key = `${op.idempotency_key}:amend:${fingerprint([base, amendment])}`;
    if (deps.remember && op.client_uuid) {
      await deps.remember(op.client_uuid, JSON.stringify({
        ...stored, [AMEND]: { base, body: amendment, key } satisfies SentAmend,
      }));
    }
    return { status: 200, body: await deps.patch(filed.id, base, amendment, key) };
  }
}


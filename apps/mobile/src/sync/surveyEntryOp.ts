/**
 * The outbox executor for a queued survey return (survey_entry), and the
 * rules for chaining several filings of one village-day.
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
   * Write the op's payload back before each request goes (rounds 3 and 4),
   * so what was actually sent under which key is on the row if the reply is
   * lost. The outbox's rewriteOp.
   */
  remember?(clientUuid: string, payload: string): Promise<void>;
}

/*
 * What this device may already have delivered for the village-day (round 4).
 *
 * Every request that went, or may have gone, under a key: the op's own POSTs
 * and PATCHes, recorded as they are sent, and those of any op it was chained
 * onto. Carried in the payload as `_prior` and stripped before sending.
 *
 * It replaces round 2/3's single `_sent`/`_sentKey`/`_amend`, which recorded
 * only one body per chain. In a chain (A rewritten, then sent; a behind-op
 * queued; a re-file folded in) that body was often not the one actually sent
 * under the key, and the replay came back IDEMPOTENCY_CONFLICT.
 */
const PRIOR = "_prior";

export type PriorRequest =
  | { kind: "post"; key: string; body: Record<string, unknown> }
  | { kind: "patch"; key: string; id: string; base: number; body: EntryAmendment };

const sameRequest = (a: PriorRequest, b: PriorRequest) =>
  a.kind === b.kind && a.key === b.key && JSON.stringify(a.body) === JSON.stringify(b.body);

function withPrior(list: PriorRequest[], ...more: PriorRequest[]): PriorRequest[] {
  const out = [...list];
  for (const p of more) if (!out.some(q => sameRequest(q, p))) out.push(p);
  return out;
}

function split(payload: Record<string, unknown>): { entry: Record<string, unknown>; prior: PriorRequest[] } {
  const { [PRIOR]: prior, ...entry } = payload;
  return { entry, prior: Array.isArray(prior) ? (prior as PriorRequest[]) : [] };
}

/**
 * Fold a new filing into an op already in the chain.
 *
 * The result carries the new figures and everything the older op may have
 * delivered: its recorded requests, plus its current body under its key (it
 * may have gone, or be on the wire now). Used both to rewrite the waiting op
 * in place and to start an op queued behind one that is SENDING.
 */
export function supersedeSurveyEntry(
  pending: Record<string, unknown>,
  next: Record<string, unknown>,
  ctx?: { idempotencyKey: string },
): Record<string, unknown> {
  const older = split(pending);
  const newer = split(next);
  const prior = withPrior(newer.prior, ...older.prior,
    ...(ctx ? [{ kind: "post" as const, key: ctx.idempotencyKey, body: older.entry }] : []));
  return { ...newer.entry, [PRIOR]: prior };
}

/**
 * The chain rules the outbox applies to survey_entry (round 4): how to fold
 * a new filing in, and how an op settling hands what it sent to the op
 * behind it (the same fold, keeping the newer figures).
 */
export const surveyEntryChain = {
  supersede: supersedeSurveyEntry,
  handOver: (older: Record<string, unknown>, newer: Record<string, unknown>, ctx: { idempotencyKey: string }) =>
    supersedeSurveyEntry(older, newer, ctx),
};

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
  const { entry, prior: carried } = split(JSON.parse(op.payload) as Record<string, unknown>);
  let prior = carried;
  const record = async (p: PriorRequest) => {
    prior = withPrior(prior, p);
    if (deps.remember && op.client_uuid) {
      await deps.remember(op.client_uuid, JSON.stringify({ ...entry, [PRIOR]: prior }));
    }
  };

  const post: PriorRequest = { kind: "post", key: op.idempotency_key, body: entry };
  await record(post);
  try {
    return { status: 201, body: await deps.post(entry, op.idempotency_key) };
  } catch (err) {
    if (!isSecondFiling(err) && !isKeyReused(err)) throw err;
    const villageId = String(entry.survey_village_id), date = String(entry.entry_date);
    let filed = await deps.getFiled(villageId, date);
    if (!filed) throw err;
    let amendment = amendmentFor(filed, entry as never);
    // Already reads as the form does: a retry after a lost response.
    if (isEmptyAmendment(amendment)) return { status: 200, body: filed };

    /*
     * Amend only a day whose latest change is one the crew made (rounds 1-4).
     *
     * Either the version the form was opened from, or one of this device's
     * own earlier requests for the day. Those are replayed under their keys:
     * a request that landed hands back its stored reply and the version it
     * made; one that never landed is refused and ignored. If the day's
     * version is ours after that, the day is corrected; otherwise somebody
     * else changed it and the crew reviews it.
     */
    let base = op.base_version;
    if (base !== filed.version) {
      let ours: number | null = null;
      for (const p of prior) {
        if (sameRequest(p, post)) continue;
        try {
          const reply = (p.kind === "post"
            ? await deps.post(p.body, p.key)
            : await deps.patch(p.id, p.base, p.body, p.key)) as { version?: number } | null;
          if (typeof reply?.version === "number") ours = Math.max(ours ?? 0, reply.version);
        } catch { /* never landed, or not ours */ }
      }
      filed = (await deps.getFiled(villageId, date)) ?? filed;
      if (ours !== null && ours === filed.version) base = filed.version;
      amendment = amendmentFor(filed, entry as never);
      if (isEmptyAmendment(amendment)) return { status: 200, body: filed };
    }
    if (base === null || base === undefined || base !== filed.version) {
      throw deps.conflict(DAY_CHANGED);
    }
    // Each distinct correction gets a key of its own, so a superseded one is
    // never sent under a key that already carried a different body.
    const key = `${op.idempotency_key}:amend:${fingerprint([base, amendment])}`;
    await record({ kind: "patch", key, id: filed.id, base, body: amendment });
    return { status: 200, body: await deps.patch(filed.id, base, amendment, key) };
  }
}
